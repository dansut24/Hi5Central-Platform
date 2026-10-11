import assert from 'node:assert/strict'
import {validTenantDeploymentProof,verifyTenantPublicBuild} from '../src/tenantDeploymentProof.js'
const sha='a'.repeat(40)
const now=new Date('2026-10-11T20:00:00.000Z')
const current={status:'verified',api_sha:sha,itsm_sha:sha,verified_at:'2026-10-11T19:50:00.000Z'}
assert.equal(validTenantDeploymentProof({row:current,buildSha:sha,now}),true)
assert.equal(validTenantDeploymentProof({row:{...current,api_sha:'b'.repeat(40)},buildSha:sha,now}),false)
assert.equal(validTenantDeploymentProof({row:{...current,itsm_sha:'b'.repeat(40)},buildSha:sha,now}),false)
assert.equal(validTenantDeploymentProof({row:{...current,status:'rolled_back'},buildSha:sha,now}),false)
assert.equal(validTenantDeploymentProof({row:{...current,verified_at:'2026-10-10T18:00:00.000Z'},buildSha:sha,now}),false)
assert.equal(validTenantDeploymentProof({row:null,buildSha:sha,now}),false)
let called=[]
const transport=async (url,options)=>{called.push({url,origin:options.headers.Origin,redirect:options.redirect});return {status:200,json:async()=>({sha})}}
const uat=await verifyTenantPublicBuild({slug:'testing',environment:'uat',sha,transport})
assert.equal(uat.apiSha,sha)
assert.deepEqual(called.map(x=>x.url),[
  'https://testing-uat.hi5central.com/api/v1/updates/version',
  'https://testing-uat.hi5central.com/release-manifest.json'])
called=[]
await verifyTenantPublicBuild({slug:'testing',environment:'live',sha,transport})
assert.deepEqual(called.map(x=>x.url),[
  'https://api.hi5central.com/api/v1/updates/version',
  'https://testing.hi5central.com/release-manifest.json'])
assert.ok(called.every(x=>x.origin==='https://testing.hi5central.com'&&x.redirect==='error'))
await assert.rejects(()=>verifyTenantPublicBuild({slug:'testing',environment:'live',sha,transport:async()=>({status:200,json:async()=>({sha:'b'.repeat(40)})})}),/not running the approved build/)
await assert.rejects(()=>verifyTenantPublicBuild({slug:'../../etc/passwd',environment:'live',sha,transport}),/Invalid deployment proof/)
console.log('PASS: tenant-scoped verified API/UI proofs, wrong revisions, stale proofs and fixed URLs')
