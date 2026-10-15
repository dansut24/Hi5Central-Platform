# Hi5Central — Admin one-click UAT → Production approval

Status: **implemented on PR #69, not deployed into Live**. This is a shared API/ITSM application release flow, distinct from customer-specific ITSM feature activation and RMM releases. A customer's UAT acceptance is necessary, but only a central Hi5Central platform owner/admin can approve a shared Production deployment.

## User journey

1. Hi5Central Dev publishes immutable release notes for an API+ITSM commit SHA; official `ghcr.io/...:sha-<commit>` images must exist. QA-only `qa26-pr69-` images do not satisfy the production release operator's artifact naming/label checks.
2. Custom tenant tests this exact published build in UAT, records which changes were accepted and test evidence, and requests Production review. A trusted UAT host relays the review to the Live central database; the tenant does not get a Docker credential.
3. A central platform owner/admin opens **admin.hi5central.com → Releases & environments → One-click UAT → Production**. The card shows Live and UAT host-observed API/ITSM revisions, review evidence and published version.
4. **Approve & queue Production** requires a browser confirmation warning that the code deployment is shared. The API rechecks active Custom policy, platform-admin membership, pending customer review, test evidence, published notes, immutable API/ITSM commit SHA and fresh, exact UAT attestation. It creates one deployment job transactionally. Duplicate pending/running jobs fail via the existing database uniqueness constraint.
5. The **separately approved native Ubuntu `managed-vps-api-itsm-v1` executor** (`deployment/qa26/managed-vps-app-release-executor.py`, currently NOT installed or enabled) claims the job using its protected service credential. It verifies the approved exact UAT image revision, backs up the target database/Compose configuration, pulls official immutable `sha-<commit>` images and checks OCI revision labels, applies reviewed migrations, updates ONLY the existing API and ITSM containers and verifies their health. On failure it attempts an image-only rollback while retaining the database backup. The existing `hi5central-release-operator` container is an unrelated legacy full-stack worker and must NEVER be enabled as a substitute. Platform Admin displays the independent executor's readiness and the verified job result.
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


## QA26 executor audit — 2026-10-14

The running `hi5central-release-operator` container is a **legacy full-stack environment-actions worker**, not the newer API/ITSM deployment-job executor. It polls `/api/platform-operator/v1/actions/claim`, requires RMM/admin web services in its health gate, and has `LIVE_PROMOTION_ENABLED=0`. It **never** calls `/api/platform-operator/v1/deployments/claim`. Do not turn on its Live flag: it would attempt full-stack actions outside the single-Live-RMM architecture.

An independent `/opt/hi5central/deployment/bin/managed-vps-release-operator.py` implementation exists on the native VPS filesystem, but **it is not running**. Its original Compose pin function assumes every `.env` or Compose file independently contains exactly one official API and ITSM image reference. The real UAT `.env` has none, and UAT needs seven layered Compose files; that script is therefore NOT ready for production installation unchanged.

**Fail-closed fix on PR #69:**
- Migration `155_app_release_executor_heartbeat.sql` stores a short-lived, authenticated heartbeat for `managed-vps-api-itsm-v1` with the required `api-itsm-live-backup-rollback` capability. It is not a deployment or an authorization grant.
- The platform-operator heartbeat endpoint accepts only that named capability with the existing private operator token, on Live only.
- The Admin Release Management API returns `executor.ready` and blocks a shared Production approval with HTTP 503 when there is no fresh (≤ 2 minute) compatible heartbeat.
- The Admin UI displays the missing-executor reason and disables **Approve & queue Production**. The old operator cannot make the button appear ready by merely being a running container.
- Tests cover wrong worker, wrong capability, expired heartbeat and valid recent report.

**Native executor implementation:** `deployment/qa26/managed-vps-app-release-executor.py` is now version-controlled and disabled by default. It derives exact existing Compose layers from the running API/ITSM container labels, validates the protected environment, restricts upgrades to API+ITSM with atomic SHA-only overrides, creates and validates a retained database backup, checks immutable official image labels and public health, attempts rollback on failed verification, and heartbeats only while enabled and healthy. CI compiles its Python source and checks the CLI. **It has not been installed or activated on the VPS.** Before installation, test its read-only preflight on native Ubuntu, review the environment and existing pinned layers, conduct an isolated failed-deployment/rollback drill, and approve the service configuration separately. Do not relabel the legacy full-stack operator as an application executor.

## QA26 reviewed build metadata

Previously deployed QA candidate `4fad62ab8578bda7c2d4aa5fdd4df8c4983257b7` has healthy Test/UAT runtime but **no OCI revision labels**, and its UAT API `release-manifest.json` reports empty SHA / `local-unversioned`. Consequently, its UAT review cannot prove an immutable build; host attestation remains the older `cb836705` snapshot.

