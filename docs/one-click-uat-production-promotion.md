# Hi5Central — Admin one-click UAT → Production approval

Status: **implemented on PR #69, not deployed into Live**. This is a shared API/ITSM application release flow, distinct from customer-specific ITSM feature activation and RMM releases. A customer's UAT acceptance is necessary, but only a central Hi5Central platform owner/admin can approve a shared Production deployment.

## User journey

1. Hi5Central Dev publishes immutable release notes for an API+ITSM commit SHA; official `ghcr.io/...:sha-<commit>` images must exist. QA-only `qa26-pr69-` images do not satisfy the production release operator's artifact naming/label checks.
2. Custom tenant tests this exact published build in UAT, records which changes were accepted and test evidence, and requests Production review. A trusted UAT host relays the review to the Live central database; the tenant does not get a Docker credential.
3. A central platform owner/admin opens **admin.hi5central.com → Releases & environments → One-click UAT → Production**. The card shows Live and UAT host-observed API/ITSM revisions, review evidence and published version.
4. **Approve & queue Production** requires a browser confirmation warning that the code deployment is shared. The API rechecks active Custom policy, platform-admin membership, pending customer review, test evidence, published notes, immutable API/ITSM commit SHA and fresh, exact UAT attestation. It creates one deployment job transactionally. Duplicate pending/running jobs fail via the existing database uniqueness constraint.
5. The separate `hi5central-release-operator` process claims the job using its service credential, verifies the source is still running the approved image, backs up the target database/config, pulls only exact official image tags and validates OCI revision labels, applies the target migrations/image pins, and verifies running service health. On failure it restores previous pins, attempts rollback and records failure/rollback status. Platform Admin polls read-only job and host-verified version status.
6. The system never treats **queued** as **installed**. It cannot change Production through a generic `application-deployments/promote` call because that bypasses the UAT review gate. RMM is excluded from the API+ITSM workflow.

## Deployment readiness gates

- **Do not approve** if the active UAT API/ITSM host attestation is absent, stale, or at a different revision. The current VPS attestation was still reporting the previous `cb836705` revision after a later QA26 UAT deployment, so the action correctly remains disabled until the trusted operator refreshes its observation.
- **Do not approve** when a customer's submitted UAT review has not arrived at the central queue, or no official published release notes exist. QA26 had no central `platform_application_release_requests` records at the time of implementation.
- PR #69 QA-tagged images were built for isolated Test/UAT testing; they are **not** the official `:sha-` tags the Live release operator requires. Publish the reviewed production image artifacts through the standard approved CI/release process first.
- Verify backup storage, capacity, gateway restart safety and rollback before an actual shared Live deployment. The gateway currently has a bind-mounted outdated Caddyfile inode; do not restart or recreate it blindly.
- Rollout to Live must be separately reviewed. No CI build or PR merge automatically authorises an application cutover.

## Validation

CI workflow `.github/workflows/uat-production-promotion.yml` runs server promotion-gate unit tests, API runtime compilation and a real Admin Vite build. Final acceptance before enabling Production: authenticated platform-admin role tests, customer-review relay, published notes, fresh UAT host attestation, duplicate submission, actual operator claim/verified completion in an isolated environment, backup+rollback failure simulation, and customer UI/mobile smoke tests.

## Future tenant portal integration

This first UI is the **central platform administrator** approval, as it governs shared Production API/ITSM images. Tenant self-service UAT acceptance and tenant-specific feature promotion remain in the customer's Live Release Management page. Do not expose global shared-code deployment authorisation in the customer billing/`-admin` portal.
