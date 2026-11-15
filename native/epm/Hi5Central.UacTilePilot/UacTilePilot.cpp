// Hi5Central UAC research pilot — review-only Credential UI provider.
// IMPORTANT: This DLL NEVER authenticates, serializes a credential, starts
// a process, reads a password or releases administrator privileges.
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
  F_ACTION=4,
  F_COUNT=5
};

constexpr wchar_t kTitle[] = L"Hi5Central EPM";
constexpr wchar_t kDescription[] = L"Request administrator access";
constexpr wchar_t kStatus[] =
    L"Send a security review to Hi5Central RMM. The underlying UAC operation "
    L"cannot be verified, so review will NOT grant administrator rights.";
constexpr wchar_t kAction[] = L"Submit UAC security review to Hi5Central RMM";
constexpr wchar_t kCheckAction[] = L"Check technician review status";
constexpr wchar_t kReasonLabel[] = L"Business justification (20-512 characters)";
constexpr wchar_t kNeedReason[] =
    L"Enter at least 20 characters explaining the action. No request was sent.";
constexpr wchar_t kUnavailable[] =
    L"Cannot contact the verified Hi5Central Windows broker. No request was sent, "
    L"and nothing was elevated. Normal Windows credentials remain available.";
constexpr wchar_t kReviewSent[] =
    L"UAC review sent to Hi5Central RMM. No administrator credential or "
    L"elevation has been issued; normal Windows UAC remains in control.";
constexpr wchar_t kRejected[] =
    L"Windows broker rejected the UAC review. No credential or elevation "
    L"was issued. Use the existing file-bound Hi5Central approval workflow.";
constexpr wchar_t kStillPending[] =
    L"Waiting for technician review. This is not an elevation grant; "
    L"normal Windows credentials remain required.";
constexpr wchar_t kReviewed[] =
    L"Technician review recorded. No administrator credential was released. "
    L"Cancel UAC or use normal Windows credentials.";
constexpr wchar_t kExpired[] =
    L"UAC review expired or was rejected. No elevation was granted.";

static const struct {
  CREDENTIAL_PROVIDER_FIELD_TYPE type;
  const wchar_t* label;
  CREDENTIAL_PROVIDER_FIELD_STATE state;
} kFields[F_COUNT] = {
  {CPFT_LARGE_TEXT,kTitle,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kDescription,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kStatus,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_EDIT_TEXT,kReasonLabel,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_COMMAND_LINK,kAction,CPFS_DISPLAY_IN_SELECTED_TILE}
};

HRESULT MakeString(const wchar_t* value,LPWSTR* output) noexcept {
  if(!output)return E_INVALIDARG;
  *output=nullptr;
  return SHStrDupW(value,output);
}


// A native CPUS_CREDUI credential provider receives no documented trusted
// handle, canonical path or file hash for the EXE being elevated. Never infer
// the file from the consent.exe window caption, recent downloads, clipboard,
// parent process or an unrelated executable with a matching display name.
// Until a separately authenticated PRE-LAUNCH intent is bound to this exact
// request, do not submit an elevation approval from this secure-desktop tile.


// The tile does not know, guess or accept an EXE path for this UAC operation.
// Only an authenticated Windows consent.exe host may submit a *review* to
// the existing EPM SYSTEM broker; that broker determines user SID/session.
static std::string ToJsonString(const std::wstring& text) {
  if(text.size()>512)return {};
  int len=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,
      text.c_str(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  if(len<=0)return {};
  std::string utf8(static_cast<size_t>(len),'\0');
  if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,
      text.c_str(),static_cast<int>(text.size()),utf8.data(),len,nullptr,nullptr))
    return {};
  std::string json="\"";
  for(unsigned char ch:utf8) {
    if(ch<0x20||ch==0x7f)return {};
    if(ch=='\"'||ch=='\\')json.push_back('\\');
    json.push_back(static_cast<char>(ch));
  }
  json.push_back('\"');
  return json;
}