PR #69's newer candidate `aa86db02aca44b5e83e887c4ba1b241d546f99ed` is built by a guarded CI workflow that stamps its reviewed Git SHA into the API manifest and adds the same OCI revision label to the API and ITSM images. Both labels were independently checked after pulling onto the VPS. These QA-only images are not official Production `:sha-` artifacts.

The UAT review relay now resolves the sandbox-specific slug (e.g. `h5c-custom-qa26-uat`) to the canonical Live slug using the same registered tenant UUID, requires an active Custom policy and evidence, and refuses unrelated names. Test/UAT candidate image pins now reference `aa86db02`; the image-only rollback pins reference healthy `4fad62ab`. Neither running service has been replaced by this preparation. The previously passing 12/12 public perimeter checks remained 12/12.


## Production release gate and immutable artifact staging — verified 15 October 2026

**Operational status:** PR #69 is open and unmerged; the `32747727ecb96f72b2ba4dbbc500fadf3be1df81` QA-tagged API/ITSM code was accepted in Test and Custom QA26 UAT. It is **not** an approved global Production image. Shared Live API/ITSM still run `2199e58a540ff912cccdbd137fdfbb9e8d48f3c5`. The separate native executor has NOT been installed/activated. No Live migrations, code upgrade, or settings promotion has occurred.

### Artifact publishing without changing floating Production tags

The repository's existing `.github/workflows/platform-containers.yml` supports `workflow_dispatch`. **When dispatched on a reviewed non-`main` branch**, its container matrix publishes immutable `:sha-<workflow GITHUB_SHA>` images. Its Production promotion job is restricted to a **push on `main`**, so a non-`main` manual dispatch must **not** update `:prod`/`:latest` tags. This workflow builds API, ITSM, RMM and Admin even in staging; only API/ITSM are selected for the application release and all four artifacts must be treated as unpromoted. An authorised GitHub operator must verify the dispatched ref, exact workflow run, pushed digests, OCI revision labels and all job results before using the artifacts. Do not manually relabel or re-tag QA-only images as official artifacts.

Merging PR #69 into `main` is a **separate, protected action**. A `main` push also triggers a Production image-promotion workflow that retags API, ITSM, RMM and Admin `:prod`/`:latest`. Even if their running Docker containers are pinned by SHA, assess other consumers of floating tags before merge. Do not bypass review requirements. The actual merged revision may differ from the reviewed PR head; inspect the final SHA and rebuild/requalify **that exact** revision as required.

### Exact UAT/Live release gate

1. Review the full 77-file cross-tenant PR diff and the branch-protection/reviewer state through the authorised GitHub release process. Keep existing unrelated tenant, billing, RMM/agent and Admin traffic isolated.
2. Publish official immutable `sha-<commit>` API+ITSM artifacts through approved CI; check both OCI revision labels and image digests. No `latest`, QA-only `qa26-pr69-...`, or arbitrary supplied digest may substitute.
3. Deploy the **identical official API+ITSM revision** into the existing shared UAT pool through a separately reviewed native Ubuntu release procedure; verify public API boundary checks and authenticated QA/MFA/People/history/device restrictions. The current QA-only UAT revision will not satisfy a release-executor comparison against any different official SHA. Record published release notes and the customer's genuine Custom-UAT review in the central approval queue.
4. On native Ubuntu, perform `managed-vps-app-release-executor.py preflight` only after reviewing/installing the exact source, Compose provenance and protected config; conduct an isolated fail/rollback drill **before** any later service enablement. The older full-stack operator must remain separate. No executor heartbeat means **no** Production one-click approval.
5. Preserve a fresh protected Live dump with `pg_restore --list` and `sha256sum --check`, plus previous Live API/ITSM image digests, complete Compose layers, and a recovery/rollback plan. The 15 October 2026 40 MB Live archive passed those first two checks, but a full data restore/off-host recovery test is still outstanding and an updated snapshot may be required at the eventual release window.
6. Rehearse migrations against an isolated Live-schema copy (already PASS on 15 October, with zero customer rows), then apply the **full PR migration chain in order: platform-admin 155 heartbeat, ITSM 156 safe audit values, ITSM 157 per-field promotions**, using protected normal migration bookkeeping with bounded locks and clear stop conditions. Additive DB schema is retained during any image-only rollback.
7. Following the explicit shared Live release approval, update only existing Live `api` and `itsm` services with verified official images; do not recreate Caddy, PostgreSQL, Redis, RMM or Admin as part of this step. The existing read-only Caddyfile bind-mount/inode mismatch means even a gateway restart requires a separate approved fix.
8. Verify Live sign-in/MFA, People, per-tenant access, ITSM/RMM boundaries, health and exact image labels; only then expose the customer-scoped **read-only** selective UAT settings preview. Promotion of `projects.showMilestones` from On to Off must be separately approved by an authorised customer administrator and must never be an automatic side effect of code deployment.

**Go/no-go:** No PR merge, official Live image cutover, Live SQL migration or customer configuration promotion is authorised merely because this runbook exists or because QA passed. The protected approval process, host readiness, proven rollback and current release-window evidence are mandatory.
