// Copyright (c) 2026 Hi5Central. Proprietary Hi5Stream v0.15.4 canary.
// Adapted from isolated v0.15.4 WGC tested callback; no codec or transport here.
// Compiled only in HI5_ENABLE_WGC154_CANARY builds.
// Visual Studio 2026's C++17 C++/WinRT path uses <experimental/coroutine>.
// Microsoft STL1011 requires explicit acknowledgement for this legacy ABI.
// Keep the WGC translation unit C++17, matching the qualified 1.0.530 agent;
// switching it to C++20 causes LNK2038 (_COROUTINE_ABI 2 vs 1).
#ifndef _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
#define _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
#endif
#include "wgc154_capture.h"
#include "winrt_interop_minimal.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <windows.graphics.directx.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <libyuv/convert.h>
#include <libyuv/scale.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;
namespace WGC=winrt::Windows::Graphics::Capture;
namespace WGD=winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock=std::chrono::steady_clock;
namespace {
struct OwnedFrame {
    std::vector<uint8_t> bgra;
    uint32_t width=0,height=0,stride=0;
    size_t byte_length=0;
    uint64_t capture_timestamp_us=0;
};
struct StageFailure:std::runtime_error{
    std::string stage;
    long code;
    StageFailure(std::string step,long h,std::string detail)
    :std::runtime_error(detail),stage(std::move(step)),code(h){}
};
std::string hresult_text(long hr) {
    std::ostringstream s;
    s<<"0x"<<std::uppercase<<std::hex<<std::setw(8)
     <<std::setfill('0')<<static_cast<uint32_t>(hr);
    return s.str();
}
uint64_t us(Clock::time_point a,Clock::time_point b){
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(b-a).count());
}
std::string json_quoted(const std::string& s){
    std::ostringstream out;out<<"\"";
    for(unsigned char c:s){
        if(c=='\"' || c=='\\')out<<'\\'<<char(c);
        else if(c=='\n')out<<"\\n";
        else if(c=='\r')out<<"\\r";
        else if(c<32)out<<"?";
        else out<<char(c);
    }
    out<<"\"";return out.str();
}
HMONITOR primary_monitor(){
    POINT origin{0,0};
    HMONITOR m=MonitorFromPoint(origin,MONITOR_DEFAULTTOPRIMARY);
    if(!m)throw StageFailure("MonitorFromPoint",E_FAIL,"Primary monitor missing");
    return m;
}
struct FrameTiming {
    uint64_t arrival_us=0,copy_map_us=0,cpu_copy_us=0;
};
struct Shared {
    std::atomic<bool> running{true};
    std::mutex d3d_mutex;
    std::mutex frames_mutex;
    std::condition_variable ready;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11Texture2D> staging;
    UINT staging_width=0,staging_height=0;
    DXGI_FORMAT staging_format=DXGI_FORMAT_UNKNOWN;
    std::optional<OwnedFrame> latest;
    FrameTiming timing;
    uint64_t arrived=0,replaced=0,failed=0,resize_events=0;
    Clock::time_point last_callback{};
    std::vector<uint64_t> callback_intervals;
    std::vector<uint64_t> source_intervals;
    int64_t last_source_ticks=0;
    bool callback_only=false;
    uint32_t previous_width=0,previous_height=0;
    std::string error_stage,error_detail,error_code;
    bool ended=false;
    void fail(std::string stage,std::string detail,std::string code){
        std::lock_guard<std::mutex> guard(frames_mutex);
        failed++;
        error_stage=std::move(stage);error_detail=std::move(detail);
        error_code=std::move(code);ended=true;running=false;
        ready.notify_all();
    }
};
void on_frame(std::shared_ptr<Shared> const& state,
              WGC::Direct3D11CaptureFramePool const& sender) {
    if(!state->running.load())return;
    const auto began=Clock::now();
    try {
        // The free-threaded pool delivers frames on a worker thread.
        // Serialise all context use and texture recycling within this callback.
        std::lock_guard<std::mutex> d3d_lock(state->d3d_mutex);
        if(!state->running.load())return;
        auto frame=sender.TryGetNextFrame();
        if(!frame)return;
        const int64_t source_ticks=frame.SystemRelativeTime().count();
        {
            std::lock_guard<std::mutex> guard(state->frames_mutex);
            if(state->last_callback.time_since_epoch().count()!=0)
                state->callback_intervals.push_back(us(state->last_callback,began));
            state->last_callback=began;
            if(state->last_source_ticks!=0 && source_ticks>state->last_source_ticks)
                state->source_intervals.push_back(
                    uint64_t(source_ticks-state->last_source_ticks)/10u);
            if(source_ticks>0)state->last_source_ticks=source_ticks;
            if(state->callback_only) {
                state->arrived++;
                state->ready.notify_all();
                return;
            }
        }
        auto content=frame.ContentSize();
        if(content.Width<2 || content.Height<2)
            throw StageFailure("Frame.ContentSize",E_INVALIDARG,"Frame dimensions invalid");
        ComPtr<Hi5DxgiSurfaceAccess> access;
        auto* surface_unknown=reinterpret_cast<IUnknown*>(winrt::get_abi(frame.Surface()));
        winrt::check_hresult(surface_unknown->QueryInterface(
            HI5_IID_DXGI_SURFACE_ACCESS,
            reinterpret_cast<void**>(access.GetAddressOf())));
        ComPtr<ID3D11Texture2D> texture;
        winrt::check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),
                    reinterpret_cast<void**>(texture.GetAddressOf())));
        D3D11_TEXTURE2D_DESC desc{};
        texture->GetDesc(&desc);
        const UINT width=std::min(desc.Width,static_cast<UINT>(content.Width)) & ~1u;
        const UINT height=std::min(desc.Height,static_cast<UINT>(content.Height)) & ~1u;
        if(width<2 || height<2 || width>8192 || height>8192 ||
            uint64_t(width)*height*4>128ull*1024*1024 ||
            desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM ||
            desc.Width>8192 || desc.Height>8192 ||
            uint64_t(desc.Width)*desc.Height*4>128ull*1024*1024 ||
            desc.SampleDesc.Count!=1)
            throw StageFailure("Frame.Texture",E_INVALIDARG,"Unsupported WGC texture geometry/format");
        if(!state->staging || state->staging_width!=desc.Width ||
           state->staging_height!=desc.Height || state->staging_format!=desc.Format){
            state->staging.Reset();
            D3D11_TEXTURE2D_DESC cpu=desc;
            cpu.Usage=D3D11_USAGE_STAGING;
            cpu.BindFlags=0;cpu.MiscFlags=0;
            cpu.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
            cpu.MipLevels=1;cpu.ArraySize=1;cpu.SampleDesc.Count=1;
            winrt::check_hresult(state->device->CreateTexture2D(&cpu,nullptr,
                                                  state->staging.GetAddressOf()));
            state->staging_width=desc.Width;
            state->staging_height=desc.Height;
            state->staging_format=desc.Format;
        }
        state->context->CopyResource(state->staging.Get(),texture.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        winrt::check_hresult(state->context->Map(state->staging.Get(),0,
                                    D3D11_MAP_READ,0,&mapped));
        const auto mapped_at=Clock::now();
        const size_t stride=size_t(width)*4;
        const size_t row_pitch=size_t(mapped.RowPitch);
        if(!mapped.pData || row_pitch<stride){
            state->context->Unmap(state->staging.Get(),0);
            throw StageFailure("WGC.Map",E_INVALIDARG,"Invalid mapped row stride");
        }
        OwnedFrame out;
        out.width=width;out.height=height;out.stride=width*4;
        out.byte_length=stride*height;
        out.capture_timestamp_us=static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
              mapped_at.time_since_epoch()).count());
        out.bgra.resize(out.byte_length);
        const uint8_t* mapped_bytes=static_cast<const uint8_t*>(mapped.pData);
        for(UINT row=0;row<height;++row) {
            std::memcpy(out.bgra.data()+size_t(row)*stride,
                        mapped_bytes+size_t(row)*row_pitch,stride);
        }
        state->context->Unmap(state->staging.Get(),0);
        const auto copied=Clock::now();
        {
            std::lock_guard<std::mutex> guard(state->frames_mutex);
            if(state->latest)state->replaced++;
            state->latest=std::move(out);
            state->arrived++;
            if(state->previous_width && (state->previous_width!=width ||
              state->previous_height!=height))state->resize_events++;
            state->previous_width=width;state->previous_height=height;
            state->timing={us(began,mapped_at),us(began,mapped_at),us(mapped_at,copied)};
        }
        state->ready.notify_all();
    } catch(winrt::hresult_error const& e) {
        state->fail("WGC.FrameArrived",e.message().empty()?"WinRT frame error":
                    winrt::to_string(e.message()),hresult_text(e.code()));
    } catch(StageFailure const& e){
        state->fail(e.stage,e.what(),hresult_text(e.code));
    } catch(std::exception const& e){
        state->fail("WGC.FrameArrived",e.what(),hresult_text(E_FAIL));
    }
}
class WgcCapture {
public:
    bool start(std::string& error,bool callback_only,int requested_min_update_ms,
               HWND target_window){
        target_is_window_=target_window!=nullptr;
        min_update_requested_ms_=requested_min_update_ms;
        try {
            if(!WGC::GraphicsCaptureSession::IsSupported()){
                throw StageFailure("GraphicsCaptureSession.IsSupported",
                                  E_NOTIMPL,"Windows Graphics Capture unavailable");
            }
            // Never modify CaptureService or change privileges. If the user
            // session disallows capture, fail explicitly and preserve fallback.
            HMONITOR monitor=nullptr;
            if(target_window && (!IsWindow(target_window) || !IsWindowVisible(target_window)))
                throw StageFailure("CreateForWindow",E_INVALIDARG,
                                   "Animated target window invalid/invisible");
            if(!target_window) monitor=primary_monitor();
            auto activation=winrt::get_activation_factory<WGC::GraphicsCaptureItem>();
            ComPtr<Hi5CaptureItemInterop> interop;
            auto* activation_unknown=reinterpret_cast<IUnknown*>(winrt::get_abi(activation));
            winrt::check_hresult(activation_unknown->QueryInterface(
                HI5_IID_CAPTURE_ITEM_INTEROP,
                reinterpret_cast<void**>(interop.GetAddressOf())));
            if(target_window) {

                winrt::check_hresult(interop->CreateForWindow(target_window,
                    winrt::guid_of<WGC::IGraphicsCaptureItem>(),
                    winrt::put_abi(item_)));
            }else {
                winrt::check_hresult(interop->CreateForMonitor(monitor,
                    winrt::guid_of<WGC::IGraphicsCaptureItem>(),
                    winrt::put_abi(item_)));
            }

            auto size=item_.Size();
            if(size.Width<2 || size.Height<2 ||
               uint64_t(size.Width)*size.Height*4>128ull*1024*1024)
                throw StageFailure("GraphicsCaptureItem.Size",E_INVALIDARG,
                                   "Monitor geometry too large/invalid");
            state_=std::make_shared<Shared>();
            state_->callback_only=callback_only;
            D3D_FEATURE_LEVEL level{};
            auto hr=D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,
                      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                      nullptr,0,D3D11_SDK_VERSION,
                      state_->device.GetAddressOf(),&level,
                      state_->context.GetAddressOf());
            if(FAILED(hr))throw StageFailure("D3D11CreateDevice",hr,
                                             "D3D device unavailable");
            ComPtr<IDXGIDevice> dxgi;
            winrt::check_hresult(state_->device.As(&dxgi));
            winrt::com_ptr<::IInspectable> inspectable;
            winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
                dxgi.Get(),inspectable.put()));
            auto graphics=inspectable.as<WGD::IDirect3DDevice>();
            pool_=WGC::Direct3D11CaptureFramePool::CreateFreeThreaded(
                graphics,winrt::Windows::Graphics::DirectX::DirectXPixelFormat::
                             B8G8R8A8UIntNormalized,2,size);
            std::weak_ptr<Shared> weak=state_;
            handler_=pool_.FrameArrived([weak](auto const& sender,auto const&){
                if(auto s=weak.lock())on_frame(s,sender);
            });
            handler_registered_=true;
            session_=pool_.CreateCaptureSession(item_);
            // Optional WinRT v26100+ capture-session property, never required
            // for WGC on older Windows. No global OS policy or driver changes.
            if(requested_min_update_ms>=0) {
                auto session5=session_.try_as<WGC::IGraphicsCaptureSession5>();
                min_update_supported_=bool(session5);
                if(session5) {
                    try {
                        const auto interval=std::chrono::duration_cast<
                            winrt::Windows::Foundation::TimeSpan>(
                                std::chrono::milliseconds(requested_min_update_ms));
                        session5.MinUpdateInterval(interval);
                        min_update_applied_=true;
                        min_update_actual_ms_=std::chrono::duration<double,std::milli>(
                            session5.MinUpdateInterval()).count();
                    } catch(winrt::hresult_error const& ex) {
                        min_update_error_=std::string("MinUpdateInterval HRESULT ")+
                                          hresult_text(ex.code());
                    }
                }else {
                    min_update_error_="IGraphicsCaptureSession5 unavailable";
                }
            }
            // Do NOT suppress Windows capture indicators/privacy borders.

            session_.StartCapture();

            return true;
        } catch(winrt::hresult_error const& e) {
            error=std::string("WinRT start: ")+winrt::to_string(e.message())+
                   " HRESULT="+hresult_text(e.code());
        } catch(StageFailure const& e){
            error=e.stage+": "+e.what()+" HRESULT="+hresult_text(e.code);
        } catch(std::exception const& e){error=e.what();}
        stop();
        return false;
    }
    bool target_is_window()const {return target_is_window_;}
    int requested_min_update_ms()const {return min_update_requested_ms_;}
    bool min_update_supported()const {return min_update_supported_;}
    bool min_update_applied()const {return min_update_applied_;}
    double min_update_actual_ms()const {return min_update_actual_ms_;}
    std::string min_update_error()const {return min_update_error_;}
    struct Poll {
        std::vector<uint64_t> callback_intervals;
        std::vector<uint64_t> source_intervals;
        std::optional<OwnedFrame> frame;
        FrameTiming timing{};
        uint64_t arrived=0,replaced=0,failed=0,resize_events=0;

        bool stopped=false;
        std::string error,stage,code;
    };
    Poll poll(std::chrono::milliseconds wait) {
        Poll out;
        if(!state_) {out.stopped=true;out.error="WGC not started";return out;}
        std::unique_lock<std::mutex> lock(state_->frames_mutex);
        state_->ready.wait_for(lock,wait,[&]{
            return bool(state_->latest) || state_->ended;
        });
        out.frame=std::move(state_->latest);
        state_->latest.reset();
        out.arrived=state_->arrived;out.replaced=state_->replaced;
        out.failed=state_->failed;out.resize_events=state_->resize_events;
        out.timing=state_->timing;
        out.stopped=state_->ended;
        out.error=state_->error_detail;out.stage=state_->error_stage;
        out.code=state_->error_code;
        return out;
    }
    Poll snapshot() {
        Poll result;
        if(!state_) return result;
        std::lock_guard<std::mutex> guard(state_->frames_mutex);
        result.arrived=state_->arrived;
        result.replaced=state_->replaced;
        result.failed=state_->failed;
        result.resize_events=state_->resize_events;
        result.callback_intervals=state_->callback_intervals;
        result.source_intervals=state_->source_intervals;
        result.stopped=state_->ended;
        result.error=state_->error_detail;
        result.stage=state_->error_stage;
        result.code=state_->error_code;
        return result;
    }
    void stop() noexcept {

        if(state_)state_->running=false;
        try {
            if(pool_ && handler_registered_){
                pool_.FrameArrived(handler_);handler_registered_=false;
            }
            if(session_){

                session_.Close();session_=nullptr;
            }
            if(pool_){

                pool_.Close();pool_=nullptr;
            }
            item_=nullptr;
        }catch(...){}
        state_.reset();

    }
    ~WgcCapture(){stop();}
