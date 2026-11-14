using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hi5Central.SelfServiceBroker;

/// <summary>
/// Reads the existing Agent's machine-DPAPI device identity as SYSTEM.
/// No credentials are copied to user profiles, the AppPortal process, task
/// arguments, named-pipe replies, or the Windows event log.
/// </summary>
internal sealed record AgentIdentity(string DeviceId, string Secret, Uri ApiBase)
{
    private static readonly string StateFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Hi5Central", "Agent", "state.dat");

    public static AgentIdentity Load()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var bytes = File.ReadAllBytes(StateFile);
        if (bytes.Length is < 40 or > 65536) throw new InvalidDataException("Agent identity file size is invalid.");
        var decoded = ProtectedData.Unprotect(bytes, null, DataProtectionScope.LocalMachine);
        try
        {
            using var json = JsonDocument.Parse(decoded);
            var state = json.RootElement;
            string Read(string first, string legacy = "")
                => state.TryGetProperty(first, out var value)
                    ? value.GetString()?.Trim() ?? ""
                    : legacy.Length > 0 && state.TryGetProperty(legacy, out value)
                        ? value.GetString()?.Trim() ?? "" : "";
            var id = Read("device_id", "deviceId");
            var key = Read("device_key", "deviceKey");
            var url = Read("api_base_url", "apiBaseUrl");
            if (!Guid.TryParse(id, out _) || key.Length < 16)
                throw new InvalidDataException("Agent device identity is incomplete.");
            if (!Uri.TryCreate(url, UriKind.Absolute, out var baseUri)
                || baseUri.Scheme != Uri.UriSchemeHttps
                || (baseUri.Host != "rmm.hi5central.com"
                    && baseUri.Host != "api.hi5central.com"
                    && !Regex.IsMatch(baseUri.Host,
                        @"^[a-z0-9][a-z0-9-]{0,61}-rmm\.hi5central\.com$",
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                || !baseUri.IsDefaultPort || baseUri.UserInfo.Length > 0)
                throw new InvalidDataException("Agent API URL is not an approved Hi5Central HTTPS endpoint.");
            return new AgentIdentity(id, key, baseUri);
        }
        finally { CryptographicOperations.ZeroMemory(decoded); }
    }
}
