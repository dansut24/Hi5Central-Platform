// Hi5Central StreamCore v055: restricted Windows Winlogon keyboard sidecar.
// Privileged only through the authorised session-bound StreamCore RMM agent.
// No TCP, HTTP, named pipe, credentials, clipboard, key logging or UAC bypass.
// The trusted SYSTEM broker relays bounded commands through inherited pipes.
// The child is explicitly created on the active winsta0\Winlogon desktop.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wtsapi32.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

static bool is_system(){
 HANDLE token=nullptr;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return false;
 BYTE data[2048]{};
 DWORD bytes=0;
 const bool ok=GetTokenInformation(token,TokenUser,data,sizeof(data),&bytes) &&
   IsWellKnownSid(reinterpret_cast<TOKEN_USER*>(data)->User.Sid,WinLocalSystemSid);
 CloseHandle(token);
 return ok;
}
static bool is_current_console(){
 DWORD session=0;
 if(!ProcessIdToSessionId(GetCurrentProcessId(),&session))return false;
 const DWORD active=WTSGetActiveConsoleSessionId();
 return active!=0xFFFFFFFF && active!=0 && session==active;
}
static bool on_winlogon(){
 HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
 if(!desktop)return false;
 wchar_t name[80]{};
 DWORD needed=0;
 const bool ok=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed)!=FALSE;
 CloseDesktop(desktop);
 return ok && _wcsicmp(name,L"Winlogon")==0;
}
static bool enable_privilege(const wchar_t* name){
 HANDLE tok=nullptr;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY,&tok))return false;
 TOKEN_PRIVILEGES p{};p.PrivilegeCount=1;
 const bool found=LookupPrivilegeValueW(nullptr,name,&p.Privileges[0].Luid)!=FALSE;
 p.Privileges[0].Attributes=SE_PRIVILEGE_ENABLED;
 const bool ok=found && AdjustTokenPrivileges(tok,FALSE,&p,0,nullptr,nullptr)!=FALSE;
 const DWORD result=GetLastError();
 CloseHandle(tok);
 return ok && result==ERROR_SUCCESS;
}
static bool allowed_vk(unsigned int vk){
 return vk==0x08||vk==0x09||vk==0x0D||vk==0x10||
   vk==0x11||vk==0x12||vk==0x14||vk==0x1B||vk==0x20||
   (vk>=0x21&&vk<=0x28)||vk==0x2D||vk==0x2E||
   (vk>=0x30&&vk<=0x39)||(vk>=0x41&&vk<=0x5A)||
   (vk>=0x70&&vk<=0x7B);
}
// Strict parser: never accept arbitrary Windows virtual keys, controls, process
// instructions, or user-specified desktop/window/process destinations.
static bool parse_keyboard_line(const std::string& line,bool perform){
 if(line.size()<3||line.size()>128)return false;
 if(line.rfind("K ",0)==0){
  std::istringstream ss(line.substr(2));
  int state=-1;unsigned int vk=0;
  std::string extra;
  if(!(ss>>state>>vk)||(ss>>extra)||(state!=0&&state!=1)||!allowed_vk(vk))return false;
  if(!perform)return true;
  INPUT input{};input.type=INPUT_KEYBOARD;input.ki.wVk=WORD(vk);
  if(state==0)input.ki.dwFlags=KEYEVENTF_KEYUP;
  return SendInput(1,&input,sizeof(INPUT))==1;
 }
 if(line.rfind("T ",0)!=0)return false;
 const std::string hex=line.substr(2);
 if(hex.empty()||hex.size()>64||hex.size()%4!=0)return false;
 std::vector<WORD> chars;
 chars.reserve(hex.size()/4);
 for(size_t i=0;i<hex.size();i+=4){
  unsigned int val=0;
  for(size_t j=0;j<4;j++){
   const char c=hex[i+j];
   if(c>='0'&&c<='9')val=(val<<4)+unsigned(c-'0');
   else if(c>='A'&&c<='F')val=(val<<4)+unsigned(c-'A'+10);
   else return false;
  }
  if(val<0x20||val==0x7F||(val>=0x80&&val<=0x9F))return false;
  chars.push_back(WORD(val));
 }
 // UTF-16 surrogates must form complete pairs, never partial or malformed.
 for(size_t i=0;i<chars.size();i++){
  if(chars[i]>=0xD800&&chars[i]<=0xDBFF){
   if(i+1==chars.size()||chars[i+1]<0xDC00||chars[i+1]>0xDFFF)return false;
   i++;
  } else if(chars[i]>=0xDC00&&chars[i]<=0xDFFF) return false;
 }
 if(!perform)return true;
 std::vector<INPUT> input;
 input.reserve(chars.size()*2);
 for(WORD ch:chars){
  INPUT down{};down.type=INPUT_KEYBOARD;down.ki.wScan=ch;
  down.ki.dwFlags=KEYEVENTF_UNICODE;
  INPUT up=down;up.ki.dwFlags|=KEYEVENTF_KEYUP;
  input.push_back(down);input.push_back(up);
 }
 return SendInput(UINT(input.size()),input.data(),sizeof(INPUT))==input.size();
}
static int selftest(){
 // This path is parser-only; cannot send input and needs no SYSTEM token.
 const std::vector<std::string> good={
  "K 1 65","K 0 65","K 1 8","K 1 13","K 0 9","T 00610062",
  "T 00410039","T D83DDE00","T 00E9"};
 const std::vector<std::string> bad={
  "","K 1 91","K 2 65","K 1 0","K 1 999",
  "K 1 65 extra","K 1 91","T 000A","T 007F","T D83D",
  "T DE00","T 0061D83D","T 00000000","T 00eg",
  "C 1 2","T ","T 0041 0042"};
 for(const auto& x:good)if(!parse_keyboard_line(x,false))return 10;
 for(const auto& x:bad)if(parse_keyboard_line(x,false))return 11;
 std::cout<<"SECURE_KEYBOARD_PROTOCOL_SELFTEST_PASS checks="
          <<good.size()+bad.size()<<" injection=0\n";
 return 0;
}
static int secure_helper(){
 if(!is_system()||!is_current_console())return 20;
 HANDLE in=GetStdHandle(STD_INPUT_HANDLE);
 if(!in||in==INVALID_HANDLE_VALUE||GetFileType(in)!=FILE_TYPE_PIPE)return 21;
 // Allow Winlogon to finish activating before rejecting commands.
 const DWORD start=GetTickCount();
 while(!on_winlogon()&&GetTickCount()-start<5000)Sleep(80);
 if(!on_winlogon())return 22;
 std::string pending;
 DWORD intervalStart=GetTickCount();
 unsigned int perSecond=0;
 while(is_current_console()&&on_winlogon()){
  char buf[256]{};
  DWORD n=0;
  if(!ReadFile(in,buf,sizeof(buf),&n,nullptr)||n==0)break;
  pending.append(buf,n);
  if(pending.size()>1024)return 23;
  size_t at=0;
  while((at=pending.find('\n'))!=std::string::npos){
   std::string line=pending.substr(0,at);
   pending.erase(0,at+1);
   if(!is_current_console()||!on_winlogon())return 24;
   const DWORD now=GetTickCount();
   if(now-intervalStart>=1000){intervalStart=now;perSecond=0;}
   if(++perSecond>500)return 25;
   // Do not log input, the parsed lines, the target field or Windows secrets.
   (void)parse_keyboard_line(line,true);
  }
 }
 return 0;
}
static std::wstring self_path(){
 wchar_t filename[MAX_PATH]{};
 if(!GetModuleFileNameW(nullptr,filename,MAX_PATH))return {};
 return filename;
}
static HANDLE duplicate_system_token(DWORD session){
 HANDLE current=nullptr;
 if(!OpenProcessToken(GetCurrentProcess(),
   TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_SESSIONID|TOKEN_ADJUST_DEFAULT,
   &current))return nullptr;
 HANDLE primary=nullptr;
 const bool ok=DuplicateTokenEx(current,MAXIMUM_ALLOWED,nullptr,
    SecurityImpersonation,TokenPrimary,&primary)!=FALSE;
 CloseHandle(current);
 if(!ok)return nullptr;
 if(!SetTokenInformation(primary,TokenSessionId,&session,sizeof(session))){
  CloseHandle(primary);return nullptr;
 }
 return primary;
}
static int broker(){
 if(!is_system()||!is_current_console())return 30;
 HANDLE in=GetStdHandle(STD_INPUT_HANDLE);
 HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE);
 if(!in||in==INVALID_HANDLE_VALUE||GetFileType(in)!=FILE_TYPE_PIPE||
    !out||out==INVALID_HANDLE_VALUE||GetFileType(out)!=FILE_TYPE_PIPE)return 31;
 const DWORD session=WTSGetActiveConsoleSessionId();
 if(session==0||session==0xFFFFFFFF)return 32;
 enable_privilege(SE_ASSIGNPRIMARYTOKEN_NAME);
 enable_privilege(SE_INCREASE_QUOTA_NAME);
 enable_privilege(SE_TCB_NAME);
 HANDLE token=duplicate_system_token(session);
 if(!token)return 33;
 SECURITY_ATTRIBUTES attrs{};attrs.nLength=sizeof(attrs);attrs.bInheritHandle=TRUE;
 HANDLE childRead=nullptr,brokerWrite=nullptr;
 if(!CreatePipe(&childRead,&brokerWrite,&attrs,0)){CloseHandle(token);return 34;}
 SetHandleInformation(brokerWrite,HANDLE_FLAG_INHERIT,0);
 STARTUPINFOW startup{};startup.cb=sizeof(startup);
 startup.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;
 startup.wShowWindow=SW_HIDE;
 startup.lpDesktop=const_cast<LPWSTR>(L"winsta0\\Winlogon");
 startup.hStdInput=childRead;
 startup.hStdOutput=out;
 startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);
 PROCESS_INFORMATION process{};
 const std::wstring exe=self_path();
 std::wstring command=L"\""+exe+L"\" --secure-helper";
 std::vector<wchar_t> commandLine(command.begin(),command.end());
 commandLine.push_back(0);
 const BOOL launched=CreateProcessAsUserW(token,exe.c_str(),commandLine.data(),
   nullptr,nullptr,TRUE,CREATE_NO_WINDOW,
   nullptr,nullptr,&startup,&process);
 CloseHandle(token);CloseHandle(childRead);
 if(!launched){CloseHandle(brokerWrite);return 35;}
 HANDLE job=CreateJobObjectW(nullptr,nullptr);
 bool inJob=false;
 if(job){
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
  lim.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(SetInformationJobObject(job,JobObjectExtendedLimitInformation,&lim,sizeof(lim)) &&
     AssignProcessToJobObject(job,process.hProcess))inJob=true;
 }
 // No readiness until the Winlogon child has been started by the trusted
 // SYSTEM token. The Go host uses this handshake before enabling keyboard.
 const char ready[]="SECURE_KEYBOARD_BROKER_READY\n";
 DWORD sent=0;
 WriteFile(out,ready,DWORD(sizeof(ready)-1),&sent,nullptr);
 char buffer[256]{};
 while(is_current_console()){
  DWORD got=0;
  if(!ReadFile(in,buffer,sizeof(buffer),&got,nullptr)||got==0)break;
  DWORD at=0;
  while(at<got){
   DWORD written=0;
   if(!WriteFile(brokerWrite,buffer+at,got-at,&written,nullptr)||written==0){
    at=got;break;
   }
   at+=written;
  }
  if(WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0)break;
 }
 CloseHandle(brokerWrite);
 if(inJob)CloseHandle(job);
 else TerminateProcess(process.hProcess,1);
 WaitForSingleObject(process.hProcess,1500);
 CloseHandle(process.hThread);CloseHandle(process.hProcess);
 return 0;
}
int wmain(int argc,wchar_t** argv){
 if(argc!=2)return 2;
 const std::wstring mode=argv[1];
 if(mode==L"--selftest")return selftest();
 if(mode==L"--broker")return broker();
 if(mode==L"--secure-helper")return secure_helper();
 return 3;
}
