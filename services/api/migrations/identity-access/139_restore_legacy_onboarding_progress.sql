-- Legacy October 2026 onboarding had a Users step but no Domain & email step.
-- Migration 119 moves these in-progress tenants to delivery. That is correct for
-- earlier setups, but MUST NOT discard canonical progress already saved after
-- Teams, Permissions, Security, ITSM or RMM. No prior answer is overwritten.
-- A legacy 'users' data key and absent 'delivery' key distinguish these tenants.
UPDATE tenant_settings
SET onboarding_step = CASE
      WHEN COALESCE(onboarding_data,'{}'::jsonb) ? 'billing'
        OR COALESCE(onboarding_data,'{}'::jsonb) ? 'rmm'
        THEN 'finish'
      WHEN COALESCE(onboarding_data,'{}'::jsonb) ? 'itsm'
        THEN CASE WHEN modules->>'rmm' = 'true' THEN 'rmm' ELSE 'finish' END
      WHEN COALESCE(onboarding_data,'{}'::jsonb) ? 'security'
        THEN 'updates'
      WHEN COALESCE(onboarding_data,'{}'::jsonb) ? 'permissions'
        THEN 'security'
      WHEN COALESCE(onboarding_data,'{}'::jsonb) ? 'groups'
        THEN 'permissions'
      ELSE onboarding_step
    END,
    updated_at = now()
WHERE onboarding_completed_at IS NULL
  AND onboarding_step = 'delivery'
  AND COALESCE(onboarding_data,'{}'::jsonb) ? 'users'
  AND NOT COALESCE(onboarding_data,'{}'::jsonb) ? 'delivery'
  AND (
    COALESCE(onboarding_data,'{}'::jsonb) ? 'groups'
    OR COALESCE(onboarding_data,'{}'::jsonb) ? 'permissions'
    OR COALESCE(onboarding_data,'{}'::jsonb) ? 'security'
    OR COALESCE(onboarding_data,'{}'::jsonb) ? 'itsm'
    OR COALESCE(onboarding_data,'{}'::jsonb) ? 'rmm'
    OR COALESCE(onboarding_data,'{}'::jsonb) ? 'billing'
  );
