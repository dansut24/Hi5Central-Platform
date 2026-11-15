using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Windows inbox programs may be signed by Microsoft catalogs rather than
/// embedded PE signatures. Resolve the exact file digest to a catalog, have
/// Windows verify the file membership + trust chain, then read the ACTUAL
/// verified signer from WinTrust's authenticated provider chain.
/// This branch is used ONLY by the fixed five-action managed UAC allowlist.
/// </summary>
internal static class WindowsCatalogSignature
{
    internal static X509Certificate2 VerifyMicrosoftSignedFile(string file)
    {
        if(!File.Exists(file))throw new InvalidOperationException("The Windows program does not exist.");
        if(!CryptCATAdminAcquireContext2(out var admin,IntPtr.Zero,"SHA256",IntPtr.Zero,0)
            || admin==IntPtr.Zero)
            throw new InvalidOperationException("Windows could not open its SHA-256 system catalog database.");
        try
        {
            using var stream=File.Open(file,FileMode.Open,FileAccess.Read,FileShare.Read);
            uint size=0;
            if(!CryptCATAdminCalcHashFromFileHandle2(admin,stream.SafeFileHandle,
                    ref size,IntPtr.Zero,0) || size is <16 or >128)
                throw new InvalidOperationException("Windows catalog hash calculation was unavailable.");
            var hash=new byte[size];
            if(!CryptCATAdminCalcHashFromFileHandle2(admin,stream.SafeFileHandle,
                    ref size,hash,0))
                throw new InvalidOperationException("Windows catalog hash calculation failed.");
            string memberTag=Convert.ToHexString(hash.AsSpan(0,(int)size));
            IntPtr previous=IntPtr.Zero;
            try
            {
                // Do not trust arbitrary catalog bytes or a signer merely
                // *included* in a PKCS#7 chain: extract the verified signer
                // corresponding to the exact member digest.
                for(int tries=0;tries<32;tries++)
                {
                    var current=CryptCATAdminEnumCatalogFromHash(admin,hash,size,0,ref previous);
                    if(current==IntPtr.Zero)break;
                    previous=current;
                    var info=new CATALOG_INFO {
                        cbStruct=(uint)Marshal.SizeOf<CATALOG_INFO>(),
                        wszCatalogFile=""
                    };
                    if(!CryptCATCatalogInfoFromContext(current,ref info,0))continue;
                    var signer=VerifyCatalogMember(admin,stream.SafeFileHandle.DangerousGetHandle(),
                        info.wszCatalogFile,file,memberTag);
                    if(signer is null)continue;
                    if(IsMicrosoftPublisher(signer))return signer;
                    signer.Dispose();
                }
            }
            finally
            {
                if(previous!=IntPtr.Zero)CryptCATAdminReleaseCatalogContext(admin,previous,0);
            }
        }
        finally {CryptCATAdminReleaseContext(admin,0);}
        throw new InvalidOperationException("No trusted Microsoft Windows catalog signature was found for this exact system executable.");
    }

    internal static bool IsMicrosoftPublisher(X509Certificate2 signer)
    {
        string common=signer.GetNameInfo(X509NameType.SimpleName,false);
        // An actual, WinTrust-verified signer certificate from the associated
        // catalog is required, not just arbitrary file-version metadata.
        return common.StartsWith("Microsoft ",StringComparison.OrdinalIgnoreCase)
            && signer.Subject.Contains("O=Microsoft Corporation",StringComparison.OrdinalIgnoreCase);
    }

