-- Phase 16: signed operator evidence is bound to a specific tenant, request,
-- database, Redis scope and action. Old unsigned approval audit rows remain
-- visible but CANNOT authorize new activations.
ALTER TABLE managed_environment_activation_audit
  ADD COLUMN IF NOT EXISTS actor_evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS reviewer_evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS actor_key_id text,
  ADD COLUMN IF NOT EXISTS reviewer_key_id text;

CREATE UNIQUE INDEX IF NOT EXISTS managed_activation_actor_evidence_once
 ON managed_environment_activation_audit(actor_evidence_sha256)
 WHERE actor_evidence_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS managed_activation_reviewer_evidence_once
 ON managed_environment_activation_audit(reviewer_evidence_sha256)
 WHERE reviewer_evidence_sha256 IS NOT NULL;

COMMENT ON COLUMN managed_environment_activation_audit.actor_evidence_sha256 IS
  'SHA-256 of out-of-band verified signed actor assertion; never the private key or original assertion';
COMMENT ON COLUMN managed_environment_activation_audit.reviewer_evidence_sha256 IS
  'One-use, independently signed reviewer assertion bound to operation, tenant and environment';
