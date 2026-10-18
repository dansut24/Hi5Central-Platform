# Release workers — reproducible source and PostgreSQL stage isolation

## Why this exists

The previously running release planner and Test/UAT/Live executors were built from
QA-host-local sources. Their checked-out queue and fanout logic no longer matched
GitHub main, and all four worker processes connected to PostgreSQL as the
unrestricted `hi5central` superuser. Never enable those legacy workers by
merely switching the global rollout pause to false.

This directory now contains reviewed source entrypoints, dependencies, Dockerfiles,
and an **operator-run** SQL boundary. Docker images are immutable Git-SHA
artifacts; CI publication **never activates workers or customer upgrades**.

## Reproducible builds

From the repository root:

```bash
docker build -f deployment/qa26/Dockerfile.certified-release-planner -t hi5central-release-planner:review .
docker build -f deployment/qa26/Dockerfile.tenant-release-executor -t hi5central-release-executor:review .
node --test services/api/test/restricted-release-worker-boundaries.mjs
```

The planner has no Docker CLI/socket. The three executor stages share one reviewed
image but **must** have distinct `DATABASE_URL` credentials and an exact
`RELEASE_GATEWAY=test|uat|live`. A restricted QA tenant-slug allowlist is
mandatory. Host Docker socket attachment requires separate operational approval.

The planner requires PostgreSQL login `hi5_release_planner`; the stage executors
require `hi5_release_executor_test`, `_uat`, and `_live`, respectively.
All four processes refuse to start under `hi5central` or any other login.

## Database procedure — separate approval gate

1. Verify complete schema and migration history (the source checkout does **not**
   yet contain all historical rollout migrations 150–171). Back up the real
   database and capture privilege/trigger/RLS baselines.
2. Test `deployment/qa26/sql/restricted-release-workers.sql` on an isolated
   PostgreSQL 17 instance with **schema only**, never copied customer records.
   The script creates four `NOLOGIN` roles, table grants, stage-scoped row-level
   security policies, preserves the existing Test-only canary, and provides a
   tightly validated, audited-UAT-lease-controlled function for creating a Live
   candidate. It is *not* an automatic startup migration.
3. Run `deployment/qa26/test/restricted-release-worker-stage-denials.sql`
   against that isolated clone. It wraps all synthetic DML in `ROLLBACK`.
   Test cross-stage inserts, updates and reads, planner status-only promotion,
   emergency pause denial and invalid UAT-to-Live leases. Test positive
   UAT-to-Live preparation only using fake isolated tenant, current approved
   stage, valid lease, verified route and certified release.
4. After separate operator review, apply the SQL during a controlled database
   change window. Roles remain **NOLOGIN** and cannot yet execute.
5. Provision unique, rotation-ready credentials via deployment secrets, then
   enable `LOGIN` for exactly the four roles. Never print connection strings,
   store plaintext passwords in Dockerfiles, GitHub, console output or audit logs.
6. Start **only** the new SHA-pinned containers using `--preflight` in each
   restricted role; verify no cross-stage writes and revoked old credentials.
   Keep the global rollout pause enabled.
7. Independently reconcile gateway in-memory configuration, bind-mounted file,
   host Caddyfile, tenant route CAS, and a real same-customer rollback. The
   gateway evidence from 18 Oct is stored in
   `/root/h5c-admin-work-activity-caddy-20261018/`. Do not do a full Caddy
   reload from a stale file or remove unrelated routes.

## How to admit customer upgrades after security acceptance

After CI, protected merge, database permission cutover, Caddy reconciliation
and successful fenced rollback evidence, execute in this order:

- Test on the latest release for isolated eligible pilot tenants, with exact
  immutable SHA, existing certification and independent Test execution approval.
- One Managed customer Production pilot **inside their maintenance window**
  with host-observed route verification and rollback immediately available.
- One Custom customer UAT pilot and recorded acceptance. Production requires
  explicit customer approval; UAT publication alone must never auto-promote.
- Then admit the remaining tenants according to individual maintenance windows,
  blackout rules, product entitlement, max concurrency and independent
  stage approvals. Do not assume the central API image means the customer
  frontend has been upgraded.

The reviewed QA26/QA27 customers currently show **02:00–05:00 Europe/London**
daily. Re-read each policy at execution time and never infer availability from
this note. Preserve all six cancelled historical jobs and their audit evidence.
A restart, new worker image or queue retry must never resurrect those jobs.

### Stop/rollback criteria

Any stale lease/fence, changed gateway source, missing real rollback proof,
unverified customer route, missing role/permission, or absent approval is a
**hard stop**. Do not unpause, use a privileged DB fallback, rewrite audit rows
or run live customer cutovers to force an apparently successful pilot.

## 18 Oct 2026 safety evidence

- Recovered entrypoints and supporting routing/gateway modules from exact old
  running QA worker images. Rebuilt planner and executor against reviewed
  mainline queue and certification modules, with pinned npm locks.
- Both builds passed on VPS; 4 restricted DB identity preflights passed against
  a no-network, schema-only PostgreSQL 17 clone (temporary QA-only LOGIN).
- Isolated SQL verified Test/Live and UAT/Live write denials; Test read cannot
  see Live; planner update grant restricted to status/timestamp; global pause
  has no executor UPDATE grant; legacy QA canary stays Test-only.
- Verified a rejected UAT Live offer without current approval/route proof,
  then a successful fake UAT Live offer with proper approval, active fenced
  lease, certified publication and current UAT route attestation.
- Production PostgreSQL roles and RLS were **not changed**, and no workers,
  gateway routes or tenant installations were modified by these tests.
