-- Customer-controlled, tenant-scoped feature releases. Not platform binary deployments.
INSERT INTO platform_feature_definitions
  (feature_key,title,description,component,default_enabled)
VALUES ('itsm.live_chat','Live Chat','Enable Live Chat in the ITSM workspace','itsm',false)
ON CONFLICT (feature_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_feature_release_approvals (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES platform_feature_definitions(feature_key),
  state text NOT NULL CHECK (state IN ('staged','uat_passed','promoted')),
  release_ref text NOT NULL,
  staged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  promoted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  promoted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,feature_key)
);

-- Append-only timeline of stages, test evidence and production approvals.
-- Each record retains its original reference even after the next rollout.
CREATE TABLE IF NOT EXISTS tenant_feature_release_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES platform_feature_definitions(feature_key),
  release_ref text NOT NULL,
  action text NOT NULL CHECK (action IN ('staged_uat','uat_passed','promoted_live')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_feature_release_events_tenant_history_idx
  ON tenant_feature_release_events(tenant_id,recorded_at DESC,id DESC);
