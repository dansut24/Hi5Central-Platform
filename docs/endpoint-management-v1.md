# Endpoint Management v1 — implementation and LAPS boundary

This first branch provides **policy authoring and previews**, not Windows configuration enforcement. It adds tenant-scoped baselines, configuration profiles, Windows LAPS settings, and individual-setting exceptions targeted at a single device, device group (static or dynamic) or assigned user.

**Precedence:** device > group > assigned user. Conflicting same-precedence group overrides are reported as conflicts. Exclude means stop managing the selected setting, not restore a Windows default or enable a blocked feature. Removing an exception restores the policy's *desired value* at the next evaluation; no device mutation occurs in v1. Risky overrides (enabling SMBv1, disabling firewall, permitting USB storage) require an explicit acknowledgement, reason and expiry. Actions are recorded in tenant-scoped policy history.

## Windows LAPS and Hi5Central storage

Hi5Central can store Windows LAPS **configuration settings**, including selected account, password age, length, and Entra/AD backup selection. These are ordinary policy configuration, not password secrets.

Native Windows LAPS only supports backing up password data to **Microsoft Entra ID** or **Windows Server Active Directory**. It does not natively escrow passwords to a third-party RMM server. Native configuration requires checking Windows version, directory join state, Windows LAPS effective source and conflicts with CSP/GPO/Intune policy. Windows LAPS settings are device-oriented. A Hi5Central portal may later retrieve the current password just in time from Entra/AD using tightly scoped credentials; default to no duplicate storage.

For standalone/workgroup endpoints, implement a separate **Hi5Central Local Admin Protection** service, not a pretend native Windows LAPS backup destination. Design prerequisites:

1. Agent generates random passwords on the device with a secure OS RNG and uses supported Windows APIs to rotate the agreed account.
2. Authenticate uploads with a device-bound channel; accept escrow only with tenant/device verification. Encrypt passwords with AEAD and tenant-specific envelope keys. Protect key-encryption material independently of the database.
3. Require sensitive-role permission and step-up MFA for display, plus a justification, immutable audit and optional two-person approval. Avoid secrets in logs, telemetry, notifications or normal inventory.
4. Ensure successful escrow and a verified recovery path before completing rotation; handle offline devices and failed rotation gracefully.
5. Detect Windows LAPS ownership of the same account and refuse conflicting rotation. Engineer safe migration rather than dual management.
6. Threat-model key recovery, backup restoration, cross-tenant isolation and vault downtime before production release.

## Remaining work before actual endpoint control

* Signed policy revisions, agent capability inventory, effective source detection and acknowledgement protocol.
* Read/apply/verify/revert Windows adapters with OS/version gating and rollback.
* Real observed compliance timestamps, drift detection and policy conflict reporting across profiles.
* Windows LAPS health collection and supported directory password retrieval integrations.
* Independent vault and credential management workflow for standalone devices.

Run `node --test services/api/test/rmm-endpoint-setting-exceptions.mjs` to validate the pure resolver. API endpoints under `/api/v1/rmm/endpoint-management` are tenant/role scoped. New migration is `117_endpoint_policy_setting_exceptions.sql`. Do not run against production until the migration ledger and current live source baseline have been reconciled.
