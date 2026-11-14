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
    public static FileProof Inspect(string candidate)
    {
        var full=System.IO.Path.GetFullPath(candidate);
        if (!System.IO.Path.IsPathFullyQualified(full) || !string.Equals(System.IO.Path.GetExtension(full),".exe",StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(@"\\",StringComparison.Ordinal) || full.StartsWith(@"\\?\",StringComparison.Ordinal)
            || full.StartsWith(@"\\.\",StringComparison.Ordinal)
            || full.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows)+@"\",StringComparison.OrdinalIgnoreCase)
            || Forbidden.Contains(System.IO.Path.GetFileName(full)))
            throw new InvalidOperationException("This executable is not eligible for the signed-file pilot.");
        var info=new FileInfo(full);
        if (!info.Exists || info.Length < 4096 || info.Length > 350*1024*1024)
            throw new InvalidOperationException("File is missing or exceeds the pilot size limit.");
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException("Links and reparse points are not approved.");
        using var stream=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read);
        var hash=Convert.ToHexString(SHA256.HashData(stream));
        if (VerifyTrust(full)!=0) throw new InvalidOperationException("Windows could not verify the executable Authenticode signature.");
        using var cert=new X509Certificate2(X509Certificate.CreateFromSignedFile(full));
        if (string.IsNullOrEmpty(cert.Thumbprint)) throw new InvalidOperationException("Publisher certificate is missing.");
        var publisher=cert.GetNameInfo(X509NameType.SimpleName,false);
        if (string.IsNullOrWhiteSpace(publisher)) throw new InvalidOperationException("Publisher identity is missing.");
        return new FileProof(full,info.Name,hash,publisher,cert.Thumbprint.ToUpperInvariant());
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
