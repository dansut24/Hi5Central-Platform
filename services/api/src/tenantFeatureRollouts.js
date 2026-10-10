import { readFileSync } from 'node:fs'
import pg from 'pg'
import { pool, withTransaction } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { recordSecurityEvent, requestIp, requestUserAgent } from './securityAudit.js'

export const LIVE_CHAT_FEATURE = 'itsm.live_chat'
const { Client } = pg

async function requireOwner(c) {
  if (deployment.runtimeEnvironment !== 'live') return { error:c.json({error:'Use your Live organisation to manage releases.'},403) }
  const session=await resolveSession(c)
  if (!session) return {error:c.json({error:'Sign in to your organisation.'},401)}
  if (!originMatchesTenant(c.req.header('origin'),session.slug)) return {error:c.json({error:'Tenant session mismatch.'},403)}
  if (!['owner','admin'].includes(session.tenant_role)) return {error:c.json({error:'Organisation administrator access is required.'},403)}
  const result=await pool.query(
    `SELECT p.update_mode,e.status
      FROM tenant_release_preferences p
      JOIN tenant_environment_state e ON e.tenant_id=p.tenant_id AND e.environment='uat'
      WHERE p.tenant_id=$1`,[session.tenant_id])
  if (result.rows[0]?.update_mode!=='admin_controlled')
    return {error:c.json({error:'Manual promotion is available only with Custom / admin-controlled updates.'},409)}
  if (result.rows[0]?.status!=='ready')
    return {error:c.json({error:'UAT must be provisioned before staging releases.'},409)}
  return {session}
}

export async function withUatDatabase(fn, targets = {}) {
  const connectionString=targets.uat
    || (process.env.TENANT_UAT_DATABASE_URL_FILE
      ? readFileSync(process.env.TENANT_UAT_DATABASE_URL_FILE,'utf8').trim()
      : process.env.TENANT_UAT_DATABASE_URL)
  if (!connectionString) throw new Error('UAT database connection is not configured.')
  const client=new Client({connectionString,connectionTimeoutMillis:6000})
  try { await client.connect();return await fn(client) }
  finally {await client.end().catch(()=>{})}
}

async function featureState(database, tenantId, environment) {
  const r=await database.query(
    `SELECT enabled FROM tenant_environment_feature_overrides
      WHERE tenant_id=$1 AND environment=$2 AND feature_key=$3`,
    [tenantId,environment,LIVE_CHAT_FEATURE])
  return r.rowCount ? Boolean(r.rows[0].enabled) : null
}

async function setFeature(database, tenantId, userId, environment, enabled) {
  const result=await database.query(
    `INSERT INTO tenant_environment_feature_overrides
       (tenant_id,environment,feature_key,enabled,updated_by)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(tenant_id,environment,feature_key)
     DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
     RETURNING enabled`,
    [tenantId,environment,LIVE_CHAT_FEATURE,enabled,userId])
  return Boolean(result.rows[0].enabled)
}

export async function tenantLiveChatState(tenantId,{source=pool,targets={}}={}) {
  const [live,uat,approval]=await Promise.all([
    featureState(source,tenantId,'live'),
    withUatDatabase(db=>featureState(db,tenantId,'uat'),targets),
    source.query(
      `SELECT state,release_ref,staged_at,verified_at,promoted_at
       FROM tenant_feature_release_approvals
       WHERE tenant_id=$1 AND feature_key=$2`,
      [tenantId,LIVE_CHAT_FEATURE]),
  ])
  return {
    featureKey:LIVE_CHAT_FEATURE,
    uatEnabled:uat===true,
    liveEnabled:live===true,
    uatOverridePresent:uat!==null,
    liveOverridePresent:live!==null,
    state:approval.rows[0]?.state||'not_staged',
    releaseRef:approval.rows[0]?.release_ref||'',
    stagedAt:approval.rows[0]?.staged_at||null,
    verifiedAt:approval.rows[0]?.verified_at||null,
    promotedAt:approval.rows[0]?.promoted_at||null,
  }
}

