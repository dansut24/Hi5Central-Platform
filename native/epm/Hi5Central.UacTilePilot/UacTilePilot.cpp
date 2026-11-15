// Hi5Central UAC research pilot — display-only Credential UI provider.
// IMPORTANT: This DLL never authenticates, serializes a credential, starts
// a process, reads a password or connects to the Hi5Central Agent.
// It supports ONLY CPUS_CREDUI. It does NOT implement a provider filter.
// The Windows password / PIN / Hello providers must remain present.
#include <windows.h>
#include <credentialprovider.h>
#include <wincred.h>
#include <shlwapi.h>
#include <new>
#include <atomic>
#include <string>
#include "UacTilePilot.h"

namespace {
std::atomic<long> g_objects{0};

enum FieldId : DWORD {
  F_TITLE=0,
  F_DESCRIPTION=1,
  F_STATUS=2,
  F_REASON=3,
  F_EXE_PATH=4,
  F_ACTION=5,
  F_COUNT=6
};

constexpr wchar_t kTitle[] = L"Hi5Central EPM";
constexpr wchar_t kDescription[] = L"Request administrator access";
constexpr wchar_t kStatus[] =
    L"Select a signed EXE path, enter a reason, then send for Newtest RMM approval. "
    L"The original Windows UAC action will NOT resume.";
constexpr wchar_t kAction[] = L"Request approval in Hi5Central RMM";
constexpr wchar_t kReasonLabel[] = L"Business justification (20-512 characters)";
constexpr wchar_t kPathLabel[] = L"Full path to signed EXE (required)";
constexpr wchar_t kNeedReason[] =
    L"Enter a business justification of at least 20 characters. No request was sent.";
constexpr wchar_t kNeedTarget[] =
    L"Enter a full local path to the signed EXE. The current UAC target is not "
    L"available through the documented credential provider API.";
constexpr wchar_t kPending[] =
    L"Request submitted to Newtest RMM for the exact signed file. CANCEL this "
    L"Windows UAC prompt. When approved, use the Hi5Central notification to launch.";
constexpr wchar_t kUnavailable[] =
    L"Hi5Central could not verify or submit this request. Nothing was elevated. "
    L"Cancel UAC and use Run with Hi5Central admin.";
constexpr wchar_t kRejected[] =
    L"Hi5Central rejected this executable or request. No elevation occurred. "
    L"Use the existing Run with Hi5Central admin flow.";

static const struct {
  CREDENTIAL_PROVIDER_FIELD_TYPE type;
  const wchar_t* label;
  CREDENTIAL_PROVIDER_FIELD_STATE state;
} kFields[F_COUNT] = {
  {CPFT_LARGE_TEXT,kTitle,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kDescription,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kStatus,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_EDIT_TEXT,kReasonLabel,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_EDIT_TEXT,kPathLabel,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_COMMAND_LINK,kAction,CPFS_DISPLAY_IN_SELECTED_TILE}
};

HRESULT MakeString(const wchar_t* value,LPWSTR* output) noexcept {
  if(!output)return E_INVALIDARG;
  *output=nullptr;
  return SHStrDupW(value,output);
}


static bool IsCandidateExe(const std::wstring& p) noexcept {
  if(p.size()<7||p.size()>2048||p[1]!=L':'||p[2]!=L'\\')return false;
  if(!((p[0]>=L'A'&&p[0]<=L'Z')||(p[0]>=L'a'&&p[0]<=L'z')))return false;
  if(_wcsicmp(p.c_str()+p.size()-4,L".exe")!=0)return false;
  if(p.find(L"..\\")!=std::wstring::npos||p.find(L'\"')!=std::wstring::npos)return false;
  return true;
}

// No credentials, Agent secret or approval tokens ever enter the UAC DLL.
// The SYSTEM-owned, ACL-protected local service authenticates the actual
// Windows Credential UI host and verifies the EXE via Authenticode/SHA-256.
static std::string JsonString(const std::wstring& text) {
  if(text.size()>4096)return {};
  int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.c_str(),
    static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  if(count<=0)return {};
  std::string utf8(static_cast<size_t>(count),'\0');
  if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.c_str(),
    static_cast<int>(text.size()),utf8.data(),count,nullptr,nullptr))return {};
  std::string output="\"";
  for(unsigned char c:utf8){
    if(c==0||c<0x20)return {};
    if(c=='\"'||c=='\\')output.push_back('\\');
    output.push_back(static_cast<char>(c));
  }
  output.push_back('\"');
  return output;
}

