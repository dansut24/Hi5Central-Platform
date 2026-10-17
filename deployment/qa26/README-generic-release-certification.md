# Generic certified Dev → tenant releases: certification plan

**Status 2026-10-17:** generic planning, policy and approval code is a
**draft PR (#79)** stacked on pinned successful six-tenant QA PR (#76). This
is not enabled on customer Live. No generic approval rows were created on the
actual VPS and the global rollout switch remains `paused=true`.

## Release lifecycle

1. A Dev release is published with immutable API and ITSM image SHAs and
   signed-off changelog. A central platform owner/admin certifies the
   exact GitHub Actions run, security, migrations and live Dev smoke test.
2. The read-only planner discovers currently active, onboarded ITSM
   tenants and calculates the next release stage under their saved Managed
   or Custom preferences, blackout periods and IANA time zone.
3. A per-SHA, per-stage staff approval authorises **planning only**,
   requiring a reviewed change, reason, approver and 1–72h expiry. The
   database trigger independently records all authorisation modifications.
4. Generic fanout is opt-in for the scheduler, defaulting to original
   explicit QA allowlist otherwise. It runs with an advisory transaction
   lock, idempotent per-tenant release IDs, pagination and tenant-specific
   maintenance start. It does **not** touch Caddy or the Docker daemon.
5. A **separate** per-release-stage execution grant is required by
   the generic queue, the executor and the DB-fenced host cutover.
   Global fleet pause is an additional independent blocker.
6. Test → Custom UAT (if auto-staging allowed) → tenant accepted +
   explicitly scheduled Custom Production. Managed has NO UAT and
   requires the platform two-designated-Test-canary gate, soak and delay
   before Production in its own maintenance window.
7. Host cutovers save a Caddy backup before writing, verify public API
   and frontend SHA, and keep an independent recovery watchdog armed
   until the exact fenced DB verified event commits. A post-commit worker
   heartbeat failure never invalidates a durable successful upgrade.
   Failures must retire the watchdog only after independently confirmed
   restore. Generic Production Caddy dual-source drift remains NO-GO.

## Already independently tested

- 2026-10-17: six real QA Test tenants served the pinned release successfully,
  including four unattended overnight deployments, one attempt each.
- New generic planning and authorization policy tests pass locally.
- GitHub Actions PostgreSQL 17 disposable DB migrations, default DENY,
  unpaused-without-execution-approval negative check, idempotent Test
  fanout, Custom UAT and audit trigger succeeded.
- Real customer VPS read-only discovery checked six active ITSM tenants,
  existing scheduled stages, individual maintenance policies, global pause.
- No worker, approval migration, or release route changed on real host.

## Mandatory remaining gates before broad activation

- **Never conflate approved planning with deployment approval.** Audit
  the generic Admin Centre page (read-only preview and planning actions).
  No UI action should set `execution_enabled=true` or unpause the fleet.
- Require an independently reviewed, time-limited **execution** promotion
  process and access controls, plus separate kill switch and worker identity.
- Containerise the generic planner and gateway worker as reproducible
  reviewed artifacts. Confirm proper restricted PostgreSQL role with
  minimal grants; do not reuse or enlarge the six-QA Test credential.
- Rehearse exact authorized generic Test→Custom UAT and Managed/Custom
  Production cutovers and host crash/recovery with disposable/isolate
  tenant hosts. Verify Caddy source/runtime, public API/UI SHA, durable DB
  fence, lease renewal, gateway serialisation, cancellation and watchdog.
- Resolve the **actual Live Caddy dual-source drift** separately BEFORE
  attempting real generic Production activation. Do not suppress the
  drift check or globally unpause to work around it.
- Add production-readiness evidence for failed worker restart, job
  de-duplication and concurrent tenant scheduling; audit orphan and
  watchdog recovery after container death.
- Verify subscription eligibility and tenant admin communications.
- Complete versioned migrations and safe rollout of the new Admin UI
  through separate reviewed release. Enable Test in a limited wave
  FIRST; enable UAT after Test soak; enable Live only after sustained QA
  and separate customer/Hi5Central approvals.

## Read-only preview

Against a control-plane Node runtime with PostgreSQL client and a reviewed
source checkout, the new command is:

```bash
node services/api/src/genericReleasePreview.mjs --sha <APPROVED_SHA40>
```

It opens a `BEGIN READ ONLY` transaction, performs no route or DB writes,
and prints the next stage and maintenance-window decision for each eligible
tenant. Until migration 166 and explicit approved stage rows, all planning
stages show approval required.

Current Production generic release pause is deliberate; the old six-tenant
one-shot timers are not the generic release scheduler.
