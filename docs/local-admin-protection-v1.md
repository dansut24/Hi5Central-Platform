# Hi5Central Local Admin Protection — implementation status (14 November 2026)

## Modes

**Native Windows LAPS** is Windows-managed, with password backup to Microsoft Entra ID or Active Directory. Hi5Central can distribute/configure Windows LAPS policies, and later trigger Reset-LapsPassword or LAPS CSP ResetPassword; Windows LAPS cannot natively back up passwords to arbitrary third-party services. Do not store duplicate directory-backed secrets in this vault.

**Hi5Central Local Admin Protection** is a separate Windows Agent implementation. It exclusively manages a dedicated Hi5-prefixed local account, by default `Hi5Recovery`. It refuses to take over an existing account, domain controllers, or systems with recognised active native/legacy Windows LAPS policy. It does not require Entra ID or Active Directory join.

## Protocol and failure recovery

1. Tenant owner or a role with `rmm.security.local_admin.rotate` registers a dedicated, not-yet-created account against one enrolled Windows agent.
2. Operator with a normally authenticated interactive session requests immediate rotation with a business reason. The API rejects clients with agent version <1.0.507 and stale/offline agents. The job contains account ID/name and prior SID only, **never a password**.
3. Updated C++ agent validates account name, Windows identity, local Windows LAPS policy and previous SID; generates a cryptographically random 40-character password with Windows BCryptGenRandom.
4. Agent sends candidate through authenticated HTTPS directly to `/api/v1/agent/laps/escrow`. API validates an agent-owned claimed job and encrypts into a separate `rmm_local_admin_rotations` row, with tenant/device/account/rotation-specific AEAD associated data. Receipt is required before changing Windows.
5. Agent uses NetUserAdd + Administrators SID resolution for a new dedicated account, or NetUserSetInfo(USER_INFO_1003) for a managed account whose SID matches. It never adopts a pre-existing similarly named account.
6. Agent posts `/api/v1/agent/laps/commit` confirming SID, job and escrow identity; API atomically activates the new record, retires/wipes superseded ciphertext and audits. The normal agent job result includes status and SID only.
7. If the Windows operation or final acknowledgement fails after escrow, the pending record transitions to `uncertain` and remains decryptable by a specially authorised technician. **Uncertain does NOT mean the candidate is the current device password.** Automatic replay of claimed sensitive jobs is disabled.
8. Reveal uses a separate `rmm.security.local_admin.read` permission, a normally authenticated interactive session (no extra five-minute MFA re-verification), an explicit reason, and an immutable-style append-only audit event. No reveal in telemetry, command outputs, activity records or inventory. HTTP response is marked no-store; the browser displays secrets only temporarily.

## Cryptography and key handling

Dedicated application-managed AES-256-GCM with 96-bit random nonces; per-device/tenant keys derived from 32-byte master key via HKDF-SHA256, plus associated data binding tenant, agent, account and rotation. Root key is provided by a host-managed read-only file `RMM_LOCAL_ADMIN_VAULT_KEY_FILE`, never committed to Git or stored in the DB. Changing/loss of root key without rewrapping prevents recovery of all encrypted credentials. **Off-host key escrow, dedicated KMS/HSM, key rotation, backup restoration tests, secret-access monitoring and external security review are required before general availability.** This version is a Newtest-only developer feature.

## Live status

- RMM API `hi5central/rmm-api:laps-vault-20261114` and UI `hi5central/rmm-web:laps-vault-20261114` deployed on original `ubuntu` VPS.
- New migration `118_local_admin_protection_vault.sql` applied individually with a pre-migration PostgreSQL custom archive under `/opt/hi5central/runtime/backups/local-admin-vault-20261114/`.
- API limits the feature to tenant `newtest` using `RMM_LOCAL_ADMIN_ENABLED_TENANT`. Secret key read through restricted `/run/secrets/rmm_local_admin_vault_key`.
- Live public smoke: RMM root 200; vault GET unauthenticated 401; agent escrow POST unauthenticated 401; web/API containers healthy.
- **No Windows local admin account has been created or password rotated yet.** Existing Lenovo agent 1.0.506 lacks native `laps.rotate` handler. New C++ agent source is in this feature branch; compile and installer rollout are necessary before a live rotation test. Do not call this end-to-end complete until agent v1.0.507+ is signed, installed, safe LAPS conflict detection has been verified on Newtest, and escrow / apply / commit / reveal are all tested against a dedicated account.
- Read/create/list/reveal routes require normal technician RBAC and session; operator UI smoke with an authenticated Newtest technician is still outstanding.
- Existing self-service portal source was preserved when producing the live API/web images from `/opt/hi5central/staging/endpoint-laps-v1-20261114`. Do not replace those images from older GitHub main without reconciling November 14 portal changes.

