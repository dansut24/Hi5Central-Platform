using Microsoft.Win32;
using Hi5Central.AppPortal.Models;

namespace Hi5Central.AppPortal.Services;

/// <summary>
/// Unprivileged read-only enumeration of machine-wide and current-user
/// uninstall registry keys. Works even when Agent service/cloud is down.
/// </summary>
public static class LocalInstalledSoftware
{
    private const string UninstallPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    public static List<PortalInstalledProgram> Read()
    {
        if (!OperatingSystem.IsWindows()) return [];
        var items = new Dictionary<string, PortalInstalledProgram>(
            StringComparer.OrdinalIgnoreCase);
        foreach (var (hive, view) in new[]
        {
            (RegistryHive.LocalMachine, RegistryView.Registry64),
            (RegistryHive.LocalMachine, RegistryView.Registry32),
            (RegistryHive.CurrentUser, RegistryView.Registry64),
            (RegistryHive.CurrentUser, RegistryView.Registry32),
        })
        {
            try
            {
                using var root = RegistryKey.OpenBaseKey(hive, view);
                using var uninstall = root.OpenSubKey(UninstallPath);
                if (uninstall is null) continue;
                foreach (var keyName in uninstall.GetSubKeyNames().Take(5000))
                {
                    try
                    {
                        using var key = uninstall.OpenSubKey(keyName);
                        if (key is null) continue;
                        if (Convert.ToString(key.GetValue("SystemComponent")) == "1"
                            || key.GetValue("ParentKeyName") is not null) continue;
                        var name = (key.GetValue("DisplayName") as string)?.Trim() ?? "";
                        if (name.Length is < 2 or > 256) continue;
                        var version = (key.GetValue("DisplayVersion") as string)?.Trim() ?? "";
                        var publisher = (key.GetValue("Publisher") as string)?.Trim() ?? "";
                        if (version.Length > 100) version = version[..100];
                        if (publisher.Length > 150) publisher = publisher[..150];
                        // Keep side-by-side versions visible; dedupe 32/64-bit views.
                        var dedupe = name + "\u001f" + version;
                        items.TryAdd(dedupe, new PortalInstalledProgram
                        {
                            Name = name,
                            Version = version,
                            Publisher = publisher,
                            Source = "windows_registry",
                        });
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
                    {
                        // Other keys remain readable.
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                or System.Security.SecurityException or PlatformNotSupportedException)
            {
                // Continue with other hive/view combinations.
            }
        }
        return items.Values.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .Take(600).ToList();
    }
}
