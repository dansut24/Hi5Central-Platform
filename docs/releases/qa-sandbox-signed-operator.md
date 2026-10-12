# QA sandbox release operator — runbook

**Status: controlled implementation awaiting host prerequisites and explicit operator approval.**

This is a restricted validation route for the two Hi5Central QA tenants. It is NOT
a general public Production deploy mechanism. Signing a plan, staging a
container, recording a database offer and activating a public route are
separate operations.

## Exact scope

| Allowed target | Gateway | Reason |
| --- | --- | --- |
| h5c-managed-qa26-test.hi5central.com | hi5central-test-gateway | Managed preview |
| h5c-custom-qa26-test.hi5central.com | hi5central-test-gateway | Custom preview |
| h5c-custom-qa26-uat.hi5central.com | hi5central-uat-gateway | Customer acceptance |

**Excluded:** Managed UAT, all QA Production hosts, all other customer hosts,
generic Caddy wildcard handlers and the root Production API.

## One-time requirements — reviewed independently

1. Register a dedicated, isolated release runner with the label
   `h5c-qa-release`. Never attach a generic public-PR runner directly to
   Production Docker. Restrict it to the protected `develop` branch.
2. Configure the GitHub environment `QA Sandbox Release Approval` with required
   reviewers and protected branches, and set its protected variable
   `HI5_QA_RELEASE_WORKFLOW_ENABLED=true` only after review.
   The workflow intentionally cannot create these controls.
3. Provision separate Test/UAT API+ITSM pairs for each QA tenant, locked with
   `RUNTIME_ENVIRONMENT=test|uat`, `VERSIONED_POOL_TENANT_SLUG=<exact slug>`,
   matching immutable `org.opencontainers.image.revision` labels and signed
   local image IDs. Do NOT reuse an unrestricted pooled API with other tenants.
4. The gateway owner must install and review unique
   `# HI5_RUNTIME_ROUTE_BEGIN <env>:<slug>` and matching END markers in the
   *inner* Test or UAT Caddy gateway, with exactly one tenant API and one
   frontend upstream. Check their precedence over generic fallbacks.
   No release job adds arbitrary site blocks automatically.
5. Verify the root edge already forwards that exact public host to the correct
   inner gateway, with existing cookies, MFA and TLS intact. Record the old
   frontend AND API SHA from the public URLs. If an old public endpoint returns
   HTML rather than immutable JSON, first correct that baseline via an
   **independently approved** routing change; do not waive rollback checks.
6. Keep the Ed25519 private release-authority key off GitHub and off the
   release runner. The trusted public key must be provisioned independently at
   `/etc/hi5central/release-authority.pub`. Issue fresh per-host intents
   externally into `/opt/hi5central/release-authorisations/<candidate SHA>/<target>.json`
   and a matching `.sig` file. No untrusted browser can issue an intent.
   The signed payload includes: exact QA hostname/environment, previous and
   new SHA, old/new API and web upstreams, current inner gateway config
   SHA-256, route generation, 15-minute validity window, signed local API
   and frontend image IDs, gateway identity, `qa_sandbox_only` scope,
   `QA Sandbox Release Approval` environment and CI evidence run ID.
7. The host's independent enablement
   `HI5_QA_SANDBOX_ROUTE_APPLY_ENABLED=true` is required for apply.
   Without all gates the operation must fail before any route change.

## Workflow and dry-run

Run [QA Release Plan (Read-Only)](../../.github/workflows/qa-release-plan.yml)
to observe the public SHA. It makes no deployment changes and produces an
unsigned report. Customer-facing release notes must use a valid version label
such as `2026.10.12-rc1`, not `2026.10.12-QA1`.

After authorised intent creation, run
[QA Sandbox Route Approval (Signed Host)](../../.github/workflows/qa-sandbox-route-approval.yml)
on reviewed `develop`. Select one of `managed-test`, `custom-test` or
`custom-uat`, provide the exact commit SHA, and leave **Apply = false**
for the first run. The signed intent is read only from the trusted host.

The host dry-run validates the Ed25519 signature, scope, candidate Caddy
configuration and expected pre-cutover Caddy checksum. No Docker or route
changes occur in dry-run.

Only after required reviewers, full image and gateway checks, verified
rollback baseline, and an audited dry-run may the protected workflow be run
with **Apply = true** and the separate host switch enabled.

## Activation and rollback semantics

Activation changes a single *inner sandbox gateway*, never the root wildcard
or another customer's tenant. The host operator checks that the previous
frontend and API route share the declared rollback SHA. It preserves a durable
before-image, writes to the gateway's existing Caddy volume, validates the
configuration and checks the public frontend and API SHA and login endpoint.
On any failed post-activation check it restores the before-image and verifies
the previous public version. The audit record says
`host_verified_control_plane_attestation_pending`; it is not an
automatic customer assignment or UAT acceptance.

If an operation fails to restore public traffic to the signed previous SHA,
**stop**. Escalate rather than retrying an unsafe deployment.

## Customer acceptance and Production restrictions

Custom UAT must have evidence of login/MFA, navigation, record access and
mobile layout. After explicit customer approval, a separate Production
release operation still requires a signed route intent and independently
verified rollback. Managed customers have no customer UAT and only become
eligible after the actual published release is at least 24 hours old and a
permitted maintenance window is open.

Do not set release-offer or assignment rows manually to pretend a public route
changed. Central control-plane attestation must be recorded after real
public-host proof, not inferred from a GitHub Actions success badge.
