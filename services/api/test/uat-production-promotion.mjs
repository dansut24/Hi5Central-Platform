import assert from 'node:assert/strict'
import test from 'node:test'
import {assessUatProductionPromotion,canonicalUatReviewSlug} from '../src/uatProductionPromotion.js'
import {applicationReleaseExecutorState,APPLICATION_RELEASE_EXECUTOR_ID,APPLICATION_RELEASE_EXECUTOR_CAPABILITY} from '../src/applicationReleaseExecutor.js'

const sha='a'.repeat(40)
const other='b'.repeat(40)
const request={
  status:'pending',build_sha:sha,
  evidence:'I confirmed login, MFA, incident updates and mobile layouts in Custom UAT.',
  approved_change_shas:[other],
}
const uat={verified:true,apiSha:sha,itsmSha:sha}
const live={verified:true,apiSha:other,itsmSha:other}
const gate=(overrides={})=>assessUatProductionPromotion({
  review:request,uat,live,published:true,...overrides,
})

test('A host-verified published UAT review is ready for platform operator queue',()=>{
  assert.equal(gate().allowed,true)
  assert.equal(gate().code,'READY_TO_QUEUE')
})
test('Reject missing, withdrawn, duplicate or malformed customer UAT approvals',()=>{
  assert.equal(gate({review:null}).code,'REVIEW_NOT_PENDING')
  assert.equal(gate({review:{...request,status:'approved'}}).allowed,false)
  assert.equal(gate({review:{...request,status:'rejected'}}).allowed,false)
  assert.equal(gate({review:{...request,build_sha:'latest'}}).code,'INVALID_REVISION')
  assert.equal(gate({review:{...request,evidence:'tested'}}).code,'MISSING_TEST_EVIDENCE')
  assert.equal(gate({review:{...request,approved_change_shas:[other,other]}}).code,'INVALID_CHANGE_SELECTION')
  assert.equal(gate({review:{...request,approved_change_shas:['wrong']}}).code,'INVALID_CHANGE_SELECTION')
})
test('A reviewed 188-change release is accepted as a complete bounded selection, never trimmed to 70',()=>{
  const approved=Array.from({length:188},(_,i)=>i.toString(16).padStart(40,'0'))
  assert.equal(gate({review:{...request,approved_change_shas:approved}}).allowed,true)
  assert.equal(gate({review:{...request,approved_change_shas:[]}}).code,'INVALID_CHANGE_SELECTION')
  const oversized=Array.from({length:513},(_,i)=>i.toString(16).padStart(40,'0'))
  assert.equal(gate({review:{...request,approved_change_shas:oversized}}).code,'INVALID_CHANGE_SELECTION')
})
test('Never promote unpublished or stale/unverified/replaced API or ITSM builds',()=>{
  assert.equal(gate({published:false}).code,'NOT_PUBLISHED')
  assert.equal(gate({uat:{...uat,verified:false}}).code,'UAT_MISMATCH')
  assert.equal(gate({uat:{...uat,apiSha:other}}).code,'UAT_MISMATCH')
  assert.equal(gate({uat:{...uat,itsmSha:other}}).code,'UAT_MISMATCH')
  assert.equal(gate({live:{...live,apiSha:sha,itsmSha:sha}}).code,'ALREADY_INSTALLED')
})
test('No browser-supplied target or revision is required; reviewed immutable build is authoritative',()=>{
  assert.equal(gate().allowed,true)
  assert.equal(gate({review:{...request,build_sha:other}}).code,'UAT_MISMATCH')
})

test('Trusted UAT review canonicalises only exact matching Live tenant slug with same UUID',()=>{
  assert.deepEqual(canonicalUatReviewSlug({
    liveSlug:'h5c-custom-qa26',uatSlug:'h5c-custom-qa26-uat',
  }),{ok:true,slug:'h5c-custom-qa26'})
  for(const slug of ['h5c-managed-qa26-uat','h5c-custom-qa26-test',
    'h5c-custom-qa26','other-tenant-uat','h5c-custom-qa26-uat.evil.com']) {
    assert.equal(canonicalUatReviewSlug({
      liveSlug:'h5c-custom-qa26',uatSlug:slug,
    }).ok,false,slug)
  }
  assert.equal(canonicalUatReviewSlug({liveSlug:'',uatSlug:'h5c-custom-qa26-uat'}).ok,false)
})

test('Never claim a one-click promotion when only the legacy environment action operator is running',()=>{
  const now=new Date('2026-10-14T23:00:00Z')
  assert.equal(applicationReleaseExecutorState(null,now).ready,false)
  assert.equal(applicationReleaseExecutorState({
    worker_id:'legacy-environment-actions',
    capability:APPLICATION_RELEASE_EXECUTOR_CAPABILITY,
    observed_at:now,
  },now).ready,false)
  assert.equal(applicationReleaseExecutorState({
    worker_id:APPLICATION_RELEASE_EXECUTOR_ID,capability:'legacy-actions',
    observed_at:now,
  },now).ready,false)
  assert.equal(applicationReleaseExecutorState({
    worker_id:APPLICATION_RELEASE_EXECUTOR_ID,
    capability:APPLICATION_RELEASE_EXECUTOR_CAPABILITY,
    observed_at:new Date(now.getTime()-120001),
  },now).ready,false)
  assert.equal(applicationReleaseExecutorState({
    worker_id:APPLICATION_RELEASE_EXECUTOR_ID,
    capability:APPLICATION_RELEASE_EXECUTOR_CAPABILITY,
    observed_at:new Date(now.getTime()-30000),
  },now).ready,true)
})
