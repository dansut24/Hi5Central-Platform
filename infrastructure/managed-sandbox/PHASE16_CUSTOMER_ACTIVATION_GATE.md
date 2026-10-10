# Phase 16 — controlled customer activation gate

**State: NOT APPROVED FOR REAL CUSTOMER ACTIVATION.** Phase 15's disposable
owner/requester real-image tests passed, but a synthetic fixture is not an
authenticated operator approval or a production pilot. No customer DNS/TLS,
Production application, legacy UAT/Test, or live customer record may be
changed by this phase without a separate audited release decision.

## Baseline evidence (10 October 2026)

- GitHub Actions [Phase 15 success](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38008097115)
  rebuilt, smoke-tested and published API/ITSM revision
  `10bf85b57e65b29efcebee8e5197f500ec4bebb7`.
- The authorised VPS repeated the same immutable pair with disposable, internal
  UAT/Test PostgreSQL, Redis, API, frontend and SMTP resources. It recorded
  `PHASE15_SYNTHETIC_CUSTOMER_LIFECYCLE: PASS` and
  `PHASE14_SYNTHETIC_RUNTIME_SMOKE: PASS` (exit 0).
- Owner/requester invitations, TOTP MFA, secure Portal/workspace cookies,
  requester authorisation denial, customer/environment origin isolation and
  approval/suspension revocation all passed.
- Scratch containers/networks were deleted; existing Dev revision `3307da9`
  and Production/legacy UAT/Test processes were unchanged. Unapproved host
  probes returned HTTP 404.

## Required gates — stop at first failure

1. **Independently authenticated operators:** Replace/check operator ID
   strings against separate authenticated identities. Prove requester, operator,
   reviewer and activation executor are distinct where policy requires it.
   Persist immutable approval and activation audit evidence. Exercise denial
   when the same actor attempts multiple roles.
2. **Initial owner lifecycle:** Verify the privileged first-owner
   `--check` and `--apply` flow, external provider sandbox mail delivery,
   invitation expiry and replay prevention. Add a safe cancel/revoke path for
   outstanding owner invitations and verify cancellation invalidates the link
   immediately. Never print invitation tokens.
3. **Tenant role and abuse matrix:** Exercise owner/admin/analyst/requester
   staff/Portal access and forbidden routes, cross-tenant impersonation and
   invitation issuance. Test invitation rate limit, duplicate/replay denial,
   MFA replay, and logout/session revocation in independent environments.
4. **Real browser E2E:** Validate exact hostnames, SameSite/Secure/HttpOnly
   cookies, MFA setup/login/logout, Portal navigation, workspace refusal,
   recovery and first-login UX. Use synthetic users and a private approved
   route until the operator gate is signed.
5. **Scoped mail, backups and isolation:** Use environment-specific credentials,
   restricted SMTP egress, tested database backup/restore, separate secrets
   and Redis scopes, and inspect Docker/firewall/network paths. Verify no
   UAT/Test access to Live database, storage, agents, job queues or Connect.
6. **Time-boxed pilot and rollback:** Obtain explicit separate operator
   approvals, choose exactly one pilot tenant and environment, pin signed
   image digests, prepare and verify rollback, monitoring and audit retention.
   Enable only the explicitly approved customer hostname. Test 404/421 for
   all non-approved variants before and after the change.

## Exit criteria

- Every gate above has a dated pass/fail result and linked evidence.
- A reviewer independent of the implementing operator approves the pilot.
- A pilot is first restricted to a synthetic tenant, scoped UAT/Test and
  approved hostnames; RMM/Agent/Viewer/Connect remain locked unless separately
  qualified. No global wildcard cutover or Production migration.
- Customer configuration promotion, Test reset, and Beta/Stable release rollout
  remain separate later milestones; passing identity tests does not imply
  those workflows are ready.

## Existing reusable tests/scripts

- `services/api/scripts/test-tenant-environment-prepare-integration.mjs`
  covers disposable provisioning, operator denial, first-owner email and MFA.
  It is guarded for isolated GitHub Actions only.
- `services/api/scripts/tenant-environment-owner-invite.mjs` supports owner
  `--check` / `--apply` on an explicitly selected target database.
- `services/api/scripts/tenant-environment-activate.mjs` supports
  `--check`, `--approve`, `--activate` and `--suspend`.
- `infrastructure/managed-sandbox/synthetic-runtime-smoke.mjs` with
  `HI5_PHASE15_SMOKE=1` covers actual disposable published-image flows.

**Do not run privileged apply/approve/activate against live control or
customer databases merely because the synthetic gate is green.**
