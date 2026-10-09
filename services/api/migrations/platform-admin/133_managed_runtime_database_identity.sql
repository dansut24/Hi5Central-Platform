-- Per-runtime database identity. Deliberately starts WITHOUT a row.
-- The infrastructure operator must initialise this after inspecting the real
-- environment's database and network configuration; application migrations
-- must never claim UAT/Test identity automatically.
CREATE TABLE IF NOT EXISTS managed_runtime_database_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  environment text NOT NULL CHECK (environment IN ('uat','test')),
  root_domain text NOT NULL,
  instance_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  verified_by text NOT NULL CHECK (length(trim(verified_by)) >= 3),
  verified_at timestamptz NOT NULL DEFAULT now(),
  CHECK (root_domain ~ '^[a-z0-9.-]+$')
);

COMMENT ON TABLE managed_runtime_database_identity IS
  'Operator-attested environment database identity; empty until infrastructure verification. Not a substitute for session/RMM/egress isolation.';
