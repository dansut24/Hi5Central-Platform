using Avalonia;
using Hi5Central.AppPortal.Services;

namespace Hi5Central.AppPortal;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (OperatingSystem.IsWindows()
            && args.Contains("--notify", StringComparer.OrdinalIgnoreCase))
        {
            PortalNotifications.PollOnceAsync().GetAwaiter().GetResult();
            return;
        }
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .LogToTrace();
}