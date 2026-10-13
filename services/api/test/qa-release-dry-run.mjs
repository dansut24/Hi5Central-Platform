import assert from 'node:assert/strict'
import {test} from 'node:test'
import {QA_RELEASE_TARGETS,releaseTargetHost,makeQaReleasePlan,assessPublicRelease} from '../src/qaReleasePlan.js'

const sha='a'.repeat(40)
const candidate=()=>makeQaReleasePlan({buildSha:sha,versionLabel:'2026.10.12-rc1',
  now:new Date('2026-10-12T21:00:00Z')})

test('QA proposal has exactly Managed Test, Custom Test and Custom UAT; no Production hosts',()=>{
  const plan=candidate()
  assert.deepEqual(plan.targets.map(t=>t.host),[
    'h5c-managed-qa26-test.hi5central.com',
    'h5c-custom-qa26-test.hi5central.com',
    'h5c-custom-qa26-uat.hi5central.com',
  ])
  assert.equal(plan.activationAllowed,false)
  assert.equal(plan.productionHostsIncluded,false)
  assert.equal(plan.kind,'unsigned_qa_release_proposal')
  assert(!plan.targets.some(t=>t.environment==='live'))
  assert(!plan.targets.some(t=>t.tenantSlug==='h5c-managed-qa26'&&t.environment==='uat'))
})

test('rejects non-QA hosts, Managed UAT, Production and arbitrary tenant policies',()=>{
  for(const other of [
    {tenantSlug:'testing',environment:'test',updateMode:'hi5_managed'},
    {tenantSlug:'h5c-managed-qa26',environment:'uat',updateMode:'hi5_managed'},
    {tenantSlug:'h5c-managed-qa26',environment:'live',updateMode:'hi5_managed'},
    {tenantSlug:'h5c-custom-qa26',environment:'live',updateMode:'admin_controlled'},
    {tenantSlug:'h5c-custom-qa26',environment:'test',updateMode:'hi5_managed'},
  ])assert.throws(()=>releaseTargetHost(other),/approved QA/)
  assert.equal(QA_RELEASE_TARGETS.length,3)
})

test('malformed SHA, unsafe label or invalid timestamp cannot create a plan',()=>{
  assert.throws(()=>makeQaReleasePlan({buildSha:'a'.repeat(8),versionLabel:'2026.10.12-rc1'}),/immutable/)
  assert.throws(()=>makeQaReleasePlan({buildSha:sha,versionLabel:'./oops'}),/version/)
  assert.throws(()=>makeQaReleasePlan({buildSha:sha,versionLabel:'2026.10.12-rc1',now:'bad-date'}),/date/)
})

test('even matching public frontend SHA never implies host/API or UAT approval',()=>{
  const plan=candidate()
  const state=assessPublicRelease(plan,plan.targets.map(t=>({host:t.host,httpStatus:200,frontendSha:sha})))
  assert(state.every(x=>x.publicFrontendMatches))
  assert(state.every(x=>!x.apiVerified&&!x.hostRouteVerified&&!x.uatApproved))
  const unknown=plan.targets.map(t=>({host:t.host,httpStatus:200,frontendSha:null}))
  assert(assessPublicRelease(plan,unknown).every(x=>x.state==='not_yet_staged'))
  assert.throws(()=>assessPublicRelease(plan,[...unknown,{host:'testing.hi5central.com',httpStatus:200,frontendSha:sha}]),/exactly/)
  assert.throws(()=>assessPublicRelease({...plan,activationAllowed:true},unknown),/read-only/)
})

test('public API requires valid JSON SHA matching frontend, without granting host approval',()=>{
  const plan=candidate()
  const healthy=plan.targets.map(t=>({
    host:t.host,httpStatus:200,frontendSha:sha,apiHttpStatus:200,apiSha:sha,
  }))
  const result=assessPublicRelease(plan,healthy)
  assert(result.every(x=>x.state==='public_manifests_match'))
  assert(result.every(x=>x.publicFrontendMatches&&x.publicApiMatches))
  assert(result.every(x=>!x.apiVerified&&!x.hostRouteVerified&&!x.uatApproved))

  const uatHtml=healthy.map((row,i)=>i===2
    ? {...row,apiHttpStatus:200,apiSha:null} : row)
  const withHtml=assessPublicRelease(plan,uatHtml)
  assert.equal(withHtml[2].state,'api_unavailable_or_mismatch')
  assert.equal(withHtml[2].publicApiMatches,false)
  assert.equal(withHtml[2].apiVerified,false)

  const error502=healthy.map((row,i)=>i===2
    ? {...row,apiHttpStatus:502,apiSha:null} : row)
  assert.equal(assessPublicRelease(plan,error502)[2].state,'api_unavailable_or_mismatch')
})
