# QA publication relay — least-privilege administrator handover

**Scope:** Only release `2026.10.15`, immutable Dev SHA `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`. The Dev user already submitted it via authenticated UI on 15 October 2026; the request is still pending central publication.

**Do not recover or copy credentials from a running Docker container.** The remote assistant's prior secret-extraction attempt was stopped by host safety controls. This workflow creates *new*, narrowly scoped credentials through an authorised administrator terminal. No secret value should ever be sent to ChatGPT, GitHub, logs or shell-history commands.

## Architecture and privileges

- Dev PostgreSQL is `hi5central-dev-postgres-1:5432/hi5central` on Docker network `hi5central-dev_hi5internal`. Existing Dev application role `hi5central` is superuser; **do not share it with the relay**.
- Dedicated DB role `hi5_release_publisher` has `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, a three-connection cap, `SELECT` on necessary columns of only `public.hi5central_release_note_drafts`, and `UPDATE` only on `status` and `published_at`. No INSERT, DELETE, editing notes, access to other tenant tables or Live DB.
- Central publication-only bearer is entirely separate from `RELEASE_OPERATOR_TOKEN`. The Live API stores only `RELEASE_PUBLICATION_TOKEN_SHA256` (lowercase hex SHA-256 digest), with optional `RELEASE_PUBLICATION_TOKEN_SHA256_NEXT` for a planned rotation. The bearer works **only** at `POST /api/platform-operator/v1/releases/publish` **and only for the exact central-side `RELEASE_PUBLICATION_ALLOWED_SHA`**. All deployment, Admin, certification and scheduling routes remain on their existing independent authorisation paths.
- No central API publishing is possible until the **reviewed code change** in `services/api/src/releaseOperator.js` and its new `releasePublicationCredential.js` helper are deployed. Do not inject the new environment hash into the old Live API image and presume it supports this protocol.
- The one-off relay is pinned to one Dev SHA, requires real staff-submitted `publication_requested`, compares central publication/readback content, then acknowledges exactly the matching Dev row. Global rollout remains paused.

## Gate A — review and test

Before changing host credentials: GitHub CI and review for PR #76; dedicated publication bearer test, relay tests, central code changes, Dev DB rights and Docker build; confirm no third-party tenants or other Production routes are touched.

## Gate B — new Dev database role (approved administrator session ONLY)

On `hi5central-prod-01`, from the reviewed Git checkout, after a Dev DB backup:

```sh
docker exec -i hi5central-dev-postgres-1 \
  psql -X -v ON_ERROR_STOP=1 -U hi5central -d hi5central \
  < deployment/qa26/bootstrap-release-publisher-dev-only.sql
