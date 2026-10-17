import {nextTenantMaintenanceWindow} from './releaseRolloutPlanner.js'
import {enqueueReleasePlans,activateNextPendingRollout} from './tenantReleaseQueue.js'
import {parseQaReleaseTenantSlugs} from './releaseQaCohort.js'
import {readGenericReleaseApprovals,authorisedGenericReleaseStage,GENERIC_STAGES} from './genericReleaseAuthorization.js'

const SHA=/^[a-f0-9]{40}$/
const allowedStages=new Set(['test','uat','live'])
const elapsed=at=>{const ms=new Date(at||'').getTime();return Number.isFinite(ms)?ms:null}
const maxDate=(...values)=>new Date(Math.max(...values.map(value=>
  value instanceof Date?value.getTime():elapsed(value)??NaN)))
const fail=message=>Object.assign(new Error(message),{code:'RELEASE_FANOUT_BLOCKED'})

/**
 * Pure policy gate. A release is planned by stage and not routed until the
 * trusted worker actually validates its target and the current tenant window.
 * A Custom customer can NEVER enter live without a matching, recorded tenant
 * admin's approval. Managed must have the platform 2-canary Test gate.
 */
export function nextCustomerReleaseStage({
  tenant,sha,publishedAt,approvedAt,jobs=[],gate=null,liveOffer=null,
  uatOffer=null,testSoakMinutes=30,now=new Date(),
}={}){
  if(!SHA.test(String(sha||''))||tenant?.status!=='active'
    ||tenant?.itsm!==true||!['hi5_managed','admin_controlled'].includes(tenant?.mode))
    return {stage:null,reason:'Not an active subscribed ITSM tenant with a valid update model.'}
  if(!Number.isInteger(testSoakMinutes)||testSoakMinutes<2||testSoakMinutes>10080)
    return {stage:null,reason:'Release Test soak policy is invalid.'}
  const releaseAt=maxDate(publishedAt,approvedAt)
  if(!Number.isFinite(releaseAt.getTime()))
    return {stage:null,reason:'Release has no valid approval and publication timestamps.'}
  const get=env=>jobs.find(j=>j.environment===env&&j.build_sha===sha)
  const test=get('test')
  if(!test){
    if(!tenant.testAutoSync)return {stage:null,reason:'Tenant has disabled automatic Test releases.'}
    return {stage:'test',notBefore:releaseAt,reason:'First automatic Test rollout.'}
  }
  if(test.status!=='succeeded'||!elapsed(test.completed_at))
    return {stage:null,reason:'Exact Test release must be verified before advancing.'}
  const soaked=maxDate(releaseAt,
    new Date(new Date(test.completed_at).getTime()+testSoakMinutes*60000))
  if(tenant.mode==='admin_controlled'){
    const uat=get('uat')
    if(!uat){
      if(!tenant.uatAutoStage)return {stage:null,reason:'Automatic UAT updates disabled.'}
      return {stage:'uat',notBefore:soaked,reason:'Custom UAT after Test and soak.'}
    }
    if(uat.status!=='succeeded'||!elapsed(uat.completed_at))
      return {stage:null,reason:'Custom UAT deployment must succeed before customer approval.'}
    if(get('live'))return {stage:null,reason:'Custom Production already has a release job.'}
    if(!uatOffer||uatOffer.build_sha!==sha
      ||!['uat_accepted','active'].includes(uatOffer.state)
      ||!uatOffer.uat_accepted_at||!uatOffer.uat_accepted_by)
      return {stage:null,reason:'Matching customer UAT acceptance is required.'}
    if(!liveOffer||liveOffer.build_sha!==sha
      ||liveOffer.state!=='scheduled'||!liveOffer.promotion_approved_at
      ||!liveOffer.promotion_approved_by||!liveOffer.maintenance_not_before)
      return {stage:null,reason:'Customer has not explicitly scheduled this Production release.'}
    return {stage:'live',
      notBefore:maxDate(soaked,uat.completed_at,liveOffer.promotion_approved_at,
        liveOffer.maintenance_not_before),
      reason:'Explicitly approved Custom Production after verified UAT.'}
  }
  if(get('live'))return {stage:null,reason:'Managed Production release already has a job.'}
  if(!tenant.liveAutoPromote)
    return {stage:null,reason:'Managed auto-promotion is disabled.'}
  if(gate?.state!=='passed'||gate.build_sha!==sha
    ||Number(gate.passed_canary_count)<2||!elapsed(gate.passed_at))
    return {stage:null,reason:'Two-customer platform Test quality gate not approved.'}
  const hours=Number(tenant.liveDelayHours)
  if(!Number.isInteger(hours)||hours<0||hours>720)
    return {stage:null,reason:'Managed release delay is invalid.'}
  return {stage:'live',notBefore:maxDate(soaked,
    new Date(new Date(gate.passed_at).getTime()+hours*3600000)),
    reason:'Managed Production after platform Test approval and tenant delay.'}
}

