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
$before='    static void compositeCursorBgra(int originX, int originY, int width, int height,'
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
$before=@'
        HGDIOBJ old = SelectObject(memDC, bmp);
        SetStretchBltMode(memDC, HALFTONE);

        StretchBlt(
            memDC,
            0, 0, dstW, dstH,
            screenDC,
            x, y, srcW, srcH,
            SRCCOPY | CAPTUREBLT
        );

        strideOut = dstW * 4;
        bgraOut.resize(static_cast<size_t>(strideOut) * dstH);
        std::memcpy(bgraOut.data(), bits, bgraOut.size());
        compositeCursorBgra(x, y, dstW, dstH, bgraOut, strideOut);
'@
$after=@'
        HGDIOBJ old = SelectObject(memDC, bmp);
        // Keep legacy HALFTONE unchanged for normal capture and previews.
        // Low-latency direct-1080 canary uses COLORONCOLOR to avoid the
        // expensive high-quality GDI resampling kernel on every frame.
        SetStretchBltMode(memDC, directGdi ? COLORONCOLOR : HALFTONE);

        const BOOL blitOk = StretchBlt(
            memDC,
            0, 0, dstW, dstH,
            screenDC,
            x, y, srcW, srcH,
            SRCCOPY | CAPTUREBLT
        );
        if (!blitOk) {
            SelectObject(memDC, old);
            DeleteObject(bmp);
            DeleteDC(memDC);
            ReleaseDC(nullptr, screenDC);
            return false;
        }
        if(directGdi)
            GdiDirectDrawScaledCursor(memDC,x,y,srcW,srcH,dstW,dstH);
        strideOut = dstW * 4;
        bgraOut.resize(static_cast<size_t>(strideOut) * dstH);
        std::memcpy(bgraOut.data(), bits, bgraOut.size());
        if(!directGdi)
            compositeCursorBgra(x, y, dstW, dstH, bgraOut, strideOut);
'@
$screen=Replace-Once $screen $before $after 'direct scaled BitBlt, inline cursor, fall back on failure'
$before=@'
        std::vector<uint8_t> bgra;
        int stride = 0;
        if (!captureRectBgraGdi(d.x, d.y, d.width, d.height, d.width, d.height, bgra, stride)) {
            result.frame = lastFrame;
            result.hasFrame = !lastFrame.y.empty();
            result.frameId = frameId;
            return result;
        }

        I420Frame out;
        bgraToI420(bgra.data(), stride, d.width, d.height, out);
'@
$after=@'
        // Default-off 530 feature is restricted to the normal interactive
        // primary monitor. All-monitors and secure/UAC capture stay native.
        const bool directEligible=hi5::GdiDirectEligible(
            hi5::EnabledProcessOrMachineCanary("HI5_GDI_DIRECT_1080_CANARY"),
            GdiDirectNormalUserDesktop(),currentIndex,false) &&
            d.primary;
        const auto target=hi5::GdiDirectTarget1080(
            d.width,d.height,directEligible);
        std::vector<uint8_t> bgra;
        int stride=0;
        bool captured=captureRectBgraGdi(d.x,d.y,d.width,d.height,
            target.width,target.height,bgra,stride,directEligible);
        int outWidth=target.width,outHeight=target.height;
        if(!captured && directEligible){
            // Recover immediately in the same frame without requiring an
            // RMM reconnect or changing codec, stream or user permissions.
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
        I420Frame out;
        bgraToI420(bgra.data(),stride,outWidth,outHeight,out);
'@
# Occurs once in captureAll and once in captureCurrent. Modify only second.
$count=($screen.Split([string[]]@($before),[System.StringSplitOptions]::None).Count-1)
if($count -ne 2){throw "Expected native GDI capture in exactly two paths, found $count"}
$first=$screen.IndexOf($before)
$second=$screen.IndexOf($before,$first+$before.Length)
$screen=$screen.Substring(0,$second)+$after+$screen.Substring($second+$before.Length)
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
                    FrameCaptureResult captured = source.nextFrameEx();
'@ @'
                    const auto directStart=std::chrono::steady_clock::now();
                    FrameCaptureResult captured = source.nextFrameEx();
                    if(direct1080Requested){
                        const auto elapsed=std::chrono::duration_cast<
                            std::chrono::microseconds>(
                            std::chrono::steady_clock::now()-directStart).count();
                        const auto us=static_cast<std::uint64_t>(
                            std::max<std::int64_t>(0,elapsed));
                        ++directCaptureCount;
                        directCaptureUsSum+=us;
                        directCaptureUsMax=std::max(directCaptureUsMax,us);
                        if(captured.hasFrame){
                            directVideoW=captured.frame.width;
                            directVideoH=captured.frame.height;
                        }
                    }
'@ 'GDI capture timer'
$stream=Replace-Once $stream @'
            if (currentTime >= nextStatsAt) {
                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +
'@ @'
            if (currentTime >= nextStatsAt) {
                if(direct1080Requested && directCaptureCount){
                    const auto sourceGeometry=source.currentDisplayInfo();
                    const double elapsedSeconds=std::max(0.001,
                        std::chrono::duration<double>(
                            currentTime-directWindowAt).count());
                    LogInfo("[gdi-direct] session="+args.sessionId+
                        " native="+std::to_string(sourceGeometry.width)+"x"+
                            std::to_string(sourceGeometry.height)+
                        " output="+std::to_string(directVideoW)+"x"+
                            std::to_string(directVideoH)+
                        " capture_samples="+std::to_string(directCaptureCount)+
                        " actual_capture_fps="+std::to_string(
                            directCaptureCount/elapsedSeconds)+
                        " avg_capture_ms="+std::to_string(
                            static_cast<double>(directCaptureUsSum)/
                            (1000.0*directCaptureCount))+
                        " max_capture_ms="+std::to_string(
                            static_cast<double>(directCaptureUsMax)/1000.0)+
                        " requested_fps="+std::to_string(requestedMaxFps)+
                        " target_fps="+std::to_string(lastTargetFps)+
                        " gdi_software_only=1");
                    directCaptureCount=0;
                    directCaptureUsSum=0;
                    directCaptureUsMax=0;
                    directWindowAt=currentTime;
                }
                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +
'@ 'GDI actual capture FPS and latency log'
foreach($marker in @('HI5_GDI_DIRECT_1080_CANARY','[gdi-direct]','actual_capture_fps=','avg_capture_ms=','isSecureHelper')){
    if(-not $stream.Contains($marker)){throw ('GDI streamer telemetry missing '+$marker)}
}
[IO.File]::WriteAllText((Resolve-Path $path).Path,$stream,(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'GDI 530 5s actual capture FPS, native/output dimensions and capture latency telemetry PASS'
