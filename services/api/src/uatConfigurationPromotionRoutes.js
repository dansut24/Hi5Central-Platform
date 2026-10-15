import pg from 'pg'
import {readFileSync} from 'node:fs'
import {pool,withTransaction} from './db.js'
import {resolveSession} from './session.js'
import {deployment,originMatchesTenant} from './deploymentConfig.js'
import {hasPermission} from './access.js'
import {recordItsmConfigurationChange} from './itsmConfigurationChanges.js'
import {
  evaluateUatConfigurationCandidates,prepareSelectiveItsmPromotion,
  prepareSelectiveItsmRevert,validPromotionId,
} from './uatSelectiveConfiguration.js'

const {Client}=pg
function object(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}
function itsmConfig(row){
  const config=object(row?.configuration)
  const effective=Object.keys(config).length?config:object(row?.onboarding_data)
  return object(effective.itsm)
}
async function authorise(c) {
  const session=await resolveSession(c)
  if(!session)return {error:c.json({error:'Authentication required.'},401)}
  if(deployment.runtimeEnvironment!=='live'||!originMatchesTenant(c.req.header('origin'),session.slug))
    return {error:c.json({error:'Approve UAT changes from your Production workspace.'},403)}
  if(!['owner','admin'].includes(session.tenant_role)
    ||!hasPermission(session.access,'settings.itsm.manage'))
    return {error:c.json({error:'Organisation ITSM administrator access required.'},403)}
  const mode=await pool.query(
    `SELECT t.slug,p.update_mode FROM tenants t JOIN tenant_release_preferences p
      ON p.tenant_id=t.id WHERE t.id=$1 AND t.status='active' LIMIT 1`,
    [session.tenant_id])
  if(!mode.rowCount||mode.rows[0].update_mode!=='admin_controlled')
    return {error:c.json({error:'Selective UAT promotion is available only for Custom ITSM customers.'},403)}
  return {session,slug:mode.rows[0].slug}
}
function uatConnectionString(){
  const file=process.env.TENANT_UAT_DATABASE_URL_FILE
  const url=file?readFileSync(file,'utf8').trim():process.env.TENANT_UAT_DATABASE_URL
  if(!url||!/^postgres(?:ql)?:\/\//i.test(url))
    throw Object.assign(new Error('Read-only UAT release comparison is not configured.'),{status:503})
  return url
}
/** Short-lived, READ ONLY UAT connection. Never update UAT or replicate
 * full snapshots to Live: only allowlisted per-field audit metadata crosses.
 */
async function readUatCandidates(tenantId,canonicalSlug){
  const db=new Client({connectionString:uatConnectionString(),connectionTimeoutMillis:5000,
    statement_timeout:7500,query_timeout:9000})
  try {
    await db.connect()
    await db.query('BEGIN READ ONLY')
    const tenant=await db.query(
      `SELECT t.slug,t.status,s.onboarding_data,s.configuration
       FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id
       WHERE t.id=$1 LIMIT 1`,[tenantId])
    if(!tenant.rowCount||tenant.rows[0].slug!==canonicalSlug+'-uat'||tenant.rows[0].status!=='active')
      throw Object.assign(new Error('UAT tenant does not match the active Live customer.'),{status:409})
    const events=await db.query(
      `SELECT id,entity_key,changed_keys,value_changes,recorded_at
       FROM itsm_configuration_change_events
       WHERE tenant_id=$1 AND environment='uat'
         AND entity_key='tenant_settings.itsm.delta-v2'
       ORDER BY recorded_at DESC,id DESC LIMIT 250`,[tenantId])
    await db.query('COMMIT')
    return {events:events.rows,uatConfig:itsmConfig(tenant.rows[0])}
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}
  finally{await db.end().catch(()=>{})}
}
async function liveConfig(db,tenantId,locked=false){
  const row=await db.query(`SELECT onboarding_data,configuration FROM tenant_settings
    WHERE tenant_id=$1 ${locked?'FOR UPDATE':''}`,[tenantId])
  if(!row.rowCount)throw Object.assign(new Error('Live tenant settings are not configured.'),{status:409})
  return itsmConfig(row.rows[0])
}
async function promotionRows(db,tenantId){
  const rows=await db.query(
    `SELECT id,uat_event_id,setting_path,before_value,after_value,status,
       approved_by,applied_at,reverted_by,reverted_at
     FROM itsm_configuration_promotions WHERE tenant_id=$1
     ORDER BY applied_at DESC LIMIT 250`,[tenantId])
  return rows.rows
}
function promotionPayload({uat,live,history}){
  const candidates=evaluateUatConfigurationCandidates({
    events:uat.events,uatConfig:uat.uatConfig,liveConfig:live,priorPromotions:history,
  })
  return {
    environment:'live',scope:'itsm',mode:'admin_controlled',
    candidates,history:history.map(x=>({
      id:x.id,path:x.setting_path,before:x.before_value,after:x.after_value,
      status:x.status,appliedAt:x.applied_at,revertedAt:x.reverted_at,
    })),
  }
}
export function registerUatConfigurationPromotionRoutes(app){
  app.get('/api/v1/release-management/configuration-promotions',async c=>{
    const auth=await authorise(c)
    if(auth.error)return auth.error
    try{
      const [uat,live,history]=await Promise.all([
        readUatCandidates(auth.session.tenant_id,auth.slug),
        liveConfig(pool,auth.session.tenant_id),
        promotionRows(pool,auth.session.tenant_id),
      ])
      return c.json(promotionPayload({uat,live,history}))
    }catch(e){
      console.error('UAT selective configuration comparison failed',{code:e.code||'UNAVAILABLE'})
      return c.json({error:e.status===409?e.message:'Could not read UAT changes safely.'},e.status||503)
    }
  })
  app.post('/api/v1/release-management/configuration-promotions',async c=>{
    const auth=await authorise(c)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    if(!validPromotionId(body?.eventId)||typeof body?.path!=='string'||body.path.length>220)
      return c.json({error:'Choose a valid UAT change to promote.'},400)
    // The browser supplies only event identity and field path. Values are
    // always derived from the protected UAT ledger and locked Live DB row.
    try{
      const uat=await readUatCandidates(auth.session.tenant_id,auth.slug)
      const result=await withTransaction(async db=>{
        const live=await liveConfig(db,auth.session.tenant_id,true)
        const history=await promotionRows(db,auth.session.tenant_id)
        const candidate=evaluateUatConfigurationCandidates({
          events:uat.events,uatConfig:uat.uatConfig,liveConfig:live,priorPromotions:history,
        }).find(x=>x.eventId===body.eventId&&x.path===body.path)
        const updated=prepareSelectiveItsmPromotion({candidate,liveConfig:live})
        const recorded=await db.query(
          `INSERT INTO itsm_configuration_promotions
            (tenant_id,uat_event_id,setting_path,before_value,after_value,approved_by)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id,applied_at`,
          [auth.session.tenant_id,candidate.eventId,candidate.path,
           JSON.stringify(candidate.before),JSON.stringify(candidate.after),auth.session.user_id])
        await db.query(
          `UPDATE tenant_settings SET
           configuration=jsonb_set(
             CASE WHEN configuration='{}'::jsonb
             THEN COALESCE(onboarding_data,'{}'::jsonb)
             ELSE configuration END,'{itsm}',$2::jsonb,true),
           updated_at=now() WHERE tenant_id=$1`,
          [auth.session.tenant_id,JSON.stringify(updated.configuration)])
        await recordItsmConfigurationChange({
          db,tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
          environment:'live',before:live,after:updated.configuration,changedPaths:updated.changedPaths,
        })
        return {id:recorded.rows[0].id,status:'applied',path:candidate.path,
          before:candidate.before,after:candidate.after,appliedAt:recorded.rows[0].applied_at}
      })
      return c.json({promotion:result})
    }catch(e){
      if(e.code==='23505')return c.json({error:'This UAT change was already promoted. Refresh.'},409)
      console.error('UAT selective setting promotion rejected',{code:e.code||'CONFLICT'})
      return c.json({error:e.status===409?e.message:'Unable to promote the selected setting safely.'},e.status||503)
    }
  })
  app.post('/api/v1/release-management/configuration-promotions/:id/revert',async c=>{
    const auth=await authorise(c)
    if(auth.error)return auth.error
    const id=c.req.param('id')
    if(!validPromotionId(id))return c.json({error:'Invalid promotion reference.'},400)
    try{
      const result=await withTransaction(async db=>{
        const live=await liveConfig(db,auth.session.tenant_id,true)
        const previous=await db.query(
          `SELECT id,setting_path,before_value,after_value,status
             FROM itsm_configuration_promotions WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
          [id,auth.session.tenant_id])
        if(!previous.rowCount)throw Object.assign(new Error('Promotion not found.'),{status:404})
        const updated=prepareSelectiveItsmRevert({promotion:previous.rows[0],liveConfig:live})
        await db.query(
          `UPDATE tenant_settings SET
           configuration=jsonb_set(
             CASE WHEN configuration='{}'::jsonb
             THEN COALESCE(onboarding_data,'{}'::jsonb)
             ELSE configuration END,'{itsm}',$2::jsonb,true),
           updated_at=now() WHERE tenant_id=$1`,
          [auth.session.tenant_id,JSON.stringify(updated.configuration)])
        await recordItsmConfigurationChange({
          db,tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
          environment:'live',before:live,after:updated.configuration,changedPaths:updated.changedPaths,
        })
        const reverted=await db.query(
          `UPDATE itsm_configuration_promotions SET
             status='reverted',reverted_by=$2,reverted_at=now()
           WHERE id=$1 AND status='applied' RETURNING id,reverted_at`,[id,auth.session.user_id])
        if(!reverted.rowCount)throw Object.assign(new Error('Promotion was already reverted.'),{status:409})
        return {id,status:'reverted',revertedAt:reverted.rows[0].reverted_at}
      })
      return c.json({promotion:result})
    }catch(e){
      console.error('UAT promotion reversal blocked',{code:e.code||'CONFLICT'})
      return c.json({error:e.status&&e.status<500?e.message:'Could not safely revert the setting.'},e.status||503)
    }
  })
}
