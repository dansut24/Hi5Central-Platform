#!/usr/bin/env bash
# Execute exactly ONE approved QA26 Managed Test job in today's legitimate
# maintenance window. Global release pause NEVER changes. No UAT/Live action.
set -Eeuo pipefail
set +x
umask 077
export LC_ALL=C
SHA=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
JOB=2ab0c800-f01d-40f7-b1db-a624b4543b2a
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "$(id -u)" == 0 ]] || { echo "CANARY_EXECUTE_BLOCKED: root SSH administrator required" >&2;exit 1; }
[[ "${H5C_CANARY_REVIEWED_SHA:-}" =~ ^[a-f0-9]{40}$ &&
   "$(git rev-parse HEAD)" == "$H5C_CANARY_REVIEWED_SHA" ]] ||
  { echo "CANARY_EXECUTE_BLOCKED: reviewed source version mismatch" >&2;exit 1; }
# Time window is fixed; no early or late operation, even if the host clock drifts.
now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
[[ "$now" > "2026-10-16T13:00:00Z" &&
   "$now" < "2026-10-16T20:00:00Z" ]] ||
  { echo "CANARY_EXECUTE_BLOCKED: outside 2026-10-16 14:00–21:00 BST start window" >&2;exit 1; }
# Separate container holds all 6 trusted control-plane environment variables
# privately. Docker exec inherits its context without exporting any secret.
container=hi5central-release-executor-test
[[ "$(docker inspect "$container" --format '{{.State.Running}}')" == true ]] ||
  { echo "CANARY_EXECUTE_BLOCKED: existing Test worker unavailable" >&2;exit 1; }
docker exec "$container" test -f /runner/qa-single-test-canary/services/api/src/tenantReleaseExecutor.mjs
for c in hi5pool-test-9f3cb1da7c27-api hi5pool-test-9f3cb1da7c27-web;do
  [[ "$(docker inspect "$c" --format '{{.State.Health.Status}}')" == healthy ]] ||
    { echo "CANARY_EXECUTE_BLOCKED: reviewed candidate not healthy" >&2;exit 1; }
done
# Source CAS: this exact gateway has been reviewed and rollback rehearsed.
expected=a9bd98d8eab259ad9be31f269b1ebff212e0673dbef9187a06df7c16fca1ae50
current="$(docker exec hi5central-test-gateway sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1)"
[[ "$current" == "$expected" ]] ||
  { echo "CANARY_EXECUTE_BLOCKED: Test gateway Caddy source changed" >&2;exit 1; }
node deployment/qa26/tenant-release-host-executor.mjs test h5c-managed-qa26 "$SHA" --preflight | \
  grep -q '"status":"preflight_pass"'
# Prior canary must be on the trusted original QA26 Test baseline.
for tenant in h5c-managed-qa26 h5c-custom-qa26;do
  actual="$(curl -fsS --max-time 10 "https://$tenant-test.hi5central.com/api/v1/updates/version" |
    node -e 'let x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>console.log(JSON.parse(x).sha))')"
  [[ "$actual" == 4a363cf9054b0b3667fd450f36e354b704ec2166 ]] ||
    { echo "CANARY_EXECUTE_BLOCKED: baseline or peer changed" >&2;exit 1; }
done
# Read-only DB guard BEFORE exercising the isolated worker.
docker exec "$container" node -e '
const{Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const id="2ab0c800-f01d-40f7-b1db-a624b4543b2a";
const a=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
const b=await c.query("SELECT state,not_before<=now() AS started,expires_at>now() AS valid FROM platform_release_single_test_canary_permits WHERE job_id=$1",[id]);
const j=await c.query("SELECT t.slug,j.environment,j.status,j.attempt_count FROM tenant_release_rollout_jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.id=$1",[id]);
const other=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status=$1",["running"]);
if(a.rows[0]?.paused!==true||b.rows[0]?.state!=="armed"||!b.rows[0]?.started||!b.rows[0]?.valid||other.rows[0]?.n!==0||j.rows[0]?.slug!=="h5c-managed-qa26"||j.rows[0]?.environment!=="test"||j.rows[0]?.status!=="scheduled"||j.rows[0]?.attempt_count!==0)throw Error("one-job canary guard failed");
console.log("EXACT_TIMED_MANAGED_TEST_CANARY_GATE_PASS");
await c.end()})().catch(e=>{console.error("CANARY_REJECTED");process.exit(1))'
echo 'SINGLE_TEST_CANARY_START'
# This isolated one-shot process is the only worker code that recognises
# the ONE-job permit. Ordinary workers still see global paused=true.
docker exec \
  -e RELEASE_QA_TENANT_SLUGS=h5c-managed-qa26 \
  -e RELEASE_WORKER_ID=single-test-canary-20261016 \
  -e H5C_SINGLE_TEST_CANARY_JOB_ID="$JOB" \
  "$container" node qa-single-test-canary/services/api/src/tenantReleaseExecutor.mjs --once
echo '=== FINAL AUDIT (never suppress a failed assertion) ==='
docker exec "$container" node -e '
const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const id="2ab0c800-f01d-40f7-b1db-a624b4543b2a",sha="9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0";
const p=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
const j=await c.query("SELECT status,attempt_count,completed_at,previous_build_sha FROM tenant_release_rollout_jobs WHERE id=$1",[id]);
const rest=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE build_sha=$1 AND id!=$2 AND status=$3 AND attempt_count=0",[sha,id,"scheduled"]);
const permit=await c.query("SELECT state FROM platform_release_single_test_canary_permits WHERE job_id=$1",[id]);
const evt=await c.query("SELECT count(*)::int n FROM tenant_release_rollout_events WHERE job_id=$1 AND event_type=$2",[id,"verified"]);
if(p.rows[0]?.paused!==true||j.rows[0]?.status!=="succeeded"||j.rows[0]?.attempt_count!==1||!j.rows[0]?.completed_at||rest.rows[0]?.n!==5||permit.rows[0]?.state!=="completed"||evt.rows[0]?.n!==1)throw Error("Durable single-tenant rollout evidence incomplete");
console.log(JSON.stringify({singleTestCanary:"verified",attempts:j.rows[0].attempt_count,othersStillScheduled:rest.rows[0].n,globalPause:p.rows[0].paused,previousSha:j.rows[0].previous_build_sha}));
await c.end()})().catch(e=>{console.error("CANARY_COMPLETION_AUDIT_FAILED",e.message);process.exit(1))'
new="$(curl -fsS --max-time 10 https://h5c-managed-qa26-test.hi5central.com/api/v1/updates/version | node -e 'let x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>console.log(JSON.parse(x).sha))')"
peer="$(curl -fsS --max-time 10 https://h5c-custom-qa26-test.hi5central.com/api/v1/updates/version | node -e 'let x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>console.log(JSON.parse(x).sha))')"
[[ "$new" == "$SHA" && "$peer" == 4a363cf9054b0b3667fd450f36e354b704ec2166 ]] ||
  { echo "CANARY_PUBLIC_ROUTE_MISMATCH: stop and inspect watchdog" >&2;exit 1; }
echo "SINGLE_TEST_MANAGED_CANARY_PASS target=$new peer_unchanged=$peer"
echo "GLOBAL_ROLLOUT_STILL_PAUSED_NO_OTHER_TENANT_DEPLOYED"
