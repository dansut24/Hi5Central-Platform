#!/usr/bin/env bash
# Stage (do not activate) two immutable generic release images. No customer
# routes, tenant jobs, migration, credentials or worker services are touched.
set -Eeuo pipefail
set +x
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
reviewed="${H5C_REVIEWED_GENERIC_RELEASE_SHA:-}"
[[ "$reviewed" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$reviewed" ]] ||
 { echo 'GENERIC_IMAGE_STAGE_BLOCKED: reviewed source does not match checkout' >&2;exit 1; }
# This stage may run only while the fleet is explicitly paused.
docker exec hi5central-certified-release-planner node -e '
const {Client}=require("pg");
(async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});
 await c.connect();
 try{
  await c.query("BEGIN READ ONLY");
  const p=(await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true")).rows[0];
  const jobs=(await c.query("SELECT count(*)::int n FROM tenant_release_rollout_jobs WHERE status=$1",["running"])).rows[0];
  if(p?.paused!==true||jobs?.n!==0)throw Error("Rollout paused or idle guard failed");
  console.log("GENERIC_IMAGE_STAGE_READONLY_PAUSE_AND_IDLE_PASS");
  await c.query("ROLLBACK");
 }finally{await c.end()}
})().catch(e=>{console.error("GENERIC_IMAGE_STAGE_BLOCKED",e.message);process.exitCode=1})'
prefix="${reviewed:0:12}"
planner="hi5central-generic-release-planner:reviewed-$prefix"
executor="hi5central-generic-release-executor:reviewed-$prefix"
adapter="hi5central-release-host-adapter:reviewed-$prefix"
docker build --pull=false --build-arg "REVIEWED_SOURCE_SHA=$reviewed" \
 -f deployment/qa26/Dockerfile.certified-release-fanout -t "$planner" .
docker build --pull=false --build-arg "REVIEWED_SOURCE_SHA=$reviewed" \
 -f deployment/qa26/Dockerfile.generic-tenant-release-executor -t "$executor" .
docker build --pull=false --build-arg "REVIEWED_SOURCE_SHA=$reviewed" \
 -f deployment/qa26/Dockerfile.release-host-adapter -t "$adapter" .
for image in "$planner" "$executor" "$adapter";do
 actual="$(docker image inspect "$image" --format '{{index .Config.Labels "hi5central.release.reviewed_source"}}')"
 [[ "$actual" == "$reviewed" ]] ||
 { echo "GENERIC_IMAGE_STAGE_BLOCKED: source attestation mismatch for $image" >&2;exit 1; }
done
[[ "$(docker image inspect "$executor" --format '{{.Config.User}}')" == "10001:10002" ]] ||
 { echo 'GENERIC_IMAGE_STAGE_BLOCKED: upgrade executor must not run as root' >&2;exit 1; }
docker run --rm --network none --entrypoint sh "$executor" -c 'test ! -S /var/run/docker.sock && ! command -v docker' ||
 { echo 'GENERIC_IMAGE_STAGE_BLOCKED: generic worker must not contain Docker socket/CLI' >&2;exit 1; }
[[ "$(docker image inspect "$planner" --format '{{.Config.User}}')" == scheduler ]] ||
 { echo 'GENERIC_IMAGE_STAGE_BLOCKED: scheduler must be unprivileged' >&2;exit 1; }
docker run --rm --network none --entrypoint node "$planner" \
 --input-type=module -e "import('./certifiedReleaseFanout.js').then(m=>{if(typeof m.fanoutCertifiedRelease!=='function')process.exit(1)})"
echo "GENERIC_RELEASE_IMAGES_STAGED_PLANNING_AND_EXECUTION_STILL_DISABLED"
docker image inspect "$planner" "$executor" "$adapter" \
 --format 'image={{.RepoTags}} digest={{.Id}} source={{index .Config.Labels "hi5central.release.reviewed_source"}}'
echo "CUSTOMER_GATEWAYS_DATABASE_WORKERS_NOT_MODIFIED"
