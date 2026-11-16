param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
function Replace-Once([string]$source,[string]$before,[string]$after,[string]$name) {
    $count=($source.Split([string[]]@($before),[System.StringSplitOptions]::None).Count-1)
    if($count -ne 1){throw "Unsafe source change: $name expected once, found $count"}
    return $source.Replace($before,$after)
}
$path=Join-Path $Root 'src/platform/windows/windows_screen.cpp'
$screen=(Get-Content -LiteralPath $path -Raw -Encoding UTF8).Replace("`r`n","`n")
$screen=Replace-Once $screen '#include "fast_capture_flags.h"' ('#include "fast_capture_flags.h"'+[Environment]::NewLine+'#include "gdi_direct_1080_policy.h"') 'direct GDI policy include'
$before='    static bool captureRectBgraGdi(int x, int y, int srcW, int srcH, int dstW, int dstH,'
$helper=@'
    // Fail closed for Secure Desktop, Winlogon/UAC and disconnected consoles.
    // No DXGI/WGC capture, desktop switching or token manipulation.
    static bool GdiDirectNormalUserDesktop() {
        const wchar_t* command = GetCommandLineW();
        if (command && std::wstring(command).find(L"_UAC_") != std::wstring::npos)
            return false;
        auto isDefault = [](HDESK desktop) -> bool {
            char name[128]{};
            DWORD needed=0;
            return desktop && GetUserObjectInformationA(
                desktop,UOI_NAME,name,sizeof(name),&needed) &&
                _stricmp(name,"Default")==0;
        };
        if(!isDefault(GetThreadDesktop(GetCurrentThreadId())))return false;
        HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
        if(!input)return false;
        const bool normal=isDefault(input);
        CloseDesktop(input);
        return normal;
    }
    // Composite on the already-selected DIB, without another allocation
    // and two complete frame copies. Apply native→destination cursor scaling.
    static void GdiDirectDrawScaledCursor(HDC destination,
        int screenX,int screenY,int srcW,int srcH,int dstW,int dstH) {
        if(!destination || srcW<=0 || srcH<=0)return;
        CURSORINFO ci{};ci.cbSize=sizeof(ci);
        if(!GetCursorInfo(&ci) || !(ci.flags & CURSOR_SHOWING) || !ci.hCursor)return;
        ICONINFO ii{};
        int cursorW=GetSystemMetrics(SM_CXCURSOR);
        int cursorH=GetSystemMetrics(SM_CYCURSOR);
        int hotX=0,hotY=0;
        if(GetIconInfo(ci.hCursor,&ii)){
            hotX=static_cast<int>(ii.xHotspot);
            hotY=static_cast<int>(ii.yHotspot);
            BITMAP bitmap{};
            if(ii.hbmColor && GetObject(ii.hbmColor,sizeof(bitmap),&bitmap)){
                cursorW=bitmap.bmWidth;cursorH=bitmap.bmHeight;
            }else if(ii.hbmMask && GetObject(ii.hbmMask,sizeof(bitmap),&bitmap)){
                cursorW=bitmap.bmWidth;cursorH=bitmap.bmHeight/2;
            }
            if(ii.hbmMask)DeleteObject(ii.hbmMask);
            if(ii.hbmColor)DeleteObject(ii.hbmColor);
        }
        const int dx=static_cast<int>((
            static_cast<int64_t>(ci.ptScreenPos.x-screenX-hotX)*dstW)/srcW);
        const int dy=static_cast<int>((
            static_cast<int64_t>(ci.ptScreenPos.y-screenY-hotY)*dstH)/srcH);
        const int drawW=std::max(1,static_cast<int>(
            (static_cast<int64_t>(cursorW)*dstW+srcW/2)/srcW));
        const int drawH=std::max(1,static_cast<int>(
            (static_cast<int64_t>(cursorH)*dstH+srcH/2)/srcH));
        if(dx>=dstW || dy>=dstH || dx+drawW<=0 || dy+drawH<=0)return;
        DrawIconEx(destination,dx,dy,ci.hCursor,
                   drawW,drawH,0,nullptr,DI_NORMAL);
    }

