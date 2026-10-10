-- Customer-dedicated UAT is OPTIONAL under Hi5Central-managed releases.
-- Internal Hi5Central release validation is unaffected.
ALTER TABLE tenant_release_preferences
 ADD COLUMN IF NOT EXISTS customer_uat_opt_in boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_release_preferences.customer_uat_opt_in IS
 'Customer-dedicated UAT opt-in; custom/manual updates require UAT. Does not provision storage or routes.';
UPDATE tenant_release_preferences SET customer_uat_opt_in=true
 WHERE update_mode='admin_controlled' AND customer_uat_opt_in=false;
