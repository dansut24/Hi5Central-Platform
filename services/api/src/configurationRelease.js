import pg from 'pg'
import {readFileSync} from 'node:fs'
import {pool,withTransaction} from './db.js'
import {deployment,originMatchesTenant} from './deploymentConfig.js'
import {resolveSession} from './session.js'
import {recordSecurityEvent,requestIp,requestUserAgent} from './securityAudit.js'
import {differenceList,applyReviewedChanges} from './configurationReleaseDiff.js'
import {AI_CONFIG_PATH,TESTED_AI_BUILD_SHA,acceptedAiChange,verifiedAiProductionBuild,shouldApplyAiVersionGate} from './aiReleaseGate.js'

const {Client}=pg
const error=(message,status=409)=>Object.assign(new Error(message),{status})
const effective=row=>row?.configuration&&Object.keys(row.configuration).length
  ?row.configuration:row?.onboarding_data||{}
const refPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const pilotPaths=()=>new Set(String(process.env.CONFIGURATION_RELEASE_PILOT_PATHS||'')
  .split(',').map(s=>s.trim()).filter(Boolean))


async function admin(c){
  const s=await resolveSession(c)
  if(!s)return {error:c.json({error:'Authentication required.'},401)}
  if(!originMatchesTenant(c.req.header('origin'),s.slug))
    return {error:c.json({error:'Tenant session mismatch.'},403)}
  if(!['owner','admin'].includes(s.tenant_role))
    return {error:c.json({error:'Organisation administrator access is required.'},403)}
  // No other organisation can preview or activate this pilot.
  const pilot=String(process.env.CONFIGURATION_RELEASE_PILOT_TENANT_SLUG||'').trim().toLowerCase()
  if(!pilot||!([pilot,pilot+'-uat'].includes(s.slug)))
    return {error:c.json({error:'Configuration promotion is not enabled for this organisation.'},404)}
  return {session:s}
}
function uatConnectionString(){
  const file=process.env.TENANT_UAT_DATABASE_URL_FILE
  const url=file?readFileSync(file,'utf8').trim():process.env.TENANT_UAT_DATABASE_URL
  if(!url)throw error('UAT configuration database is not available.',503)
  return url
}
async function withUat(read){
  const client=new Client({connectionString:uatConnectionString(),connectionTimeoutMillis:6000})
  try{
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result=await read(client)
    await client.query('COMMIT')
    return result
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{})
    throw e
  }finally{await client.end().catch(()=>{})}
}
async function configuration(db,tenantId,lock=false){
  const r=await db.query(
    `SELECT configuration,onboarding_data FROM tenant_settings
      WHERE tenant_id=$1 ${lock?'FOR UPDATE':''}`,[tenantId])
  if(!r.rowCount)throw error('This tenant is not configured in this environment.',409)
  return effective(r.rows[0])
}
async function trackedEvents(db,tenantId){
  try{
    const r=await db.query(
      `SELECT source_table,source_key,changed_path,operation,recorded_at
         FROM tenant_configuration_change_events
        WHERE tenant_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 200`,[tenantId])
    return r.rows.map(row=>({
      source:row.source_table,recordKey:row.source_key,path:row.changed_path,
      operation:row.operation,recordedAt:row.recorded_at,
      promotable:row.source_table==='tenant_settings',
    }))
  }catch(e){
    if(e.code==='42P01')return [] // Existing UAT changes still appear through live diff.
    throw e
  }
}
async function readyUat(tenantId){
  const r=await pool.query(
    `SELECT status FROM tenant_environment_state WHERE tenant_id=$1 AND environment='uat'`,
    [tenantId])
  if(r.rows[0]?.status!=='ready')throw error('Provision a ready UAT environment before promoting configuration.')
}
async function requiredCapabilities(db,changes){
  const rows=await db.query(`
    SELECT r.path_prefix,r.capability_key,r.component,r.description,
      EXISTS(
        SELECT 1 FROM platform_build_configuration_capabilities b
        JOIN platform_application_deployment_attestations d ON d.environment='live'
        WHERE b.component=r.component
          AND b.capability_key=r.capability_key
          AND b.build_sha=CASE WHEN r.component='api' THEN d.api_sha ELSE d.itsm_sha END
          AND d.status='verified'
          AND d.observed_at>=now()-interval '24 hours'
      ) AS installed
    FROM platform_configuration_capability_requirements r
  `)
  return changes.map(item=>{
    const required=rows.rows.filter(r=>r.path_prefix.length<=item.path.length
      &&r.path_prefix.every((p,i)=>p===item.path[i]))
    const blocked=required.filter(r=>!r.installed)
    return {...item,versionUpgradeRequired:blocked.length>0,
      requiredCapabilities:blocked.map(r=>({capability:r.capability_key,
        component:r.component,description:r.description}))}
  })
}

