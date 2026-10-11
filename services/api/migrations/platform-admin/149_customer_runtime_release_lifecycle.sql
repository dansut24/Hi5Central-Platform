-- Tenant-specific application release acceptance and future host scheduling.
-- Migration is metadata only: no tenant routing, Docker or Caddy changes.
ALTER TABLE tenant_runtime_update_offers
  ADD COLUMN IF NOT EXISTS acceptance_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS promotion_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_gate_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;

CREATE TABLE IF NOT EXISTS tenant_runtime_release_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES tenant_runtime_update_offers(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN
    ('uat_attested','uat_accepted','production_scheduled','maintenance_deferred',
     'activation_verified','release_blocked','rolled_back')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  build_sha text NOT NULL CHECK(build_sha ~ '^[a-f0-9]{40}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_runtime_release_events_by_offer
  ON tenant_runtime_release_events(offer_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS tenant_runtime_release_events_by_tenant
  ON tenant_runtime_release_events(tenant_id,occurred_at DESC);

-- Nothing is automatically due on migration. New offers remain pending
-- a separately attested host route and explicit UAT acceptance.

CREATE TABLE IF NOT EXISTS tenant_runtime_route_attestations (
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 environment text NOT NULL CHECK(environment IN ('uat','live')),
 pool_id text NOT NULL,
 build_sha text NOT NULL CHECK(build_sha ~ '^[a-f0-9]{40}$'),
 public_host text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','rolled_back')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,environment),
 FOREIGN KEY(pool_id,environment) REFERENCES platform_runtime_pools(id,environment)
);
CREATE INDEX IF NOT EXISTS tenant_runtime_route_attestations_pool
  ON tenant_runtime_route_attestations(pool_id,environment);
