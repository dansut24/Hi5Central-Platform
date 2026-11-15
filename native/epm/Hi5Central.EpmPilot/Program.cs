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
        string reason="",int processId=0)
    {
        using var client=new NamedPipeClientStream(".",EpmService.PipeName,PipeDirection.InOut,
            PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation);
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(38));
        await client.ConnectAsync(3500,timeout.Token);
        client.ReadMode=PipeTransmissionMode.Message;
        var message=JsonSerializer.SerializeToUtf8Bytes(new{type,path,reason,processId});
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
                    if(type!="run" || grant!=null)
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
                if(grant!=null && type=="run"
                    && root.TryGetProperty("success",out var success) && success.GetBoolean()
                    && root.TryGetProperty("processId",out var pid))
                {
                    int id=pid.GetInt32();
                    if(id<=0 || !ActiveDesktopGrants.TryAdd(id,grant))
                        throw new InvalidOperationException("Unable to retain the EPM session grant.");
                    grant=null; // Owned by the monitor until the job ends.
                }
                if(localFailure is not null && type=="run")
                {
                    result.Dispose();
                    throw new InvalidOperationException("Desktop grant failed: "+localFailure);
                }
                return result;
            }
        }
        finally {grant?.Dispose();}
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
    internal static async Task RequestOrLaunch(string path)
    {
        try {
            using var checkedStatus=await AskBroker("check",path);
            var state=Value(checkedStatus.RootElement,"status");
            if(state=="approved"){
                var choice=MessageBox.Show(
                    "The exact executable has been approved. Run it with Hi5Central administrator privileges now?\n\n"+
                    Path.GetFileName(path)+"\n\nThis approval is one-time and expires after 15 minutes.",
                    "Hi5Central Elevation",MessageBoxButtons.YesNo,MessageBoxIcon.Information);
                if(choice!=DialogResult.Yes)return;
                using var launched=await AskBroker("run",path);
                if(!Ok(launched.RootElement))
                    throw new InvalidOperationException(Value(launched.RootElement,"error"));
                int pid=launched.RootElement.GetProperty("processId").GetInt32();
                MessageBox.Show("Hi5Central started the approved executable.\n\n"+
                    "The launcher will remain in the background to revoke temporary "+
                    "desktop access when the installer exits. Do not end the EPM launcher in Task Manager.",
                    "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
                await WaitForJobAndRevokeGrant(pid);
                return;
            }
            if(state=="pending"){
                MessageBox.Show("Your elevation request is awaiting technician approval.\nOnce approved, right-click the same EXE again.",
                    "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
                return;
            }
            string? justification=ReasonDialog.Prompt(path);
            if(justification is null)return;
            using var result=await AskBroker("request",path,justification);
            if(!Ok(result.RootElement))throw new InvalidOperationException(Value(result.RootElement,"error"));
            MessageBox.Show("Your elevation request has been submitted.\nIT can review it in RMM → Elevation requests.\nYou will be notified when it is approved.",
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
        } catch(Exception e) {
            MessageBox.Show("Hi5Central elevation could not continue.\n\n"+e.Message,
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        }
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
internal static class ReasonDialog
{
    internal static string? Prompt(string path)
    {
        using var dialog=new Form {
            Text="Hi5Central Elevation Approval",Width=550,Height=340,
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
        var cancel=new Button {Text="Cancel",Left=291,Top=245,Width=96,Height=32,DialogResult=DialogResult.Cancel};
        var submit=new Button {Text="Request approval",Left=393,Top=245,Width=114,Height=32,Enabled=false,
            DialogResult=DialogResult.OK};
        input.TextChanged+=(_,_)=>submit.Enabled=input.Text.Trim().Length>=20;
        dialog.Controls.AddRange([title,file,explain,input,cancel,submit]);
        dialog.AcceptButton=submit;dialog.CancelButton=cancel;
        return dialog.ShowDialog()==DialogResult.OK?input.Text.Trim():null;
    }
}
internal sealed class ApprovalTray : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly System.Windows.Forms.Timer timer;
    private readonly HashSet<string> notified=new(StringComparer.OrdinalIgnoreCase);
    private readonly ContextMenuStrip menu=new();
    private bool querying;
    private string lastApproved="";
    internal ApprovalTray()
    {
        icon=new NotifyIcon {Visible=true,Icon=SystemIcons.Shield,Text="Hi5Central Elevation approvals",
            ContextMenuStrip=menu};
        menu.Items.Add("Hi5Central elevation monitor (Newtest)",null,(_,_)=>{});
        menu.Items.Add("Refresh requests",null,async(_,_)=>await Check());
        menu.Items.Add("Exit",null,(_,_)=>ExitThread());
        icon.BalloonTipClicked+=async(_,_)=>{if(!string.IsNullOrEmpty(lastApproved))await Program.RequestOrLaunch(lastApproved);};
        timer=new System.Windows.Forms.Timer {Interval=15000};
        timer.Tick+=async(_,_)=>await Check();
        timer.Start();
        _=Check();
    }
    private async Task Check()
    {
        if(querying)return;
        querying=true;
        try{
            using var response=await Program.AskBroker("watch");
            if(!response.RootElement.TryGetProperty("requests",out var requests))return;
            foreach(var row in requests.EnumerateArray()) {
                string status=row.GetProperty("status").GetString()??"";
                string path=row.GetProperty("path").GetString()??"";
                if(status=="approved"&&notified.Add(path)) {
                    lastApproved=path;
                    icon.BalloonTipTitle="Hi5Central elevation approved";
                    icon.BalloonTipText=Path.GetFileName(path)+" is approved. Click to run or right-click the file again.";
                    icon.ShowBalloonTip(10000);
                }
                if(status!="approved")notified.Remove(path);
            }
        }catch{/* offline is not authorisation */}
        finally{querying=false;}
    }
    protected override void ExitThreadCore(){
        timer.Stop();timer.Dispose();icon.Visible=false;icon.Dispose();menu.Dispose();
        base.ExitThreadCore();
    }
}
