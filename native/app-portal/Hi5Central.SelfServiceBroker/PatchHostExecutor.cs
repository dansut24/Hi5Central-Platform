using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hi5Central.SelfServiceBroker;

/// <summary>
/// Mirrors the proven Agent 1.0.506 PatchHost launch contract, in a separate
/// LocalSystem Windows service. Self Service cannot run arbitrary shell commands.
/// The existing PatchHost alone decides signer/hash/unsigned-approval validity.
/// </summary>
internal sealed class PatchHostExecutor
{
    private static readonly string ProgramRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        "Hi5Central", "Agent");
    private static readonly string HostExecutable =
        Path.Combine(ProgramRoot, "Hi5CentralPatchHost.exe");
    private static readonly string WorkRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Hi5Central", "Agent", "PatchHost");

    private static FileSystemAccessRule Rule(WellKnownSidType sid)
        => new(new SecurityIdentifier(sid, null), FileSystemRights.FullControl,
            AccessControlType.Allow);

    private static void ProtectWorkDirectory()
    {
        Directory.CreateDirectory(WorkRoot);
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(WorkRoot).SetAccessControl(acl);
    }

    private static void ProtectManifest(string path)
    {
        var acl = new FileSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(Rule(WellKnownSidType.LocalSystemSid));
        acl.AddAccessRule(Rule(WellKnownSidType.BuiltinAdministratorsSid));
        new FileInfo(path).SetAccessControl(acl);
    }

    public async Task<JsonElement> ExecuteAsync(string jobId, JsonElement original, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (!Guid.TryParse(jobId, out _))
            throw new InvalidDataException("Invalid PatchHost job ID.");
        if (!File.Exists(HostExecutable))
            throw new FileNotFoundException("The existing Hi5Central PatchHost is required.");
        ProtectWorkDirectory();
        var issued = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var manifest = JsonNode.Parse(original.GetRawText()) as JsonObject
            ?? throw new InvalidDataException("PatchHost payload must be an object.");
        manifest["protocolVersion"] = 1;
        manifest["action"] = "software.install";
        manifest["jobId"] = jobId;
        manifest["deviceId"] = AgentIdentity.Load().DeviceId;
        manifest["issuedUnixMs"] = issued;
        manifest["expiresUnixMs"] = issued + 10 * 60 * 1000;
        var plain = Encoding.UTF8.GetBytes(manifest.ToJsonString());
        var encrypted = ProtectedData.Protect(plain, null, DataProtectionScope.LocalMachine);
        CryptographicOperations.ZeroMemory(plain);
        var path = Path.Combine(WorkRoot, jobId + ".manifest.dpapi");
        var resultPath = Path.Combine(WorkRoot, jobId + ".result.json");
        try
        {
            File.WriteAllBytes(path, encrypted);
            ProtectManifest(path);
            var command = new ProcessStartInfo
            {
                FileName = HostExecutable,
                WorkingDirectory = ProgramRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            command.ArgumentList.Add("--execute-manifest");
            command.ArgumentList.Add(path);
            command.ArgumentList.Add("--output");
            command.ArgumentList.Add(resultPath);
            using var process = Process.Start(command)
                ?? throw new InvalidOperationException("PatchHost could not be started.");
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(TimeSpan.FromMinutes(35));
            try
            {
                await process.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree:true);
                throw;
            }
            if (!File.Exists(resultPath))
                throw new InvalidDataException("PatchHost returned no installation result.");
            var file = new FileInfo(resultPath);
            if (file.Length is < 2 or > 2_097_152)
                throw new InvalidDataException("PatchHost installation result size is invalid.");
            var data = JsonNode.Parse(await File.ReadAllTextAsync(resultPath, ct)) as JsonObject
                ?? throw new InvalidDataException("PatchHost result JSON is invalid.");
            data["patchHostExitCode"] = process.ExitCode;
            using var doc = JsonDocument.Parse(data.ToJsonString());
            return doc.RootElement.Clone();
        }
        finally
        {
            try { File.Delete(path); } catch (IOException) { }
            try { File.Delete(resultPath); } catch (IOException) { }
            CryptographicOperations.ZeroMemory(encrypted);
        }
    }
}
