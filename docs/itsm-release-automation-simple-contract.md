# Hi5Central ITSM — customer release automation contract

**Owner direction, 17 October 2026.** This supersedes the _user-facing workflow_ assumptions in the old six-tenant special QA release scripts. **Do not unpause or migrate Production as part of adopting this contract.** GitHub PR #79 remains draft until host, schema and database permission gates pass. This is a simplification of the flow, not permission to bypass host safety.

## The operator experience: ONE release action

1. Developers push as often as needed to GitHub. `dev.hi5central.com` runs the current Development build; `customer-test.hi5central.com` is the always-latest evaluation environment, not a prerequisite certification hop on each release. Test must not expose customer Production data.
2. In **Admin → Releases**, staff select one **exact immutable GitHub commit SHA** from the available CI-built candidates, attach version, release notes and feature entries (which may have been drafted during development), and review CI/security/schema checks plus Dev browser/API health. GitHub commit contents are fixed; if further code changes, select the NEW commit and recertify. Notes can be edited before publication; the published SHA never silently changes.
3. A single explicit **Release to customers** action certifies/publishes that exact build and queues eligible customer ITSM updates automatically. No separate user-facing “approve Test planning”, “approve UAT execution”, “approve Live execution”, manual fan-out, or repeated staff clicks for the same release. Internal guardrails remain automatic. A failed safety check blocks the single action and explains why.
4. **Managed**: immediately visible as an available release; queues a Production deployment for the **next allowed tenant maintenance window**, no mandatory UAT and no mandatory per-tenant release Test/canary or default 24-hour soak. If an explicit tenant-requested deferral/blackout exists, respect it. A queued job does not mean Production has changed.
5. **Custom**: queues UAT deployment in the next allowed maintenance window; UAT runs the selected release. After UAT checks, the **customer owner/admin** approves this exact SHA and chooses when to promote to Production. Without approval, Production stays untouched indefinitely.
6. For 10, 20, 200+ tenants, a **durable FIFO/due-time queue** uses tenant-specific IANA timezone, maintenance start/end and blackout periods. One **host cutover at a time per shared gateway**; if capacity is busy or window closes, defer to that tenant's next window, never extend a cutover past it. Retries are bounded, idempotent, and restart-safe. Same tenant can keep multiple **pending newer versions** without overlapping its active update. The history shows queued, scheduled, running, verifying, succeeded/failed/rolled-back and elapsed time.
7. Every authorised tenant administrator can request **rollback to the previous verified compatible ITSM release** from Production, with reason and confirmation. Rollback is a queue action, not an unrestricted SHA selector or direct Docker command. It pauses only that tenant's forward upgrades, validates image/database compatibility, swaps only that tenant's route, probes public API/web, and records actor/time/before/after/proof/result. A failed rollback holds the tenant and raises an operator alert. Avoid automatic downgrade of irreversible schema/data migrations. The new rollback request and tenant holds in PR #79 are **NOT** yet a working trusted host rollback; never display “completed” until host proof is durable.

## Separate Custom UAT → Live configuration changes

**NOT an application release**. A change made in Custom UAT that is tenant-owned configuration (ITSM options, workflow settings, categories etc.) may be offered for selective promotion to Live **without any new GitHub commit, version or Docker cutover**.

Existing code already provides `itsm_configuration_change_events`, `uatConfigurationPromotionRoutes.js`, `uatSelectiveConfiguration.js` and `UatSelectiveConfigurationPromotion.jsx`. Retain this and improve coverage; do not implement a second unsafe DB replication runner.

- A lightweight **read-only UAT configuration watcher** may refresh change candidates; the existing Live API already compares the UAT event ledger with Live, so use it rather than copying whole tables.
- Show per-setting friendly description and **old Live value → proposed UAT value**, author/time, and change history. Customer explicitly chooses settings to promote; apply each in a transaction with tenant ownership and compare-and-swap conflict detection. Optionally add carefully audited batch select later, not blind “copy all”.
- Scope = **allowlisted tenant-owned configuration fields only**. Shared canonical people, customers, operational ITSM tickets, RMM, billing, sessions, secrets, device data and global data **must never be copied**. Existing shared fields must not be offered as independent UAT changes. If a desired field is not currently covered, add a reviewed field-specific mapping and tests.
- Each successful promotion can be **reverted independently**, but only when the current Live value still matches the promoted value. Store immutable audit rows and expose to customer.
- Promotion changes DB application configuration **only**, and does not enqueue/deploy an ITSM application release. Feature code still requires a real published application release.

