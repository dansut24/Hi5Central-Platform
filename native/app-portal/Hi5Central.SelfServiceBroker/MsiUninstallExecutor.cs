using System.Diagnostics;
using System.Security.AccessControl;
using System.Text.Json;
using Microsoft.Win32;

namespace Hi5Central.SelfServiceBroker;

/// <summary>
/// Managed, audited MSI removal ONLY. No registry UninstallString, no
/// arbitrary command line, no shell, no PowerShell, no user-supplied files.
/// The API already checks the published app assignment, administrator opt-in,
/// exact current revision and previously successful install.
/// </summary>
internal sealed class MsiUninstallExecutor
{
    private const string UninstallRoot = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string InstallMutex = @"Global\Hi5CentralPatchHostSoftwareInstall";

    internal static bool ProductInstalled(string productCode)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        // Match MSI product code, never executable names or caller strings.
        if (!Guid.TryParseExact(productCode, "B", out _))
            throw new InvalidDataException("Invalid MSI ProductCode.");
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var entry = root.OpenSubKey(UninstallRoot + "\\" + productCode);
            if (entry is not null) return true;
        }
        return false;
    }

    internal async Task<JsonElement> ExecuteAsync(string jobId, JsonElement manifest,
        CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (!Guid.TryParse(jobId, out _)) throw new InvalidDataException("Invalid job ID.");
        var code = manifest.GetProperty("productCode").GetString() ?? "";
        var revision = manifest.GetProperty("revisionId").GetString() ?? "";
        var app = manifest.GetProperty("appId").GetString() ?? "";
        if (!Guid.TryParseExact(code, "B", out _)
            || !Guid.TryParse(revision, out _)
            || !Guid.TryParse(app, out _))
            throw new InvalidDataException("MSI uninstall manifest identity invalid.");

        // Synchronise with PatchHost installers to avoid fighting the MSI
        // database and reboot-required operations.
        using var mutex = new Mutex(false, InstallMutex);
        var locked = false;
        try
        {
            locked = mutex.WaitOne(TimeSpan.FromMinutes(4));
            if (!locked) throw new TimeoutException("Another installation is in progress.");
            if (!ProductInstalled(code))
            {
                return JsonSerializer.SerializeToElement(new {
                    success=true,removalVerified=true,verificationPassed=true,
                    alreadyAbsent=true,productCode=code,revisionId=revision,
                    uninstallExitCode=1605,
                });
            }
            var executable = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System), "msiexec.exe");
            var start = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            start.ArgumentList.Add("/x");
            start.ArgumentList.Add(code);
            start.ArgumentList.Add("/qn");
            start.ArgumentList.Add("/norestart");

            using var process = Process.Start(start)
                ?? throw new InvalidOperationException("Windows Installer could not start.");
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(TimeSpan.FromMinutes(25));
            try { await process.WaitForExitAsync(limit.Token); }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                throw;
            }
            // MSI completion is not sufficient. Windows must no longer list
            // the EXACT product code in its machine-wide uninstall registry.
            var absent = !ProductInstalled(code);
            var acceptedExit = process.ExitCode is 0 or 3010 or 1605;
            var success = acceptedExit && absent;
            return JsonSerializer.SerializeToElement(new
            {
                success, removalVerified=success,verificationPassed=success,
                productCode=code,revisionId=revision,
                uninstallExitCode=process.ExitCode,rebootRequired=process.ExitCode==3010,
                registryAbsent=absent,
                error=success?"":!acceptedExit?"msi_uninstall_exit_code":"msi_product_still_registered",
            });
        }
        finally { if (locked) mutex.ReleaseMutex(); }
    }
}
