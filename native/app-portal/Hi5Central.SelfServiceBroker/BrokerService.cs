using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Hi5Central.SelfServiceBroker;

internal sealed class BrokerService(ILogger<BrokerService> log) : BackgroundService
{
    private const string PipeName = "Hi5CentralSelfServiceBroker";
    private readonly BrokerApi _api = new();
    private readonly PatchHostExecutor _patchHost = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        // Independent service starts even while Hi5CentralAgent is Stopped.
        log.LogInformation("Independent Self Service broker started");
        await Task.WhenAll(ListenLoop(ct), PollLoop(ct));
    }

    private static PipeSecurity PipeAcl()
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return security;
    }

    private async Task ListenLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var pipe = NamedPipeServerStreamAcl.Create(
                    PipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Message,
                    PipeOptions.Asynchronous, 65536, 65536, PipeAcl());
                await pipe.WaitForConnectionAsync(ct);
                await HandleClient(pipe, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                log.LogWarning("Self Service pipe request failed ({ExceptionType})",
                    ex.GetType().Name);
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
        }
    }

    private async Task HandleClient(NamedPipeServerStream pipe, CancellationToken ct)
    {
        // Identity is derived from the Windows pipe token, NEVER supplied by
        // the unprivileged desktop application.
        string sid = "", name = "";
        pipe.RunAsClient(() =>
        {
            using var windows = WindowsIdentity.GetCurrent();
            sid = windows.User?.Value ?? "";
            name = windows.Name ?? "";
        });
        if (sid.Length is < 8 or > 255) throw new UnauthorizedAccessException();
        var parts = name.Split('\\');
        var username = parts.Length > 1 ? parts[^1] : name;
        var upn = name.Contains('@') ? name : "";
        var identity = new
        {
            sid,
            username,
            upn,
            displayName = username,
            sessionId = "",
        };
        var buffer = new byte[65536];
        using var input = new MemoryStream();
        pipe.ReadMode = PipeTransmissionMode.Message;
        do
        {
            var read = await pipe.ReadAsync(buffer.AsMemory(), ct);
            if (read == 0) throw new EndOfStreamException();
            if (input.Length + read > 65536)
                throw new InvalidDataException("App Portal request exceeded limit.");
            input.Write(buffer, 0, read);
        } while (!pipe.IsMessageComplete);
        string reply;
        try
        {
            using var parsed = JsonDocument.Parse(input.ToArray());
            var root = parsed.RootElement;
            var type = root.TryGetProperty("type", out var value) ? value.GetString() : "";
            using var response = type switch
            {
                "catalogue" => await _api.SendAsync(
                    "/api/v1/agent/app-portal/catalogue", new { identity },
                    independent:false, ct),
                "install" => await InstallAsync(root, identity, ct),
                _ => throw new InvalidDataException("Unsupported Self Service request."),
            };
            if (type == "catalogue")
            {
                var obj = System.Text.Json.Nodes.JsonNode.Parse(
                    response.RootElement.GetRawText()) as System.Text.Json.Nodes.JsonObject
                    ?? throw new InvalidDataException("Invalid catalogue response.");
                obj["independentBrokerConnected"] = true;
                reply = obj.ToJsonString();
            }
            else reply = response.RootElement.GetRawText();
        }
        catch (Exception ex)
        {
            // Do not return network internals or device credentials to users.
            reply = JsonSerializer.Serialize(new
            {
                success = false,
                error = ex is InvalidOperationException
                    ? ex.Message : "Self Service is unavailable. Please try again.",
            });
        }
        var bytes = Encoding.UTF8.GetBytes(reply);
        if (bytes.Length > 2_097_152) throw new InvalidDataException("Reply too large.");
        await pipe.WriteAsync(bytes, ct);
        await pipe.FlushAsync(ct);
    }

    private Task<JsonDocument> InstallAsync(JsonElement request, object identity, CancellationToken ct)
    {
        var id = request.TryGetProperty("appId", out var appId) ? appId.GetString() : "";
        if (!Guid.TryParse(id, out _))
            throw new InvalidDataException("Invalid application ID.");
        return _api.SendAsync("/api/v1/agent/app-portal/install",
            new { appId = id, identity }, independent:true, ct);
    }

    private async Task PollLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using (var heartbeat = await _api.SendAsync(
                    "/api/v1/agent/app-portal/broker/heartbeat", new { }, false, ct))
                {
                    if (heartbeat.RootElement.GetProperty("success").GetBoolean())
                    {
                        using var claims = await _api.SendAsync(
                            "/api/v1/agent/app-portal/broker/jobs/claim", new { }, false, ct);
                        foreach (var job in claims.RootElement.GetProperty("jobs").EnumerateArray())
                        {
                            await RunClaimedJob(job, ct);
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                log.LogWarning("Independent install poll unavailable ({Type})", ex.GetType().Name);
            }
            await Task.Delay(TimeSpan.FromSeconds(6), ct);
        }
    }

    private async Task RunClaimedJob(JsonElement job, CancellationToken ct)
    {
        var id = job.GetProperty("id").GetString() ?? "";
        if (!Guid.TryParse(id, out _)) throw new InvalidDataException("Invalid job identity.");
        // Strictly software jobs with server-issued payload. The broker's
        // claim API cannot return general RMM commands or remote sessions.
        if (job.GetProperty("job_type").GetString() != "patch.software")
            throw new InvalidOperationException("Non-portal job refused.");
        JsonElement result;
        try
        {
            result = await _patchHost.ExecuteAsync(id, job.GetProperty("payload"), ct);
        }
        catch (Exception ex)
        {
            log.LogError("PatchHost job {JobId} failed ({Type})", id, ex.GetType().Name);
            using var fallback = JsonDocument.Parse(
                """{"success":false,"error":"independent_patchhost_failed"}""");
            result = fallback.RootElement.Clone();
        }
        var success = result.TryGetProperty("success", out var flag) && flag.GetBoolean();
        var error = !success && result.TryGetProperty("error", out var e) ? e.GetString() : null;
        using var response = await _api.SendAsync(
            "/api/v1/agent/devices/jobs/" + id + "/result",
            new { success, result, error }, false, ct);
        log.LogInformation("Self Service installation {JobId} completed success={Success}",id,success);
    }

    public override void Dispose()
    {
        _api.Dispose();
        base.Dispose();
    }
}
