#include "app/viewer_app.h"

#ifdef _WIN32
#include <windows.h>
#endif

int main(int argc, char* argv[]) {
#ifdef _WIN32
    // Keep the proven console-subsystem argv semantics used by Windows URL
    // protocol activation, but remove the console immediately so the Viewer
    // behaves like a native GUI application.
    if (HWND console = GetConsoleWindow(); console) {
        ShowWindow(console, SW_HIDE);
    }
    FreeConsole();
#endif

    hi5::ViewerApp app;
    return app.Run(argc, argv);
}