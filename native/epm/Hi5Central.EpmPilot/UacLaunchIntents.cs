using System.Collections.Concurrent;

namespace Hi5Central.EpmPilot;

/// <summary>
/// An authenticated, user-initiated pre-UAC launch intent, NEVER a Windows
/// credential or a substitute for consent.exe verification. Only the exact
/// checked signed file can enter the existing one-use technician workflow.
/// One active intent per session; no "latest downloaded EXE" guessing.
/// </summary>
internal sealed record UacLaunchIntent(
    Guid Nonce,string Sid,string UserName,int Session,FileProof Proof,DateTimeOffset CreatedAt);

internal sealed class UacLaunchIntents
{
    internal static readonly TimeSpan ValidFor=TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<int,UacLaunchIntent> current=new();
    private readonly Func<DateTimeOffset> now;
    internal UacLaunchIntents(Func<DateTimeOffset>? clock=null) => now=clock??(()=>DateTimeOffset.UtcNow);

    internal UacLaunchIntent Begin(string sid,string userName,int session,FileProof proof)
    {
        if(!sid.StartsWith("S-1-5-21-",StringComparison.Ordinal) || session<=0)
            throw new UnauthorizedAccessException("A standard interactive Windows user is required.");
        // Reject an overlapping launch in the same session, even from a
        // different account. A UAC prompt is not a multi-intent selector.
        while(true) {
            if(current.TryGetValue(session,out var old)) {
                if(now()-old.CreatedAt<=ValidFor)
                    throw new InvalidOperationException(
                        "An existing Hi5Central UAC launch is active. Finish or cancel it first.");
                current.TryRemove(new KeyValuePair<int,UacLaunchIntent>(session,old));
                continue;
            }
            var created=new UacLaunchIntent(Guid.NewGuid(),sid,userName,session,proof,now());
            if(current.TryAdd(session,created))return created;
        }
    }
    internal UacLaunchIntent? Peek(string sid,int session)
    {
        if(!current.TryGetValue(session,out var item))return null;
        if(now()-item.CreatedAt>ValidFor) {
            current.TryRemove(new KeyValuePair<int,UacLaunchIntent>(session,item));
            return null;
        }
        return item.Sid==sid?item:null;
    }
    internal UacLaunchIntent Consume(string sid,int session,Guid nonce)
    {
        var intent=Peek(sid,session);
        if(intent is null || intent.Nonce!=nonce)
            throw new UnauthorizedAccessException(
                "This managed UAC launch has expired or belongs to another request.");
        if(!current.TryRemove(new KeyValuePair<int,UacLaunchIntent>(session,intent)))
            throw new UnauthorizedAccessException("The launch was already used.");
        return intent;
    }
    internal bool Abandon(string sid,int session,Guid nonce)
    {
        var intent=Peek(sid,session);
        return intent is not null && intent.Nonce==nonce
            && current.TryRemove(new KeyValuePair<int,UacLaunchIntent>(session,intent));
    }
    internal static void SelfTest()
    {
        var tick=DateTimeOffset.UtcNow;
        var store=new UacLaunchIntents(()=>tick);
        const string sid="S-1-5-21-11-22-33-1001", another="S-1-5-21-11-22-33-1002";
        var proof=new FileProof(@"C:\Users\test\Downloads\SignedInstaller.exe",
            "SignedInstaller.exe",new string('A',64),"Trusted Publisher",new string('B',40));
        var ticket=store.Begin(sid,"TEST\\Employee",2,proof);
        if(ticket.Nonce==Guid.Empty || store.Peek(sid,2)?.Nonce!=ticket.Nonce
            || store.Peek(another,2)!=null || store.Peek(sid,3)!=null)
            throw new Exception("Intent session/user isolation failed.");
        bool overlapDenied=false;
        try {store.Begin(sid,"TEST\\Employee",2,proof);}
        catch(InvalidOperationException){overlapDenied=true;}
        if(!overlapDenied)throw new Exception("Concurrent UAC intent accepted.");
        bool badNonceDenied=false;
        try {store.Consume(sid,2,Guid.NewGuid());}
        catch(UnauthorizedAccessException){badNonceDenied=true;}
        if(!badNonceDenied || store.Peek(sid,2) is null)
            throw new Exception("Wrong nonce accepted or original ticket consumed.");
        var consumed=store.Consume(sid,2,ticket.Nonce);
        if(consumed.Proof.Hash!=proof.Hash||store.Peek(sid,2)!=null)
            throw new Exception("One-time intent redemption failed.");
        bool replayDenied=false;
        try {store.Consume(sid,2,ticket.Nonce);}
        catch(UnauthorizedAccessException){replayDenied=true;}
        if(!replayDenied)throw new Exception("UAC intent replay was accepted.");
        var next=store.Begin(sid,"TEST\\Employee",2,proof);
        if(store.Abandon(another,2,next.Nonce)
            || store.Abandon(sid,2,Guid.NewGuid())
            || store.Peek(sid,2) is null
            || !store.Abandon(sid,2,next.Nonce)
            || store.Peek(sid,2)!=null)
            throw new Exception("Cross-user abandon or intended cancellation failed.");
        var expiring=store.Begin(sid,"TEST\\Employee",2,proof);
        tick=tick.AddMinutes(3);
        if(store.Peek(sid,2)!=null)
            throw new Exception("Expired intent remained available.");
        replayDenied=false;
        try{store.Consume(sid,2,expiring.Nonce);}
        catch(UnauthorizedAccessException){replayDenied=true;}
        if(!replayDenied)throw new Exception("Expired intent could be submitted.");
        Console.WriteLine("PASS: scoped, signed-file-bound UAC prelaunch intent, overlap, expiration, cancellation and replay denied.");
    }
}
