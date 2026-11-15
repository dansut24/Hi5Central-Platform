using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using System.Security.Principal;

namespace Hi5Central.EpmPilot;

/// <summary>
/// Tests the SAME broker challenge method used for a real elevation, in a
/// non-privileged local pipe loopback. Does not create administrators, alter
/// desktops, consume approvals, or start installers. Must pass on Windows CI.
/// </summary>
internal static class PipeProtocolSelfTest
{
    internal static async Task RunAsync()
    {
        await ExchangeAsync(grant:true);
        await ExchangeAsync(grant:false);
        Console.WriteLine("PASS: EPM bidirectional desktop-grant protocol; grant/rejection preserve diagnostic codes.");
    }

    private static async Task ExchangeAsync(bool grant)
    {
        string pipeName="H5CEPM-ProtocolTest-"+Guid.NewGuid().ToString("N");
        using var cts=new CancellationTokenSource(TimeSpan.FromSeconds(12));
        using var server=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,
            PipeTransmissionMode.Message,PipeOptions.Asynchronous);
        using var client=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,
            PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation);

        Task<Exception?> serverWork=Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(cts.Token);
            server.ReadMode=PipeTransmissionMode.Message;
            byte[] originalRequest=new byte[256];
            int requestLength=await server.ReadAsync(originalRequest,cts.Token);
            if(requestLength<=0)throw new InvalidDataException("Protocol self-test initial request missing.");
            try {
                WindowsIdentity.RunImpersonated(
                    SafeAccessTokenHandle.InvalidHandle,
                    () => EpmService.RequestDesktopGrant(server,"S-1-5-32-545"));
                return null;
            }
            catch(Exception ex) {return ex;}
        },cts.Token);

        await client.ConnectAsync(3500,cts.Token);
        client.ReadMode=PipeTransmissionMode.Message;
        await client.WriteAsync(new byte[]{0x7B,0x7D},cts.Token); // {}
        await client.FlushAsync(cts.Token);

        byte[] challengeData=new byte[1024];
        int received=await client.ReadAsync(challengeData,cts.Token);
        if(received<1) throw new InvalidDataException("Protocol self-test challenge absent.");
        using(var challenge=JsonDocument.Parse(challengeData.AsMemory(0,received)))
        {
            if(challenge.RootElement.GetProperty("action").GetString()!="grant-local-desktop"
                || challenge.RootElement.GetProperty("adminSid").GetString()!="S-1-5-32-545")
                throw new InvalidDataException("Unexpected broker desktop challenge.");
        }
        byte[] response=JsonSerializer.SerializeToUtf8Bytes(new {
            granted=grant,
            stage=grant?"":"desktop-query-identity",
            win32Code=grant?0:5
        });
        await client.WriteAsync(response,cts.Token);
        await client.FlushAsync(cts.Token);

        Exception? failure=await serverWork.WaitAsync(cts.Token);
        if(grant && failure!=null)
            throw new InvalidOperationException("Desktop grant protocol accepted response but broker threw.",failure);
        if(!grant && (failure is not EpmLaunchException epm
            || epm.Stage!="desktop-query-identity" || epm.WindowsCode!=5))
            throw new InvalidOperationException("Desktop rejection did not preserve Windows stage/code.",failure);
    }
}
