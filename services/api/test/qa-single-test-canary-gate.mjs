import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

const root=fileURLToPath(new URL('../../..',import.meta.url))
const dest=mkdtempSync(join(tmpdir(),'h5c-single-test-gate-'))
const dir=join(dest,'src')
mkdirSync(dir,{recursive:true})
for(const name of ['runtimePoolPolicy.js','releaseRolloutPlanner.js']){
  copyFileSync(join(root,'services/api/src',name),join(dir,name))
}
copyFileSync(join(root,'deployment/qa26/single-test-canary/services/api/src/tenantReleaseQueue.js'),
  join(dir,'tenantReleaseQueue.js'))
// Ensure the copied modules are loaded as ESM regardless of temporary path.
const {writeFileSync}=await import('node:fs')
writeFileSync(join(dest,'package.json'),'{"type":"module"}')
const {claimDueRollouts}=await import(pathToFileURL(join(dir,'tenantReleaseQueue.js')).href)

const id='2ab0c800-f01d-40f7-b1db-a624b4543b2a'
const cohort=['h5c-managed-qa26']
const makeDb=({paused=true,permit=0}={})=>{
  const seen=[]
  return {
    seen,
    async query(sql,args){
      seen.push({sql,args})
      if(sql.includes('pg_advisory_xact_lock'))return {rows:[{locked:true}],rowCount:1}
      if(sql.includes('SELECT paused,reason FROM platform_release_rollout_control'))
        return {rows:[{paused,reason:'Safe global pause'}],rowCount:1}
      if(sql.includes('SELECT p.job_id FROM platform_release_single_test_canary_permits'))
        return {rows:permit?[{job_id:id}]:[],rowCount:permit}
      if(sql.includes('SELECT j.id,j.tenant_id,j.environment,j.build_sha'))
        return {rows:[],rowCount:0}
      if(sql.includes('SELECT DISTINCT environment FROM tenant_release_rollout_jobs'))
        return {rows:[],rowCount:0}
      throw Error('Unexpected SQL '+sql)
    },
  }
}
const options={environment:'test',limit:1,leaseSeconds:600,
  qaTenantSlugs:cohort,qaCanaryJobId:id}

test('globally unpaused state blocks the canary even if a permit exists',async()=>{
  const db=makeDb({paused:false,permit:1})
  const result=await claimDueRollouts(db,options)
  assert.equal(result.paused,true)
  assert.equal(result.claimed.length,0)
  assert.ok(!db.seen.some(x=>x.sql.includes('SELECT p.job_id')))
})
test('global pause + no active permit never claims a job',async()=>{
  const db=makeDb({paused:true,permit:0})
  const result=await claimDueRollouts(db,options)
  assert.equal(result.paused,true)
  assert.equal(result.claimed.length,0)
  assert.ok(!db.seen.some(x=>x.sql.includes('SELECT j.id,j.tenant_id,j.environment')))
})
test('valid exact single-job permit scopes the SQL query to the one job',async()=>{
  const db=makeDb({paused:true,permit:1})
  const result=await claimDueRollouts(db,options)
  assert.equal(result.paused,false)
  assert.equal(result.claimed.length,0)
  const query=db.seen.find(x=>x.sql.includes('SELECT j.id,j.tenant_id,j.environment'))
  assert.ok(query.sql.includes('j.id=$5::uuid'))
  assert.equal(query.args[4],id)
  assert.deepEqual(query.args[3],cohort)
})
test('wrong canary id, wrong environment, wider cohort or bulk limit fail closed',async()=>{
  const changes=[
    {qaCanaryJobId:'1e56ca13-33a4-4603-b723-9f4951120101'},
    {environment:'live'},
    {qaTenantSlugs:['h5c-managed-qa26','managed1']},
    {qaTenantSlugs:['h5c-custom-qa26']},
    {limit:2},
  ]
  for(const extra of changes){
    const db=makeDb({paused:true,permit:1})
    await assert.rejects(()=>claimDueRollouts(db,{...options,...extra}),/one exact QA Test job/i)
    assert.equal(db.seen.length,0)
  }
})
test('missing canary job parameter cannot use normal batch-worker path',async()=>{
  const db=makeDb()
  await assert.rejects(()=>claimDueRollouts(db,{...options,qaCanaryJobId:null}),
    /one exact QA Test job/i)
  assert.equal(db.seen.length,0)
})
process.on('exit',()=>rmSync(dest,{recursive:true,force:true}))
