import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const base = resolve('apps/itsm/src')
const source = readFileSync(resolve(base,'lib/tenantSurface.js'),'utf8')
const config = readFileSync(resolve(base,'lib/deploymentConfig.js'),'utf8')
const entry = readFileSync(resolve(base,'main.jsx'),'utf8')
const homepage = readFileSync(resolve(base,'features/marketing/MarketingApp.jsx'),'utf8')

assert.match(source,/marketing-preview\.\$\{rootHost\}/)
assert.match(source,/config\.runtimeEnvironment === 'marketing-preview'/)
assert.match(config,/\['dev', 'test', 'uat', 'live', 'marketing-preview'\]/)
assert.match(entry,/SignupPage/)
assert.match(homepage,/ProfessionalMarketingHome/)
assert.match(homepage,/path === '\/signup'/)

// Assert actual routing behaviour on a simulated window, without browsers
// or any network connections. Existing real tenant hosts MUST stay unchanged.
const { resolveTenantSurface } = await import('../apps/itsm/src/lib/tenantSurface.js')
function surface(hostname,environment='marketing-preview',pathname='/') {
  globalThis.window = {
    __HI5_CONFIG__: {
      deploymentMode:'managed', tenancyMode:'multi',
      runtimeEnvironment:environment, rootDomain:'hi5central.com',
    },
    location:{ hostname,pathname,search:'',origin:'https://'+hostname },
  }
  return resolveTenantSurface(globalThis.window.location)
}
assert.equal(surface('marketing-preview.hi5central.com').kind,'marketing')
assert.equal(surface('marketing-preview.hi5central.com').tenantSlug,'')
assert.equal(surface('marketing-preview.hi5central.com').preview,true)
assert.equal(surface('hi5central.com','live').kind,'marketing')
assert.equal(surface('company.hi5central.com').kind,'workspace')
assert.equal(surface('company-portal.hi5central.com').kind,'portal')
assert.equal(surface('company-rmm.hi5central.com').kind,'rmm')
assert.equal(surface('marketing-preview.hi5central.com','live').kind,'workspace')
console.log('PASS: PR83 preview marketing only, existing root/signup, tenant Portal and RMM routing unchanged.')