## Tests and outstanding follow-ups

- 23 passing Node tests for per-setting policy rules, Windows policy adapter, vault crypto and MFA guards.
- RMM web and API runtime builds pass. Windows native agent C++ needs GitHub Windows workflow verification.
- Outstanding: agent native Windows build; agent staged upgrade and dedicated Newtest account test; prove role-protected reveal without an extra MFA prompt, pending/uncertain recovery, wrong-tenant protection, database backup/restore using sealed key; implement scheduled recurring rotations and age policy; optional Windows-native LAPS ResetPassword and AD/Entra just-in-time retrieval through proper directory delegated permissions.

## Test instructions

Open Newtest RMM → Configure → Endpoint management → Local admin vault. Sign in with MFA, choose the Newtest Lenovo in the account-registration selector and register the dedicated `Hi5Recovery` account. Registration itself does not create/change the Windows account. Rotate now will remain blocked while the agent is below the secure handler minimum; after the agent build is deployed, sign in normally and enter a business justification. Never choose the built-in Administrator account for initial testing.

## 2026-11-14 Local Admin Vault MFA change

The extra five-minute MFA recency requirement has been removed from rotation and password reveal. Normal Hi5Central sign-in (including platform login MFA), tenant scoping, separate rotate/read permissions, written justification, audit logging and encrypted escrow remain enforced. Deployed to Newtest as laps-no-stepup-mfa-20261114, with 23 passing tests. Agent 1.0.508 is connected, but the initial Hi5Recovery password rotation has not yet been performed.

## 2026-11-14 17:10 — first rotation escrow query defect and correction

The operator initiated the first `Hi5Recovery` rotation on Newtest Lenovo at **17:10:07 UTC**. Job `7927b97a-616b-43db-8282-8ee5f149ea94` failed at 17:10:11 with `Server did not acknowledge secure password escrow`. PostgreSQL logged SQLSTATE `42883`; the actual escrow query compared the JSONB metadata text value `j.request_metadata->>'account_id'` directly to the bound UUID `$3`, producing `operator does not exist: text = uuid`.

Fixed the authenticated escrow SQL to compare metadata text with `r.account_id::text`, retaining the required matching tenant, Agent, claimed job, job type, source and account identity. Verified both escrow and commit SQL against the actual Newtest schema inside a transaction that was **rolled back**, leaving the original failed job and record unchanged. 26 tests passed including 3 new escrow SQL regression tests. API image `hi5central/rmm-api:laps-escrow-uuid-fix-20261114` deployed; RMM web and Windows Agent were not modified. Public unauthenticated escrow continues to return 401.

The Agent read-only Windows check confirmed **no `Hi5Recovery` account**, **no active native/legacy LAPS policy sources** at the checked registry roots, Windows DomainRole 0 (standalone workstation), and Hi5CentralAgent running. No candidate password was escrowed; no local account/password was created or changed in the failed attempt. The operator should retry **Rotate password now** from the authenticated tenant UI using an administrative reason. Do not bypass RBAC by creating rotation jobs directly in PostgreSQL. Inspect live escrow/commit/audit results after the UI retry before claiming end-to-end success.

## 2026-11-14 17:17 first escrow succeeded but local group membership failed

At 17:17:52 UTC a second Hi5Recovery rotation was requested for Newtest Lenovo (Agent 1.0.508), job `f79f6d19-b841-49f2-815f-6614c5528dd0`, rotation `3c39425f-d8ed-474e-9d4c-a2dd322fb732`. The Agent successfully escrowed an encrypted candidate at 17:17:54; it then failed with `Could not add the dedicated account to local Administrators`. The legacy native code passed the account name `.\Hi5Recovery` to NetAPI `NetLocalGroupAddMembers` at level 3, which depends on name resolution; no numeric Windows API error was retained. The Agent attempted to remove the newly-created local account and the vault marked the rotation `uncertain`. No account SID or activation receipt was recorded.

