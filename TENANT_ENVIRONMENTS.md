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
- Read-only per-tenant environment cards in Platform Admin.
- Customer UAT/Test frontend fail-closed landing page.
- API and ITSM hostname tests in the container workflow.
- Dev database migration syntax/backfill validated in a transaction and rolled back.

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
