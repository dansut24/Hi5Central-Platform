namespace Hi5Central.EpmPilot;

/// <summary>
/// A non-elevating review of a native Windows UAC prompt. Requesting a review
/// never creates an admin account or releases Windows credentials. The
/// underlying target is not exposed by the supported CPUS_CREDUI interface.
/// </summary>
internal static class NativeUacReviewPolicy
{
    internal const int MinReason=20, MaxReason=512;
    internal static bool TryValidateReason(string? value,out string trimmed)
    {
        trimmed=(value??"").Trim();
        return trimmed.Length is >=MinReason and <=MaxReason
            && !trimmed.Any(char.IsControl);
    }
    internal static bool ValidConsentInstance(
        string hostPath,string windowsDirectory,string accountSid,
        int hostSession,int requesterSession,DateTimeOffset started,
        DateTimeOffset now)
    {
        return accountSid=="S-1-5-18" &&
            EpmService.IsTrustedWindowsCredentialHostPath(hostPath,windowsDirectory) &&
            hostSession>0 && hostSession==requesterSession &&
            started<=now.AddSeconds(15) &&
            started>=now.AddMinutes(-5);
    }
    internal static bool CredentialReleaseEnabled => false;

    internal static void SelfTest()
    {
        var now=DateTimeOffset.UtcNow;
        string root=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string consent=Path.Combine(root,"System32","consent.exe");
        if(!TryValidateReason("  Need to change a protected network setting  ",out var reason)
           || reason!="Need to change a protected network setting"
           || TryValidateReason("too short",out _)
           || TryValidateReason("Changed\r\nWindows policy in secret",out _)
           || TryValidateReason(new string('a',513),out _))
            throw new InvalidOperationException("UAC reason validation failed.");
        if(!ValidConsentInstance(consent,root,"S-1-5-18",2,2,now,now)
           || ValidConsentInstance(consent,root,"S-1-5-21-1-2-3-1001",2,2,now,now)
           || ValidConsentInstance(consent,root,"S-1-5-18",3,2,now,now)
           || ValidConsentInstance(consent,root,"S-1-5-18",2,2,now.AddMinutes(-6),now)
           || ValidConsentInstance(Path.Combine(Path.GetTempPath(),"consent.exe"),
               root,"S-1-5-18",2,2,now,now)
           || CredentialReleaseEnabled)
            throw new InvalidOperationException("UAC host or no-credential policy failed.");
        Console.WriteLine("PASS: native UAC review requires real SYSTEM consent host, same Windows session and valid reason.");
        Console.WriteLine("PASS: unidentified native UAC target cannot release an administrator credential.");
    }
}
