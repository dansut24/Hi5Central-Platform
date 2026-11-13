using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Hi5Central.AppPortal.Broker;

if (!OperatingSystem.IsWindows())
{
    throw new PlatformNotSupportedException("The Agent IPC acceptance suite runs on Windows only.");
}

var broker = new WindowsNamedPipeAppPortalBroker();
var tests = new (string Name, Func<Task> Run)[]
{
    ("catalogue response and request schema", async () =>
    {
        var server = ReplyToOneRequestAsync("catalogue", null, "{\"success\":true,\"apps\":[]}");
        using var document = await broker.GetCatalogueAsync();
        await server;
        Require(document.RootElement.GetProperty("success").GetBoolean(),
            "Expected successful catalogue response.");
    }),
    ("install includes the application ID", async () =>
    {
        const string id = "f535b802-fef9-443a-a8c3-0089a2fc91ac";
        var server = ReplyToOneRequestAsync("install", id,
            "{\"success\":true,\"approvalRequired\":true}");
        using var document = await broker.InstallAsync(id);
        await server;
        Require(document.RootElement.GetProperty("approvalRequired").GetBoolean(),
            "Expected approval-required install.");
    }),
    ("invalid empty app ID rejected locally", async () =>
    {
        await ExpectAsync<ArgumentException>(
            () => broker.InstallAsync(""), "Empty app ID must be rejected.");
    }),
    ("malformed Agent response rejected", async () =>
    {
        var server = ReplyToOneRequestAsync("catalogue", null, "{INVALID-JSON");
        await ExpectAsync<JsonException>(
            () => broker.GetCatalogueAsync(), "Malformed Agent response must fail.");
        await server;
    }),
    ("caller cancellation stops a pending connection", async () =>
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
        await ExpectAsync<OperationCanceledException>(
            () => broker.GetCatalogueAsync(cts.Token),
            "Cancellation from the UI must not be converted into a timeout.");
    }),
    ("unresponsive Agent cannot hang the catalogue forever", async () =>
    {
        // A server accepts the pipe, consumes the message and then intentionally
        // never writes a response. The portal must time out rather than hang.
        var server = ReplyToOneRequestAsync("catalogue", null, null);
        var watch = Stopwatch.StartNew();
        await ExpectAsync<TimeoutException>(
            () => broker.GetCatalogueAsync(),
            "Unresponsive Agent should produce a bounded timeout.");
        await server;
        Require(watch.Elapsed < TimeSpan.FromSeconds(20),
            "Catalogue request took longer than the allowed response window.");
    })
};

foreach (var test in tests)
{
    await test.Run();
    Console.WriteLine("PASS: " + test.Name);
}
Console.WriteLine("All " + tests.Length + " App Portal named-pipe tests passed.");

static async Task ReplyToOneRequestAsync(string expectedType, string? expectedAppId, string? reply)
{
    using var server = new NamedPipeServerStream(
        "Hi5CentralAppPortal", PipeDirection.InOut, 1,
        PipeTransmissionMode.Message, PipeOptions.Asynchronous);
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));

    await server.WaitForConnectionAsync(cts.Token);
    using var buffer = new MemoryStream();
    var bytes = new byte[4096];
    do
    {
        var read = await server.ReadAsync(bytes, cts.Token);
        if (read <= 0) throw new InvalidDataException("Client disconnected before request.");
        buffer.Write(bytes, 0, read);
    } while (!server.IsMessageComplete);

    using var request = JsonDocument.Parse(buffer.ToArray());
    Require(request.RootElement.GetProperty("type").GetString() == expectedType,
        "Incorrect IPC operation.");
    if (expectedAppId is not null)
    {
        Require(request.RootElement.GetProperty("appId").GetString() == expectedAppId,
            "Incorrect installation ID.");
    }

    if (reply is null)
    {
        // Leave server connected beyond the 15-second read deadline.
        await Task.Delay(TimeSpan.FromSeconds(16));
    }
    else
    {
        var payload = Encoding.UTF8.GetBytes(reply);
        await server.WriteAsync(payload, cts.Token);
        await server.FlushAsync(cts.Token);
    }
}

static void Require(bool actual, string failure)
{
    if (!actual) throw new Exception(failure);
}

static async Task ExpectAsync<TException>(Func<Task> action, string failure)
    where TException : Exception
{
    try
    {
        await action();
    }
    catch (TException)
    {
        return;
    }
    throw new Exception(failure);
}
