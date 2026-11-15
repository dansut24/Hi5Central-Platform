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
internal sealed record UacReviewCache(
    Guid Id,string Sid,int Session,int ConsentPid,DateTimeOffset ConsentStarted,string Reason);

internal sealed class EpmService : ServiceBase
{
    internal const string PipeName="Hi5CentralEpmPilot";
    private readonly CancellationTokenSource stop=new();
    private readonly ConcurrentDictionary<Guid,ApprovalCache> approvals=new();
    private readonly ConcurrentDictionary<Guid,UacReviewCache> uacReviews=new();
    private readonly ConcurrentDictionary<int,(string sid,int session)> launchedJobs=new();
    private readonly EpmApi api=new();
    private readonly SemaphoreSlim gate=new(1,1);
    private Task? running;
    internal EpmService() { ServiceName="Hi5CentralEpmPilot"; CanStop=true; AutoLog=true; }
    protected override void OnStart(string[] args) => running=Task.Run(()=>Listen(stop.Token));
    protected override void OnStop() {
        stop.Cancel();
        try{running?.Wait(TimeSpan.FromSeconds(5));}catch{}
        // Do not leave temporary administrator identities when the pilot service stops.
        // Active process jobs are closed (and terminated) before profile/account cleanup.
        AdminLaunch.StopActiveLaunches();
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
                // UAC is hosted by a protected Windows credential UI process.
                // Never accept the caller SID as the employee SID; authenticate
                // the Windows host and resolve the interactive session user.
                "uac-request"=>await RequestFromCredentialUi(file,
                    data.TryGetProperty("reason",out var uacReason)?uacReason.GetString()??"":"",
                    pipe,caller,ct),
                "uac-review"=>await SubmitNativeUacReview(
                    data.TryGetProperty("reason",out var reviewReason)
                      ? reviewReason.GetString()??"": "",pipe,caller,ct),
                "uac-review-status"=>await NativeUacReviewStatus(
                    data.TryGetProperty("requestId",out var reviewId)
                     && Guid.TryParse(reviewId.GetString(),out var parsedReviewId)
                       ? parsedReviewId:Guid.Empty,pipe,caller,ct),
                "check"=>await Check(file,caller,ct),
                "run"=>await Run(file,caller,ct,pipe),
                "job"=>Job(data.TryGetProperty("processId",out var job)?job.GetInt32():0,caller),
                "watch"=>await Watch(caller,ct),
                _=>new {success=false,error="Unknown EPM request"}
            };
        } catch(Exception ex) {
            response=new {success=false,error=ex is InvalidOperationException or UnauthorizedAccessException or EpmLaunchException
                ?ex.Message:"Hi5Central could not complete the request."};
        } finally {gate.Release();}
        var output=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response));
        await pipe.WriteAsync(output.AsMemory(),ct);
        // Named-pipe writes are not buffered like StreamWriter. No FlushAsync:
        // flushing a duplex pipe can wait on its peer and deadlock.
    }
    private async Task<object> SubmitNativeUacReview(string reason,
        NamedPipeServerStream pipe,(string sid,string name,int session) caller,CancellationToken ct)
    {
        if(!NativeUacReviewPolicy.TryValidateReason(reason,out var trimmed))
            throw new InvalidOperationException("Enter a 20–512 character business justification.");
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out var pid)
            || pid==0 || pid>int.MaxValue)
            throw new UnauthorizedAccessException("Cannot verify the Windows UAC host.");
        using var clientProcess=System.Diagnostics.Process.GetProcessById((int)pid);
        var root=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var started=new DateTimeOffset(clientProcess.StartTime.ToUniversalTime(),TimeSpan.Zero);
        if(!NativeUacReviewPolicy.ValidConsentInstance(
                GetProcessImage(pid),root,caller.sid,clientProcess.SessionId,
                caller.session,started,DateTimeOffset.UtcNow))
            throw new UnauthorizedAccessException("Native UAC host verification failed.");
        if(!WTSQueryUserToken((uint)caller.session,out var userToken))
            throw new UnauthorizedAccessException("Cannot resolve interactive Windows user.");
        using(userToken)
        using(var identity=new WindowsIdentity(userToken.DangerousGetHandle()))
        {
            string sid=identity.User?.Value??"";
            if(!sid.StartsWith("S-1-5-21-",StringComparison.Ordinal)
                || identity.User?.IsWellKnown(WellKnownSidType.LocalSystemSid)==true)
                throw new UnauthorizedAccessException("Only a standard interactive user may request UAC review.");
            // No guessed application path. No Windows administrator credential.
            using var response=await api.PostAsync("/api/v1/agent/epm/uac-reviews",new {
                sid,username=identity.Name,sessionId=caller.session,
                consentProcessId=(int)pid,consentStartedAt=started.ToString("O"),
                reason=trimmed
            },ct);
            var r=response.RootElement;
            var reviewId=Guid.Parse(r.GetProperty("requestId").GetString()!);
            uacReviews[reviewId]=new UacReviewCache(
                reviewId,sid,caller.session,(int)pid,started,trimmed);
            return new {
                success=r.GetProperty("success").GetBoolean(),
                requestId=reviewId.ToString(),
                status=r.GetProperty("status").GetString(),
                credentialReleaseEnabled=false,
                message="Request submitted for review. No administrator credential or elevation was issued."
            };
        }
    }

    private async Task<object> NativeUacReviewStatus(Guid id,
        NamedPipeServerStream pipe,(string sid,string name,int session) caller,CancellationToken ct)
    {
        if(id==Guid.Empty || !uacReviews.TryGetValue(id,out var review))
            throw new UnauthorizedAccessException("Unknown UAC review instance.");
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out var pid)
            || pid!=(uint)review.ConsentPid
            || caller.sid!="S-1-5-18" || caller.session!=review.Session)
            throw new UnauthorizedAccessException("UAC review belongs to a different secure process.");
        using var process=System.Diagnostics.Process.GetProcessById((int)pid);
        var started=new DateTimeOffset(process.StartTime.ToUniversalTime(),TimeSpan.Zero);
        if(started!=review.ConsentStarted ||
            !NativeUacReviewPolicy.ValidConsentInstance(
                GetProcessImage(pid),Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                caller.sid,process.SessionId,review.Session,started,DateTimeOffset.UtcNow))
            throw new UnauthorizedAccessException("Windows consent process changed.");
        if(!WTSQueryUserToken((uint)review.Session,out var userToken))
            throw new UnauthorizedAccessException("Cannot verify original Windows requester.");
        using(userToken)
        using(var user=new WindowsIdentity(userToken.DangerousGetHandle()))
        {
            if(user.User?.Value!=review.Sid)
                throw new UnauthorizedAccessException("Windows requester changed.");
            using var result=await api.PostAsync(
                "/api/v1/agent/epm/uac-reviews/"+review.Id+"/status",new {
                    sid=review.Sid,username=user.Name,sessionId=review.Session,
                    consentProcessId=review.ConsentPid,
                    consentStartedAt=review.ConsentStarted.ToString("O"),reason=review.Reason
                },ct);
            var status=result.RootElement.GetProperty("status").GetString()??"unknown";
            if(status is "expired" or "rejected")
                uacReviews.TryRemove(review.Id,out _);
            return new {success=true,status,requestId=review.Id,credentialReleaseEnabled=false};
        }
    }

    internal async Task<object> RequestFromCredentialUi(string file,string reason,
        NamedPipeServerStream pipe,(string sid,string name,int session) caller,CancellationToken ct)
    {
        // UAC request is a non-elevating route to the EXISTING per-file RMM
        // approval. The credential provider cannot submit admin credentials
        // and cannot resume the original Windows UAC operation.
        if(caller.sid!="S-1-5-18")
            throw new UnauthorizedAccessException("UAC requests require a trusted Windows credential host.");
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out var pid))
            throw new UnauthorizedAccessException("Unable to identify Windows credential host.");
        using var process=System.Diagnostics.Process.GetProcessById((int)pid);
        // Only the actual Microsoft Windows Credential UI host, not a regular
        // SYSTEM process or a user application, may use this special route.
        var expectedRoot=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var actual=GetProcessImage(pid);
        bool windowsHost=IsTrustedWindowsCredentialHostPath(actual,expectedRoot);
        if(!windowsHost || process.SessionId!=caller.session)
            throw new UnauthorizedAccessException("Untrusted credential host or Windows session.");
        if(!WTSQueryUserToken((uint)caller.session,out var interactiveToken))
            throw new UnauthorizedAccessException("No interactive Windows user is available.");
        using(interactiveToken)
        using(var identity=new WindowsIdentity(interactiveToken.DangerousGetHandle()))
        {
            string sid=identity.User?.Value??"";
            if(!sid.StartsWith("S-1-5-21-",StringComparison.Ordinal)
                || identity.User?.IsWellKnown(WellKnownSidType.LocalSystemSid)==true)
                throw new UnauthorizedAccessException("Invalid interactive user identity.");
            // Existing Request performs Authenticode, SHA-256, signer, path,
            // identity binding, API submission and one-time approval caching.
            return await Request(file,reason,(sid,identity.Name,caller.session),ct,"native-uac");
        }
    }

    internal static bool IsTrustedWindowsCredentialHostPath(string actual,string windowsRoot)
    {
        // No path prefix, executable basename, or user-provided alias is
        // authoritative. Only the two exact Microsoft-hosted paths qualify.
        return new[]{"consent.exe","CredentialUIBroker.exe"}
            .Any(name=>string.Equals(actual,
                Path.Combine(windowsRoot,"System32",name),
                StringComparison.OrdinalIgnoreCase));
    }

    private static string GetProcessImage(uint pid)
    {
        const uint PROCESS_QUERY_LIMITED_INFORMATION=0x1000;
        var process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid);
        if(process==IntPtr.Zero)
            throw new UnauthorizedAccessException("Cannot inspect credential host.");
        try {
            var buffer=new StringBuilder(32768);
            uint chars=(uint)buffer.Capacity;
            if(!QueryFullProcessImageNameW(process,0,buffer,ref chars))
                throw new UnauthorizedAccessException("Cannot verify credential host path.");
            return buffer.ToString();
        }
        finally {CloseHandle(process);}
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
    private async Task<object> Request(string path,string reason,(string sid,string name,int session) caller,CancellationToken ct,string requestSource="explorer") {
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
                signatureStatus="Valid",reason=reason.Trim(),source=requestSource
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
    private object Job(int pid,(string sid,string name,int session) caller)
    {
        if(pid<=0)throw new InvalidOperationException("Invalid EPM job ID.");
        // A broker restart destroys the one-time job cache. The user companion
        // must revoke its temporary ACL immediately, not retain it for 45 minutes.
        if(!launchedJobs.TryGetValue(pid,out var owner))
            return new {success=true,status="unknown",processId=pid};
        if(owner.sid!=caller.sid || owner.session!=caller.session)
            throw new UnauthorizedAccessException("This EPM job belongs to a different Windows session.");
        bool running=AdminLaunch.IsJobActive((uint)pid);
        if(!running)launchedJobs.TryRemove(pid,out _);
        return new {success=true,status=running?"running":"ended",processId=pid};
    }

    // Authenticated, single-use local pipe challenge; no cross-session handle
    // duplication. The employee-side launcher edits only its own desktop ACL.
    internal static void RequestDesktopGrant(NamedPipeServerStream pipe,string sid,Action<string>? diagnosticStage=null)
    {
        // A request-bound 18-second watchdog closes the pipe if an
        // authenticated user process never acknowledges its desktop grant.
        // The broker must fail closed rather than leave its privileged
        // launch thread waiting forever on a synchronous Win32 pipe read.
        var challenge=JsonSerializer.SerializeToUtf8Bytes(new {
            action="grant-local-desktop",adminSid=sid
        });
        try {
            diagnosticStage?.Invoke("before-challenge-write");
            // WriteAsync already sends a complete message to the named pipe.
            // FlushAsync may block while peer is trying to write its ACK, causing
            // a duplex deadlock before this service can read that ACK.
            // The callback is synchronous inside CreateProcessAsUser setup.
            // Blocking on overlapped WriteAsync here can deadlock even after
            // Windows delivers the bytes to the peer. Use a small synchronous
            // message write (always under 512 bytes), then read ACK separately.
            pipe.Write(challenge,0,challenge.Length);
            diagnosticStage?.Invoke("challenge-written");
            // ACK is a single bounded JSON pipe message under 1 KiB.
            // Avoid IsMessageComplete here: its disconnected/read-state
            // InvalidOperationException obscured actual desktop Win32 errors.
            var bytes=new byte[1024];
            diagnosticStage?.Invoke("awaiting-ack");
            // Do not use sync-over-async here. This exact path is exercised by
            // Windows CI in PipeProtocolSelfTest.
            int watchdogState=0; // 0=pending, 1=complete, 2=timed out
            using var watchdog=new System.Threading.Timer(_ => {
                if(Interlocked.CompareExchange(ref watchdogState,2,0)==0) {
                    try { pipe.Dispose(); } catch { }
                }
            },null,TimeSpan.FromSeconds(18),Timeout.InfiniteTimeSpan);
            int count;
            try {
                count=pipe.Read(bytes,0,bytes.Length);
                if(Interlocked.CompareExchange(ref watchdogState,1,0)!=0)
                    throw new EpmLaunchException("desktop-grant-timeout",0);
            }
            catch(Exception) when(Volatile.Read(ref watchdogState)==2) {
                throw new EpmLaunchException("desktop-grant-timeout",0);
            }
            finally {
                Interlocked.CompareExchange(ref watchdogState,1,0);
                watchdog.Change(Timeout.InfiniteTimeSpan,Timeout.InfiniteTimeSpan);
            }
            diagnosticStage?.Invoke("ack-read");
            if(count==0)throw new EpmLaunchException("desktop-grant-connection",109);
            if(count>=bytes.Length)
                throw new EpmLaunchException("desktop-grant-invalid",87);
            using var ack=JsonDocument.Parse(bytes.AsMemory(0,count));
            diagnosticStage?.Invoke("ack-parsed");
            if(!ack.RootElement.TryGetProperty("granted",out var permitted)
                || permitted.ValueKind!=JsonValueKind.True)
            {
                // The client is the only process that can inspect the requesting
                // user's interactive desktop. Accept only known, bounded audit
                // codes from this authenticated pipe exchange.
                var root=ack.RootElement;
                string stage=root.TryGetProperty("stage",out var st)
                    && st.ValueKind==JsonValueKind.String
                    ? st.GetString()??"" : "";
                int nativeCode=root.TryGetProperty("win32Code",out var wc)
                    && wc.ValueKind==JsonValueKind.Number
                    && wc.TryGetInt32(out var code) ? code : 0;
                bool allowed=stage.StartsWith("desktop-",StringComparison.Ordinal)
                    && stage.Length<=64
                    && stage.All(c=>char.IsAsciiLetterOrDigit(c)||c=='-');
                throw new EpmLaunchException(allowed?stage:"desktop-grant-rejected",
                    nativeCode is >=0 and <=65535 ? nativeCode : 0);
            }
        }
        catch(Exception failure) when(failure is not EpmLaunchException) {
            string stage=failure switch {
                OperationCanceledException => "desktop-grant-timeout",
                System.IO.IOException => "desktop-grant-pipe-io",
                System.Text.Json.JsonException => "desktop-grant-json",
                InvalidOperationException => "desktop-grant-protocol",
                UnauthorizedAccessException => "desktop-grant-access",
                _ => "desktop-grant-unexpected"
            };
            throw new EpmLaunchException(stage,0);
        }
    }

    private async Task<object> Run(string path,(string sid,string name,int session) caller,
        CancellationToken ct,NamedPipeServerStream pipe) {
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
            // A named-pipe request originates from a standard user. Explicitly
            // revert any inherited thread impersonation before touching the
            // local SAM or launching a privileged Windows process.
            // RunImpersonated must remain synchronous for the whole launch.
            var processId=WindowsIdentity.RunImpersonated(
                Microsoft.Win32.SafeHandles.SafeAccessTokenHandle.InvalidHandle,
                () => {
                    using var identity=WindowsIdentity.GetCurrent();
                    if (identity.User?.IsWellKnown(WellKnownSidType.LocalSystemSid)!=true)
                        throw new EpmLaunchException("service-security-context",5);
                    return AdminLaunch.Launch(existing.Proof.Path,caller.session,
                        sid => RequestDesktopGrant(pipe,sid),
                        async observation => {
                            // Asynchronous completion is best-effort; the temporary
                            // administrator account is already cleaned up locally.
                            // Never send credentials, tokens or command lines.
                            using var report=await api.PostAsync(
                                "/api/v1/agent/epm/file-requests/"+existing.Id+"/lifecycle",
                                new {
                                    sid=caller.sid,phase="ended",pid=(int)observation.Pid,
                                    exitCode=observation.ExitCode.HasValue
                                        ? (long?)observation.ExitCode.Value : null,
                                    reason=observation.EndReason,elapsedMs=observation.ElapsedMs
                                },CancellationToken.None);
                        });
                });
            approvals.TryRemove(existing.Id,out _);
            launchedJobs[processId]=(caller.sid,caller.session);
            // This means Windows accepted the process. It does not mean the
            // installer rendered or successfully installed its package.
            try {
                using var report=await api.PostAsync(
                    "/api/v1/agent/epm/file-requests/"+existing.Id+"/lifecycle",
                    new {sid=caller.sid,phase="started",pid=processId},ct);
            } catch { /* never revoke an already redeemed approval on audit failure */ }
            return new {success=true,status="launched",processId};
        } catch (Exception error) {
            // The approval is already consumed, so never automatically retry.
            // Persist only bounded diagnostic codes, not the executable arguments,
            // device credential, account password or Windows token.
            string stage=error switch {
                EpmLaunchException launch => launch.Stage,
                UnauthorizedAccessException => "launch-access-denied",
                OperationCanceledException => "launch-cancelled",
                System.IO.IOException => "launch-io",
                InvalidOperationException => "launch-invalid-operation",
                System.ComponentModel.Win32Exception => "launch-win32-error",
                System.Text.Json.JsonException => "launch-json",
                _ => "unexpected-launch-error"
            };
            int nativeCode=error is EpmLaunchException native
                ? native.WindowsCode
                : error is System.ComponentModel.Win32Exception win32
                    ? Math.Clamp(win32.NativeErrorCode,0,65535) : 0;
            try {
                using var failed=await api.PostAsync(
                    "/api/v1/agent/epm/file-requests/"+existing.Id+"/failed",
                    new {sid=caller.sid,stage,win32Code=nativeCode},ct);
            } catch { /* authorisation stays consumed even if audit transport fails */ }
            throw;
        }
    }
    [DllImport("kernel32.dll",SetLastError=true)]private static extern IntPtr OpenProcess(uint desiredAccess,bool inherit,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder image,ref uint length);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool CloseHandle(IntPtr handle);
    [DllImport("wtsapi32.dll",SetLastError=true)]private static extern bool WTSQueryUserToken(uint sessionId,out Microsoft.Win32.SafeHandles.SafeAccessTokenHandle userToken);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool ProcessIdToSessionId(uint pid,out uint session);
}
