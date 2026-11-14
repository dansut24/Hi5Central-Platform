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
