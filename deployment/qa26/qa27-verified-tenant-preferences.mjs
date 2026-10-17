#!/usr/bin/env node
/**
 * Narrow one-time QA27 preference repair for four correctly registered
 * and verified test customers. An empty maintenance days array means no
 * permitted day at all. Keep their selected UK 02:00-05:00 hours; use the
 * same seven-day QA release window as the existing QA managed/custom pairs.
 *
 * This adjusts only update preferences, not credentials, tenant membership,
 * ITSM records, UAT/Test rows, Caddy, queue, scope approval, or rollout pause.
 * Run with --dry-run (default) and then --apply only against paused VPS.
 */
import pg from 'pg'
const slugs=['h5c-managed-rmm-qa27','qa27-custom-rmm-qa27',
 'qa27-managed-itsm-qa27','qa27-custom-itsm-qa27']
const want={
 'h5c-managed-rmm-qa27':{mode:'hi5_managed',rmm:true},
 'qa27-custom-rmm-qa27':{mode:'admin_controlled',rmm:true},
 'qa27-managed-itsm-qa27':{mode:'hi5_managed',rmm:false},
 'qa27-custom-itsm-qa27':{mode:'admin_controlled',rmm:false},
}
const validDays=['mon','tue','wed','thu','fri','sat','sun']
const mode=process.argv.at(-1)==='--apply'?'apply':
 process.argv.at(-1)==='--dry-run'?'dry-run':'invalid'
if(mode==='invalid'||!process.env.DATABASE_URL)
 throw Error('Use --dry-run or --apply with an authorised PostgreSQL connection.')
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
 connectionTimeoutMillis:6500})
try{
 await db.connect()
 await db.query('BEGIN')
 await db.query("SET LOCAL lock_timeout='900ms'")
 await db.query("SET LOCAL statement_timeout='15000ms'")
 const rollout=(await db.query(
  'SELECT paused FROM platform_release_rollout_control WHERE singleton=true FOR SHARE')).rows[0]
 if(rollout?.paused!==true)throw Error('Fleet rollout must remain paused.')
 const active=await db.query(
  "SELECT count(*)::int AS n FROM tenant_release_rollout_jobs WHERE status='running'")
 if(active.rows[0]?.n!==0)throw Error('Deployment worker currently active.')
 const result=await db.query([
  'SELECT t.id,t.slug,t.status,t.created_at,s.modules,',
  's.onboarding_completed_at,p.update_mode,p.maintenance_window,',
  'p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote',
  'FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  'WHERE t.slug=ANY($1::text[])',
  'ORDER BY t.slug FOR UPDATE OF p',
 ].join(' '),[slugs])
 if(result.rowCount!==4)throw Error('Exactly four normally registered QA27 tenants are required.')
 const report=[]
 for(const t of result.rows){
  const expected=want[t.slug]
  if(!expected||t.status!=='active'||!t.onboarding_completed_at
    ||t.update_mode!==expected.mode||t.modules?.itsm!==true
    ||Boolean(t.modules?.rmm)!==expected.rmm||t.test_auto_sync!==true
    ||t.live_auto_promote!==(expected.mode==='hi5_managed'))
   throw Error('Unexpected QA tenant module, onboarding or update mode: '+t.slug)
  const w=t.maintenance_window
  if(w?.start!=='02:00'||w?.end!=='05:00'||w?.timezone!=='Europe/London'
   ||!Array.isArray(w?.days)||w.days.length!==0)
   throw Error('QA tenant window was changed or has already been corrected: '+t.slug)
  const verified=await db.query([
   'SELECT count(*)::int AS n FROM tenant_memberships m',
   'JOIN users u ON u.id=m.user_id',
   "WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'",
   'AND u.email_verified_at IS NOT NULL',
  ].join(' '),[t.id])
  if(verified.rows[0]?.n<1)
   throw Error('QA tenant active verified owner missing: '+t.slug)
  const changes={maintenanceWindow:{
   ...w,days:validDays},uatAutoStage:expected.mode==='admin_controlled'}
  if(mode==='apply'){
   const update=await db.query([
    'UPDATE tenant_release_preferences',
    'SET maintenance_window=$2::jsonb,uat_auto_stage=$3,updated_at=now()',
    'WHERE tenant_id=$1 AND update_mode=$4',
    'RETURNING tenant_id',
   ].join(' '),[t.id,JSON.stringify(changes.maintenanceWindow),
    changes.uatAutoStage,t.update_mode])
   if(update.rowCount!==1)throw Error('QA preference CAS changed: '+t.slug)
   await db.query([
    'INSERT INTO platform_admin_audit_events',
    '(actor_user_id,action,target_type,target_id,metadata)',
    "VALUES(NULL,'qa27.release_preferences_normalised','tenant',$1,$2::jsonb)",
   ].join(' '),[t.id,JSON.stringify({source:'reviewed-QA-operator',
    tenantSlug:t.slug,previous:{maintenanceWindow:w,
     uatAutoStage:t.uat_auto_stage},
    next:changes,noGatewayChanges:true,globalPausePreserved:true})])
  }
  report.push({slug:t.slug,mode:t.update_mode,rmm:expected.rmm,
   previousDays:w.days.length,days:validDays.length,
   uatAutoStage:changes.uatAutoStage})
 }
 if(mode==='apply')await db.query('COMMIT')
 else await db.query('ROLLBACK')
 console.log(JSON.stringify({audit:'H5C_QA27_PREFERENCES_V1',mode,
  committed:mode==='apply',globallyPaused:true,activeDeploymentJobs:0,
  tenantCount:report.length,notTouched:[
   'passwords','membership','billing','RMM devices','live routes','rollout approvals'],
  tenants:report},null,2))
}catch(error){
 await db.query('ROLLBACK').catch(()=>{})
 console.error('QA27_PREFERENCES_BLOCKED',String(error.message).slice(0,220))
 process.exitCode=1
}finally{await db.end()}
