#!/usr/bin/env bash
# Reproducible, containerised Test-only QA worker staging. Never authorises
# a DB role, grants a job permit, unpauses workers or changes tenant routes.
set -Eeuo pipefail
set +x
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
sha="${H5C_CANARY_REVIEWED_SHA:-}"
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$sha" ]] ||
 { echo "SIX_TEST_STAGE_BLOCKED: reviewed commit mismatch" >&2;exit 1; }
image="hi5central-qa-six-test-worker:reviewed-${sha:0:12}"
base="hi5central-generic-release-executor:qa-cohort-11551068"
docker image inspect "$base" >/dev/null
for target in hi5pool-test-9f3cb1da7c27-api hi5pool-test-9f3cb1da7c27-web;do
 [[ "$(docker inspect "$target" --format '{{.State.Health.Status}}')" == healthy ]] ||
 { echo "SIX_TEST_STAGE_BLOCKED: target pair unhealthy" >&2;exit 1; }
done
docker exec hi5central-certified-release-planner node -e '
const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const p=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");
const jobs=await c.query("SELECT status,count(*)::int n,max(attempt_count)::int a FROM tenant_release_rollout_jobs WHERE build_sha=$1 AND environment=$2 GROUP BY status",
["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0","test"]);
if(p.rows[0]?.paused!==true||jobs.rows.length!==1||jobs.rows[0].status!=="scheduled"
 ||jobs.rows[0].n!==6||jobs.rows[0].a!==0)throw Error("QA Test cohort changed");
console.log("QA_SIX_STAGE_QUEUE_GUARD_PASS");await c.end()
})().catch(()=>process.exit(1))'
node --check deployment/qa26/execute-six-qa-test-job-admin.mjs
node --check deployment/qa26/single-test-canary/services/api/src/qaSixTestCohort.js
node --check deployment/qa26/single-test-canary/services/api/src/tenantReleaseExecutor.mjs
node --check deployment/qa26/single-test-canary/deployment/qa26/tenant-release-host-executor.mjs
docker build --pull=false -f deployment/qa26/Dockerfile.single-test-canary \
 --build-arg "REVIEWED_SOURCE_SHA=$sha" -t "$image" . >/dev/null
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "hi5central.qa.reviewed_source"}}')" == "$sha" ]] ||
 { echo "SIX_TEST_STAGE_BLOCKED: immutable image mismatch" >&2;exit 1; }
sha_release=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
for slug in h5c-managed-qa26 h5c-custom-qa26 managed1 managed2 custom1 custom2;do
  docker run --rm --network hi5central --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 100 --memory 256m \
  --tmpfs /tmp:rw,nosuid,size=8m \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --entrypoint node "$image" deployment/qa26/tenant-release-host-executor.mjs \
  test "$slug" "$sha_release" --preflight | \
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.status!=="preflight_pass")process.exit(1)})'
done
echo "QA_SIX_TEST_IMMUTABLE_IMAGE_AND_PRECHECKS_PASS image=$image"
echo "NO_TENANT_ROUTES_CHANGED_NO_JOBS_CLAIMED_NO_ROLLOUT_UNPAUSED"
