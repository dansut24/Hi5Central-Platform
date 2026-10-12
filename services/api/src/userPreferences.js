import { originMatchesTenantAccount } from './deploymentConfig.js'
import { pool, withTransaction } from './db.js'
import { tenantExperienceSnapshot } from './tenantExperience.js'
import { resolveSession } from './session.js'

const ALLOWED_THEME = new Set(['system', 'light', 'dark'])
const ALLOWED_ACCENT = new Set(['amber', 'cyan', 'blue', 'violet', 'emerald', 'rose'])

function normaliseAccent(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (ALLOWED_ACCENT.has(raw)) return raw
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  return '#3b82f6'
}
const ALLOWED_DENSITY = new Set(['comfortable', 'compact'])
const ALLOWED_SIDE = new Set(['left', 'right'])
const ALLOWED_STYLE = new Set(['floating', 'clean'])
const ALLOWED_MODE = new Set(['expanded', 'collapsed', 'hidden'])
const ALLOWED_PLATFORM = new Set(['itsm', 'rmm', 'admin'])

function originMatchesSession(c, session) {
  return originMatchesTenantAccount(c.req.header('origin'), session.slug)
}

async function requireSession(c) {
  const session = await resolveSession(c)
  if (!session) return { error: c.json({ error: 'Authentication required.' }, 401) }
  if (!originMatchesSession(c, session)) return { error: c.json({ error: 'Tenant session mismatch.' }, 403) }
  return { session }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalisePlatform(value, fallback = 'itsm') {
  const platform = String(value || '').trim().toLowerCase()
  return ALLOWED_PLATFORM.has(platform) ? platform : fallback
}

export function normalisePreferences(input = {}) {
  const data = asObject(input)
  const appearance = asObject(data.appearance)
  const navigation = asObject(data.navigation)
  const guidance = asObject(data.guidance)

  return {
    appearance: {
      theme: ALLOWED_THEME.has(appearance.theme) ? appearance.theme : 'light',
      accentMode: appearance.accentMode === 'personal' ? 'personal' : 'tenant',
      accent: normaliseAccent(appearance.accent),
      density: ALLOWED_DENSITY.has(appearance.density) ? appearance.density : 'comfortable',
    },
    navigation: {
      desktopSide: ALLOWED_SIDE.has(navigation.desktopSide) ? navigation.desktopSide : 'left',
      mobileSide: ALLOWED_SIDE.has(navigation.mobileSide) ? navigation.mobileSide : 'left',
      sidebarStyle: ALLOWED_STYLE.has(navigation.sidebarStyle) ? navigation.sidebarStyle : 'floating',
      sidebarMode: ALLOWED_MODE.has(navigation.sidebarMode) ? navigation.sidebarMode : 'expanded',
    },
    guidance: {
      coachMarks: guidance.coachMarks !== false,
    },
  }
}

export async function readUserExperience(userId) {
  const result = await pool.query(
    `SELECT preferences,first_login_completed_at,platform_guidance,platform_getting_started
       FROM user_experience_preferences
      WHERE user_id=$1
      LIMIT 1`,
    [userId],
  )
  return result.rows[0] || null
}

function markerTimestamp(container, platform, field) {
  const value = asObject(asObject(container)[platform])[field]
  return value || null
}

export function experiencePayload({ user, tenant = null, tenantOnboardingCompletedAt = null, row, platform = 'itsm' }) {
  const resolvedPlatform = normalisePlatform(platform)
  const scoped = tenantExperienceSnapshot(row, tenant?.id, tenantOnboardingCompletedAt)
  return {
    user, tenant,
    preferences: scoped.preferences ? normalisePreferences(scoped.preferences) : null,
    firstLoginCompletedAt: scoped.firstLoginCompletedAt,
    tenantOnboardingCompletedAt: tenantOnboardingCompletedAt || null,
    platform: resolvedPlatform,
    platformGuidance: scoped.platformGuidance,
    platformCoachmarksCompletedAt: markerTimestamp(scoped.platformGuidance, resolvedPlatform, 'completedAt'),
    platformGettingStartedDismissedAt: markerTimestamp(scoped.platformGettingStarted, resolvedPlatform, 'dismissedAt'),
  }
}

// The original row is keyed to the central identity. Store new per-tenant
// preferences within JSONB maps, and never overwrite another tenant's
// appearance or first-login history. Row locking protects parallel sessions.
export async function patchUserExperience(userId, body = {}, { tenantId, tenantOnboardingCompletedAt = null } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(String(tenantId || ''))) {
    const error = new Error('A verified tenant membership is required.')
    error.status = 403
    throw error
  }
  const platform = normalisePlatform(body?.platform)
  const now = new Date().toISOString()
  return withTransaction(async db => {
    await db.query(
      `INSERT INTO user_experience_preferences
       (user_id,preferences,first_login_completed_at,platform_guidance,platform_getting_started)
       VALUES ($1,'{}'::jsonb,NULL,'{}'::jsonb,'{}'::jsonb)
       ON CONFLICT (user_id) DO NOTHING`, [userId],
    )
    const existing = await db.query(
      `SELECT preferences,first_login_completed_at,platform_guidance,platform_getting_started
         FROM user_experience_preferences WHERE user_id=$1 FOR UPDATE`, [userId],
    )
    const row = existing.rows[0]
    const scoped = tenantExperienceSnapshot(row, tenantId, tenantOnboardingCompletedAt)
    const preferences = body?.preferences
      ? normalisePreferences(body.preferences)
      : normalisePreferences(scoped.preferences || {})
    const rootPrefs = asObject(row?.preferences)
    const rootGuidance = asObject(row?.platform_guidance)
    const rootGettingStarted = asObject(row?.platform_getting_started)
    const tenantGuidance = { ...asObject(scoped.platformGuidance) }
    const tenantGettingStarted = { ...asObject(scoped.platformGettingStarted) }
    if (body?.coachmarksComplete) {
      tenantGuidance[platform] = { ...asObject(tenantGuidance[platform]),
        completedAt: tenantGuidance[platform]?.completedAt || now }
    }
    if (body?.gettingStartedDismissed) {
      tenantGettingStarted[platform] = { ...asObject(tenantGettingStarted[platform]),
        dismissedAt: tenantGettingStarted[platform]?.dismissedAt || now }
    }
    const encodedPrefs = {
      ...rootPrefs,
      tenantOverrides: { ...asObject(rootPrefs.tenantOverrides), [tenantId]: preferences },
    }
    const encodedGuidance = {
      ...rootGuidance,
      tenantFirstLogin: {
        ...asObject(rootGuidance.tenantFirstLogin),
        ...(body?.firstLoginComplete ? { [tenantId]: scoped.firstLoginCompletedAt || now } : {}),
      },
      tenantPlatforms: { ...asObject(rootGuidance.tenantPlatforms), [tenantId]: tenantGuidance },
    }
    const encodedStarted = {
      ...rootGettingStarted,
      tenantPlatforms: { ...asObject(rootGettingStarted.tenantPlatforms), [tenantId]: tenantGettingStarted },
    }
    if (JSON.stringify(encodedPrefs).length > 20000) {
      const error = new Error('User preferences are too large.')
      error.status = 413
      throw error
    }
    const updated = await db.query(
      `UPDATE user_experience_preferences SET
         preferences=$2::jsonb,platform_guidance=$3::jsonb,
         platform_getting_started=$4::jsonb,updated_at=now()
       WHERE user_id=$1
       RETURNING preferences,first_login_completed_at,platform_guidance,platform_getting_started`,
      [userId,JSON.stringify(encodedPrefs),JSON.stringify(encodedGuidance),JSON.stringify(encodedStarted)],
    )
    return updated.rows[0]
  })
}

