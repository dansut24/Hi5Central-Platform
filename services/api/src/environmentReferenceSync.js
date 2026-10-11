import pg from 'pg'
import {readFileSync} from 'node:fs'
import {pool} from './db.js'
import {deployment,originMatchesTenant} from './deploymentConfig.js'
import {resolveSession} from './session.js'
import {
  REFERENCE_RESOURCES,MAX_RESOURCE_ROWS,planReferenceChanges,
} from './environmentReferencePlan.js'

const {Client}=pg
const environments=['uat','test']
const validTenantId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const REFRESH_INTERVAL_MS=5*60*1000
function refuse(message,status=409){return Object.assign(new Error(message),{status})}
function destinationUrl(environment){
  if(!environments.includes(environment))throw refuse('Unsupported environment.',400)
  const file=process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL_FILE`]
  const value=file?readFileSync(file,'utf8').trim():process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL`]
  if(!value)throw refuse('Environment reference database is unavailable.',503)
  return value
}
function pilotSlug(){
  return String(process.env.ENV_REFERENCE_SYNC_PILOT_TENANT_SLUG||'').trim().toLowerCase()
}
async function verifiedTenant(db,tenantId,slug){
  const r=await db.query(
    "SELECT id FROM tenants WHERE id=$1 AND slug=$2 AND status='active'",
    [tenantId,slug])
  if(r.rowCount!==1)throw refuse('Tenant identity mismatch across environments.',403)
}
async function sourceRows(db,tenantId,resource,lock=false){
  const columns=['external_key','id',...resource.fields].join(',')
  const sql=`SELECT ${columns} FROM ${resource.table}
    WHERE tenant_id=$1 ORDER BY external_key LIMIT ${MAX_RESOURCE_ROWS+1}${lock?' FOR UPDATE':''}`
  const result=await db.query(sql,[tenantId])
  if(result.rowCount>MAX_RESOURCE_ROWS)throw refuse('Too many reference records; batch processing required.',422)
  return result.rows
}
async function baselines(db,tenantId,resource){
  return (await db.query(
    `SELECT external_key,field_key,source_digest,target_digest
      FROM environment_reference_sync_baselines WHERE tenant_id=$1 AND resource=$2`,
    [tenantId,resource.kind])).rows
}
async function policyEnabled(db,tenantId){
  const r=await db.query('SELECT enabled FROM environment_reference_sync_policies WHERE tenant_id=$1',[tenantId])
  return r.rows[0]?.enabled===true
}
function accumulate(total,next){
  for(const [key,value] of Object.entries(next))total[key]=(total[key]||0)+value
}
function safeCounts(out){
  return {environment:out.environment,mode:out.mode,
    totals:out.totals,
    resources:out.resources,
    status:out.status,
    // No values, names, email addresses, phone numbers or source keys.
  }
}
export async function syncReferenceEnvironment({
  tenantId,tenantSlug,environment,mode='preview',
  source=pool,targetUrl=destinationUrl,
}){
  if(deployment.runtimeEnvironment!=='live')throw refuse('Synchronisation runs only on the Production control plane.',403)
  if(!validTenantId.test(String(tenantId||''))||!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(String(tenantSlug||'')))
    throw refuse('Invalid tenant reference.',400)
  if(!environments.includes(environment)||!['preview','apply'].includes(mode))
    throw refuse('Unsupported sync request.',400)
  if(!pilotSlug()||pilotSlug()!==tenantSlug)
    throw refuse('Reference sync is not enabled for this organisation.',404)
  const dest=new Client({connectionString:targetUrl(environment),connectionTimeoutMillis:6000})
  const live=await source.connect()
  let liveTransaction=false,destTransaction=false
  const started=new Date()
  try{
    await dest.connect()
    await live.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    liveTransaction=true
    await dest.query(mode==='apply'?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    destTransaction=true
    await verifiedTenant(live,tenantId,tenantSlug)
    await verifiedTenant(dest,tenantId,tenantSlug+'-'+environment)
    if(mode==='apply'){
      if(process.env.ENV_REFERENCE_SYNC_APPLY_ENABLED!=='true')
        throw refuse('Automatic reference synchronisation is still in preview mode.',403)
      if(!(await policyEnabled(live,tenantId))||!(await policyEnabled(dest,tenantId)))
        throw refuse('Reference synchronisation is not enabled for this tenant and environment.',403)
      const lock=await dest.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
        [tenantId+':'+environment+':reference-sync'])
      if(!lock.rows[0]?.acquired)throw refuse('Reference synchronisation is already running.',409)
      await dest.query("SET LOCAL lock_timeout='3s'")
      await dest.query("SET LOCAL statement_timeout='25s'")
    }
    const totals={sourceRecords:0,destinationRecords:0,missing:0,conflicts:0,
      initialised:0,updates:0,destinationOnly:0}
    const resources=[]
    for(const resource of REFERENCE_RESOURCES){
      const [liveRows,targetRows,prior]=await Promise.all([
        sourceRows(live,tenantId,resource),
        sourceRows(dest,tenantId,resource,mode==='apply'),
        baselines(dest,tenantId,resource),
      ])
      const plan=planReferenceChanges({
        source:liveRows,target:targetRows,baselines:prior,resource,
      })
      accumulate(totals,plan.stats)
      resources.push({kind:resource.kind,...plan.stats})
      if(mode!=='apply')continue
      const targetByKey=new Map(targetRows.map(row=>[row.external_key,row]))
      for(const change of plan.changes){
        if(change.action==='conflict')continue
        if(change.action==='update'){
          const target=targetByKey.get(change.externalKey)
          if(!target)throw refuse('Target reference disappeared during reconciliation.')
          // Resource/field identifiers are hard-coded in REFERENCE_RESOURCES,
          // not derived from any user request or stored source value.
          const result=await dest.query(
            `UPDATE ${resource.table} SET ${change.field}=$1,updated_at=now()
              WHERE id=$2 AND tenant_id=$3 AND external_key=$4`,
            [change.value,target.id,tenantId,change.externalKey])
          if(result.rowCount!==1)throw refuse('Target reference changed during reconciliation.')
        }
        await dest.query(
          `INSERT INTO environment_reference_sync_baselines(
            tenant_id,resource,external_key,field_key,source_digest,target_digest)
            VALUES($1,$2,$3,$4,$5,$5)
            ON CONFLICT(tenant_id,resource,external_key,field_key) DO UPDATE SET
              source_digest=EXCLUDED.source_digest,
              target_digest=EXCLUDED.target_digest,
              last_synced_at=now()`,
          [tenantId,resource.kind,change.externalKey,change.field,change.sourceDigest])
      }
    }
    const outcome={environment,mode,status:'completed',totals,resources}
    if(mode==='apply')await dest.query(
      `INSERT INTO environment_reference_sync_runs(tenant_id,environment,mode,status,counts,started_at)
       VALUES($1,$2,$3,'completed',$4::jsonb,$5)`,
      [tenantId,environment,mode,JSON.stringify({totals,resources}),started])
    await dest.query('COMMIT')
    destTransaction=false
    await live.query('COMMIT')
    liveTransaction=false
    return safeCounts(outcome)
  }catch(e){
    if(destTransaction)await dest.query('ROLLBACK').catch(()=>{})
    if(liveTransaction)await live.query('ROLLBACK').catch(()=>{})
    throw e
  }finally{
    live.release()
    await dest.end().catch(()=>{})
  }
}
async function authorise(c){
  const s=await resolveSession(c)
  if(!s)return {error:c.json({error:'Authentication required.'},401)}
  if(deployment.runtimeEnvironment!=='live'||!originMatchesTenant(c.req.header('origin'),s.slug))
    return {error:c.json({error:'Use the Production organisation release centre.'},403)}
  if(!['owner','admin'].includes(s.tenant_role))
    return {error:c.json({error:'Organisation administrator access required.'},403)}
  if(!pilotSlug()||s.slug!==pilotSlug())
    return {error:c.json({error:'Environment sync is not enabled for this organisation.'},404)}
  return {session:s}
}
export function registerEnvironmentReferenceSyncRoutes(app){
  app.get('/api/v1/release-management/environment-sync',async c=>{
    const auth=await authorise(c)
    if(auth.error)return auth.error
    try{
      const results=[]
      for(const environment of environments){
        const result=await syncReferenceEnvironment({
          tenantId:auth.session.tenant_id,tenantSlug:auth.session.slug,environment})
        results.push(result)
      }
      return c.json({direction:'production_to_sandboxes',mode:'preview',
        referenceFields:['people','departments','teams','sites'],
        excludes:['passwords','sessions','mfa_secrets','permissions','records','devices','messages','configuration'],
        environments:results})
    }catch(e){return c.json({error:e.message||'Reference preview unavailable.'},e.status||503)}
  })
  app.post('/api/v1/release-management/environment-sync/:environment/apply',async c=>{
    const auth=await authorise(c)
    if(auth.error)return auth.error
    let body
    try{body=await c.req.json()}catch{return c.json({error:'Valid JSON required.'},400)}
    if(body?.confirmed!==true)return c.json({error:'Explicit confirmation required.'},400)
    try{
      const data=await syncReferenceEnvironment({
        tenantId:auth.session.tenant_id,tenantSlug:auth.session.slug,
        environment:c.req.param('environment'),mode:'apply'})
      return c.json(data)
    }catch(e){return c.json({error:e.message||'Reference sync failed.'},e.status||503)}
  })
}
export function startReferenceSyncScheduler(){
  if(deployment.runtimeEnvironment!=='live'
    ||process.env.ENV_REFERENCE_SYNC_AUTO_ENABLED!=='true'
    ||process.env.ENV_REFERENCE_SYNC_APPLY_ENABLED!=='true'
    ||!pilotSlug())return {enabled:false}
  let running=false
  async function tick(){
    if(running)return
    running=true
    try{
      const p=await pool.query("SELECT id FROM tenants WHERE slug=$1 AND status='active'",[pilotSlug()])
      if(p.rowCount!==1)return
      for(const environment of environments){
        try{
          const outcome=await syncReferenceEnvironment({
            tenantId:p.rows[0].id,tenantSlug:pilotSlug(),environment,mode:'apply'})
          console.log('Environment reference sync completed',{
            environment,counts:outcome.totals,
          })
        }catch(e){
          // Avoid private record values or connection-string disclosure.
          console.error('Environment reference sync failed',{
            environment,code:e.code||'SYNC_ERROR',
          })
        }
      }
    }finally{running=false}
  }
  // Validate and bootstrap an opted-in tenant shortly after startup, then
  // reconcile incrementally every five minutes without an external cron job.
  const initial=setTimeout(()=>{void tick()},15_000)
  initial.unref?.()
  const timer=setInterval(()=>{void tick()},REFRESH_INTERVAL_MS)
  timer.unref?.()
  return {enabled:true,intervalMs:REFRESH_INTERVAL_MS}
}
