// API feasibility test ONLY. No real Windows accounts, no administrator
// passwords, no UAC submission, no credential provider registration.
// Proves the Windows CREDUI wire-buffer roundtrip using invented test data.
#include <windows.h>
#include <wincred.h>
#include <credui.h>
#include <vector>
#include <string>
#include <iostream>

static void Require(bool ok,const wchar_t* msg)
{
    if(!ok){std::wcerr<<L"FAIL: "<<msg<<L"\n";ExitProcess(1);}
}
int wmain()
{
    wchar_t username[]=L"EXAMPLE\\H5CSyntheticOnly";
    wchar_t password[]=L"NotARealWindowsPassword_2026!";
    DWORD needed=0;
    BOOL first=CredPackAuthenticationBufferW(0,username,password,nullptr,&needed);
    Require(!first&&GetLastError()==ERROR_INSUFFICIENT_BUFFER&&needed>0&&needed<16384,
        L"CredPack size-query contract");
    std::vector<BYTE> packed(needed);
    BOOL packedOk=CredPackAuthenticationBufferW(
        0,username,password,packed.data(),&needed);
    Require(packedOk,L"synthetic CredPackAuthenticationBufferW");
    wchar_t outputUsername[256]{};
    wchar_t outputDomain[256]{};
    wchar_t outputPassword[256]{};
    DWORD userChars=256,domainChars=256,passChars=256;
    BOOL decoded=CredUnPackAuthenticationBufferW(
        0,packed.data(),needed,
        outputUsername,&userChars,outputDomain,&domainChars,
        outputPassword,&passChars);
    Require(decoded,L"synthetic CredUnPackAuthenticationBufferW");
    Require(std::wstring(outputUsername).find(L"H5CSyntheticOnly")!=std::wstring::npos,
        L"synthetic user identity preserved");
    Require(std::wstring(outputPassword)==L"NotARealWindowsPassword_2026!",
        L"synthetic password preserved within current process");
    SecureZeroMemory(packed.data(),packed.size());
    SecureZeroMemory(password,sizeof(password));
    SecureZeroMemory(outputPassword,sizeof(outputPassword));
    std::wcout<<L"PASS: Windows credential packing API with synthetic credentials only.\n";
    std::wcout<<L"PASS: no Windows account created, no UAC prompt, no authentication.\n";
    return 0;
}
