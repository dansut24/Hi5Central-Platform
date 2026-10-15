# Dev release-note publication relay — QA26

**State:** Code staged in draft PR #76; not yet deployed to running release services. Dev SHA `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0` already has a real Dev-authenticated `publication_requested` row at 2026-10-15 21:27:42 UTC. No central published record or release certification yet.

## What was missing

The existing `hi5central-release-operator` polls `/api/platform-operator/v1/actions/claim`, but it does **not** relay authenticated release-note publication requests from Dev to the central Live catalogue. The Dev UI correctly submits a request and stops; the Admin Centre cannot certify a build until centrally published.

## New isolated component

- `services/api/src/releasePublicationRelay.mjs`: an idempotent PostgreSQL row-locked relay that reads **only** the exact pinned SHA already in `publication_requested` with an authenticated Dev author and timestamp, validates its immutable customer notes through the central token-protected endpoint, reads back the central public catalogue, and updates that exact Dev request to `published` only after verifying same SHA and notes.
- `releasePublicationRelayDaemon.mjs`: `--preflight`, `--once` and bounded 15-second retry loop. Failure preserves Dev publication request for later retry; no direct central SQL publication or fabricated human approval.
- `Dockerfile.release-publication-relay`: pinned Node 22 + `pg@8.23.0`, non-root, no Docker socket or Caddyfile.
- `compose.release-publication-relay.yml`: 2 read-only file secrets and *only* the existing `hi5central-dev_hi5internal` network for Dev PostgreSQL and `hi5central` network for internal central Live API. No published ports.
- Regression tests: legitimate request, missing request, central refusal, central readback mismatch, concurrent Dev edit, invalid authority/credential/SHA, and transaction rollback — **7/7 PASS** in an isolated Docker test image.

## Deployment safety gate

1. Review PR changes/security and GitHub checks. Verify the real Dev database contains the exact staff-submitted request and that central has no conflicting immutable record.
2. Independently prepare two restricted operator-owned secret files with a connection URL for the existing Dev PostgreSQL and the existing central `RELEASE_OPERATOR_TOKEN`. Do not echo or commit their contents; make them accessible solely to the Docker Compose runtime.
3. Export only **file paths** in `QA_RELEASE_DEV_DB_SECRET_FILE` and `QA_RELEASE_OPERATOR_SECRET_FILE`. Validate the compose model and build:
   ```sh
   docker compose -f deployment/qa26/compose.release-publication-relay.yml config --quiet
   docker compose -f deployment/qa26/compose.release-publication-relay.yml build
   docker compose -f deployment/qa26/compose.release-publication-relay.yml run --rm qa-release-publication-relay --preflight
   ```
4. Start one pinned worker only after preflight, using normal approved change management. It must not inherit any release planner/worker override:
   ```sh
   docker compose -f deployment/qa26/compose.release-publication-relay.yml up -d
   docker logs --tail 30 hi5central-release-publication-relay
   ```
5. Pass criteria: `release_notes_published` log for exact `9f3cb1da...`; central catalogue row matches every field; Dev draft becomes `published` with matching timestamp; Admin Centre lists the release awaiting independent human certification. Global `platform_release_rollout_control.paused` **must still be true**, with no approved certifications and no active tenant jobs.
6. For stop/rollback, `docker compose ... down` halts polling and does **not** modify customer routes or undo valid immutable publications. Preserve Dev/central PostgreSQL backups and operator event log. Never direct-insert central publication records or flip Dev status without actual central attestation.

After a genuine Admin staff member certifies against official successful Actions run `38791420784`, check the exact six-tenant cohort and remaining Live gateway reconciliation before any unpause. Do not let this editorial relay grant GitHub certification, broaden the QA tenant allowlist, or skip the customer maintenance windows.