/** Stage first in the tenant's separate UAT database. Do not touch other tenants. */
export async function stageTenantLiveChat(tenantId,userId,opts={}) {
  const source=opts.source||pool
  const targets=opts.targets||{}
  const changeRef='live-chat-'+new Date().toISOString().slice(0,10)
  // Establish a controlled Live baseline only when none exists. Never disable
  // an already deployed customer feature merely because UAT is restaged.
  await source.query(
    `INSERT INTO tenant_environment_feature_overrides
      (tenant_id,environment,feature_key,enabled,updated_by)
     VALUES($1,'live',$2,false,$3)
     ON CONFLICT(tenant_id,environment,feature_key) DO NOTHING`,
    [tenantId,LIVE_CHAT_FEATURE,userId])
  await withUatDatabase(async db=>{
    await db.query('BEGIN')
    try {
      const tenant=await db.query('SELECT 1 FROM tenants WHERE id=$1 AND status=$2',[tenantId,'active'])
      if(!tenant.rowCount)throw new Error('UAT organisation has not been provisioned.')
      await setFeature(db,tenantId,userId,'uat',true)
      await db.query('COMMIT')
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
  },targets)
  await source.query(
    `INSERT INTO tenant_feature_release_approvals
      (tenant_id,feature_key,state,release_ref,staged_by,staged_at)
     VALUES($1,$2,'staged',$3,$4,now())
     ON CONFLICT(tenant_id,feature_key) DO UPDATE SET
       state='staged',release_ref=excluded.release_ref,staged_by=excluded.staged_by,
       staged_at=now(),verified_by=NULL,verified_at=NULL,
       promoted_by=NULL,promoted_at=NULL,updated_at=now()`,
    [tenantId,LIVE_CHAT_FEATURE,changeRef,userId])
  return tenantLiveChatState(tenantId,{source,targets})
}

/** A tenant administrator explicitly confirms UAT validation before approval. */
export async function verifyTenantLiveChatUat(tenantId,userId,opts={}) {
  const source=opts.source||pool,targets=opts.targets||{}
  const state=await tenantLiveChatState(tenantId,{source,targets})
  if(state.state!=='staged'||!state.uatEnabled)
    throw new Error('Stage and test Live Chat in UAT before confirming acceptance.')
  const r=await source.query(
    `UPDATE tenant_feature_release_approvals
       SET state='uat_passed',verified_by=$3,verified_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND feature_key=$2 AND state='staged' RETURNING state`,
    [tenantId,LIVE_CHAT_FEATURE,userId])
  if(!r.rowCount)throw new Error('Live Chat UAT acceptance could not be recorded.')
  return tenantLiveChatState(tenantId,{source,targets})
}

/** Promote only UAT-passed, tenant-specific feature configuration to Live. */
export async function promoteTenantLiveChat(tenantId,userId,opts={}) {
  const source=opts.source||pool,targets=opts.targets||{}
  const state=await tenantLiveChatState(tenantId,{source,targets})
  if(state.state!=='uat_passed'||!state.verifiedAt||!state.uatEnabled)
    throw new Error('Live Chat must pass UAT before promotion to Live.')
  return withTransaction(async client=>{
    const approval=await client.query(
      `SELECT state FROM tenant_feature_release_approvals
       WHERE tenant_id=$1 AND feature_key=$2 FOR UPDATE`,[tenantId,LIVE_CHAT_FEATURE])
    if(approval.rows[0]?.state!=='uat_passed') throw new Error('UAT approval has changed.')
    await setFeature(client,tenantId,userId,'live',true)
    await client.query(
      `UPDATE tenant_feature_release_approvals
         SET state='promoted',promoted_by=$3,promoted_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND feature_key=$2`,
      [tenantId,LIVE_CHAT_FEATURE,userId])
    return {featureKey:LIVE_CHAT_FEATURE,liveEnabled:true,state:'promoted'}
  },source)
}

export function registerTenantFeatureRoutes(app) {
  // Read-only effective flag for the current tenant/environment. Absence of
  // an override preserves existing workspace user preference behaviour.
  app.get('/api/v1/workspace-features',async c=>{
    const session=await resolveSession(c)
    if(!session)return c.json({error:'Authentication required.'},401)
    if(!originMatchesTenant(c.req.header('origin'),session.slug))
      return c.json({error:'Tenant session mismatch.'},403)
    const environment=deployment.runtimeEnvironment
    if(!['live','uat','test'].includes(environment))
      return c.json({liveChatEnabled:null,environment})
    if(environment==='test')return c.json({liveChatEnabled:true,environment})
    return c.json({liveChatEnabled:await featureState(pool,session.tenant_id,environment),environment})
  })

  app.get('/api/v1/release-management/feature-rollouts/live-chat',async c=>{
    const auth=await requireOwner(c)
    if(auth.error)return auth.error
    return c.json(await tenantLiveChatState(auth.session.tenant_id))
  })

  for(const [action,method] of [
    ['stage-uat',stageTenantLiveChat],
    ['confirm-uat',verifyTenantLiveChatUat],
    ['promote-live',promoteTenantLiveChat],
  ]) {
    app.post(`/api/v1/release-management/feature-rollouts/live-chat/${action}`,async c=>{
      const auth=await requireOwner(c)
      if(auth.error)return auth.error
      try {
        const result=await method(auth.session.tenant_id,auth.session.user_id)
        await recordSecurityEvent({
          tenantId:auth.session.tenant_id,
          actorUserId:auth.session.user_id,
          sessionId:auth.session.session_id||null,
          eventType:'release.feature_'+action.replaceAll('-','_'),
          ipAddress:requestIp(c),userAgent:requestUserAgent(c),
          metadata:{featureKey:LIVE_CHAT_FEATURE,action},
        })
        return c.json(result)
      } catch(e){
        console.error('Tenant feature release action failed',{action,code:e.code||'FAILED',message:e.message})
        return c.json({error:e.message||'Release could not be completed.'},409)
      }
    })
  }
}
