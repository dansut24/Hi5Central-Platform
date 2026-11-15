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
            Environment.ExitCode=0;
            return;
        }
        ApplicationConfiguration.Initialize();
        if(args.Length==1 && args[0]=="--watch") {
            Application.Run(new ApprovalTray());
            return;
        }
        if(args.Length!=1 || !args[0].EndsWith(".exe",StringComparison.OrdinalIgnoreCase)) {
            MessageBox.Show("Right-click a downloaded EXE and select Run with Hi5Central admin.",
                "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
            return;
        }
        Application.Run(new LauncherContext(args[0]));
    }
    internal static async Task<JsonDocument> AskBroker(string type,string path="",string reason="",
        InteractiveDesktopHandles? interactiveDesktop=null)
    {
        using var client=new NamedPipeClientStream(".",EpmService.PipeName,PipeDirection.InOut,
            PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation);
        using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(38));
        await client.ConnectAsync(3500,limit.Token);
        var bytes=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{
            type,path,reason,
            stationHandle=interactiveDesktop?.Station.ToInt64().ToString(),
            desktopHandle=interactiveDesktop?.Desktop.ToInt64().ToString()
        }));
        await client.WriteAsync(bytes,limit.Token);
        await client.FlushAsync(limit.Token);
        using var response=new MemoryStream();
        var buffer=new byte[8192];
        int n;
        while((n=await client.ReadAsync(buffer,limit.Token))>0){
            if(response.Length+n>262144) throw new InvalidDataException("Broker response exceeded size limit.");
            response.Write(buffer,0,n);
        }
        return JsonDocument.Parse(response.ToArray());
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
                // The desktop handles belong to this standard-user session;
                // the service validates their kernel type/name before adding any ACE.
                using var desktop=InteractiveDesktopHandles.Open();
                using var launched=await AskBroker("run",path,interactiveDesktop:desktop);
                if(!Ok(launched.RootElement))throw new InvalidOperationException(Value(launched.RootElement,"error"));
                MessageBox.Show("Hi5Central started the approved executable. No administrator password was shared.",
                    "Hi5Central Elevation",MessageBoxButtons.OK,MessageBoxIcon.Information);
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
