#!/usr/bin/env bash
# One-time administrator-only Dev acknowledgement of an ALREADY published release.
# NO new central release POST, NO tenant deployment, NO global rollout changes.
set -Eeuo pipefail
set +x
umask 077

SHA="9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"
IMAGE="hi5central-release-publication-relay:qa-reconcile-v1"
EXPECTED_IMAGE_ID="sha256:98c8f36c5d2c325fab627b540fe5f57a6855c53ba12dfc4079167cc08162e107"
NAME="hi5central-release-publication-reconcile-qa26"
ROOT="/etc/hi5central/qa-release-relay"
DB_SECRET="$ROOT/dev-db.url"
TOKEN_SECRET="$ROOT/publication.token"

fail(){ echo "QA_PUBLISHED_RELEASE_RECONCILIATION_BLOCKED: $*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || fail 'Run only in your authorised root SSH session'
[[ "$(stat -c '%a:%u:%g' "$ROOT")" == "700:0:0" ]] ||
  fail 'Secret directory has unexpected ownership or mode'
for f in "$DB_SECRET" "$TOKEN_SECRET"; do
  [[ -f "$f" && ! -L "$f" ]] || fail 'Expected a real restricted secret file'
  [[ "$(stat -c '%a:%u:%g' "$f")" == "400:100:101" ]] ||
    fail 'Secret file ownership or mode has changed'
done
[[ "$(docker image inspect "$IMAGE" --format '{{.Id}}')" == "$EXPECTED_IMAGE_ID" ]] ||
  fail 'The isolated reconciliation image has not been staged or has changed'
[[ "$(docker inspect hi5central-api --format '{{.State.Health.Status}}')" == healthy ]] ||
  fail 'The central Live API is not healthy'
if docker ps -a --format '{{.Names}}' | grep -Fx "$NAME" >/dev/null; then
  fail 'Dedicated reconciliation container already exists; review its state before repeating'
fi

docker exec hi5central-certified-release-planner node -e '
const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();try{
const a=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
const b=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status=ANY($1)",[["running","scheduled"]]);
const d=await c.query("SELECT count(*)::int n FROM hi5central_published_release_notes WHERE build_sha=$1",["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"]);
if(a.rows[0]?.paused!==true||b.rows[0]?.n!==0||d.rows[0]?.n!==1)
throw Error("The existing central publication or rollout safety state is unexpected");
console.log("CENTRAL_PUBLISHED_AND_TENANTS_PAUSED_PASS");
}finally{await c.end()}})().catch(e=>{console.error("RECONCILIATION_GUARD_REFUSED");process.exitCode=1})' ||
  fail 'Central publication or rollout guard failed'

docker exec hi5pool-dev-9f3cb1da7c27-api node -e '
const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();try{
const r=await c.query("SELECT status,requested_at,edited_by,jsonb_array_length(entries) n FROM hi5central_release_note_drafts WHERE build_sha=$1",["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"]);
if(r.rows.length!==1||r.rows[0].status!=="publication_requested"||
 !r.rows[0].requested_at||!r.rows[0].edited_by||r.rows[0].n!==5)
 throw Error("Original Dev request is not pending and complete");
console.log("DEV_ORIGINAL_PUBLICATION_REQUEST_PASS");
}finally{await c.end()}})().catch(e=>{console.error("DEV_REQUEST_GUARD_REFUSED");process.exitCode=1})' ||
  fail 'Original Dev user-submitted release request changed'

cleanup(){
  status=$?
  trap - EXIT
  if docker ps -a --format '{{.Names}}' | grep -Fx "$NAME" >/dev/null; then
    docker rm -f "$NAME" >/dev/null ||
      echo "WARNING: manually remove the temporary reconciliation container" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

docker create --name "$NAME" \
  --network hi5central-dev_hi5internal --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 128m \
  --mount "type=bind,source=$DB_SECRET,target=/run/secrets/qa_dev_db,readonly" \
  --mount "type=bind,source=$TOKEN_SECRET,target=/run/secrets/qa_publication_token,readonly" \
  -e DEV_DATABASE_URL_FILE=/run/secrets/qa_dev_db \
  -e RELEASE_PUBLICATION_TOKEN_FILE=/run/secrets/qa_publication_token \
  -e CENTRAL_RELEASE_AUTHORITY_URL=http://hi5central-api:3001 \
  -e RELEASE_PUBLICATION_ALLOWED_SHA="$SHA" \
  --entrypoint /bin/sleep "$IMAGE" 1200 >/dev/null

docker start "$NAME" >/dev/null
docker network connect hi5central "$NAME"

# Authenticated test POST {} is REJECTED and cannot insert release notes.
docker exec "$NAME" node releasePublicationRelayDaemon.mjs --preflight

# CRITICAL: unlike --once, this flag NEVER invokes the protected POST endpoint.
# It reads the immutable central published catalogue and acknowledges only
# exact matching release content, SHA, and prior real Dev author/request.
docker exec "$NAME" node releasePublicationRelayDaemon.mjs --reconcile-only

docker exec hi5pool-dev-9f3cb1da7c27-api node -e '
const{Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();try{
const r=await c.query("SELECT status,published_at FROM hi5central_release_note_drafts WHERE build_sha=$1",["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"]);
if(r.rows.length!==1||r.rows[0].status!=="published"||!r.rows[0].published_at)
throw Error("Dev publication acknowledgement is missing");
console.log("DEV_PUBLICATION_ACKNOWLEDGEMENT_PASS");
}finally{await c.end()}})().catch(()=>{console.error("DEV_ACK_READBACK_FAILED");process.exitCode=1})'

docker exec hi5central-certified-release-planner node -e '
const{Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();try{
const a=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
const b=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status=ANY($1)",[["running","scheduled"]]);
const d=await c.query("SELECT count(*)::int n FROM hi5central_published_release_notes WHERE build_sha=$1",["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"]);
if(a.rows[0]?.paused!==true||b.rows[0]?.n!==0||d.rows[0]?.n!==1)
 throw Error("Central release or rollout guard changed");
console.log("FINAL_CENTRAL_IMMUTABLE_AND_ROLLOUT_PAUSED_PASS");
}finally{await c.end()}})().catch(()=>{console.error("FINAL_PUBLICATION_STATE_FAILED");process.exitCode=1})'
echo "QA_PUBLISHED_RELEASE_RECONCILIATION_PASS sha=$SHA"
