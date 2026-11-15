using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Per-request access to ONLY the requesting user's WinSta0/Default desktop.
/// Duplicates handles supplied by the OS-authenticated named-pipe client; NEVER
/// opens a window station in service Session 0 or changes UAC/secure desktop.
/// An ACE for the random ephemeral administrator SID is added and later removed.
/// </summary>
internal sealed class InteractiveDesktopGrant : IDisposable
{
    private const int UOI_NAME=2, UOI_TYPE=3;
    private const uint DACL_SECURITY_INFORMATION=4;
    private const uint DUPLICATE_SAME_ACCESS=2;
    private const uint PROCESS_DUP_HANDLE=0x40;
    private const int WINSTA_ALL_ACCESS=0x000F037F;
    private const int DESKTOP_ALL_ACCESS=0x000F01FF;
    private static readonly object DaclLock=new();
    private readonly SecurityIdentifier admin;
    private IntPtr station;
    private IntPtr desktop;
    private bool stationGranted, desktopGranted, disposed;

    private InteractiveDesktopGrant(SecurityIdentifier sid) { admin=sid; }

    internal static InteractiveDesktopGrant Acquire(uint clientPid,long sourceStation,
        long sourceDesktop,string adminSid)
    {
        if(clientPid==0 || sourceStation<=0 || sourceDesktop<=0)
            throw new EpmLaunchException("desktop-client-handles",87);
        var sid=new SecurityIdentifier(adminSid);
        var result=new InteractiveDesktopGrant(sid);
        IntPtr process=OpenProcess(PROCESS_DUP_HANDLE,false,clientPid);
        if(process==IntPtr.Zero)
            throw new EpmLaunchException("desktop-open-client",Marshal.GetLastWin32Error());
        try {
            if(!DuplicateHandle(process,new IntPtr(sourceStation),GetCurrentProcess(),
                out result.station,0,false,DUPLICATE_SAME_ACCESS))
                throw new EpmLaunchException("desktop-duplicate-station",Marshal.GetLastWin32Error());
            if(!DuplicateHandle(process,new IntPtr(sourceDesktop),GetCurrentProcess(),
                out result.desktop,0,false,DUPLICATE_SAME_ACCESS))
                throw new EpmLaunchException("desktop-duplicate-desktop",Marshal.GetLastWin32Error());
        }
        catch {
            result.Dispose();
            throw;
        }
        finally { CloseHandle(process); }

        try
        {
            // Do not accept arbitrary client handles; validate both kernel
            // object TYPE and NAME before editing any security descriptor.
            if(!string.Equals(UserObjectInfo(result.station,UOI_TYPE),"WindowStation",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(result.station,UOI_NAME),"WinSta0",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(result.desktop,UOI_TYPE),"Desktop",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(result.desktop,UOI_NAME),"Default",StringComparison.OrdinalIgnoreCase))
                throw new EpmLaunchException("desktop-handle-identity",5);
            lock(DaclLock)
            {
                AddAce(result.station,sid,WINSTA_ALL_ACCESS);
                result.stationGranted=true;
                AddAce(result.desktop,sid,DESKTOP_ALL_ACCESS);
                result.desktopGranted=true;
            }
            return result;
        }
        catch {
            result.Dispose();
            throw;
        }
    }

    private static string UserObjectInfo(IntPtr handle,int informationClass)
    {
        if(!GetUserObjectInformationW(handle,informationClass,IntPtr.Zero,0,out var needed)
            && needed==0)
            throw new EpmLaunchException("desktop-query-identity",Marshal.GetLastWin32Error());
        if(needed<2 || needed>1024)
            throw new EpmLaunchException("desktop-query-identity",87);
        var buffer=Marshal.AllocHGlobal(checked((int)needed));
        try {
            if(!GetUserObjectInformationW(handle,informationClass,buffer,needed,out _))
                throw new EpmLaunchException("desktop-query-identity",Marshal.GetLastWin32Error());
            return Marshal.PtrToStringUni(buffer)??"";
        }
        finally {Marshal.FreeHGlobal(buffer);}
    }

    private static RawSecurityDescriptor ReadDescriptor(IntPtr obj)
    {
        uint info=DACL_SECURITY_INFORMATION;
        GetUserObjectSecurity(obj,ref info,null,0,out var bytesNeeded);
        if(bytesNeeded<20 || bytesNeeded>65536)
            throw new EpmLaunchException("desktop-read-acl",Marshal.GetLastWin32Error());
        var buffer=new byte[bytesNeeded];
        if(!GetUserObjectSecurity(obj,ref info,buffer,(uint)buffer.Length,out _))
            throw new EpmLaunchException("desktop-read-acl",Marshal.GetLastWin32Error());
        var descriptor=new RawSecurityDescriptor(buffer,0);
        if(descriptor.DiscretionaryAcl is null)
            throw new EpmLaunchException("desktop-missing-acl",5);
        return descriptor;
    }

    internal static void InsertSpecificAce(RawSecurityDescriptor descriptor,
        SecurityIdentifier sid,int access)
    {
        var acl=descriptor.DiscretionaryAcl
            ?? throw new EpmLaunchException("desktop-missing-acl",5);
        // The SID is a new, random local identity and must not be allowed
        // by any existing ACE: fail closed rather than changing old policy.
        for(int i=0;i<acl.Count;i++)
            if(acl[i] is QualifiedAce existing && existing.SecurityIdentifier.Equals(sid))
                throw new EpmLaunchException("desktop-duplicate-admin-sid",5);
        acl.InsertAce(acl.Count,new CommonAce(
            AceFlags.None,AceQualifier.AccessAllowed,access,sid,false,null));
    }

