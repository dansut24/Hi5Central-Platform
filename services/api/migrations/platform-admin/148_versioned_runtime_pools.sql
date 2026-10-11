-- Versioned runtime pools are an opt-in routing control plane. Merely
-- migrating these tables never changes customer traffic or starts containers.
-- Pools share the environment database; migrations must remain compatible
-- across every active release version. No tenant operational data is copied.
CREATE TABLE IF NOT EXISTS platform_runtime_pools (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{2,62}$'),
  environment text NOT NULL CHECK (environment IN ('test','uat','live')),
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  api_target text NOT NULL DEFAULT '' CHECK (length(api_target)<=100),
  web_target text NOT NULL DEFAULT '' CHECK (length(web_target)<=100),
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning','verified','draining','failed')),
  verified_at timestamptz,
  last_seen_at timestamptz,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,environment),
  CHECK (state <> 'verified' OR (verified_at IS NOT NULL
    AND api_target <> '' AND web_target <> ''))
);
CREATE INDEX IF NOT EXISTS platform_runtime_pool_build_lookup
  ON platform_runtime_pools(environment,build_sha,state);

-- No assignment is created by this migration: existing production hostname
-- routes remain on the stable pool until a verified pool is activated via
-- a separately approved host-level routing generation.
CREATE TABLE IF NOT EXISTS tenant_runtime_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('uat','live')),
  pool_id text NOT NULL,
  build_sha text NOT NULL CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  generation bigint NOT NULL DEFAULT 0,
  activated_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(tenant_id,environment),
  FOREIGN KEY (pool_id,environment) REFERENCES platform_runtime_pools(id,environment)
);
CREATE INDEX IF NOT EXISTS tenant_runtime_assignments_pool_lookup
  ON tenant_runtime_assignments(pool_id,environment);

-- One pending release per tenant+environment. This queue cannot deploy code;
-- only host-verified pool assignments may ever become active.
CREATE TABLE IF NOT EXISTS tenant_runtime_update_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK(environment IN ('uat','live')),
  pool_id text NOT NULL,
  build_sha text NOT NULL CHECK(build_sha ~ '^[a-f0-9]{40}$'),
  update_mode text NOT NULL CHECK(update_mode IN ('hi5_managed','admin_controlled')),
  state text NOT NULL DEFAULT 'offered'
    CHECK(state IN ('offered','uat_testing','uat_accepted','scheduled',
      'activating','active','blocked','cancelled')),
  notes text NOT NULL DEFAULT '',
  maintenance_not_before timestamptz,
  uat_accepted_at timestamptz,
  uat_accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(pool_id,environment) REFERENCES platform_runtime_pools(id,environment)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_runtime_offer_per_tenant_environment
  ON tenant_runtime_update_offers(tenant_id,environment)
  WHERE state IN ('offered','uat_testing','uat_accepted','scheduled','activating');
CREATE INDEX IF NOT EXISTS tenant_runtime_offers_state_due
  ON tenant_runtime_update_offers(state,maintenance_not_before)
  WHERE state IN ('uat_accepted','scheduled');

-- Routing plans must be approved, verified and activated by the trusted host;
-- browser/admin requests never write the live Caddy configuration.
CREATE TABLE IF NOT EXISTS platform_runtime_route_generations (
  generation bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL CHECK(environment IN ('uat','live')),
  state text NOT NULL DEFAULT 'draft'
    CHECK(state IN ('draft','verified','active','rolled_back','failed')),
  mapping_sha256 text NOT NULL DEFAULT '',
  previous_generation bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_runtime_route_generation
  ON platform_runtime_route_generations(environment) WHERE state='active';