export function registerUserPreferenceRoutes(app) {
  app.get('/api/v1/user-preferences', async (c) => {
    const auth = await requireSession(c)
    if (auth.error) return auth.error
    const platform = normalisePlatform(c.req.query('surface'))
    const row = await readUserExperience(auth.session.user_id)
    return c.json(experiencePayload({
      user: {
        id: auth.session.user_id,
        name: auth.session.name,
        email: auth.session.email,
        tenantRole: auth.session.tenant_role,
      },
      tenant: {
        id: auth.session.tenant_id,
        slug: auth.session.slug,
        companyName: auth.session.company_name,
        modules: auth.session.modules || {},
        accent: auth.session.configuration?.theme?.accent || auth.session.onboarding_data?.theme?.accent || '#3b82f6',
      },
      tenantOnboardingCompletedAt: auth.session.onboarding_completed_at,
      row,
      platform,
    }))
  })

  app.patch('/api/v1/user-preferences', async (c) => {
    const auth = await requireSession(c)
    if (auth.error) return auth.error
    let body
    try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }

    try {
      const row = await patchUserExperience(auth.session.user_id, body, {
        tenantId: auth.session.tenant_id,
        tenantOnboardingCompletedAt: auth.session.onboarding_completed_at,
      })
      return c.json(experiencePayload({
        user: {
          id: auth.session.user_id,
          name: auth.session.name,
          email: auth.session.email,
          tenantRole: auth.session.tenant_role,
        },
        tenant: {
          id: auth.session.tenant_id,
          slug: auth.session.slug,
          companyName: auth.session.company_name,
          modules: auth.session.modules || {},
          accent: auth.session.configuration?.theme?.accent || auth.session.onboarding_data?.theme?.accent || '#3b82f6',
        },
        tenantOnboardingCompletedAt: auth.session.onboarding_completed_at,
        row,
        platform: normalisePlatform(body?.platform),
      }))
    } catch (error) {
      if (error?.status) return c.json({ error: error.message }, error.status)
      throw error
    }
  })
}