async function aiAcceptance(db,tenantId){
  const a=await db.query(
    'SELECT tested_build_sha,uat_configuration_hash,accepted_at FROM tenant_ai_release_acceptances WHERE tenant_id=$1',
    [tenantId])
  return a.rows[0]||null
}
async function verifiedLiveAiRuntime(db){
  const r=await db.query(
    "SELECT status,api_sha,itsm_sha,observed_at FROM platform_application_deployment_attestations WHERE environment='live'")
  return verifiedAiProductionBuild({row:r.rows[0]})
}
async function checkDeployedUatAiBuild(){
  // Pilot host is fixed; no user-controlled URL or redirect target.
  const base='https://testing-uat.hi5central.com'
  for(const path of ['/api/v1/updates/version','/release-manifest.json']){
    const response=await fetch(base+path,{redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(9000)})
    if(!response.ok)throw error('Unable to verify the UAT application version.',503)
    const body=await response.json()
    if(body.sha!==TESTED_AI_BUILD_SHA)
      throw error('The running UAT application differs from the tested AI build. Test it again before acceptance.')
  }
}

function summarizeDiff(changes){
  return changes.map(row=>({
    ...row,
    title:row.path.map(s=>s.replace(/([a-z])([A-Z])/g,'$1 $2')).join(' / '),
    category:row.path[0],
    // Existing configuration keys have no application version dependency.
    // Future schema capabilities can mark individual paths as code-dependent.
    promotionStatus:row.promotable?'ready':'needs_safe_adapter',
  }))
}
export function registerConfigurationReleaseRoutes(app){
  app.get('/api/v1/release-management/configuration-changes',async c=>{
    const auth=await admin(c)
    if(auth.error)return auth.error
    const tenantId=auth.session.tenant_id
    if(deployment.runtimeEnvironment==='uat'){
      const [current,events]=await Promise.all([
        configuration(pool,tenantId),trackedEvents(pool,tenantId),
      ])
      return c.json({environment:'uat',trackedEvents:events,
        message:'UAT changes are captured automatically. Review differences and approve them in Production.',
        configurationPresent:Boolean(current),changes:[]})
    }
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Configuration promotion is available through UAT and Production.'},403)
    try{
      await readyUat(tenantId)
      const [live,uat]=await Promise.all([
        configuration(pool,tenantId),
        withUat(async db=>({
          configuration:await configuration(db,tenantId),
          events:await trackedEvents(db,tenantId),
        })),
      ])
      const allChanges=differenceList(live,uat.configuration)
      // A new pilot must not present provisioning/baseline differences as
      // previously approved customer changes. The allowlist also constrains POST.
      const reviewedChanges=allChanges.filter(change=>pilotPaths().has(change.id))
      const [acceptance,liveAiReady]=await Promise.all([
        aiAcceptance(pool,tenantId),verifiedLiveAiRuntime(pool),
      ])
      const aiDiff=reviewedChanges.find(c=>c.id===AI_CONFIG_PATH)
      return c.json({
        environment:'live',
        aiRelease:aiDiff?{
          testedBuildSha:TESTED_AI_BUILD_SHA,
          uatAccepted:acceptedAiChange({change:aiDiff,acceptance}),
          acceptedAt:acceptedAiChange({change:aiDiff,acceptance})?acceptance.accepted_at:null,
          productionBuildReady:liveAiReady,
          requiresSoftwareUpdate:shouldApplyAiVersionGate(aiDiff)&&!liveAiReady,
        }:null,
        changes:summarizeDiff(await requiredCapabilities(pool,reviewedChanges)),
        baselineExcludedCount:allChanges.length-reviewedChanges.length,
        trackedEvents:uat.events,
        promotionPolicy:'Select only tested settings; live changes are not overwritten without approval.',
      })
    }catch(e){
      return c.json({error:e.message||'Cannot inspect UAT changes.'},e.status||503)
    }
  })

  app.post('/api/v1/release-management/configuration-changes/accept-ai-uat',async c=>{
    const auth=await admin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'UAT acceptance is recorded in the Production release centre.'},403)
    let body
    try{body=await c.req.json()}catch{return c.json({error:'Valid JSON required.'},400)}
    const note=String(body?.note||'').trim()
    if(body?.confirmed!==true||body?.tested!==true||note.length<20||note.length>3000)
      return c.json({error:'Confirm the UAT test and provide 20–3000 characters of test evidence.'},400)
    if(!pilotPaths().has(AI_CONFIG_PATH))
      return c.json({error:'The AI release is not enabled for this pilot.'},404)
    try{
      await readyUat(auth.session.tenant_id)
      await checkDeployedUatAiBuild()
      const live=await configuration(pool,auth.session.tenant_id)
      const uat=await withUat(db=>configuration(db,auth.session.tenant_id))
      const change=differenceList(live,uat).find(x=>x.id===AI_CONFIG_PATH)
      if(!change||change.to!==true||!change.promotable)
        throw error('AI Assist must be enabled and tested in UAT, but remain pending in Production.')
      await withTransaction(async db=>{
        const locked=await configuration(db,auth.session.tenant_id,true)
        const latest=differenceList(locked,uat).find(x=>x.id===AI_CONFIG_PATH)
        if(!latest||latest.afterHash!==change.afterHash||latest.beforeHash!==change.beforeHash)
          throw error('The configuration changed during approval. Refresh and retest.')
        await db.query(
          `INSERT INTO tenant_ai_release_acceptances
             (tenant_id,tested_build_sha,uat_configuration_hash,evidence,accepted_by,accepted_at)
           VALUES($1,$2,$3,$4,$5,now())
           ON CONFLICT(tenant_id) DO UPDATE SET tested_build_sha=EXCLUDED.tested_build_sha,
             uat_configuration_hash=EXCLUDED.uat_configuration_hash,
             evidence=EXCLUDED.evidence,accepted_by=EXCLUDED.accepted_by,accepted_at=now()`,
          [auth.session.tenant_id,TESTED_AI_BUILD_SHA,change.afterHash,note,auth.session.user_id])
        await recordSecurityEvent({
          db,tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
          sessionId:auth.session.session_id,eventType:'release.ai_software_uat_accepted',
          ipAddress:requestIp(c),userAgent:requestUserAgent(c),
          metadata:{testedBuildSha:TESTED_AI_BUILD_SHA,configurationPath:AI_CONFIG_PATH},
        })
      })
      return c.json({accepted:true,testedBuildSha:TESTED_AI_BUILD_SHA})
    }catch(e){return c.json({error:e.message||'UAT release acceptance failed.'},e.status||409)}
  })

  app.post('/api/v1/release-management/configuration-changes/promote',async c=>{
    const auth=await admin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only the Production release centre can promote UAT configuration.'},403)
    let body
    try{body=await c.req.json()}catch{return c.json({error:'Valid JSON required.'},400)}
    const note=String(body?.note||'').trim()
    if(body?.confirmed!==true||body?.tested!==true||note.length<20||note.length>3000)
      return c.json({error:'Confirm testing and provide 20–3000 characters of UAT evidence.'},400)
    if(!Array.isArray(body?.changes)||body.changes.length<1||body.changes.length>100)
      return c.json({error:'Select 1–100 tracked settings for this promotion.'},400)
    if(!body.changes.every(item=>pilotPaths().has(item?.id)))
      return c.json({error:'A selected setting is outside the approved configuration pilot scope.'},403)
    if(!body.changes.every(item=>typeof item?.id==='string'&&
      /^[A-Za-z0-9_.-]{1,600}$/.test(item.id)&&
      /^[a-f0-9]{64}$/.test(item.beforeHash||'')&&
      /^[a-f0-9]{64}$/.test(item.afterHash||'')))
      return c.json({error:'Invalid change references.'},400)
    try{
      await readyUat(auth.session.tenant_id)
      // Read one consistent UAT source snapshot. Promotion compares the exact
      // reviewed before/after hashes under the Live tenant row lock.
      const uat=await withUat(db=>configuration(db,auth.session.tenant_id))
      const result=await withTransaction(async db=>{
        const live=await configuration(db,auth.session.tenant_id,true)
        const differences=await requiredCapabilities(db,differenceList(live,uat))
        const indexed=new Map(differences.map(item=>[item.id,item]))
        const ai=body.changes.find(change=>change.id===AI_CONFIG_PATH)
        if(ai&&indexed.get(AI_CONFIG_PATH)?.to===true){
          const acceptance=await aiAcceptance(db,auth.session.tenant_id)
          if(!acceptedAiChange({change:indexed.get(AI_CONFIG_PATH),acceptance}))
            throw error('The matching AI application release must be accepted in UAT before promotion.')
          if(!(await verifiedLiveAiRuntime(db)))
            throw error('Deploy and verify the exact UAT-tested AI API and ITSM build in Production first.')
        }
        if(body.changes.some(change=>indexed.get(change.id)?.versionUpgradeRequired))
          throw error('A selected change requires a compatible Production application upgrade first.')
        const next=applyReviewedChanges(live,uat,body.changes)
        if(JSON.stringify(next)===JSON.stringify(live))throw error('No configuration changes remain to promote.')
        const requiresMfaBefore=live?.security?.requireMfa===true
        const requiresMfaAfter=next?.security?.requireMfa===true
        await db.query("SELECT set_config('hi5.actor_user_id',$1,true)",[auth.session.user_id])
        await db.query(
          `UPDATE tenant_settings SET configuration=$2::jsonb,updated_at=now()
            WHERE tenant_id=$1`,[auth.session.tenant_id,JSON.stringify(next)])
        if(body.changes.some(item=>item.id==='company.displayName')) {
          const displayName=String(next?.company?.displayName||'').trim()
          if(displayName.length<2||displayName.length>120)
            throw error('The promoted organisation name must be 2–120 characters.',400)
          await db.query(
            'UPDATE tenants SET company_name=$2,updated_at=now() WHERE id=$1',
            [auth.session.tenant_id,displayName])
        }
        if(!requiresMfaBefore&&requiresMfaAfter){
          // The exact same security enforcement as an ordinary Production
          // security settings save, without copying UAT sessions or secrets.
          await db.query(
            `UPDATE auth_sessions s
               SET revoked_at=COALESCE(s.revoked_at,now()),
                   revoked_reason=COALESCE(s.revoked_reason,'mfa_policy_enabled')
             WHERE s.tenant_id=$1 AND s.id<>$2 AND s.revoked_at IS NULL
               AND s.user_id IN (
                 SELECT ur.user_id FROM access_user_roles ur
                 JOIN access_roles r ON r.tenant_id=ur.tenant_id AND r.id=ur.role_id
                 WHERE ur.tenant_id=$1 AND r.active=true AND (
                   r.system_key IN ('owner','administrator')
                   OR 'settings.security.manage'=ANY(r.permissions)
                   OR '*'=ANY(r.permissions))
               )`,[auth.session.tenant_id,auth.session.session_id])
        }
        const items=body.changes.map(x=>({
          id:x.id,beforeHash:x.beforeHash,afterHash:x.afterHash,
        }))
        const promoted=await db.query(
          `INSERT INTO tenant_configuration_promotions(tenant_id,actor_user_id,items,note)
           VALUES($1,$2,$3::jsonb,$4) RETURNING id,promoted_at`,
          [auth.session.tenant_id,auth.session.user_id,JSON.stringify(items),note])
        await recordSecurityEvent({
          db,tenantId:auth.session.tenant_id,actorUserId:auth.session.user_id,
          sessionId:auth.session.session_id,
          eventType:'release.configuration_promoted',
          ipAddress:requestIp(c),userAgent:requestUserAgent(c),
          metadata:{promotionId:promoted.rows[0].id,paths:items.map(x=>x.id)},
        })
        return {id:promoted.rows[0].id,promotedAt:promoted.rows[0].promoted_at,
          count:items.length,items:items.map(x=>x.id)}
      })
      return c.json({promoted:result,productionChanged:true})
    }catch(e){
      return c.json({error:e.message||'Configuration promotion failed.',productionChanged:false},e.status||409)
    }
  })
}
