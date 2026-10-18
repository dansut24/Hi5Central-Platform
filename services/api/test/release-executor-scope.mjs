import test from 'node:test'
import assert from 'node:assert/strict'
import {claimDueRollouts} from '../src/tenantReleaseQueue.js'

const SHA='ff3795f7d1bc5d256ced5142b578c0897f57f6a7'
const OTHER='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'

test('a configured executor SHA must be exactly lowercase SHA40 before DB access',async()=>{
 let calls=0
 const db={query:async()=>{calls++;return {rows:[]}}}
 for(const invalid of ['',OTHER.slice(0,12),OTHER.toUpperCase(),' '+SHA,SHA+' ']){
  await assert.rejects(claimDueRollouts(db,{buildSha:invalid}),/Exact pinned release SHA/)
 }
 assert.equal(calls,0)
})

test('approved Test execution claim selects only exact pinned SHA and named QA cohort',async()=>{
 const calls=[]
 const db={async query(sql,params){
  calls.push({sql,params})
  if(sql.includes('SELECT paused,reason FROM platform_release_rollout_control'))
   return {rows:[{paused:false,reason:''}]}
  if(sql.includes('FROM tenant_release_rollout_jobs j'))return {rows:[]}
  return {rows:[]}
 }}
 const scope=['h5c-managed-qa26','h5c-custom-qa26','qa27-managed-itsm-qa27','qa27-custom-itsm-qa27']
 const result=await claimDueRollouts(db,{
  now:new Date('2026-10-18T13:30:00Z'),environment:'test',limit:1,
  qaTenantSlugs:scope,buildSha:SHA,leaseSeconds:600
 })
 assert.deepEqual(result.claimed,[])
 const statement=calls.find(v=>v.sql.includes('FOR UPDATE OF j SKIP LOCKED'))
 assert.ok(statement)
 assert.match(statement.sql,/j\.build_sha=\$5/)
 assert.match(statement.sql,/a\.execution_enabled=true/)
 assert.match(statement.sql,/j\.environment=\$3/)
 assert.deepEqual(statement.params.slice(2),['test',scope,SHA])
})
