#!/usr/bin/env bash
# QA-only: Stage reviewed one-tenant worker code INSIDE the existing Test worker,
# in a separate directory. The running worker process and its configuration stay untouched.
# Does not read/print/re-export DATABASE_URL or any other secret.
set -Eeuo pipefail
set +x
umask 077
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
if [[ "$(git rev-parse HEAD)" != "__PINNED_COMMIT__" ]]; then
  echo "CANARY_STAGE_BLOCKED: checkout the approved exact Git commit" >&2; exit 1
fi
TARGET=hi5central-release-executor-test
if [[ "$(docker inspect "$TARGET" --format '{{.State.Running}}')" != true
  || "$(docker inspect "$TARGET" --format '{{.Config.Image}}')" != hi5central-generic-release-executor:qa-cohort-11551068 ]]; then
  echo "CANARY_STAGE_BLOCKED: original paused Test worker is not running its pinned image" >&2; exit 1
fi
docker exec "$TARGET" node -e '
const x=process.env;
if(x.RELEASE_GATEWAY!=="test"||!x.DATABASE_URL?.startsWith("postgres")||
x.RELEASE_QA_TENANT_SLUGS?.split(",").sort().join(",")!==
["custom1","custom2","h5c-custom-qa26","h5c-managed-qa26","managed1","managed2"].sort().join(","))
process.exit(1);
console.log("ORIGINAL_TEST_WORKER_SCOPE_CONFIRMED")
'
docker exec hi5central-certified-release-planner node -e '
const{Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const p=(await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true")).rows[0];
const j=(await c.query("SELECT status,count(*)::int n,max(attempt_count)::int attempts FROM tenant_release_rollout_jobs WHERE build_sha=$1 GROUP BY status",
["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"])).rows;
if(p?.paused!==true||j.length!==1||j[0].status!=="scheduled"||j[0].n!==6||j[0].attempts!==0)
throw Error("rollout changed");
console.log("ALL_SIX_JOBS_STILL_PAUSED");
await c.end()})().catch(()=>process.exit(1));
'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bundle="$tmp/qa-single-test-canary"
mkdir -p "$bundle/services/api/src" "$bundle/deployment/qa26"
for file in releaseGatewayCoordinator.js releaseQaCohort.js runtimePoolPolicy.js releaseRolloutPlanner.js tenantCaddyVersionRoutes.js tenantLiveBaseline.js; do
  cp "services/api/src/$file" "$bundle/services/api/src/$file"
done
cp deployment/qa26/single-test-canary/services/api/src/tenantReleaseQueue.js "$bundle/services/api/src/"
cp deployment/qa26/single-test-canary/services/api/src/tenantReleaseExecutor.mjs "$bundle/services/api/src/"
cp deployment/qa26/single-test-canary/deployment/qa26/tenant-release-host-executor.mjs "$bundle/deployment/qa26/"
node --check "$bundle/services/api/src/tenantReleaseQueue.js"
node --check "$bundle/services/api/src/tenantReleaseExecutor.mjs"
node --check "$bundle/deployment/qa26/tenant-release-host-executor.mjs"
# Copy *only reviewed source code*. No secrets or volume/filesystem extraction.
docker cp "$bundle" "$TARGET:/runner/"
for file in services/api/src/tenantReleaseQueue.js services/api/src/tenantReleaseExecutor.mjs deployment/qa26/tenant-release-host-executor.mjs; do
  localHash="$(sha256sum "$bundle/$file"|cut -d' ' -f1)"
  containerHash="$(docker exec "$TARGET" sha256sum "/runner/qa-single-test-canary/$file"|cut -d' ' -f1)"
  [[ "$localHash" == "$containerHash" ]] ||
    { echo "CANARY_STAGE_BLOCKED: copied code identity mismatch" >&2; exit 1; }
done
docker exec "$TARGET" node --check qa-single-test-canary/services/api/src/tenantReleaseExecutor.mjs
docker exec "$TARGET" node --check qa-single-test-canary/deployment/qa26/tenant-release-host-executor.mjs
echo "SINGLE_TEST_CANARY_CODE_STAGED_ONLY"
echo "GLOBAL_ROLLOUT_AND_EXISTING_WORKER_UNCHANGED"
