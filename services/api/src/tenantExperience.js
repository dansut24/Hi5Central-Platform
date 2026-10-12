// Resolve the personal workspace settings of one tenant membership.
// Legacy user-wide settings remain valid for tenants that were already onboarded
// when the user first personalised their workspace. Newly created organisations
// must never inherit that old completed-first-login marker or personal accent.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const timestamp = value => {
  if (!value) return null
  const millis = new Date(value).getTime()
  return Number.isFinite(millis) ? millis : null
}

export function tenantExperienceSnapshot(row, tenantId, onboardingCompletedAt) {
  const key = String(tenantId || '')
  const preferences = object(row?.preferences)
  const guidance = object(row?.platform_guidance)
  const started = object(row?.platform_getting_started)
  const overrides = object(preferences.tenantOverrides)
  const firstMarkers = object(guidance.tenantFirstLogin)
  const tenantGuidance = object(object(guidance.tenantPlatforms)[key])
  const tenantStarted = object(object(started.tenantPlatforms)[key])
  const priorFinished = timestamp(row?.first_login_completed_at)
  const onboardingFinished = timestamp(onboardingCompletedAt)
  const originalTenantComplete = priorFinished !== null
    && (onboardingFinished === null || priorFinished >= onboardingFinished)
  const tenantFinished = firstMarkers[key] || (originalTenantComplete ? row.first_login_completed_at : null)
  const scopedPreferences = Object.hasOwn(overrides, key)
    ? object(overrides[key])
    : originalTenantComplete ? preferences : null
  const scopedGuidance = Object.hasOwn(object(guidance.tenantPlatforms), key)
    ? tenantGuidance : originalTenantComplete ? guidance : {}
  const scopedStarted = Object.hasOwn(object(started.tenantPlatforms), key)
    ? tenantStarted : originalTenantComplete ? started : {}
  return {
    preferences: scopedPreferences,
    firstLoginCompletedAt: tenantFinished || null,
    platformGuidance: scopedGuidance,
    platformGettingStarted: scopedStarted,
  }
}
