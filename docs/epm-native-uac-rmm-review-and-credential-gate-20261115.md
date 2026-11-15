# Hi5Central EPM — Native UAC → RMM review and administrator-credential gate

**Date:** 15 November 2026
**Target:** Newtest Lenovo only; original IONOS VPS `ubuntu`; separate EU environment never touched.

## Exact status: NOT full native UAC elevation

The user requested: from **any random Windows UAC prompt**, select Hi5Central,
enter only a reason, send an approval request to RMM, and upon technician
approval complete the **same original UAC action**. The original operation's
path or parameters must never be typed by the employee.

The Credential Provider (`CPUS_CREDUI`) can show the tile in real UAC; this
was already proven on the Lenovo. The documented API does not return a trusted
path or canonical identity for the underlying operation. Windows **can**
complete Credential UI when a provider serializes **real administrator
credentials**; an RMM approval decision itself cannot be used as such a
credential. A temporary admin identity may let an *arbitrary* UAC process run
with broad privileges, including an admin shell and child processes; simply
deleting the local account **does not revoke tokens or terminate an already
elevated process**. This is materially broader than the qualified per-file
EPM broker.

**No unrestricted/unknown-target administrator credential release was
implemented or enabled. No real random UAC end-to-end elevation test has passed.**

## Implemented in this work

### RMM backend / authorization
- New `rmm_epm_native_uac_reviews` table, migration
  `services/api/migrations/rmm/188_epm_native_uac_review.sql`.
- Agent-authenticated request at `POST /api/v1/agent/epm/uac-reviews`
  accepts a 20–512-character reason and Windows requester SID/session,
  `consent.exe` PID and process start timestamp. It does not accept an
  arbitrary claimed target EXE identity.
- Unique binding to tenant/device/session/consent PID/start time; five-minute
  expiry, rejection, review and audit.
- Status endpoint `POST /api/v1/agent/epm/uac-reviews/:id/status`.
- Technician routes `GET /api/v1/rmm/epm/uac-reviews` and
  `POST /api/v1/rmm/epm/uac-reviews/:id/decision` (review or reject only).
  Authenticated session and `rmm.software.manage` permission required;
  neither review result is a credential or permission to elevate.
- DB `credential_release_enabled` is permanently `false` by CHECK, API
  hardcodes false and `rmmEpmUacPolicy` rejects fake target claims.
  No configuration flag or accidental technician click can enable it.
- On the Newtest RMM Elevation Requests page, a **distinct native UAC
  security review queue** prominently states the underlying operation is
  unidentified and review does not elevate.

### Windows service and native UAC tile — source and CI only
- EPM broker `uac-review` uses named-pipe Windows client impersonation,
  verifies `consent.exe`/`CredentialUIBroker.exe` exact System32 image
  pathname, LOCAL SYSTEM client SID, same interactive session, UAC process
  creation time within five minutes, and interactive requester SID.
- Broker forwards the reason and verified caller identity to RMM; local
  cache binds the returned review ID to the **same Windows consent process
  instance**. `uac-review-status` revalidates instance and requester before
  asking RMM for a decision. Neither endpoint can create a local admin.
- UAC C++ Credential Provider tile has only the business reason input.
  It can submit a review and request its current technician review status.
  `GetSerialization` STILL always returns
  `CPGSR_NO_CREDENTIAL_NOT_FINISHED`, with zero authentication bytes.
- Windows CI builds and validates both code paths. A separate synthetic-only
  `CredPackAuthenticationBufferW`/`CredUnPackAuthenticationBufferW`
  test passed to establish the *technical format* of Windows credential
  serialization. It does not authenticate or create a real Windows user.
- The working original EXE EPM broker and Edge browser bridge remain
  unchanged on Lenovo; the new Windows review-only builds are staged but
  **NOT installed on the test device**.

## Test evidence

- Newtest RMM API + web running primary images
  `hi5central/rmm-api:epm-native-uac-review-20261115` and
  `hi5central/rmm-web:epm-native-uac-review-20261115`.
- API and elevation-request page HTTP 200, healthy containers; Agent
  `1.0.510` Running/Connected.
- 3/3 node policy tests passed: per-consent identity, no credential release,
  stale/invalid request/target rejection.
- Migrated review table successfully; transactional insert -> reviewed
  decision -> no pending replay, credential release false, ROLLBACK;
  0 synthetic requests persisted.