    private static X509Certificate2? VerifyCatalogMember(IntPtr admin,IntPtr fileHandle,
        string catalogPath,string filePath,string memberTag)
    {
        if(string.IsNullOrWhiteSpace(catalogPath))return null;
        var catalog=new WINTRUST_CATALOG_INFO {
            cbStruct=(uint)Marshal.SizeOf<WINTRUST_CATALOG_INFO>(),
            pcwszCatalogFilePath=catalogPath,pcwszMemberTag=memberTag,
            pcwszMemberFilePath=filePath,hMemberFile=fileHandle,hCatAdmin=admin
        };
        IntPtr allocation=Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_CATALOG_INFO>());
        try
        {
            Marshal.StructureToPtr(catalog,allocation,false);
            var trust=new WINTRUST_DATA {
                cbStruct=(uint)Marshal.SizeOf<WINTRUST_DATA>(),
                dwUIChoice=2,fdwRevocationChecks=0,dwUnionChoice=2,
                pUnion=allocation,dwStateAction=1,dwProvFlags=0x00001000
            };
            var action=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            try
            {
                if(WinVerifyTrust(IntPtr.Zero,ref action,ref trust)!=0
                    || trust.hWVTStateData==IntPtr.Zero)return null;
                IntPtr provider=WTHelperProvDataFromStateData(trust.hWVTStateData);
                if(provider==IntPtr.Zero)return null;
                IntPtr signer=WTHelperGetProvSignerFromChain(provider,0,false,0);
                if(signer==IntPtr.Zero)return null;
                IntPtr signerCert=WTHelperGetProvCertFromChain(signer,0);
                if(signerCert==IntPtr.Zero)return null;
                var header=Marshal.PtrToStructure<CRYPT_PROVIDER_CERT_HEADER>(signerCert);
                if(header.cbStruct < IntPtr.Size+4 || header.cbStruct > 2048
                    || header.pCert==IntPtr.Zero)return null;
                // CRYPT_PROVIDER_CERT.pCert is a CERT_CONTEXT*, not an
                // X509Certificate2 managed handle. Copy its DER-encoded
                // signer certificate while WinTrust still owns the state.
                var context=Marshal.PtrToStructure<CERT_CONTEXT_HEADER>(header.pCert);
                if(context.pbCertEncoded==IntPtr.Zero
                    || context.cbCertEncoded is <128 or >1048576)return null;
                var encoded=new byte[context.cbCertEncoded];
                Marshal.Copy(context.pbCertEncoded,encoded,0,encoded.Length);
                return new X509Certificate2(encoded);
            }
            finally
            {
                if(trust.hWVTStateData!=IntPtr.Zero)
                {
                    trust.dwStateAction=2;
                    _=WinVerifyTrust(IntPtr.Zero,ref action,ref trust);
                }
            }
        }
        finally
        {
            Marshal.DestroyStructure<WINTRUST_CATALOG_INFO>(allocation);
            Marshal.FreeHGlobal(allocation);
        }
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct CATALOG_INFO
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]
        public string wszCatalogFile;
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct WINTRUST_CATALOG_INFO
    {
        public uint cbStruct,dwCatalogVersion;
        [MarshalAs(UnmanagedType.LPWStr)]public string? pcwszCatalogFilePath;
        [MarshalAs(UnmanagedType.LPWStr)]public string? pcwszMemberTag;
        [MarshalAs(UnmanagedType.LPWStr)]public string? pcwszMemberFilePath;
        public IntPtr hMemberFile,pbCalculatedFileHash;
        public uint cbCalculatedFileHash;
        public IntPtr pcCatalogContext,hCatAdmin;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData,pSIPClientData;
        public uint dwUIChoice,fdwRevocationChecks,dwUnionChoice;
        public IntPtr pUnion;
        public uint dwStateAction;
        public IntPtr hWVTStateData,pwszURLReference;
        public uint dwProvFlags,dwUIContext;
        public IntPtr pSignatureSettings;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct CRYPT_PROVIDER_CERT_HEADER
    {
        public uint cbStruct;
        public IntPtr pCert;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CERT_CONTEXT_HEADER
    {
        public uint dwCertEncodingType;
        public IntPtr pbCertEncoded;
        public uint cbCertEncoded;
    }

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminAcquireContext2",
        ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATAdminAcquireContext2(out IntPtr context,
        IntPtr subsystem,[MarshalAs(UnmanagedType.LPWStr)]string hashAlgorithm,
        IntPtr strongSignaturePolicy,uint flags);

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminCalcHashFromFileHandle2",
        ExactSpelling=true,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr admin,
        Microsoft.Win32.SafeHandles.SafeFileHandle file,ref uint bytes,IntPtr hash,uint flags);

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminCalcHashFromFileHandle2",
        ExactSpelling=true,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr admin,
        Microsoft.Win32.SafeHandles.SafeFileHandle file,ref uint bytes,[Out]byte[] hash,uint flags);

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminEnumCatalogFromHash",
        ExactSpelling=true,SetLastError=true)]
    private static extern IntPtr CryptCATAdminEnumCatalogFromHash(IntPtr admin,
        [In]byte[] fileHash,uint hashSize,uint flags,ref IntPtr previous);

    [DllImport("wintrust.dll",EntryPoint="CryptCATCatalogInfoFromContext",
        ExactSpelling=true,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATCatalogInfoFromContext(IntPtr catalog,
        ref CATALOG_INFO information,uint flags);

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminReleaseCatalogContext",
        ExactSpelling=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATAdminReleaseCatalogContext(IntPtr admin,
        IntPtr catalog,uint flags);

    [DllImport("wintrust.dll",EntryPoint="CryptCATAdminReleaseContext",
        ExactSpelling=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptCATAdminReleaseContext(IntPtr admin,uint flags);

    [DllImport("wintrust.dll",EntryPoint="WinVerifyTrust",
        ExactSpelling=true,SetLastError=true)]
    private static extern int WinVerifyTrust(IntPtr hwnd,ref Guid action,ref WINTRUST_DATA data);

    [DllImport("wintrust.dll",EntryPoint="WTHelperProvDataFromStateData",ExactSpelling=true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);

    [DllImport("wintrust.dll",EntryPoint="WTHelperGetProvSignerFromChain",ExactSpelling=true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider,uint signerIndex,
        [MarshalAs(UnmanagedType.Bool)]bool counterSigner,uint counterSignerIndex);

    [DllImport("wintrust.dll",EntryPoint="WTHelperGetProvCertFromChain",ExactSpelling=true)]
    private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer,uint certIndex);
}
