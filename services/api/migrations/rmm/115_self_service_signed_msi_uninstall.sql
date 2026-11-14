-- Administrators must enable each published MSI removal individually.
-- Default false preserves all existing customer applications.
ALTER TABLE rmm_app_portal_apps
 ADD COLUMN IF NOT EXISTS allow_self_service_uninstall boolean NOT NULL DEFAULT false;
