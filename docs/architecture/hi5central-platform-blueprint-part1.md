# Hi5Central SaaS architecture — Part 1: foundations and compatibility

**Status:** Proposal, 15 October 2026. **Scope:** deliverables 1–5 of the customer-approved 18-part platform specification. Implementation follows in small, independently tested changes. This document does **not** authorise a Live deployment or a database migration.

**Repository baseline:** `dansut24/Hi5Central-Platform` at `9041ed0fc0908badfd1ceb9d638215caef5e431b`, stacked above PR #69. Existing customer data, environment databases, host routing, billing, MFA, portal, ITSM, RMM, audits and QA tenants are retained.

## 1. Assumptions and decisions requiring confirmation

1. Initial residency is **UK only**, because the present IONOS VPS is a single-region deployment. Signup cannot promise EU/US residency until a provisioned region exists.
2. Use existing **one database per runtime environment** (Live/Dev/Test/UAT) and `tenant_id`-scoped operational tables, with PostgreSQL RLS where possible and restricted DB credentials. Do not introduce per-customer databases/schemas without a separate migration and cost decision. The customer specification says "schema per environment"; clarify whether physical *tenant-per-schema* isolation is mandatory.
3. ITSM and Portal are a combined versioned app; RMM is independently released and has **Production only**. Shared platform identity and billing are not version-promoted by customer actions.
4. **Managed ITSM = Live + Test** and **Custom ITSM = Live + Test + UAT**. Managed customers never get UAT or need a UAT approval. A platform Test-wave quality gate applies to Managed.
5. "Test always latest" means **latest *target* release**, with actual activation at the first permitted maintenance window. Show pending/running/current separately. No automatic update is instant.
6. Release rollback can restore prior app images, routing and reversible flags. Database rollback defaults to forward-compatible corrective migrations; *never* roll back shared schema blindly or overwrite newer operational data.
7. Internal release console proposed hostname: `releases.hi5central.com`, reserved for staff SSO + MFA; alternatively integrate in `admin.hi5central.com` with separately scoped staff privileges.
8. Sign-up offers only implemented residency regions. RMM license counts and Stripe billing remain in the central control plane.
9. A single VPS permits near-zero-downtime **application** cutovers, not highly available Postgres or true zero downtime for host failure. Explicitly document that risk and failover threshold.

## 2. System architecture and present gap

```text
                    Internet / customer verified domains
                                   |
                    Caddy (wildcard + custom TLS)
                                   |
          Edge route resolver (read-only signed route snapshot)
           hostname -> tenantId -> environment -> release pool
                        /                       \
       ITSM/Portal pools (API+web per immutable SHA)   RMM Live pools
         [Test] [UAT only Custom] [Live]          [Live only]
                | environment-scoped DB identity       |
                +---------------------+-----------------+
                                      |
                          tenant directory service
                 central users, memberships, company,
                       billing, access + SSO grants
                                      |
                             control-plane database
                        releases, routing, jobs, audit
                                      |
                      durable PostgreSQL-backed worker
                gated queue -> window -> canary -> route
                         -> verify -> rollback
```

**Current confirmed assets to extend:**

- `services/api/src/db.js` already uses `pg.Pool`, not Neon. Hono and container publishing through GHCR already work.
- `tenantEnvironmentProvisioner.js` provisions separate Test/UAT database rows, prevents copying tickets/devices/secrets and mirrors some user metadata. This is transitional: **authoritative** People/company/accounts should live only in the central directory; sandbox identity mirrors become caches/projections, never independent editors.
- `tenantEnvironmentPolicy.js` correctly maps Managed to Test-only and Custom to Test+UAT.
- Migrations 148/149 already define runtime pools, tenant runtime assignments, update offers and host route attestations. Keep these models and extend them, rather than creating a competing release system.
- `runtimePoolControl.js` currently returns `routingEnabled:false`, and `runtimePoolManagedScheduler.js` returns `activationEnabled:false`: they implement *planning and read-only gates*, **not activation**.
- **Correctness gap:** `runtimePoolPolicy.tenantReleaseEligibility` and `tenantRuntimeReleaseLifecycle.scheduleTenantLive` currently expect a UAT path for Managed. Replace that path with a **platform Test-wave attestation + soak** and no managed-tenant UAT.
- `featureFlags.js` already uses per-tenant/environment overrides. Separate code deployment from feature activation; flags can be promoted independently with allowlisted diffs and version compatibility.
- PR #69 has a verified precise-sha API/ITSM staging and controlled configuration delta path. It is **not** the multi-tenant rollout scheduler.

