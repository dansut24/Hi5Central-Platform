import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,generateKeyPairSync,sign} from 'node:crypto'
import {canonicalRouteIntent} from '../src/runtimeHostRouteTransaction.js'
import {validateQaSandboxHostIntent,inspectQaSandboxGatewayRoutes,runQaSandboxHostTransaction} from '../src/qaSandboxHostRelease.js'

const now=new Date('2026-10-12T22:30:00Z')
const {privateKey,publicKey}=generateKeyPairSync('ed25519')
const publicKeyPem=publicKey.export({type:'spki',format:'pem'})
const source=[
  '# Preserve existing unrelated customer service',
  'http://other-tenant-test.hi5central.com { reverse_proxy hi5pool-test-other-web:80 }',
  '# HI5_RUNTIME_ROUTE_BEGIN test:h5c-managed-qa26',
  '@managedApi {',
  '  host h5c-managed-qa26-test.hi5central.com',
  '  path /api/v1/*',
  '}',
  'handle @managedApi { reverse_proxy hi5pool-test-previous-api:3001 }',
  '@managedHost host h5c-managed-qa26-test.hi5central.com',
  'handle @managedHost { reverse_proxy hi5pool-test-previous-web:80 }',
  '# HI5_RUNTIME_ROUTE_END test:h5c-managed-qa26',
  'handle { reverse_proxy hi5pool-test-default-web:80 }',
  '',
].join('\n')
const sha='a'.repeat(40),oldsha='b'.repeat(40)
const signIntent=intent=>sign(null,Buffer.from(canonicalRouteIntent(intent)),privateKey).toString('base64')
const basic={
  environment:'test',tenantSlug:'h5c-managed-qa26',
  publicHost:'h5c-managed-qa26-test.hi5central.com',
  buildSha:sha,previousBuildSha:oldsha,
  previousUpstream:'hi5pool-test-previous-web:80',
  nextUpstream:'hi5pool-test-qa-new-managed-web:80',
  previousApiTarget:'hi5pool-test-previous-api:3001',
  nextApiTarget:'hi5pool-test-qa-new-managed-api:3001',
  expectedCaddySha256:createHash('sha256').update(source).digest('hex'),
  routeGeneration:1,
  issuedAt:'2026-10-12T22:29:00Z',expiresAt:'2026-10-12T22:40:00Z',
  gateway:'hi5central-test-gateway',releaseScope:'qa_sandbox_only',
  approvalEnvironment:'QA Sandbox Release Approval',
  approvedRunId:'38308247394',
  apiImageDigest:'c'.repeat(64),webImageDigest:'d'.repeat(64),
}
const auth={intent:basic,signature:signIntent(basic),publicKeyPem,now}

test('correctly signed QA-only intent names the exact test gateway and one tenant',()=>{
  assert.equal(validateQaSandboxHostIntent(auth).gateway,'hi5central-test-gateway')
  const candidate=inspectQaSandboxGatewayRoutes({config:source,intent:basic})
  assert.match(candidate,/reverse_proxy hi5pool-test-qa-new-managed-web:80/)
  assert.match(candidate,/reverse_proxy hi5pool-test-qa-new-managed-api:3001/)
  assert.match(candidate,/hi5pool-test-other-web:80/)
  assert.equal(candidate.replace('hi5pool-test-qa-new-managed-web','hi5pool-test-previous-web')
   .replace('hi5pool-test-qa-new-managed-api','hi5pool-test-previous-api'),source)
})

test('signed general production intent cannot authorise QA and cross-tenant targets fail',()=>{
  const incompatible=[
    {...basic,environment:'live',publicHost:'h5c-managed-qa26.hi5central.com',gateway:'hi5central-web'},
    {...basic,environment:'uat',publicHost:'h5c-managed-qa26-uat.hi5central.com',gateway:'hi5central-uat-gateway'},
    {...basic,tenantSlug:'testing',publicHost:'testing-test.hi5central.com'},
    {...basic,nextApiTarget:'hi5pool-uat-qa-new-api:3001'},
    {...basic,releaseScope:'production'},
    {...basic,approvalEnvironment:'unreviewed'},
    {...basic,gateway:'hi5central-web'},
    {...basic,apiImageDigest:null},
  ]
  for(const wrong of incompatible){
    assert.throws(()=>validateQaSandboxHostIntent({...auth,intent:wrong,
      signature:signIntent(wrong)}),/QA|sandbox|gateway|targets|signed/)
  }
  assert.throws(()=>validateQaSandboxHostIntent({...auth,intent:{...basic,buildSha:'e'.repeat(40)}}),/signature is invalid/)
  assert.throws(()=>validateQaSandboxHostIntent({...auth,now:new Date('2026-10-12T23:00:00Z')}),/expired/)
})

test('missing or duplicated tenant marker is not a safe implicit wildcard edit',()=>{
  assert.throws(()=>inspectQaSandboxGatewayRoutes({config:'handle { reverse_proxy hi5pool-test-default-web:80 }',
    intent:basic}),/operator-provisioned/)
  assert.throws(()=>inspectQaSandboxGatewayRoutes({config:source+source,
    intent:basic}),/operator-provisioned/)
  assert.throws(()=>inspectQaSandboxGatewayRoutes({config:source.replace(
    'path /api/v1/*','path /api/v2/*'),intent:basic}),/API and ITSM routes/)
})

test('default signed host operation dry-runs without activating; public failure rolls back',async()=>{
  const calls=[]
  const adapter=(fail=false)=>({
    gateway:'hi5central-test-gateway',
    readActiveConfig:async()=>{calls.push('read');return source},
    validateCandidate:async()=>{calls.push('validate')},
    verifyTargetBuild:async()=>{calls.push('images')},
    preserveRollback:async()=>{calls.push('backup')},
    activateCandidate:async()=>{calls.push('activate')},
    verifyPublicRoute:async()=>{calls.push('public');if(fail)throw Error('Unexpected frontend SHA')},
    recordActivation:async()=>{calls.push('record')},
    restoreRollback:async()=>{calls.push('rollback')},
    verifyRestoredRoute:async()=>{calls.push('verifiedPrevious')},
  })
  const dry=await runQaSandboxHostTransaction({...auth,adapter:adapter()})
  assert.equal(dry.state,'dry_run')
  assert.deepEqual(calls,['read','validate'])
  calls.length=0
  await assert.rejects(()=>runQaSandboxHostTransaction({...auth,adapter:adapter(true),
      applyEnabled:true}),/rolled back/)
  assert.deepEqual(calls,['read','validate','images','backup','activate','public','rollback','verifiedPrevious'])
  calls.length=0
  await assert.rejects(()=>runQaSandboxHostTransaction({...auth,adapter:{...adapter(),
    gateway:'hi5central-web'},applyEnabled:true}),/gateway does not match/)
  assert.deepEqual(calls,[])
})
