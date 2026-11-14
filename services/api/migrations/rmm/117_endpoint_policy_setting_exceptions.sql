-- Endpoint configuration control plane. No Windows settings are modified by this migration.
CREATE TABLE IF NOT EXISTS rmm_endpoint_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 name text NOT NULL,
 description text NOT NULL DEFAULT '',
 kind text NOT NULL DEFAULT 'baseline' CHECK (kind IN ('baseline','configuration','laps')),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','disabled')),
 scope_type text NOT NULL DEFAULT 'estate' CHECK (scope_type IN ('estate','group','device','user')),
 scope_id text NOT NULL DEFAULT '',
 settings jsonb NOT NULL DEFAULT '[]'::jsonb,
 revision integer NOT NULL DEFAULT 1,
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,name)
);
CREATE INDEX IF NOT EXISTS rmm_endpoint_profiles_tenant ON rmm_endpoint_profiles(tenant_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS rmm_endpoint_setting_exceptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES rmm_endpoint_profiles(id) ON DELETE CASCADE,
 setting_key text NOT NULL,
 scope_type text NOT NULL CHECK (scope_type IN ('device','group','user')),
 scope_id text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('exclude','override')),
 value jsonb,
 reason text NOT NULL,
 risk_accepted boolean NOT NULL DEFAULT false,
 expires_at timestamptz,
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT rmm_endpoint_exception_mode_value CHECK (
   (mode='exclude' AND value IS NULL) OR (mode='override' AND value IS NOT NULL)
 )
);
CREATE UNIQUE INDEX IF NOT EXISTS rmm_endpoint_exception_active_unique
 ON rmm_endpoint_setting_exceptions(tenant_id,profile_id,setting_key,scope_type,scope_id)
 WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rmm_endpoint_exception_resolution
 ON rmm_endpoint_setting_exceptions(tenant_id,profile_id,revoked_at,expires_at);

CREATE TABLE IF NOT EXISTS rmm_endpoint_policy_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 profile_id uuid REFERENCES rmm_endpoint_profiles(id) ON DELETE SET NULL,
 exception_id uuid REFERENCES rmm_endpoint_setting_exceptions(id) ON DELETE SET NULL,
 action text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rmm_endpoint_policy_history_tenant
 ON rmm_endpoint_policy_history(tenant_id,created_at DESC);