static std::wstring SendNativeUacReview(const std::wstring& reason,
    std::string& reviewId) {
  auto escaped=ToJsonString(reason);
  if(escaped.empty())return kRejected;
  const std::string request="{\"type\":\"uac-review\",\"reason\":"+escaped+"}";
  char answer[4096]{};
  DWORD returned=0;
  // Message-mode pipe. This is a bounded synchronous operation only for
  // review submission; it NEVER issues or submits a Windows credential.
  BOOL ok=CallNamedPipeW(L"\\\\.\\pipe\\Hi5CentralEpmPilot",
      const_cast<char*>(request.data()),static_cast<DWORD>(request.size()),
      answer,sizeof(answer)-1,&returned,8000);
  if(!ok||returned>=sizeof(answer))return kUnavailable;
  const std::string response(answer,answer+returned);
  if(response.find("\"success\":true")!=std::string::npos &&
      response.find("\"credentialReleaseEnabled\":false")!=std::string::npos) {
    const std::string needle="\"requestId\":\"";
    auto offset=response.find(needle);
    if(offset==std::string::npos)return kRejected;
    offset+=needle.size();
    if(offset+36>=response.size()||response[offset+36]!='\"')return kRejected;
    auto candidate=response.substr(offset,36);
    for(size_t i=0;i<candidate.size();i++) {
      char c=candidate[i];
      if((i==8||i==13||i==18||i==23) ? c!='-' :
         !(c>='0'&&c<='9'||c>='a'&&c<='f'||c>='A'&&c<='F'))
        return kRejected;
    }
    reviewId=candidate;
    return kReviewSent;
  }
  return kRejected;
}


static std::wstring FetchNativeUacReviewStatus(const std::string& id) {
  if(id.size()!=36)return kRejected;
  const std::string message="{\"type\":\"uac-review-status\",\"requestId\":\""+id+"\"}";
  char buffer[4096]{};
  DWORD received=0;
  if(!CallNamedPipeW(L"\\\\.\\pipe\\Hi5CentralEpmPilot",
       const_cast<char*>(message.data()),static_cast<DWORD>(message.size()),
       buffer,sizeof(buffer)-1,&received,8000)
     ||received>=sizeof(buffer))return kUnavailable;
  const std::string response(buffer,buffer+received);
  if(response.find("\"success\":true")==std::string::npos ||
      response.find("\"credentialReleaseEnabled\":false")==std::string::npos)
    return kRejected;
  if(response.find("\"status\":\"reviewed\"")!=std::string::npos)return kReviewed;
  if(response.find("\"status\":\"pending\"")!=std::string::npos)return kStillPending;
  return kExpired;
}

class Tile final : public ICredentialProviderCredential {
  std::atomic<ULONG> refs_{1};
  ICredentialProviderCredentialEvents* events_{nullptr};
  bool selected_{false};
  bool clicked_{false};
  std::wstring reason_;
  std::wstring status_;
  std::string reviewId_;
public:
  Tile() {g_objects.fetch_add(1);}
  ~Tile() {
    if(events_) events_->Release();
    if(!reason_.empty()) SecureZeroMemory(reason_.data(),reason_.size()*sizeof(wchar_t));
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
    if(id==F_ACTION&&!reviewId_.empty())return MakeString(kCheckAction,value);
    return MakeString(kFields[id].label,value);
  }
  STDMETHODIMP GetBitmapValue(DWORD,HBITMAP*) override {return E_NOTIMPL;}
  STDMETHODIMP GetCheckboxValue(DWORD,BOOL*,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP GetSubmitButtonValue(DWORD,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueCount(DWORD,DWORD*,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueAt(DWORD,DWORD,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP SetStringValue(DWORD id,LPCWSTR input) override {
    if(id!=F_REASON||!input||!reviewId_.empty())return E_INVALIDARG;
    const size_t length=wcsnlen_s(input,513);
    if(length>512)return E_INVALIDARG;
    // This display-only pilot neither transmits nor persists the reason.
    // Reject control characters to avoid obscured/truncated prompt content.
    for(size_t i=0;i<length;i++) {
      if(input[i]<0x20 || input[i]==0x7f)return E_INVALIDARG;
    }
    std::wstring incoming(input,length);
    if(!reason_.empty())SecureZeroMemory(reason_.data(),reason_.size()*sizeof(wchar_t));
    reason_.swap(incoming);
    if(!incoming.empty())SecureZeroMemory(incoming.data(),incoming.size()*sizeof(wchar_t));
    clicked_=false;status_.clear();
    return S_OK;
  }
  STDMETHODIMP SetCheckboxValue(DWORD,BOOL) override {return E_NOTIMPL;}
  STDMETHODIMP SetComboBoxSelectedValue(DWORD,DWORD) override {return E_NOTIMPL;}
  STDMETHODIMP CommandLinkClicked(DWORD id) override {
    if(id!=F_ACTION)return E_INVALIDARG;
    clicked_=true;
    // Review is not elevation. Never authenticate or grant administrator
    // rights in the unbound/native UAC case.
    if(!reviewId_.empty())status_=FetchNativeUacReviewStatus(reviewId_);
    else if(reason_.size()<20)status_=kNeedReason;
    else status_=SendNativeUacReview(reason_,reviewId_);
    if(events_) {
      events_->SetFieldString(this,F_STATUS,status_.c_str());
      events_->SetFieldString(this,F_ACTION,
          reviewId_.empty()?kAction:kCheckAction);
    }
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
