using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Immutable operation identity for Hi5Central EPM. Captured by a trusted
/// pre-launch adapter; never reconstructed from an arbitrary native UAC
/// window, its caption, foreground process or most recent download.
/// Identity alone does NOT authorise execution.
/// </summary>
internal enum ElevationKind
{
    SignedExecutable,
    WindowsInstaller,
    PowerShellScript,
    ManagedWindowsAction,
    PrivilegedFileOperation,
    NestedChildProcess,
    UnmanagedNativeUac
}
internal enum ElevationCapture
{
    ExplorerSelectedItem,
    BrowserCompletedDownload,
    ManagedApplication,
    EndpointPolicy,
    None
}
internal enum ElevationRoute
{
    ExistingSignedExeBroker,
    WorkerNotImplemented,
    WindowsUacFallback,
    Reject
}

internal sealed record ElevationTarget(
    ElevationKind Kind,
    ElevationCapture Capture,
    string Identifier,
    string Sha256,
    string Publisher,
    string? OperationCode = null,
    string? ArgumentsDigest = null,
    string? ParentOperationId = null
);

internal sealed record ElevationActor(
    string TenantId,
    string DeviceId,
    string UserSid,
    int SessionId
);

internal sealed record ElevationIntent(
    Guid RequestId,
    ElevationTarget Target,
    ElevationActor Actor,
    string BindingHash,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    bool IsConsumed = false
);

internal sealed record ElevationAssessment(
    ElevationRoute Route,
    string Reason,
    bool HasTrustedAutomaticIdentity,
    bool HasActiveExecutionWorker
);

internal static class ElevationPolicy
{
    internal static ElevationAssessment Assess(ElevationTarget? target)
    {
        if(target is null || target.Kind==ElevationKind.UnmanagedNativeUac ||
           target.Capture==ElevationCapture.None)
            return new(ElevationRoute.WindowsUacFallback,
                "The native UAC prompt did not supply a trusted target identity.",false,false);
        if(target.Identifier.Length is < 1 or > 4096 ||
            target.Identifier.Contains('\0') ||
            !IsSha256(target.Sha256))
            return new(ElevationRoute.Reject,
                "Invalid or incomplete target identity.",false,false);
        bool capturedFile=target.Capture is
            ElevationCapture.ExplorerSelectedItem or ElevationCapture.BrowserCompletedDownload or
            ElevationCapture.ManagedApplication;
        if(target.Kind==ElevationKind.SignedExecutable &&
           capturedFile && IsLocalFileIdentity(target.Identifier,".exe") &&
           !string.IsNullOrWhiteSpace(target.Publisher) &&
           string.IsNullOrWhiteSpace(target.OperationCode) &&
           string.IsNullOrWhiteSpace(target.ArgumentsDigest) &&
           string.IsNullOrWhiteSpace(target.ParentOperationId))
            return new(ElevationRoute.ExistingSignedExeBroker,
                "Existing one-use EXE broker must independently recheck Authenticode, SHA-256 and user/session.",true,true);

        bool identifiable=target.Kind switch {
            ElevationKind.WindowsInstaller => capturedFile &&
                IsLocalFileIdentity(target.Identifier,".msi"),
            ElevationKind.PowerShellScript => capturedFile &&
                IsLocalFileIdentity(target.Identifier,".ps1"),
            ElevationKind.ManagedWindowsAction =>
                target.Capture==ElevationCapture.EndpointPolicy &&
                target.OperationCode is not null &&
                target.OperationCode.StartsWith("H5C.",StringComparison.Ordinal) &&
                target.OperationCode.Length<=128,
            ElevationKind.PrivilegedFileOperation =>
                target.Capture==ElevationCapture.EndpointPolicy &&
                target.OperationCode is not null && target.OperationCode.Length<=128,
            ElevationKind.NestedChildProcess => !string.IsNullOrWhiteSpace(target.ParentOperationId),
            _ => false
        };
        if(identifiable)
            return new(ElevationRoute.WorkerNotImplemented,
                "Target can be modelled, but no qualified privilege worker is available.",true,false);

        return new(ElevationRoute.Reject,
            "This operation is not eligible for this capture route.",false,false);
    }

    internal static bool IsSha256(string value) =>
        value.Length==64 && value.All(c=>
            c is >= '0' and <= '9' or >= 'A' and <= 'F' or >= 'a' and <= 'f');

    private static bool IsLocalFileIdentity(string path,string extension) =>
        path.Length>=4 && char.IsAsciiLetter(path[0]) && path[1]==':' &&
        path[2]=='\\' && !path.Contains("..\\",StringComparison.Ordinal) &&
        !path.Contains("\\.\\",StringComparison.Ordinal) &&
        !path.Contains("\\?\\",StringComparison.Ordinal) &&
        path.EndsWith(extension,StringComparison.OrdinalIgnoreCase);

