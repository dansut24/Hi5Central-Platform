import assert from 'node:assert/strict'
import {Hono} from 'hono'
process.env.MFA_RECOVERY_PILOT_TENANT_SLUG='testing'
const {registerMfaRecoveryRoutes}=await import('../src/mfaRecovery.js')
const {mfaRecoveryStartHtml,mfaRecoveryConfirmHtml}=await import('../src/mfaRecoveryPages.js')
const app=new Hono()
registerMfaRecoveryRoutes(app)
for(const path of ['/api/v1/auth/mfa-recovery/start','/api/v1/auth/mfa-recovery/confirm']){
 const r=await app.request('https://api.hi5central.com'+path)
 assert.equal(r.status,200)
 assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/)
 assert.equal(r.headers.get('referrer-policy'),'no-referrer')
 assert.match(r.headers.get('cache-control'),/no-store/)
 const html=await r.text()
 assert.match(html,/Current password/)
 assert.doesNotMatch(html,/<script\s+src=/i)
 assert.doesNotMatch(html,/<img\s+src=/i)
}
assert.match(mfaRecoveryStartHtml,/verified login email/)
assert.match(mfaRecoveryConfirmHtml,/location\.hash/)
assert.match(mfaRecoveryConfirmHtml,/history\.replaceState/)
assert.match(mfaRecoveryConfirmHtml,/Return to Test sign-in/)
const wrongOrigin=await app.request('https://api.hi5central.com/api/v1/auth/mfa-recovery/request',{
 method:'POST',headers:{origin:'https://attacker.example',host:'api.hi5central.com','content-type':'application/json'},
 body:'{}'
})
assert.equal(wrongOrigin.status,404)
const missing=await app.request('https://api.hi5central.com/api/v1/auth/mfa-recovery/complete',{
 method:'POST',headers:{origin:'https://api.hi5central.com',host:'api.hi5central.com','content-type':'application/json'},
 body:JSON.stringify({token:'not-a-valid-token',password:'test'})
})
assert.equal(missing.status,400)
const generic=await app.request('https://api.hi5central.com/api/v1/auth/mfa-recovery/request',{
 method:'POST',headers:{origin:'https://api.hi5central.com',host:'api.hi5central.com','content-type':'application/json'},
 body:'invalid-json'
})
assert.equal(generic.status,202)
console.log('PASS: constrained MFA owner recovery pages, no-token-in-query, origin checks and fail-closed requests')