**Service boundary:** One pool per *version and environment*, shared by tenants assigned that version, **not one Docker container per tenant**. This limits RAM and churn on the VPS. All application requests independently authorise tenant and environment; never accept tenant identity from arbitrary request headers. Staff Dev uses a separate identity audience, MFA and synthetic-only database.

**Routes:** Root domain for marketing/signup, `dev` internal, `releases` staff, `{slug}` ITSM Live + `/portal`, `{slug}-test` ITSM Test, `{slug}-uat` Custom ITSM UAT, `{slug}-rmm` Live RMM, `{slug}-admin` customer control plane. Allocate hostnames only when product entitlement and tenant status allow them. Suffixes `test, uat, rmm, admin, dev, releases`, internal hosts and QA26 slugs are reserved. Test UAT admin/RMM aliases must not appear.

**Identity:** Central OIDC-ready identity broker exchanges single-use short-lived, environment-scoped grants into **host-only**, HttpOnly, Secure, SameSite session cookies; environment permissions come from the central directory. A tenant cannot use another tenant/environment grant. Customer support access requires a consent event, scope, expiry and visible audit. Staff Dev sessions never become implicit customer sessions.

**Data separation:** Directory truth includes legal company, addresses, People/contacts, user identifiers/MFA, tenant membership and environment grants. Operational truth includes incidents, assets, forms, SLAs, automations, notes and attachments in the relevant environment DB. Sandbox Test starts with no operational rows. Replicate *directory events only* to environment read models; do not replicate tickets, passwords, recovery secrets, or mutable shared master data. The environment app must route shared-data writes back through the central directory API with idempotency keys.

## 3. Hosting, deployment and routing

**VPS topology:** Caddy/edge, control-plane Hono API, directory API, versioned ITSM API+static web pools, dedicated RMM API/web/telemetry, worker, PostgreSQL 17, Redis for cache and bounded queues, monitoring. Isolate `dev`, `test`, `uat`, `live`, directory and RMM via networks, database users and resource ceilings. No publicly published PostgreSQL socket. Preserve existing Caddy config; migration to a new router must be *shadow read-only first*. Never restart the Caddy bind-mounted service during a routine app rollout.

**TLS:** Build/pin Caddy with `github.com/caddy-dns/ionos` if staying on IONOS DNS. Validate module compatibility, zone and DNS-01 issuance on a non-production hostname before changing certificate configuration. A move to Cloudflare DNS is an option, not a requirement. Wildcard covers `*.hi5central.com` **one DNS label**, not arbitrarily deep tenant domains. Custom domains require token/DNS ownership verification and Caddy On-Demand TLS with a strict fast permission endpoint that authorises only verified, active domain records. Renewal and DNS plugin health are monitored.

**Release artifact:** GitHub Actions builds versioned API/ITSM (and independent RMM) images; immutable SHA/digest and OCI labels signed/verified. A semver catalog release contains QA attestations, notes, flags and migrations. **Publishing a catalog release never automatically changes tenant routing**. No mutable `:latest` tag drives production assignments.

**Zero/low-downtime activation:**
1. Scheduler claims a durable tenant+env rollout idempotently, enforcing release state, freeze, time window, soak, dependencies, approval and region.
2. Host agent pre-pulls/starts the candidate pool *without stopping old pool*, runs compatibility checks, smoke tests and internal/public readiness.
3. Gateway validates a signed generation and atomically switches only the targeted tenant hostname to the already healthy pool.
4. Mark activation only after route proof plus HTTP/authenticated smoke checks; keep old pool warm through the rollback and soak window.
5. Failure: restore prior route generation, preserve idempotent result and audit, pause dependent waves and notify.
6. Old pools are retired only when no active tenant assignment/rollback hold refers to them; enforce supported version cap.

**Important:** A single host cannot survive VPS outage. Off-server status and backups are mandatory; second app host and streaming replica become the first scaling move, followed by region-specific stacks on AWS/EU/UK.

## 4. Data model and invariants

Extend existing tables and reuse migration identities:

