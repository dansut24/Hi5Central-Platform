#!/usr/bin/env bash
# Stage a SEPARATE immutable QA-only canary image, never mutate the original
# read-only Test worker or retrieve its credential environment.
set -Eeuo pipefail
set +x
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "${H5C_CANARY_REVIEWED_SHA:-}" =~ ^[a-f0-9]{40}$ &&
  "$(git rev-parse HEAD)" == "$H5C_CANARY_REVIEWED_SHA" ]] ||
  { echo "CANARY_STAGE_BLOCKED: reviewed exact code SHA not checked out" >&2;exit 1; }
[[ "$(docker inspect hi5central-release-executor-test --format '{{.State.Running}}')" == true ]] ||
  { echo "CANARY_STAGE_BLOCKED: original Test worker not running" >&2;exit 1; }
docker exec hi5central-certified-release-planner node -e '
const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();
const p=(await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true")).rows[0];
const j=(await c.query("SELECT status,count(*)::int n,max(attempt_count)::int mx FROM tenant_release_rollout_jobs WHERE build_sha=$1 GROUP BY status",["9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"])).rows;
if(p?.paused!==true||j.length!==1||j[0].status!=="scheduled"||j[0].n!==6||j[0].mx!==0)throw Error("paused Test cohort changed");
await c.end();console.log("QA_ROLLOUT_PAUSED_PRECHECK_PASS")
})().catch(()=>process.exit(1))
'
echo '=== Apply empty, idempotent Test-only permit schema (no permit is armed) ==='
cat services/api/migrations/platform-admin/165_single_paused_test_canary.sql |
  docker exec -i hi5central-postgres sh -c \
    'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
echo 'SINGLE_TEST_CANARY_EMPTY_SCHEMA_READY'
echo '=== Build separated immutable QA worker from vetted existing worker image ==='
docker image inspect hi5central-generic-release-executor:qa-cohort-11551068 \
  --format 'BASE_IMAGE_ID={{.Id}}'
docker build -f deployment/qa26/Dockerfile.single-test-canary \
  --build-arg "REVIEWED_SOURCE_SHA=$H5C_CANARY_REVIEWED_SHA" \
  -t hi5central-qa-single-test-canary:reviewed-v1 .
docker image inspect hi5central-qa-single-test-canary:reviewed-v1 \
  --format 'SINGLE_TEST_CANARY_IMAGE_BUILT={{.Id}} reviewed={{index .Config.Labels "hi5central.qa.reviewed_source"}}'
echo 'ORIGINAL_WORKER_READ_ONLY_AND_UNCHANGED'
echo 'NO_PUBLIC_ROUTES_OR_RELEASE_JOBS_CHANGED'
