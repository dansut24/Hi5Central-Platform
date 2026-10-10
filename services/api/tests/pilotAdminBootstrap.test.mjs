import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto'
import {
  pilotBootstrapEnabled,validatePilotAdminIdentity,verifyPilotBootstrapPair,
  bootstrapToken,bootstrapHash,
} from '../src/pilotAdminBootstrap.js'
const scopeId='11111111-1111-4111-8111-111111111111'
const email='pilot.owner@example.invalid',displayName='Pilot Owner'
const env={
  PILOT_ADMIN_BOOTSTRAP_ENABLED:'true',PLATFORM_ADMIN_MFA_REQUIRED:'true',
  DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
  RUNTIME_ENVIRONMENT:'live',FEATURE_MODE:'controlled',
  ADMIN_URL:'https://pilot-admin.hi5central.com',
  API_URL:'https://pilot-control-api.hi5central.com',COOKIE_DOMAIN:'',
}
function fixture(){
  const people=[
    {id:'operator-one',roles:['operator']},
    {id:'reviewer-one',roles:['reviewer']},
    {id:'executor-three',roles:['executor']},
  ].map(x=>{
    const pair=generateKeyPairSync('ed25519')
    return {...x,keyId:x.id+'-key',privateKey:pair.privateKey,
      publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})}
  })
  const trust={version:1,principals:people.map(({id,roles,keyId,publicKeyPem})=>
    ({id,roles,keyId,publicKeyPem}))}
  const signed=(person,role='operator',options={})=>{
    const now=Date.now()
    const payload={version:1,audience:'hi5central-pilot-initial-platform-admin',
      action:'issue',role,operatorId:person.id,email,displayName,scopeId,
      issuedAt:new Date(now-1000).toISOString(),
      expiresAt:new Date(now+120000).toISOString(),
      nonce:randomBytes(24).toString('hex'),...options}
    const bytes=Buffer.from(JSON.stringify(payload))
    return JSON.stringify({keyId:person.keyId,payload:bytes.toString('base64url'),
      signature:sign(null,bytes,person.privateKey).toString('base64url')})
  }
  return {people,trust,signed}
}
test('pilot enablement never trusts Prod/Dev/legacy or global cookies',()=>{
  assert.equal(pilotBootstrapEnabled(env),true)
  for(const change of [
    {PILOT_ADMIN_BOOTSTRAP_ENABLED:'false'},{PLATFORM_ADMIN_MFA_REQUIRED:'false'},
    {DEPLOYMENT_MODE:'self_hosted'},{TENANCY_MODE:'single'},
    {RUNTIME_ENVIRONMENT:'dev'},{FEATURE_MODE:'all_enabled'},
    {ADMIN_URL:'https://admin.hi5central.com'},
    {API_URL:'https://api.hi5central.com'},{COOKIE_DOMAIN:'.hi5central.com'},
  ])assert.equal(pilotBootstrapEnabled({...env,...change}),false)
})
test('validates first-admin email and name; hashes random, non-reusable links',()=>{
  assert.equal(validatePilotAdminIdentity({email,displayName}),true)
  for(const bad of ['invalid','OWNER@example.invalid',' pilot.owner@example.invalid'])
    assert.equal(validatePilotAdminIdentity({email:bad,displayName}),false)
  const a=bootstrapToken(),b=bootstrapToken()
  assert.notEqual(a,b)
  assert.match(a,/^[A-Za-z0-9_-]{43}$/)
  assert.equal(bootstrapHash(a).length,64)
  assert.notEqual(bootstrapHash(a),bootstrapHash(b))
})
test('signed actor and distinct reviewer must match exact invite and database scope',()=>{
  const {people,trust,signed}=fixture()
  const actor=signed(people[0]),reviewer=signed(people[1],'reviewer')
  const result=verifyPilotBootstrapPair(actor,reviewer,trust,{scopeId,email,displayName})
  assert.equal(result.actor.operatorId,'operator-one')
  assert.equal(result.reviewer.operatorId,'reviewer-one')
  assert.notEqual(result.actor.keyId,result.reviewer.keyId)
  assert.match(result.actor.sha256,/^[a-f0-9]{64}$/)
  for(const expected of [
    {scopeId:'22222222-2222-4222-8222-222222222222',email,displayName},
    {scopeId,email:'attacker@example.invalid',displayName},
    {scopeId,email,displayName:'Wrong Person'},
  ])assert.throws(()=>verifyPilotBootstrapPair(actor,reviewer,trust,expected))
  assert.throws(()=>verifyPilotBootstrapPair(actor,'',trust,{scopeId,email,displayName}))
  assert.throws(()=>verifyPilotBootstrapPair(actor,actor,trust,{scopeId,email,displayName}))
  assert.throws(()=>verifyPilotBootstrapPair(actor,
    signed(people[0],'reviewer'),trust,{scopeId,email,displayName}))
  assert.throws(()=>verifyPilotBootstrapPair(actor,
    signed(people[1],'reviewer',{expiresAt:new Date(Date.now()-360000).toISOString()}),
    trust,{scopeId,email,displayName}))
  assert.throws(()=>verifyPilotBootstrapPair(actor,
    signed(people[1],'reviewer',{role:'operator'}),trust,{scopeId,email,displayName}))
  const modified=JSON.parse(reviewer)
  modified.payload=Buffer.from(JSON.stringify({email:'attacker@example.invalid'})).toString('base64url')
  assert.throws(()=>verifyPilotBootstrapPair(actor,JSON.stringify(modified),
    trust,{scopeId,email,displayName}))
})
test('invitation redemption cannot create a privileged password-only session',async()=>{
  const {readFileSync}=await import('node:fs')
  const src=readFileSync(new URL('../src/platformAdmin.js',import.meta.url),'utf8')
  assert.match(src,/auth\/bootstrap\/accept/)
  assert.match(src,/platform_admin_members\(user_id,role,status\)/)
  assert.match(src,/result=await withTransaction\(async db=>/)
  assert.match(src,/sessionCreated:false/)
  assert.match(src,/pilotBootstrapEnabled\(\)/)
  assert.match(src,/identity.instance_id!==scope.scope_id/)
  assert.match(src,/counts.users!==0\|\|counts.admins!==0\|\|counts.tenants!==0/)
})
