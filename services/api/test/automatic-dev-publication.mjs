import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyAutomaticDevPublication as verify} from '../src/automaticDevPublication.js'

const sha='c286e389865311851f91338aad94256f1131b994'
const ciRunUrl='https://github.com/dansut24/Hi5Central-Platform/actions/runs/39067576905'
const settings={RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev',
  RELEASE_PUBLICATION_AUTOMATIC:'true'}
function passing(overrides={}){
 const called=[]
 const inputs={
  sha,settings,listCandidates:async()=>{
   called.push('github-candidate-discovery')
   return [{buildSha:sha,ciRunUrl}]
  },
  verifyRun:async x=>{
   called.push('exact-official-ci-verification')
   assert.deepEqual({sha:x.sha,runUrl:x.runUrl},{sha,runUrl:ciRunUrl})
   return {buildSha:sha,evidence:{ci:true,security:true,migrations:true}}
  },
  verifyDev:async x=>{called.push('actual-dev-http-proof');assert.equal(x.sha,sha)
   return {smoke:true}},
  ...overrides,
 }
 return {inputs,called}
}
test('verifies successful official CI and Dev proof before allowing central notes publication',async()=>{
 const x=passing()
 const result=await verify(x.inputs)
 assert.equal(result.sha,sha)
 assert.equal(result.ciRunUrl,ciRunUrl)
 assert.deepEqual(x.called,['github-candidate-discovery',
  'exact-official-ci-verification','actual-dev-http-proof'])
})
test('requires exact automatic-mode opt-in, never a wildcard',async()=>{
 for(const invalid of [{}, {RELEASE_PUBLICATION_ALLOWED_SHA:'*',
  RELEASE_PUBLICATION_AUTOMATIC:'true'},
  {RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev'}]){
  const x=passing({settings:invalid})
  await assert.rejects(()=>verify(x.inputs),/not enabled/)
  assert.deepEqual(x.called,[])
 }
})
test('refuses unknown GitHub release, unverified CI and mismatched Dev',async()=>{
 for(const variant of [
  {listCandidates:async()=>[]},
  {listCandidates:async()=>[{buildSha:'f'.repeat(40),ciRunUrl}]},
  {verifyRun:async()=>({buildSha:sha,evidence:{ci:true,security:false,migrations:true}})},
  {verifyRun:async()=>({buildSha:'b'.repeat(40),evidence:{ci:true,security:true,migrations:true}})},
  {verifyDev:async()=>({smoke:false})},
 ]){
  await assert.rejects(()=>verify(passing(variant).inputs),
    /incomplete|missing|CI proof|Dev API\/frontend proof/)
 }
})
test('rejects arbitrary run URLs and malformed SHAs before publication',async()=>{
 await assert.rejects(()=>verify(passing({sha:'short'}).inputs),/SHA40/)
 await assert.rejects(()=>verify(passing({
  listCandidates:async()=>[{buildSha:sha,ciRunUrl:'https://evil.example/run/1'}],
 }).inputs),/incomplete or missing/)
})