## Small implementation footprint

| Component | Responsibility | What it must NOT do |
| --- | --- | --- |
| **Release publisher (Admin request)** | Select exact CI-passing GitHub SHA, attach features/notes, one release action | Deploy raw unreviewed Dev workspace or silently retag releases |
| **Release scheduler (one poller)** | Discover active ITSM tenants; queue Managed Live or Custom UAT; enqueue customer-approved Custom Live; defer per maintenance window | Write Caddy, run Docker, impersonate customers |
| **Upgrade worker (one queue consumer with per-gateway serialization)** | Claim scheduled jobs, use restricted trusted host action to stage/apply only the named tenant & SHA, health-check and audit/rollback | Possess unrestricted root-equivalent Docker socket or use PostgreSQL superuser |
| **Custom configuration watcher (read-only)** | Surface UAT change events/diffs using existing selective promotion API | Copy databases or apply changes without customer approval |

This is **two deployment workers plus a lightweight configuration watcher**; the release-button handler is not a worker. The host's restricted, privileged deployment adapter is an internal security boundary, not another product workflow or an additional approval screen.

## Existing work to retain / simplify

- **Keep**: real certified SHA/GitHub CI verification, Dev smoke check, release notes and feature tracking, per-tenant preferences, timezone window planner, blackout logic, durable queue/event history, safe host gateway route CAS and independent rollback watchdog, customer UAT approval, selective UAT setting promotions and reverts, tenant-scoped version visibility, audit logs and rollback requests.
- **Remove from the standard customer-release flow (after tests)**: mandatory exact-release tenant Test → 30-minute soak → two-customer platform canary → Managed 24-hour delay; special six-tenant allowlist as permanent discovery; repeated user-facing stage planning/execution authorisations; hard-coded owner operations per tenant. Keep a QA-only canary mode for debugging but not as a customer release requirement.
- **Not negotiable in production**: independently verified GitHub image+schema compatibility, least-privileged DB roles, no unrestricted Docker socket from the scheduler/executor, Caddy source-of-truth reconciliation, per-tenant isolation and host route checks, global emergency pause, per-tenant rollback safety, audit and recovery. These are automatic guards, not additional staff interactions.

## Acceptance test (10 real QA tenants first)

1. Preserve original six QA tenants and intentionally provision 4 additional **isolated QA** tenants (5 Managed, 5 Custom) using the real normal onboarding path; verify ITSM entitlements and route boundaries.
2. One staff release of **new, explicitly chosen** GitHub SHA queues 5 Managed Live and 5 Custom UAT; does **not** queue Custom Live. Every due job lies inside that customer's maintenance window; restart planner and prove no duplicates. `Dev→Test` latest is independent of the release queue.
3. Observe queue staggering across different time zones/overlapping windows, up to 20 candidate customers (second pass), only one active host cutover per shared gateway, bounded retries and deferred attempts.
4. Watch real authenticated HTTPS frontend/API versions, login and tenancy after every deployment; verify no RMM or Portal cross-impact. Force one failed health check and verify the previous route automatically survives.
5. As real Custom tenant admins, approve chosen UAT builds and schedule Production, then verify only those five exact approved SHAs promote; deliberately attempt wrong SHA/cross-tenant approval and require rejection.
6. Verify **10 customer-initiated requests to roll back**, one on each tenant, including safe incompatibility denial, user confirmation, per-tenant forward hold, host route restore and audit; confirm the other nine tenants are unchanged by each. No rollback success based on metadata alone.
7. Demonstrate Custom field-only UAT → Live promotion on representative safe settings, conflict detection and revert, with no Docker release, no copying of shared tenant data and no changes to Managed.
8. Run a fresh second Dev SHA through the entire flow **without changing workers or editing code/tenant allowlists**. Only after independent security review, schema reconciliation and full real-host evidence should the operator enable general production eligibility.

