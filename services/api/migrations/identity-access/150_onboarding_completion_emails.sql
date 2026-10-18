-- Owner onboarding-complete message, queued once per tenant.
-- The completion record is committed in the onboarding transaction and
-- is independently deliverable; SMTP failures must never undo onboarding.
CREATE TABLE IF NOT EXISTS onboarding_completion_emails (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','retry')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_completion_emails_due
  ON onboarding_completion_emails(next_attempt_at, created_at)
  WHERE status IN ('pending','retry','sending');
