-- Separately attested *central* managed control plane identity.
-- No value is inserted automatically: internal Dev, legacy single-tenant
-- environments and self-hosted instances MUST fail provisioning closed.
CREATE TABLE IF NOT EXISTS managed_control_plane_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  deployment_mode text NOT NULL CHECK (deployment_mode = 'managed'),
  tenancy_mode text NOT NULL CHECK (tenancy_mode = 'multi'),
  root_domain text NOT NULL CHECK (root_domain ~ '^[a-z0-9.-]+$'),
  instance_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  verified_by text NOT NULL CHECK (length(trim(verified_by)) >= 3),
  verified_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE managed_control_plane_identity IS
  'Independent operator attestation of the managed multi-tenant control plane. Empty until verified; never automatically populate from deployment settings.';
