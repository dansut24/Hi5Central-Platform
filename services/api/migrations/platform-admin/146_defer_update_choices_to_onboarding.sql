-- Signup and Platform Admin registration precede the customer's update choice.
-- Existing explicitly configured tenants retain their current policies.
ALTER TABLE managed_public_signup_requests
  ALTER COLUMN update_mode DROP NOT NULL;
ALTER TABLE tenant_release_preferences
  ADD COLUMN IF NOT EXISTS onboarding_selection_pending boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_release_preferences.onboarding_selection_pending IS
  'New managed customer has not selected Managed/Custom during authenticated onboarding. The legacy manual default is a fail-closed placeholder, never consent to Custom/UAT.';