export function scheduledCustomerRelease({decision,tenant,sha,now=new Date(),
  expectedDurationMinutes=15}={}){
  if(!decision?.stage||!allowedStages.has(decision.stage))
    return {status:'blocked',reason:decision?.reason||'Not eligible.'}
  const window=nextTenantMaintenanceWindow({
    policy:tenant.maintenance,blackouts:tenant.blackouts||[],now,
    notBefore:decision.notBefore,durationMinutes:expectedDurationMinutes,
    // Planning is permitted while globally paused; execution still isn't.
    minLeadMinutes:5,
  })
  if(!window.ok)return {status:'blocked',reason:window.reason}
  return {status:'scheduled',tenantId:tenant.id,stage:decision.stage,
    scheduledAt:window.scheduledAt,buildSha:sha,
    expectedDurationMinutes,reason:decision.reason}
}

/**
 * Run inside ONE transaction. The transaction advisory lock prevents two
 * publisher/scheduler instances from double-planning a release cohort.
 * Unique per-tenant+env+SHA job identity survives process restarts.
 * No Docker, Caddy, production route change or employee approval here.
 */
export async function fanoutCertifiedRelease(db,{
  sha,now=new Date(),limit=200,testSoakMinutes=30,qaTenantSlugs=null,scope='qa',
}={}){
  if(!SHA.test(String(sha||''))||!Number.isInteger(limit)||limit<1||limit>2000)
    throw fail('Exact immutable revision and bounded tenant batch required.')
  if(!['qa','generic'].includes(scope))throw fail('Unknown release planner scope.')
  // QA keeps its frozen explicit allowlist. General discovery is deliberately
  // separate and only occurs with fresh staff-approved per-stage DB scope.
  const allowlist=scope==='qa'
    ?parseQaReleaseTenantSlugs(Array.isArray(qaTenantSlugs)?qaTenantSlugs.join(','):'')
    :null
  let genericStagePermissions=null
  if(scope==='generic'){
    const approvals=await readGenericReleaseApprovals(db,{sha})
    genericStagePermissions=Object.fromEntries(GENERIC_STAGES.map(stage=>[
      stage,authorisedGenericReleaseStage({approval:approvals[stage],sha,stage,now})]))
    if(!GENERIC_STAGES.some(stage=>genericStagePermissions[stage].allowed))
      throw fail('No explicit staff-approved generic release planning stage; refusing all writes.')
  }
  const lock=await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',
    ['hi5central-certified-release-fanout',sha])
  if(!lock.rows[0]?.locked)return {locked:true,queued:0,blocked:0}
  const releases=await db.query([
    'SELECT c.build_sha,c.status,c.approved_at,c.evidence,',
    'n.published_at,n.version_label',
    'FROM platform_certified_application_releases c',
    'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
    "WHERE c.build_sha=$1 AND c.status='approved' AND c.approved_by IS NOT NULL",
    'AND c.evidence @> $2::jsonb',
    'FOR SHARE OF c',
  ].join(' '),[sha,JSON.stringify({
    build:true,ci:true,security:true,migrations:true,smoke:true,
  })])
  if(!releases.rowCount)throw fail('A human-approved, checked and published official release is required.')
  const release=releases.rows[0]
  const tenantsSql=[
    'SELECT t.id,t.slug,t.status,p.update_mode AS mode,',
    'p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,',
    'p.live_delay_hours,p.maintenance_window,p.blackout_periods,',
    "COALESCE((ts.modules->>'itsm')::boolean,false) AS itsm",
    'FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id',
    'JOIN tenant_settings ts ON ts.tenant_id=t.id',
    "WHERE t.status='active' AND ts.onboarding_completed_at IS NOT NULL",
    "AND COALESCE((ts.modules->>'itsm')::boolean,false)=true",
    'AND ($3::text[] IS NULL OR t.slug=ANY($3::text[]))',
    ...(scope==='generic'?["AND public.hi5_release_generic_tenant_permitted(t.id)=true"]:[]),
    "AND t.id > COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",
    'ORDER BY t.id LIMIT $1',
  ].join(' ')
  // Automatic quality signoff uses only DESIGNATED real customer Test jobs
  // with a host-verified event, a complete soak and separate staff certification.
  const canaries=await db.query([
    'SELECT j.id,j.tenant_id,j.completed_at FROM tenant_release_rollout_jobs j',
    'JOIN platform_release_canary_tenants c ON c.tenant_id=j.tenant_id AND c.enabled=true',
    'JOIN tenants t ON t.id=j.tenant_id',
    "WHERE j.environment='test' AND j.build_sha=$1 AND j.status='succeeded'",
    'AND ($4::text[] IS NULL OR t.slug=ANY($4::text[]))',
    'AND j.completed_at IS NOT NULL',
    "AND j.completed_at <= ($2::timestamptz - make_interval(mins=>$3::int))",
    'AND EXISTS (SELECT 1 FROM tenant_release_rollout_events e',
    "WHERE e.job_id=j.id AND e.event_type='verified' AND e.fence=j.lease_fence)",
    'ORDER BY j.completed_at DESC LIMIT 10000',
  ].join(' '),[sha,now,testSoakMinutes,allowlist])
  const designated=[...new Map(canaries.rows.map(j=>[j.tenant_id,j])).values()]
  if(designated.length>=2){
    if(scope==='generic'){
      // Generic unattended planner has EXECUTE on one verified DB procedure,
      // NEVER direct INSERT/UPDATE on the cross-tenant QA gate. The function
      // independently checks immutable fenced canary evidence and real soak.
      await db.query(
        'SELECT public.hi5_release_record_verified_test_gate($1,$2) AS recorded',
        [sha,testSoakMinutes])
    }else{
      // Legacy explicitly allowlisted QA path retained until separate retirement.
      const evidence={automatic:true,source:'two-verified-designated-test-canaries',
        certifiedReleaseSha:sha,testSoakMinutes,verifiedJobIds:designated.map(j=>j.id),
        verifiedTenantIds:designated.map(j=>j.tenant_id)}
      await db.query([
        'INSERT INTO platform_release_test_qa_gates',
        '(build_sha,state,passed_canary_count,passed_at,accepted_by,evidence)',
        "VALUES($1,'passed',$2,$3,NULL,$4::jsonb)",
        'ON CONFLICT(build_sha) DO NOTHING',
      ].join(' '),[sha,designated.length,now,JSON.stringify(evidence)])
    }
  }
  const qa=await db.query('SELECT * FROM platform_release_test_qa_gates WHERE build_sha=$1',[sha])
  const gate=qa.rows[0]||null
  const report={releaseSha:sha,scope,scanned:0,queued:0,alreadyQueued:0,blocked:0,reasons:[]}
  let tenantCursor=null
  for(;;){
    const tenants=await db.query(tenantsSql,[limit,tenantCursor,allowlist])
    if(!tenants.rows.length)break
    for(const row of tenants.rows){
    report.scanned++
    const tenant={
      id:row.id,status:row.status,mode:row.mode,itsm:row.itsm,
      testAutoSync:row.test_auto_sync,uatAutoStage:row.uat_auto_stage,
      liveAutoPromote:row.live_auto_promote,liveDelayHours:row.live_delay_hours,
      maintenance:row.maintenance_window,blackouts:row.blackout_periods,
    }
    const jobs=(await db.query([
      'SELECT environment,build_sha,status,completed_at FROM tenant_release_rollout_jobs',
      'WHERE tenant_id=$1 AND build_sha=$2',
    ].join(' '),[row.id,sha])).rows
    const offers=(await db.query([
      'SELECT environment,build_sha,state,uat_accepted_at,uat_accepted_by,',
      'promotion_approved_at,promotion_approved_by,maintenance_not_before',
      'FROM tenant_runtime_update_offers WHERE tenant_id=$1 AND build_sha=$2',
    ].join(' '),[row.id,sha])).rows
    const decision=nextCustomerReleaseStage({
      tenant,sha,publishedAt:release.published_at,approvedAt:release.approved_at,
      jobs,gate,uatOffer:offers.find(x=>x.environment==='uat'),
      liveOffer:offers.find(x=>x.environment==='live'),testSoakMinutes,now,
    })
    const plan=scheduledCustomerRelease({decision,tenant,sha,now})
    if(plan.status==='scheduled'&&scope==='generic'
      &&!genericStagePermissions[plan.stage]?.allowed){
      report.blocked++
      if(report.reasons.length<20)report.reasons.push({slug:row.slug,
        reason:'Generic '+plan.stage+' scheduling has no current staff approval.'})
      continue
    }
    if(plan.status!=='scheduled'){
      report.blocked++
      if(report.reasons.length<20)report.reasons.push({slug:row.slug,reason:plan.reason})
      continue
    }
    const rows=await enqueueReleasePlans(db,{plans:[plan],releaseRef:'release-'+sha.slice(0,12)})
    if(rows[0]?.reused){report.alreadyQueued++;continue}
    const activated=await activateNextPendingRollout(db,{
      tenantId:tenant.id,environment:plan.stage,
    })
    if(!activated.activated && activated.reason==='No queued rollout for this tenant/environment.')
      throw fail('New release job was not durably recorded.')
    report.queued++
  }
    tenantCursor=tenants.rows[tenants.rows.length-1].id
    if(tenants.rows.length<limit)break
  }
  await db.query([
    'INSERT INTO platform_release_fanout_checkpoints',
    '(build_sha,last_scan_at,last_tenant_count,last_queued_count,last_blocked_count,last_error)',
    "VALUES($1,now(),$2,$3,$4,'')",
    'ON CONFLICT(build_sha) DO UPDATE SET',
    'last_scan_at=excluded.last_scan_at,last_tenant_count=excluded.last_tenant_count,',
    'last_queued_count=excluded.last_queued_count,last_blocked_count=excluded.last_blocked_count,',
    "last_error=''",
  ].join(' '),[sha,report.scanned,report.queued,report.blocked])
  await db.query([
    'INSERT INTO platform_release_fanout_events(build_sha,event_type,details)',
    "VALUES($1,'scan',$2::jsonb)",
  ].join(' '),[sha,JSON.stringify({
    scanned:report.scanned,queued:report.queued,alreadyQueued:report.alreadyQueued,
    blocked:report.blocked,scope,
  })])
  return report
}
