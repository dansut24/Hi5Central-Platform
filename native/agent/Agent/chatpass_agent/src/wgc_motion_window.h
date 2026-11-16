#pragma once
#ifdef _WIN32
#include <windows.h>
#include <algorithm>
#include <chrono>
#include <thread>

// Stage 2N: visible, temporary test animation on the authenticated user's
// DEFAULT desktop only. Never inject mouse/keyboard input, open a secure
// desktop, create screenshot files, or modify the live stream configuration.
namespace hi5 {
class WgcMotionTestWindow final {
public:
    WgcMotionTestWindow() = default;
    WgcMotionTestWindow(const WgcMotionTestWindow&) = delete;
    WgcMotionTestWindow& operator=(const WgcMotionTestWindow&) = delete;
    ~WgcMotionTestWindow() { Close(); }

    bool Open(HMONITOR monitor, unsigned rate) {
        if (!monitor || (rate != 15 && rate != 30 && rate != 60)) return false;
        WNDCLASSW wc{};
        wc.lpfnWndProc = &WndProc;
        wc.hInstance = GetModuleHandleW(nullptr);
        wc.lpszClassName = L"Hi5CentralWgcMotion527";
        wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
        if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
            return false;
        MONITORINFO info{};
        info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(monitor, &info)) return false;
        const int width = info.rcMonitor.right - info.rcMonitor.left;
        const int height = info.rcMonitor.bottom - info.rcMonitor.top;
        if (width < 700 || height < 440) return false;
        const int x = info.rcMonitor.left + width - 672;
        const int y = info.rcMonitor.top + 35;
        rate_ = rate;
        hwnd_ = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            wc.lpszClassName, L"Hi5Central isolated capture benchmark",
            WS_POPUP | WS_BORDER, x, y, 640, 320,
            nullptr, nullptr, wc.hInstance, nullptr);
        if (!hwnd_) return false;
        SetWindowLongPtrW(hwnd_, GWLP_USERDATA,
                          reinterpret_cast<LONG_PTR>(this));
        ShowWindow(hwnd_, SW_SHOWNOACTIVATE);
        if (!IsWindowVisible(hwnd_)) { Close(); return false; }
        Pump();
        return PaintNext();
    }

    bool PaintNext() {
        if (!hwnd_ || !IsWindow(hwnd_) || !IsWindowVisible(hwnd_)) return false;
        ++tick_;
        InvalidateRect(hwnd_, nullptr, FALSE);
        if (!UpdateWindow(hwnd_)) return false;
        ++painted_;
        return true;
    }

    void Pump() {
        MSG msg{};
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsigned Painted() const noexcept { return painted_; }

    void Close() noexcept {
        if (hwnd_) {
            HWND h = hwnd_;
            hwnd_ = nullptr;
            SetWindowLongPtrW(h, GWLP_USERDATA, 0);
            if (IsWindow(h)) DestroyWindow(h);
        }
    }

private:
    static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg,
                                    WPARAM wparam, LPARAM lparam) {
        if (msg == WM_ERASEBKGND) return 1;
        if (msg == WM_PAINT) {
            auto* self = reinterpret_cast<WgcMotionTestWindow*>(
                GetWindowLongPtrW(hwnd, GWLP_USERDATA));
            PAINTSTRUCT ps{};
            HDC dc = BeginPaint(hwnd, &ps);
            if (dc) {
                if (self) self->Draw(dc);
                EndPaint(hwnd, &ps);
            }
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    void Draw(HDC dc) {
        RECT bounds{0, 0, 640, 320};
        HBRUSH bg = CreateSolidBrush(RGB(25, 38, 57));
        FillRect(dc, &bounds, bg);
        DeleteObject(bg);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, RGB(246, 250, 255));
        RECT header{20, 14, 620, 52};
        DrawTextW(dc, L"Hi5Central WGC capture benchmark",
                  -1, &header, DT_LEFT | DT_SINGLELINE);
        RECT subheader{20, 47, 620, 76};
        DrawTextW(dc, L"Temporary animation - closes automatically",
                  -1, &subheader, DT_LEFT | DT_SINGLELINE);
        // The entire 640x210 strip area changes each paint, generating
        // independently composited desktop updates at 15/30/60 Hz.
        for (int i = 0; i < 24; ++i) {
            const unsigned phase = static_cast<unsigned>(i) * 13u + tick_ * 7u;
            RECT bar{12 + i * 26, 90, 35 + i * 26, 295};
            HBRUSH brush = CreateSolidBrush(RGB(
                static_cast<BYTE>(40u + phase % 190u),
                static_cast<BYTE>(35u + (phase * 3u) % 190u),
                static_cast<BYTE>(45u + (phase * 7u) % 190u)));
            FillRect(dc, &bar, brush);
            DeleteObject(brush);
        }
        wchar_t label[100]{};
        wsprintfW(label, L"Target %u Hz  |  Updates %u", rate_, tick_);
        RECT footer{20, 297, 620, 319};
        DrawTextW(dc, label, -1, &footer, DT_LEFT | DT_SINGLELINE);
    }

    HWND hwnd_ = nullptr;
    unsigned rate_ = 0;
    unsigned tick_ = 0;
    unsigned painted_ = 0;
};
} // namespace hi5
#endif
