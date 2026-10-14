-- Append-only operational metadata for ITSM configuration changes.
-- Never write credentials or raw before/after configuration values to this ledger.
-- People, security, theme, billing and RMM are Live-owned, not UAT changes.
CREATE TABLE IF NOT EXISTS itsm_configuration_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('live','uat')),
  entity_key text NOT NULL DEFAULT 'tenant_settings.itsm',
  before_sha256 text NOT NULL CHECK (before_sha256 ~ '^[0-9a-f]{64}$'),
  after_sha256 text NOT NULL CHECK (after_sha256 ~ '^[0-9a-f]{64}$'),
  changed_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (before_sha256 <> after_sha256)
);
CREATE INDEX IF NOT EXISTS itsm_configuration_change_events_history_idx
  ON itsm_configuration_change_events (tenant_id, environment, recorded_at DESC, id DESC);
