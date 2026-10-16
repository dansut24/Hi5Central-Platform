#!/usr/bin/env bash
# Human-authorised single QA Test permit. NEVER disable global rollout pause.
# Run on the real VPS as root AFTER staging the exact reviewed canary code.
set -Eeuo pipefail
set +x
umask 077
SHA=9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0
JOB=2ab0c800-f01d-40f7-b1db-a624b4543b2a
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
[[ "$(id -u)" == 0 ]] || { echo "CANARY_PERMIT_BLOCKED: root admin required";exit 1; }
[[ "${H5C_CANARY_REVIEWED_SHA:-}" =~ ^[a-f0-9]{40}$ &&
   "$(git rev-parse HEAD)" == "$H5C_CANARY_REVIEWED_SHA" ]] ||
  { echo "CANARY_PERMIT_BLOCKED: reviewed source revision mismatch";exit 1; }
docker exec hi5central-release-executor-test test -f   /runner/qa-single-test-canary/services/api/src/tenantReleaseExecutor.mjs
docker inspect hi5pool-test-9f3cb1da7c27-api hi5pool-test-9f3cb1da7c27-web \
  --format '{{.State.Health.Status}}' | grep -c '^healthy$' | grep -qx 2
# An exact, bounded permit valid ONLY 2026-10-16 14:00–14:45 Europe/London.
# The maint-window policy, global pause and no-other-running-jobs are verified
# again by queue and host at the moment of cutover.
cat <<'SQL' | docker exec -i hi5central-postgres sh -c \
  'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
BEGIN;
DO $$
DECLARE
  wanted uuid := '2ab0c800-f01d-40f7-b1db-a624b4543b2a';
  existing int;
  row_count int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM platform_release_rollout_control WHERE singleton AND paused) THEN
    RAISE EXCEPTION 'Global customer pause must stay enabled';
  END IF;
  IF EXISTS(SELECT 1 FROM tenant_release_rollout_jobs WHERE status='running' AND lease_expires_at>now()) THEN
    RAISE EXCEPTION 'Another release currently owns a deployment lease';
  END IF;
  IF EXISTS(SELECT 1 FROM platform_release_single_test_canary_permits WHERE state='armed') THEN
    RAISE EXCEPTION 'An armed Test canary already exists';
  END IF;
  IF EXISTS(SELECT 1 FROM platform_release_single_test_canary_permits WHERE job_id=wanted) THEN
    RAISE EXCEPTION 'Canary permit already used; do not replay';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM tenant_release_rollout_jobs j
    JOIN tenants t ON t.id=j.tenant_id
    JOIN tenant_release_preferences p ON p.tenant_id=t.id
    JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha
    WHERE j.id=wanted AND t.slug='h5c-managed-qa26'
      AND j.environment='test'
      AND j.build_sha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
      AND j.status='scheduled' AND j.attempt_count=0
      AND j.scheduled_at='2026-10-16T13:00:00Z'::timestamptz
      AND p.update_mode='hi5_managed'
      AND c.status='approved' AND c.approved_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Exact certified, scheduled Managed QA Test job absent';
  END IF;
  INSERT INTO platform_release_single_test_canary_permits
    (job_id,tenant_id,build_sha,environment,tenant_slug,not_before,expires_at,approved_by)
  SELECT j.id,j.tenant_id,j.build_sha,'test',t.slug,
    '2026-10-16T13:00:00Z'::timestamptz,
    '2026-10-16T13:45:00Z'::timestamptz,
    c.approved_by
  FROM tenant_release_rollout_jobs j
  JOIN tenants t ON t.id=j.tenant_id
  JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha
  WHERE j.id=wanted AND c.status='approved'
  RETURNING 1 INTO existing;
  IF existing<>1 THEN RAISE EXCEPTION 'Single canary permit could not be armed'; END IF;
END $$;
COMMIT;
SQL
echo "SINGLE_TEST_CANARY_PERMIT_ARMED_SHA=$SHA"
echo "SINGLE_TEST_CANARY_JOB_ID=$JOB"
echo "GLOBAL_ROLLOUT_REMAINS_PAUSED"
