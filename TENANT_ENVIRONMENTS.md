# Managed tenant environments — implementation contract

Status: **Phase 1 foundation in `develop`; NOT ready for customer UAT/Test access.**

## Hostname contract

| Scope | Example | Purpose |
| --- | --- | --- |
| Platform Admin | `admin.hi5central.com` | Central tenants, ownership, subscription and billing |
| Internal Dev | `dev.hi5central.com` | Engineering and platform change ledger |
| Customer Production | `acme.hi5central.com` | Stable customer workspace |
| Customer UAT | `acmeuat.hi5central.com` | Beta/stable release validation and configuration promotion |
| Customer Test | `acmetest.hi5central.com` | Disposable, resettable configuration/testing |

Managed customer slugs may not end in `uat` or `test`; this reserves suffix hosts.
Existing ambiguous slugs must be audited and resolved before enabling production routing.
Legacy RMM/Portal hostnames remain supported for the live environment.

## Release channels are not customer configuration promotion

- A Hi5Central **platform release** is an immutable, signed set of API, ITSM,
  Portal, RMM and Admin artifacts. Beta is released to customer UAT; stable
  releases go to customer Production. Customer Test may track available features.
- A **customer configuration change** is a selected, auditable object (forms,
  workflows, automation, dashboards, catalogue, policies) promoted
  Test → UAT → Production with comparison and approval. Never copy sandbox
  incidents, jobs, enrolled devices, test credentials or test records as part
  of configuration promotion.
- Agent and Viewer channels are independently versioned and updated to the
  latest *compatible stable* release, without waiting for a web release.

## Cost-conscious managed architecture

For the hosted service, provision **three shared runtime environments**
(Production, UAT and Test) rather than three container stacks per customer.

- Production, UAT and Test must use **separate PostgreSQL databases, Redis
  scopes, session secrets, API tokens and agent command streams**.
- Within each environment, all tenants share application/API infrastructure
  but retain tenant_id isolation, with security tests for every route,
  background job, WebSocket and RMM control path.
- Platform Admin is an independent **central control plane**, not a customer
  tenant or environment.
- A provisioning operator must create/sync the customer's environment-local
  organisation, memberships and configuration defaults. Configuration
  promotion is an explicit, audited, allowlisted export/import operation.
- Internal Dev stays a single-tenant engineering stack. It is **not** a
  substitute for the shared customer Test/UAT infrastructure.
- Until the shared managed control plane and separate environment stores
  are deployed, the request queue cannot safely be processed.

## Provisioning and isolation — required before activation

The `tenant_environment_instances` table reserves hostnames and records
provisioning status. This **does not partition customer data**.

An environment may be marked ready/routed only after all of these exist:

1. Independent persistent data scope (database/schema or a verified,
   end-to-end tenant+environment partition with enforced access control).
2. Environment-scoped logins, cookies, API tokens, permissions and MFA; no
   cross-environment session reuse.
3. Environment-scoped RMM agent enrollment, broker commands, remote sessions,
   device policies, cached files, job queues and agent secrets.
4. Separate outbound mail/webhook/integration configuration: Test cannot send
   real messages or run Production automations by default.
5. Independent backup/restore and destructive reset operations limited to
   the Test scope, with explicit confirmation and audit.
6. DNS/TLS routing verified for the exact environment hostname; unknown
   hostnames and unprovisioned environments fail closed.
7. Tenant isolation and cross-environment regression tests are passing.

Production remains on existing routing throughout this phase. UAT/Test
are not given Production database access as a workaround.

## Work completed in Phase 1 foundation

- Hostname classification, validation and reserved naming rules for managed tenants.
- Additive environment-inventory migration (Production ready, sandboxes pending).
- Per-tenant environment cards in Platform Admin, with the internal Dev account
  distinguished from customer environments.
- Audited, role-restricted UAT/Test provisioning request queue. The request
  creates an operator task only; it **does not** create a tenant database,
  activate an environment, alter DNS or mark isolation as verified. Claimed
  requests cannot be cancelled through the customer Admin interface.
