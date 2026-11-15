using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Hi5Central.EpmPilot;

// Only bounded failure stages and Win32 codes are returned to the RMM audit log.
internal sealed class EpmLaunchException : Exception
{
    internal string Stage { get; }
    internal int WindowsCode { get; }
    internal EpmLaunchException(string stage, int code)
        : base("Approved launch failed at " + stage + " (Windows error " + code + ").")
    { Stage=stage; WindowsCode=code; }
}

/// <summary>
/// Windows EPM pilot: create a random, isolated local administrator identity,
/// launch only the already verified and one-time-approved executable, and keep
/// that account's profile alive until the installer and its child processes end.
/// No installer copy or generic SYSTEM command shell is created.
/// </summary>
internal sealed record EpmProcessObservation(uint Pid,uint? ExitCode,string EndReason,int ElapsedMs);

internal static class AdminLaunch
{
    private static readonly ConcurrentDictionary<uint, LaunchLease> Active = new();
    private const uint CREATE_NEW_CONSOLE=0x10, CREATE_SUSPENDED=0x4, CREATE_UNICODE_ENVIRONMENT=0x400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
    private const uint WAIT_FAILED=0xFFFFFFFF;

    public static int Launch(string approvedFile,int sessionId,Action<string> grantInteractiveDesktop,
        Func<EpmProcessObservation,Task>? onExited=null)
    {
        string account="H5EP"+Convert.ToHexString(RandomNumberGenerator.GetBytes(5));
        string password=Convert.ToHexString(RandomNumberGenerator.GetBytes(24))+"!qA9";
        var user=new USER_INFO_1 { usri1_name=account,usri1_password=password,
          usri1_priv=1,usri1_flags=1,usri1_home_dir="",usri1_comment="Hi5Central one-time EPM elevation" };
        int created=NetUserAdd(null,1,ref user,out _);
        if(created!=0)throw new EpmLaunchException("create-admin-identity",created);
        var lease=new LaunchLease(account);
        try
        {
            string administrators=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)
                .Translate(typeof(NTAccount)).Value.Split('\\').Last();
            var member=new LOCALGROUP_MEMBERS_INFO_3 {
                lgrmi3_domainandname=Environment.MachineName+"\\"+account };
            int joined=NetLocalGroupAddMembers(null,administrators,3,ref member,1);
            if(joined!=0)throw new EpmLaunchException("assign-admin-group",joined);
            if(!LogonUser(account,Environment.MachineName,password,2,0,out var token))
                throw new EpmLaunchException("logon-identity",Marshal.GetLastWin32Error());
            try
            {
                IntPtr elevated=token;
                if(GetTokenInformation(token,19,out var linked,IntPtr.Size,out _) && linked!=IntPtr.Zero)
                    elevated=linked;
                try
                {
                    if(!IsEnabledAdministratorToken(elevated))
                        throw new EpmLaunchException("validate-elevated-token",0);
                    if(!DuplicateTokenEx(elevated,0xF01FF,IntPtr.Zero,2,1,out var primary))
                        throw new EpmLaunchException("duplicate-primary-token",Marshal.GetLastWin32Error());
                    lease.Token=primary;
                }
                finally { if(elevated!=token)CloseHandle(elevated); }
            }
            finally { CloseHandle(token); }

            int session=sessionId;
            if(!SetTokenInformation(lease.Token,12,ref session,sizeof(int)))
                throw new EpmLaunchException("bind-desktop-session",Marshal.GetLastWin32Error());

            using(var identity=new WindowsIdentity(lease.Token))
                lease.Sid=identity.User?.Value ?? throw new EpmLaunchException("resolve-admin-sid",0);

            // Never duplicate a desktop handle between Session 0 and the user
            // session. Request a bounded ACL grant in the authenticated user's
            // interactive companion before creating this elevated process.
            grantInteractiveDesktop(lease.Sid);

            // Windows does not load HKCU or create USERPROFILE for CreateProcessAsUser.
            var profile=new PROFILEINFO {
                dwSize=(uint)Marshal.SizeOf<PROFILEINFO>(),dwFlags=1,lpUserName=account
            };
            if(!LoadUserProfile(lease.Token,ref profile))
                throw new EpmLaunchException("load-admin-profile",Marshal.GetLastWin32Error());
            lease.Profile=profile.hProfile;
            if(!CreateEnvironmentBlock(out var environment,lease.Token,false))
                throw new EpmLaunchException("create-user-environment",Marshal.GetLastWin32Error());
            lease.Environment=environment;

            lease.Job=CreateJobObject(IntPtr.Zero,null);
            if(lease.Job==IntPtr.Zero)
                throw new EpmLaunchException("create-process-job",Marshal.GetLastWin32Error());
            var jobLimit=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            jobLimit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if(!SetInformationJobObject(lease.Job,9,ref jobLimit,
                (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
                throw new EpmLaunchException("set-process-job-limits",Marshal.GetLastWin32Error());

            var startup=new STARTUPINFO {
                cb=Marshal.SizeOf<STARTUPINFO>(),lpDesktop=@"winsta0\default" };
            string command="\""+approvedFile+"\"";
            if(!CreateProcessAsUser(lease.Token,approvedFile,command,
                IntPtr.Zero,IntPtr.Zero,false,
                CREATE_NEW_CONSOLE|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,
                lease.Environment,Path.GetDirectoryName(approvedFile),ref startup,out var process))
                throw new EpmLaunchException("create-elevated-process",Marshal.GetLastWin32Error());
            lease.Process=process.hProcess;
            try
            {
                if(!AssignProcessToJobObject(lease.Job,lease.Process))
                    throw new EpmLaunchException("assign-process-job",Marshal.GetLastWin32Error());
                uint resumed=ResumeThread(process.hThread);
                if(resumed==WAIT_FAILED)
                    throw new EpmLaunchException("resume-approved-process",Marshal.GetLastWin32Error());
                uint pid=process.dwProcessId;
                if(!Active.TryAdd(pid,lease))
                    throw new EpmLaunchException("track-approved-process",0);
                // Monitor the process tree without blocking the interactive approval dialog.
                _=Task.Run(()=>MonitorJob(pid,lease,onExited));
                return checked((int)pid);
            }
            finally { CloseHandle(process.hThread); }
        }
        catch
        {
            // Fail closed: job close terminates any created, still-suspended process.
            lease.Dispose();
            throw;
        }
    }

    private static async Task MonitorJob(uint pid,LaunchLease lease,
        Func<EpmProcessObservation,Task>? onExited)
    {
        var started=DateTime.UtcNow;
        string reason="job-empty";
        uint? exitCode=null;
        try
        {
            var deadline=started.AddMinutes(45);
            while(DateTime.UtcNow<deadline)
            {
                if(!QueryInformationJobObject(lease.Job,1,out var accounting,
                    (uint)Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(),out _))
                {
                    reason="job-query-error";
                    break;
                }
                if(accounting.ActiveProcesses==0)break;
                await Task.Delay(1000).ConfigureAwait(false);
            }
            if(DateTime.UtcNow>=deadline)reason="timeout";
        }
        catch { reason="monitor-error"; }
        finally
        {
            try
            {
                // Exit status is valid only after the initial process is signaled.
                // It does not prove an installer completed successfully.
                if(lease.Process!=IntPtr.Zero && WaitForSingleObject(lease.Process,0)==0
                    && GetExitCodeProcess(lease.Process,out var nativeExit))
                    exitCode=nativeExit;
            }
            catch { /* unknown exit is not success */ }
            var elapsed=(int)Math.Clamp((DateTime.UtcNow-started).TotalMilliseconds,0,2700000);
            lease.Dispose();
            Active.TryRemove(pid,out _);
            if(onExited is not null)
            {
                try {await onExited(new EpmProcessObservation(pid,exitCode,reason,elapsed)).ConfigureAwait(false);}
                catch { /* audit network loss must not keep an admin identity alive */ }
            }
        }
    }

    // Stop-Service must not orphan any temporary local administrator account.
    internal static void StopActiveLaunches()
    {
        foreach(var active in Active.ToArray())
        {
            active.Value.Dispose();
            Active.TryRemove(active.Key,out _);
        }
    }

    private sealed class LaunchLease : IDisposable
    {
        private int disposed;
        public string Account {get;}
        public string Sid {get;set;}="";
        public IntPtr Token, Profile, Environment, Process, Job;
        public LaunchLease(string account) {Account=account;}
        public void Dispose()
        {
            if(Interlocked.Exchange(ref disposed,1)!=0)return;
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE prevents privileged child
            // processes remaining after cleanup/timeout/service stop.
            if(Job!=IntPtr.Zero) {CloseHandle(Job);Job=IntPtr.Zero;}
            if(Process!=IntPtr.Zero) {
                WaitForSingleObject(Process,5000);
                CloseHandle(Process);Process=IntPtr.Zero;
            }
            if(Environment!=IntPtr.Zero) {
                DestroyEnvironmentBlock(Environment);Environment=IntPtr.Zero;
            }
            if(Profile!=IntPtr.Zero && Token!=IntPtr.Zero) {
                UnloadUserProfile(Token,Profile);Profile=IntPtr.Zero;
            }
            if(Token!=IntPtr.Zero) {CloseHandle(Token);Token=IntPtr.Zero;}
            // Only the random, internally generated H5EP identity is deleted.
            NetUserDel(null,Account);
            if(Sid.StartsWith("S-1-",StringComparison.Ordinal))
                DeleteProfile(Sid,null,null);
        }
    }

    internal static bool IsEnabledAdministratorToken(IntPtr primaryToken)
    {
        const uint queryAndDuplicate=0x0008|0x0002;
        if(!DuplicateTokenEx(primaryToken,queryAndDuplicate,IntPtr.Zero,2,2,out var checkToken))
            throw new EpmLaunchException("duplicate-check-token",Marshal.GetLastWin32Error());
        try
        {
            var adminSid=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
            var sid=new byte[adminSid.BinaryLength];adminSid.GetBinaryForm(sid,0);
            var ptr=Marshal.AllocHGlobal(sid.Length);
            try
            {
                Marshal.Copy(sid,0,ptr,sid.Length);
                if(!CheckTokenMembership(checkToken,ptr,out bool isMember))
                    throw new EpmLaunchException("check-token-membership",Marshal.GetLastWin32Error());
                return isMember;
            }
            finally {Marshal.FreeHGlobal(ptr);}
        }
        finally {CloseHandle(checkToken);}
    }
    internal static void RunTokenSelfTest()
    {
        if(!OpenProcessToken(GetCurrentProcess(),0x0008|0x0002,out var token))
            throw new EpmLaunchException("self-test-open-process-token",Marshal.GetLastWin32Error());
        try {_=IsEnabledAdministratorToken(token);}
        finally {CloseHandle(token);}
        // Test non-destructive ACL add/remove against a synthetic desktop ACL.
        InteractiveDesktopGrant.RunAclSelfTest();
        // Exercise and verify job-limit marshalling on the Windows CI runner.
        var job=CreateJobObject(IntPtr.Zero,null);
        if(job==IntPtr.Zero)throw new EpmLaunchException("self-test-create-job",Marshal.GetLastWin32Error());
        try
        {
            var info=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
                throw new EpmLaunchException("self-test-set-job-limit",Marshal.GetLastWin32Error());
        }
        finally {CloseHandle(job);}
    }

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct USER_INFO_1 {
        [MarshalAs(UnmanagedType.LPWStr)] public string? usri1_name;
        [MarshalAs(UnmanagedType.LPWStr)] public string? usri1_password;
        public uint usri1_password_age,usri1_priv;
        [MarshalAs(UnmanagedType.LPWStr)] public string? usri1_home_dir;
        [MarshalAs(UnmanagedType.LPWStr)] public string? usri1_comment;
        public uint usri1_flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string? usri1_script_path;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct LOCALGROUP_MEMBERS_INFO_3 {
        [MarshalAs(UnmanagedType.LPWStr)] public string? lgrmi3_domainandname;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct PROFILEINFO {
        public uint dwSize,dwFlags;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpUserName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpProfilePath;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpDefaultPath;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpServerName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpPolicyPath;
        public IntPtr hProfile;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb;public string? lpReserved;public string? lpDesktop;public string? lpTitle;
        public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
        public short wShowWindow,cbReserved2;
        public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit,PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass,SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount;
        public ulong ReadTransferCount,WriteTransferCount,OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime,TotalKernelTime;
        public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses;
    }

    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)] private static extern int NetUserAdd(string? server,uint level,ref USER_INFO_1 user,out int parameter);
    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)] private static extern int NetUserDel(string? server,string username);
    [DllImport("Netapi32.dll",CharSet=CharSet.Unicode)] private static extern int NetLocalGroupAddMembers(string? server,string group,uint level,ref LOCALGROUP_MEMBERS_INFO_3 users,uint total);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool LogonUser(string user,string domain,string password,int logonType,int provider,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int infoClass,out IntPtr linkedToken,int length,out int actualLength);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool member);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool DuplicateTokenEx(IntPtr existing,uint access,IntPtr attributes,int level,int tokenType,out IntPtr primary);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool SetTokenInformation(IntPtr token,int type,ref int value,int length);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool CreateProcessAsUser(IntPtr token,string app,string cmd,IntPtr processAttr,IntPtr threadAttr,bool inherit,uint flags,IntPtr env,string? workingDir,ref STARTUPINFO startup,out PROCESS_INFORMATION info);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("userenv.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool LoadUserProfile(IntPtr token,ref PROFILEINFO info);
    [DllImport("userenv.dll",SetLastError=true)] private static extern bool UnloadUserProfile(IntPtr token,IntPtr profile);
    [DllImport("userenv.dll",SetLastError=true)] private static extern bool CreateEnvironmentBlock(out IntPtr environment,IntPtr token,bool inherit);
    [DllImport("userenv.dll",SetLastError=true)] private static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("userenv.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool DeleteProfile(string sid,string? path,string? computerName);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes,string? name);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job,int infoClass,out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info,uint size,out uint returned);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
}
