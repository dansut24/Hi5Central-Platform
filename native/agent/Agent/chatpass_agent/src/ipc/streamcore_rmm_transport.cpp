#include "streamcore_rmm_transport.h"
#include "session_launcher.h"
#include <sddl.h>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <vector>

// Restrict pipe DACL to SYSTEM and built-in Administrators. The process
// itself must be created by the RMM Agent's LocalSystem SCM service,
// in the exact active console session using LaunchInElevatedDefaultSession.
bool StreamCoreRmmTransport::ValidSessionID(const std::string& sid) {
 if(sid.size()!=36)return false;
 for(size_t i=0;i<sid.size();++i){
  const bool dash=(i==8||i==13||i==18||i==23);
  if(dash){if(sid[i]!='-')return false;}
  else if(!((sid[i]>='0'&&sid[i]<='9')||(sid[i]>='a'&&sid[i]<='f')))return false;
 }
 return true;
}
StreamCoreRmmTransport::StreamCoreRmmTransport(std::string sid,MessageCallback cb)
 :sessionID_(std::move(sid)),callback_(std::move(cb)){}
StreamCoreRmmTransport::~StreamCoreRmmTransport(){Stop();}
HANDLE StreamCoreRmmTransport::CreateRestrictedPipe(const std::wstring& name,DWORD mode) {
 PSECURITY_DESCRIPTOR sd=nullptr;
 if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
     L"D:P(A;;GA;;;SY)(A;;GA;;;BA)",SDDL_REVISION_1,&sd,nullptr)){
  return INVALID_HANDLE_VALUE;
 }
 SECURITY_ATTRIBUTES sa{};
 sa.nLength=sizeof(sa);sa.lpSecurityDescriptor=sd;sa.bInheritHandle=FALSE;
 HANDLE pipe=CreateNamedPipeW(name.c_str(),mode,
    PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,
    1,65536,65536,0,&sa);
 LocalFree(sd);
 return pipe;
}
bool StreamCoreRmmTransport::ConnectBounded(HANDLE pipe,std::thread& worker,int timeoutMillis){
 if(pipe==INVALID_HANDLE_VALUE)return false;
 std::mutex mu;std::condition_variable cv;
 bool complete=false;bool success=false;
 worker=std::thread([&](){
  BOOL connected=ConnectNamedPipe(pipe,nullptr);
  DWORD error=connected?ERROR_SUCCESS:GetLastError();
  {std::lock_guard<std::mutex> guard(mu);
   success=connected||error==ERROR_PIPE_CONNECTED;
   complete=true;}
  cv.notify_one();
 });
 std::unique_lock<std::mutex> lock(mu);
 if(!cv.wait_for(lock,std::chrono::milliseconds(timeoutMillis),[&](){return complete;})){
  // Windows CancelSynchronousIo prevents an unbounded wait on shutdown
  // or a compromised companion process.
  CancelSynchronousIo((HANDLE)worker.native_handle());
 }
 lock.unlock();
 if(worker.joinable())worker.join();
 return complete&&success;
}
bool StreamCoreRmmTransport::Start(const std::string& trustedExe) {
 if(stopped_.load()||running_.load()||!ValidSessionID(sessionID_)||!callback_)
  return false;
 if(trustedExe.empty()||trustedExe.size()>1024)return false;
 // Never execute a path chosen by remote WebRTC messages; caller must
 // derive the fixed filename from its own signed Agent installation.
 const std::string target="Hi5StreamCore-RMM-Engine-Win64.exe";
 if(trustedExe.size()<target.size() ||
    trustedExe.compare(trustedExe.size()-target.size(),target.size(),target)!=0)
  return false;
 std::wstring id(sessionID_.begin(),sessionID_.end());
 std::wstring prefix=L"\\\\.\\pipe\\Hi5Central-RMM-StreamCore-"+id;
 toCore_=CreateRestrictedPipe(prefix+L"-agent-to-core",PIPE_ACCESS_OUTBOUND);
 fromCore_=CreateRestrictedPipe(prefix+L"-core-to-agent",PIPE_ACCESS_INBOUND);
 if(toCore_==INVALID_HANDLE_VALUE||fromCore_==INVALID_HANDLE_VALUE){
  Stop();return false;
 }
 process_=hi5::LaunchInElevatedDefaultSession(trustedExe,
    "--rmm-session --id "+sessionID_+" --pipes");
 if(!process_){Stop();return false;}
 // The dedicated child must connect both pipes. Do not leak this thread
 // or block an agent WebSocket callback indefinitely on a failed child.
 std::thread first,second;
 bool inReady=ConnectBounded(toCore_,first,10000);
 bool outReady=inReady&&ConnectBounded(fromCore_,second,10000);
 if(!inReady||!outReady){Stop();return false;}
 running_.store(true);
 reader_=std::thread([this](){ReaderLoop();});
 return true;
}
bool StreamCoreRmmTransport::Send(const std::string& json){
 if(!running_.load()||json.empty()||json.size()>256*1024 ||
     json.find('\n')!=std::string::npos||json.find('\r')!=std::string::npos)
  return false;
 std::lock_guard<std::mutex> guard(writing_);
 if(toCore_==INVALID_HANDLE_VALUE)return false;
 const std::string message=json+"\n";
 DWORD wrote=0;
 return WriteFile(toCore_,message.data(),static_cast<DWORD>(message.size()),&wrote,nullptr)
      &&wrote==message.size();
}
void StreamCoreRmmTransport::ReaderLoop(){
 std::string buffer;buffer.reserve(8192);
 char tmp[8192];
 while(running_.load()){
  DWORD count=0;
  const BOOL ok=ReadFile(fromCore_,tmp,sizeof(tmp),&count,nullptr);
  if(!ok||count==0)break;
  buffer.append(tmp,count);
  if(buffer.size()>256*1024){break;}
  for(size_t pos; (pos=buffer.find('\n'))!=std::string::npos;){
   auto msg=buffer.substr(0,pos);
   buffer.erase(0,pos+1);
   if(msg.empty()||msg.size()>256*1024)continue;
   // Caller parses and checks session_id; this pipe is additionally
   // protected by the SYSTEM-only DACL and tied to the child PID.
   callback_(msg);
  }
 }
 running_.store(false);
}
void StreamCoreRmmTransport::Stop(){
 if(stopped_.exchange(true))return;
 const bool wasConnected=running_.exchange(false);
 if(wasConnected && toCore_!=INVALID_HANDLE_VALUE){
  const std::string stop="{\"type\":\"stop_webrtc\",\"session_id\":\""+sessionID_+"\"}\n";
  DWORD n=0;WriteFile(toCore_,stop.data(),static_cast<DWORD>(stop.size()),&n,nullptr);
 }
 if(process_){
  if(WaitForSingleObject(process_,1500)==WAIT_TIMEOUT){
   TerminateProcess(process_,0);
   WaitForSingleObject(process_,1000);
  }
  CloseHandle(process_);process_=nullptr;
 }
 if(reader_.joinable()){
  CancelSynchronousIo((HANDLE)reader_.native_handle());
 }
 if(toCore_!=INVALID_HANDLE_VALUE){
  CloseHandle(toCore_);toCore_=INVALID_HANDLE_VALUE;
 }
 if(fromCore_!=INVALID_HANDLE_VALUE){
  CloseHandle(fromCore_);fromCore_=INVALID_HANDLE_VALUE;
 }
 if(reader_.joinable())reader_.join();
}
