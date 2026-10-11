import assert from 'node:assert/strict'
import {generateKeyPairSync,sign,createHash} from 'node:crypto'
import {canonicalRouteIntent,verifyHostRouteIntent,renderVerifiedTenantRoute,
 runHostRouteTransaction} from '../src/runtimeHostRouteTransaction.js'

const {publicKey,privateKey}=generateKeyPairSync('ed25519')
const publicKeyPem=publicKey.export({type:'spki',format:'pem'})
const sha='a'.repeat(40)
const now=new Date('2026-10-11T22:00:00.000Z')
const source=`*.hi5central.com {
  # Unrelated customer remains untouched
  @anotherCustomer host other-company.hi5central.com
  handle @anotherCustomer {
    reverse_proxy hi5pool-other-web:80
  }
  # HI5_RUNTIME_ROUTE_BEGIN live:testing
  @testingApi {
    host testing.hi5central.com
    path /api/v1/*
  }
  handle @testingApi {
    reverse_proxy hi5pool-legacy-api:3001
  }
  @testingHost host testing.hi5central.com
  handle @testingHost {
    reverse_proxy hi5pool-legacy-web:80
  }
  # HI5_RUNTIME_ROUTE_END live:testing
  handle { reverse_proxy hi5central-itsm:80 }
}
`
const intent={
 environment:'live',tenantSlug:'testing',publicHost:'testing.hi5central.com',
 buildSha:sha,previousBuildSha:'b'.repeat(40),previousUpstream:'hi5pool-legacy-web:80',nextUpstream:'hi5pool-release-web:80',
 previousApiTarget:'hi5pool-legacy-api:3001',nextApiTarget:'hi5pool-release-api:3001',
 expectedCaddySha256:createHash('sha256').update(source).digest('hex'),routeGeneration:4,
 issuedAt:'2026-10-11T21:59:00Z',expiresAt:'2026-10-11T22:09:00Z',
}
const signature=sign(null,Buffer.from(canonicalRouteIntent(intent)),privateKey).toString('base64')
const auth={intent,signature,publicKeyPem,now}
assert.equal(verifyHostRouteIntent(auth),intent)
assert.throws(()=>verifyHostRouteIntent({...auth,intent:{...intent,buildSha:'b'.repeat(40)}}),
 /invalid/)
assert.throws(()=>verifyHostRouteIntent({...auth,now:new Date('2026-10-11T23:00:00Z')}),/expired/)
assert.throws(()=>verifyHostRouteIntent({...auth,intent:{...intent,tenantSlug:'another'}}),/approved tenant/)
const candidate=renderVerifiedTenantRoute(source,intent)
assert.ok(candidate.includes('reverse_proxy hi5pool-release-web:80'))
assert.ok(candidate.includes('reverse_proxy hi5pool-release-api:3001'))
assert.ok(candidate.includes('reverse_proxy hi5pool-other-web:80'))
assert.ok(!candidate.includes('reverse_proxy hi5pool-legacy-web:80'))
assert.equal(candidate.replace('hi5pool-release-web:80','hi5pool-legacy-web:80')
 .replace('hi5pool-release-api:3001','hi5pool-legacy-api:3001'),source)
assert.throws(()=>renderVerifiedTenantRoute(source.replace(
 '# HI5_RUNTIME_ROUTE_BEGIN live:testing','# NO_AUTO_ROUTE live:testing'),intent),/operator-provisioned/)
assert.throws(()=>renderVerifiedTenantRoute(source.replace(
 'host testing.hi5central.com','host other-company.hi5central.com'),intent),/hostname/)
const calls=[]
const adapter=(options={})=>({
 readActiveConfig:async()=>{calls.push('read');return source},
 validateCandidate:async c=>{calls.push('validate');assert.equal(c,candidate)},
 verifyTargetBuild:async i=>{calls.push('preflight');assert.equal(i.buildSha,sha)},
 preserveRollback:async()=>{calls.push('backup')},
 activateCandidate:async()=>{calls.push('activate');if(options.fail==='activate')throw Error('Caddy refused new config')},
 verifyPublicRoute:async()=>{calls.push('public');if(options.fail==='public')throw Error('Unexpected public build')},
 recordActivation:async()=>{calls.push('receipt');if(options.fail==='receipt')throw Error('Could not append receipt')},
 restoreRollback:async old=>{calls.push('restore');assert.equal(old,source);if(options.fail==='rollback')throw Error('Caddy rollback error')},
 verifyRestoredRoute:async()=>{calls.push('restored')},
})
const preview=await runHostRouteTransaction({...auth,adapter:adapter()})
assert.equal(preview.state,'dry_run')
assert.equal(preview.routingChanged,false)
assert.deepEqual(calls,['read','validate'],'Dry-run must never preflight, switch routes, or write receipts')
calls.length=0
const live=await runHostRouteTransaction({...auth,adapter:adapter(),applyEnabled:true})
assert.equal(live.state,'verified_active')
assert.equal(live.routingChanged,true)
assert.deepEqual(calls,['read','validate','preflight','backup','activate','public','receipt'])
for(const failure of ['activate','public','receipt']){
 calls.length=0
 await assert.rejects(()=>runHostRouteTransaction({...auth,adapter:adapter({fail:failure}),applyEnabled:true}),/rolled back/)
 assert.deepEqual(calls.slice(-2),['restore','restored'])
}
calls.length=0
const wrongConfig={...adapter(),readActiveConfig:async()=>source+'# stale'}
await assert.rejects(()=>runHostRouteTransaction({...auth,adapter:wrongConfig,applyEnabled:true}),/changed since approval/)
assert.deepEqual(calls,[],'Changed running config must never start deployment')
console.log('PASS: signed tenant intent, immutable config digest, default dry-run, isolated Caddy patch, automatic post-cutover rollback')
