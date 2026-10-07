import { originMatchesTenantAccount } from './deploymentConfig.js'
import { pool } from './db.js'
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
  const guidance = asObject(row?.platform_guidance)
  const gettingStarted = asObject(row?.platform_getting_started)
  return {
    user,
    tenant,
    preferences: row ? normalisePreferences(row.preferences || {}) : null,
    firstLoginCompletedAt: row?.first_login_completed_at || null,
    tenantOnboardingCompletedAt: tenantOnboardingCompletedAt || null,
    platform: resolvedPlatform,
    platformGuidance: guidance,
    platformCoachmarksCompletedAt: markerTimestamp(guidance, resolvedPlatform, 'completedAt'),
    platformGettingStartedDismissedAt: markerTimestamp(gettingStarted, resolvedPlatform, 'dismissedAt'),
  }
}

export async function patchUserExperience(userId, body = {}) {
  const platform = normalisePlatform(body?.platform)
  const current = await readUserExperience(userId)
  const preferences = body?.preferences
    ? normalisePreferences(body.preferences)
    : normalisePreferences(current?.preferences || {})
  const guidance = { ...asObject(current?.platform_guidance) }
  const gettingStarted = { ...asObject(current?.platform_getting_started) }
  const now = new Date().toISOString()

  if (body?.coachmarksComplete) {
    guidance[platform] = { ...asObject(guidance[platform]), completedAt: guidance[platform]?.completedAt || now }
  }
  if (body?.gettingStartedDismissed) {
    gettingStarted[platform] = { ...asObject(gettingStarted[platform]), dismissedAt: gettingStarted[platform]?.dismissedAt || now }
  }

  const encoded = JSON.stringify(preferences)
  if (encoded.length > 20_000) {
    const error = new Error('User preferences are too large.')
    error.status = 413
    throw error
  }

  await pool.query(
    `INSERT INTO user_experience_preferences (
       user_id,preferences,first_login_completed_at,platform_guidance,platform_getting_started,updated_at
     ) VALUES (
       $1,$2::jsonb,CASE WHEN $3::boolean THEN now() ELSE NULL END,$4::jsonb,$5::jsonb,now()
     )
     ON CONFLICT (user_id)
     DO UPDATE SET
       preferences=EXCLUDED.preferences,
       first_login_completed_at=CASE
         WHEN $3::boolean THEN COALESCE(user_experience_preferences.first_login_completed_at,now())
         ELSE user_experience_preferences.first_login_completed_at
       END,
       platform_guidance=EXCLUDED.platform_guidance,
       platform_getting_started=EXCLUDED.platform_getting_started,
       updated_at=now()`,
    [userId, encoded, Boolean(body?.firstLoginComplete), JSON.stringify(guidance), JSON.stringify(gettingStarted)],
  )

  return readUserExperience(userId)
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
      const row = await patchUserExperience(auth.session.user_id, body)
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
