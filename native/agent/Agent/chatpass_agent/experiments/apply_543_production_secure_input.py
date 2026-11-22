#!/usr/bin/env python3
"""Hi5Central v543 Newtest-only production secure-input sidecar, using pre-existing C++ dispatcher."""
from pathlib import Path
import sys
root=Path(sys.argv[1])
src=root/"src"
service=src/"platform/windows/windows_service.cpp"
streamer=src/"streamer_main.cpp"
ring=src/"ipc/input_pipe.h"
for f in (service,streamer,ring):
    assert f.is_file(), f

def replace(f,old,new):
    body=f.read_text(encoding="utf-8")
    count=body.count(old)
    assert count==1, (f.name,old[:100],count)
    f.write_text(body.replace(old,new,1),encoding="utf-8")

# Use secure DACL rather than the legacy open-to-everyone DACL for this isolated UAC bridge.
replace(ring,'#include <windows.h>','#include <windows.h>\n#include <sddl.h>')
replace(ring,'''    bool Create(const std::string& name) {
        name_ = name;

        SECURITY_DESCRIPTOR sd{};
        InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
        SetSecurityDescriptorDacl(&sd, TRUE, nullptr, FALSE);
        SECURITY_ATTRIBUTES sa{ sizeof(SECURITY_ATTRIBUTES), &sd, FALSE };

        hMap_ = CreateFileMappingA(INVALID_HANDLE_VALUE, &sa,
            PAGE_READWRITE, 0,
            static_cast<DWORD>(kInputShmTotalBytes),
            name.c_str());
        if (!hMap_) return false;''','''    bool Create(const std::string& name, bool systemOnly = false) {
        name_ = name;

        SECURITY_DESCRIPTOR sd{};
        InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
        SetSecurityDescriptorDacl(&sd, TRUE, nullptr, FALSE);
        PSECURITY_DESCRIPTOR secureDescriptor = nullptr;
        if (systemOnly && !ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1,
            &secureDescriptor, nullptr)) return false;
        SECURITY_ATTRIBUTES sa{ sizeof(SECURITY_ATTRIBUTES),
            systemOnly ? secureDescriptor : &sd, FALSE };

        hMap_ = CreateFileMappingA(INVALID_HANDLE_VALUE, &sa,
            PAGE_READWRITE, 0,
            static_cast<DWORD>(kInputShmTotalBytes),
            name.c_str());
        const DWORD createdCode = GetLastError();
        if (secureDescriptor) LocalFree(secureDescriptor);
        // An untrusted process must not pre-create the privileged input mapping.
        if (systemOnly && hMap_ && createdCode == ERROR_ALREADY_EXISTS) {
            CloseHandle(hMap_);
            hMap_ = nullptr;
        }
        if (!hMap_) return false;''')

