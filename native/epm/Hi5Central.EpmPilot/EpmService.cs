using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;

namespace Hi5Central.EpmPilot;

internal sealed record ApprovalCache(
    Guid Id,string Sid,int SessionId,FileProof Proof);

internal sealed class EpmService : ServiceBase
{
    internal const string PipeName="Hi5CentralEpmPilot";
    private readonly CancellationTokenSource stop=new();
    private readonly ConcurrentDictionary<Guid,ApprovalCache> approvals=new();
    private readonly EpmApi api=new();
    private readonly SemaphoreSlim gate=new(1,1);
    private Task? running;
    internal EpmService() { ServiceName="Hi5CentralEpmPilot"; CanStop=true; AutoLog=true; }
    protected override void OnStart(string[] args) => running=Task.Run(()=>Listen(stop.Token));
    protected override void OnStop() {
        stop.Cancel();
        try{running?.Wait(TimeSpan.FromSeconds(5));}catch{}
        api.Dispose();gate.Dispose();stop.Dispose();
    }
    private static PipeSecurity Acl() {
        var acl=new PipeSecurity();
        acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),
            PipeAccessRights.FullControl,AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid,null),
            PipeAccessRights.ReadWrite,AccessControlType.Allow));
        return acl;
    }
    private async Task Listen(CancellationToken ct) {
        while (!ct.IsCancellationRequested) {
            try {
                using var pipe=NamedPipeServerStreamAcl.Create(PipeName,PipeDirection.InOut,1,
                    PipeTransmissionMode.Message,PipeOptions.Asynchronous,16384,16384,Acl());
                await pipe.WaitForConnectionAsync(ct);
                await Handle(pipe,ct);
            } catch (OperationCanceledException) when (ct.IsCancellationRequested) {return;}
              catch { try{await Task.Delay(300,ct);}catch{return;} }
        }
    }
    private static (string sid,string name,int session) ClientIdentity(NamedPipeServerStream pipe) {
        string sid="",name="";
        pipe.RunAsClient(()=>{
            using var identity=WindowsIdentity.GetCurrent();
            sid=identity.User?.Value??"";
            name=identity.Name??"";
        });
        if(!sid.StartsWith("S-1-",StringComparison.Ordinal) || sid.Length>255
            || !GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out var pid)
            || !ProcessIdToSessionId(pid,out var session)
            || session==0 || session>int.MaxValue)
            throw new UnauthorizedAccessException("Caller Windows identity/session is not valid.");
        return (sid,name,(int)session);
    }
    private async Task Handle(NamedPipeServerStream pipe,CancellationToken ct) {
        var caller=ClientIdentity(pipe);
        var bytes=new byte[16384];
        using var buffer=new MemoryStream();
        pipe.ReadMode=PipeTransmissionMode.Message;
        do {
            int n=await pipe.ReadAsync(bytes.AsMemory(),ct);
            if(n==0) throw new EndOfStreamException();
            if(buffer.Length+n>16384) throw new InvalidDataException("Request too large");
            buffer.Write(bytes,0,n);
        } while(!pipe.IsMessageComplete);
        object response;
        await gate.WaitAsync(ct);
        try{
            using var json=JsonDocument.Parse(buffer.ToArray());
            var data=json.RootElement;
            string type=data.TryGetProperty("type",out var t)?t.GetString()??"":"";
            string file=data.TryGetProperty("path",out var p)?p.GetString()??"":"";
            response=type switch {
                "request"=>await Request(file, data.TryGetProperty("reason",out var reason)?reason.GetString()??"":"",
                    caller,ct),
                "check"=>await Check(file,caller,ct),
                "run"=>await Run(file,caller,ct),
                "watch"=>await Watch(caller,ct),
                _=>new {success=false,error="Unknown EPM request"}
            };
        } catch(Exception ex) {
            response=new {success=false,error=ex is InvalidOperationException or UnauthorizedAccessException or EpmLaunchException
                ?ex.Message:"Hi5Central could not complete the request."};
        } finally {gate.Release();}
        var output=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response));
        await pipe.WriteAsync(output.AsMemory(),ct);
        await pipe.FlushAsync(ct);
    }
    private ApprovalCache? Match(string path,(string sid,string name,int session) caller) {
        return approvals.Values.OrderByDescending(x=>x.Id)
            .FirstOrDefault(x=>x.Sid==caller.sid && x.SessionId==caller.session
                && StringComparer.OrdinalIgnoreCase.Equals(x.Proof.Path,Path.GetFullPath(path)));
    }
    private object ToApiBinding(ApprovalCache item) => new {
        sid=item.Sid,sessionId=item.SessionId,path=item.Proof.Path,sha256=item.Proof.Hash,
        signerThumbprint=item.Proof.Thumbprint
    };
    private async Task<string> Status(ApprovalCache item,CancellationToken ct) {
        using var r=await api.PostAsync("/api/v1/agent/epm/file-requests/"+item.Id+"/status",ToApiBinding(item),ct);
        return r.RootElement.GetProperty("status").GetString()??"unknown";
    }
    private async Task<object> Request(string path,string reason,(string sid,string name,int session) caller,CancellationToken ct) {
        if(string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("Choose an executable first.");
        var original=VerifiedFile.Inspect(path);
        var cached=Match(original.Path,caller);
        if(cached is not null && cached.Proof.Hash==original.Hash && cached.Proof.Thumbprint==original.Thumbprint) {
            var status=await Status(cached,ct);
            if(status is "pending" or "approved")
                return new {success=true,status,requestId=cached.Id,file=original.Name};
        }
        if(reason.Trim().Length is < 20 or > 2000)
            throw new InvalidOperationException("Provide a business reason between 20 and 2000 characters.");
        // The approval records only a signed file identity. No copy or installer
        // is stored in ProgramData; all reads remain in the original Downloads path.
        using (var result=await api.PostAsync("/api/v1/agent/epm/file-requests",new {
                sid=caller.sid,username=caller.name,sessionId=caller.session,path=original.Path,
                sha256=original.Hash,signerThumbprint=original.Thumbprint,publisher=original.Publisher,
                signatureStatus="Valid",reason=reason.Trim()
            },ct)) {
            var id=Guid.Parse(result.RootElement.GetProperty("requestId").GetString()!);
            approvals[id]=new ApprovalCache(id,caller.sid,caller.session,original);
            string status=result.RootElement.GetProperty("status").GetString()??"pending";
            return new {success=true,status,requestId=id,file=original.Name,publisher=original.Publisher};
        }
    }
    private async Task<object> Check(string path,(string sid,string name,int session) caller,CancellationToken ct) {
        if(string.IsNullOrWhiteSpace(path))return new {success=false,status="none",error="Select a file."};
        var existing=Match(path,caller);
        if(existing is null)return new {success=true,status="none"};
        var original=VerifiedFile.Inspect(path);
        if (existing.Proof.Hash!=original.Hash || existing.Proof.Thumbprint!=original.Thumbprint)
            return new {success=false,status="changed",error="Executable content changed. Request new approval."};
        return new {success=true,status=await Status(existing,ct),requestId=existing.Id,publisher=original.Publisher};
    }
    private async Task<object> Watch((string sid,string name,int session) caller,CancellationToken ct) {
        var list=new List<object>();
        foreach(var item in approvals.Values.Where(x=>x.Sid==caller.sid && x.SessionId==caller.session)){
            try {list.Add(new {path=item.Proof.Path,status=await Status(item,ct),requestId=item.Id});}
            catch { /* disconnected status is not an approval */ }
        }
        return new {success=true,requests=list};
    }
    private async Task<object> Run(string path,(string sid,string name,int session) caller,CancellationToken ct) {
        var existing=Match(path,caller) ?? throw new InvalidOperationException("No request exists for this Windows user and file.");
        if(await Status(existing,ct)!="approved") throw new InvalidOperationException("This file has not been approved or the approval has expired.");
        // Hold a deny-write/deny-delete handle throughout redemption and process
        // creation. If the file changes, disappears, is replaced, or is unsigned,
        // redemption is refused before consuming the one-time authorisation.
        using var pinnedFile=VerifiedFile.LockForApprovedLaunch(existing.Proof);
        using (var consumed=await api.PostAsync("/api/v1/agent/epm/file-requests/"+existing.Id+"/redeem",
            ToApiBinding(existing),ct)) {
            if(!consumed.RootElement.GetProperty("redeemed").GetBoolean())
                throw new InvalidOperationException("Approval redemption failed.");
        }
        try {
            var processId=AdminLaunch.Launch(existing.Proof.Path,caller.session);
            approvals.TryRemove(existing.Id,out _);
            return new {success=true,status="launched",processId};
        } catch (Exception error) {
            // The approval is already consumed, so never automatically retry.
            // Persist only bounded diagnostic codes, not the executable arguments,
            // device credential, account password or Windows token.
            string stage=error is EpmLaunchException launch
                ? launch.Stage : "unexpected-launch-error";
            int nativeCode=error is EpmLaunchException native
                ? native.WindowsCode : 0;
            try {
                using var failed=await api.PostAsync(
                    "/api/v1/agent/epm/file-requests/"+existing.Id+"/failed",
                    new {sid=caller.sid,stage,win32Code=nativeCode},ct);
            } catch { /* authorisation stays consumed even if audit transport fails */ }
            throw;
        }
    }
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool ProcessIdToSessionId(uint pid,out uint session);
}
