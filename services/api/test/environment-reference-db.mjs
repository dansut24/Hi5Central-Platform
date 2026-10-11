import assert from 'node:assert/strict'
import pg from 'pg'
import {pool} from '../src/db.js'
import {syncReferenceEnvironment} from '../src/environmentReferenceSync.js'
const {Client}=pg
const target=new Client({connectionString:process.env.TENANT_UAT_DATABASE_URL})
const tenantId='aaaaaaaa-1234-4321-8123-000000000011'
const slug='sync-tenant'
const targetUrl=()=>process.env.TENANT_UAT_DATABASE_URL
const readPhone=async (db=target)=>(await db.query(
  "SELECT phone FROM organisation_people WHERE tenant_id=$1 AND external_key='PERSON-1'",[tenantId])).rows[0]?.phone
async function provision(db,env){
  await db.query(
    "INSERT INTO tenants(id,slug,company_name,status) VALUES($1,$2,'Sync fixture','active')",
    [tenantId,slug+(env==='live'?'':'-uat')])
  await db.query('INSERT INTO environment_reference_sync_policies(tenant_id,enabled) VALUES($1,true)',[tenantId])
  await db.query(
    "INSERT INTO organisation_people(tenant_id,external_key,name,email,phone,job_title,active) VALUES($1,'PERSON-1','Alex Example','alex@example.invalid','111','Analyst',true)",
    [tenantId])
}
try{
  await target.connect()
  await provision(pool,'live')
  await provision(target,'uat')
  const args={tenantId,tenantSlug:slug,environment:'uat',source:pool,targetUrl}
  let preview=await syncReferenceEnvironment({...args,mode:'preview'})
  assert.equal(preview.totals.updates,0)
  assert.equal(preview.totals.initialised,4)
  await syncReferenceEnvironment({...args,mode:'apply'})
  assert.equal(await readPhone(),'111')
  let b=await target.query('SELECT count(*)::int AS count FROM environment_reference_sync_baselines WHERE tenant_id=$1',[tenantId])
  assert.equal(b.rows[0].count,4)
  await pool.query("UPDATE organisation_people SET phone='222' WHERE tenant_id=$1",[tenantId])
  preview=await syncReferenceEnvironment({...args,mode:'preview'})
  assert.equal(preview.totals.updates,1)
  await syncReferenceEnvironment({...args,mode:'apply'})
  assert.equal(await readPhone(),'222')
  await target.query("UPDATE organisation_people SET phone='uat-test-only' WHERE tenant_id=$1",[tenantId])
  await pool.query("UPDATE organisation_people SET phone='333' WHERE tenant_id=$1",[tenantId])
  const conflict=await syncReferenceEnvironment({...args,mode:'apply'})
  assert.equal(conflict.totals.conflicts,1)
  assert.equal(await readPhone(),'uat-test-only',
    'Local UAT changes must not be overwritten by Production updates')
  const history=await target.query('SELECT count(*)::int AS n FROM environment_reference_sync_runs WHERE tenant_id=$1',[tenantId])
  assert.equal(history.rows[0].n,3)
  const allTables=await target.query("SELECT count(*)::int AS n FROM environment_reference_sync_baselines WHERE tenant_id=$1",[tenantId])
  assert.equal(allTables.rows[0].n,4)
  console.log('PASS: isolated PostgreSQL Production-to-UAT sync, incremental update, conflict, no secrets')
}finally{
  await target.end().catch(()=>{})
  await pool.end().catch(()=>{})
}
