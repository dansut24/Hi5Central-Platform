import assert from 'node:assert/strict'
import test from 'node:test'
import { isDirectoryReference,validDirectoryServiceToken,validateDirectorySnapshot,
  readCanonicalDirectory,liveRmmAccessAllowed } from '../src/liveDirectoryBridge.js'
const tenantId='11111111-1111-4111-8111-111111111111'
const userId='22222222-2222-4222-8222-222222222222'
const secret='central-directory-test-secret-is-long-enough'
const snapshot={people:[{name:'QA user'}],teams:[],departments:[],sites:[],teamMemberships:[]}
test('Mandatory service bearer secret and typed tenant/user/environment',()=>{
  assert.equal(validDirectoryServiceToken(secret,'Bearer '+secret),true)
  assert.equal(validDirectoryServiceToken(secret,'Bearer invalid'),false)
  assert.equal(validDirectoryServiceToken('short','Bearer short'),false)
  assert.equal(isDirectoryReference(tenantId,userId,'uat'),true)
  assert.equal(isDirectoryReference(tenantId,userId,'test'),true)
  assert.equal(isDirectoryReference(tenantId,userId,'live'),false)
  assert.equal(isDirectoryReference(tenantId,'another-user','test'),false)
})
test('Read-through has scoped request and denies unsecured/unavailable origins',async()=>{
  const seen=[]
  const fetcher=async(url,options)=>{seen.push({url,options});return {ok:true,json:async()=>({directory:snapshot})}}
  const result=await readCanonicalDirectory(tenantId,userId,{environment:'uat',fetcher,apiUrl:'https://identity.example.test',secret})
  assert.deepEqual(result,snapshot)
  assert.equal(seen[0].options.method,'POST')
  assert.deepEqual(JSON.parse(seen[0].options.body),{tenantId,userId,environment:'uat'})
  assert.equal(seen[0].options.headers.authorization,'Bearer '+secret)
  // Shared Test/UAT deliberately do not set QA26_STAGING_MODE. Internal routing
  // must still reach the protected Live authority through the gateway.
  assert.equal(seen[0].options.headers['X-Hi5-QA26-Internal'],'pr69')
  await assert.rejects(readCanonicalDirectory(tenantId,userId,{environment:'test',fetcher,apiUrl:'http://unsafe.example.test',secret}),/not configured/)
  await assert.rejects(readCanonicalDirectory(tenantId,userId,{environment:'live',fetcher,apiUrl:'https://identity.example.test',secret}),/sandbox session/)
  await assert.rejects(readCanonicalDirectory(tenantId,userId,{environment:'uat',fetcher:async()=>({ok:false}),apiUrl:'https://identity.example.test',secret}),/unavailable or access was denied/)
})
test('Directory payload validation never silently falls back to stale local rows',()=>{
  assert.throws(()=>validateDirectorySnapshot({people:[]}),/incomplete/)
  assert.deepEqual(validateDirectorySnapshot(snapshot),snapshot)
})
test('Test/UAT RMM remote access is denied, internal Dev remains isolated',()=>{
  assert.equal(liveRmmAccessAllowed('test'),false)
  assert.equal(liveRmmAccessAllowed('uat'),false)
  assert.equal(liveRmmAccessAllowed('live'),true)
  assert.equal(liveRmmAccessAllowed('dev'),true)
  assert.equal(liveRmmAccessAllowed('unknown'),false)
})

test('Read-through routing marker does not replace the required service credential',async()=>{
  let calls=0
  await assert.rejects(
    readCanonicalDirectory(tenantId,userId,{
      environment:'uat',apiUrl:'https://identity.example.test',secret:'missing',
      fetcher:async()=>{calls++;return {ok:true,json:async()=>({directory:snapshot})}},
    }),
    /not configured/,
  )
  assert.equal(calls,0)
})