    internal static void RemoveSpecificAce(RawSecurityDescriptor descriptor,
        SecurityIdentifier sid,int access)
    {
        var acl=descriptor.DiscretionaryAcl;
        if(acl is null)return;
        for(int i=acl.Count-1;i>=0;i--)
        {
            if(acl[i] is CommonAce ace && ace.AceFlags==AceFlags.None
                && ace.AceQualifier==AceQualifier.AccessAllowed
                && ace.AccessMask==access && ace.SecurityIdentifier.Equals(sid))
            {
                acl.RemoveAce(i);
                return;
            }
        }
    }

    private static void WriteDescriptor(IntPtr obj,RawSecurityDescriptor descriptor)
    {
        var bytes=new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes,0);
        uint securityInfo=DACL_SECURITY_INFORMATION;
        if(!SetUserObjectSecurity(obj,ref securityInfo,bytes))
            throw new EpmLaunchException("desktop-write-acl",Marshal.GetLastWin32Error());
    }

    private static void AddAce(IntPtr obj,SecurityIdentifier sid,int rights)
    {
        var desc=ReadDescriptor(obj);
        InsertSpecificAce(desc,sid,rights);
        WriteDescriptor(obj,desc);
    }
    private static void RemoveAce(IntPtr obj,SecurityIdentifier sid,int rights)
    {
        var desc=ReadDescriptor(obj);
        RemoveSpecificAce(desc,sid,rights);
        WriteDescriptor(obj,desc);
    }

    public void Dispose()
    {
        if(disposed)return;
        disposed=true;
        lock(DaclLock)
        {
            if(desktopGranted)
            {
                try {RemoveAce(desktop,admin,DESKTOP_ALL_ACCESS);}
                catch { /* no widened ACL fallback; leave only dead random SID if removed later */ }
                desktopGranted=false;
            }
            if(stationGranted)
            {
                try {RemoveAce(station,admin,WINSTA_ALL_ACCESS);}
                catch { /* cleanup is retried at the next controlled launch */ }
                stationGranted=false;
            }
        }
        if(desktop!=IntPtr.Zero) {CloseHandle(desktop);desktop=IntPtr.Zero;}
        if(station!=IntPtr.Zero) {CloseHandle(station);station=IntPtr.Zero;}
    }

    internal static void RunAclSelfTest()
    {
        var sid=new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid,null);
        var other=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
        var acl=new RawAcl(2,2);
        acl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,
            0x1000,other,false,null));
        var desc=new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent,
            null,null,null,acl);
        InsertSpecificAce(desc,sid,DESKTOP_ALL_ACCESS);
        if(desc.DiscretionaryAcl?.Count!=2)
            throw new InvalidOperationException("EPM DACL self-test failed to add one ACE.");
        RemoveSpecificAce(desc,sid,DESKTOP_ALL_ACCESS);
        if(desc.DiscretionaryAcl?.Count!=1
            || !((QualifiedAce)desc.DiscretionaryAcl[0]).SecurityIdentifier.Equals(other))
            throw new InvalidOperationException("EPM DACL self-test failed to preserve old ACE.");
    }

    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr sourceHandle,
        IntPtr targetProcess,out IntPtr targetHandle,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle,int index,IntPtr info,uint size,out uint required);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle,ref uint info,byte[]? security,uint size,out uint needed);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool SetUserObjectSecurity(IntPtr handle,ref uint info,byte[] security);
}

/// <summary>Handles opened in the requesting user's interactive session, not Session 0.</summary>
internal sealed class InteractiveDesktopHandles : IDisposable
{
    private const uint READ_CONTROL=0x00020000,WRITE_DAC=0x00040000;
    public IntPtr Station {get;private set;}
    public IntPtr Desktop {get;private set;}

    private InteractiveDesktopHandles(IntPtr station,IntPtr desktop)
    { Station=station;Desktop=desktop; }

    internal static InteractiveDesktopHandles Open()
    {
        // The ordinary user already owns access to their interactive desktop.
        // If Windows denies READ_CONTROL|WRITE_DAC, fail closed; never alter
        // a policy, take ownership, or disable the secure UAC desktop.
        var station=OpenWindowStationW("WinSta0",false,READ_CONTROL|WRITE_DAC);
        if(station==IntPtr.Zero)
            throw new EpmLaunchException("desktop-client-station",Marshal.GetLastWin32Error());
        var desktop=OpenDesktopW("Default",0,false,READ_CONTROL|WRITE_DAC);
        if(desktop==IntPtr.Zero)
        {
            int code=Marshal.GetLastWin32Error();
            CloseWindowStation(station);
            throw new EpmLaunchException("desktop-client-default",code);
        }
        return new InteractiveDesktopHandles(station,desktop);
    }
    public void Dispose()
    {
        if(Desktop!=IntPtr.Zero){CloseDesktop(Desktop);Desktop=IntPtr.Zero;}
        if(Station!=IntPtr.Zero){CloseWindowStation(Station);Station=IntPtr.Zero;}
    }

    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr OpenDesktopW(string name,uint flags,bool inherit,uint access);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
}
