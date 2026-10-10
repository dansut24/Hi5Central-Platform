#!/bin/sh
set -eu
DIR="$1"
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NET=hi5central-phase22-shadow
R=hi5central-phase22-redis
A=hi5central-phase22-api
cleanup_api(){
 docker stop -t 5 "$A" >/dev/null 2>&1 || true
 docker stop -t 5 "$R" >/dev/null 2>&1 || true
 rm -f "$DIR/api.env"
}
trap cleanup_api EXIT
if docker ps -a --format '{{.Names}}' | grep -Eq '^hi5central-phase22-(api|redis)$'; then
 echo 'Aborting: shadow service name already exists'; exit 1
fi
{
 echo 'PLATFORM_ADMIN_MFA_REQUIRED=true'
 echo 'PILOT_ADMIN_BOOTSTRAP_ENABLED=false'
 echo 'DEPLOYMENT_MODE=managed'
 echo 'TENANCY_MODE=multi'
 echo 'RUNTIME_ENVIRONMENT=live'
 echo 'FEATURE_MODE=controlled'
 echo 'BACKGROUND_WORKERS_ENABLED=false'
 echo 'ROOT_DOMAIN=hi5central.com'
 echo 'API_URL=https://pilot-control-api.hi5central.com'
 echo 'ADMIN_URL=https://pilot-admin.hi5central.com'
 echo 'REDIS_URL=redis://shadow-redis:6379/0'
 echo 'PORT=3001'
 docker exec hi5central-api node -e 'const c=require("node:crypto");for(const k of ["MFA_ENCRYPTION_KEY","CONNECT_CODE_HMAC_KEY"]){console.log(k+"="+c.randomBytes(32).toString("hex"))}'
} > "$DIR/api.env"
chmod 600 "$DIR/api.env"
docker run -d --rm --name "$R" --network "$NET" --network-alias shadow-redis redis:8-alpine >/dev/null
docker run -d --rm --name "$A" --network "$NET" --env-file "$DIR/runtime.env" --env-file "$DIR/api.env" \
  --entrypoint node ghcr.io/dansut24/hi5central-platform-api:sha-2d332d3e281a0048681062eab9a28d6b41721d36 dist/index.mjs >/dev/null
echo 'PRIVATE_SHADOW_API_STARTED_WITHOUT_HOST_PORTS'
for i in $(seq 1 40); do
 if docker exec "$A" node -e 'fetch("http://127.0.0.1:3001/live").then(r=>process.exit(r.ok?0:2)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
  break
 fi
 sleep 1
done
if ! docker exec "$A" node -e 'fetch("http://127.0.0.1:3001/live").then(r=>process.exit(r.ok?0:2)).catch(()=>process.exit(1))'; then
 echo 'SHADOW_API_STARTUP_FAILED'
 docker logs "$A" 2>&1 | grep -iE 'Error|missing|required|invalid|connect' | tail -10 | cut -c1-145 || true
 exit 1
fi
echo 'PHASE22_SHADOW_API_HEALTHY'
docker cp "$BASE/phase22-shadow-readonly.mjs" "$A":/app/phase22-shadow-readonly.mjs >/dev/null
docker exec "$A" node /app/phase22-shadow-readonly.mjs