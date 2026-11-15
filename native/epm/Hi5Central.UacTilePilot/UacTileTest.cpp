// Windows CI tests the real COM DLL without registering a credential provider.
// It checks the policy boundaries, visible tile metadata, and NO-CREDENTIAL
// serialization. No UAC dialog, passwords, local admin or account changes.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <credentialprovider.h>
#include <iostream>
#include <string>
#include "UacTilePilot.h"

using DllGetClassObjectFn=HRESULT(STDAPICALLTYPE*)(REFCLSID,REFIID,void**);
using DllCanUnloadNowFn=HRESULT(STDAPICALLTYPE*)();

void Must(bool pass,const wchar_t* message) {
  if(!pass) {std::wcerr<<L"FAIL: "<<message<<L"\n";ExitProcess(1);}
}

int wmain(int argc,wchar_t** argv) {
  Must(argc==2,L"DLL path is required");
  HRESULT hr=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
  Must(SUCCEEDED(hr),L"CoInitializeEx");
  HMODULE dll=LoadLibraryW(argv[1]);
  Must(dll!=nullptr,L"LoadLibrary");
  auto getFactory=reinterpret_cast<DllGetClassObjectFn>(GetProcAddress(dll,"DllGetClassObject"));
  auto canUnload=reinterpret_cast<DllCanUnloadNowFn>(GetProcAddress(dll,"DllCanUnloadNow"));
  Must(getFactory!=nullptr&&canUnload!=nullptr,L"COM exports");
  IClassFactory* factory=nullptr;
  hr=getFactory(CLSID_Hi5CentralUacTilePilot,IID_IClassFactory,
    reinterpret_cast<void**>(&factory));
  Must(hr==S_OK&&factory!=nullptr,L"Get factory for pilot CLSID");
  ICredentialProvider* provider=nullptr;
  hr=factory->CreateInstance(nullptr,IID_ICredentialProvider,
    reinterpret_cast<void**>(&provider));
  Must(hr==S_OK&&provider!=nullptr,L"Create provider via COM factory");
  Must(FAILED(provider->SetUsageScenario(CPUS_LOGON,0)),L"must reject sign-in");
  Must(FAILED(provider->SetUsageScenario(CPUS_UNLOCK_WORKSTATION,0)),
    L"must reject unlock");
  Must(FAILED(provider->SetUsageScenario(CPUS_CHANGE_PASSWORD,0)),
    L"must reject password change");
  Must(provider->SetUsageScenario(CPUS_CREDUI,0)==S_OK,L"accept only CredUI");

  DWORD count=0,defaultCredential=0;
  BOOL autoLogon=TRUE;
  Must(provider->GetCredentialCount(&count,&defaultCredential,&autoLogon)==S_OK
    &&count==1&&autoLogon==FALSE&&defaultCredential==CREDENTIAL_PROVIDER_NO_DEFAULT,
    L"one non-default non-autologon tile");

  DWORD fields=0;
  Must(provider->GetFieldDescriptorCount(&fields)==S_OK&&fields==4,
    L"four display-only fields");
  for(DWORD i=0;i<fields;i++) {
    CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* f=nullptr;
    Must(provider->GetFieldDescriptorAt(i,&f)==S_OK&&f!=nullptr,
      L"field descriptor");
    Must(f->cpft!=CPFT_PASSWORD_TEXT&&f->cpft!=CPFT_EDIT_TEXT&&f->cpft!=CPFT_SUBMIT_BUTTON,
      L"credential entry fields prohibited");
    CoTaskMemFree(f->pszLabel);CoTaskMemFree(f);
  }
  ICredentialProviderCredential* tile=nullptr;
  Must(provider->GetCredentialAt(0,&tile)==S_OK&&tile!=nullptr,L"get tile");
  BOOL autologon=TRUE;
  Must(tile->SetSelected(&autologon)==S_OK&&!autologon,
    L"selection must not auto logon");
  LPWSTR title=nullptr;
  Must(tile->GetStringValue(0,&title)==S_OK&&title
    &&std::wstring(title).find(L"Hi5Central")!=std::wstring::npos,
    L"tile label visible");
  CoTaskMemFree(title);
  Must(tile->CommandLinkClicked(3)==S_OK,L"explanation link");
  LPWSTR details=nullptr;
  Must(tile->GetStringValue(2,&details)==S_OK&&details
    &&std::wstring(details).find(L"Cancel")!=std::wstring::npos,
    L"show safe existing EPM fallback");
  CoTaskMemFree(details);

  CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE response=CPGSR_RETURN_CREDENTIAL_FINISHED;
  CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION serialization{};
  LPWSTR status=reinterpret_cast<LPWSTR>(1);
  CREDENTIAL_PROVIDER_STATUS_ICON icon=CPSI_ERROR;
  hr=tile->GetSerialization(&response,&serialization,&status,&icon);
  Must(hr==S_OK&&response==CPGSR_NO_CREDENTIAL_NOT_FINISHED
    &&serialization.cbSerialization==0&&serialization.rgbSerialization==nullptr
    &&status==nullptr,L"never provide authentication data");
  tile->Release();

  const DWORD flags[]={CREDUIWIN_GENERIC,CREDUIWIN_IN_CRED_ONLY,CREDUIWIN_AUTHPACKAGE_ONLY};
  for(DWORD flag:flags) {
    Must(provider->SetUsageScenario(CPUS_CREDUI,flag)==S_OK,L"CredUI flags");
    count=5;
    Must(provider->GetCredentialCount(&count,&defaultCredential,&autoLogon)==S_OK
      &&count==0,L"must avoid restrictive CredUI modes");
  }
  provider->Release();factory->Release();
  Must(canUnload()==S_OK,L"COM instances fully released");
  FreeLibrary(dll);
  CoUninitialize();
  std::wcout<<L"PASS: CPUS_CREDUI only; tile metadata, no credentials, native COM lifetime\n";
  return 0;
}
