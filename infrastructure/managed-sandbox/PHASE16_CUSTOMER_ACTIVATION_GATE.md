# Phase 16 — controlled customer activation gate

## Increment 2 — cryptographically signed activation approvals (10 October 2026)

**PASS in isolated GitHub Actions; NOT approved for real customer activation.**
[Phase 16 signed approval CI](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38009157834)
completed with exit 0 and verified the disposable PostgreSQL and UAT/Test
Redis services were removed. No customer domains, running Dev deployment,
Production, or legacy UAT/Test environments were changed.

The privileged `tenant-environment-activate.mjs` mutation modes
(`--approve`, `--activate`, `--suspend`) now require:
- A trusted Ed25519 **public-key registry file** provisioned out-of-band via
  `SANDBOX_OPERATOR_TRUST_FILE`. The file is versioned, not group/other
  writable, contains distinct principal identifiers/key IDs and refuses
  duplicated public-key fingerprints. No private signing key is held in the
  application database or source repository.
- Two separate signed assertions supplied as
  `ACTIVATION_ACTOR_ATTESTATION` and
  `ACTIVATION_REVIEWER_ATTESTATION`. The actor and reviewer must possess
  distinct trusted signing keys. Approval actors require the `operator`
  role; activating actors require `executor`; reviewers require `reviewer`.
- Assertions with the fixed audience
  `hi5central-managed-sandbox-activation`, explicit action, signer ID, role,
  customer slug, environment, control-plane request UUID, local tenant UUID,
  DB UUID, Redis UUID, unique nonce, issue timestamp and expiry (at most
  five minutes). Invalid, out-of-window, modified or cross-environment
  assertions fail closed **before a database mutation**.
- A signed approval audit and a separate activation executor distinct
  from both initial approvers. Legacy unsigned approval audit entries
  **cannot** authorise new activations. Migration
  `140_managed_operator_evidence.sql` stores only one-use SHA-256 evidence
  digests and public key identifiers; the signed assertions and private keys
  are not stored in tenant data.

GitHub Actions generates a fresh Ed25519 key pair for each synthetic role,
never stores private keys in Git, and verifies that missing, stale, tampered,
wrong-role and incorrectly scoped assertions cannot approve activation. It
also verifies valid approvals and subsequent activation/suspension.

**Important remaining trust requirements:** The registry is a trusted input,
not proof of real-world identity. Platform security must enrol and verify
actual named operators separately (prefer hardware-backed keys / enterprise
IdP), restrict who can modify the trusted registry and database credentials,
retain out-of-band signed approval receipts, rotate/revoke keys, and prove
custody and two-person separation. A caller who can substitute the trusted
registry and hold direct database write access is outside the protections
of this first iteration. No self-service or public pilot activation is enabled.

### Offline signer workflow (source-only)

The offline signing tool is
`services/api/scripts/tenant-environment-sign-attestation.mjs --sign`.
Run it on each authorised operator's separately controlled signing workstation,
not inside a public web or application container. It reads a mode-0600
Ed25519 PKCS#8 private key file and writes a **new** mode-0600, short-lived
signed-assertion file using exclusive create; it does not display private
keys or assertion values. The signing command accepts these inputs:

| Environment variable | Meaning |
| --- | --- |
| `SANDBOX_SIGNING_PRIVATE_KEY_FILE` | Operator's locally protected private key |
| `SANDBOX_SIGNING_OUTPUT_FILE` | Fresh, non-existent output path |
| `SANDBOX_SIGNING_KEY_ID`, `SANDBOX_SIGNING_OPERATOR_ID` | IDs enrolled in the separately protected trust registry |
| `SANDBOX_SIGNING_ACTION` | `approve`, `activate`, or `suspend` |
| `SANDBOX_SIGNING_ROLE` | `operator`, `reviewer`, or `executor` as appropriate |
| `TENANT_SLUG`, `TARGET_ENVIRONMENT` | Exact customer and UAT/Test |
| `PROVISION_REQUEST_ID`, `LOCAL_TENANT_ID` | Exact request and environment-local tenant |
| `DATABASE_INSTANCE_ID`, `REDIS_INSTANCE_ID` | Exact independently attested runtime scope |

A separate signing action is required for each distinct person/role and
each individual approval/activation/suspension. The operator runner verifies
the independently provisioned `SANDBOX_OPERATOR_TRUST_FILE`, receives the
two signed assertion contents, and checks that each is valid and independently
authorised. Assertions must not be committed to Git or copied into customer
records. Real users' keys, trusted key registry and automated assertion
handoff/approver identity enrolment are **not** provisioned by this phase.

The [offline signer CI and full integration run](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38009341172)
passed, including forged/expired evidence denial, key-file permissions,
trust-file tampering, existing first-owner MFA, and disposal of all temporary
databases and Redis services.

## Increment 1 — first-owner invitation cancellation (10 October 2026)

**PASS in isolated GitHub Actions, NOT activated for customers.**
[Phase 16 owner-invitation CI](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38008858567)
successfully completed on `develop` with a disposable PostgreSQL 17 database,
separate UAT/Test Redis instances and the existing isolated provisioning
harness. All temporary service containers were removed.

- The initial-owner operator CLI now accepts `--check`, `--apply`, and
  `--cancel`. The cancellation action targets precisely a single pending,
  unaccepted `owner` invitation by tenant, environment and invitee email,
  refuses a bad confirmation or another email, and cannot be replayed.
- Cancellation still works when customer approval is withdrawn or the tenant
  becomes suspended, but it refuses a mismatched database identity, bootstrap
  or customer hostname. This is a privileged database operator action, NOT
  a user-facing cancellation API.
- Both issuance and cancellation require an attributed
  `OWNER_INVITATION_OPERATOR` identifier and create operator-audit rows.
  Delivery failure revokes the pending invitation and records an audit
  outcome where the database remains available.
- Migration `139_managed_owner_invitation_audit.sql` creates a distinct
  scoped audit table with an UPDATE/DELETE rejection trigger. CI verifies
  ordinary SQL writes cannot modify committed audit records.
- CI sent first-owner invitations into its **local ephemeral SMTP sink**,
  cancelled the first link, proved the one-time token could no longer create
  a user, reissued a distinct invitation, and completed first-owner MFA.
  It also denied cancelling an already redeemed invitation.

**Remaining before pilot:** Operator identifiers are still supplied as
privileged environment variables, not bound to independently authenticated
people. Immutable database-level audit entries are not a substitute for
off-host evidence custody, production mail validation, browser E2E,
independently attested operators or operator-approved DNS/TLS activation.


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
