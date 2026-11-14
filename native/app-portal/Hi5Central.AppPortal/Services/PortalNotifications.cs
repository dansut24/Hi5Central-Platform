using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
using CommunityToolkit.WinUI.Notifications;
using Hi5Central.AppPortal.Broker;
using Hi5Central.AppPortal.Models;
using Hi5Central.AppPortal.Serialization;
using Microsoft.Win32;

namespace Hi5Central.AppPortal.Services;

/// <summary>
/// End-user, non-elevated toast notifications. Works independently of the
/// RMM Agent using the dedicated Self Service broker named pipe.
/// No credentials, installer links, usernames or message content are saved.
/// </summary>
public static class PortalNotifications
{
    private static readonly string SettingsFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Hi5Central", "SelfService", "notifications-enabled.txt");

    public static bool Enabled
    {
        get
        {
            if (!OperatingSystem.IsWindows()) return false;
            try { return !File.Exists(SettingsFile) ||
                         File.ReadAllText(SettingsFile).Trim() != "0"; }
            catch (IOException) { return true; }
            catch (UnauthorizedAccessException) { return false; }
        }
    }

    public static void SetEnabled(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return;
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
        File.WriteAllText(SettingsFile, enabled ? "1" : "0");
        if (enabled) EnsureSchedule();
        else RemoveSchedule();
    }

    private static string TaskName()
    {
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User?.Value ?? "";
        if (sid.Length < 8 || sid.Any(ch => !(char.IsLetterOrDigit(ch) || ch == '-')))
            throw new InvalidOperationException("The Windows user SID is unavailable.");
        return "Hi5CentralSelfServiceNotifications-" + sid;
    }

    private static bool ExecuteTaskManager(params string[] args)
    {
        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.System), "schtasks.exe"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info);
        if (process is null) return false;
        if (!process.WaitForExit(10_000)) return false;
        return process.ExitCode == 0;
    }

    public static void EnsureSchedule()
    {
        if (!OperatingSystem.IsWindows() || !Enabled) return;
        try
        {
            var name = TaskName();
            if (ExecuteTaskManager("/Query", "/TN", name)) return;
            var executable = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable)) return;
            // Runs as the signed-in Windows user. Never SYSTEM, and never
            // starts/restarts Hi5CentralAgent. One-shot process exits after
            // polling; no background EXE lock blocks Self Service upgrades.
            ExecuteTaskManager("/Create", "/F", "/SC", "MINUTE", "/MO", "15",
                "/TN", name, "/TR", string.Concat("\"", executable, "\" --notify"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
            or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // Notifications remain available while the GUI is open.
        }
    }

    private static void RemoveSchedule()
    {
        if (!OperatingSystem.IsWindows()) return;
        try { ExecuteTaskManager("/Delete", "/F", "/TN", TaskName()); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
            or InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    public static void SyncCatalogue(PortalCatalogueResponse current, PortalCatalogueCache cache)
    {
        if (!OperatingSystem.IsWindows()) return;
        // Per-user named mutex avoids a duplicate notification when the UI
        // and a 15-minute notification worker refresh simultaneously.
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? "";
        if (sid.Length < 8) return;
        using var gate = new Mutex(false, "Local\\Hi5Central.SelfService.Notifications." + sid);
        var locked = false;
        try
        {
            locked = gate.WaitOne(TimeSpan.FromSeconds(3));
            if (!locked) return;
            var hadSnapshot = cache.TryLoad(out var previous, out _);
            if (Enabled && hadSnapshot && previous is not null)
            {
                var previousIds = new HashSet<string>(
                    previous.Apps.Select(x => x.Id),
                    StringComparer.OrdinalIgnoreCase);
                var newApps = current.Apps
                    .Where(x => !string.IsNullOrWhiteSpace(x.Id)
                        && !previousIds.Contains(x.Id)
                        && x.Intent != "hidden")
                    .Take(5).ToList();
                if (newApps.Count > 0)
                {
                    var title = newApps.Count == 1
                        ? "A new app is available to you"
                        : $"{newApps.Count} new apps are available";
                    var description = string.Join(", ", newApps.Select(x => x.Name));
                    try
                    {
                        new ToastContentBuilder()
                            .AddText(title)
                            .AddText(description)
                            .Show();
                    }
                    catch (Exception ex) when (ex is IOException
                        or InvalidOperationException or UnauthorizedAccessException
                        or System.Runtime.InteropServices.COMException
                        or TypeInitializationException)
                    {
                        // The OS may suppress notifications due to settings,
                        // focus assist or unavailable toast registration.
                    }
                }
            }
            // Save even when notifications are disabled so enabling them
            // does not bombard the user with historic assignments.
            cache.Save(current);
        }
        catch (AbandonedMutexException)
        {
            cache.Save(current);
        }
        finally { if (locked) gate.ReleaseMutex(); }
    }

    public static async Task PollOnceAsync()
    {
        if (!OperatingSystem.IsWindows() || !Enabled) return;
        try
        {
            var broker = AppPortalBrokerFactory.Create();
            using var result = await broker.GetCatalogueAsync();
            var catalogue = result.RootElement.Deserialize(
                PortalJsonContext.Default.PortalCatalogueResponse);
            if (catalogue?.Success == true)
                SyncCatalogue(catalogue, new PortalCatalogueCache());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
            or InvalidOperationException or JsonException or OperationCanceledException)
        {
            // A disconnected Broker is retried by the next scheduled run.
            // Never log machine identity credentials or surface a login UI.
        }
    }
}