# Existing RunStreamerMain entry point, no new exe, no capture or WebRTC in input-only mode.
replace(streamer,'''namespace hi5 {

    int RunStreamerMain(int argc, char** argv) {''','''namespace hi5 {

    // Existing production InputPipeReader + SendKeyEvent/SendUnicodeTextUtf8,
    // without allocating DesktopFrameSource, GDI/DXGI, shmem or WebRTC.
    // This process is launched ONLY by the authenticated LocalSystem Agent
    // service as SYSTEM in the same active console on winsta0\\\\Winlogon.
    int RunSecureInputOnlyMain(const Args& args, DWORD ownerPid) {
        if (args.sessionId.size()!=36 || args.sessionId.find_first_not_of("0123456789abcdefABCDEF-")!=std::string::npos)
            return 21;
        const std::string prefix=args.sessionId.substr(0,16);
        if (args.inputPipeName!="Global\\\\Hi5Input_UAC_"+prefix ||
            args.stopEventName!="Global\\\\Hi5Stop_UAC_"+prefix)
            return 22;
        HANDLE token=nullptr;
        if(!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY,&token))return 23;
        BYTE tokenBuf[2048]{};DWORD n=0;
        const bool system=GetTokenInformation(token,TokenUser,tokenBuf,sizeof(tokenBuf),&n) &&
            IsWellKnownSid(reinterpret_cast<TOKEN_USER*>(tokenBuf)->User.Sid,WinLocalSystemSid);
        CloseHandle(token);
        if(!system)return 24;
        DWORD selfSession=0;
        if(!ProcessIdToSessionId(GetCurrentProcessId(),&selfSession) ||
           selfSession==0 || selfSession!=WTSGetActiveConsoleSessionId())return 25;
        HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,ownerPid);
        if(!parent)return 26;
        HANDLE stop=OpenEventA(SYNCHRONIZE,FALSE,args.stopEventName.c_str());
        if(!stop){CloseHandle(parent);return 27;}
        hi5::InputPipeReader reader;
        if(!reader.Open(args.inputPipeName)){
            CloseHandle(stop);CloseHandle(parent);return 28;
        }
        // Do not expose a second screenshot, webcam, clipboard, stream or
        // codec. No keyboard text or secrets are written to logs.
        while(WaitForSingleObject(stop,15)==WAIT_TIMEOUT &&
              WaitForSingleObject(parent,0)==WAIT_TIMEOUT &&
              WTSGetActiveConsoleSessionId()==selfSession) {
            HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
            bool winlogon=false;
            if(desktop){
                wchar_t name[96]{};DWORD needed=0;
                winlogon=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed)!=0 &&
                    _wcsicmp(name,L"Winlogon")==0;
                CloseDesktop(desktop);
            }
            hi5::InputCmd cmd{};int drained=0;
            while(reader.Read(cmd) && ++drained<=128){
                // Discard stale input if Winlogon has closed, never replay.
                if(!winlogon)continue;
                if(cmd.type==hi5::InputCmdType::KeyEvent){
                    SendKeyEvent(cmd);
                }else if(cmd.type==hi5::InputCmdType::PasteText){
                    std::string text;
                    if(cmd.clipboard.length<=640 &&
                       reader.ReadClipboard(cmd.clipboard.offsetInClip,cmd.clipboard.length,text)){
                        SendUnicodeTextUtf8(text);
                    }
                }
            }
        }
        reader.Close();
        CloseHandle(stop);CloseHandle(parent);
        return 0;
    }

    int RunStreamerMain(int argc, char** argv) {''')
replace(streamer,'''        const Args args = ParseArgs(argc, argv);
        if (args.sessionId.empty() || args.shmemName.empty()) {''','''        const Args args = ParseArgs(argc, argv);
        bool secureInputOnly=false;
        for(int i=1;i<argc;++i){
            if(std::string(argv[i])=="--secure-input-only")secureInputOnly=true;
        }
        if(secureInputOnly) {
            const auto owner=GetArgValue(argc,argv,"--owner-pid");
            if(!owner)return 20;
            try {
                const unsigned long pid=std::stoul(*owner);
                if(!pid || pid>0xFFFFFFFFUL)return 20;
                return RunSecureInputOnlyMain(args,static_cast<DWORD>(pid));
            } catch(...) {return 20;}
        }
        if (args.sessionId.empty() || args.shmemName.empty()) {''')

# Keep StreamCore secure-state based on actual v053 source selection, not an
# unreliable Session-0 OpenInputDesktop check.
replace(service,'''            std::shared_ptr<StreamCoreRmmTransport> streamcore;''','''            std::shared_ptr<StreamCoreRmmTransport> streamcore;
            std::shared_ptr<std::atomic<bool>> streamcoreSecureKeyboard;''')
