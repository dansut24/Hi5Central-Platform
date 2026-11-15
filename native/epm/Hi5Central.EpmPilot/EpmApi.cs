using System.Net.Http.Json;
using System.Text.Json;

namespace Hi5Central.EpmPilot;

internal sealed class EpmApi : IDisposable
{
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(25) };
    public void Dispose() => http.Dispose();

    public async Task<JsonDocument> PostAsync(string path, object data, CancellationToken ct)
    {
        if (!path.StartsWith("/api/v1/agent/epm/file-requests", StringComparison.Ordinal)
            && !path.StartsWith("/api/v1/agent/epm/uac-reviews", StringComparison.Ordinal))
            throw new InvalidOperationException("EPM broker cannot call unrelated API endpoints.");
        // Keep device identity sourced from the Agent's machine-DPAPI state, but route
        // EPM requests only to the shared RMM API (the general API host has no EPM routes).
        var device = AgentIdentity.Load();
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri("https://rmm.hi5central.com"), path))
        {
            Content = JsonContent.Create(data)
        };
        request.Headers.Add("x-hi5-device-id", device.DeviceId);
        request.Headers.Add("x-hi5-agent-secret", device.Secret);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length > 262144) throw new InvalidDataException("Oversized approval response.");
        var doc = JsonDocument.Parse(bytes);
        if (!response.IsSuccessStatusCode)
        {
            var error = doc.RootElement.TryGetProperty("error", out var entry)
                ? entry.GetString() : "Elevation request was not accepted.";
            doc.Dispose();
            throw new InvalidOperationException(error ?? "Elevation request was not accepted.");
        }
        return doc;
    }
}
