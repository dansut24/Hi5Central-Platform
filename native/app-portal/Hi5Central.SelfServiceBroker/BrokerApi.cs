using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Hi5Central.SelfServiceBroker;

/// <summary>Only the existing authenticated Self Service API is accessible.</summary>
internal sealed class BrokerApi : IDisposable
{
    private readonly HttpClient _http = new()
    {
        Timeout = TimeSpan.FromSeconds(35),
    };
    public void Dispose() => _http.Dispose();

    public async Task<JsonDocument> SendAsync(
        string path, object body, bool independent, CancellationToken ct)
    {
        if (!path.StartsWith("/api/v1/agent/app-portal/", StringComparison.Ordinal)
            && !path.StartsWith("/api/v1/agent/devices/jobs/", StringComparison.Ordinal))
            throw new InvalidOperationException("Unsupported broker endpoint.");
        var identity = AgentIdentity.Load();
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(identity.ApiBase, path))
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add("x-hi5-device-id", identity.DeviceId);
        request.Headers.Add("x-hi5-agent-secret", identity.Secret);
        if (independent) request.Headers.Add("x-hi5-self-service-broker", "v1");
        using var response = await _http.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, ct);
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        if (response.Content.Headers.ContentLength is > 2_097_152)
            throw new InvalidDataException("Response too large.");
        using var limited = new MemoryStream();
        var buffer = new byte[16_384];
        int read;
        while ((read = await stream.ReadAsync(buffer.AsMemory(), ct)) > 0)
        {
            if (limited.Length + read > 2_097_152)
                throw new InvalidDataException("Response too large.");
            limited.Write(buffer, 0, read);
        }
        limited.Position = 0;
        var data = await JsonDocument.ParseAsync(limited, cancellationToken: ct);
        if (!response.IsSuccessStatusCode)
        {
            var error = data.RootElement.TryGetProperty("error", out var e)
                ? e.GetString() : null;
            data.Dispose();
            throw new InvalidOperationException(
                string.IsNullOrWhiteSpace(error) ? "Hi5Central rejected the request." : error);
        }
        return data;
    }
}
