-- Pilot Admin: password verification MUST NOT by itself grant any platform session.
-- Separate one-time challenges, encrypted TOTP and proof-of-MFA sessions.
ALTER TABLE platform_admin_sessions
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_admin_mfa_methods (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_used_step bigint,
  recovery_code_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  enrolled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_admin_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_admin_mfa_challenges_user
  ON platform_admin_mfa_challenges(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS platform_admin_mfa_challenges_active
  ON platform_admin_mfa_challenges(token_hash,expires_at) WHERE used_at IS NULL;
COMMENT ON TABLE platform_admin_mfa_challenges IS
  'One-time 10-minute password-stage challenges; never substitute for completed administrator TOTP authentication.';
