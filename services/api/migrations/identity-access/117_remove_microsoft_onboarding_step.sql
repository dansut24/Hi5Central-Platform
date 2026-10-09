-- Microsoft 365 configuration moved out of first-run onboarding and into Settings.
-- Any tenant paused on the legacy users step should continue at Teams & groups.
UPDATE tenant_settings
SET onboarding_step = 'groups',
    updated_at = now()
WHERE onboarding_completed_at IS NULL
  AND onboarding_step = 'users';