- Requests can only be queued from a managed multi-tenant control plane for
  active tenants with reserved pending/failed environment identities.
- Customer UAT/Test frontend fail-closed landing page.
- API and ITSM hostname tests in the container workflow.
- Dev database migration syntax/backfill validated in a transaction and rolled back.

## Phase 3 — environment-scoped runtime and operator preflight

The managed multi-tenant UAT and Test API runtimes use:
- `TENANCY_MODE=multi`, `DEPLOYMENT_MODE=managed`, `RUNTIME_ENVIRONMENT=uat|test`.
- Environment-specific customer hostnames (`acmeuat.hi5central.com` etc.).
- Strict HTTPS origin matching, including separate RMM/Portal origins.
- Environment-specific workspace and portal session cookie names; no
  parent-domain `COOKIE_DOMAIN` on UAT/Test.
- Separate PostgreSQL and Redis backing services for each runtime.

`managed_runtime_database_identity` (migration 133) starts **empty**.
An infrastructure operator must independently inspect the target
PostgreSQL service and manually attest its environment, instance and root
domain before any provisioning can proceed. Do not stamp this table from a
client-supplied hostname or an unauthenticated request.

The preflight script is read-only and requires distinct control and target
database connections. Example (run on the secured operator machine, with
secrets supplied by its secret store, **not** in source control):

```sh
PROVISION_REQUEST_ID="<approved request UUID>" \\
TARGET_ENVIRONMENT="uat" \\
ROOT_DOMAIN="hi5central.com" \\
CONTROL_DATABASE_URL="<central-control-plane-DB-secret>" \\
TARGET_DATABASE_URL="<isolated-uat-DB-secret>" \\
node services/api/scripts/tenant-environment-preflight.mjs
```

It checks request state, tenant lifecycle, reserved hostname, target database
identity, schema presence, and that the customer does not already exist in
the target environment. **A passing preflight permits only further setup**:
it does not create a customer tenant, issue logins, enable agents or mark an
environment ready. Activation additionally requires scoped Redis, RMM, MFA,
permissions, integration/egress restrictions, verified DNS/TLS and a tested
cross-tenant isolation suite.

The currently deployed `dev`, `uat` and `test` VPS stacks remain in
single-tenant mode. **Do not flip them to multi-tenant or enable wildcard
routing until their account/session/agent safety checks and operator flow
have been validated in a dedicated pilot.** Existing customer Production
routing and cookies remain unchanged.

## Phase 4 — suspended customer tenant preparation (source-only)

Migration `134_managed_environment_tenant_bootstrap.sql` introduces a unique
environment-local provenance record. A guarded operator command is available
at `services/api/scripts/tenant-environment-prepare.mjs`.

**Prerequisites:** a central managed *multi-tenant* control-plane database;
separately provisioned UAT and Test databases; their migration history
(including 133/134); operator-attested runtime identities; a real pending
tenant/environment provisioning request; and tightly scoped database
credentials from a secret store. **Do not run this against Hi5Central Dev
(single-tenant), legacy Production, or a customer database with existing
records.** The scripts are deliberately not bundled into the public API
container and must be run from a controlled operator workspace with the API
package dependencies installed.

The command defaults to read-only `--check`. The explicit `--apply` mode
also requires `CONFIRM_TENANT_BOOTSTRAP` exactly equal to
`<customer-slug>:<uat|test>:<request UUID>`. Never write connection strings
or confirmation values to source control.

The worker locks the control-plane request, verifies the target database
attestation and hostname, creates a **suspended** environment-local tenant,
writes minimal `tenant_settings` (RMM disabled), and saves a unique
provenance record. It then records the control-plane request as `claimed`
and environment status as `provisioning`. Retries with matching provenance
are idempotent; conflicts fail closed. Because two PostgreSQL databases
cannot be committed atomically, a control-plane commit failure can leave
a suspended, unexposed target tenant requiring manual reconciliation.

