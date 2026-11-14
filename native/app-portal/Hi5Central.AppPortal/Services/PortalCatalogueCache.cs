using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Hi5Central.AppPortal.Models;
using Hi5Central.AppPortal.Serialization;

namespace Hi5Central.AppPortal.Services;

/// <summary>
/// Per-user Windows DPAPI cache of the last authorised catalogue response.
/// It NEVER caches Agent credentials, installer URLs or privileged commands.
/// Cached assignments are display-only; installation still requires live
/// Windows Agent IPC and fresh server-side authorisation.
/// </summary>
public sealed class PortalCatalogueCache
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Hi5Central.SelfService.Catalogue.v1");
    private static string DirectoryPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Hi5Central", "SelfService");
    private static string CachePath => Path.Combine(DirectoryPath, "catalogue-v1.dpapi");

    public bool TryLoad(out PortalCatalogueResponse? response, out DateTimeOffset savedAt)
    {
        response = null;
        savedAt = default;
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            var path = CachePath;
            var file = new FileInfo(path);
            if (!file.Exists || file.Length is < 20 or > 4_194_304) return false;
            savedAt = file.LastWriteTimeUtc;
            var ciphertext = File.ReadAllBytes(path);
            var plaintext = ProtectedData.Unprotect(ciphertext, Entropy, DataProtectionScope.CurrentUser);
            response = JsonSerializer.Deserialize(plaintext, PortalJsonContext.Default.PortalCatalogueResponse);
            // Never expose the previous device's cache from a reused Windows user profile.
            if (response?.Success != true
                || !string.Equals(response.Device.Name, Environment.MachineName,
                    StringComparison.OrdinalIgnoreCase))
            {
                response = null;
                return false;
            }
            return true;
        }
        catch
        {
            response = null;
            return false;
        }
    }

    public void Save(PortalCatalogueResponse response)
    {
        if (!OperatingSystem.IsWindows() || !response.Success) return;
        if (!string.Equals(response.Device.Name, Environment.MachineName,
            StringComparison.OrdinalIgnoreCase)) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(
            response, PortalJsonContext.Default.PortalCatalogueResponse);
        if (bytes.Length > 2 * 1024 * 1024) return;
        var ciphertext = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(DirectoryPath);
        var temp = Path.Combine(DirectoryPath, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllBytes(temp, ciphertext);
            File.Move(temp, CachePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