```

The SQL is deliberately **not a normal migration**. It creates `hi5_release_publisher` with **NOLOGIN, PASSWORD NULL** and the exact column-level grants. It aborts if the role already exists (do not overwrite somebody else's role). This SQL was exercised against an isolated Postgres 17 test container with privilege assertions.

## Gate C — generate NEW credentials locally

As the authorised VPS administrator, after reviewing the script:

```sh
sudo python3 deployment/qa26/provision-release-publisher-admin.py
```

The script verifies that the Dev role starts `NOLOGIN`, securely generates a random Dev password and a **separate** random publication bearer, writes two host-side files (UID 100, mode 0400, protected root directory), and sends an `ALTER ROLE ... LOGIN PASSWORD` only through **stdin to the named Dev PostgreSQL container**. It neither reads old credentials nor prints the new ones. The printed `RELEASE_PUBLICATION_TOKEN_SHA256` hash is **not** a usable bearer. It is configuration metadata for the next approved API deployment.

Paths:
- `/etc/hi5central/qa-release-relay/dev-db.url`
- `/etc/hi5central/qa-release-relay/publication.token`

**Do not run this script via Remote Desktop Commander, a ChatGPT tool call or a CI runner** if host safety controls have denied credential operations. Use the approved administrator-only host session/secrets management workflow. If a vault is subsequently deployed, replace these host files with managed secret mounts and audit rotation.

## Gate D — reviewed Live API-only deployment

Build and deploy the targeted new API code with the publication credential guard, using your normal protected release/rollback procedure. Configure the new image's **central Live API service only**:

```dotenv
RELEASE_PUBLICATION_TOKEN_SHA256=<hash printed by the administrator script>
RELEASE_PUBLICATION_ALLOWED_SHA=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
```

**The hash line above contains a placeholder**, not a bearer credential. Never include the actual bearer in any container environment variable, ticket or GitHub commit. The existing `RELEASE_OPERATOR_TOKEN` is unchanged and remains unavailable to the relay. Verify that unauthenticated publication returns HTTP 401 and that the old deployment operator token does not authorise the publication endpoint. With the relay's new token, the nonpublishing `POST {}` preflight must return HTTP 400. Deploying the entire draft PR's API image over shared Live is **not approved**: isolate the reviewed authentication change, preserve existing Live routes and be able to roll back.

## Gate E — secret metadata and Docker isolation

Use the reviewed gated script:

```sh
export QA_RELEASE_DEV_DB_SECRET_FILE=/etc/hi5central/qa-release-relay/dev-db.url
export QA_RELEASE_PUBLICATION_TOKEN_SECRET_FILE=/etc/hi5central/qa-release-relay/publication.token
sh deployment/qa26/qa-publication-relay-secret-gate.sh
```

The gate checks file existence, root-isolated directory, UID 100/mode 0400, Docker image and Dev+Live networks without opening secret files. The relay image is `hi5central-release-publication-relay:qa-scoped-v1` only after rebuilding it from the final reviewed source and verifying its immutable digest. The VPS currently has Docker but no `docker compose` CLI; use a separately reviewed Docker CLI run that binds **only those two host secret files read-only**, runs non-root with `--read-only --cap-drop ALL --security-opt no-new-privileges:true`, joins `hi5central-dev_hi5internal` and `hi5central`, and exposes no ports or Docker socket.

**Do not switch the generic Dev DB hostname `postgres` into a dual-network relay.** The code pins it to `hi5central-dev-postgres-1`.

## Gate F — preflight, one-time publication and verification

In the isolated relay only:

```sh
node releasePublicationRelayDaemon.mjs --preflight
node releasePublicationRelayDaemon.mjs --once
```

The preflight validates Dev DB schema/login plus a **nonpublishing**, authenticated central request that MUST return HTTP 400 for deliberately invalid notes. Refuse any HTTP 201, 401, 403, 404 or 5xx. The one-time run processes **only** the original staff-authenticated, pinned request. Confirm:

1. Central `hi5central_published_release_notes` and public `/api/v1/updates/published` contain the exact build SHA, version, title and all five customer changes.
2. Dev `hi5central_release_note_drafts` now shows `published` with matching timestamp.
3. Global `platform_release_rollout_control.paused=true`, still zero tenant jobs, no automatic staff certification and no customer version changes.
4. Stop/remove only this relay container, leave the encrypted/approved audit trail and revoke or rotate credentials according to policy.

**Release certification requires another human step** in the Admin Centre, using official successful GitHub Actions run `38791420784`. The six-tenant Test/UAT rollout and durable Live gateway reconciliation are separate gates.

## Rotation / emergency revocation

**Publication token, no downtime:** generate a new dedicated bearer and its digest in the admin secrets manager; deploy `RELEASE_PUBLICATION_TOKEN_SHA256_NEXT` alongside the current digest; verify the new bearer returns the nonpublishing HTTP 400; switch relay secret mount to new bearer; remove the old digest by promoting NEXT to primary through a reviewed Live API rollout; revoke/destroy the old bearer. Never overlap the full deployment operator credential.

**Dev DB role:** stop the publisher, issue an approved role-password rotation on the Dev Postgres only, replace its restricted URL file atomically, and verify Dev-only login with `--preflight`. For full revocation, the Dev DBA may run `ALTER ROLE hi5_release_publisher NOLOGIN PASSWORD NULL;` and revoke its grants. Do not revoke privileges from the existing `hi5central` application role.

**Security incident:** stop the one-off relay and revoke the dedicated publication token digest and Dev publisher account. Leave the global rollout paused, preserve audit evidence and avoid touching unrelated customer environments.