**It intentionally does not:** copy users, passwords, MFA, memberships,
sessions, incidents, devices, policy definitions, automation data, jobs,
tokens or agent enrolment; activate a user account; issue RMM credentials;
change a hostname; mark a request completed; or mark UAT/Test Ready.

The managed UAT/Test API startup additionally verifies
`managed_runtime_database_identity` *before* initialising Redis, the RMM
broker, workers or the HTTP listener. A missing or incorrect attestation
blocks startup, without affecting single-tenant Dev or legacy Production.

Validation completed: 27 isolated runtime, authorisation and bootstrap
unit tests; SQL migration/bootstrap checked in a rolled-back Dev
PostgreSQL transaction. A disposable end-to-end pair of PostgreSQL
databases was prepared but privileged script execution was blocked by
remote-command safety checks, so the script's actual write/retry flow
**has not been integration-tested**. Temporary integration containers and
network were removed. Do not treat the operator as production-ready until
that path is tested in an authorised isolated environment.

**Remaining before activation:** multi-tenant central control plane,
environment-specific Redis credentials and queues, tenant user/MFA
enrolment, RMM agent/token/device isolation, outbound integration
restrictions, DNS/TLS exact-host routing, restore/reset boundaries,
cross-tenant access tests and a signed isolation approval.

## Phase 5 — disposable end-to-end provisioning release gate

New migrations:

- `135_managed_control_plane_identity.sql` requires independent operator
  attestation that the *source* database is a managed multi-tenant control
  plane, and deliberately creates **no attestation row** during migration.
  Internal single-tenant Dev cannot be used to provision customer identities.
- `136_isolated_tenant_hostname_trigger.sql` prevents an attested UAT/Test
  database from generating misleading `Live: ready` hostname reservations
  when a suspended environment-local tenant is created. Central managed
  control-plane reservations continue unchanged.

Both the read-only preflight and privileged identity-preparation script now
require the managed control-plane identity in addition to the UAT/Test
target database attestation. A missing/wrong identity fails closed.
The operator never inserts either identity automatically.

The **Platform Containers** API build job now runs a disposable PostgreSQL
integration test, in addition to the unit tests, *before* publishing images.
The test uses a throwaway PostgreSQL 17 container bound to localhost. Within
it the test creates three random-named, independent test databases:
control, UAT and Test. It applies the relevant real SQL migrations and
uses fictitious tenants only. Its scenarios include:

- Read-only preflight and rejection of unconfirmed writes
- Approved suspended UAT and Test identity preparation
- No users, memberships, verification credentials or active RMM settings
- Correct request transition to `claimed`/`provisioning`, never `ready`
- Idempotent retries without duplicating tenant records
- Rejection of tampered identity, wrong environment/database or unattested
  control-plane source
- A target commit with an incomplete control-plane commit requiring manual
  reconciliation (never automatic activation)
- Zero false Live-ready reservations inside an attested UAT/Test database

The integration harness is locked to the GitHub Actions runner's
`127.0.0.1` ephemeral PostgreSQL instance. It removes its temporary
databases and container when finished. No Dev/VPS/Production database
connection or real customer identity is used.

**Release status:** integration coverage is committed to `develop`, but
must be executed and pass through Platform Containers before deployment.
Do not claim the privileged writer is end-to-end verified until that
workflow is green. A green integration gate validates *suspended identity
preparation*, not customer activation or RMM Agent session isolation.

## Next increments

1. Choose and implement verified data isolation for a pilot tenant.
2. Provision separate session/auth and RMM/agent scopes; wire exact-host routing
   only once provisioning gates pass.
3. Add management operations in Platform Admin (provision/suspend, status,
   owner transfer, billing) with audit and permission checks.
4. Implement selective customer configuration promotion and safe Test reset.
5. Add change auto-discovery / Beta and stable release controls in Dev Settings.
6. Pilot on Dev, then UAT; do not change Production until complete validation.

Build the unified platform from `develop` using the manual **Platform Containers**
workflow and stage to Dev only. The older global `hi5central-test` and
`hi5central-uat` VPS stacks are not per-customer sandboxes.
