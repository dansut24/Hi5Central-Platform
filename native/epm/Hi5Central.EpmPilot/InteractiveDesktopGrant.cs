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

    internal static void RunPreflight()
    {
        IntPtr station=OpenWindowStationW("WinSta0",false,0x00020000|0x00040000);
        if(station==IntPtr.Zero)
            throw new EpmLaunchException("desktop-client-station",Marshal.GetLastWin32Error());
        IntPtr desktop=IntPtr.Zero;
        try
        {
            desktop=OpenDesktopW("Default",0,false,0x00020000|0x00040000);
            if(desktop==IntPtr.Zero)
                throw new EpmLaunchException("desktop-client-default",Marshal.GetLastWin32Error());
            if(!string.Equals(UserObjectInfo(station,UOI_NAME),"WinSta0",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(desktop,UOI_NAME),"Default",StringComparison.OrdinalIgnoreCase))
                throw new EpmLaunchException("desktop-client-identity",5);
        }
        finally
        {
            if(desktop!=IntPtr.Zero)CloseDesktop(desktop);
            CloseWindowStation(station);
        }
    }

    /// <summary>
    /// Called ONLY in the requesting user's interactive process. WinSta0 and
    /// Default are opened in that same Windows session, not duplicated from the
    /// SYSTEM broker's Session 0. The broker supplies a newly created, random
    /// H5EP account SID after verifying the authenticated approval.
    /// </summary>
    internal static InteractiveDesktopGrant AcquireLocal(string adminSid)
    {
        var sid=new SecurityIdentifier(adminSid);
        if(!sid.IsAccountSid()) throw new EpmLaunchException("desktop-grant-sid",87);
        var lease=new InteractiveDesktopGrant(sid);
        try
        {
            // Open the caller's own interactive desktop with READ_CONTROL|WRITE_DAC.
            // No desktop handle is passed to or from Session 0.
            lease.station=OpenWindowStationW("WinSta0",false,0x00020000|0x00040000);
            if(lease.station==IntPtr.Zero)
                throw new EpmLaunchException("desktop-open-station",Marshal.GetLastWin32Error());
            lease.desktop=OpenDesktopW("Default",0,false,0x00020000|0x00040000);
            if(lease.desktop==IntPtr.Zero)
                throw new EpmLaunchException("desktop-open-default",Marshal.GetLastWin32Error());
            if(!string.Equals(UserObjectInfo(lease.station,UOI_TYPE),"WindowStation",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(lease.station,UOI_NAME),"WinSta0",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(lease.desktop,UOI_TYPE),"Desktop",StringComparison.OrdinalIgnoreCase)
                || !string.Equals(UserObjectInfo(lease.desktop,UOI_NAME),"Default",StringComparison.OrdinalIgnoreCase))
                throw new EpmLaunchException("desktop-handle-identity",5);
            lock(DaclLock)
            {
                AddAce(lease.station,sid,WINSTA_ALL_ACCESS);
                lease.stationGranted=true;
                AddAce(lease.desktop,sid,DESKTOP_ALL_ACCESS);
                lease.desktopGranted=true;
            }
            return lease;
        }
        catch {
            lease.Dispose();
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
        if(desktop!=IntPtr.Zero) {CloseDesktop(desktop);desktop=IntPtr.Zero;}
        if(station!=IntPtr.Zero) {CloseWindowStation(station);station=IntPtr.Zero;}
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

    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr OpenDesktopW(string name,uint flags,bool inherit,uint access);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool GetUserObjectInformationW(IntPtr handle,int index,IntPtr info,uint size,out uint required);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle,ref uint info,byte[]? security,uint size,out uint needed);
    [DllImport("user32.dll",SetLastError=true)]
    private static extern bool SetUserObjectSecurity(IntPtr handle,ref uint info,byte[] security);
}