## As-found discrepancies at authoring

- PR #79 (draft) currently makes exact-release tenant Test+soak and two-canary platform QA **mandatory** before Managed Live. This conflicts with the owner's direct `Dev→Release→Managed Production` contract.
- The Admin certification UI still says “verify & approve” followed by multiple stage approvals. It needs a clear single **Release to customers** action backed by one atomic certification/queue transaction, with automatic backend checks.
- Existing UAT selective configuration promotion is largely present; it should be verified and extended, **not** rebuilt as a full database copier.
- Existing rollback metadata / request API is NOT yet the customer-usable, host-executing rollback.
- The previous VPS read-only audit found six real QA tenants, global rollout paused, privileged current workers and unresolved Live Caddy drift; therefore no claim of 10 live rollouts or full automation is justified yet.

## Implementation checkpoint — 17 October 2026 (continuation)

- **Code completed on PR #79:** generic release fanout defaults to `direct_customer_release`, scheduling Managed directly to Live and Custom directly to UAT. Generic preview uses the same policy; generic cutover guards do not demand a tenant Test job or two platform canaries. The separate legacy QA path remains explicitly selectable for regressions. Custom Production still requires host-verified matching UAT plus customer-owned approval.
- **CI verified:** full Tenant Release Rollout Orchestration (including PostgreSQL tests), platform containers and related workflows passed after updating the ten-tenant test to allow a newer version to wait `pending` behind an older active release. A second synthetic SHA queued exactly five Managed Live and five Custom UAT candidates without mandatory customer Test jobs, preserving deduplication and RMM-only exclusion.
- **VPS read-only findings:** six fully onboarded ITSM QA tenants (three Managed, three Custom). Global release rollout remains `paused=true`. Generic approvals and customer rollback tables were absent on the connected Live DB. Three legacy release executors still mount the host Docker socket. No changes were made to Live host containers/routes, and no new QA tenants were provisioned.
- **One-action code now implemented but NOT live:** Admin → Releases offers **Release to customers** for an already prepared/published changelog and exact GitHub Actions run. The endpoint re-verifies official CI/Dev health, authorises the UAT/Live release paths, and inserts eligible tenant jobs atomically. Previously revoked stage rows fail closed; global pause, tenant approval, maintenance windows and trusted host gates are never bypassed. Legacy detailed stage controls are moved to Advanced. Unit and PostgreSQL scheduling coverage were added.
- **Still required before activation:** complete same-screen commit selection plus editable release features/notes (currently prepared separately in Dev), apply/reconcile missing schema and least-privileged roles, replace privileged Docker-socket host execution, complete customer-requested trusted-host rollback, verify independently updating latest-Dev Test stream, provision four more isolated QA tenants, run real HTTPS Managed/UAT/custom-production/rollback acceptance and then scale to 20. PR #79 is draft and the VPS remains globally paused.

## Continuation verified 17 October 2026 — unified publication and restricted host access

**Committed and CI-certified, still in draft PR #79:**
- The everyday Releases screen now discovers successful `qa-real-dev-release-candidate.yml` GitHub runs, selects the exact immutable commit, edits version/title/summary/feature notes, saves unfinished drafts and offers **Release to customers**. Staff do not paste an Actions URL or navigate separate approvals. `171_customer_release_preparation_drafts.sql` creates additive, SHA-scoped draft storage; Dev and central publication share one pure release-note validator.
- The one POST independently rechecks the exact GitHub run and actual Dev frontend/API health. In one database transaction it immutably publishes validated customer notes, records certification, authorises the two customer paths and creates due-time queue jobs. Any failure rolls back all DB changes. A repeated release with different notes or revoked authorisation is rejected.
- Generic scheduler and worker follow direct Managed Live / Custom UAT. Customer-approved matching UAT remains required for Custom Live. Legacy six-tenant sequential QA mode is still a separate regression path.
- Generic release executor image runs as `10001:10002`, contains no Docker CLI, never receives `/var/run/docker.sock`, and refuses to start for actual work without its private Unix socket. A separate trusted host adapter is the only intended Docker authority: it accepts bounded tenant/SHA/mode/fence requests, independently validates database lease/role/scope, serialises gateway actions and returns verified proof. Its transport is a group-restricted Unix socket; **no public HTTP listener**. The root adapter is a privileged security boundary, not an additional release queue/worker.
- CI builds planner, executor and host adapter images and checks root separation plus read-only/malformed host transport. All applicable workflows passed on the final verified commit as checked in this session. Stage-only image builds **do not** install, unpause or route anything.

