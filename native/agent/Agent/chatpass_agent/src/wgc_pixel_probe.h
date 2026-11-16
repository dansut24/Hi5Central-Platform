#pragma once
#ifdef _WIN32
// Windows 2026 SDK's C++17 WinRT projection requires this header-scoped
// compatibility shim. No async coroutine API is used by this diagnostic.
#ifndef _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
#define _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
#endif
#include "wgc_user_probe.h"
#include "wgc_pixel_probe_policy.h"
#include <cstring>
#include <vector>

// Stage 2L is an explicit, short-lived, local-only capture experiment.
// The existing Stage 2K arrival probe and the live WebRTC/GDI service are
// untouched. It NEVER writes screenshots, sends pixels or streams video.
namespace hi5 {
struct WgcPixelStats {
    std::mutex mutex;
    unsigned frames = 0;
    unsigned long long readbackUsSum = 0;
    unsigned long long readbackUsMax = 0;
    unsigned width = 0;
    unsigned height = 0;
    unsigned long long sampledDigest = 1469598103934665603ull;
    std::atomic<unsigned> failure{0};
    std::atomic<bool> stopping{false};
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
    std::vector<std::uint8_t> privateBgraFrame;
};
inline int RunInteractiveWgcPixelChild() {
    const bool system = DxgiProbeIsSystem();
    DWORD session = 0xffffffffu;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) return 102;
    const DWORD console = WTSGetActiveConsoleSessionId();
    if (system) return 101;
    if (console == 0xffffffffu || session != console) return 102;
    const bool threadDefault = DxgiProbeObjectName(GetThreadDesktop(
        GetCurrentThreadId())) == L"Default";
    const bool stationDefault = DxgiProbeObjectName(
        GetProcessWindowStation()) == L"WinSta0";
    if (!threadDefault) return 103;
    if (!stationDefault) return 104;
    HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    const bool inputDefault = input && DxgiProbeObjectName(input) == L"Default";
    if (input) CloseDesktop(input);
    if (!CanAttemptWgcMonitorProbe(system, session == console, threadDefault,
                                   stationDefault, inputDefault)) return 105;
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        using namespace winrt::Windows::Graphics::Capture;
        using namespace winrt::Windows::Graphics::DirectX;
        using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
        if (!GraphicsCaptureSession::IsSupported()) return 301;

