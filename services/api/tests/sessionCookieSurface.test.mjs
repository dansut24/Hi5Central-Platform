import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

process.env.DEPLOYMENT_MODE = 'managed'
process.env.TENANCY_MODE = 'multi'
process.env.RUNTIME_ENVIRONMENT = 'uat'
process.env.ROOT_DOMAIN = 'hi5central.com'
process.env.COOKIE_DOMAIN = ''
// The cookie tests must never connect to a customer or Dev database.
process.env.DATABASE_URL ||= 'postgresql://none:none@127.0.0.1:1/unused'

const { deployment } = await import('../src/deploymentConfig.js')
const { environmentSessionCookieNames } = await import('../src/tenantEnvironmentHostnames.js')
const { setRequestSessionCookie } = await import('../src/session.js')
const cookieNames = environmentSessionCookieNames(deployment)

async function issuedCookie(origin) {
  const app = new Hono()
  app.post('/api/v1/auth/mfa/verify', (c) => {
    setRequestSessionCookie(c, 'synthetic-only-session-token', 3600)
    return c.json({ authenticated: true })
  })
  const response = await app.request('https://pilot-uat-api.hi5central.com/api/v1/auth/mfa/verify', {
    method: 'POST',
    headers: origin ? { Origin: origin } : {},
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie') || ''
}

test('requester Portal MFA receives its own secure host-only cookie', async () => {
  const cookie = await issuedCookie('https://synthacmeuat-portal.hi5central.com')
  assert.ok(cookie.startsWith(`${cookieNames.portal}=`), cookie)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /Secure/i)
  assert.doesNotMatch(cookie, /(?:^|;)\s*Domain=/i)
  assert.ok(!cookie.startsWith(`${cookieNames.workspace}=`))
})

test('staff MFA continues to receive the workspace cookie', async () => {
  const cookie = await issuedCookie('https://synthacmeuat.hi5central.com')
  assert.ok(cookie.startsWith(`${cookieNames.workspace}=`), cookie)
  assert.ok(!cookie.startsWith(`${cookieNames.portal}=`))
})

test('other environment Portal origins cannot select a UAT Portal cookie', async () => {
  const cookie = await issuedCookie('https://synthbravotest-portal.hi5central.com')
  assert.ok(cookie.startsWith(`${cookieNames.workspace}=`), cookie)
})
