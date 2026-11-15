using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Hi5Central.EpmPilot;

internal sealed record FileProof(string Path, string Name, string Hash, string Publisher, string Thumbprint);

internal static class VerifiedFile
{
    private static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
    {
        "cmd.exe","powershell.exe","pwsh.exe","wscript.exe","cscript.exe",
        "mshta.exe","rundll32.exe","regsvr32.exe","reg.exe","sc.exe",
        "net.exe","net1.exe","explorer.exe","schtasks.exe","wmic.exe",
        "msedge.exe","chrome.exe","firefox.exe","msiexec.exe",
        "csc.exe","installutil.exe","bitsadmin.exe","certutil.exe"
    };
    /// <summary>
    /// Pin the exact approved file in its original location. Deny all new writes,
    /// renames and deletes until the elevated process image has been created.
    /// Re-validate SHA-256 and Windows Authenticode while the handle remains open.
    /// Nothing is copied to ProgramData and no persistent file cache is created.
    /// </summary>
    public static FileStream LockForApprovedLaunch(FileProof approved, ManagedAction? managedAction=null)
    {
        var full=System.IO.Path.GetFullPath(approved.Path);
        if (!StringComparer.OrdinalIgnoreCase.Equals(full,approved.Path))
            throw new InvalidOperationException("Approved executable path no longer matches.");
        // Local fixed NTFS volumes only in the pilot; no UNC / mapped network
        // shares or reparse-point paths that could redirect after verification.
        if (new DriveInfo(System.IO.Path.GetPathRoot(full)!).DriveType!=DriveType.Fixed)
            throw new InvalidOperationException("File must be on a local fixed disk.");
        var lockStream=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read);
        try {
            if(managedAction is not null && !string.Equals(
                    managedAction.Path,full,StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Managed action file does not match its approved executable.");
            var current=managedAction is null ? Inspect(full) : InspectManaged(managedAction);
            if (!StringComparer.OrdinalIgnoreCase.Equals(current.Path,approved.Path)
                || current.Hash!=approved.Hash
                || current.Thumbprint!=approved.Thumbprint
                || current.Publisher!=approved.Publisher)
                throw new InvalidOperationException(
                    "The executable differs from the approved file; please request approval again.");
            return lockStream;
        }
        catch {
            lockStream.Dispose();
            throw;
        }
    }

    // The downloaded-executable policy remains strict. Only the FIVE fixed,
    // compiled-in Microsoft Windows actions may use this separate verifier.
    public static FileProof InspectManaged(ManagedAction action)
    {
        if(ManagedUacActions.Resolve(action.Code)!=action)
            throw new UnauthorizedAccessException("Unknown managed Windows action.");
        var verified=InspectCore(action.Path,true);
        if(!verified.Publisher.StartsWith("Microsoft",StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Managed Windows action must have a trusted Microsoft publisher.");
        return verified;
    }

    public static FileProof Inspect(string candidate) => InspectCore(candidate,false);

    private static FileProof InspectCore(string candidate,bool managedWindowsAction)
    {
        var full=System.IO.Path.GetFullPath(candidate);
        if (!System.IO.Path.IsPathFullyQualified(full) || !string.Equals(System.IO.Path.GetExtension(full),".exe",StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(@"\\",StringComparison.Ordinal) || full.StartsWith(@"\\?\",StringComparison.Ordinal)
            || full.StartsWith(@"\\.\",StringComparison.Ordinal)
            || (!managedWindowsAction && full.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows)+@"\",StringComparison.OrdinalIgnoreCase))
            || (!managedWindowsAction && Forbidden.Contains(System.IO.Path.GetFileName(full))))
            throw new InvalidOperationException("This executable is not eligible for the signed-file pilot.");
        // Reject junction/symlink parents as well as a reparse-point executable:
        // process creation accepts a path, so its directory chain must not move.
        var parent=System.IO.Path.GetDirectoryName(full);
        while (!string.IsNullOrWhiteSpace(parent))
        {
            var dir=new DirectoryInfo(parent);
            if (!dir.Exists || dir.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidOperationException("Redirected or missing executable directories are not approved.");
            parent=dir.Parent?.FullName;
        }
        var info=new FileInfo(full);
        if (!info.Exists || info.Length < 4096 || info.Length > 350*1024*1024)
            throw new InvalidOperationException("File is missing or exceeds the pilot size limit.");
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("Links and reparse points are not approved.");
        using var stream=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read);
        var hash=Convert.ToHexString(SHA256.HashData(stream));
        X509Certificate2 cert;
        if(managedWindowsAction && VerifyTrust(full)!=0)
        {
            // Most Windows system binaries are catalog-signed, not PE-signed.
            // Verify the exact member hash against Windows' trusted catalog
            // and extract the actual Microsoft signer. No generic fallback.
            cert=WindowsCatalogSignature.VerifyMicrosoftSignedFile(full);
        }
        else
        {
            if(VerifyTrust(full)!=0)
                throw new InvalidOperationException("Windows could not verify the executable Authenticode signature.");
            cert=new X509Certificate2(X509Certificate.CreateFromSignedFile(full));
        }
        // Keep the certificate alive through publisher extraction and proof
        // construction. A bare using(cert) scopes only the next statement!
        using(cert)
        {
            if(string.IsNullOrEmpty(cert.Thumbprint))
                throw new InvalidOperationException("Publisher certificate is missing.");
            var publisher=cert.GetNameInfo(X509NameType.SimpleName,false);
            if(string.IsNullOrWhiteSpace(publisher))
                throw new InvalidOperationException("Publisher identity is missing.");
            return new FileProof(full,info.Name,hash,publisher,cert.Thumbprint.ToUpperInvariant());
        }
    }

    internal static void ManagedVerifierSelfTest()
    {
        // Regression: all five Microsoft system images must be eligible ONLY
        // through a registered operation, while the downloaded-EXE policy
        // must continue rejecting C:\Windows and general-purpose runtimes.
        foreach(string code in ManagedUacActions.Codes)
        {
            var action=ManagedUacActions.Resolve(code)
                ?? throw new InvalidOperationException("Missing Windows managed-action fixture.");
            bool rejectedByOrdinaryPolicy=false;
            try { _=Inspect(action.Path); }
            catch(InvalidOperationException) {rejectedByOrdinaryPolicy=true;}
            if(!rejectedByOrdinaryPolicy)
                throw new InvalidOperationException("The ordinary EXE policy accepted a Windows system binary: "+code);
            var proof=InspectManaged(action);
            if(proof.Hash.Length!=64 || proof.Thumbprint.Length<40)
                throw new InvalidOperationException("The managed Windows file signature/hash was not bound: "+code);
            using var locked=LockForApprovedLaunch(proof,action);
            if(!locked.CanRead)
                throw new InvalidOperationException("System file lock failed: "+code);
            Console.WriteLine("PASS: managed Windows system image verified (signed Microsoft image, deny-write lock, original downloaded-EXE prohibition): "+code);
        }
    }

    private static int VerifyTrust(string path)
    {
        var info = new WINTRUST_FILE_INFO { cbStruct=(uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),pcwszFilePath=path };
        var filePtr=Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_FILE_INFO>());
        try {
            Marshal.StructureToPtr(info,filePtr,false);
            var data = new WINTRUST_DATA {
                cbStruct=(uint)Marshal.SizeOf<WINTRUST_DATA>(),
                dwUIChoice=2, fdwRevocationChecks=1, dwUnionChoice=1,
                pFile=filePtr,dwStateAction=0,dwProvFlags=0
            };
            var action= new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            return WinVerifyTrust(IntPtr.Zero,ref action,ref data);
        } finally {
            Marshal.DestroyStructure<WINTRUST_FILE_INFO>(filePtr);
            Marshal.FreeHGlobal(filePtr);
        }
    }
    [DllImport("wintrust.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern int WinVerifyTrust(IntPtr hwnd,[In] ref Guid pgActionID,[In] ref WINTRUST_DATA pWVTData);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct WINTRUST_FILE_INFO {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct WINTRUST_DATA {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }
}