**Real VPS read-only evidence:**
- Global release pause: `true`. Six onboarded real ITSM QA tenants: 3 Managed / 3 Custom. No new tenants were created and no customer route was changed.
- The connected control-plane DB is still missing `platform_release_generic_stage_approvals` (166), generic tenant scope (169), customer rollback schema (170), and new staff release drafts (171). These must be applied with migration history, ownership and least-privileged role reconciliation, not ad hoc SQL.
- The actual host-side Caddy bind source SHA-256 is `8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3`; the running `hi5central-web` mount has SHA-256 `21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050`. **Live gateway source drift is independently confirmed**, despite the remote tool container not directly seeing the host bind path. Do not force a Live cutover or silently replace either file.
- The existing running QA executor containers remain privileged, Docker-socket mounted and globally paused. The new generic image/host adapter is code + CI evidence **only**, not deployed services.

**Required to reach real live acceptance:** independently reconcile mounted/host Caddy sources and route ownership, apply approved additive migrations with restricted DB identities, install the trusted adapter and socket-only generic worker (without opening a public API), implement and verify customer-requested trusted-host rollback (not just rollback-request metadata or failed-cutover compensation), provision four additional intentionally isolated QA tenants through normal onboarding, prove actual 5 Managed / 5 Custom + rollback and Custom selective UAT configuration promotion, repeat with a second SHA, then enable general tenant admission after signoff. Do not substitute synthetic 10-tenant CI for host proof.

## 17 October 2026 follow-up — actual VPS readiness and immutable schema comparison

The host has been inspected read-only with the one-command auditor at
`deployment/qa26/audit-release-host-readiness.mjs`; the auditor is now
CI syntax-checked. **No VPS deployment, schema, route, queue or pause writes occurred.**

- Six active ITSM QA tenants: 3 Managed and 3 Custom. The 15 environment
  API-version probes return valid same-origin immutable JSON for 9 Test/UAT
  environments but HTML for all 6 Live tenants. All 6 Live frontend manifests
  and runtime configs are reachable; this does not count as passing Live API.
- Global release pause remains **true**, running jobs **zero**.
- Active-mounted Live Caddy SHA-256:
  `21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050`.
  Host bind-source SHA-256:
  `8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3`.
  Host has an older QA canary block that the active mount does not; active
  Caddy has other route changes absent from the host. Do not reload either.
- **Dry-run proof:** the reviewed tenant-scoped Caddy builder successfully
  planned six independent Live tenant routes against EACH source, and each
  resulting candidate passed Caddy syntax adaptation in a disposable,
  networkless container. No actual route or container was modified. These
  are two different valid candidates, NOT authorisation to choose one.
- Restricted generic executor images passed CI, but the three *currently
  running* legacy QA executors still mount `/var/run/docker.sock`.
- Production migration ledger has **zero** of 16 expected release migration
  entries (155–171 excluding 162, which has its own history). Do not stamp
  those entries manually: some schema objects already exist and some drift.
  Surface audit passes only 6/16 expected historical/new migration groups.
- Exact CI-to-VPS structural fingerprint comparison shows:
  **MATCH** groups 159, 163, 164, 165;
  **DRIFT** 156, 158, 160, 161;
  **MISSING** 155, 157, 166, 167.
  The remaining 168–171 objects are independently missing by direct
  readiness queries, and 170/171 are now included in the release-readiness
  manifest. Missing objects include the configuration-promotion table,
  the customer rollback tables and the editable release draft table.
  Structural fingerprints are not ACL/ownership/row-policy equivalence.
