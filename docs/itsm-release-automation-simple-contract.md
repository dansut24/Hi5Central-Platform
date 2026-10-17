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
