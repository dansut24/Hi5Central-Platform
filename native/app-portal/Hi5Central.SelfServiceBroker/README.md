# Independent Hi5Central Windows Self Service broker

Separate SYSTEM Windows service `Hi5CentralSelfServiceBroker`; the Windows
RMM Agent and remote-access components are not modified or restarted.

* Serves the authenticated Windows user GUI over a local-only Windows named pipe
  with ACL granting authenticated users request access but no service keys.
  Windows impersonation supplies the caller SID; client-supplied identities are
  ignored.
* Gets the existing per-device machine-DPAPI `state.dat` as SYSTEM. This is NOT
  copied, embedded in the UI, shared with a Windows user, or logged.
* HTTPS only to approved Hi5Central API hosts, with existing Agent device auth.
* Fresh server-side user/device assignments and owner-approved SHA checks still
  happen for every install/approval. Offline cache is read-only.
* Claims only `request_metadata.source='app_portal'` `patch.software` jobs via
  a dedicated authenticated endpoint (other RMM jobs remain Agent-only).
* Reuses the proven standalone PatchHost (machine-DPAPI encrypted manifests,
  SYSTEM/Administrators ACL, SHA256/WinTrust, owner-approved unsigned exception).
  The broker itself never downloads and runs a direct, unvalidated installer.
* The old Agent named pipe remains the backwards-compatible fallback during
  deployments. The two services can run simultaneously; the DB atomic job
  claim and PatchHost mutex prevent simultaneous patch execution.
* Independent broker cannot provide remote viewing, inventory collection, or
  other RMM Agent features while that Agent is stopped.

Do not deploy until Windows CI and real Lenovo smoke tests pass. Package as an
independently maintained Windows service under
`C:\Program Files\Hi5Central\SelfServiceBroker`, with SCM restart on failure.