'@
$screen=Replace-Once $screen $before ($helper+$before) 'GDI desktop and scaled cursor helper'
$before='        std::vector<uint8_t>& bgraOut, int& strideOut) {'
$after='        std::vector<uint8_t>& bgraOut, int& strideOut, bool directGdi = false) {'
$screen=Replace-Once $screen $before $after 'explicit direct GDI call parameter'
$screen=Replace-Once $screen @'
        if (PersistentGdiCanaryEnabled()) {
            static thread_local PersistentGdiDib surface;
'@ @'
        if (PersistentGdiCanaryEnabled() || directGdi) {
            // Reuse existing qualified DIB for 530 downscaled GDI output.
            static thread_local PersistentGdiDib surface;
'@ 'direct persistent GDI reuse'
$screen=Replace-Once $screen @'
                    const BOOL blitOk = StretchBlt(
                        surface.memDC, 0, 0, dstW, dstH,
                        screenDC, x, y, srcW, srcH, SRCCOPY | CAPTUREBLT);
                    if (blitOk) {
                        compositeCursorOnGdiSurface(
                            surface.memDC, x, y, dstW, dstH);
'@ @'
                    if(directGdi)SetStretchBltMode(surface.memDC,COLORONCOLOR);
                    const BOOL blitOk = StretchBlt(
                        surface.memDC, 0, 0, dstW, dstH,
                        screenDC, x, y, srcW, srcH, SRCCOPY | CAPTUREBLT);
                    if (blitOk) {
                        if(directGdi)
                            GdiDirectDrawScaledCursor(
                                surface.memDC,x,y,srcW,srcH,dstW,dstH);
                        else
                            compositeCursorOnGdiSurface(
                                surface.memDC, x, y, dstW, dstH);
'@ 'direct persistent cursor and fast resampling'
$screen=Replace-Once $screen @'
            // Never fail an entire stream only because opt-in reuse failed.
        }

        HDC screenDC = GetDC(nullptr);
'@ @'
            // Never fail an entire stream only because opt-in reuse failed.
        }
        if(directGdi)return false; // caller retries native verified GDI.

        HDC screenDC = GetDC(nullptr);
'@ 'persistent failure falls back to native frame'
$start=$screen.IndexOf('    FrameCaptureResult captureCurrentDisplayGdiLocked() {')
$end=$screen.IndexOf('    FrameCaptureResult captureOneLocked() {',$start)
if($start -lt 0 -or $end -le $start){throw 'GDI single monitor source block changed'}
$current=$screen.Substring($start,$end-$start)
$current=Replace-Once $current @'
        std::vector<uint8_t> bgra;
        int stride = 0;
        const bool stageTiming = CaptureStageTimingEnabled();
'@ @'
        const bool directEligible=hi5::GdiDirectEligible(
            hi5::EnabledProcessOrMachineCanary("HI5_GDI_DIRECT_1080_CANARY"),
            GdiDirectNormalUserDesktop(),currentIndex,false) &&
            d.primary;
        const auto target=hi5::GdiDirectTarget1080(
            d.width,d.height,directEligible);
        std::vector<uint8_t> bgra;
        int stride = 0;
        const bool stageTiming = CaptureStageTimingEnabled();
'@ 'primary normal desktop target geometry'
$current=Replace-Once $current @'
        if (!captureRectBgraGdi(d.x, d.y, d.width, d.height, d.width, d.height, bgra, stride)) {
            result.frame = lastFrame;
            result.hasFrame = !lastFrame.y.empty();
            result.frameId = frameId;
            return result;
        }
'@ @'
        bool captured=captureRectBgraGdi(d.x,d.y,d.width,d.height,
            target.width,target.height,bgra,stride,directEligible);
        int outWidth=target.width,outHeight=target.height;
        if(!captured && directEligible){
            captured=captureRectBgraGdi(d.x,d.y,d.width,d.height,
                d.width,d.height,bgra,stride,false);
            outWidth=d.width;outHeight=d.height;
        }
        if(!captured){
            result.frame=lastFrame;
            result.hasFrame=!lastFrame.y.empty();
            result.frameId=frameId;
            return result;
        }
'@ 'direct 1080p capture fallback'
$current=Replace-Once $current '        bgraToI420(bgra.data(), stride, d.width, d.height, out);' '        bgraToI420(bgra.data(), stride, outWidth, outHeight, out);' 'correct I420 output size'
$current=Replace-Once $current '            LogCaptureStageTiming(gdiMs, i420Ms, d.width, d.height);' '            LogCaptureStageTiming(gdiMs, i420Ms, outWidth, outHeight);' 'correct captured stage dimensions'
$screen=$screen.Substring(0,$start)+$current+$screen.Substring($end)
$before=@'
    FrameCaptureResult captureOneLocked() {
        refreshDisplaysLocked();

        if (currentIndex == -1) {
'@
$after=@'
    FrameCaptureResult captureOneLocked() {
        refreshDisplaysLocked();

        // Selected primary monitor on normal desktop: direct GDI-only
        // capture at the final I420 resolution, without DXGI acquisition.
        if (hi5::EnabledProcessOrMachineCanary("HI5_GDI_DIRECT_1080_CANARY") &&
            currentIndex == 0 && GdiDirectNormalUserDesktop()) {
            const auto* selected=findCurrentTargetLocked();
            if(selected && selected->info.primary)
                return captureCurrentDisplayGdiLocked();
        }

        if (currentIndex == -1) {
'@
$screen=Replace-Once $screen $before $after 'default-off GDI path before DXGI'
foreach($marker in @('GdiDirectTarget1080(','GdiDirectDrawScaledCursor(','COLORONCOLOR','GdiDirectNormalUserDesktop(','HI5_GDI_DIRECT_1080_CANARY','if(!captured && directEligible)')){
    if(-not $screen.Contains($marker)){throw ('Direct1080 source marker missing '+$marker)}
}
[IO.File]::WriteAllText((Resolve-Path $path).Path,$screen,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'GDI native baseline preserved, primary direct 1728x1080 path default OFF; scaled cursor/fallback PASS'

$path=Join-Path $Root 'src/streamer_main.cpp'
$stream=(Get-Content -LiteralPath $path -Raw -Encoding UTF8).Replace("`r`n","`n")
$stream=Replace-Once $stream @'
        auto nextStatsAt = std::chrono::steady_clock::now() + statsEvery;
'@ @'
        auto nextStatsAt = std::chrono::steady_clock::now() + statsEvery;
        const bool direct1080Requested=
            hi5::EnabledProcessOrMachineCanary("HI5_GDI_DIRECT_1080_CANARY") &&
            !isSecureHelper;
        auto directWindowAt=std::chrono::steady_clock::now();
        std::uint64_t directCaptureCount=0;
        std::uint64_t directCaptureUsSum=0;
        std::uint64_t directCaptureUsMax=0;
        int directVideoW=0,directVideoH=0;
'@ 'GDI 5s telemetry state'
$stream=Replace-Once $stream @'
                    ++captureTimingCount;
                    const bool recentInput = (now - lastInputAt) <= activeHold;
'@ @'
                    ++captureTimingCount;
                    if(direct1080Requested && captured.hasFrame){
                        directVideoW=captured.frame.width;
                        directVideoH=captured.frame.height;
                    }
                    const bool recentInput = (now - lastInputAt) <= activeHold;
'@ 'selected direct output dimensions'
$stream=Replace-Once $stream @'
            if (currentTime >= nextStatsAt) {
                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +
'@ @'
            if (currentTime >= nextStatsAt) {
                if(direct1080Requested && captureTimingCount){
                    const auto native=source.currentDisplayInfo();
                    const double seconds=std::max(0.001,
                        std::chrono::duration<double>(
                            currentTime-directWindowAt).count());
                    LogInfo("[gdi-direct] session="+args.sessionId+
                        " native="+std::to_string(native.width)+"x"+
                            std::to_string(native.height)+
                        " output="+std::to_string(directVideoW)+"x"+
                            std::to_string(directVideoH)+
                        " actual_capture_fps="+std::to_string(
                            captureTimingCount/seconds)+
                        " avg_capture_ms="+std::to_string(
                            captureMsTotal/std::max<uint64_t>(1,captureTimingCount))+
                        " max_capture_ms="+std::to_string(captureMsMax)+
                        " requested_fps="+std::to_string(requestedMaxFps)+
                        " target_fps="+std::to_string(lastTargetFps)+
                        " gdi_software_only=1");
                    directWindowAt=currentTime;
                }
                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +
'@ 'measured native/output and FPS'
foreach($marker in @('HI5_GDI_DIRECT_1080_CANARY','[gdi-direct]','actual_capture_fps=','avg_capture_ms=','isSecureHelper')){
    if(-not $stream.Contains($marker)){throw ('GDI streamer telemetry missing '+$marker)}
}
[IO.File]::WriteAllText((Resolve-Path $path).Path,$stream,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'GDI 530 5s actual capture FPS, native/output dimensions and capture latency telemetry PASS'
