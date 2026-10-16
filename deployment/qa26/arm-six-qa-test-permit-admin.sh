#!/usr/bin/env bash
# Staff-approved exact QA Test permit: ONE reviewed job, 45 minutes maximum.
# Does not create roles, copy secrets, deploy routes or unpause the fleet.
set -Eeuo pipefail
set +x
umask 077
[[ "$(id -u)" == 0 ]] || { echo "QA_PERMIT_DENIED: root SSH required" >&2; exit 1; }
slug="${1:-}"
[[ "$#" == 1 ]] || { echo "Usage: $0 <exact QA Test tenant slug>" >&2; exit 1; }
mode=; job=; start=; end=
case "$slug" in
 h5c-managed-qa26) job=2ab0c800-f01d-40f7-b1db-a624b4543b2a;mode=hi5_managed;;
 h5c-custom-qa26) job=fb97dd79-fdbe-47ed-ac82-d2b1419f73b2;mode=admin_controlled;;
 managed1) job=f34cfcf2-1536-4417-8779-437ce96fd1c0;mode=hi5_managed;;
 managed2) job=ad325517-6c8d-4d36-879a-ee144de4adea;mode=hi5_managed;;
 custom1) job=ff87e5b0-2ed5-4f0a-9f5c-015a0b433755;mode=admin_controlled;;
 custom2) job=1e56ca13-33a4-4603-b723-9f4951120101;mode=admin_controlled;;
 *) echo "QA_PERMIT_DENIED: tenant not in six-job QA cohort" >&2;exit 1;;
esac
if [[ "$slug" == h5c-* ]];then
 start=2026-10-16T13:00:00Z
 end=2026-10-16T20:00:00Z
else
 start=2026-10-17T01:00:00Z
 end=2026-10-17T03:00:00Z
fi
now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
[[ "$now" > "$start" && "$now" < "$end" ]] ||
 { echo "QA_PERMIT_DENIED: not within approved tenant Test maintenance window" >&2;exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
[[ "${H5C_CANARY_REVIEWED_SHA:-}" =~ ^[a-f0-9]{40}$ &&
  "$(git rev-parse HEAD)" == "$H5C_CANARY_REVIEWED_SHA" ]] ||
 { echo "QA_PERMIT_DENIED: reviewed exact source SHA mismatch" >&2;exit 1; }
sha=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
# Every SQL literal is from the hardcoded case mapping above.
# Advisory lock serializes with the release claim transaction.
docker exec -i hi5central-postgres sh -c \
 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
BEGIN;
DO \$\$
DECLARE
 target uuid := '$job'::uuid;
 changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('hi5central-release-claim'),hashtext('shared-gateway'));
 IF now() < '$start'::timestamptz OR now() >= '$end'::timestamptz THEN
   RAISE EXCEPTION 'QA Test window closed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM platform_release_rollout_control WHERE singleton=true AND paused=true) THEN
   RAISE EXCEPTION 'Global rollout unexpectedly enabled';
 END IF;
 IF EXISTS(SELECT 1 FROM tenant_release_rollout_jobs WHERE status='running' AND lease_expires_at>now()) THEN
   RAISE EXCEPTION 'Another job is already being deployed';
 END IF;
 IF EXISTS(SELECT 1 FROM platform_release_single_test_canary_permits WHERE state='armed') THEN
   RAISE EXCEPTION 'Another single-job permit is still armed';
 END IF;
 IF EXISTS(SELECT 1 FROM platform_release_single_test_canary_permits WHERE job_id=target) THEN
   RAISE EXCEPTION 'QA permit already used; operator recovery required';
 END IF;
 INSERT INTO platform_release_single_test_canary_permits
  (job_id,tenant_id,build_sha,environment,tenant_slug,not_before,expires_at,approved_by)
 SELECT j.id,j.tenant_id,j.build_sha,'test',t.slug,now(),now()+interval '45 minutes',c.approved_by
 FROM tenant_release_rollout_jobs j
 JOIN tenants t ON t.id=j.tenant_id
 JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id
 JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha
 WHERE j.id=target AND t.slug='$slug'
   AND j.environment='test' AND j.build_sha='$sha'
   AND j.status='scheduled' AND j.attempt_count=0
   AND j.scheduled_at<=now() AND p.update_mode='$mode'
   AND p.test_auto_sync=true
   AND t.status='active' AND c.status='approved'
   AND c.approved_by IS NOT NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'Exact reviewed job cannot receive a permit'; END IF;
END
\$\$;
COMMIT;
SQL
echo "QA_EXACT_TEST_PERMIT_ARMED slug=$slug job=$job valid_for=45_minutes"
echo "GLOBAL_ROLLOUT_REMAINS_PAUSED"
