-- Single-owner pilot bootstrap: email-link proof and MFA replace a
-- second human reviewer. Keep dual-control invitations for larger operators.
ALTER TABLE pilot_admin_bootstrap_invitations
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'dual_control';
ALTER TABLE pilot_admin_bootstrap_invitations
  ALTER COLUMN reviewed_by DROP NOT NULL;
ALTER TABLE pilot_admin_bootstrap_invitations
  ALTER COLUMN reviewer_evidence_sha256 DROP NOT NULL;
ALTER TABLE pilot_admin_bootstrap_invitations
  DROP CONSTRAINT IF EXISTS pilot_admin_bootstrap_invitations_check;
ALTER TABLE pilot_admin_bootstrap_invitations
  DROP CONSTRAINT IF EXISTS pilot_admin_bootstrap_invitations_approval_mode_check;
ALTER TABLE pilot_admin_bootstrap_invitations
  ADD CONSTRAINT pilot_admin_bootstrap_invitations_approval_mode_check
  CHECK (
    (approval_mode='dual_control' AND reviewed_by IS NOT NULL
      AND reviewer_evidence_sha256 IS NOT NULL AND issued_by<>reviewed_by)
    OR (approval_mode='single_owner' AND reviewed_by IS NULL
      AND reviewer_evidence_sha256 IS NULL
      AND issued_by='pilot-single-owner-operator')
  );
COMMENT ON COLUMN pilot_admin_bootstrap_invitations.approval_mode IS
  'dual_control: independent reviewer; single_owner: first-person pilot setup, email-link redemption and MFA mandatory.';
