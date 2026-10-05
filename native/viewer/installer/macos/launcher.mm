#import <Cocoa/Cocoa.h>

#include <spawn.h>
#include <string>

extern char** environ;

namespace {

NSString* gViewerBundlePath = nil;

NSString* ViewerBundlePath() {
    if (gViewerBundlePath) return gViewerBundlePath;
    return [[NSBundle mainBundle] bundlePath];
}

void InstallPersistentCopyIfMounted() {
    NSString* source = [[NSBundle mainBundle] bundlePath];
    if (![source hasPrefix:@"/Volumes/"]) return;

    NSFileManager* files = [NSFileManager defaultManager];
    NSString* applications = [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"];
    NSString* target = [applications stringByAppendingPathComponent:@"Hi5CentralViewer.app"];

    NSError* error = nil;
    if (![files createDirectoryAtPath:applications
          withIntermediateDirectories:YES
                           attributes:nil
                                error:&error]) {
        NSLog(@"Hi5Central Viewer could not create user Applications directory: %@", error);
        return;
    }

    if ([files fileExistsAtPath:target] && ![files removeItemAtPath:target error:&error]) {
        NSLog(@"Hi5Central Viewer could not replace existing application: %@", error);
        return;
    }

    error = nil;
    if (![files copyItemAtPath:source toPath:target error:&error]) {
        NSLog(@"Hi5Central Viewer could not install persistent application copy: %@", error);
        return;
    }

    NSURL* targetUrl = [NSURL fileURLWithPath:target isDirectory:YES];
    const OSStatus registration = LSRegisterURL((__bridge CFURLRef)targetUrl, true);
    if (registration != noErr) {
        NSLog(@"Hi5Central Viewer LaunchServices registration returned %d", (int)registration);
    }

    gViewerBundlePath = [target copy];
}

bool LaunchViewerCore(NSString* deepLink) {
    NSString* corePath = [ViewerBundlePath()
        stringByAppendingPathComponent:@"Contents/MacOS/Hi5CentralViewerCore"];

    const char* executable = [corePath fileSystemRepresentation];
    if (!executable || !*executable) return false;

    std::string executableArg(executable);
    std::string linkArg;
    if (deepLink) {
        const char* utf8 = [deepLink UTF8String];
        if (utf8) linkArg = utf8;
    }

    char* argvWithLink[] = {
        executableArg.data(),
        linkArg.empty() ? nullptr : linkArg.data(),
        nullptr
    };
    char* argvWithoutLink[] = {
        executableArg.data(),
        nullptr
    };

    pid_t pid = 0;
    const int rc = posix_spawn(
        &pid,
        executable,
        nullptr,
        nullptr,
        linkArg.empty() ? argvWithoutLink : argvWithLink,
        environ);
    return rc == 0;
}

bool IsSupportedViewerUrl(NSURL* url) {
    if (!url) return false;
    NSString* scheme = [[url scheme] lowercaseString];
    return [scheme isEqualToString:@"hi5central-viewer"] ||
           [scheme isEqualToString:@"hi5viewer"] ||
           [scheme isEqualToString:@"hi5tech"];
}

} // namespace

@interface Hi5CentralViewerLauncherDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, assign) BOOL receivedUrl;
@end

@implementation Hi5CentralViewerLauncherDelegate

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
    (void)notification;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    // A normal Finder launch should still show the Viewer shell. Give
    // LaunchServices a short opportunity to deliver an incoming URL first.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        if (!self.receivedUrl) {
            LaunchViewerCore(nil);
            [NSApp terminate:nil];
        }
    });
}

- (void)application:(NSApplication*)application openURLs:(NSArray<NSURL*>*)urls {
    self.receivedUrl = YES;

    for (NSURL* url in urls) {
        if (!IsSupportedViewerUrl(url)) continue;
        LaunchViewerCore([url absoluteString]);
    }

    // Keep each remote session in its own core process. Exiting this lightweight
    // URL handler means the next custom URL launch gets a fresh launcher and can
    // create another independent Viewer session.
    [application terminate:nil];
}

@end

int main(int argc, const char* argv[]) {
    (void)argc;
    (void)argv;

    @autoreleasepool {
        InstallPersistentCopyIfMounted();

        NSApplication* app = [NSApplication sharedApplication];
        Hi5CentralViewerLauncherDelegate* delegate =
            [[Hi5CentralViewerLauncherDelegate alloc] init];
        [app setDelegate:delegate];
        [app run];
    }

    return 0;
}