static std::wstring SendRequest(const std::wstring& path,const std::wstring& reason) {
  auto p=JsonString(path),r=JsonString(reason);
  if(p.empty()||r.empty())return kRejected;
  const std::string message="{\"type\":\"uac-request\",\"path\":"+p+",\"reason\":"+r+"}";
  char reply[4096]{};
  DWORD received=0;
  // CallNamedPipe has a bounded 5s timeout; failure to contact the service
  // must never freeze the secure desktop indefinitely or authenticate UAC.
  BOOL ok=CallNamedPipeW(L"\\\\.\\pipe\\Hi5CentralEpmPilot",
      const_cast<char*>(message.data()),static_cast<DWORD>(message.size()),
      reply,sizeof(reply)-1,&received,5000);
  if(!ok||received>=sizeof(reply))return kUnavailable;
  std::string result(reply,reply+received);
  // This text is only a UI status hint. Server-side approval is authoritative;
  // even a fabricated response here cannot grant rights or complete UAC.
  if(result.find("\"success\":true")!=std::string::npos)
    return kPending;
  return kRejected;
}

class Tile final : public ICredentialProviderCredential {
  std::atomic<ULONG> refs_{1};
  ICredentialProviderCredentialEvents* events_{nullptr};
  bool selected_{false};
  bool clicked_{false};
  std::wstring reason_;
  std::wstring path_;
  std::wstring status_;
public:
  Tile() {g_objects.fetch_add(1);}
  ~Tile() {
    if(events_) events_->Release();
    if(!reason_.empty()) SecureZeroMemory(reason_.data(),reason_.size()*sizeof(wchar_t));
    if(!path_.empty()) SecureZeroMemory(path_.data(),path_.size()*sizeof(wchar_t));
    g_objects.fetch_sub(1);
  }
  STDMETHODIMP QueryInterface(REFIID riid,void** ptr) override {
    if(!ptr)return E_INVALIDARG;
    *ptr=nullptr;
    if(IsEqualIID(riid,IID_IUnknown)||IsEqualIID(riid,IID_ICredentialProviderCredential))
      *ptr=static_cast<ICredentialProviderCredential*>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override {return ++refs_;}
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n=--refs_;if(!n)delete this;return n;
  }
  STDMETHODIMP Advise(ICredentialProviderCredentialEvents* event) override {
    if(events_)events_->Release();
    events_=event;
    if(events_)events_->AddRef();
    return S_OK;
  }
  STDMETHODIMP UnAdvise() override {
    if(events_){events_->Release();events_=nullptr;}
    return S_OK;
  }
  STDMETHODIMP SetSelected(BOOL* autoLogon) override {
    if(!autoLogon)return E_INVALIDARG;
    *autoLogon=FALSE;selected_=true;return S_OK;
  }
  STDMETHODIMP SetDeselected() override {
    selected_=false;return S_OK;
  }
  STDMETHODIMP GetFieldState(
      DWORD id,CREDENTIAL_PROVIDER_FIELD_STATE* state,
      CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE* interactive) override {
    if(!state||!interactive)return E_INVALIDARG;
    if(id>=F_COUNT)return E_INVALIDARG;
    *state=kFields[id].state;
    *interactive=CPFIS_NONE;
    return S_OK;
  }
  STDMETHODIMP GetStringValue(DWORD id,LPWSTR* value) override {
    if(id>=F_COUNT)return E_INVALIDARG;
    if(id==F_STATUS&&clicked_)return MakeString(status_.c_str(),value);
    if(id==F_REASON)return MakeString(reason_.c_str(),value);
    if(id==F_EXE_PATH)return MakeString(path_.c_str(),value);
    return MakeString(kFields[id].label,value);
  }
  STDMETHODIMP GetBitmapValue(DWORD,HBITMAP*) override {return E_NOTIMPL;}
  STDMETHODIMP GetCheckboxValue(DWORD,BOOL*,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP GetSubmitButtonValue(DWORD,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueCount(DWORD,DWORD*,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueAt(DWORD,DWORD,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP SetStringValue(DWORD id,LPCWSTR input) override {
    if((id!=F_REASON && id!=F_EXE_PATH)||!input)return E_INVALIDARG;
    const size_t maximum=id==F_REASON?512:2048;
    const size_t length=wcsnlen_s(input,maximum+1);
    if(length>maximum)return E_INVALIDARG;
    // This display-only pilot neither transmits nor persists the reason.
    // Reject control characters to avoid obscured/truncated prompt content.
    for(size_t i=0;i<length;i++) {
      if(input[i]<0x20 || input[i]==0x7f)return E_INVALIDARG;
    }
    std::wstring incoming(input,length);
    auto& value=id==F_REASON?reason_:path_;
    if(!value.empty())SecureZeroMemory(value.data(),value.size()*sizeof(wchar_t));
    value.swap(incoming);
    if(!incoming.empty())SecureZeroMemory(incoming.data(),incoming.size()*sizeof(wchar_t));
    clicked_=false;status_.clear();
    return S_OK;
  }
  STDMETHODIMP SetCheckboxValue(DWORD,BOOL) override {return E_NOTIMPL;}
  STDMETHODIMP SetComboBoxSelectedValue(DWORD,DWORD) override {return E_NOTIMPL;}
  STDMETHODIMP CommandLinkClicked(DWORD id) override {
    if(id!=F_ACTION)return E_INVALIDARG;
    clicked_=true;
    if(reason_.size()<20)status_=kNeedReason;
    else if(!IsCandidateExe(path_))status_=kNeedTarget;
    else status_=SendRequest(path_,reason_);
    if(events_)events_->SetFieldString(this,F_STATUS,status_.c_str());
    return S_OK;
  }
  STDMETHODIMP GetSerialization(
      CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE* response,
      CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION* serialization,
      LPWSTR* status,CREDENTIAL_PROVIDER_STATUS_ICON* icon) override {
    if(!response||!serialization||!status||!icon)return E_INVALIDARG;
    // Never submit administrator credentials or authenticate from this pilot.
    *response=CPGSR_NO_CREDENTIAL_NOT_FINISHED;
    ZeroMemory(serialization,sizeof(*serialization));
    *icon=CPSI_NONE;
    *status=nullptr;
    return S_OK;
  }
  STDMETHODIMP ReportResult(NTSTATUS,NTSTATUS,LPWSTR* status,
                             CREDENTIAL_PROVIDER_STATUS_ICON* icon) override {
    if(!status||!icon)return E_INVALIDARG;
    *status=nullptr;*icon=CPSI_NONE;return S_OK;
  }
};

class Provider final : public ICredentialProvider {
  std::atomic<ULONG> refs_{1};
  CREDENTIAL_PROVIDER_USAGE_SCENARIO scenario_{CPUS_INVALID};
  DWORD flags_{0};
public:
  Provider(){g_objects.fetch_add(1);}
  ~Provider() {g_objects.fetch_sub(1);}
  STDMETHODIMP QueryInterface(REFIID riid,void** ptr) override {
    if(!ptr)return E_INVALIDARG;
    *ptr=nullptr;
    if(IsEqualIID(riid,IID_IUnknown)||IsEqualIID(riid,IID_ICredentialProvider))
      *ptr=static_cast<ICredentialProvider*>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override {return ++refs_;}
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n=--refs_;if(!n)delete this;return n;
  }
  STDMETHODIMP SetUsageScenario(CREDENTIAL_PROVIDER_USAGE_SCENARIO scenario,DWORD flags) override {
    scenario_=CPUS_INVALID;flags_=flags;
    if(scenario!=CPUS_CREDUI)return E_NOTIMPL;
    scenario_=scenario;
    return S_OK;
  }
  STDMETHODIMP SetSerialization(const CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION*) override {
    // Never accept or forward serialized user credentials.
    return E_NOTIMPL;
  }
  STDMETHODIMP Advise(ICredentialProviderEvents*,UINT_PTR) override {return S_OK;}
  STDMETHODIMP UnAdvise() override {return S_OK;}
  STDMETHODIMP GetFieldDescriptorCount(DWORD* count) override {
    if(!count)return E_INVALIDARG;
    *count=F_COUNT;return S_OK;
  }
  STDMETHODIMP GetFieldDescriptorAt(DWORD index,CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** result) override {
    if(!result)return E_INVALIDARG;
    *result=nullptr;
    if(index>=F_COUNT)return E_INVALIDARG;
    auto* field=reinterpret_cast<CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR*>(
      CoTaskMemAlloc(sizeof(CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR)));
    if(!field)return E_OUTOFMEMORY;
    ZeroMemory(field,sizeof(*field));
    field->dwFieldID=index;
    field->cpft=kFields[index].type;
    HRESULT hr=MakeString(kFields[index].label,&field->pszLabel);
    if(FAILED(hr)){CoTaskMemFree(field);return hr;}
    *result=field;
    return S_OK;
  }
  STDMETHODIMP GetCredentialCount(DWORD* count,DWORD* defaultCredential,BOOL* autoLogon) override {
    if(!count||!defaultCredential||!autoLogon)return E_INVALIDARG;
    // Prefer the Hi5Central tile for the supported CredUI scenario only.
    // Windows may choose an existing system credential provider instead;
    // never auto-submit or filter the built-in password providers.
    *defaultCredential=CREDENTIAL_PROVIDER_NO_DEFAULT;
    *autoLogon=FALSE;
    const DWORD restrictive=CREDUIWIN_GENERIC|CREDUIWIN_IN_CRED_ONLY|CREDUIWIN_AUTHPACKAGE_ONLY;
    *count=(scenario_==CPUS_CREDUI&&(flags_&restrictive)==0)?1:0;
    if(*count==1)*defaultCredential=0;
    return S_OK;
  }
  STDMETHODIMP GetCredentialAt(DWORD index,ICredentialProviderCredential** credential) override {
    if(!credential)return E_INVALIDARG;
    *credential=nullptr;
    DWORD count=0,def=0;BOOL autoLogon=FALSE;
    HRESULT hr=GetCredentialCount(&count,&def,&autoLogon);
    if(FAILED(hr))return hr;
    if(index!=0||count!=1)return E_INVALIDARG;
    Tile* tile=new(std::nothrow) Tile();
    if(!tile)return E_OUTOFMEMORY;
    *credential=tile;
    return S_OK;
  }
};

class Factory final : public IClassFactory {
  std::atomic<ULONG> refs_{1};
public:
  Factory(){g_objects.fetch_add(1);}
  ~Factory() {g_objects.fetch_sub(1);}
  STDMETHODIMP QueryInterface(REFIID riid,void** ptr) override {
    if(!ptr)return E_INVALIDARG;*ptr=nullptr;
    if(IsEqualIID(riid,IID_IUnknown)||IsEqualIID(riid,IID_IClassFactory))
      *ptr=static_cast<IClassFactory*>(this);
    else return E_NOINTERFACE;
    AddRef();return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override {return ++refs_;}
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n=--refs_;if(!n)delete this;return n;
  }
  STDMETHODIMP CreateInstance(IUnknown* outer,REFIID iid,void** output) override {
    if(!output)return E_INVALIDARG;*output=nullptr;
    if(outer)return CLASS_E_NOAGGREGATION;
    Provider* provider=new(std::nothrow) Provider();
    if(!provider)return E_OUTOFMEMORY;
    HRESULT hr=provider->QueryInterface(iid,output);
    provider->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    if(lock)g_objects.fetch_add(1);
    else g_objects.fetch_sub(1);
    return S_OK;
  }
};
} // namespace

extern "C" __declspec(dllexport) HRESULT STDAPICALLTYPE
H5DllGetClassObject(REFCLSID clsid,REFIID iid,void** output) {
  if(!output)return E_INVALIDARG;
  *output=nullptr;
  if(!IsEqualCLSID(clsid,CLSID_Hi5CentralUacTilePilot))
    return CLASS_E_CLASSNOTAVAILABLE;
  Factory* factory=new(std::nothrow) Factory();
  if(!factory)return E_OUTOFMEMORY;
  HRESULT hr=factory->QueryInterface(iid,output);
  factory->Release();
  return hr;
}

extern "C" __declspec(dllexport) HRESULT STDAPICALLTYPE H5DllCanUnloadNow() {
  return g_objects.load()==0?S_OK:S_FALSE;
}

BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID) {
  if(reason==DLL_PROCESS_ATTACH)DisableThreadLibraryCalls(instance);
  return TRUE;
}
