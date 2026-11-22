# Hi5Central RMM 1.0.544 — separate VM-Lab test-mode package

**Date:** 22 November 2026  
**Build:** https://github.com/dansut24/Hi5Central-Platform/actions/runs/45050137080  
**Branch:** `canary/streamcore-544-vm-testmode-20261122`  
**Git commit:** latest workflow source `bde138cb139ca58f89e4906684651daab1026eed` (run source)

## Scope

This test candidate integrates the actual Hi5Central Windows C++ RMM Agent 1.0.544, a separately compiled StreamCore v053 Pion/WebRTC Windows companion configured for VM-only test mode, and a copy of Viewer v054r5. The Windows installer stages the companion binary with the Agent. The viewer is still web-hosted, **not** embedded in the Windows service. This is an opt-in, unsigned, no-automatic-deployment package.

Never replace the signed-off Newtest Lenovo baseline (Agent 1.0.543, StreamCore v053, Viewer v054r4). Never use AWS EU or Lenovo registration secrets for VM-Lab.

## Hard prerequisites

1. Existing **Test VM** is registered separately as `vm-lab` in `C:\ProgramData\Hi5Central\StreamCore\device.json`. Preserve `host-token.txt` and the independent `Hi5StreamCoreVMBridgeV049` service.
2. **Separately enrol the VM as a Hi5Central RMM Agent device** in the Newtest tenant via the Admin Portal (or a designated QA tenant). A standalone StreamCore `vm-lab` registration is not a Hi5Central RMM Agent enrolment. The VPS RMM table currently contains only 2 agents, and no VM RMM Agent was identified in the latest audit. Collect the VM's new RMM device UUID; never copy the Lenovo UUID.
3. Before installing, take a VM snapshot or backup the VM's existing Agent binary, service configuration and enrollment file. The experiment does not package other devices' rollback installers. Do not uninstall the existing StreamCore VM bridge as a shortcut.
4. Obtain a **successful** GitHub Actions Windows CI run with artifact `Hi5Central-RMM-1.0.544-StreamCore-v053-VM-Lab-TestMode-DefaultOFF`. A branch commit or running workflow is not a compiled installer. Validate the artifact `manifest.json` hashes before installing.

## When GitHub run succeeds

Download the artifact ZIP from the run's **Artifacts** section, extract it on the Test VM, then run Administrator PowerShell:

```powershell
# Read-only preflight; use the UUID from the VM's Hi5Central RMM enrollment.
.\Check-Hi5Central-RMM-544-VMTest.ps1 -PackageDirectory . -RmmDeviceId '<VM-RMM-DEVICE-UUID>'
```

If it says `VM_TEST_READINESS=AGENT_NOT_INSTALLED`, install `Hi5CentralAgentSetup-1.0.544-RMM-STREAMCORE-VMTEST.exe` on that VM only, using its own authorized enrollment (not Lenovo credentials). The StreamCore flags remain **OFF by default**.

After the new Agent is installed and the VM appears online in the Hi5Central RMM Devices page, run:

```powershell
.\Check-Hi5Central-RMM-544-VMTest.ps1 -PackageDirectory . -RmmDeviceId '<VM-RMM-DEVICE-UUID>'
.\Check-Hi5Central-RMM-544-VMTest.ps1 -PackageDirectory . -RmmDeviceId '<VM-RMM-DEVICE-UUID>' -ActivateTestMode
```

This sets the exact VM hostname and RMM UUID machine flags (plus `vm-lab` identity) and restarts **only Hi5CentralAgent**, not the separate VM StreamCore bridge. It creates a VM-hostname-specific v046 qualification file allowing **VP8 initially only**. H.264/H.265/VP9/AV1 require their own VM/browser proof and must not inherit Lenovo approvals.

Launch a session **from the VM's Hi5Central RMM device page** into the web viewer:
https://newtest-rmm.hi5central.com/rmm-viewer/index.html

The old standalone StreamCore viewer `https://stream-core.hi5central.com/v047.html?vm=1` is a different app and does not validate the integrated Hi5Central RMM Agent.

## Qualification checklist

Confirm authenticated remote session start, VP8 video, 15/30/45/60 FPS selectable (actual capture FPS measured), native keyboard, mouse, Start/CAD, UAC and Winlogon, image scaling/zoom, no black screen on reconnect, and no forced H.264 → VP8 due to false-stall heuristics. Export the `graceful_media_recovery` diagnostic JSON with timestamps and compare Agent logs. No password text in diagnostics.

## Safe disable

On the same VM, while the new 1.0.544 package is still installed:

```powershell
.\Check-Hi5Central-RMM-544-VMTest.ps1 -PackageDirectory . -RmmDeviceId '<VM-RMM-DEVICE-UUID>' -DeactivateTestMode
```

This clears the VM-only test flags and restarts the actual Agent, returning to its original sender path. It does NOT undo other VM service configurations, remove credentials, or uninstall the Agent. Restore the VM snapshot if a complete installer rollback is needed. Use the exact installer version/hash from the CI manifest.

## Build artefact design

CI uses the previous validated 543 secure-input/Agent reconstruction pipeline, then patches only an explicit VM host+RMM UUID eligibility gate, verifies it, compiles v053 Go Pion RMM core from public checksum-pinned source (Go 1.25) and packages it with the 544 Windows Agent/Inno Setup installer and pinned viewer v054r5 files. The source ZIP SHA256 is `16764336053aafeef1f150a6f4fd3ac025ff1837581cca13f0980f98c9ec4166` at:
https://downloads.hi5central.com/rmm-agent-544-vm-testmode-20261122/streamcore-v053-vm-testmode-source.zip

Only **CI success and actual VM run** can establish this as a valid testable binary. Do not mark it as production-qualified or enable it on any other customer agent before successful VM testing.