    internal static string Binding(ElevationTarget target,ElevationActor actor)
    {
        // A stable canonical tuple. No arbitrary dictionaries/order-dependent
        // JSON, and no unsafely concatenated separators.
        byte[] json=JsonSerializer.SerializeToUtf8Bytes(new {
            kind=target.Kind.ToString(),
            capture=target.Capture.ToString(),
            identifier=target.Identifier,
            sha256=target.Sha256.ToUpperInvariant(),
            publisher=target.Publisher,
            operationCode=target.OperationCode,
            argumentsDigest=target.ArgumentsDigest,
            parentOperationId=target.ParentOperationId,
            tenant=actor.TenantId,
            device=actor.DeviceId,
            user=actor.UserSid,
            session=actor.SessionId
        });
        return Convert.ToHexString(SHA256.HashData(json));
    }
}

/// <summary>
/// Strict one-use ledger for typed operations. This does not execute or
/// approve actions: only ExistingSignedExeBroker is currently runnable and
/// it must independently verify the target against the signed file again.
/// </summary>
internal sealed class ElevationIntentLedger
{
    private static readonly TimeSpan Ttl=TimeSpan.FromMinutes(2);
    private readonly Func<DateTimeOffset> clock;
    private readonly ConcurrentDictionary<Guid,ElevationIntent> intents=new();
    internal ElevationIntentLedger(Func<DateTimeOffset>? clock=null) =>
        this.clock=clock ?? (()=>DateTimeOffset.UtcNow);

    internal ElevationIntent Create(ElevationTarget target,ElevationActor actor)
    {
        var route=ElevationPolicy.Assess(target);
        if(!route.HasTrustedAutomaticIdentity)
            throw new UnauthorizedAccessException("Cannot bind an untrusted Windows UAC target.");
        if(string.IsNullOrWhiteSpace(actor.TenantId)||string.IsNullOrWhiteSpace(actor.DeviceId)
           ||!actor.UserSid.StartsWith("S-1-5-21-",StringComparison.Ordinal)
           ||actor.SessionId<=0)
            throw new UnauthorizedAccessException("Tenant, device or Windows SID/session is missing.");
        // A worker-not-implemented operation may be recorded for dry-run,
        // but cannot be redeemed as an elevation. No generic admin tokens.
        var now=clock();
        var value=new ElevationIntent(Guid.NewGuid(),target,actor,
            ElevationPolicy.Binding(target,actor),now,now.Add(Ttl));
        if(!intents.TryAdd(value.RequestId,value))
            throw new InvalidOperationException("Operation request ID collision.");
        return value;
    }
    internal ElevationIntent Redeem(Guid id,ElevationActor actor,ElevationTarget target)
    {
        if(!intents.TryGetValue(id,out var prior))
            throw new UnauthorizedAccessException("Unknown operation.");
        var now=clock();
        if(now>prior.ExpiresAt)
        {
            RemoveExact(id,prior);
            throw new UnauthorizedAccessException("Expired operation.");
        }
        if(prior.Actor!=actor ||
           !string.Equals(prior.BindingHash,ElevationPolicy.Binding(target,actor),StringComparison.Ordinal) ||
           ElevationPolicy.Assess(target).Route!=ElevationRoute.ExistingSignedExeBroker)
            throw new UnauthorizedAccessException("Target, user, session, tenant or worker not authorised.");
        // Atomically remove before returning; no replay even under concurrent
        // requests. The actual broker still requires technician approval.
        if(!RemoveExact(id,prior))
            throw new UnauthorizedAccessException("Operation already redeemed.");
        return prior with {IsConsumed=true};
    }
    internal bool Cancel(Guid id,ElevationActor actor)
    {
        if(!intents.TryGetValue(id,out var entry)||entry.Actor!=actor)
            return false;
        return RemoveExact(id,entry);
    }
    private bool RemoveExact(Guid id,ElevationIntent value) =>
        ((ICollection<KeyValuePair<Guid,ElevationIntent>>)intents)
            .Remove(new KeyValuePair<Guid,ElevationIntent>(id,value));
}