- Unauthenticated agent POST and technician GET both responded HTTP 401.
- Windows broker CI run
  https://github.com/dansut24/Hi5Central-Platform/actions/runs/43741535609
  PASSED, including existing EPM regression and UAC host policy.
- Windows tile CI run
  https://github.com/dansut24/Hi5Central-Platform/actions/runs/43742086863
  PASSED; 2/2 CTest cases including synthetic credential packing,
  isolated registration + uninstall/auto rollback.
- CI test binaries staged (original primary VPS only, do not install as
  production):
  - https://downloads.hi5central.com/epm/uac-review-ci-20261115/Hi5Central-EPM-NativeUacReview-Broker-CI.zip
    SHA256 `A891912BC7A9DD9B810E2874BC9142077B0B8A41D6508D7F178C6993F479A7C3`,
    EXE SHA256 `E7E580CE40A0104E416AEAF586952A9DC9D11CE48BB6DAF1AEBF33F60A6727CE`.
  - https://downloads.hi5central.com/epm/uac-review-ci-20261115/Hi5Central-EPM-NativeUacReview-Tile-CI.zip
    SHA256 `C574425C97F29309BA2BA5E201707E650308AED4A2DE8ABDB1F1CB4D46726F2A`,
    DLL SHA256 `2E0A40AC0D24C6D23FC0F94AB819FA39642B5712CAED17BF56FDF61B05934066`.

## Critical next engineering decision for ANY arbitrary UAC

Two *different privilege scopes* must never be presented as the same thing.

**A. File- or operation-scoped approval (least privilege)**:
Identity captured at a documented pre-launch hook, hash/signature or typed
operation verified, existing process/worker used after technician approval.
This does **not** automatically resume every native UAC prompt.

**B. Broad temporary administrator approval (arbitrary UAC)**:
A technician explicitly approves a potentially unknown Windows operation
as **unrestricted administrator execution**, not as file-limited approval.
A custom CPUS_CREDUI provider could serialize a newly generated local
administrator credential (Windows-supported technique), but it may elevate
any process the user requested, including arbitrary descendants. It must
be a separately enabled, high-privilege feature requiring at minimum:
- Distinct permission/policy and prominent technician warning describing
  unknown target and broad administrator power; no automatic approval.
- Service-verified exact consent host PID + start time, session/SID,
  one-time request and short authorization TTL.
- Ephemeral random administrator identity, no shared or vaulted
  administrator password in client UI, no saved browser credentials.
- OS-authenticated credential serialization only for the original verified
  consent instance; second request, PID reuse and replay denied.
- Durable SYSTEM cleanup even after EPM service crash/reboot, with
  account/group/profile removal and Windows token/process audit.
- Demonstrate that privileged processes/children and dangerous persistent
  changes remain a security consideration: deleting an account alone
  does NOT terminate elevated processes or revoke existing tokens.
- Independent Windows test of genuine consent.exe UI, credential packing,
  UAC return, rejection, expiry, cleanup and normal Windows provider fallback
  before installing on Newtest.
- Clear product name **Admin Session / unrestricted UAC approval**, distinct
  from signed-file EPM and scoped endpoint policy.

The user previously allowed Lenovo experimentation because the machine
could be reset. This does not remove the need to qualify the separate
risk of provisioning unrestricted administrator tokens.

## Sources
- Microsoft CPUS_CREDUI:
  https://learn.microsoft.com/en-us/windows/desktop/api/credentialprovider/ne-credentialprovider-credential_provider_usage_scenario
- Microsoft CredPackAuthenticationBuffer:
  https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credpackauthenticationbufferw
- Microsoft Credential Provider serialization:
  https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nf-credentialprovider-icredentialprovidercredential-getserialization
- Admin By Request Admin Session distinction:
  https://docs.adminbyrequest.com/features/admin-session.htm

## Continuation summary

User requested full native UAC reason -> RMM approval -> completion for a
random UAC prompt. Implemented review-only UAC request/decision backend,
frontend and authenticated Windows tile/broker source with CI tests.
Live RMM deployed and healthy; Win32 review-only builds staged, not on
Lenovo. No administrator credential release, no true random UAC completion,
and no user-facing live UAC test. Separate explicitly high-privilege Admin
Session/UAC credential mode is needed for arbitrary prompts; design and
security/cleanup tests required. Preserve original EXE broker, Agent,
browser integration and Windows UAC. Original VPS ubuntu only, no EU.
