-- Hi5Central Local Admin Protection: secrets are encrypted by a tenant-bound
-- application key before this table is written. Native Windows LAPS secrets are NOT stored here.
CREATE TABLE IF NOT EXISTS rmm_local_admin_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 agent_device_id uuid NOT NULL REFERENCES rmm_agent_devices(id) ON DELETE CASCADE,
 inventory_id uuid NOT NULL REFERENCES rmm_device_inventory(id) ON DELETE CASCADE,
 account_name text NOT NULL DEFAULT 'Hi5Recovery',
 account_sid text,
 mode text NOT NULL DEFAULT 'hi5central' CHECK (mode IN ('hi5central')),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','error','disabled')),
 create_account boolean NOT NULL DEFAULT true,
 current_rotation_id uuid,
 last_rotated_at timestamptz,
 next_rotation_at timestamptz,
 last_error text,
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,agent_device_id)
);
CREATE INDEX IF NOT EXISTS rmm_local_admin_accounts_tenant ON rmm_local_admin_accounts(tenant_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS rmm_local_admin_rotations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES rmm_local_admin_accounts(id) ON DELETE CASCADE,
 agent_device_id uuid NOT NULL REFERENCES rmm_agent_devices(id) ON DELETE CASCADE,
 job_id uuid NOT NULL UNIQUE REFERENCES rmm_agent_jobs(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','escrowed','active','uncertain','failed','superseded')),
 credential_ciphertext text,
 key_version smallint NOT NULL DEFAULT 1,
 escrowed_at timestamptz,
 activated_at timestamptz,
 retired_at timestamptz,
 revealed_at timestamptz,
 reveal_count integer NOT NULL DEFAULT 0,
 created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rmm_local_admin_rotations_lookup ON rmm_local_admin_rotations(tenant_id,account_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rmm_local_admin_one_active_rotation ON rmm_local_admin_rotations(account_id) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS rmm_local_admin_one_pending_rotation ON rmm_local_admin_rotations(account_id) WHERE state IN ('queued','escrowed','uncertain');
ALTER TABLE rmm_local_admin_accounts
 ADD CONSTRAINT rmm_local_admin_current_rotation_fkey FOREIGN KEY (current_rotation_id)
 REFERENCES rmm_local_admin_rotations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS rmm_local_admin_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES rmm_local_admin_accounts(id) ON DELETE CASCADE,
 rotation_id uuid REFERENCES rmm_local_admin_rotations(id) ON DELETE SET NULL,
 event_type text NOT NULL,
 reason text NOT NULL DEFAULT '',
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('technician','agent','system')),
 created_at timestamptz NOT NULL DEFAULT now(),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rmm_local_admin_audit_lookup ON rmm_local_admin_audit(tenant_id,account_id,created_at DESC);
