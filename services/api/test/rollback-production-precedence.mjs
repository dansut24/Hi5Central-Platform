import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {rollbackReadiness} from '../src/stageRollbackControl.js'

const tenantId='52b02c05-b454-4acc-80cc-90f7adfe0866'
const current='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const previous='79d95f3ffa2a5e3c7820cbd00aa69cb19c886f0e'

function stateDb(productionSha){
 return {
  async query(sql){
   sql=String(sql)
   if(sql.includes('SELECT t.status,p.update_mode'))
    return {rows:[{status:'active',update_mode:'admin_controlled'}],rowCount:1}
   if(sql.includes('FROM platform_release_rollback_jobs')&&sql.includes('ORDER BY created_at'))
    return {rows:[],rowCount:0}
   if(sql.includes('SELECT a.build_sha,a.generation,a.pool_id,t.slug'))
    return {rows:[{build_sha:current,generation:1792448479497,pool_id:'h5pool-uat-d05e592ef6e4',slug:'companycustom'}],rowCount:1}
   if(sql.includes('SELECT j.previous_build_sha FROM tenant_release_rollout_jobs'))
    return {rows:[{previous_build_sha:previous}],rowCount:1}
   if(sql.includes('FROM tenants t JOIN tenant_release_preferences p'))
    return {rows:[{id:tenantId,slug:'companycustom',status:'active',update_mode:'admin_controlled'}],rowCount:1}
   if(sql.includes('SELECT environment,pool_id,build_sha,generation'))
    return {rows:[{environment:'uat',pool_id:'h5pool-uat-d05e592ef6e4',build_sha:current,generation:1792448479497}],rowCount:1}
   if(sql.includes('FROM tenant_runtime_route_attestations'))
    return {rows:[{pool_id:'h5pool-uat-d05e592ef6e4',build_sha:current,public_host:'companycustom-uat.hi5central.com',state:'active',checked_at:new Date()}],rowCount:1}
   if(sql.includes('AS backed_up'))
    return {rows:[{id:'2a91a2ed-e237-4195-836c-06e5c58b6f2b',build_sha:current,previous_build_sha:previous,status:'succeeded',backed_up:true}],rowCount:1}
   if(sql.includes('SELECT build_sha FROM tenant_runtime_assignments')&&sql.includes("environment='live'"))
    return {rows:productionSha?[{build_sha:productionSha}]:[],rowCount:productionSha?1:0}
   if(sql.includes('SELECT 1 FROM tenant_release_rollout_jobs')
      ||sql.includes('SELECT 1 FROM platform_release_rollback_jobs'))
    return {rows:[],rowCount:0}
   throw Error('Unexpected read in regression fixture: '+sql.slice(0,140))
  }
 }
}
test('customer cannot roll UAT backward while Production is on the newer release',async()=>{
 const outcome=await rollbackReadiness(stateDb(current),{
  tenantId,environment:'uat',actor:'customer',executorReady:true})
 assert.equal(outcome.canRequest,false)
 assert.match(outcome.reasons.join(' '),/Roll back Production/)
 assert.equal(outcome.installedBuildSha,current)
 assert.equal(outcome.previousBuildSha,previous)
})
test('UAT restore can proceed after an independently verified Production restore to target',async()=>{
 const outcome=await rollbackReadiness(stateDb(previous),{
  tenantId,environment:'uat',actor:'customer',executorReady:true})
 assert.equal(outcome.canRequest,true)
 assert.deepEqual(outcome.reasons,[])
})
test('missing or unrecognised Production version fails closed',async()=>{
 for(const sha of [null,'a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c']){
  const outcome=await rollbackReadiness(stateDb(sha),{
   tenantId,environment:'uat',actor:'customer',executorReady:true})
  assert.equal(outcome.canRequest,false)
 }
})
test('worker and host lease also require exact Production rollback target',()=>{
 const worker=readFileSync(new URL('../src/stageRollbackExecution.mjs',import.meta.url),'utf8')
 const host=readFileSync(new URL('../../../deployment/release/host-deploy.mjs',import.meta.url),'utf8')
 assert.match(worker,/await productionBeforeUat\(\)/)
 assert.match(worker,/installed\.rows\[0\]\?\.build_sha!==job\.toSha/)
 assert.match(host,/production\.build_sha=r\.target_build_sha/)
})
