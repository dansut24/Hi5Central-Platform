import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DEPLOYMENT_MODE='managed'
process.env.TENANCY_MODE='multi'
process.env.RUNTIME_ENVIRONMENT='uat'
process.env.ROOT_DOMAIN='hi5central.com'
process.env.COOKIE_DOMAIN=''

const { secureLoginSurface }=await import('../src/secureLoginSurface.js')

test('an environment customer Portal origin receives Portal MFA session',()=>{
  assert.equal(secureLoginSurface('https://synthacmeuat-portal.hi5central.com'),'portal')
  assert.equal(secureLoginSurface('https://syntheticuat-portal.hi5central.com'),'portal')
})
test('staff workspace origins must stay workspace sessions',()=>{
  assert.equal(secureLoginSurface('https://synthacmeuat.hi5central.com'),'workspace')
  assert.equal(secureLoginSurface('https://dev.hi5central.com'),'workspace')
  assert.equal(secureLoginSurface(''),'workspace')
})
test('a customer Test Portal is not classified as a UAT Portal',()=>{
  assert.equal(secureLoginSurface('https://synthbravotest-portal.hi5central.com'),'workspace')
})