- **Safe activation order:** reconcile historical schema against canonical
  definitions with a reviewed additive-only plan; apply only audited missing
  changes and verify roles; independently reconcile Caddy source and active
  runtime while preserving all unrelated routes; verify all Live API version
  routes; then stage restricted host adapter and non-root executors. Only
  when no active jobs exist and rollback is fully tested should the fleet
  pause be released for an approved pilot of ten real QA tenants.

A green GitHub PR is **code/CI evidence**, not a Production host upgrade or
customer rollback acceptance. PR #79 remains draft, and the installed release
scheduler remains globally paused.

## 17 October 2026 — ACTUAL Production schema reconciliation completed, routing still held

A full PostgreSQL 17 custom-format backup of the existing 486 MB live control
database was saved to the **VPS-local** Docker volume
`h5c_release_79_pre_reconcile_backup`, archive
`hi5central_before_release79_20261017.dump`. `pg_restore --list` verified
the archive; SHA-256:
`e712584f76db97bef1ffa55f48fb37289916dcef7ce2a3d9d23a0255ed5edfd4`.
Do not export this private backup to a public build or CI environment.

The reviewed, guarded `deployment/qa26/reconcile-release-schema.mjs` was
tested against a disposable schema-only clone and as a **ROLLBACK-only
transaction on the real database**, then committed with the verified backup
identifier and checksum. Result:
`ddlMigrationsApplied=10`, `historicalMigrationsReconciled=6`,
`transactionCommitted=true`. These were the ten genuinely
missing/corrective migrations 155,156,157,160,166–171; six already present
historic migrations 158,159,161,163–165 were reconciled by their verified
catalog surfaces, not destructive table recreation. The migration ledger
now contains **16/16 entries**, and the read-only
`releaseMigrationReadiness.mjs` reports **16/16 passing surface checks**.
The backup does not replace verification of restore compatibility.

Immediately after commit, `platform_release_rollout_control.paused=true`,
zero jobs were running, all six active QA tenants remained present, and
production HTTPS checks for public, Dev, Admin, Live and Test sites returned
HTTP 200. No routes, Docker gateway containers, application images or
customer deployment approvals were changed.

**Three-way gateway drift now confirmed, still a hard stop:**
1. Host persisted Caddy source SHA:
   `8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3`.
2. Gateway container-mounted source SHA:
   `21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050`.
3. Adapted mounted runtime JSON SHA:
   `e694ac9b9208f155cfe3c76c79fb03873601214cc2ffd26074535d56f3ea85f1`;
   **currently loaded Caddy admin JSON SHA**:
   `32d51f1f27095a3d4681106c40c46a8090398f5d8d281619740f46b20c81ac49`.

The actual gateway runtime contains the extra exact
`marketing-preview.hi5central.com` route and a newer worker-audit Admin/API
preview upstream. The host-persisted Caddy file, meanwhile, contains older
QA-canary routes and broad redirects for some RMM/tenant hostnames that
are NOT equivalent to what is being served. Copying either file over the
currently loaded configuration could silently break other projects. The
read-only readiness audit now checks and exposes all three sources. The
pure `releaseGatewaySourceAgreement.js` component and four negative tests
are committed and passing. Its proposed privileged host-executor integration
was **blocked by safety checks** during the attempted edit; do not claim that
this protective runtime check is installed inside the production host executor.

The six existing Live tenant URLs still return HTML for same-origin
`/api/v1/updates/version`; nine Test/UAT URLs have passing immutable JSON
versions. Three existing QA executors still mount Docker's socket. The
new non-root generic worker/privileged IPC adapter remain CI artifacts,
not live installations. No real customer rollback host operation has yet
been successfully executed.

**Required remaining controlled acceptance:** approved three-way Caddy
reconciliation preserving the currently loaded preview, auth, RMM and other
tenant routes; full Live same-origin API proof; independently reviewed
restricted executor credentials and host wiring; a durable customer-rollback
host action with fence/watchdog verification; onboarding and acceptance of
ten real QA tenants; protected PR review/merge and versioned deployment.
Only then consider lifting the global rollout pause. Do not bypass a
security-blocked host change via alternate editing channels.
