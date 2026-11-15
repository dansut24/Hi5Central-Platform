# Hi5Central EPM — Windows process monitoring correction
**15 November 2026** | **Newtest Lenovo pilot only**

## Verified tests (primary VPS, `ubuntu`)
- Request `e1aada9e-ab8c-4003-a4c8-cd44ac9fc9d8` approved/redeemed on
  15 Nov 2026 at 12:49 UTC; Windows process ID 3924 was reported.
- Request `29e8a132-80a9-44c1-a82d-521ce2d02818` approved/redeemed
  at 12:53 UTC; Windows process ID 4496 was reported.
- Both processes reported `job-query-error` shortly after launch.
  **No initial EXE exit code was reported**, and no successful installation
  can be inferred from a redeemed request.
- Previous approval requests failed at `desktop-grant-protocol`, which is
  absent from these two newest records. The duplex named-pipe fix cleared
  that known blocking stage.
- Lenovo Agent 1.0.510 Running/Connected; Newtest RMM API/web HTTP 200.
- Last software patch observation for Notepad++ remains 8.9.8.1; this is
  an older observation and not proof that no installation occurred.

## Root cause
The .NET P/Invoke `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` had only
`TotalUserTime` and `TotalKernelTime` among its large integer members,
omitting `ThisPeriodTotalUserTime` and `ThisPeriodTotalKernelTime`.
The resulting 32-byte structure did not match native Windows' 48-byte
structure. Windows `QueryInformationJobObject` with information class 1
then failed. The error path closed a job configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which can immediately terminate
the just-launched installer and child processes.

Microsoft documentation:
https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information

## Fix and evidence
- Source `native/epm/Hi5Central.EpmPilot/AdminLaunch.cs`, commit
  `2c8e23552ea5cdb210635df3a2bade68f79a8326`.
- Added both missing 64-bit fields, correct 48-byte native structure.
- Extended `--self-test` to verify native size==48 and make a real
  `QueryInformationJobObject` call on an empty job object (ActiveProcesses==0).
- Windows CI run `43716436531` **passed**: compile, fail-closed self-test
  including native job accounting, publish, service install and uninstall.
- The new version is **not yet installed on the physical Lenovo**.

## Published verified updater (Newtest pilot)
`https://downloads.hi5central.com/epm/job-accounting-20261115/Upgrade-Epm-JobAccounting-20261115.ps1`

- Update script SHA-256:
  `CDC193D4421CB259891DA87D1849DDCCFA728B8AB8D90CEDDA7F9F5B14DF6879`
- CI ZIP SHA-256:
  `5DCA6DB819A7694613FCA26EE283F31BE83C6FAE1520E4D0A437C749886D7A0B`
- New EXE SHA-256:
  `7A61965321851DB6D9346422AADDFBF9C1E10846F446EAF4CD99C000D15CAAAF`
- Updater requires previously qualified duplex-pipe EXE SHA:
  `05E822197E2924F7FDD1231BB0104B0230EFF6767514D5AC9926CDA23464A9EF`.
- The updater stops if the current installed hash is unknown or an
  `H5EP*` account remains, verifies ZIP/EXE, preserves rollback while
  replacing only the EPM pilot service, then starts it. No UAC, Agent,
  Company Portal, EU or broader tenant changes.

## Next test
1. Close any old installer/error. Run checksum-verified script in admin
   PowerShell; confirm `Get-Service Hi5CentralEpmPilot` Running.
2. As standard user, run `--desktop-preflight` (no approval needed).
3. Only if PASS, right-click downloaded Notepad++ 8.9.9.1 EXE,
   request elevation, approve in Newtest RMM, launch once.
4. Verify it **remains visible and interactive**, completes installer,
   package version transitions to 8.9.9.1, and temporary H5EP account and
   added desktop ACL grant are cleaned up. Report process lifecycle / exit code.
5. Keep production release blocked until full interactive security and
   cleanup/denial/replay/timeout paths are tested. Edge/Chrome download
   prompt and automatic UAC-adjacent detection are not implemented.

**Environment:** original IONOS VPS only. Never touch EU without explicit user instruction.