| Logical domain | Tables (existing or proposed) | Key invariant |
|---|---|---|
| Identity | existing `tenants`, `users`, `tenant_memberships`; proposed `directory_events`, `directory_projection_offsets` | Central directory is authoritative; projection strictly versioned/idempotent |
| Environment access | existing environment access mappings; proposed `access_grants` with audience+expiry | Tenant, environment, product and host are checked on every exchange |
| Catalog | existing published release notes; proposed `release_artifacts`, `release_requirements`, `release_feature_defaults` | Immutable digest, notes and migration contract |
| Runtime | existing `platform_runtime_pools`, `tenant_runtime_assignments`, route generations | Host-proven healthy exact SHA; atomic rollbackable route generation |
| Rollouts | existing `tenant_runtime_update_offers`; proposed `tenant_rollouts`, `rollout_attempts`, `wave_gates`, `rollout_events` | Unique tenant+environment+version, durable state, lease+fencing token |
| Scheduling | proposed `maintenance_policies`, `blackout_periods`, `rollout_notifications` | IANA TZ, explicit DST decision, next eligible window, no silent override |
| Features/config | existing flag overrides/ITSM audit/promotions; proposed `release_feature_requirements` | Flags per tenant+env, reversible diffs, never copy directory records |
| Domains | proposed `tenant_domains`, `domain_verifications` | Verified+reserved host -> exactly one active tenant and product |
| Billing | existing Stripe/customer subscription lifecycle tables | Central billing entitlement gates routing and onboarding, not sandbox clones |
| Operations | proposed `backup_jobs`, `restore_drills`, `tenant_exports`, `support_access_grants` | Encryption+off-site proof, expiry and retention controls |

**Relational invariants:** Unique tenant/environment/version idempotency key; unique active tenant/environment route; immutable release digest; unique signed route generation; in-progress lease with bounded TTL/fencing; user approvals bound to tested exact release and feature/config diff hash. Make operational writes tenant-scoped with DB role restrictions and RLS where applicable.

**State machine:** `pending → scheduled → running → succeeded`; eligible failures go `failed`, then `rolled_back` where route activation occurred. Paused/blackout/insufficient soak becomes `deferred`, not `failed`. Every attempt emits a durable event and is restart-safe. Audit the actual before/after route, window used, approver, notification and rollback.

**No false identity sync:** A new account/company/contact update is written once to central directory; projects and tickets remain independent. Consumers apply monotonic directory event revisions, reject stale revisions, reconcile after outages and cannot write central rows locally. A promotion copies only approved code version, flags and allowlisted operational *configuration*; preview and conflict checks are required.

## 5. Version compatibility and database migrations

**Compatibility unit:** Treat `directory_contract_version`, `environment_schema_version`, `api_contract_version` and `release_id` separately. A release is eligible for a pool only when its declared min/max contracts cover the currently shared schema and currently supported prior running image(s). Version-pinned pools can coexist for a bounded period.

**Expand / backfill / contract:**

1. *Expand* on the correct environment/control DB: add nullable fields/new tables/indexes with no breaking semantic changes. Protect lock timeouts and migration ownership.
2. Deploy new APIs that can read old + new representations. Existing APIs remain able to read the expanded schema.
3. Backfill idempotently in bounded chunks; monitor lag, row counts and errors.
4. Start new healthy pools, switch individual tenants in their windows, verify and retain old pool.
5. *Contract only later*, after no supported pool or customer route needs old columns/API behaviours and the rollback window has passed. Separate PR/release.

**Do not** execute arbitrary `migrate` on startup or promote UAT data into Live. Migration runner owns an advisory lock and migration ledger; its invocation is a separate protected maintenance operation with compatibility CI and fresh offsite verified backup. For a shared DB, schema expand can affect other tenants outside their maintenance windows; restrict to demonstrably backward-compatible non-impacting changes or defer to a platform-wide approved window. Data-changing migrations are treated as scheduled operational change and can be paused.

**Preflight gates:** Real Live schema state, all active image manifests, user/tenant contract compatibility, approved SQL diff, lock/statement timeouts, disk and backup headroom, WAL/recovery point, dry-run in isolated restore, rollback route proof and operator maintenance window. A safe rollback switches application/flags/routes; DB recovery is a separate DR operation with a data-loss decision, not automatic `pg_restore` over customer writes.

## Delivery method (applies to later sections 6–18)

No more manual per-customer image swaps as the steady state. Implement and verify the directory contract, window/blackout engine, durable rollout worker, host route activator and release console in **narrow stacked PRs**, using existing migrations/policies. Each tranche adds integration tests that demonstrate an actual tenant moves from `queued` to `verified route` with correct schedule; a green build alone is insufficient. PR #69 remains independent and subject to its current release/approval gates. This draft is a design baseline only, not a completed deployment.
