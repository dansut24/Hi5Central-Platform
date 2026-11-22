#!/usr/bin/env python3
"""Fail-closed VM lab opt-in for Hi5Central RMM Agent 1.0.544.
Must run only AFTER v541 and v543 secure input overlays have passed."""
import sys
from pathlib import Path
root=Path(sys.argv[1])
file=root/'src/platform/windows/windows_service.cpp'
text=file.read_text(encoding='utf-8')
old='''            static bool StreamCoreRmmNewtestEligible(const std::string& deviceId,SessionMode mode) {
                if (mode != SessionMode::Console ||
                    deviceId != "8b416bc2-ba5a-42d0-9b43-777a6f47af20" ||
                    !hi5::EnabledProcessOrMachineCanary("HI5_RMM_STREAMCORE_ENGINE")) return false;
                wchar_t hostname[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD n=MAX_COMPUTERNAME_LENGTH+1;
                return GetComputerNameW(hostname,&n) &&
                       _wcsicmp(hostname,L"DESKTOP-Q9LTF1M")==0;
            }
'''
new='''            static bool StreamCoreRmmNewtestEligible(const std::string& deviceId,SessionMode mode) {
                // 544 build: preserve the enrolled/authenticated session and
                // console-only checks. Test VM is separately machine-bound
                // and never inherits the Lenovo's device enrolment.
                if (mode != SessionMode::Console ||
                    !hi5::EnabledProcessOrMachineCanary("HI5_RMM_STREAMCORE_ENGINE")) return false;
                wchar_t hostname[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD n=MAX_COMPUTERNAME_LENGTH+1;
                if (!GetComputerNameW(hostname,&n)) return false;
                if (deviceId == "8b416bc2-ba5a-42d0-9b43-777a6f47af20" &&
                    _wcsicmp(hostname,L"DESKTOP-Q9LTF1M")==0) return true;
                if (!hi5::EnabledProcessOrMachineCanary("HI5_RMM_STREAMCORE_VM_TEST_MODE") ||
                    _wcsicmp(hostname,L"DESKTOP-Q9LTF1M")==0) return false;
                char testHost[256]{};
                char testDevice[64]{};
                char testLab[32]{};
                DWORD hostLen=GetEnvironmentVariableA("HI5_RMM_STREAMCORE_VM_TEST_HOSTNAME",
                                                      testHost,sizeof(testHost));
                DWORD devLen=GetEnvironmentVariableA("HI5_RMM_STREAMCORE_VM_TEST_DEVICE_ID",
                                                     testDevice,sizeof(testDevice));
                DWORD labLen=GetEnvironmentVariableA("HI5_RMM_STREAMCORE_VM_LAB_ID",
                                                     testLab,sizeof(testLab));
                if (hostLen==0 || hostLen>=sizeof(testHost) ||
                    devLen!=36 || labLen!=6 ||
                    _stricmp(testLab,"vm-lab")!=0) return false;
                char actualHost[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD actualLen=MAX_COMPUTERNAME_LENGTH+1;
                return GetComputerNameA(actualHost,&actualLen) &&
                       _stricmp(actualHost,testHost)==0 &&
                       deviceId==testDevice;
            }
'''
assert text.count(old)==1, 'Source differs from pinned 543 eligibility guard'
text=text.replace(old,new,1)
assert 'RunSecureInputOnlyMain' not in text or 'streamcoreSecureKeyboard' in text
assert text.count('HI5_RMM_STREAMCORE_VM_TEST_DEVICE_ID')==1
assert 'streamcoreSecureKeyboard' in text
file.write_text(text,encoding='utf-8')
print('PASS VM-only dual identity gate added without changing Lenovo, secure input, authenticated UUID, pipe or codec paths')
