-- Hi5Central EPM Newtest native UAC credential UI review records.
-- A reviewed request is NEVER a Windows credential or an elevation grant.
-- Unknown underlying UAC target: release disabled until a verified scope exists.
CREATE TABLE IF NOT EXISTS rmm_epm_native_uac_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_device_id uuid NOT NULL REFERENCES rmm_agent_devices(id) ON DELETE CASCADE,
  requester_sid text NOT NULL,
  requester_name text NOT NULL,
  requester_session_id integer NOT NULL CHECK (requester_session_id > 0),
  consent_process_id integer NOT NULL CHECK (consent_process_id > 0),
  consent_process_started_at timestamptz NOT NULL,
  business_reason text NOT NULL CHECK (char_length(business_reason) BETWEEN 20 AND 512),
  scope text NOT NULL DEFAULT 'unidentified-native-uac' CHECK (scope='unidentified-native-uac'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reviewed','rejected','expired','cancelled')),
  credential_release_enabled boolean NOT NULL DEFAULT false
    CHECK (credential_release_enabled=false),
  decision_note text,
  decided_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epm_uac_pid_scope_unique UNIQUE
    (tenant_id,agent_device_id,requester_session_id,consent_process_id,consent_process_started_at)
);
CREATE INDEX IF NOT EXISTS rmm_epm_native_uac_reviews_tenant_created_idx
  ON rmm_epm_native_uac_reviews (tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS rmm_epm_native_uac_reviews_endpoint_status_idx
  ON rmm_epm_native_uac_reviews (agent_device_id,status,created_at DESC);
COMMENT ON TABLE rmm_epm_native_uac_reviews IS
  'Review-only native UAC requests: underlying operation unavailable to credential provider; no admin authentication or elevation permitted.';
