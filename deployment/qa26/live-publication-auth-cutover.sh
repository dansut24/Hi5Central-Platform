#!/usr/bin/env bash
# Reviewed, API-only controlled Live publication credential cutover.
# Never touches Caddy, customer routing, CI approval, tenant jobs or rollout pause.
set -Eeuo pipefail
set +x
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OLD_ID="sha256:237637f2db12879ed9c3ab7f0d86e305607ae2c18984d38fb0e95192d32f8b56"
NEW_ID="sha256:685d076d9efccbf047b5391182df43b9b80e3ec23b977ed96a6d7b2f2fd2f581"
IMAGE="hi5central-api:qa-publication-auth-fdee74c"
OVERLAY="$SCRIPT_DIR/compose.live-publication-auth-only.overlay.yml"
started=0
base() {
  docker compose -p deployment \
    -f /opt/hi5central/deployment/compose.runtime.yml \
    -f /opt/hi5central/phase43-live-release-label/compose.prod.yml \
    -f /opt/hi5central/deployment/compose.release-publication-2199e58.yml "$@"
}
restore() {
  status=$?
  trap - ERR
  if [ "$started" -eq 1 ]; then
    echo 'CUTOVER_FAILED: restoring the pinned original Live API image' >&2
    if base up -d --no-deps --force-recreate --pull never api >/dev/null; then
      echo 'ROLLBACK_REQUESTED: verify the Live API health immediately' >&2
    else
      echo 'ROLLBACK_FAILED: urgent administrator review needed' >&2
    fi
  fi
  unset RELEASE_PUBLICATION_TOKEN_SHA256
  exit "$status"
}
trap restore ERR
die() { echo "CUTOVER_BLOCKED: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'Use an approved root SSH session'
[[ $RELEASE_PUBLICATION_TOKEN_SHA256 =~ ^[a-f0-9]{64}$ ]] || die 'Set the new publication bearer SHA256 digest, not the bearer'
[ -f "$OVERLAY" ] || die 'Missing reviewed API-only Compose overlay'
[ "$(docker inspect hi5central-api --format '{{.Image}}')" = "$OLD_ID" ] || die 'Live API baseline has changed'
[ "$(docker image inspect "$IMAGE" --format '{{.Id}}')" = "$NEW_ID" ] || die 'The candidate immutable image has changed'
[ "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" = healthy ] || die 'Live API not healthy'
python3 -u "$SCRIPT_DIR/preflight-live-publication-auth-compose.py"

# Fail closed if any customer deployment automation is running or unpaused.
docker exec hi5central-certified-release-planner node -e '
const {Client}=require("pg");
(async()=>{let c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
let p=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
let j=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status=ANY($1)",[["running","scheduled"]]);
if(p.rows[0]?.paused!==true||j.rows[0]?.n!==0)throw Error("unsafe rollout state");
console.log("ROLLOUT_PAUSE_VERIFIED");
}finally{await c.end()}})().catch(()=>process.exit(1))'

echo 'CUTOVER_START: replacing the Live API service only'
started=1
base -f "$OVERLAY" up -d --no-deps --pull never --force-recreate api

for i in $(seq 1 45); do
  if [ "$(docker inspect hi5central-api --format '{{.Image}}' 2>/dev/null)" = "$NEW_ID" ] &&
     [ "$(docker inspect hi5central-api --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ]; then
    if docker exec hi5central-api node -e '
Promise.all(["/live","/api/v1/updates/published"].map(p=>
 fetch("http://127.0.0.1:3001"+p,{signal:AbortSignal.timeout(3500)})))
.then(xs=>{if(xs.some(x=>!x.ok))process.exitCode=1})
.catch(()=>process.exitCode=1)' >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 2
done
[ "$(docker inspect hi5central-api --format '{{.Image}}')" = "$NEW_ID" ]
[ "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" = healthy ]
docker exec hi5central-api node -e '
Promise.all(["/live","/api/v1/updates/published"].map(p=>
 fetch("http://127.0.0.1:3001"+p,{signal:AbortSignal.timeout(3500)})))
.then(xs=>{if(xs.some(x=>!x.ok))process.exitCode=1})
.catch(()=>process.exitCode=1)'
# Verify that the actual external gateway still routes to the healthy
# central catalogue and that publication rejects unauthenticated clients.
curl -fsS --max-time 10 -o /dev/null https://api.hi5central.com/api/v1/updates/published
docker exec hi5central-api node -e '
fetch("http://127.0.0.1:3001/api/platform-operator/v1/releases/publish",{
  method:"POST",headers:{"Content-Type":"application/json"},body:"{}",
  signal:AbortSignal.timeout(3500)
}).then(r=>{if(r.status!==401)process.exitCode=1})
.catch(()=>process.exitCode=1)'
docker exec hi5central-api node -e '
if(!/^[a-f0-9]{64}$/.test(String(process.env.RELEASE_PUBLICATION_TOKEN_SHA256||""))||
process.env.RELEASE_PUBLICATION_ALLOWED_SHA!=="9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0")
process.exit(1)'
unset RELEASE_PUBLICATION_TOKEN_SHA256
trap - ERR
echo 'LIVE_PUBLICATION_API_ONLY_CUTOVER_PASS'
echo 'No release was published and no tenant deployments were activated'