internal static class ElevationCoverageTests
{
    internal static void Run()
    {
        const string digest="AFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAF";
        var user=new ElevationActor("newtest","lenovo","S-1-5-21-11-22-33-1001",2);
        var another=user with {UserSid="S-1-5-21-11-22-33-1002"};
        var exe=new ElevationTarget(ElevationKind.SignedExecutable,
            ElevationCapture.ExplorerSelectedItem,@"C:\Apps\VerifiedSetup.exe",digest,"Publisher");
        var browser=exe with {Capture=ElevationCapture.BrowserCompletedDownload};
        var msi=new ElevationTarget(ElevationKind.WindowsInstaller,
            ElevationCapture.ExplorerSelectedItem,@"C:\Apps\VerifiedSetup.msi",digest,"Publisher");
        var ps1=new ElevationTarget(ElevationKind.PowerShellScript,
            ElevationCapture.ManagedApplication,@"C:\Apps\ApprovedScript.ps1",digest,"Publisher");
        var windows=new ElevationTarget(ElevationKind.ManagedWindowsAction,
            ElevationCapture.EndpointPolicy,"services",digest,"Microsoft","H5C.Services.Start");
        var file=new ElevationTarget(ElevationKind.PrivilegedFileOperation,
            ElevationCapture.EndpointPolicy,"restricted-file",digest,"Microsoft","H5C.File.Copy");
        var nested=new ElevationTarget(ElevationKind.NestedChildProcess,
            ElevationCapture.ManagedApplication,@"C:\Apps\Child.exe",digest,"Publisher",
            ParentOperationId:"opaque-approved-parent");
        var unbound=new ElevationTarget(ElevationKind.UnmanagedNativeUac,
            ElevationCapture.None,"",digest,"");
        Check(ElevationPolicy.Assess(exe).Route==ElevationRoute.ExistingSignedExeBroker,
            "Existing EXE worker was not recognized.");
        Check(ElevationPolicy.Assess(browser).Route==ElevationRoute.ExistingSignedExeBroker,
            "Browser EXE worker was not recognized.");
        foreach(var item in new[]{msi,ps1,windows,file,nested})
            Check(ElevationPolicy.Assess(item).Route==ElevationRoute.WorkerNotImplemented,
                "Unqualified privileged operation was incorrectly allowed.");
        Check(ElevationPolicy.Assess(unbound).Route==ElevationRoute.WindowsUacFallback,
            "Unbound native UAC must fall back to Windows.");
        Check(ElevationPolicy.Assess(exe with {Capture=ElevationCapture.None}).Route ==
              ElevationRoute.WindowsUacFallback,"No capture is not authorisation.");
        Check(ElevationPolicy.Assess(exe with {Identifier=@"\\server\drop\setup.exe"}).Route ==
              ElevationRoute.Reject,"Network executable path accepted.");
        Check(ElevationPolicy.Assess(exe with {Identifier=@"C:\Apps\..\evil.exe"}).Route ==
              ElevationRoute.Reject,"Traversing path accepted.");
        Check(ElevationPolicy.Assess(exe with {ArgumentsDigest=digest}).Route ==
              ElevationRoute.Reject,"Unapproved EXE command-line arguments accepted.");
        Check(ElevationPolicy.Assess(exe with {ParentOperationId="other"}).Route ==
              ElevationRoute.Reject,"Unapproved nested process accepted.");
        Check(ElevationPolicy.Assess(exe with {Sha256="unknown"}).Route ==
              ElevationRoute.Reject,"Missing hash accepted.");
        Check(ElevationPolicy.Assess(windows with {Capture=ElevationCapture.ExplorerSelectedItem}).Route ==
              ElevationRoute.Reject,"Administrative action accepted from Explorer file selection.");

        var tick=DateTimeOffset.UtcNow;
        var ledger=new ElevationIntentLedger(()=>tick);
        var bound=ledger.Create(exe,user);
        Check(bound.BindingHash.Length==64 && !string.IsNullOrWhiteSpace(bound.Target.Identifier),
            "Immutable operation binding absent.");
        bool denied=false;
        try{ledger.Redeem(bound.RequestId,another,exe);}catch(UnauthorizedAccessException){denied=true;}
        Check(denied,"Cross-user request accepted.");
        denied=false;
        try{ledger.Redeem(bound.RequestId,user,exe with {Sha256=new string('B',64)});}
        catch(UnauthorizedAccessException){denied=true;}
        Check(denied,"Replaced target hash accepted.");
        var consumed=ledger.Redeem(bound.RequestId,user,exe);
        Check(consumed.IsConsumed,"One-use token did not get consumed.");
        denied=false;
        try{ledger.Redeem(bound.RequestId,user,exe);}catch(UnauthorizedAccessException){denied=true;}
        Check(denied,"Replay accepted.");
        var notReady=ledger.Create(msi,user);
        denied=false;
        try{ledger.Redeem(notReady.RequestId,user,msi);}catch(UnauthorizedAccessException){denied=true;}
        Check(denied,"MSI without qualified execution worker was elevated.");
        Check(ledger.Cancel(notReady.RequestId,user),"Cancellation failed.");
        var expired=ledger.Create(exe,user);
        tick=tick.AddMinutes(3);
        denied=false;
        try{ledger.Redeem(expired.RequestId,user,exe);}catch(UnauthorizedAccessException){denied=true;}
        Check(denied,"Expired operation accepted.");

        Console.WriteLine("PASS: typed EXE, MSI, PowerShell, Windows action, file and child-process policy matrix.");
        Console.WriteLine("PASS: no generic native UAC capture; unsupported operation workers fail closed.");
        Console.WriteLine("PASS: tenant/user/session/target/argument binding, expiry, cancellation and no replay.");
    }
    private static void Check(bool assertion,string message)
    {
        if(!assertion)throw new InvalidOperationException(message);
    }
}
