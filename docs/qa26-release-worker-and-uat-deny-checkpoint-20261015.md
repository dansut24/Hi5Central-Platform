# QA26 release-worker and sandbox gateway checkpoint — 15 October 2026

This is an operator handover and a reproducible QA-only change record. It is **not**
authorisation to unpause the global rollout or to apply the Live disk Caddyfile.

## Actual host (hi5central-prod-01)

- Global `platform_release_rollout_control.paused=true`; there are no scheduled
  or running rollout jobs at the time of the final observed worker replacement.
- The restartable `hi5central-certified-release-planner` is running.
- Three version-independent workers `hi5central-release-executor-{test,uat,live}`
  run locally built, read-only image `hi5central-generic-release-executor:qa-live-compat-e52c`,
  built from GitHub commit `e52c7c4ac1ff94b13eda5bc42a881068328599bf`.
  All three report fresh `paused` PostgreSQL heartbeats and completed real DB preflight.
- Their prior working containers are stopped but retained as
  `hi5central-release-executor-{test,uat,live}-previous-e52c`.
  Do not discard them until the complete post-certification QA acceptance passes.

## Exact QA26 UAT denies

The active UAT gateway Caddyfile checksum is
`126c2c3a0ca0390028394c1c680578dfbced9bbf6d1faf7d870fda003b09f0ed`.

Expected HTTPS: Managed QA26 `-uat`, `-uat-portal`, `-uat-rmm` are HTTP 404;
Custom QA26 `-uat-rmm` is HTTP 404; Custom QA26 `-uat` and `-uat-portal`
remain HTTP 200, with Custom UAT's API SHA unchanged
(`4a363cf9054b0b3667fd450f36e354b704ec2166`).
The two independently validated persistent backups are:

- Docker volume `hi5central_qa_uat_route_rollback_backups`, original
  `qa26-managed-uat-deny-1792094709.Caddyfile`
- Same volume, intermediate snapshot
  `qa26-uat-alias-deny-1792095227.Caddyfile`

The active config resides in `hi5central-uat_gateway_runtime_config`, which
must be preserved/exported alongside the rollback-backup volume. A
fresh/scratch installation can reconstruct the **exact** deployed Caddyfile
byte-for-byte by taking the original UAT Caddyfile baseline and running:

```sh
node deployment/qa26/qa26-uat-deny-overlay.mjs --render previous.Caddyfile candidate.Caddyfile
```

Review the diff, verify the SHA and `caddy adapt` with the running gateway's
Caddy version, then deploy with a separate checked backup/watchdog. The
generator only creates a candidate; it never changes a running gateway.

## Generic Live cutover: required safety check

The running gateway's mounted `/etc/caddy/Caddyfile` was SHA256
`21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050`,
but the persisted `/opt/hi5central/deployment/Caddyfile` was SHA256
`8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3`.
The latter includes a pre-existing Managed QA Live canary and other unrelated
pending Auth/Admin/release-certification routing differences. The **currently
running Caddy Admin JSON is a third operational source**, and cannot be treated
as equivalent to either source file without verification.

The generic executor now refuses Live preflight/apply if mounted and persisted
sources differ. This was **proven fail-closed on the real VPS**. Do not “fix”
by blindly reloading the persisted Live file: it would activate unrelated
pending shared routes. Do not delete the legacy QA canary without a reviewed
tenant-scoped dual-source backup/restore and exact public API+web proof.

For the two existing legacy QA Live tenants only, the executor may resolve the
older SPA version from the immutable frontend manifest + explicit shared Live
API origin and an independently verified shared API version. All other
customers, and all Test/UAT paths, still require valid JSON SHA from their
real public tenant API. The helper has unit tests and is copied into the new
worker image.

## Next acceptance gate (not yet completed)

1. Reconcile Live's runtime Admin JSON, mounted source and persisted Caddyfile
   through a separate QA-only reviewed, dual-source route rehearsal with backups.
2. Add **four additional real self-onboarded QA customers**, two Managed and
   two Custom, giving 3+3 alongside the two existing QA26 customers. No synthetic
   customer or fake human approval inserts.
3. Publish an actual Dev changelog for one official immutable exact SHA and
   have a genuine Hi5Central staff member verify/certify the matching successful
   five/six-gate GitHub Actions run.
4. Preserve the existing release pause until those prerequisites pass.
   Enable only an approved QA cohort. Observe automatic Test for six; Custom
   UAT for three; policy-gated Managed Production; customer-approved Custom
   Production. Keep Managed without UAT and sandbox RMM disabled.
5. Capture for each job exact SHA, tenant/environment, scheduled window, worker,
   attempt, duration, HTTPS frontend/API proof, rollback reference and failure
   or success, plus unauthenticated protection and authorised MFA sign-in.
   Retain original containers, gateway snapshots and PostgreSQL backups until
   the final host recovery exercise succeeds.

No shared customer Production, RMM, marketing or unrelated tenant route was
changed by this QA26 UAT deny and worker compatibility update.
