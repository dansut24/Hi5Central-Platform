using Microsoft.Win32;
using System.ServiceProcess;
using System.Text.Json;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Passive device capabilities only. Never launches UAC, reads passwords,
/// alters Windows policies, writes files, or elevates a process.
/// Worker status represents IMPLEMENTED Hi5Central code, not an inference
/// that Windows itself can elevate an operation on this device.
/// </summary>
internal static class ElevationCoverageProbe
{
    internal static object Create()
    {
        const string uacKey=@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
        const string providerKey=
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{7464D2E2-202B-4546-953D-9AFCDA3201E6}";
        using var key=Registry.LocalMachine.OpenSubKey(uacKey,false);
        using var tile=Registry.LocalMachine.OpenSubKey(providerKey,false);
        int? Value(string name) =>
            key?.GetValue(name) is int v?v:null;
        string Service(string name)
        {
            try {
                using var controller=new ServiceController(name);
                return controller.Status.ToString();
            }
            catch {return "unavailable";}
        }
        return new {
            schemaVersion="hi5central-epm-coverage-v1",
            timestampUtc=DateTimeOffset.UtcNow.ToString("O"),
            platform=Environment.OSVersion.VersionString,
            windowsUac=new {
                enabled=Value("EnableLUA")==1,
                secureDesktop=Value("PromptOnSecureDesktop")==1,
                standardUserPrompt=Value("ConsentPromptBehaviorUser"),
                credentialTilePilotRegistered=tile is not null,
                appInfoService=Service("Appinfo"),
                windowsInstallerService=Service("msiserver")
            },
            coverage=new object[] {
                new {scenario="explorer_signed_exe",automaticTarget=true,
                    approval=true,executionWorker=true,status="qualified-existing-flow"},
                new {scenario="edge_chrome_downloaded_exe",automaticTarget=true,
                    approval=true,executionWorker=true,status="qualified-existing-flow"},
                new {scenario="unmanaged_native_uac",automaticTarget=false,
                    approval=false,executionWorker=false,status="windows-uac-fallback"},
                new {scenario="windows_installer_msi",automaticTarget=false,
                    approval=false,executionWorker=false,status="worker-required"},
                new {scenario="powershell_script",automaticTarget=false,
                    approval=false,executionWorker=false,status="worker-required"},
                new {scenario="windows_settings",automaticTarget=false,
                    approval=false,executionWorker=false,status="operation-specific-broker-required"},
                new {scenario="services_registry_tasks",automaticTarget=false,
                    approval=false,executionWorker=false,status="operation-specific-broker-required"},
                new {scenario="explorer_protected_file_operation",automaticTarget=false,
                    approval=false,executionWorker=false,status="operation-specific-broker-required"},
                new {scenario="nested_child_process",automaticTarget=false,
                    approval=false,executionWorker=false,status="worker-required"}
            },
            notes="Read-only diagnostic. No universal UAC interception or native prompt resumption is claimed."
        };
    }
    internal static void Print()
    {
        // WinExe is a GUI subsystem executable. Write directly to inherited
        // stdout so a redirected PowerShell/RMM CI diagnostic captures the
        // JSON even when no interactive console is attached.
        byte[] bytes=System.Text.Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(Create())+Environment.NewLine);
        using var output=Console.OpenStandardOutput();
        output.Write(bytes);
        output.Flush();
    }
}
