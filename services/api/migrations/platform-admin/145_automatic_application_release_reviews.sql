-- UAT reviewers approve immutable application changes without registering
-- one feature flag per code change. This is not a data synchronisation table.
CREATE TABLE IF NOT EXISTS tenant_application_release_reviews (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  approved_change_shas jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','requested','forwarded')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,build_sha)
);
CREATE INDEX IF NOT EXISTS tenant_application_review_requests_idx
 ON tenant_application_release_reviews(status,requested_at DESC)
 WHERE status='requested';

-- Platform-wide binaries are controlled by Platform Admin. A request from UAT
-- is never itself permission to deploy shared application code.
CREATE TABLE IF NOT EXISTS platform_application_release_requests (
  request_key text PRIMARY KEY,
  source_tenant_slug text NOT NULL,
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  approved_change_shas jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence text NOT NULL DEFAULT '',
  reviewed_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','queued')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);
