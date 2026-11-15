using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Five named Windows operations selected through Hi5Central BEFORE UAC.
/// These actions are not inferred from a native Windows consent dialog.
/// Approval may start only the registered image + immutable argument string.
/// </summary>
internal sealed record ManagedAction(string Code,string Name,string Path,string Arguments)
{
    internal string ArgumentsSha256 =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Arguments)));
}

internal static class ManagedUacActions
{
    internal static readonly string[] Codes=[
        "notepad","regedit","services","powershell","msiexec-help"];
    internal static ManagedAction? Resolve(string? code)
    {
        string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if(string.IsNullOrWhiteSpace(windows))return null;
        return code switch {
            "notepad" => new("notepad","Notepad (administrator)",
                Path.Combine(windows,"System32","notepad.exe"),""),
            "regedit" => new("regedit","Registry Editor (administrator)",
                Path.Combine(windows,"regedit.exe"),""),
            "services" => new("services","Services MMC (administrator)",
                Path.Combine(windows,"System32","mmc.exe"),"services.msc"),
            "powershell" => new("powershell","Windows PowerShell (administrator)",
                Path.Combine(windows,"System32","WindowsPowerShell","v1.0","powershell.exe"),
                "-NoProfile -NoExit"),
            "msiexec-help" => new("msiexec-help","Windows Installer help (administrator)",
                Path.Combine(windows,"System32","msiexec.exe"),"/?"),
            _ => null
        };
    }

    internal static void SelfTest()
    {
        if(Codes.Distinct(StringComparer.Ordinal).Count()!=5)
            throw new Exception("Managed UAC allowlist is not unique.");
        foreach(string code in Codes)
        {
            var x=Resolve(code)??throw new Exception("Unknown allowlisted action");
            if(x.Code!=code||!Path.IsPathFullyQualified(x.Path)
              ||!x.Path.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)
              ||x.ArgumentsSha256.Length!=64
              ||x.Arguments.Contains('"') || x.Arguments.Contains('\n'))
                throw new Exception("Managed action is not a bounded, fixed command.");
            if(x.ArgumentsSha256==new string('A',64))
                throw new Exception("Managed action hash fixture unsafe.");
        }
        if(Resolve("cmd")!=null||Resolve("explorer")!=null
            ||Resolve("../powershell")!=null)
            throw new Exception("Unapproved management command accepted.");

        var now=DateTimeOffset.UtcNow;
        var pending=new PreparedManagedUac(()=>now);
        var sid="S-1-5-21-1-2-3-1001";
        var a=Resolve("notepad")!;
        pending.Begin(sid,2,a);
        bool overlapping=false;
        try{pending.Begin(sid,2,Resolve("services")!);}catch(InvalidOperationException){overlapping=true;}
        if(!overlapping||pending.Consume("S-1-5-21-1-2-3-999",2)!=null
            ||pending.Consume(sid,3)!=null
            ||pending.Consume(sid,2)?.Code!="notepad"
            ||pending.Consume(sid,2)!=null)
            throw new Exception("Managed action SID/session isolation or one-use binding failed.");
        pending.Begin(sid,2,a);
        now=now.AddMinutes(4);
        if(pending.Consume(sid,2)!=null)
            throw new Exception("Expired managed action could still be approved.");
        Console.WriteLine("PASS: five fixed managed Windows UAC targets, argument hashes, SID/session binding, replay and expiry.");
    }
}

internal sealed record PreparedAction(string Sid,int Session,string Code,DateTimeOffset CreatedAt);
internal sealed class PreparedManagedUac
{
    private readonly ConcurrentDictionary<int,PreparedAction> intents=new();
    private readonly Func<DateTimeOffset> now;
    private static readonly TimeSpan ValidFor=TimeSpan.FromMinutes(3);
    internal PreparedManagedUac(Func<DateTimeOffset>? clock=null)=>now=clock??(()=>DateTimeOffset.UtcNow);

    internal void Begin(string sid,int session,ManagedAction action)
    {
        if(!sid.StartsWith("S-1-5-21-",StringComparison.Ordinal)||session<=0
            ||ManagedUacActions.Resolve(action.Code)!=action)
            throw new UnauthorizedAccessException("Only a verified interactive user and listed Windows operation may request an intent.");
        while(true)
        {
            if(intents.TryGetValue(session,out var old))
            {
                if(now()-old.CreatedAt<=ValidFor)
                    throw new InvalidOperationException("Finish or cancel the previous managed UAC request first.");
                ((ICollection<KeyValuePair<int,PreparedAction>>)intents)
                    .Remove(new KeyValuePair<int,PreparedAction>(session,old));
                continue;
            }
            if(intents.TryAdd(session,new PreparedAction(sid,session,action.Code,now())))
                return;
        }
    }
    internal ManagedAction? Consume(string sid,int session)
    {
        if(!intents.TryGetValue(session,out var item))return null;
        if(item.Sid!=sid)return null;
        if(!((ICollection<KeyValuePair<int,PreparedAction>>)intents)
            .Remove(new KeyValuePair<int,PreparedAction>(session,item)))
            return null;
        return now()-item.CreatedAt<=ValidFor
            ? ManagedUacActions.Resolve(item.Code):null;
    }
    internal bool Abandon(string sid,int session,string code)
    {
        if(!intents.TryGetValue(session,out var item)
            ||item.Sid!=sid||item.Code!=code)return false;
        return ((ICollection<KeyValuePair<int,PreparedAction>>)intents)
            .Remove(new KeyValuePair<int,PreparedAction>(session,item));
    }
}