        const HMONITOR monitor = MonitorFromPoint(
            POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
        if (!monitor) return 302;
        GraphicsCaptureItem item{nullptr};
        try {
            auto factory = winrt::get_activation_factory<
                GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
            winrt::check_hresult(factory->CreateForMonitor(
                monitor, winrt::guid_of<GraphicsCaptureItem>(),
                winrt::put_abi(item)));
        } catch (winrt::hresult_error const& e) {
            if (e.code().value == static_cast<int32_t>(0x80070005u))
                return static_cast<int>(0x80070005u);
            return 303;
        }

        Microsoft::WRL::ComPtr<ID3D11Device> d3d;
        Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
        const D3D_FEATURE_LEVEL feature = D3D_FEATURE_LEVEL_11_0;
        HRESULT hr = D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, &feature, 1,
            D3D11_SDK_VERSION, &d3d, nullptr, &context);
        if (FAILED(hr)) return 304;
        Microsoft::WRL::ComPtr<IDXGIDevice> dxgi;
        if (FAILED(d3d.As(&dxgi))) return 304;
        winrt::com_ptr<IInspectable> inspectable;
        hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), inspectable.put());
        if (FAILED(hr)) return 305;
        auto winDevice = inspectable.as<IDirect3DDevice>();

        Direct3D11CaptureFramePool pool{nullptr};
        try {
            pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                winDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2, item.Size());
        } catch (winrt::hresult_error const&) { return 306; }
        GraphicsCaptureSession capture{nullptr};
        try { capture = pool.CreateCaptureSession(item); }
        catch (winrt::hresult_error const&) { return 307; }

        auto stats = std::make_shared<WgcPixelStats>();
        auto token = pool.FrameArrived(
            [stats, d3d, context](auto const& sender, auto const&) {
            if (stats->stopping.load()) return;
            try {
                auto frame = sender.TryGetNextFrame();
                if (!frame) return;
                auto surface = frame.Surface();
                auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
                winrt::check_hresult(access->GetInterface(
                    __uuidof(ID3D11Texture2D),
                    reinterpret_cast<void**>(texture.GetAddressOf())));
                if (!texture) { stats->failure.store(313); return; }

                D3D11_TEXTURE2D_DESC desc{};
                texture->GetDesc(&desc);
                if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
                    desc.SampleDesc.Count != 1 ||
                    !WgcPixelDimensionsAllowed(desc.Width, desc.Height,
                                              desc.Width * 4u)) {
                    stats->failure.store(311);
                    return;
                }
                std::lock_guard<std::mutex> guard(stats->mutex);
                if (stats->stopping.load() || stats->frames >= 200) return;
                if (!stats->staging || stats->width != desc.Width ||
                    stats->height != desc.Height) {
                    D3D11_TEXTURE2D_DESC cpu = desc;
                    cpu.Usage = D3D11_USAGE_STAGING;
                    cpu.BindFlags = 0;
                    cpu.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                    cpu.MiscFlags = 0;
                    stats->staging.Reset();
                    if (FAILED(d3d->CreateTexture2D(
                            &cpu, nullptr, stats->staging.GetAddressOf()))) {
                        stats->failure.store(310);
                        return;
                    }
                    stats->width = desc.Width;
                    stats->height = desc.Height;
                    stats->privateBgraFrame.resize(
                        static_cast<size_t>(desc.Width) * desc.Height * 4u);
                }
                auto start = std::chrono::steady_clock::now();
                context->CopyResource(stats->staging.Get(), texture.Get());
                D3D11_MAPPED_SUBRESOURCE mapped{};
                const HRESULT mapHr = context->Map(stats->staging.Get(), 0,
                                                  D3D11_MAP_READ, 0, &mapped);
                if (FAILED(mapHr)) {
                    stats->failure.store(310);
                    return;
                }
                const size_t rowBytes = static_cast<size_t>(desc.Width) * 4u;
                if (!WgcPixelDimensionsAllowed(desc.Width, desc.Height,
                                                mapped.RowPitch)) {
                    context->Unmap(stats->staging.Get(), 0);
                    stats->failure.store(311);
                    return;
                }
                for (unsigned y = 0; y < desc.Height; ++y) {
                    std::memcpy(stats->privateBgraFrame.data() + y * rowBytes,
                        static_cast<const std::uint8_t*>(mapped.pData) +
                            static_cast<size_t>(y) * mapped.RowPitch, rowBytes);
                }
                context->Unmap(stats->staging.Get(), 0);
                const auto elapsed = std::chrono::duration_cast<
                    std::chrono::microseconds>(
                    std::chrono::steady_clock::now() - start).count();

                // Read back every row; sample a small portion only to verify
                // the CPU frame buffer is accessible. Never log the bytes.
                const size_t n = stats->privateBgraFrame.size();
                for (size_t p = 0; p < n; p += std::max<size_t>(1, n / 256)) {
                    stats->sampledDigest ^=
                        static_cast<unsigned long long>(
                            stats->privateBgraFrame[p]);
                    stats->sampledDigest *= 1099511628211ull;
                }
                ++stats->frames;
                stats->readbackUsSum += static_cast<unsigned long long>(
                    std::max<long long>(0, elapsed));
                stats->readbackUsMax = std::max(
                    stats->readbackUsMax,
                    static_cast<unsigned long long>(
                        std::max<long long>(0, elapsed)));
            } catch (...) { stats->failure.store(312); }
        });

        try { capture.StartCapture(); }
        catch (winrt::hresult_error const& e) {
            pool.FrameArrived(token);
            capture.Close();
            pool.Close();
            if (e.code().value == static_cast<int32_t>(0x80070005u))
                return static_cast<int>(0x80070005u);
            return 308;
        }
        // An animated desktop should produce events. Idle WGC can generate
        // one frame only; never treat idle-event rate as maximum capture FPS.
        std::this_thread::sleep_for(std::chrono::milliseconds(3200));
        stats->stopping.store(true);
        pool.FrameArrived(token);
        capture.Close();
        pool.Close();

        std::lock_guard<std::mutex> guard(stats->mutex);
        if (!stats->frames) {
            return static_cast<int>(stats->failure.load()
                                    ? stats->failure.load() : 309u);
        }
        if (stats->failure.load()) return static_cast<int>(stats->failure.load());
        // Transmit metrics via child exit status only; no IPC pixel payload.
        return static_cast<int>(PackWgcPixelFrames(
            stats->frames,
            static_cast<unsigned>((stats->readbackUsSum / stats->frames + 500u)
                                  / 1000u),
            static_cast<unsigned>((stats->readbackUsMax + 500u) / 1000u)));
    } catch (winrt::hresult_error const& e) {
        if (e.code().value == static_cast<int32_t>(0x80070005u))
            return static_cast<int>(0x80070005u);
        return 312;
    } catch (...) { return 312; }
}

