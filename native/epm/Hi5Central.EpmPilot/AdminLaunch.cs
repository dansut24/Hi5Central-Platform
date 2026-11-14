using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Trial-only isolated elevation: temporary random local administrator token,
/// never the requesting user's token and never a SYSTEM shell. Account deleted
/// as soon as launch is attempted. Only the service can invoke this function.
/// </summary>
internal static class AdminLaunch
{
    public static int Launch(string approvedFile,int sessionId)
    {
        string account="H5EP"+Convert.ToHexString(RandomNumberGenerator.GetBytes(5));
        string password=Convert.ToHexString(RandomNumberGenerator.GetBytes(24))+"!qA9";
        var user=new USER_INFO_1 { usri1_name=account,usri1_password=password,
          usri1_priv=1,usri1_flags=1,usri1_home_dir="",usri1_comment="Hi5Central one-time EPM elevation" };
        int parameter;
        int created=NetUserAdd(null,1,ref user,out parameter);
        if(created!=0)throw new Win32Exception(created,"Cannot create one-time elevation identity.");
        try {
            string administrators=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)
                .Translate(typeof(NTAccount)).Value.Split('\\').Last();
            var member=new LOCALGROUP_MEMBERS_INFO_3 { lgrmi3_domainandname=Environment.MachineName+"\\"+account };
            int joined=NetLocalGroupAddMembers(null,administrators,3,ref member,1);
            if(joined!=0)throw new Win32Exception(joined,"Could not assign isolated local-admin identity.");
            if(!LogonUser(account,Environment.MachineName,password,2,0,out var token))
                throw new Win32Exception(Marshal.GetLastWin32Error(),"Isolated admin logon failed.");
            try {
                // On UAC-enabled Windows, LogonUser may return a filtered local-admin
                // token. The linked full token is required for actual approved elevation.
                // Do not disable UAC or use a generic SYSTEM process instead.
                IntPtr elevated = token;
                if (GetTokenInformation(token, 19, out var linked, IntPtr.Size, out _)
                    && linked != IntPtr.Zero) elevated = linked;
                try {
                var adminSid=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
                var sid=new byte[adminSid.BinaryLength]; adminSid.GetBinaryForm(sid,0);
                var ptr=Marshal.AllocHGlobal(sid.Length);
                try {
                    Marshal.Copy(sid,0,ptr,sid.Length);
                    if(!CheckTokenMembership(elevated,ptr,out var memberEnabled) || !memberEnabled)
                        throw new InvalidOperationException("Windows did not grant an elevated administrator token.");
                } finally {Marshal.FreeHGlobal(ptr);}
                if(!DuplicateTokenEx(elevated,0xF01FF,IntPtr.Zero,2,1,out var primary))
                    throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot create primary elevation token.");
                try {
                    var session=sessionId;
                    if(!SetTokenInformation(primary,12,ref session,sizeof(int)))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot bind approval to desktop session.");
                    var startup=new STARTUPINFO { cb=Marshal.SizeOf<STARTUPINFO>(), lpDesktop=@"winsta0\default" };
                    string command="\""+approvedFile+"\"";
                    if(!CreateProcessAsUser(primary,approvedFile,command,IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,
                        Path.GetDirectoryName(approvedFile),ref startup,out var process))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),"Approved process could not launch.");
                    try { return checked((int)process.dwProcessId); }
                    finally { CloseHandle(process.hThread);CloseHandle(process.hProcess); }
                } finally {CloseHandle(primary);}
                } finally { if (elevated != token) CloseHandle(elevated); }
            } finally {CloseHandle(token);}
        } finally {NetUserDel(null,account);}
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct USER_INFO_1 {
        [MarshalAs(UnmanagedType.LPWStr)]public string? usri1_name;
        [MarshalAs(UnmanagedType.LPWStr)]public string? usri1_password;
        public uint usri1_password_age;
        public uint usri1_priv;
        [MarshalAs(UnmanagedType.LPWStr)]public string? usri1_home_dir;
        [MarshalAs(UnmanagedType.LPWStr)]public string? usri1_comment;
        public uint usri1_flags;
        [MarshalAs(UnmanagedType.LPWStr)]public string? usri1_script_path;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct LOCALGROUP_MEMBERS_INFO_3 {
        [MarshalAs(UnmanagedType.LPWStr)]public string? lgrmi3_domainandname;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX;public int dwY;public int dwXSize;public int dwYSize;public int dwXCountChars;public int dwYCountChars;
        public int dwFillAttribute;public int dwFlags;public short wShowWindow;public short cbReserved2;public IntPtr lpReserved2;
        public IntPtr hStdInput;public IntPtr hStdOutput;public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId;public uint dwThreadId;
    }
    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)]private static extern int NetUserAdd(string? server,uint level,ref USER_INFO_1 user,out int parameter);
    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)]private static extern int NetUserDel(string? server,string username);
    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)]private static extern int NetLocalGroupAddMembers(string? server,string group,uint level,ref LOCALGROUP_MEMBERS_INFO_3 users,uint total);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)]private static extern bool LogonUser(string user,string domain,string password,int logonType,int provider,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)]private static extern bool GetTokenInformation(
        IntPtr token,int informationClass,out IntPtr linkedToken,int length,out int returnedLength);
    [DllImport("advapi32.dll",SetLastError=true)]private static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool isMember);
    [DllImport("advapi32.dll",SetLastError=true)]private static extern bool DuplicateTokenEx(IntPtr existing,uint access,IntPtr attributes,int level,int tokenType,out IntPtr primary);
    [DllImport("advapi32.dll",SetLastError=true)]private static extern bool SetTokenInformation(IntPtr token,int type,ref int value,int length);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token,string app,string cmd,IntPtr processAttr,
        IntPtr threadAttr,bool inherit,uint flags,IntPtr environment,string? workingDirectory,ref STARTUPINFO startup,out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool CloseHandle(IntPtr handle);
}
