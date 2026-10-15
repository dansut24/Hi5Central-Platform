# QA release-note relay: administrator credential/connection handover

**Applies only to Dev build** `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`, whose release notes were authentically submitted in Dev at 2026-10-15 21:27:42 UTC. This is a *publication* workflow; it cannot certify a GitHub build or deploy a customer.

## 1. Read-only verification (completed)

- Actual Dev PostgreSQL: Docker container `hi5central-dev-postgres-1`, network `hi5central-dev_hi5internal`, database `hi5central`, port 5432. Existing Dev API's generic `postgres` hostname is ambiguous once a relay joins both networks. The relay now pins that host to `hi5central-dev-postgres-1` and rejects non-Dev database names/endpoints. Never point the relay at `hi5central-postgres` or other Live PostgreSQL.
- Central authority: `hi5central-api:3001` on `hi5central`; public central catalogue is HTTP 200 at `https://api.hi5central.com/api/v1/updates/published`.
- The legacy host operator's `/config/operator.token` is **not** the currently active Live API bearer credential. It cannot be reused. Both were compared only by hash equality and their values were not shown.
- Global `platform_release_rollout_control.paused=true`; no active jobs. Leave this flag unchanged.
- The operator-reviewed source is `services/api/src/releasePublicationRelay.mjs`, tested in `services/api/test/release-publication-relay.mjs`. It authenticates with an intentionally malformed `POST {}` preflight and accepts only HTTP 400, so the probe cannot publish anything.

## 2. Administrator-only credential provisioning

This step **must happen in an authorised VPS administrator session using approved secrets management**. Host security controls blocked direct remote extraction of the credentials; do not bypass those controls.

Provision two *new restricted files*, not values in chat, repository files, shell history or logs:

| Admin-provisioned file | Required content | Source / scope |
|---|---|---|
| `/etc/hi5central/qa-release-relay/dev-db.url` | Current **Dev** PostgreSQL URL for database `hi5central` | Dev secrets management or a separately provisioned least-privilege Dev DB account with SELECT of release note drafts and UPDATE of only status/published_at |
| `/etc/hi5central/qa-release-relay/central-operator.token` | **Current Live API** publication-authorised bearer token | The authorised Live API secrets manager, NOT the stale `hi5central-release-operator` token volume |

Restrict the parent directory to root and mode 0700, and the *files* to numeric owner UID 100 (the relay's dedicated non-root user) and mode 0400. The Docker engine must be able to bind these actual **host-side** paths. Maintain an approved rotation/revocation plan for the central bearer, which currently has permissions broader than publication.

The administrator supplies **paths only**, never secret values, to the shell:

```sh
export QA_RELEASE_DEV_DB_SECRET_FILE=/etc/hi5central/qa-release-relay/dev-db.url
export QA_RELEASE_OPERATOR_SECRET_FILE=/etc/hi5central/qa-release-relay/central-operator.token
sh deployment/qa26/qa-publication-relay-secret-gate.sh
```

The gate checks only file metadata, networks and image presence; it does **not** open/print/copy secrets or start a service.

## 3. Isolated Docker CLI preflight (administrator approval required)

The VPS does not currently have the `docker compose` CLI, so an independently approved direct Docker invocation is needed. Keep secrets as read-only mounts and join only `hi5central-dev_hi5internal` plus `hi5central`. The image is `hi5central-release-publication-relay:qa-local-20261015` (review exact provenance/checksum before executing).

After approval, execute in an authorised admin session, supplying file paths from the environment above:

```sh
docker create --name hi5central-release-publication-relay-qa26 \
  --network hi5central-dev_hi5internal \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 128m \
  --mount "type=bind,source=$QA_RELEASE_DEV_DB_SECRET_FILE,target=/run/secrets/qa_dev_db,readonly" \
  --mount "type=bind,source=$QA_RELEASE_OPERATOR_SECRET_FILE,target=/run/secrets/qa_operator_token,readonly" \
  -e DEV_DATABASE_URL_FILE=/run/secrets/qa_dev_db \
  -e RELEASE_OPERATOR_TOKEN_FILE=/run/secrets/qa_operator_token \
  -e CENTRAL_RELEASE_AUTHORITY_URL=http://hi5central-api:3001 \
  -e RELEASE_PUBLICATION_ALLOWED_SHA=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0 \
  --entrypoint /bin/sleep \
  hi5central-release-publication-relay:qa-local-20261015 900

docker start hi5central-release-publication-relay-qa26
docker network connect hi5central hi5central-release-publication-relay-qa26
docker exec hi5central-release-publication-relay-qa26 \
  node releasePublicationRelayDaemon.mjs --preflight
```

**Pass:** `RELEASE_PUBLICATION_RELAY_PREFLIGHT_PASS sha=9f3cb1da...`. A 401 indicates stale/incorrect bearer; connection errors suggest network/DNS or Dev credentials. Do not attempt publication until preflight passes.

## 4. One controlled publication

Reconfirm the exact Dev row is `publication_requested`, central SHA is absent or identically published, global pause remains true and no active tenant jobs. Then a human authorised operator can execute:

```sh
docker exec hi5central-release-publication-relay-qa26 \
  node releasePublicationRelayDaemon.mjs --once
```

Expect `release_notes_published` for the pinned SHA, or an idempotent `no_pending` if successfully completed by another authorised process. Independently verify the central public catalogue JSON has the exact title, version, SHA and five customer-facing changes. Verify Dev now says `published`. Verify global rollout is *still paused*. On any error, **do not manually insert into either DB**.

## 5. Teardown, rotate and approval

Stop/remove only the one-off relay container:

```sh
docker rm -f hi5central-release-publication-relay-qa26
```

Revoke or remove the QA-only secret files with an approved credential retention policy. This temporary relay does not require persistent privileged credentials after publication. Retain redacted logs and audit evidence. The real Hi5Central platform administrator must separately certify the exact immutable build using official successful [GitHub Actions run 38791420784](https://github.com/dansut24/Hi5Central-Platform/actions/runs/38791420784); there must be no fabricated approvals. The six-tenant deployment pause and generic Live gateway source-drift block remain enabled until their separate acceptance tests pass.
