-- The deployed application is shared by every tenant in one environment.
-- A tenant feature promotion must never imply that the global application has
-- been deployed. Only a host-side operator can attest its observed images.
CREATE TABLE IF NOT EXISTS platform_application_deployment_attestations (
  environment text PRIMARY KEY CHECK (environment IN ('dev','test','uat','live')),
  status text NOT NULL CHECK (status IN ('verified','deploying','failed','rolled_back')),
  api_sha text CHECK (api_sha IS NULL OR api_sha ~ '^[a-f0-9]{40}$'),
  itsm_sha text CHECK (itsm_sha IS NULL OR itsm_sha ~ '^[a-f0-9]{40}$'),
  release_ref text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (api_sha IS NOT NULL AND itsm_sha IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS platform_application_deployment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('dev','test','uat','live')),
  status text NOT NULL CHECK (status IN ('verified','deploying','failed','rolled_back')),
  api_sha text,
  itsm_sha text,
  release_ref text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_app_deployment_events_recent_idx
  ON platform_application_deployment_events(environment,recorded_at DESC,id DESC);

-- Bind the customer's UAT acceptance to the actual API and ITSM revision.
-- Older promotion records remain readable; only new approvals need the gate.
ALTER TABLE tenant_feature_release_approvals
  ADD COLUMN IF NOT EXISTS tested_api_sha text,
  ADD COLUMN IF NOT EXISTS tested_itsm_sha text;

-- Platform administrator approval queues a host-only deployment. Tenant owners
-- cannot enqueue a deployment of shared multi-tenant application binaries.
CREATE TABLE IF NOT EXISTS platform_application_deployment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_environment text NOT NULL CHECK (from_environment IN ('dev','uat')),
  to_environment text NOT NULL CHECK (to_environment IN ('uat','live')),
  api_sha text NOT NULL CHECK (api_sha ~ '^[a-f0-9]{40}$'),
  itsm_sha text NOT NULL CHECK (itsm_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','running','succeeded','failed','rolled_back')),
  release_ref text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_one_pending_app_deployment_per_environment
  ON platform_application_deployment_jobs(to_environment)
  WHERE status IN ('requested','running');
CREATE INDEX IF NOT EXISTS platform_app_deployment_jobs_recent_idx
  ON platform_application_deployment_jobs(requested_at DESC);
