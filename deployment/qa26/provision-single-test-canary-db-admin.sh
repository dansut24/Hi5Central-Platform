#!/usr/bin/env bash
# Run ON THE AUTHORISED SSH HOST ONLY, once. New scoped canary DB account:
# does not read any existing Docker env, operator token or credential.
set -Eeuo pipefail
set +x
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ "$(id -u)" == 0 ]] || { echo 'CANARY_DB_PROVISION_BLOCKED: root SSH required';exit 1; }
[[ "${H5C_CANARY_REVIEWED_SHA:-}" =~ ^[a-f0-9]{40}$ &&
  "$(git rev-parse HEAD)" == "$H5C_CANARY_REVIEWED_SHA" ]] ||
  { echo 'CANARY_DB_PROVISION_BLOCKED: reviewed code SHA mismatch';exit 1; }
secretDir=/etc/hi5central/qa-single-test-canary
secretFile="$secretDir/database.url"
[[ ! -e "$secretFile" && ! -L "$secretFile" ]] ||
  { echo 'CANARY_DB_PROVISION_BLOCKED: secret already provisioned; never rotate automatically';exit 1; }
docker exec hi5central-postgres sh -c \
  'test "$POSTGRES_DB" = hi5central && test "$POSTGRES_USER" = hi5central'
[[ "$(docker exec hi5central-postgres sh -c 'psql -X -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT COUNT(*) FROM pg_roles WHERE rolname='\''hi5_release_qa_canary'\''" ')" == 0 ]] ||
  { echo 'CANARY_DB_PROVISION_BLOCKED: scoped role already exists';exit 1; }
docker exec hi5central-certified-release-planner node -e '
const{Client}=require("pg");(async()=>{let c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const p=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");if(p.rows[0]?.paused!==true)throw Error("global rollout not paused");await c.end();console.log("CANARY_PROVISION_PAUSE_GUARD_PASS")})().catch(()=>process.exit(1))'
password="$(openssl rand -hex 32)"
[[ "${#password}" == 64 ]] || { echo 'RNG failure';exit 1; }
# The generated password is passed as operator-controlled stdin straight into
# central Postgres, NEVER echoed to the user or carried out of host SSH.
{
printf "BEGIN;\n"
printf "CREATE ROLE hi5_release_qa_canary LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '%s';\n" "$password"
cat <<'SQL'
GRANT CONNECT ON DATABASE hi5central TO hi5_release_qa_canary;
GRANT USAGE ON SCHEMA public TO hi5_release_qa_canary;
GRANT SELECT ON
  tenants,tenant_settings,tenant_release_preferences,
  platform_release_rollout_control,platform_certified_application_releases,
  platform_release_test_qa_gates,tenant_runtime_update_offers,
  tenant_runtime_assignments,tenant_runtime_route_attestations
TO hi5_release_qa_canary;
GRANT SELECT,UPDATE ON
  tenant_release_rollout_jobs,platform_release_single_test_canary_permits
TO hi5_release_qa_canary;
GRANT SELECT,INSERT,UPDATE ON
  tenant_release_rollout_events,platform_release_worker_heartbeats,platform_runtime_pools
TO hi5_release_qa_canary;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  platform_release_gateway_owners
TO hi5_release_qa_canary;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hi5_release_qa_canary;
COMMIT;
SQL
} | docker exec -i hi5central-postgres sh -c \
  'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
install -d -m 0700 -o 0 -g 0 "$secretDir"
printf 'postgresql://hi5_release_qa_canary:%s@hi5central-postgres:5432/hi5central\n' \
  "$password" >"$secretFile"
chmod 0400 "$secretFile"
chown 0:0 "$secretFile"
unset password
[[ "$(stat -c '%a:%u:%g' "$secretDir")" == '700:0:0' &&
  "$(stat -c '%a:%u:%g' "$secretFile")" == '400:0:0' ]] ||
  { echo 'CANARY_DB_PROVISION_BLOCKED: wrong secret metadata';exit 1; }
# Report role capabilities only, never DB URLs/passwords.
docker exec hi5central-postgres sh -c '
psql -X -q -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT CASE WHEN rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
AND NOT rolcreatedb AND NOT rolinherit
AND has_table_privilege(rolname,'\''public.tenant_release_rollout_jobs'\'','\''UPDATE'\'')
AND NOT has_table_privilege(rolname,'\''public.platform_release_rollout_control'\'','\''UPDATE'\'')
THEN '\''SCOPED_ROLE_PASS'\'' ELSE '\''ROLE_GUARD_FAILED'\'' END
FROM pg_roles WHERE rolname='\''hi5_release_qa_canary'\''" ' |
  grep -Fx SCOPED_ROLE_PASS
echo 'SINGLE_TEST_CANARY_SCOPED_DB_CREDENTIAL_PROVISIONED'
echo 'No credential text displayed; global deployment pause unchanged.'
