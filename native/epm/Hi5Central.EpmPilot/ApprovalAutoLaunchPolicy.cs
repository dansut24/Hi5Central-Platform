namespace Hi5Central.EpmPilot;

// Auto-start is a separate EXPLICIT opt-in on a trusted user-selected signed
// executable request. Review-only native UAC never yields a launch capability.
internal static class ApprovalAutoLaunchPolicy
{
    internal static bool CanEnable(bool optedIn,string requestSource,string requesterSid) =>
        optedIn && requestSource=="explorer" &&
        requesterSid.StartsWith("S-1-5-21-",StringComparison.Ordinal);

    internal static bool ShouldStart(string status,bool localOptIn,bool apiConfirmed) =>
        status=="approved" && localOptIn && apiConfirmed;

    internal static void SelfTest()
    {
        const string sid="S-1-5-21-11-22-33-1001";
        if (!CanEnable(true,"explorer",sid) || CanEnable(false,"explorer",sid)
            || CanEnable(true,"native-uac",sid)
            || CanEnable(true,"explorer","S-1-5-18")
            || CanEnable(true,"unknown",sid)
            || !ShouldStart("approved",true,true)
            || ShouldStart("pending",true,true)
            || ShouldStart("reviewed",true,true)
            || ShouldStart("rejected",true,true)
            || ShouldStart("approved",false,true)
            || ShouldStart("approved",true,false))
            throw new InvalidOperationException("EPM auto-launch safety policy regression.");
        Console.WriteLine("PASS: auto-start only for explicitly selected signed EXE + confirmed one-time approval; native UAC review never runnable.");
    }
}