private:
    std::shared_ptr<Shared> state_;
    WGC::GraphicsCaptureItem item_{nullptr};
    WGC::GraphicsCaptureSession session_{nullptr};
    WGC::Direct3D11CaptureFramePool pool_{nullptr};
    winrt::event_token handler_{};
    bool handler_registered_=false;
    bool target_is_window_=false;
    int min_update_requested_ms_=-1;
    bool min_update_supported_=false,min_update_applied_=false;
    double min_update_actual_ms_=0;
    std::string min_update_error_;
};
} // anonymous namespace: source-matched WGC callback
namespace hi5 {
class Wgc154Capture::Impl {
public:
    WgcCapture source;
    std::vector<uint8_t> nativeI420;
    uint64_t consumed=0, empty=0;
    bool running=false;
    static constexpr int outputWidth=1280,outputHeight=800;
};
Wgc154Capture::Wgc154Capture():impl_(std::make_unique<Impl>()){}
Wgc154Capture::~Wgc154Capture(){stop();}
bool Wgc154Capture::start(std::string& error) {
    if(impl_->running)return true;
    try {
        // The service launches the streamer in the interactive session;
        // never request privileges, bypass user consent or switch desktop.
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch(winrt::hresult_error const& e) {
        error="WinRT apartment unavailable: "+hresult_text(e.code());
        return false;
    }
    impl_->running=impl_->source.start(error,false,-1,nullptr);
    return impl_->running;
}
bool Wgc154Capture::takeLatest(FrameCaptureResult& result,
                               Wgc154Metrics& metrics,
                               std::string& error,unsigned waitMs) {
    result={};
    if(!impl_->running){error="WGC154 stopped";return false;}
    const auto polled=impl_->source.poll(std::chrono::milliseconds(
        std::min(waitMs,25u)));
    metrics.sourceFrames=polled.arrived;
    metrics.oldFramesReplaced=polled.replaced;
    metrics.captureErrors=polled.failed;
    if(polled.stopped || polled.failed){
        error="WGC154 capture stopped "+polled.stage+" "+polled.code+" "+polled.error;
        return false;
    }
    if(!polled.frame){
        ++impl_->empty;
        metrics.emptyPolls=impl_->empty;
        return true;
    }
    const auto started=Clock::now();
    const OwnedFrame& input=*polled.frame;
    // This 1280x800 canary only supports the qualified Lenovo 2560x1600
    // primary monitor. Any topology/resolution change safely falls back.
    if(input.width!=2560 || input.height!=1600 ||
       input.stride<input.width*4 ||
       input.byte_length!=size_t(input.stride)*input.height){
        error="Unqualified WGC154 source dimensions/topology; fallback";
        return false;
    }
    const int w=static_cast<int>(input.width);
    const int h=static_cast<int>(input.height);
    const size_t yLength=size_t(w)*h;
    const size_t uvLength=size_t(w/2)*(h/2);
    impl_->nativeI420.resize(yLength+uvLength*2);
    uint8_t* const y=impl_->nativeI420.data();
    uint8_t* const u=y+yLength;
    uint8_t* const v=u+uvLength;
    if(libyuv::ARGBToI420(input.bgra.data(),input.stride,
                          y,w,u,w/2,v,w/2,w,h)!=0){
        error="libyuv ARGBToI420 rejected WGC frame; fallback";
        return false;
    }
    const auto converted=Clock::now();
    auto& output=result.frame;
    output.width=Impl::outputWidth;
    output.height=Impl::outputHeight;
    const size_t newY=size_t(output.width)*output.height;
    const size_t newUV=size_t(output.width/2)*(output.height/2);
    output.y.resize(newY);output.u.resize(newUV);output.v.resize(newUV);
    if(libyuv::I420Scale(y,w,u,w/2,v,w/2,w,h,
                         output.y.data(),output.width,
                         output.u.data(),output.width/2,
                         output.v.data(),output.width/2,
                         output.width,output.height,
                         libyuv::kFilterBilinear)!=0){
        error="libyuv I420Scale failed; fallback";
        return false;
    }
    const auto completed=Clock::now();
    result.hasFrame=true;
    result.changed=true;
    result.cursorOnly=false;
    result.frameId=++impl_->consumed;
    metrics.consumedFrames=impl_->consumed;
    metrics.emptyPolls=impl_->empty;
    metrics.readbackMs=polled.timing.copy_map_us/1000.0+
                       polled.timing.cpu_copy_us/1000.0;
    metrics.conversionMs=std::chrono::duration<double,std::milli>(
        converted-started).count();
    metrics.scaleMs=std::chrono::duration<double,std::milli>(
        completed-converted).count();
    const auto nowUs=std::chrono::duration_cast<std::chrono::microseconds>(
        completed.time_since_epoch()).count();
    metrics.frameAgeMs=nowUs>=static_cast<int64_t>(input.capture_timestamp_us)
        ? (nowUs-input.capture_timestamp_us)/1000.0 : 0.0;
    return true;
}
void Wgc154Capture::stop() noexcept{
    if(impl_){impl_->source.stop();impl_->running=false;}
}
} // namespace hi5
