using System.Runtime.InteropServices;

namespace Hi5Central.EpmPilot;

/// <summary>
/// A standard Windows .lnk explicitly chosen by the employee, not a guessed
/// target from an arbitrary UAC prompt. Shell Link resolution is advisory:
/// the SYSTEM broker independently binds SHA-256, signer, SID and session.
/// We refuse shortcuts with arguments instead of silently approving a
/// different command line. No scripts, MSI, URL, UNC or folders here.
/// </summary>
internal static class ShortcutSelection
{
    internal static string ResolveSignedExecutableShortcut(string selected)
    {
        if(string.IsNullOrWhiteSpace(selected) || selected.Length>2048
            || !Path.IsPathFullyQualified(selected) || selected.StartsWith(@"\\")
            || !string.Equals(Path.GetExtension(selected),".lnk",StringComparison.OrdinalIgnoreCase)
            || !File.Exists(selected))
            throw new InvalidOperationException("Choose an existing local Windows .lnk shortcut.");
        Type shellType=Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("The Windows shortcut resolver is not available.");
        object shell=Activator.CreateInstance(shellType)
            ?? throw new InvalidOperationException("Cannot initialise the Windows shortcut resolver.");
        object? shortcut=null;
        try
        {
            dynamic sh=shell;
            shortcut=sh.CreateShortcut(selected);
            dynamic link=shortcut!;
            string target=Environment.ExpandEnvironmentVariables((string)link.TargetPath);
            string args=(string)link.Arguments;
            if(!string.IsNullOrWhiteSpace(args))
                throw new InvalidOperationException(
                    "This shortcut has command-line arguments. Select the original signed EXE in File Explorer instead.");
            if(string.IsNullOrWhiteSpace(target) || !Path.IsPathFullyQualified(target)
                || target.StartsWith(@"\\") || target.Length>2048
                || !string.Equals(Path.GetExtension(target),".exe",StringComparison.OrdinalIgnoreCase)
                || !File.Exists(target))
                throw new InvalidOperationException(
                    "Shortcut target is not an existing local executable.");
            // Reject interpreters and Windows system paths before requesting
            // a technician's decision; same rules run again in the broker.
            return VerifiedFile.Inspect(target).Path;
        }
        finally
        {
            if(shortcut is not null && Marshal.IsComObject(shortcut))
                Marshal.FinalReleaseComObject(shortcut);
            if(Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);
        }
    }

    internal static void SelfTest()
    {
        var temp=Path.Combine(Path.GetTempPath(),"Hi5Central-ShortcutTest-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        object? shell=null;
        object? link=null;
        try
        {
            var shellType=Type.GetTypeFromProgID("WScript.Shell")
                ?? throw new InvalidOperationException("Windows Script Host Shell Link COM is unavailable.");
            shell=Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("Could not construct Shell Link test.");
            string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32","notepad.exe");
            string lnk=Path.Combine(temp,"notepad.lnk");
            dynamic host=shell;
            link=host.CreateShortcut(lnk);
            dynamic shortcut=link!;
            shortcut.TargetPath=exe;
            shortcut.Save();
            // EPM's normal downloaded-file rules deliberately reject Windows
            // system paths, even if a shortcut was explicitly selected.
            bool denied=false;
            try { _=ResolveSignedExecutableShortcut(lnk); }
            catch(InvalidOperationException) {denied=true;}
            if(!denied)throw new Exception("Shortcut to forbidden system tool was accepted.");
            shortcut.Arguments="-NoProfile -NoExit";
            shortcut.Save();
            denied=false;
            try { _=ResolveSignedExecutableShortcut(lnk); }
            catch(InvalidOperationException e) when(e.Message.Contains("arguments")) {denied=true;}
            if(!denied)throw new Exception("Shortcut with unapproved arguments was accepted.");
            denied=false;
            try { _=ResolveSignedExecutableShortcut("https://example.org/program.lnk"); }
            catch(InvalidOperationException) {denied=true;}
            if(!denied)throw new Exception("URL shortcut was accepted.");
            Console.WriteLine("PASS: Windows .lnk target resolved; system shortcuts, argument injection and URLs denied.");
        }
        finally
        {
            if(link is not null && Marshal.IsComObject(link))Marshal.FinalReleaseComObject(link);
            if(shell is not null && Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);
            try {Directory.Delete(temp,true);}catch { }
        }
    }
}
