# Central automatic Dev publication: approved VPS operator procedure

**Scope:** Editorial publication only. Never unpause customer upgrades, run the
old Docker-socket executors, alter customer routes or approve Custom Production.

Do not execute the activation portion until PR #86 has completed its required
review and is merged into `main`, all required GitHub checks pass, and an
authorized platform operator approves this central API change. The existing
`main` push workflow also builds **ITSM, RMM and Admin** images; do not
interpret their image publication as approval to redeploy those services.

## 1. Verify exact target and stop on unexpected state

On the **real Docker host**, through your normal approved SSH/VPS console:

```bash
sudo -i
set -Eeuo pipefail
set +x
umask 077

# Existing running API was created by project "deployment" with these four
# Compose sources. Do not silently omit any, especially the fourth auth
# overlay. Confirm docker inspect reports these exact files before proceeding.
docker inspect hi5central-api --format \
  '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
docker inspect hi5central-api --format \
  'image={{.Config.Image}} health={{.State.Health.Status}} project={{index .Config.Labels "com.docker.compose.project"}}'
docker inspect hi5central-web --format 'gateway={{.State.Health.Status}}'

# Must show global release pause true. Never proceed if unpaused.
docker exec hi5central-certified-release-planner node --input-type=module -e '
import pg from "pg";
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
try {
 const q=await p.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
 if(q.rows[0]?.paused!==true)throw Error("Customer rollout must remain globally paused");
 console.log("CUSTOMER_ROLLOUT_PAUSED_PASS");
} finally { await p.end() }'

# Don't overwrite a dirty checkout. This is a separate read-only source copy.
git clone --depth=1 --branch main \
  https://github.com/dansut24/Hi5Central-Platform.git \
  /root/h5c-reviewed-central-publisher-20261018
SRC=/root/h5c-reviewed-central-publisher-20261018
SHA=$(git -C "$SRC" rev-parse HEAD)
echo "REVIEWED_MAIN_SHA=$SHA"

# The GitHub Actions Platform Containers workflow needs to have completed
# successfully for THIS SHA before pulling any API image.
IMAGE="ghcr.io/dansut24/hi5central-platform-api:sha-$SHA"
docker pull "$IMAGE"
docker image inspect "$IMAGE" --format 'reviewed_api_image={{.Id}}'

# All four original files are mandatory. The fifth adds ONLY API image and
# the two publication settings. Never change API, Admin or RMM gateway routes.
BASE=(
  -f /opt/hi5central/deployment/compose.runtime.yml
  -f /opt/hi5central/phase43-live-release-label/compose.prod.yml
  -f /opt/hi5central/deployment/compose.release-publication-2199e58.yml
  -f /root/hi5central-live-publication-auth/deployment/qa26/compose.live-publication-auth-only.overlay.yml
)
REVIEW="$SRC/deployment/qa26/compose.central-verified-dev-publication-only.overlay.yml"
test -s "$REVIEW"
export H5C_REVIEWED_CENTRAL_API_IMAGE="$IMAGE"
docker compose -p deployment --project-directory /opt/hi5central/deployment \
  "${BASE[@]}" -f "$REVIEW" config --quiet
docker compose -p deployment --project-directory /opt/hi5central/deployment \
  "${BASE[@]}" -f "$REVIEW" config --images | grep -Fx "$IMAGE"
docker compose --dry-run -p deployment --project-directory /opt/hi5central/deployment \
  "${BASE[@]}" -f "$REVIEW" up -d --no-deps --no-build api
```

If any command fails: **STOP**. Do not copy or overwrite a Caddyfile, loosen
Postgres grants, remove a secret or remove the rollout pause.

## 2. Operator-approved API cutover — only after explicit change approval

Keep an independent recovery record:

```bash
test "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect hi5central-web --format '{{.State.Health.Status}}')" = healthy
OLD_IMAGE=$(docker inspect hi5central-api --format '{{.Image}}')
echo "OLD_CENTRAL_API_IMAGE_ID=$OLD_IMAGE"
docker image inspect "$OLD_IMAGE" --format '{{.Id}}'
```

This command recreates **only** the API using the current four Compose
sources plus the reviewed publication-only overlay. It does NOT update RMM,
ITSM, Admin or any Caddyfile, and does NOT unpause rollouts:

```bash
docker compose -p deployment --project-directory /opt/hi5central/deployment \
  "${BASE[@]}" -f "$REVIEW" up -d --no-deps --no-build api
sleep 10
test "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" = healthy
curl -fsS --max-time 12 https://api.hi5central.com/live
docker inspect hi5central-web --format 'gateway={{.State.Health.Status}}'
```

A healthy API **alone is not** enough to declare central publication ready.
Continue to the authenticated relay preflight. If any check fails, follow
the rollback below immediately.

## 3. Start only the publication-only relay

This is a non-root, read-only, no-Docker-socket service. Its Dev database URL
and dedicated bearer already reside in restricted host files; do not print,
copy into Git or pass credentials in CLI arguments.

```bash
export QA_RELEASE_DEV_DB_SECRET_FILE=/etc/hi5central/qa-release-relay/dev-db.url
export QA_RELEASE_PUBLICATION_TOKEN_SECRET_FILE=/etc/hi5central/qa-release-relay/publication.token
test -s "$QA_RELEASE_DEV_DB_SECRET_FILE"
test -s "$QA_RELEASE_PUBLICATION_TOKEN_SECRET_FILE"
RELAY="$SRC/deployment/qa26/compose.release-publication-relay.yml"
docker compose -p h5c-release-publisher -f "$RELAY" config --quiet
docker compose -p h5c-release-publisher -f "$RELAY" build qa-release-publication-relay

# Preflight uses the dedicated bearer for a NON-PUBLISHING HTTP request.
# It MUST prove that actual Live central API has the verified Dev capability.
docker compose -p h5c-release-publisher -f "$RELAY" \
  run --rm --no-deps qa-release-publication-relay --preflight
# Only if preflight returns 0:
docker compose -p h5c-release-publisher -f "$RELAY" \
  up -d --no-build --no-deps qa-release-publication-relay
docker inspect hi5central-release-publication-relay \
  --format 'relay={{.State.Status}} restarts={{.RestartCount}}'
```

**Do not create a release automatically.** With Dev still serving certified SHA
`ff3795f7d1bc5d256ced5142b578c0897f57f6a7`, verify the original
editorial title and entries are unchanged; then the developer can press
**Release to customers** on the new draft. Wait for central immutable
catalogue readback AND Dev publication acknowledgment for the exact SHA.

```bash
curl -fsS --max-time 12 https://dev-api.hi5central.com/api/v1/updates/version
curl -fsS --max-time 12 https://api.hi5central.com/api/v1/updates/published \
  | grep -o 'ff3795f7d1bc5d256ced5142b578c0897f57f6a7'
node "$SRC/deployment/qa26/audit-customer-publication-handoff.mjs"
```

The last audit intentionally returns nonzero until separate customer
certification, stage approvals and actual tenant upgrade safety checks
are complete. **Central publication is not customer rollout.**

## 4. Emergency API rollback

If API health, Admin, shared auth, tenant routing or publication authorization
fails, stop the relay before restoring the previously running API Compose
state **without the new fifth overlay**.

```bash
docker compose -p h5c-release-publisher -f "$RELAY" \
  stop qa-release-publication-relay || true
docker compose -p deployment --project-directory /opt/hi5central/deployment \
  "${BASE[@]}" up -d --no-deps --no-build api
sleep 10
test "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" = healthy
docker inspect hi5central-api --format '{{.Image}}'
curl -fsS --max-time 12 https://api.hi5central.com/live
```

If the original four Compose files have changed since initial inspection,
**do not use this rollback command**; restore the separately recorded
exact prior image and Compose files under incident procedures.

## 5. Absolutely separate runner GO gates

This editorial deployment has no permission to certify, plan or execute a
customer update. The release scheduler remains NO-GO while any condition
below is false:

- six old SHA `9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0` jobs are
  still scheduled, unreconciled or unaudited;
- dedicated planner plus Test/UAT/Live executor PostgreSQL login roles
  and SQL stage isolation are absent;
- the live shared Caddy host source, mounted source and loaded runtime differ;
- all ten Live baseline assignments and exact API/frontend serving hashes
  are not independently verified;
- the generic worker has no trusted, customer-requested rollback with
  durable fence/audit proof;
- exact SHA is not formally certified, ten QA tenants are not explicitly
  admitted or stage execution approval is absent.

**Never** unpause to make a CI result green or to meet a wall-clock deadline.
Custom Production always requires separate customer approval.
