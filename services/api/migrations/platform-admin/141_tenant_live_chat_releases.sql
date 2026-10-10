-- Tenant-scoped, manually approved feature changes. No global feature flags.
INSERT INTO platform_feature_definitions
  (feature_key,title,description,component,default_enabled)
VALUES
  ('itsm.live_chat','Live Chat','Enable the ITSM Live Chat workspace','itsm',false)
ON CONFLICT (feature_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_feature_release_approvals (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES platform_feature_definitions(feature_key),
  state text NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged','uat_passed','promoted')),
  release_ref text NOT NULL DEFAULT '',
  staged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  promoted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  promoted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,feature_key)
);
