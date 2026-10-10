import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'

process.env.MFA_ENCRYPTION_KEY='d'.repeat(64)
process.env.PLATFORM_ADMIN_MFA_REQUIRED='true'
const {
 platformAdminMfaRequired,encryptAdminTotp,decryptAdminTotp,
 makeAdminTotpSecret,adminTotpCode,verifyAdminTotp,makeAdminRecoveryCodes,
 createAdminMfaChallenge,adminMfaChallengeHash,
}=await import('../src/platformAdminMfa.js')

test('pilot Admin MFA flag is explicit and TOTP secrets remain encrypted',()=>{
 assert.equal(platformAdminMfaRequired,true)
 const secret=makeAdminTotpSecret()
 assert.match(secret,/^[A-Z2-7]{32}$/)
 const encrypted=encryptAdminTotp(secret)
 assert.notEqual(encrypted,secret)
 assert.equal(decryptAdminTotp(encrypted),secret)
 assert.throws(()=>decryptAdminTotp(encrypted.slice(0,-3)+'bad'))
})

test('MFA codes reject wrong values, expiry and same-step replays',()=>{
 const secret=makeAdminTotpSecret(), now=Date.now()
 const step=Math.floor(now/30000)
 const code=adminTotpCode(secret,step)
 assert.equal(verifyAdminTotp(secret,code,null,now),step)
 assert.equal(verifyAdminTotp(secret,code,step,now),null)
 assert.equal(verifyAdminTotp(secret,'not-totp',null,now),null)
 assert.equal(verifyAdminTotp(secret,code,null,now+5*60_000),null)
})

test('ten one-time recovery codes are unique, independently generated and not six-digit TOTP',()=>{
 const codes=makeAdminRecoveryCodes()
 assert.equal(codes.length,10)
 assert.equal(new Set(codes).size,10)
 for(const code of codes){
  assert.match(code,/^(?:[A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/)
  assert.equal(code.length,19)
 }
})

test('password stage creates a random hashed challenge, expiring after ten minutes',async()=>{
 const queries=[]
 const db={query:async(sql,params)=>{queries.push({sql,params});return {rowCount:1}}}
 const first=await createAdminMfaChallenge(db,'33333333-3333-4333-8333-333333333333')
 const second=await createAdminMfaChallenge(db,'33333333-3333-4333-8333-333333333333')
 assert.equal(first.mfaRequired,true)
 assert.equal(first.expiresInSeconds,600)
 assert.notEqual(first.challengeToken,second.challengeToken)
 assert.equal(queries.length,4)
 assert.ok(queries[0].sql.includes('used_at=now()'))
 assert.equal(queries[1].params[1],createHash('sha256').update(first.challengeToken).digest('hex'))
 assert.equal(queries[3].params[1],adminMfaChallengeHash(second.challengeToken))
 assert.ok(!queries[3].sql.includes(second.challengeToken))
})

test('Admin MFA is wired into privileged sessions and no password-only pilot bypass remains',async()=>{
 const {readFileSync}=await import('node:fs')
 const src=readFileSync(new URL('../src/platformAdmin.js',import.meta.url),'utf8')
 assert.match(src,/platformAdminMfaRequired && !row\.mfa_verified_at/)
 assert.match(src,/if\(platformAdminMfaRequired\) return null \/\/ Platform MFA/)
 assert.match(src,/INSERT INTO platform_admin_sessions\(user_id,token_hash,expires_at,mfa_verified_at\)/)
 assert.match(src,/app\.post\('\/api\/platform\/v1\/auth\/mfa\/verify'/)
})
