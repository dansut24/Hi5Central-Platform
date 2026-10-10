# Phase 29 — Direct Production acceptance cutover

**Owner decision (10 Oct 2026):** Do not maintain the isolated pilot as the
primary testing destination. Test the actual **hi5central.com/signup** and
**admin.hi5central.com** domains. The existing four tenants are test data,
but still preserve the database and software rollback point.

## Current factual result — no public cutover yet

A production backup was taken on the VPS at
`/workspace/deployment/backups/phase29-public-onboarding-20261010/`
(mode 0700 directory, 0600 files), including a complete PostgreSQL
custom-format snapshot (40,256,772 bytes), both gateway configurations,
Compose file, and existing container/image manifest.

**Read-only-source upgrade rehearsal passed** against immutable API revision
`1a9a8a17d0277981e334a0a5fad13805b0e24338`. Docker-internal,
temporary Postgres 17, Redis and API containers restored from real
Production, applied outstanding migrations, verified the authenticated
Admin read path, and were destroyed.

| | Actual Production | Migrated temporary clone |
| --- | --- | --- |
| tenants | 4 | 4 |
| owner memberships | 3 | 3 |
| users | 9 | 9 |
| schema migrations | 124 | 152 |
| new UAT provisioning/owner intent tables | absent | present |

The real public API, Admin, signup, Caddy gateway and database are still
the legacy images. No public migrations or customer records have been
modified. The **latest** source revision (after production signup
enablement refactor) needs its own green CI and full shadow rehearsal
before cutover; do not reuse the prior revision as final approval.

## Public signup design

Signup collects company, tenant URL, owner's email/name, products only.
Managed / Custom / UAT options are reserved for authenticated onboarding.
Submit creates a pending *email-verification request*, never an active
tenant or user session. Confirm by one-time email link, then Admin
reviews the request and registers a pending environment.

The new API's production mode requires:
`DEPLOYMENT_MODE=managed`, `TENANCY_MODE=multi`,
`RUNTIME_ENVIRONMENT=live`,
`API_URL=https://api.hi5central.com`,
`ADMIN_URL=https://admin.hi5central.com`,
`MANAGED_SIGNUP_REQUESTS_ENABLED=true`,
`MANAGED_SIGNUP_LIVE_APPROVED=true`,
`MANAGED_SIGNUP_TEST_ONLY=true`,
`MANAGED_SIGNUP_TEST_EMAIL=<approved recipient>`,
`MANAGED_SIGNUP_SMTP_APPROVED=true`, and valid SMTP settings.
This allows **only the approved address** for the first real test,
rejects premature update/UAT selections and leaves the old direct
account/signup activation endpoint disabled by default. A later
unrestricted launch needs stronger trusted-proxy IP/rate limiting
and abuse controls; these test-only gates intentionally do not support
general public registration.

Production already contains one existing Platform Admin membership.
**Do not run the empty-pilot first Admin bootstrap** on Production.
Preserve existing Admin membership and migrate the existing Admin
through MFA enrolment; the approved Outlook address is a **signup test
recipient**, not automatically an existing Platform Admin.

## Recommended deployment sequence (operator-reviewed)

1. Verify disk space, restore snapshot to fresh throwaway Postgres
   and compare 4 tenants/3 owners/9 users; preserve an off-server
   backup before irreversible migrations.
2. Record and test smoke checks for legacy ITSM login/session,
   RMM agent check-ins, terminal, device updates, remote viewer/
   WebSockets and software qualification.
3. Run matching immutable new API **migration command**
   `node dist/migrate.mjs` as a one-shot on the Production DB,
   only during a deliberate maintenance window.
4. Replace only the Production API image and command with the
   verified **new immutable API** image. **Do not reuse** the
   legacy Compose `npm run migrate && npm start` command: the
   new minimal runtime image contains `dist/` only.
   Keep all existing required mounts, keys, dependencies and
   shared WebSocket routes.
5. Activate the verified Admin UI image with runtime
   `API_URL=https://api.hi5central.com`; verify existing
   Platform Admin owner identity and MFA.
6. Serve the new marketing/frontend image at normal `/signup`,
   and its immutable JS/CSS assets. Do not serve only the new
   HTML against the old API. Verify the entire browser journey.
7. Submit the single approved signup request, verify the email,
   confirm the queued item in authenticated Admin. Record no
   active customer runtime until provisioning actually completes.
8. Run isolated per-customer Custom UAT provisioning and
   reviewable tenant-specific UAT → Production change promotion
   **only after the actual executor is implemented and verified**.
9. Test the *real* Test factory reset, all-features/demo-data
   seed and UAT/Live non-impact (still not implemented).

**Rollback:** live config/image pins saved by the Phase29 backup;
reverting an image after migrations is NOT a DB rollback. Any full DB
restore must occur during an isolated maintenance window because it
reverts writes since the snapshot. Test the restore first.

## Gaps that must not be represented as working

- Public gateway/network modification from the remote executor has
  previously been denied by the deployment safety controls. Owner
  authorisation to test on Production does not override this technical
  limit; do not route via a less controlled deployment method.
- Existing RMM/ITSM shared API WebSocket and session regression has
  not yet been demonstrated on the newest images.
- New customer Production and Custom UAT runtime provisioning remains
  pending an isolation-verified deploy executor.
- `inspectCustomerConfigurationPromotion` is **read-only**
  (always returns `eligibleForExecution:false`). There is no
  customer-scoped transactional apply/rollback engine yet.
- Proposed demonstration feature is `itsm.live_chat`:
  disabled in customer's Production; enabled in customer's UAT;
  approve a false→true diff and apply only that tenant/feature.
  It is not currently registered/enforced end-to-end.
- Current global Test reset only queues/updates metadata. It is
  not a tenant-specific demo-data wipe/reseed with a factory reset.

**Acceptance means visible behaviour, not a green CI badge or queue
status alone.** No legitimate Production cutover should be reported
as completed until public routes, browsers, backend data and
rollback pass direct checks.