replace(service,'''                        if (core) {
                            json control={{"type","rmm_control"},{"session_id",sessionId},{"input",msg}};
                            if(!core->Send(control.dump())) LogW("StreamCore RMM control pipe unavailable "+sessionId);
                            FlushBridgeOutgoing();
                            return;
                        }''','''                        if (core) {
                            // Route only keyboard/text on active Winlogon through
                            // the SAME Agent input ring used by production RMM.
                            // Mouse, CAD, video and all normal-desktop input keep
                            // the unchanged qualified StreamCore paths.
                            const std::string kind=msg.value("kind",std::string());
                            const bool isKeyboard=(kind=="text_input"||kind=="text"||
                                kind=="insert_text"||kind=="key_text"||
                                kind=="key_down"||kind=="key_up"||kind=="key_press");
                            bool routed=false;
                            if(isKeyboard){
                                std::lock_guard<std::mutex> lock(sessionsMu_);
                                auto it=sessions_.find(sessionId);
                                if(it!=sessions_.end() && it->second->streamcore==core &&
                                   it->second->streamcoreSecureKeyboard &&
                                   it->second->streamcoreSecureKeyboard->load() &&
                                   it->second->secureStreamerProcess){
                                    it->second->activeMode=DesktopMode::Secure;
                                    DispatchInputToPipe(*it->second,msg);
                                    it->second->activeMode=DesktopMode::Normal;
                                    routed=true;
                                }
                            }
                            if(!routed){
                                json control={{"type","rmm_control"},{"session_id",sessionId},{"input",msg}};
                                if(!core->Send(control.dump())) LogW("StreamCore RMM control pipe unavailable "+sessionId);
                            }
                            FlushBridgeOutgoing();
                            return;
                        }''')

replace(service,'''                auto core=std::make_shared<StreamCoreRmmTransport>(sessionId,
                    [sendFn,sessionId](const std::string& wire){''','''                auto secureKeyboard=std::make_shared<std::atomic<bool>>(false);
                auto core=std::make_shared<StreamCoreRmmTransport>(sessionId,
                    [sendFn,sessionId,secureKeyboard](const std::string& wire){''')
replace(service,'''                        const std::string type=parsed.value("type",std::string());
                        if(type!="webrtc_offer"''','''                        const std::string type=parsed.value("type",std::string());
                        if(type=="capture_started"){
                            const std::string backend=parsed.value("backend",std::string());
                            secureKeyboard->store(backend.find("Winlogon")!=std::string::npos);
                        }
                        if(type!="webrtc_offer"''')
replace(service,'''                ctx->streamcore=core;
                {
                    std::lock_guard<std::mutex> lock(sessionsMu_);
                    sessions_[sessionId]=std::move(ctx);
                }''','''                ctx->streamcore=core;
                ctx->streamcoreSecureKeyboard=secureKeyboard;
                // Reuse existing signed Agent secure streamer and production
                // input pipeline, but run it INPUT ONLY (no second capture).
                // Strict SYSTEM/Administrator-only shared memory DACL, rejecting
                // pre-created objects. No third-party privileged executable.
                const std::string prefix=sessionId.substr(0,16);
                ctx->secureInputPipeName="Global\\\\Hi5Input_UAC_"+prefix;
                ctx->secureStopEventName="Global\\\\Hi5Stop_UAC_"+prefix;
                if(ctx->secureInputPipe.Create(ctx->secureInputPipeName,true)){
                    ctx->secureStopEvent=CreateEventA(nullptr,TRUE,FALSE,
                        ctx->secureStopEventName.c_str());
                    if(ctx->secureStopEvent){
                        const std::string cmdLine="--mode streamer --secure-input-only"+
                            std::string(" --session ")+sessionId+
                            " --input-pipe "+ctx->secureInputPipeName+
                            " --stop-event "+ctx->secureStopEventName+
                            " --owner-pid "+std::to_string(GetCurrentProcessId());
                        ctx->secureStreamerProcess=LaunchOnSecureDesktop(
                            CurrentExePath(),cmdLine);
                        if(ctx->secureStreamerProcess){
                            LogI("Newtest production Winlogon INPUT-ONLY helper started; no media changes");
                        }else{
                            LogW("Newtest production Winlogon keyboard unavailable; existing StreamCore unchanged");
                        }
                    }
                } else {
                    LogW("Newtest secure input ring unavailable (ACL/owner collision); existing StreamCore unchanged");
                }
                {
                    std::lock_guard<std::mutex> lock(sessionsMu_);
                    sessions_[sessionId]=std::move(ctx);
                }''')
print('PATCH_PASS secure source',service.stat().st_size,'streamer',streamer.stat().st_size,'ring',ring.stat().st_size)
