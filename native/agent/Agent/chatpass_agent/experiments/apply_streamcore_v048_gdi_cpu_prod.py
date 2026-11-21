#!/usr/bin/env python3
"""Apply *only* v0.3.17 GDI optimisations to 537-based C++ RMM agent.
This is called as the final overlay, AFTER all qualified 530-537 CI
patches. Zero production RMM signaling or encoder source changes.
"""
from pathlib import Path
import sys
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path("native/agent/Agent/chatpass_agent")
p=root/"src/frame_source.cpp"
s=p.read_text(encoding="utf-8")
def once(old,new,label):
 global s
 if s.count(old)!=1:
  raise ValueError(f"{label}: expected unique production anchor, got {s.count(old)}")
 s=s.replace(old,new,1)
once('#include "frame_source.h"', '''#include "frame_source.h"
#include "streamcore_v048_cpu_policy.hpp"
#include "fast_capture_flags.h"''',"include")
once('namespace {', '''namespace {
    // Opt-in ONLY on the Newtest Lenovo. Feature cannot be accidentally
    // activated by a tenant-wide env change on another RMM device.
    static bool StreamcoreV048CpuCanaryEnabled() noexcept {
        static const bool on=[] {
            wchar_t computer[MAX_COMPUTERNAME_LENGTH+1]{};
            DWORD len=MAX_COMPUTERNAME_LENGTH+1;
            return GetComputerNameW(computer,&len) &&
              _wcsicmp(computer,L"DESKTOP-Q9LTF1M")==0 &&
              hi5::EnabledProcessOrMachineCanary("HI5_RMM_STREAMCORE_V048_CPU_CANARY");
        }();
        return on;
    }

    static bool StreamcoreV048NormalDesktop() noexcept {
        HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
        if(!desktop)return false; // avoid any secure/UAC/Winlogon change
        wchar_t name[128]{};DWORD required=0;
        const bool ok=GetUserObjectInformationW(
             desktop,UOI_NAME,name,sizeof(name),&required)!=FALSE;
        CloseDesktop(desktop);
        return ok && _wcsicmp(name,L"Default")==0;
    }
''', 'policy')
# Preserve old HALFTONE StretchBlt path for dimensions that differ and
# when canary disabled. Try native BitBlt then fall back on failure.
old='''        SetStretchBltMode(memDC, HALFTONE);

        StretchBlt(
            memDC,
            0, 0, dstW, dstH,
            screenDC,
            x, y, srcW, srcH,
            SRCCOPY | CAPTUREBLT
        );'''
new='''        const bool nativeCanary=StreamcoreV048CpuCanaryEnabled() &&
                                StreamcoreV048NormalDesktop();
        BOOL copied=FALSE;
        if(hi5::streamcore048::NativeBlit(nativeCanary,srcW,srcH,dstW,dstH)){
            copied=BitBlt(memDC,0,0,dstW,dstH,
                          screenDC,x,y,SRCCOPY | CAPTUREBLT);
        }
        if(!copied){
            SetStretchBltMode(memDC,HALFTONE);
            copied=StretchBlt(memDC,0,0,dstW,dstH,
                              screenDC,x,y,srcW,srcH,SRCCOPY | CAPTUREBLT);
        }
        if(!copied){
            SelectObject(memDC,old);
            DeleteObject(bmp);
            DeleteDC(memDC);
            ReleaseDC(nullptr,screenDC);
            return false;
        }'''
once(old,new,'gdi-blit')
once('''    I420Frame lastFrame;
    std::chrono::steady_clock::time_point lastGdiRefresh{};''',
'''    I420Frame lastFrame;
    // GDI duplicate tracking is completely dormant until the explicitly
    // scoped Lenovo CPU canary is enabled. Preserve UAC and resize paths.
    std::vector<uint8_t> lastGdiBgra;
    int lastGdiIndex=-999;
    int lastGdiW=0,lastGdiH=0;
    uint64_t lastGdiFrameId=0;
    std::chrono::steady_clock::time_point lastGdiEmittedAt{};
    std::chrono::steady_clock::time_point lastGdiRefresh{};''','gdi-cache-fields')
# Integrate same single helper in BOTH all-monitors and single-display paths,
# before expensive BGRA->I420 conversion. Every one-pixel change still emits.
anchor='''        I420Frame out;
        bgraToI420(bgra.data(), stride, d.width, d.height, out);
        lastFrame = out;
        lastGdiRefresh = std::chrono::steady_clock::now();'''
addition='''        const auto cpuNow=std::chrono::steady_clock::now();
        const bool cpuCanary=StreamcoreV048CpuCanaryEnabled() &&
                             StreamcoreV048NormalDesktop();
        if(cpuCanary && lastGdiIndex==currentIndex && lastGdiW==d.width &&
           lastGdiH==d.height && lastGdiFrameId==frameId &&
           !lastFrame.y.empty() &&
           hi5::streamcore048::ExactSameBGRA(
                bgra.data(),bgra.size(),lastGdiBgra.data(),lastGdiBgra.size())){
            // Never treat a deliberate unchanged-frame skip as packet loss.
            result.frame=lastFrame;result.hasFrame=true;
            const bool heartbeat=hi5::streamcore048::HeartbeatDue(
                cpuNow,lastGdiEmittedAt);
            result.changed=heartbeat;
            if(heartbeat){lastGdiEmittedAt=cpuNow;result.frameId=++frameId;
                          lastGdiFrameId=frameId;}
            else result.frameId=frameId;
            lastGdiRefresh=cpuNow;
            return result;
        }
        I420Frame out;
        bgraToI420(bgra.data(), stride, d.width, d.height, out);
        lastFrame = out;
        lastGdiRefresh = cpuNow;
        if(cpuCanary){
           lastGdiBgra=std::move(bgra);
           lastGdiIndex=currentIndex;lastGdiW=d.width;lastGdiH=d.height;
           lastGdiFrameId=frameId+1;lastGdiEmittedAt=cpuNow;
        }else lastGdiBgra.clear();'''
if s.count(anchor)!=2:
 raise ValueError(f'GDI conversion branches expected exactly 2, got {s.count(anchor)}')
s=s.replace(anchor,addition)
assert s.count('hi5::streamcore048::ExactSameBGRA(')==2
assert s.count('hi5::streamcore048::NativeBlit(')==1
assert '#include "streamcore_v048_cpu_policy.hpp"' in s
p.write_text(s,encoding="utf-8")
print("PASS: injected default-off Lenovo GDI native BitBlt and unchanged-BGRA CPU fast path in both GDI capture branches")