inline int RunInteractiveWgcPixelLauncher() {
    // Privileged launch action is explicit and NEVER attached to service
    // startup, video session negotiation or secure desktop transitions.
    const bool system = DxgiProbeIsSystem();
    const DWORD console = WTSGetActiveConsoleSessionId();
    if (!CanLaunchInteractiveDxgiProbe(system, console != 0xffffffffu)) {
        std::cout << "HI5_WGC_PIXEL_PROBE status=skipped reason="
                  << (system ? "no_active_console" : "system_required") << "\n";
        return 2;
    }
    wchar_t path[MAX_PATH]{};
    const DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (!len || len >= MAX_PATH) return 3;
    const int bytes = WideCharToMultiByte(
        CP_UTF8, 0, path, -1, nullptr, 0, nullptr, nullptr);
    if (bytes <= 1) return 3;
    std::string exe(static_cast<size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, 0, path, -1, exe.data(), bytes,
                           nullptr, nullptr) <= 1) return 3;
    exe.resize(static_cast<size_t>(bytes - 1));

    HANDLE child = LaunchInInteractiveSession(
        exe, "--mode wgc-pixel-probe-child");
    if (!child) {
        std::cout << "HI5_WGC_PIXEL_PROBE status=error "
                     "reason=interactive_user_launch_failed\n";
        return 4;
    }
    const DWORD wait = WaitForSingleObject(child, 12000);
    if (wait != WAIT_OBJECT_0) {
        TerminateProcess(child, 0x7e0001ffu);
        WaitForSingleObject(child, 1000);
        CloseHandle(child);
        std::cout << "HI5_WGC_PIXEL_PROBE status=error "
                     "reason=timeout_or_wait_failed\n";
        return 5;
    }
    DWORD code = 0xffffffffu;
    if (!GetExitCodeProcess(child, &code)) {
        CloseHandle(child);
        return 6;
    }
    CloseHandle(child);
    MONITORINFO monitorInfo{};
    monitorInfo.cbSize = sizeof(monitorInfo);
    const HMONITOR monitor = MonitorFromPoint(
        POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    const bool monitorOk = monitor && GetMonitorInfoW(monitor, &monitorInfo);
    const int width = monitorOk ?
        monitorInfo.rcMonitor.right - monitorInfo.rcMonitor.left : 0;
    const int height = monitorOk ?
        monitorInfo.rcMonitor.bottom - monitorInfo.rcMonitor.top : 0;
    const bool success = WgcPixelHasFrames(code);
    const unsigned frames = success ? WgcPixelFrames(code) : 0u;
    std::cout << "HI5_WGC_PIXEL_PROBE status=completed"
              << " result=" << (success ? "cpu_pixels_copied" :
                                               WgcPixelFailure(code))
              << " child_exit_hex=0x" << std::hex << std::uppercase << code
              << std::dec
              << " frames_delivered_to_private_cpu_sink=" << frames
              << " monitor_width=" << width
              << " monitor_height=" << height
              << " avg_readback_ms=" << (success ?
                  WgcPixelAverageReadbackMs(code) : 0u)
              << " max_readback_ms=" << (success ?
                  WgcPixelMaximumReadbackMs(code) : 0u)
              << " observed_event_fps_x10=" << (frames * 10000u / 3200u)
              << " sample_window_ms=3200"
              << " pixel_data_logged=0"
              << " image_files_written=0"
              << " transmitted_frames=0"
              << " gdi_live_fallback_preserved=1"
              << " secure_desktop_unchanged=1\n";
    return 0;
}
} // namespace hi5
#endif
