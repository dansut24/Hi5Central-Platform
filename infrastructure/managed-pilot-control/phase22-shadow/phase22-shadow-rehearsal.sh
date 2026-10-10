#!/bin/sh
set -eu
set +x
[ "${HI5_PRODUCTION_SHADOW_REHEARSAL:-}" = 'YES_READ_ONLY_SOURCE_EPHEMERAL_CLONE' ] || { echo 'Explicit shadow rehearsal consent required.'; exit 2; }
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
umask 077
NAME=hi5central-phase22-db
NET=hi5central-phase22-shadow
DIR=/workspace/phase22-shadow-rehearsal
if docker ps -a --format '{{.Names}}' | grep -Fxq "$NAME"; then echo 'ABORT: stale shadow database'; exit 1; fi
if docker network ls --format '{{.Name}}' | grep -Fxq "$NET"; then echo 'ABORT: stale shadow network'; exit 1; fi
mkdir -p "$DIR"
chmod 700 "$DIR"
cleanup(){
  echo "PHASE22_CLEANUP"
  docker stop -t 5 "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$DIR/runtime.env" "$DIR/migration.log"
  echo "TEMP_POSTGRES_AND_NETWORK_REMOVED"
}
trap cleanup EXIT
docker network create --internal --label com.hi5central.scope=disposable-production-migration-rehearsal "$NET" >/dev/null
sh "$BASE/phase22-env.sh" "$DIR/runtime.env"
docker run --rm -d --name "$NAME" --network "$NET" --network-alias shadow-postgres \
 --env-file "$DIR/runtime.env" --label com.hi5central.scope=disposable-production-migration-rehearsal \
 postgres:17-alpine >/dev/null
for n in $(seq 1 40); do
  if docker exec "$NAME" pg_isready -U phase22_user -d phase22_shadow >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U phase22_user -d phase22_shadow >/dev/null
echo "SHADOW_DB_HEALTHY_NO_HOST_PORTS"
echo "SNAPSHOT_STREAM_BEGIN"
# Pipe a transactionally consistent custom-format snapshot in memory directly
# between containers, never writing customer rows to the host filesystem.
docker exec hi5central-postgres pg_dump -Fc --no-owner --no-acl -U hi5central -d hi5central \
 | docker exec -i "$NAME" pg_restore --exit-on-error --no-owner --no-acl \
    -U phase22_user -d phase22_shadow >/dev/null
echo "SNAPSHOT_RESTORE_PASS"
docker exec "$NAME" psql -U phase22_user -d phase22_shadow -At -c \
 "SELECT (SELECT count(*) FROM tenants),(SELECT count(*) FROM tenant_memberships WHERE role='owner'),(SELECT count(*) FROM users),(SELECT count(*) FROM schema_migrations);"
echo "MIGRATIONS_APPLY_BEGIN"
# This container has ONLY the isolated shadow network. The URL comes solely
# from the freshly generated shadow runtime file, not from the production API.
docker run --rm --network "$NET" --env-file "$DIR/runtime.env" \
 --entrypoint npm \
 ghcr.io/dansut24/hi5central-platform-api:sha-2d332d3e281a0048681062eab9a28d6b41721d36 \
 run migrate:dist > "$DIR/migration.log" 2>&1 || {
   echo "SHADOW_MIGRATIONS_FAILED"
   grep -E 'Applying migration|Migration failed|error|Error|constraint|column|relation' "$DIR/migration.log" \
     | tail -16 | cut -c1-195 || true
   exit 1
 }
echo "SHADOW_MIGRATIONS_PASS"
docker exec "$NAME" psql -U phase22_user -d phase22_shadow -At -c \
 "SELECT (SELECT count(*) FROM tenants),(SELECT count(*) FROM tenant_memberships WHERE role='owner'),(SELECT count(*) FROM users),(SELECT count(*) FROM schema_migrations),(to_regclass('public.tenant_environment_provision_requests') IS NOT NULL),(to_regclass('public.tenant_initial_owner_onboarding_intents') IS NOT NULL);"
sh "$BASE/phase22-api-rehearsal.sh" "$DIR"
echo "PROD_READ_ONLY_INSPECTION"
docker exec hi5central-postgres psql -U hi5central -d hi5central -At -c \
 "SELECT (SELECT count(*) FROM tenants),(SELECT count(*) FROM tenant_memberships WHERE role='owner'),(SELECT count(*) FROM users),(SELECT count(*) FROM schema_migrations);"
echo "PHASE22_PROD_SNAPSHOT_MIGRATION_REHEARSAL=PASS"