using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Hi5Central.EpmBrowserHost;

internal static class Program
{
    private const string ExtensionId="mdablcgpimddfidkjilfglpcaolpopda";
    private const string ExtensionOrigin="chrome-extension://"+ExtensionId+"/";
    private const int MaxIncomingBytes=16384;
    private const int MaxPathLength=4096;

    private static int Main(string[] args)
    {
        if(args.Length==1 && args[0]=="--self-test")
            return SelfTest();
        try
        {
            // Edge/Chrome supplies the extension origin as the first argument.
            // Registration's allowed_origins is the main authorization layer;
            // check it again inside the unprivileged host.
            if(args.Length==0 || args[0]!=ExtensionOrigin)
                return 2;
            using var stdin=Console.OpenStandardInput();
            using var stdout=Console.OpenStandardOutput();
            var json=ReadFrame(stdin);
            using var request=JsonDocument.Parse(json);
            var value=request.RootElement;
            if(value.ValueKind!=JsonValueKind.Object
                || !value.TryGetProperty("type",out var action)
                || action.GetString()!="request"
                || !value.TryGetProperty("path",out var filename)
                || filename.ValueKind!=JsonValueKind.String)
            {
                WriteFrame(stdout,new {ok=false,message="Unsupported Hi5Central request."});
                return 0;
            }

            string? chosen=filename.GetString();
            if(!TryValidateLocalDownload(chosen,out string path))
            {
                WriteFrame(stdout,new {
                    ok=false,
                    message="Choose a completed EXE from your Windows Downloads folder. Other files are not supported by this pilot."
                });
                return 0;
            }

            string broker=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Hi5Central","EPM","Hi5CentralEpmPilot.exe");
            if(!File.Exists(broker))
            {
                WriteFrame(stdout,new {ok=false,message="The Hi5Central EPM Windows client is not installed."});
                return 0;
            }
            var ps=new ProcessStartInfo {
                FileName=broker,UseShellExecute=false,
                WorkingDirectory=Path.GetDirectoryName(broker)!
            };
            // ArgumentList prevents shell interpretation or argument injection.
            ps.ArgumentList.Add(path);
            using var proc=Process.Start(ps);
            if(proc is null)
                throw new InvalidOperationException("Unable to start EPM companion.");

            // Elevation is NOT performed by this host. The existing EPM user
            // prompt and authenticated SYSTEM service handle the exact file,
            // signer, SID, session, justification and technician approval.
            WriteFrame(stdout,new {ok=true,message="Hi5Central opened the administrator access request."});
            return 0;
        }
        catch(Exception)
        {
            // Never leak paths, usernames, privileged details or raw exception
            // messages to a browser extension or stdout/stderr.
            try {
                using var output=Console.OpenStandardOutput();
                WriteFrame(output,new {ok=false,message="Hi5Central could not open this request."});
            } catch { }
            return 1;
        }
    }

    internal static byte[] ReadFrame(Stream input)
    {
        Span<byte> prefix=stackalloc byte[4];
        input.ReadExactly(prefix);
        int length=BinaryPrimitives.ReadInt32LittleEndian(prefix);
        if(length<2 || length>MaxIncomingBytes)
            throw new InvalidDataException("Native message length outside pilot bounds.");
        byte[] body=new byte[length];
        input.ReadExactly(body);
        return body;
    }

    internal static void WriteFrame(Stream output,object result)
    {
        byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(result);
        if(bytes.Length>4096)throw new InvalidDataException("Native response too large.");
        Span<byte> prefix=stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(prefix,bytes.Length);
        output.Write(prefix);
        output.Write(bytes);
        output.Flush();
    }

    private static string DownloadsRoot()
    {
        string root=Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),"Downloads");
        try
        {
            using var key=Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",false);
            const string downloadsGuid="{374DE290-123F-4565-9164-39C4925E467B}";
            if(key?.GetValue(downloadsGuid) is string redirected
                && !string.IsNullOrWhiteSpace(redirected))
                root=Environment.ExpandEnvironmentVariables(redirected);
        }
        catch { /* Fall back to the user's actual profile Downloads. */ }
        return Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
    }

    internal static bool TryValidateLocalDownload(string? candidate,out string canonical)
    {
        canonical="";
        try
        {
            if(string.IsNullOrWhiteSpace(candidate) || candidate.Length>MaxPathLength
                || !Path.IsPathFullyQualified(candidate)
                || candidate.StartsWith(@"\\",StringComparison.Ordinal)
                || !string.Equals(Path.GetExtension(candidate),".exe",StringComparison.OrdinalIgnoreCase))
                return false;
            string path=Path.GetFullPath(candidate);
            string root=DownloadsRoot();
            if(!path.StartsWith(root,StringComparison.OrdinalIgnoreCase))
                return false;
            var drive=new DriveInfo(Path.GetPathRoot(path)!);
            if(drive.DriveType!=DriveType.Fixed)return false;
            var file=new FileInfo(path);
            if(!file.Exists || file.Length<1 || file.Attributes.HasFlag(FileAttributes.ReparsePoint))
                return false;
            var current=file.Directory;
            while(current!=null && current.FullName.StartsWith(root,StringComparison.OrdinalIgnoreCase))
            {
                if(current.Attributes.HasFlag(FileAttributes.ReparsePoint))return false;
                current=current.Parent;
            }
            canonical=path;
            return true;
        }
        catch {return false;}
    }

    private static int SelfTest()
    {
        try
        {
            byte[] msg=JsonSerializer.SerializeToUtf8Bytes(new{type="request",path=@"C:\Users\Example\Downloads\Setup.exe"});
            using var pipe=new MemoryStream();
            WriteFrame(pipe,new {type="request",path=@"C:\Users\Example\Downloads\Setup.exe"});
            pipe.Position=0;
            using var decoded=JsonDocument.Parse(ReadFrame(pipe));
            if(decoded.RootElement.GetProperty("type").GetString()!="request")
                throw new Exception("Roundtrip failed.");
            using var tooLong=new MemoryStream(new byte[]{0xFF,0xFF,0x7F,0x7F});
            try {
                ReadFrame(tooLong);
                throw new Exception("Oversize native message accepted.");
            }
            catch(InvalidDataException) { /* desired */ }
            if(TryValidateLocalDownload(@"\\evil\share\setup.exe",out _)
                || TryValidateLocalDownload(@"C:\Windows\System32\cmd.exe",out _)
                || TryValidateLocalDownload("not-absolute.exe",out _)
                || TryValidateLocalDownload(@"C:\Users\Example\Downloads\evil.bat",out _))
                throw new Exception("Untrusted path accepted.");
            Console.WriteLine("PASS: browser native message framing and untrusted path rejection.");
            return 0;
        }
        catch(Exception error) {
            Console.Error.WriteLine("FAIL: "+error.GetType().Name);
            return 1;
        }
    }
}
