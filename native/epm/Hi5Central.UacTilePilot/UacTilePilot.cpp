// Hi5Central UAC research pilot — display-only Credential UI provider.
// IMPORTANT: This DLL never authenticates, serializes a credential, starts
// a process, reads a password or connects to the Hi5Central Agent.
// It supports ONLY CPUS_CREDUI. It does NOT implement a provider filter.
// The Windows password / PIN / Hello providers must remain present.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <credentialprovider.h>
#include <shlwapi.h>
#include <new>
#include <atomic>
#include "UacTilePilot.h"

namespace {
std::atomic<long> g_objects{0};

enum FieldId : DWORD {
  F_TITLE=0,
  F_DESCRIPTION=1,
  F_STATUS=2,
  F_ACTION=3,
  F_COUNT=4
};

constexpr wchar_t kTitle[] = L"Hi5Central EPM";
constexpr wchar_t kDescription[] = L"Request administrator access";
constexpr wchar_t kStatus[] =
    L"UAC research pilot only. Approval will not be submitted here.";
constexpr wchar_t kAction[] = L"How to request approval";
constexpr wchar_t kActionStatus[] =
    L"Cancel this Windows prompt, then use Run with Hi5Central admin. "
    L"Your reason and technician approval will be handled by the existing EPM service.";

static const struct {
  CREDENTIAL_PROVIDER_FIELD_TYPE type;
  const wchar_t* label;
  CREDENTIAL_PROVIDER_FIELD_STATE state;
} kFields[F_COUNT] = {
  {CPFT_LARGE_TEXT,kTitle,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kDescription,CPFS_DISPLAY_IN_BOTH},
  {CPFT_SMALL_TEXT,kStatus,CPFS_DISPLAY_IN_SELECTED_TILE},
  {CPFT_COMMAND_LINK,kAction,CPFS_DISPLAY_IN_SELECTED_TILE}
};

HRESULT MakeString(const wchar_t* value,LPWSTR* output) noexcept {
  if(!output)return E_INVALIDARG;
  *output=nullptr;
  return SHStrDupW(value,output);
}

class Tile final : public ICredentialProviderCredential {
  std::atomic<ULONG> refs_{1};
  ICredentialProviderCredentialEvents* events_{nullptr};
  bool selected_{false};
  bool clicked_{false};
public:
  Tile() {g_objects.fetch_add(1);}
  ~Tile() override {
    if(events_) events_->Release();
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
    if(id==F_STATUS&&clicked_)return MakeString(kActionStatus,value);
    return MakeString(kFields[id].label,value);
  }
  STDMETHODIMP GetBitmapValue(DWORD,HBITMAP*) override {return E_NOTIMPL;}
  STDMETHODIMP GetCheckboxValue(DWORD,BOOL*,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP GetSubmitButtonValue(DWORD,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueCount(DWORD,DWORD*,DWORD*) override {return E_NOTIMPL;}
  STDMETHODIMP GetComboBoxValueAt(DWORD,DWORD,LPWSTR*) override {return E_NOTIMPL;}
  STDMETHODIMP SetStringValue(DWORD,LPCWSTR) override {return E_NOTIMPL;}
  STDMETHODIMP SetCheckboxValue(DWORD,BOOL) override {return E_NOTIMPL;}
  STDMETHODIMP SetComboBoxSelectedValue(DWORD,DWORD) override {return E_NOTIMPL;}
  STDMETHODIMP CommandLinkClicked(DWORD id) override {
    if(id!=F_ACTION)return E_INVALIDARG;
    clicked_=true;
    if(events_)events_->SetFieldString(this,F_STATUS,kActionStatus);
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
  ~Provider() override {g_objects.fetch_sub(1);}
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
    *defaultCredential=CREDENTIAL_PROVIDER_NO_DEFAULT;
    *autoLogon=FALSE;
    // Never contribute a tile to Windows sign-in/unlock or restrictive
    // Credential UI contexts that require an actual auth package.
    const DWORD restrictive=CREDUIWIN_GENERIC|CREDUIWIN_IN_CRED_ONLY|CREDUIWIN_AUTHPACKAGE_ONLY;
    *count=(scenario_==CPUS_CREDUI&&(flags_&restrictive)==0)?1:0;
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
  ~Factory() override {g_objects.fetch_sub(1);}
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
DllGetClassObject(REFCLSID clsid,REFIID iid,void** output) {
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

extern "C" __declspec(dllexport) HRESULT STDAPICALLTYPE DllCanUnloadNow() {
  return g_objects.load()==0?S_OK:S_FALSE;
}

BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID) {
  if(reason==DLL_PROCESS_ATTACH)DisableThreadLibraryCalls(instance);
  return TRUE;
}
