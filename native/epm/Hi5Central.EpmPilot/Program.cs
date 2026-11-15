using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace Hi5Central.EpmPilot;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if(args.Length==1 && args[0]=="--service") {
            ServiceBase.Run(new EpmService());
            return;
        }
        if(args.Length==1 && args[0]=="--coverage-report") {
            // Read-only posture report for automated Windows Newtest qualification.
            // Does not open UAC, create a credential or alter the EPM service.
            ElevationCoverageProbe.Print();
            return;
        }
        if(args.Length==1 && args[0]=="--self-test") {
            bool refusedMissingFile=false;
            try {
                VerifiedFile.Inspect(Path.Combine(Path.GetTempPath(),"missing-hi5central-epm-file.exe"));
            } catch { refusedMissingFile=true; }
            if (!refusedMissingFile) {
                Console.Error.WriteLine("FAIL: missing executable accepted.");
                Environment.ExitCode=1;
                return;
            }
            // Test CheckTokenMembership with a duplicated IMPERSONATION token,
            // not with the primary token returned from LogonUser.
            AdminLaunch.RunTokenSelfTest();
            Console.WriteLine("PASS: missing file denied; primary-to-impersonation token membership check works.");
            // Reproduce the production one-time desktop-grant handshake,
            // including an explicit Windows denial, before publishing a pilot.
            PipeProtocolSelfTest.RunAsync().GetAwaiter().GetResult();
            ElevationCoverageTests.Run();
            UacLaunchIntents.SelfTest();
            NativeUacReviewPolicy.SelfTest();
            ApprovalAutoLaunchPolicy.SelfTest();
            ManagedUacActions.SelfTest();
            VerifiedFile.ManagedVerifierSelfTest();
            string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if(!EpmService.IsTrustedWindowsCredentialHostPath(
                    Path.Combine(windows,"System32","consent.exe"),windows)
                || !EpmService.IsTrustedWindowsCredentialHostPath(
                    Path.Combine(windows,"System32","CredentialUIBroker.exe"),windows)
                || EpmService.IsTrustedWindowsCredentialHostPath(
                    Path.Combine(Path.GetTempPath(),"consent.exe"),windows)
                || EpmService.IsTrustedWindowsCredentialHostPath(
                    Path.Combine(windows,"SysWOW64","consent.exe"),windows))
                throw new InvalidOperationException("UAC request host executable validation failed.");
            Console.WriteLine("PASS: native UAC bridge rejects forged user-host executable paths.");
            Environment.ExitCode=0;
            return;
        }
        ApplicationConfiguration.Initialize();
        if(args.Length==1 && args[0]=="--desktop-preflight") {
            try {
                // Read-only preflight: open WinSta0/Default with ACL access
                // without editing a desktop security descriptor or approval.
                InteractiveDesktopGrant.RunPreflight();
                MessageBox.Show(
                    "PASS: This Windows session can open WinSta0 and Default desktop with the required ACL rights.\n\n"+
                    "No elevation request was sent and no Windows security settings were changed.",
                    "Hi5Central EPM Desktop Preflight",
                    MessageBoxButtons.OK,MessageBoxIcon.Information);
            } catch(Exception error) {
                MessageBox.Show(
                    "Desktop access preflight failed. No approval was consumed.\n\n"+error.Message,
                    "Hi5Central EPM Desktop Preflight",
                    MessageBoxButtons.OK,MessageBoxIcon.Warning);
            }
            return;
        }
        if(args.Length==1 && args[0]=="--watch") {
            // One notification watcher per user per interactive session.
            // Signing out or restarting the EPM service is NOT required.
            string sid=WindowsIdentity.GetCurrent().User?.Value??"unknown";
            string mutexName=@"Local\Hi5CentralEpmPilotWatcher_"+sid;
            using var singleton=new Mutex(true,mutexName,out bool created);
            if(!created)return;
            try {Application.Run(new ApprovalTray());}
            finally {singleton.ReleaseMutex();}
            return;
        }
        if(args.Length==2 && args[0]=="--managed-uac")
        {
            if(ManagedUacActions.Resolve(args[1]) is null)
            {
                MessageBox.Show("This operation is not enabled for Hi5Central EPM.",
                    "Hi5Central Managed UAC",MessageBoxButtons.OK,MessageBoxIcon.Warning);
                return;
            }
            EnsureWatcherForCurrentUser();
            Application.Run(new ManagedUacLauncherContext(args[1]));
            return;
        }
        if(args.Length!=1 || !args[0].EndsWith(".exe",StringComparison.OrdinalIgnoreCase)) {
            MessageBox.Show("Right-click a downloaded EXE and select Run with Hi5Central admin.",
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        // Launch the watcher *as the requesting standard user* on the very
        // first right-click invocation. This works even after an administrator
        // upgrades the service while the user remains signed in.
        EnsureWatcherForCurrentUser();
        Application.Run(new LauncherContext(args[0]));
    }
    private static void EnsureWatcherForCurrentUser()
    {
        try {
            string sid=WindowsIdentity.GetCurrent().User?.Value??"";
            if(string.IsNullOrWhiteSpace(sid))return;
            string name=@"Local\Hi5CentralEpmPilotWatcher_"+sid;
            if(Mutex.TryOpenExisting(name,out var existing)) {
                existing.Dispose();
                return;
            }
            string? exe=Environment.ProcessPath;
            if(string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))return;
            // Do not start the tray from an elevated administrator's session.
            // The explorer shell invokes us with the requesting user's token.
            using var identity=WindowsIdentity.GetCurrent();
            if(identity.User?.IsWellKnown(WellKnownSidType.LocalSystemSid)==true)return;
            Process.Start(new ProcessStartInfo {
                FileName=exe,
                Arguments="--watch",
                UseShellExecute=false,
                CreateNoWindow=true,
                WorkingDirectory=Path.GetDirectoryName(exe)!
            })?.Dispose();
        }
        catch {
            // Notification bootstrap is best effort; request/elevation logic
            // continues unchanged. User can also run the explicit --watch command.
        }
    }

    private static readonly ConcurrentDictionary<int,InteractiveDesktopGrant> ActiveDesktopGrants=new();

    private static async Task<JsonDocument> ReadBrokerMessage(
        NamedPipeClientStream client,CancellationToken ct)
    {
        using var data=new MemoryStream();
        var bytes=new byte[8192];
        do {
            int n=await client.ReadAsync(bytes,ct);
            if(n==0)throw new EndOfStreamException("The Hi5Central broker connection closed.");
            if(data.Length+n>262144)throw new InvalidDataException("EPM broker response exceeds size limit.");
            data.Write(bytes,0,n);
        } while(!client.IsMessageComplete);
        return JsonDocument.Parse(data.ToArray());
    }

    internal static async Task<JsonDocument> AskBroker(string type,string path="",
        string reason="",int processId=0,bool autoLaunchOnApproval=false)
    {
        using var client=new NamedPipeClientStream(".",EpmService.PipeName,PipeDirection.InOut,
            PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation);
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(38));
        await client.ConnectAsync(3500,timeout.Token);
        client.ReadMode=PipeTransmissionMode.Message;
        var message=JsonSerializer.SerializeToUtf8Bytes(new{type,path,reason,processId,autoLaunchOnApproval});
        await client.WriteAsync(message,timeout.Token);
        InteractiveDesktopGrant? grant=null;
        string? localFailure=null;
        try
        {
            while(true)
            {
                using var received=await ReadBrokerMessage(client,timeout.Token);
                var root=received.RootElement;
                if(root.TryGetProperty("action",out var action)
                    && action.GetString()=="grant-local-desktop")
                {
                    if((type!="run" && type!="managed-run") || grant!=null)
                        throw new InvalidOperationException("Unexpected EPM desktop grant challenge.");
                    bool granted=false;
                    string failureStage="";
                    int failureCode=0;
                    try {
                        string sid=root.GetProperty("adminSid").GetString()
                            ?? throw new InvalidOperationException("Missing EPM account SID.");
                        grant=InteractiveDesktopGrant.AcquireLocal(sid);
                        granted=true;
                    } catch(Exception e) {
                        localFailure=e.Message;
                        failureStage=e is EpmLaunchException epm
                            ? epm.Stage : "desktop-grant-client-error";
                        failureCode=e is EpmLaunchException native
                            ? native.WindowsCode : 0;
                    }
                    // Preserve the actual local Win32 failure stage in the RMM
                    // audit instead of reporting only "desktop-grant-protocol".
                    // Never return freeform exception text or Windows identities.
                    var ack=JsonSerializer.SerializeToUtf8Bytes(new{
                        granted,stage=failureStage,win32Code=failureCode
                    });
                    await client.WriteAsync(ack,timeout.Token);
                    continue;
                }
                var result=JsonDocument.Parse(root.GetRawText());
                if(grant!=null && (type=="run" || type=="managed-run")
                    && root.TryGetProperty("success",out var success) && success.GetBoolean()
                    && root.TryGetProperty("processId",out var pid))
                {
                    int id=pid.GetInt32();
                    if(id<=0 || !ActiveDesktopGrants.TryAdd(id,grant))
                        throw new InvalidOperationException("Unable to retain the EPM session grant.");
                    grant=null; // Owned by the monitor until the job ends.
                }
                if(localFailure is not null && (type=="run" || type=="managed-run"))
                {
                    result.Dispose();
                    throw new InvalidOperationException("Desktop grant failed: "+localFailure);
                }
                return result;
            }
        }
        finally {grant?.Dispose();}
    }

    internal static async Task StartManagedUacPrompt(string code)
    {
        var action=ManagedUacActions.Resolve(code);
        if(action is null)
            throw new UnauthorizedAccessException("This managed Windows action is not supported.");
        using var response=await AskBroker("managed-prepare",path:code);
        var root=response.RootElement;
        if(!root.TryGetProperty("success",out var ok) || ok.ValueKind!=JsonValueKind.True)
        {
            string detail=root.TryGetProperty("error",out var err)
                && err.ValueKind==JsonValueKind.String ? err.GetString()??"" : "";
            throw new InvalidOperationException(
                "Managed Windows UAC broker refused preparation: "+
                (detail.Length>200?detail[..200]:detail.Length>0?detail:"unknown broker error"));
        }
        if(!root.TryGetProperty("actionCode",out var returnedCode)
            || returnedCode.GetString()!=code)
            throw new UnauthorizedAccessException("Managed Windows UAC action code mismatch.");
        if(!root.TryGetProperty("path",out var returnedPath)
            || !string.Equals(returnedPath.GetString(),action.Path,
                StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Managed Windows UAC executable path mismatch.");
        if(!root.TryGetProperty("arguments",out var returnedArgs)
            || returnedArgs.GetString()!=action.Arguments)
            throw new UnauthorizedAccessException("Managed Windows UAC fixed arguments mismatch.");
        if(!root.TryGetProperty("argumentsSha256",out var returnedDigest)
            || returnedDigest.GetString()!=action.ArgumentsSha256)
            throw new UnauthorizedAccessException("Managed Windows UAC argument digest mismatch.");
        try
        {
            // The real Windows UAC credential screen still appears. Choosing
            // Hi5Central in that screen queues only this known managed intent.
            // The original UAC must be cancelled; it is never authenticated.
            using var process=Process.Start(new ProcessStartInfo {
                FileName=action.Path,Arguments=action.Arguments,
                Verb="runas",UseShellExecute=true
            });
        }
        catch(System.ComponentModel.Win32Exception error) when(error.NativeErrorCode==1223)
        {
            // Expected when the employee closes the original UAC after
            // submitting a managed EPM request. No Windows credential passed.
        }
        finally
        {
            // If the user cancelled before requesting Hi5Central EPM,
            // release the three-minute prelaunch reservation immediately.
            // A request already consumed by trusted consent.exe is unaffected.
            try {using var abandoned=await AskBroker("managed-abandon",path:code);} catch { }
        }
    }

    internal static async Task LaunchApprovedManagedAction(string code)
    {
        try
        {
            if(ManagedUacActions.Resolve(code) is null)
                throw new UnauthorizedAccessException("Unknown Hi5Central managed action.");
            using var response=await AskBroker("managed-run",path:code);
            if(!Ok(response.RootElement))
                throw new InvalidOperationException(Value(response.RootElement,"error"));
            int pid=response.RootElement.GetProperty("processId").GetInt32();
            // Retain and revoke the temporary desktop ACL for the lifetime
            // of the exact approved process tree.
            await WaitForJobAndRevokeGrant(pid);
        }
        catch(Exception error)
        {
            MessageBox.Show("Hi5Central couldn't launch the approved Windows action.\n\n"+error.Message,
                "Hi5Central Managed UAC",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        }
    }

    private static async Task WaitForJobAndRevokeGrant(int processId)
    {
        try
        {
            var deadline=DateTime.UtcNow.AddMinutes(46);
            while(DateTime.UtcNow<deadline)
            {
                await Task.Delay(2000);
                try {
                    using var state=await AskBroker("job",processId:processId);
                    if(Ok(state.RootElement) && Value(state.RootElement,"status") is "ended" or "unknown")
                        return;
                }
                catch { /* Retry intermittent broker failures until the bounded deadline. */ }
            }
        }
        finally
        {
            if(ActiveDesktopGrants.TryRemove(processId,out var grant))
                grant.Dispose();
        }
    }

    private static bool Ok(JsonElement data)=>data.TryGetProperty("success",out var value)&&value.GetBoolean();
    private static string Value(JsonElement data,string key)=>data.TryGetProperty(key,out var item)?item.ToString():"";
    internal static async Task RequestOrLaunch(string path,bool startAfterApproval=false)
    {
        try {
            using var checkedStatus=await AskBroker("check",path);
            var state=Value(checkedStatus.RootElement,"status");
            if(state=="approved"){
                if(!startAfterApproval) {
                    var choice=MessageBox.Show(
                        "The exact executable has been approved. Run it with Hi5Central administrator privileges now?\n\n"+
                        Path.GetFileName(path)+"\n\nThis approval is one-time and expires after 15 minutes.",
                        "Hi5Central Elevation",MessageBoxButtons.YesNo,MessageBoxIcon.Information);
                    if(choice!=DialogResult.Yes)return;
                }
                using var launched=await AskBroker("run",path);
                if(!Ok(launched.RootElement))
                    throw new InvalidOperationException(Value(launched.RootElement,"error"));
                int pid=launched.RootElement.GetProperty("processId").GetInt32();
                // Start release monitoring immediately: a modal MessageBox
                // could leave temporary desktop access granted indefinitely
                // if the employee walks away after technician approval.
                await WaitForJobAndRevokeGrant(pid);
                return;
            }
            if(state=="pending"){
                MessageBox.Show("Your elevation request is awaiting technician approval.\nOnce approved, right-click the same EXE again.",
                    "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
                return;
            }
            var justification=ReasonDialog.Prompt(path);
            if(justification is null)return;
            using var result=await AskBroker("request",path,justification.Reason,
                autoLaunchOnApproval:justification.AutoLaunchOnApproval);
            if(!Ok(result.RootElement))throw new InvalidOperationException(Value(result.RootElement,"error"));
            bool autoAccepted=result.RootElement.TryGetProperty("autoLaunchOnApproval",out var auto)
                && auto.ValueKind==JsonValueKind.True;
            MessageBox.Show("Your elevation request has been submitted.\nIT can review it in RMM → Elevation requests.\n"+
                (autoAccepted
                    ? "Once approved, Hi5Central will start the exact signed executable automatically in this Windows session."
                    : "You will be notified when approved and can click to run the verified executable."),
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch(Exception e) {
            MessageBox.Show("Hi5Central elevation could not continue.\n\n"+e.Message,
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        }
    }
}
internal sealed class ManagedUacLauncherContext : ApplicationContext
{
    private readonly System.Windows.Forms.Timer once;
    internal ManagedUacLauncherContext(string code)
    {
        once=new System.Windows.Forms.Timer {Interval=120};
        once.Tick+=async(_,_)=>{
            once.Stop();
            try {await Program.StartManagedUacPrompt(code);}
            catch(Exception error)
            {
                MessageBox.Show(error.Message,"Hi5Central Managed UAC",
                    MessageBoxButtons.OK,MessageBoxIcon.Warning);
            }
            finally {ExitThread();}
        };
        once.Start();
    }
    protected override void ExitThreadCore()
    {
        once.Stop();once.Dispose();
        base.ExitThreadCore();
    }
}
internal sealed class LauncherContext : ApplicationContext
{
    private readonly System.Windows.Forms.Timer once;
    private readonly string selectedFile;
    internal LauncherContext(string path) {
        selectedFile=path;
        once=new System.Windows.Forms.Timer {Interval=120};
        once.Tick+=async (_,_)=>{
            once.Stop();
            try {await Program.RequestOrLaunch(selectedFile);}
            finally {ExitThread();}
        };
        once.Start();
    }
    protected override void ExitThreadCore() {
        once.Stop();once.Dispose();
        base.ExitThreadCore();
    }
}
internal sealed record ApprovalReason(string Reason,bool AutoLaunchOnApproval);

internal static class ReasonDialog
{
    internal static ApprovalReason? Prompt(string path)
    {
        using var dialog=new Form {
            Text="Hi5Central Elevation Approval",Width=550,Height=390,
            StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,
            MaximizeBox=false,MinimizeBox=false,ShowInTaskbar=true
        };
        var title=new Label {Text="Why do you need administrator access?",Left=20,Top=20,Width=490,Height=28,
            Font=new Font(SystemFonts.MessageBoxFont.FontFamily,12,FontStyle.Bold)};
        var file=new Label {Text=Path.GetFileName(path),Left=20,Top=53,Width=490,Height=24,AutoEllipsis=true};
        var explain=new Label {Text="Only this signed EXE and this Windows user will be approved.\nThe request does not grant general administrator rights.",
            Left=20,Top=83,Width=495,Height=42};
        var input=new TextBox {Left=20,Top=137,Width=487,Height=92,Multiline=true,
            ScrollBars=ScrollBars.Vertical,MaxLength=2000};
        var autoLaunch=new CheckBox {
            Text="Start this exact signed EXE automatically after IT approves",
            Left=20,Top=240,Width=487,Height=28,Checked=true
        };
        var cancel=new Button {Text="Cancel",Left=291,Top=287,Width=96,Height=32,DialogResult=DialogResult.Cancel};
        var submit=new Button {Text="Request approval",Left=393,Top=287,Width=114,Height=32,Enabled=false,
            DialogResult=DialogResult.OK};
        input.TextChanged+=(_,_)=>submit.Enabled=input.Text.Trim().Length>=20;
        dialog.Controls.AddRange([title,file,explain,input,autoLaunch,cancel,submit]);
        dialog.AcceptButton=submit;dialog.CancelButton=cancel;
        return dialog.ShowDialog()==DialogResult.OK
            ?new ApprovalReason(input.Text.Trim(),autoLaunch.Checked):null;
    }
}
internal sealed class ApprovalTray : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly System.Windows.Forms.Timer timer;
    private readonly HashSet<string> notified=new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> autoStarted=new(StringComparer.OrdinalIgnoreCase);
    private readonly ContextMenuStrip menu=new();
    private bool querying;
    private string clickableApprovedFile="";
    internal ApprovalTray()
    {
        icon=new NotifyIcon {Visible=true,Icon=SystemIcons.Shield,
            Text="Hi5Central EPM request notifications",ContextMenuStrip=menu};
        menu.Items.Add("Hi5Central EPM (Newtest)",null,(_,_)=>{});
        menu.Items.Add("Refresh request outcomes",null,async(_,_)=>await Check());
        menu.Items.Add("Exit",null,(_,_)=>ExitThread());
        icon.BalloonTipClicked+=async(_,_)=>{
            // A link is offered only for an EXE whose verified content,
            // signer, user and session are subject to a one-time approval.
            string file=clickableApprovedFile;
            if(!string.IsNullOrEmpty(file))await Program.RequestOrLaunch(file);
        };
        timer=new System.Windows.Forms.Timer {Interval=5000};
        timer.Tick+=async(_,_)=>await Check();
        timer.Start();
        _=Check();
    }

    private static string Read(JsonElement row,string key) =>
        row.TryGetProperty(key,out var field) && field.ValueKind==JsonValueKind.String
          ? field.GetString()??"": "";

    private static string Short(string text,int maximum=175)
    {
        string sanitized=new string(text.Where(ch=>!char.IsControl(ch)).ToArray()).Trim();
        return sanitized.Length<=maximum?sanitized:sanitized[..(maximum-1)]+"…";
    }

    private void Notify(string title,string message,string? approvedFile=null)
    {
        // Never expose a clickable link to an unbound UAC action.
        clickableApprovedFile=approvedFile??"";
        icon.BalloonTipTitle=Short(title,60);
        icon.BalloonTipText=Short(message,240);
        icon.ShowBalloonTip(10000);
    }

    private async Task Check()
    {
        if(querying)return;
        querying=true;
        try {
            using var response=await Program.AskBroker("watch");
            if(response.RootElement.TryGetProperty("requests",out var files)
                && files.ValueKind==JsonValueKind.Array)
                foreach(var row in files.EnumerateArray()) {
                    string status=Read(row,"status");
                    string path=Read(row,"path");
                    string id=Read(row,"requestId");
                    string note=Read(row,"decisionNote");
                    if(string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(path)
                        || !notified.Add("file:"+id+":"+status))continue;
                    if(status=="approved") {
                        bool shouldStart=row.TryGetProperty("autoLaunchOnApproval",out var auto)
                            && auto.ValueKind==JsonValueKind.True;
                        if(shouldStart) {
                            // One local launch attempt per approved request. The
                            // broker separately rechecks the signed file identity,
                            // requester SID/session and one-time API redemption.
                            Notify("Hi5Central EPM approved — launching",
                                Path.GetFileName(path)+" approved. Attempting one-time verified launch.");
                            if(autoStarted.Add(id)) {
                                string code=Read(row,"operationCode");
                                if(code.Length>0)
                                    _ = Program.LaunchApprovedManagedAction(code);
                                else
                                    _ = Program.RequestOrLaunch(path,true);
                            }
                        } else {
                            Notify("Hi5Central EPM approved",
                                Path.GetFileName(path)+" approved once. Click this notification to run the verified file, or use Run with Hi5Central admin again.",
                                path);
                        }
                    } else if(status=="rejected") {
                        Notify("Hi5Central EPM request denied",
                            Path.GetFileName(path)+" was rejected. "+(note.Length>0?"Reason: "+note:"Contact your IT administrator."));
                    } else if(status=="expired") {
                        Notify("Hi5Central EPM approval expired",
                            "Approval expired for "+Path.GetFileName(path)+". Submit a new request.");
                    } else if(status=="launch_failed") {
                        Notify("Hi5Central EPM launch failed",
                            Path.GetFileName(path)+" could not be launched. Contact IT to review the device activity.");
                    }
                }
            if(response.RootElement.TryGetProperty("uacReviews",out var uac)
                && uac.ValueKind==JsonValueKind.Array)
                foreach(var row in uac.EnumerateArray()) {
                    string status=Read(row,"status");
                    string id=Read(row,"requestId");
                    string note=Read(row,"decisionNote");
                    if(string.IsNullOrWhiteSpace(id)
                        || !notified.Add("uac:"+id+":"+status))continue;
                    if(status=="rejected") {
                        Notify("Hi5Central EPM UAC request denied",
                            "Your UAC request was rejected. "+(note.Length>0?"Reason: "+note:"Contact IT for details."));
                    } else if(status=="reviewed") {
                        // This cannot be called 'approved': native CredUI does
                        // not expose a verified executable/operation to bind.
                        Notify("Hi5Central EPM UAC review completed",
                            "IT reviewed your UAC request, but administrator access was NOT granted. Contact IT for a supported launch method."
                            +(note.Length>0?" Note: "+note:""));
                    } else if(status=="expired") {
                        Notify("Hi5Central EPM UAC review expired",
                            "The UAC review expired. No administrator access was granted.");
                    }
                }
        } catch {
            // Network errors never mean that an action was approved.
        } finally {querying=false;}
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();timer.Dispose();icon.Visible=false;icon.Dispose();menu.Dispose();
        base.ExitThreadCore();
    }
}
