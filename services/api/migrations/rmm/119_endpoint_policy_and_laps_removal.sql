-- Reversible endpoint-policy withdrawal and auditable Hi5Central local-admin retirement.
-- Migration is additive except replacing the legacy profile-name uniqueness rule
-- with an active-only uniqueness index so removed profiles may be recreated.
ALTER TABLE rmm_endpoint_profiles
 ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS rmm_endpoint_profiles_active_tenant
 ON rmm_endpoint_profiles(tenant_id,updated_at DESC) WHERE archived_at IS NULL;
ALTER TABLE rmm_endpoint_profiles
 DROP CONSTRAINT IF EXISTS rmm_endpoint_profiles_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS rmm_endpoint_profiles_active_name
 ON rmm_endpoint_profiles(tenant_id,name) WHERE archived_at IS NULL;

ALTER TABLE rmm_local_admin_accounts
 DROP CONSTRAINT IF EXISTS rmm_local_admin_accounts_state_check;
ALTER TABLE rmm_local_admin_accounts
 ADD CONSTRAINT rmm_local_admin_accounts_state_check
 CHECK(state IN ('pending','active','error','disabled','removing','removed','removal_uncertain'));
ALTER TABLE rmm_local_admin_accounts
 ADD COLUMN IF NOT EXISTS removal_job_id uuid REFERENCES rmm_agent_jobs(id) ON DELETE SET NULL,
 ADD COLUMN IF NOT EXISTS removed_at timestamptz;
CREATE INDEX IF NOT EXISTS rmm_local_admin_accounts_unremoved
 ON rmm_local_admin_accounts(tenant_id,agent_device_id)
 WHERE state <> 'removed';

-- Historical rotations and audit remain attached to the same account row.
-- The removal receipt will zero encrypted credential ciphertext and clear
-- current_rotation_id only after Windows confirms the account is absent.
