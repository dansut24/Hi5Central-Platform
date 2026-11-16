#pragma once
#ifdef _WIN32
// Windows Graphics Capture is an opt-in interactive-user capture backend.
// Unlike the diagnostic modes, these frames are supplied to the existing
// authenticated Agent session. It does not bypass the Windows capture border,
// alter UAC/secure-desktop policy, or replace the qualified GDI fallback.
#include "wgc_user_probe.h"
#include "fast_capture_flags.h"
#include "wgc_live_policy.h"
#include "bgra_to_i420_fast.h"
#include "frame_source.h"
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace hi5 {
struct WgcLiveMetrics {
    uint64_t arrived=0;
    uint64_t converted=0;
    uint64_t copiesUs=0;
    uint64_t copiesMaxUs=0;
    uint64_t failed=0;
    uint64_t delivered=0;
    uint64_t latestAgeMs=0;
};
class WgcLiveFrameSource final {
public:
    WgcLiveFrameSource() = default;
    WgcLiveFrameSource(const WgcLiveFrameSource&) = delete;
    WgcLiveFrameSource& operator=(const WgcLiveFrameSource&) = delete;
    ~WgcLiveFrameSource() { Stop(); }

    bool Start(int displayIndex,std::string& reason) noexcept {
        Stop();
        reason.clear();
        if (!EnabledProcessOrMachineCanary("HI5_WGC_LIVE_CANARY")) {
            reason="flag_disabled";return false;
        }
        // This first canary is PRIMARY-monitor and normal-desktop only.
        if(displayIndex!=0){reason="primary_monitor_only";return false;}
        if(DxgiProbeIsSystem()){reason="system_capture_prohibited";return false;}
        DWORD sessionId=0xffffffffu;
        if(!ProcessIdToSessionId(GetCurrentProcessId(),&sessionId) ||
           sessionId!=WTSGetActiveConsoleSessionId()){
            reason="interactive_console_required";return false;
        }
        const bool defaultDesktop=DxgiProbeObjectName(
            GetThreadDesktop(GetCurrentThreadId()))==L"Default";
        const bool defaultStation=DxgiProbeObjectName(
            GetProcessWindowStation())==L"WinSta0";
        HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
        const bool inputDefault=input && DxgiProbeObjectName(input)==L"Default";
        if(input)CloseDesktop(input);
        if(!WgcLiveEligible(true,false,true,
                            defaultDesktop && defaultStation && inputDefault,
                            false,false,displayIndex)){
            reason="secure_or_nondefault_desktop";return false;
        }
        try {
            using namespace winrt::Windows::Graphics::Capture;
            using namespace winrt::Windows::Graphics::DirectX;
            using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            if(!GraphicsCaptureSession::IsSupported()){
                reason="wgc_unsupported";return false;
            }
            const HMONITOR monitor=MonitorFromPoint(
                POINT{0,0},MONITOR_DEFAULTTOPRIMARY);
            if(!monitor){reason="no_primary_monitor";return false;}
            GraphicsCaptureItem item{nullptr};
            auto factory=winrt::get_activation_factory<
                GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
            winrt::check_hresult(factory->CreateForMonitor(
                monitor,winrt::guid_of<GraphicsCaptureItem>(),
                winrt::put_abi(item)));
            const auto size=item.Size();
            if(size.Width<=0 || size.Height<=0 || size.Width>8192 ||
               size.Height>4320 || (size.Width & 1) || (size.Height & 1)){
                reason="unexpected_monitor_dimensions";return false;
            }
            Microsoft::WRL::ComPtr<ID3D11Device> d3d;
            Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
            const D3D_FEATURE_LEVEL level=D3D_FEATURE_LEVEL_11_0;
            winrt::check_hresult(D3D11CreateDevice(
                nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,&level,1,
                D3D11_SDK_VERSION,&d3d,nullptr,&context));
            Microsoft::WRL::ComPtr<IDXGIDevice> dxgi;
            winrt::check_hresult(d3d.As(&dxgi));
            winrt::com_ptr<IInspectable> inspectable;
            winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
                dxgi.Get(),inspectable.put()));
            auto direct3d=inspectable.as<IDirect3DDevice>();
            pool_=Direct3D11CaptureFramePool::CreateFreeThreaded(
                direct3d,DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,size);
            capture_=pool_.CreateCaptureSession(item);
            auto state=std::make_shared<State>();
            state->width=static_cast<unsigned>(size.Width);
            state->height=static_cast<unsigned>(size.Height);
            callback_=pool_.FrameArrived(
                [state,d3d,context](auto const& sender,auto const&) {
                if(state->stopping.load(std::memory_order_acquire))return;
                // FreeThreaded may dispatch from worker threads. Serialize
                // the immediate D3D context and latest-frame slot.
                try {
                    auto frame=sender.TryGetNextFrame();
                    if(!frame)return;
                    state->arrived.fetch_add(1,std::memory_order_relaxed);
                    auto surface=frame.Surface();
                    auto access=surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                    Microsoft::WRL::ComPtr<ID3D11Texture2D> tex;
                    winrt::check_hresult(access->GetInterface(
                        __uuidof(ID3D11Texture2D),
                        reinterpret_cast<void**>(tex.GetAddressOf())));
                    D3D11_TEXTURE2D_DESC desc{};
                    tex->GetDesc(&desc);
                    if(desc.Width!=state->width || desc.Height!=state->height ||
                       desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM ||
                       desc.SampleDesc.Count!=1){
                        state->failed.fetch_add(1);return;
                    }
                    std::lock_guard<std::mutex> lock(state->mutex);
                    if(state->stopping.load())return;
                    if(!state->staging){
                        D3D11_TEXTURE2D_DESC cpu=desc;
                        cpu.Usage=D3D11_USAGE_STAGING;
                        cpu.BindFlags=0;
                        cpu.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
                        cpu.MiscFlags=0;
                        if(FAILED(d3d->CreateTexture2D(
                            &cpu,nullptr,state->staging.GetAddressOf()))){
                            state->failed.fetch_add(1);return;
                        }
                    }
                    I420Frame next;
                    next.width=static_cast<int>(desc.Width);
                    next.height=static_cast<int>(desc.Height);
                    const size_t pixels=static_cast<size_t>(desc.Width)*desc.Height;
                    next.y.resize(pixels);
                    next.u.resize(pixels/4u);
                    next.v.resize(pixels/4u);
                    const auto started=std::chrono::steady_clock::now();
                    context->CopyResource(state->staging.Get(),tex.Get());
                    D3D11_MAPPED_SUBRESOURCE mapped{};
                    if(FAILED(context->Map(state->staging.Get(),0,
                                           D3D11_MAP_READ,0,&mapped))){
                        state->failed.fetch_add(1);return;
                    }
                    const bool converted=BgraToI420FastPlanes(
                        static_cast<const std::uint8_t*>(mapped.pData),
                        static_cast<int>(mapped.RowPitch),
                        static_cast<int>(desc.Width),
                        static_cast<int>(desc.Height),
                        next.y.data(),next.u.data(),next.v.data());
                    context->Unmap(state->staging.Get(),0);
                    if(!converted){state->failed.fetch_add(1);return;}
                    const auto elapsed=std::chrono::duration_cast<
                        std::chrono::microseconds>(
                        std::chrono::steady_clock::now()-started).count();
                    state->latest=std::move(next);
                    state->latestAt=std::chrono::steady_clock::now();
                    ++state->sequence;
                    ++state->converted;
                    state->copyUs+=static_cast<uint64_t>(
                        std::max<std::int64_t>(0,elapsed));
                    state->maxUs=std::max(state->maxUs,static_cast<uint64_t>(
                        std::max<std::int64_t>(0,elapsed)));
                } catch (...) {state->failed.fetch_add(1);}
            });
            state_=std::move(state);
            capture_.StartCapture();
            active_=true;
            reason="started";
            return true;
        }catch(winrt::hresult_error const& e){
            reason="winrt_hresult_"+std::to_string(
                static_cast<std::uint32_t>(e.code().value));
            Stop();
            return false;
        }catch(...){
            reason="wgc_initialisation_exception";
            Stop();
            return false;
        }
    }
    void Stop() noexcept {
        active_=false;
        if(state_)state_->stopping.store(true,std::memory_order_release);
        try{if(pool_)pool_.FrameArrived(callback_);}catch(...){}
        try{if(capture_)capture_.Close();}catch(...){}
        try{if(pool_)pool_.Close();}catch(...){}
        capture_=nullptr;
        pool_=nullptr;
        state_.reset();
        delivered_=0;
    }
    bool Active() const noexcept {return active_ && static_cast<bool>(state_);}
    // Returns a new frame only, never queues stale frames.
    bool Take(FrameCaptureResult& result) {
        auto s=state_;
        if(!s||s->stopping.load())return false;
        std::lock_guard<std::mutex> lock(s->mutex);
        if(s->sequence==0 || s->sequence==delivered_)return false;
        result.frame=s->latest;
        result.hasFrame=true;
        result.changed=true;
        result.cursorOnly=false;
        result.frameId=s->sequence;
        delivered_=s->sequence;
        ++s->delivered;
        return true;
    }
    std::uint64_t AgeMs() const noexcept {
        auto s=state_;
        if(!s)return UINT64_MAX;
        std::lock_guard<std::mutex> lock(s->mutex);
        if(s->sequence==0)return UINT64_MAX;
        const auto dt=std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now()-s->latestAt).count();
        return static_cast<std::uint64_t>(std::max<std::int64_t>(0,dt));
    }
    WgcLiveMetrics Metrics() const noexcept {
        WgcLiveMetrics m{};
        auto s=state_;
        if(!s)return m;
        m.arrived=s->arrived.load();
        m.failed=s->failed.load();
        std::lock_guard<std::mutex> lock(s->mutex);
        m.converted=s->converted;m.copiesUs=s->copyUs;
        m.copiesMaxUs=s->maxUs;m.delivered=s->delivered;
        if(s->sequence){
            auto dt=std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now()-s->latestAt).count();
            m.latestAgeMs=static_cast<uint64_t>(std::max<int64_t>(0,dt));
        }else m.latestAgeMs=UINT64_MAX;
        return m;
    }
private:
    struct State {
        std::mutex mutex;
        std::atomic<bool> stopping{false};
        std::atomic<std::uint64_t> arrived{0};
        std::atomic<std::uint64_t> failed{0};
        unsigned width=0,height=0;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
        I420Frame latest;
        std::chrono::steady_clock::time_point latestAt{};
        std::uint64_t sequence=0,converted=0,copyUs=0,maxUs=0,delivered=0;
    };
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession capture_{nullptr};
    winrt::event_token callback_{};
    std::shared_ptr<State> state_;
    std::uint64_t delivered_=0;
    bool active_=false;
};
} // namespace hi5
#endif
