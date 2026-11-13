using System.IO.Pipes;
using System.Text.Json;

namespace Hi5Central.AppPortal.Broker;

/// <summary>
/// The desktop UI only speaks to the local privileged Agent. No Agent secret,
/// network installer URL or elevation request is exposed to the UI process.
/// </summary>
public sealed class WindowsNamedPipeAppPortalBroker : IAppPortalBroker
{
    private const string PipeName = "Hi5CentralAppPortal";
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan CatalogueTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromSeconds(30);
    private const int MaximumResponseBytes = 2 * 1024 * 1024;

    public Task<JsonDocument> GetCatalogueAsync(CancellationToken cancellationToken = default)
        => SendAsync("catalogue", appId: null, CatalogueTimeout, cancellationToken);

    public Task<JsonDocument> InstallAsync(string appId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(appId))
        {
            throw new ArgumentException("A catalogue application ID is required.", nameof(appId));
        }
        return SendAsync("install", appId, InstallTimeout, cancellationToken);
    }

    private static async Task<JsonDocument> SendAsync(
        string requestType,
        string? appId,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "The Windows App Portal broker requires the Hi5Central Windows Agent.");
        }

        using var operationTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operationTimeout.CancelAfter(timeout);
        var operationToken = operationTimeout.Token;

        try
        {
            await using var pipe = new NamedPipeClientStream(
                ".",
                PipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);

            using (var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(operationToken))
            {
                connectTimeout.CancelAfter(ConnectTimeout);
                await pipe.ConnectAsync(connectTimeout.Token).ConfigureAwait(false);
            }
            pipe.ReadMode = PipeTransmissionMode.Message;

            using var requestBuffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(requestBuffer))
            {
                writer.WriteStartObject();
                writer.WriteString("type", requestType);
                if (!string.IsNullOrWhiteSpace(appId))
                {
                    writer.WriteString("appId", appId);
                }
                writer.WriteEndObject();
            }

            var requestBytes = requestBuffer.ToArray();
            await pipe.WriteAsync(requestBytes, operationToken).ConfigureAwait(false);
            await pipe.FlushAsync(operationToken).ConfigureAwait(false);

            using var response = new MemoryStream();
            var buffer = new byte[64 * 1024];
            do
            {
                var read = await pipe.ReadAsync(buffer, operationToken).ConfigureAwait(false);
                if (read <= 0) break;

                if (response.Length + read > MaximumResponseBytes)
                {
                    throw new InvalidDataException("The App Portal response exceeded the maximum size.");
                }
                response.Write(buffer, 0, read);
            }
            while (!pipe.IsMessageComplete);

            if (response.Length == 0)
            {
                throw new InvalidDataException("The Hi5Central Agent returned an empty response.");
            }

            response.Position = 0;
            var document = await JsonDocument.ParseAsync(
                    response, cancellationToken: operationToken)
                .ConfigureAwait(false);

            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                document.Dispose();
                throw new InvalidDataException("The Hi5Central Agent returned an invalid response.");
            }

            return document;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Do not retry the operation automatically. A timed-out install request
            // might already have been accepted by the Agent.
            throw new TimeoutException(
                requestType == "install"
                    ? "The Agent did not confirm this request. Refresh before trying again: the install may already have started."
                    : "The Hi5Central Agent did not respond in time.");
        }
    }
}
