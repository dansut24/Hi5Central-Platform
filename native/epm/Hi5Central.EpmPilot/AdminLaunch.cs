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
// Only expose a fixed stage identifier and numeric Win32 code. Passwords,
// device secrets and local security tokens are never added to diagnostics.
internal sealed class EpmLaunchException : Exception
{
    internal string Stage { get; }
    internal int WindowsCode { get; }
    internal EpmLaunchException(string stage,int windowsCode)
        : base("Approved launch failed at " + stage + " (Windows error " + windowsCode + ").")
    { Stage=stage; WindowsCode=windowsCode; }
}

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
        if(created!=0)throw new EpmLaunchException("create-admin-identity",created);
        try {
            string administrators=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)
                .Translate(typeof(NTAccount)).Value.Split('\\').Last();
            var member=new LOCALGROUP_MEMBERS_INFO_3 { lgrmi3_domainandname=Environment.MachineName+"\\"+account };
            int joined=NetLocalGroupAddMembers(null,administrators,3,ref member,1);
            if(joined!=0)throw new EpmLaunchException("assign-admin-group",joined);
            if(!LogonUser(account,Environment.MachineName,password,2,0,out var token))
                throw new EpmLaunchException("logon-identity",Marshal.GetLastWin32Error());
            try {
                // On UAC-enabled Windows, LogonUser may return a filtered local-admin
                // token. The linked full token is required for actual approved elevation.
                // Do not disable UAC or use a generic SYSTEM process instead.
                IntPtr elevated = token;
                if (GetTokenInformation(token, 19, out var linked, IntPtr.Size, out _)
                    && linked != IntPtr.Zero) elevated = linked;
                try {
                // CheckTokenMembership requires an IMPERSONATION token.
                // LogonUser and TokenLinkedToken return PRIMARY tokens. Passing
                // either directly can fail or incorrectly reject a valid admin.
                if (!IsEnabledAdministratorToken(elevated))
                    throw new EpmLaunchException("validate-elevated-token",0);
                if(!DuplicateTokenEx(elevated,0xF01FF,IntPtr.Zero,2,1,out var primary))
                    throw new EpmLaunchException("duplicate-primary-token",Marshal.GetLastWin32Error());
                try {
                    var session=sessionId;
                    if(!SetTokenInformation(primary,12,ref session,sizeof(int)))
                        throw new EpmLaunchException("bind-desktop-session",Marshal.GetLastWin32Error());
                    var startup=new STARTUPINFO { cb=Marshal.SizeOf<STARTUPINFO>(), lpDesktop=@"winsta0\default" };
                    string command="\""+approvedFile+"\"";
                    if(!CreateProcessAsUser(primary,approvedFile,command,IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,
                        Path.GetDirectoryName(approvedFile),ref startup,out var process))
                        throw new EpmLaunchException("create-elevated-process",Marshal.GetLastWin32Error());
                    try { return checked((int)process.dwProcessId); }
                    finally { CloseHandle(process.hThread);CloseHandle(process.hProcess); }
                } finally {CloseHandle(primary);}
                } finally { if (elevated != token) CloseHandle(elevated); }
            } finally {CloseHandle(token);}
        } finally {NetUserDel(null,account);}
    }

    // A primary token cannot be used directly with CheckTokenMembership.
    // Explicitly duplicate it as TokenImpersonation, then ask Windows whether
    // the Administrators SID is enabled. Never accept deny-only membership.
    internal static bool IsEnabledAdministratorToken(IntPtr primaryToken)
    {
        const uint TOKEN_QUERY_AND_DUPLICATE = 0x0008 | 0x0002;
        if (!DuplicateTokenEx(primaryToken,TOKEN_QUERY_AND_DUPLICATE,
            IntPtr.Zero,2,2,out var impersonationToken))
            throw new EpmLaunchException("duplicate-check-token",Marshal.GetLastWin32Error());
        try {
            var adminSid=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
            var sid=new byte[adminSid.BinaryLength];
            adminSid.GetBinaryForm(sid,0);
            var ptr=Marshal.AllocHGlobal(sid.Length);
            try {
                Marshal.Copy(sid,0,ptr,sid.Length);
                if (!CheckTokenMembership(impersonationToken,ptr,out var isEnabled))
                    throw new EpmLaunchException("check-token-membership",Marshal.GetLastWin32Error());
                return isEnabled;
            } finally { Marshal.FreeHGlobal(ptr); }
        } finally { CloseHandle(impersonationToken); }
    }

    internal static void RunTokenSelfTest()
    {
        // CI exercising the exact primary-token → impersonation-token validation
        // path against the runner's actual access token, without launching or
        // creating any administrator account.
        if (!OpenProcessToken(GetCurrentProcess(),0x0008|0x0002,out var token))
            throw new EpmLaunchException("self-test-open-process-token",Marshal.GetLastWin32Error());
        try {
            _=IsEnabledAdministratorToken(token);
        } finally { CloseHandle(token); }
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
    [DllImport("kernel32.dll")]private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)]
    private static extern bool OpenProcessToken(IntPtr process,uint desiredAccess,out IntPtr token);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool CloseHandle(IntPtr handle);
}
