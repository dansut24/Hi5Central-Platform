import assert from 'node:assert/strict'
import test from 'node:test'
process.env.DEPLOYMENT_MODE='managed'
process.env.TENANCY_MODE='multi'
process.env.RUNTIME_ENVIRONMENT='uat'
process.env.ROOT_DOMAIN='hi5central.com'
process.env.API_URL='https://pilot-uat-api.hi5central.com'
process.env.ADMIN_URL='https://admin.hi5central.com'
process.env.COOKIE_DOMAIN=''
const { deployment }=await import('../src/deploymentConfig.js')

test('managed sandbox API does not expose Production Admin or broad cookies',()=>{
  assert.equal(deployment.tenancyMode,'multi')
  assert.equal(deployment.runtimeEnvironment,'uat')
  assert.equal(deployment.adminUrl,'')
  assert.equal(deployment.cookieDomain,'')
  assert.equal(deployment.apiUrl,'https://pilot-uat-api.hi5central.com')
})
