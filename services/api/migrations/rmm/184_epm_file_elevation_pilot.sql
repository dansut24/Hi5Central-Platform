-- Hi5Central EPM: support-approved, file-specific elevations. No managed App Portal install is dispatched.
CREATE TABLE IF NOT EXISTS rmm_epm_file_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_device_id uuid NOT NULL REFERENCES rmm_agent_devices(id) ON DELETE CASCADE,
  requester_sid text NOT NULL,
  requester_name text NOT NULL DEFAULT '',
  requester_session_id integer NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[A-F0-9]{64}$'),
  publisher text NOT NULL,
  signer_thumbprint text NOT NULL CHECK (length(signer_thumbprint) BETWEEN 40 AND 128),
  business_reason text NOT NULL CHECK (length(business_reason) BETWEEN 20 AND 2000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','redeemed','launch_failed','expired')),
  decision_note text NOT NULL DEFAULT '',
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  approval_expires_at timestamptz,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rmm_epm_file_requests_tenant_status
  ON rmm_epm_file_requests(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS rmm_epm_file_requests_device_sid
  ON rmm_epm_file_requests(agent_device_id,requester_sid,created_at DESC);