An independently executed Windows **read-only** check (job `0c017f2b-f92e-4b9e-ae45-cff8fc63dc1c`, 17:22 UTC) confirmed Hi5Recovery **does not exist**, `Administrators` resolves by well-known SID `S-1-5-32-544`, the Agent service is **LocalSystem**, and the account has no group membership. The escrowed password was not usable. At 17:27 UTC the precise failed rotation was reconciled in a tightly checked DB transaction: state `failed`, unusable encrypted candidate erased, account returned to `pending`, and append-only `rotation.reconciled_no_account` audit event recorded. Neither Windows nor another tenant account was changed by this reconciliation.

The Windows Agent 1.0.509 fix resolves the newly-created account's SID via `NetUserGetInfo(4)`, validates it, then uses `LOCALGROUP_MEMBERS_INFO_0` / `NetLocalGroupAddMembers(level 0)` against the SID-resolved BUILTIN Administrators group, avoiding account-name ambiguity and logging the non-secret Windows status code if future assignment fails. If group assignment fails, the Agent deletes the new account and verifies that its SID is absent. Only then does it report a bounded `LAPS_ACCOUNT_CREATION_ROLLED_BACK:` error. The API uses that explicit, authenticated failure marker to mark escrowed candidates `failed` and clear unusable ciphertext, retaining `uncertain` if removal cannot be verified. The RMM UI now positions reason-validation errors next to the rotation/reveal controls.

Regression tests extended to 29; API and web staging build successfully. **End-to-end success remains unproven until the 1.0.509 Windows Agent is built, installed on Newtest Lenovo and the operator performs a fresh rotation and safe reveal with reason.** Continue restricting vault feature to tenant `newtest` until complete.

## 2026-11-14 safety gate and upgrade handoff

Until the SID-based Windows Agent 1.0.509 installer is deployed, Newtest's rotation button is disabled with an explicit compatibility message, and the API rejects any LAPS rotation from Agent <1.0.509 (HTTP 409). This prevents repeated escrow/group-assignment failures on the old 1.0.508 agent, while permitting account viewing and audits. Enabling a rotation always still requires the normal authenticated, RBAC-authorised technician request.

The existing Agent upgrade script is also corrected to register a **single** +35-second scheduled-task trigger without the previous simultaneous `Start-ScheduledTask` invocation. This avoids two installer runs, which caused an earlier transient Agent access violation during the upgrade handoff. Both safeguards are retained in the GitHub source so later container releases do not undo them.

## 2026-11-14 17:45 — fixed Agent 1.0.509 deployed; Windows check passed

GitHub Windows installer workflow run **43621425673**, native Windows job **success**, artifact `Hi5Central-Windows-Agent-1.0.509-LAPSGroupSid`. Setup staged on the original VPS at `https://downloads.hi5central.com/rmm-agent/1.0.509/Hi5CentralAgentSetup.exe`, SHA-256 `991fc0e69a8bdc7dc2a742d926b6de5ecc73a1de9badb7ed71fb66063a4f551b`, verified by both GitHub artifact transfer and local SHA check.

Upgrade job `bf1f4d48-b21a-4e8d-9644-d5839e9bc36b` successfully completed with `succeeded_after_reconnect`; Agent 1.0.509 reported by RMM at **17:44:33 UTC**. The corrected once-only scheduled-task handoff was used; task result 0 and read-only Windows post-check `dd3067f7-f7c4-4f21-ab9e-293b76e0cab9` at 17:45:24 UTC confirmed Hi5CentralAgent Running (PID 11440), Hi5CentralSelfServiceBroker Running (PID 17556), Administrators group resolves by SID S-1-5-32-544, no Hi5Recovery account, no new Windows Error Reporting crash during installation.

The vault API/web remained healthy, `Hi5Recovery` registration returned to `pending` with no current rotation, both earlier rotations retained as `failed` and first unusable encrypted candidate retired; an audited `account.ready_for_retry` event cleared the now-stale upgrade warning. Newtest now requires Agent **>=1.0.509** for password-changing rotation, retains normal RBAC, business reasons and an authenticated tenant session, and displays the reveal reason requirement immediately beside controls.

**First successful account creation, secure escrow activation and password reveal are still outstanding.** A technician must initiate a fresh `Rotate password now` from the authenticated Newtest RMM UI (reason >=10 characters). After it completes, verify account SID, local Administrators SID membership, vault state active, encrypted ciphertext (without reading plaintext), commit audit, and user-authorised Reveal with reason >=12 characters. Do not programmatically insert a `laps.rotate` job to bypass the authenticated UI.
