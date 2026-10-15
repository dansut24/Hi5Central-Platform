import {customerPoolHostname,maintenanceWindowStatus,verifiedRuntimePool} from './runtimePoolPolicy.js'

const checks=['login','navigation','records','mobile']
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const refuse=(message,status=409)=>Object.assign(new Error(message),{status})
export function validateUatAcceptance(value){
  const notes=String(value?.notes||'').trim()
  if(notes.length<20||notes.length>3000)throw refuse('Record 20–3000 characters of UAT test evidence.',400)
  const supplied=Array.isArray(value?.checks)?value.checks:[]
  if(supplied.length!==checks.length||new Set(supplied).size!==checks.length||
    !checks.every(item=>supplied.includes(item)))
    throw refuse('Complete all four UAT acceptance checks.',400)
  return {notes,checks}
}
export function verifiedCustomerRoute({route,pool,offer,slug,now=new Date()}){
  if(!route||route.state!=='active'||route.environment!==offer.environment)
    return {ok:false,reason:'No active host-verified customer route.'}
  if(route.pool_id!==offer.pool_id||route.build_sha!==offer.build_sha||
    pool.id!==offer.pool_id||pool.build_sha!==offer.build_sha)
    return {ok:false,reason:'Offer, route and pool builds do not match.'}
  if(route.public_host!==customerPoolHostname(slug,offer.environment))
    return {ok:false,reason:'This route serves a different customer hostname.'}
  const age=now.getTime()-new Date(route.checked_at||'').getTime()
  if(!Number.isFinite(age)||age<0||age>900000)
    return {ok:false,reason:'Public route proof expired; recheck this customer UAT.'}
  const verified=verifiedRuntimePool(pool,now)
  return verified.verified?{ok:true}:{ok:false,reason:verified.reason}
}
export function scheduledPromotionGate({offer,preference,uatOffer,testGate,pool,now=new Date()}){
  if(offer?.environment!=='live'||offer.state!=='scheduled')
    return {allowed:false,reason:'No scheduled Production update.'}
  if(!pool||pool.id!==offer.pool_id||pool.build_sha!==offer.build_sha||
    pool.environment!=='live')
    return {allowed:false,reason:'Production pool revision mismatch.'}
  const healthy=verifiedRuntimePool(pool,now)
  if(!healthy.verified)return {allowed:false,reason:healthy.reason}
  if(offer.update_mode!==preference?.update_mode)
    return {allowed:false,reason:'Update mode changed after scheduling.'}
  if(!offer.maintenance_not_before||
    new Date(offer.maintenance_not_before).getTime()>now.getTime())
    return {allowed:false,reason:'Release start time has not arrived.'}
  const window=maintenanceWindowStatus(preference.maintenance_window,now)
  if(!window.allowed)return {allowed:false,reason:window.reason}
  if(preference.update_mode==='admin_controlled'){
    if(!uatOffer||uatOffer.build_sha!==offer.build_sha||!uatOffer.uat_accepted_at
      ||!['uat_accepted','active'].includes(uatOffer.state))
      return {allowed:false,reason:'Matching customer UAT approval is missing.'}
    return offer.promotion_approved_at&&offer.promotion_approved_by
      ?{allowed:true,reason:'Custom release approved within maintenance window.'}
      :{allowed:false,reason:'Customer approval is missing.'}
  }
  if(preference.update_mode!=='hi5_managed'||preference.live_auto_promote!==true)
    return {allowed:false,reason:'Managed updates are paused.'}
  // Managed tenants have only Test + Live, NEVER a UAT offer.
  if(testGate?.state!=='passed'||testGate.build_sha!==offer.build_sha
    ||Number(testGate.passed_canary_count)<2)
    return {allowed:false,reason:'Platform Test/canary approval is missing.'}
  const hours=Number(preference.live_delay_hours)
  const accepted=new Date(testGate.passed_at||'').getTime()
  if(!Number.isInteger(hours)||hours<0||hours>720||!Number.isFinite(accepted)
    ||accepted>now.getTime()||now.getTime()-accepted<hours*3600000)
    return {allowed:false,reason:'Minimum Managed Test soak/delay has not elapsed.'}
  return {allowed:true,reason:'Managed Test-approved release is inside maintenance window.'}
}
function checkIds(...ids){
  if(!ids.every(id=>uuid.test(String(id||''))))
    throw refuse('Invalid tenant, user or offer reference.',400)
}
export async function acceptTenantUat({db,tenantId,offerId,userId,evidence,now=new Date()}){
  checkIds(tenantId,offerId,userId)
  const accepted=validateUatAcceptance(evidence)
  const sql=[
    'SELECT o.*,t.slug,p.id AS pool_id_verified,p.environment AS pool_environment,',
    'p.build_sha AS pool_build_sha,p.state AS pool_state,p.api_target,p.web_target,',
    'p.verified_at,p.last_seen_at,r.pool_id AS route_pool_id,',
    'r.build_sha AS route_build_sha,r.public_host,r.state AS route_state,',
    'r.environment AS route_environment,r.checked_at',
    'FROM tenant_runtime_update_offers o',
    "JOIN tenants t ON t.id=o.tenant_id AND t.status='active'",
    'JOIN platform_runtime_pools p ON p.id=o.pool_id AND p.environment=o.environment',
    'LEFT JOIN tenant_runtime_route_attestations r',
    'ON r.tenant_id=o.tenant_id AND r.environment=o.environment',
    "WHERE o.id=$1 AND o.tenant_id=$2 AND o.environment='uat' FOR UPDATE OF o",
  ].join(' ')
  const row=(await db.query(sql,[offerId,tenantId])).rows[0]
  if(!row||row.state!=='uat_testing')throw refuse('The UAT update is not currently ready for sign-off.')
  const pool={id:row.pool_id_verified,environment:row.pool_environment,build_sha:row.pool_build_sha,
    state:row.pool_state,api_target:row.api_target,web_target:row.web_target,
    verified_at:row.verified_at,last_seen_at:row.last_seen_at}
  const route={pool_id:row.route_pool_id,build_sha:row.route_build_sha,
    public_host:row.public_host,state:row.route_state,
    environment:row.route_environment,checked_at:row.checked_at}
  const verify=verifiedCustomerRoute({route,pool,offer:row,slug:row.slug,now})
  if(!verify.ok)throw refuse(verify.reason)
  const changed=await db.query([
    "UPDATE tenant_runtime_update_offers SET state='uat_accepted',",
    'uat_accepted_at=$3,uat_accepted_by=$4,acceptance_evidence=$5::jsonb,',
    "notes=$6,updated_at=$3 WHERE id=$1 AND tenant_id=$2 AND state='uat_testing'",
    'RETURNING id,environment,build_sha,state,uat_accepted_at',
  ].join(' '),[offerId,tenantId,now,userId,JSON.stringify(accepted),accepted.notes])
  if(!changed.rowCount)throw refuse('UAT state changed during approval.')
  await db.query([
    'INSERT INTO tenant_runtime_release_events',
    '(tenant_id,offer_id,event_type,actor_user_id,build_sha,details)',
    "VALUES($1,$2,'uat_accepted',$3,$4,$5::jsonb)",
  ].join(' '),[tenantId,offerId,userId,row.build_sha,JSON.stringify(accepted)])
  return changed.rows[0]
}
export async function scheduleTenantLive({db,tenantId,offerId,userId,
  confirmed=false,requestedAt=null,now=new Date()}){
  checkIds(tenantId,offerId)
  if(userId!=null)checkIds(userId)
  const row=(await db.query([
    'SELECT o.*,p.update_mode AS current_mode,p.live_auto_promote,p.live_delay_hours,',
    'p.maintenance_window FROM tenant_runtime_update_offers o',
    'JOIN tenant_release_preferences p ON p.tenant_id=o.tenant_id',
    "WHERE o.id=$1 AND o.tenant_id=$2 AND o.environment='live' FOR UPDATE OF o",
  ].join(' '),[offerId,tenantId])).rows[0]
  if(!row||row.state!=='offered')throw refuse('No unscheduled Production offer for this customer.')
  if(row.update_mode!==row.current_mode)throw refuse('Update preference changed; request a new offer.')
  // Two independent gates: Custom requires its own UAT acceptance;
  // Managed requires a platform Test/canary signoff instead of any UAT row.
  let accepted=null,testGate=null
  if(row.update_mode==='admin_controlled'){
    accepted=(await db.query([
      'SELECT build_sha,uat_accepted_at FROM tenant_runtime_update_offers',
      "WHERE tenant_id=$1 AND environment='uat' AND build_sha=$2",
      "AND state IN ('uat_accepted','active') AND uat_accepted_at IS NOT NULL",
      'ORDER BY uat_accepted_at DESC LIMIT 1',
    ].join(' '),[tenantId,row.build_sha])).rows[0]
    if(!accepted)throw refuse('The same build must be accepted in customer UAT first.')
  }else if(row.update_mode==='hi5_managed'){
    testGate=(await db.query([
      'SELECT build_sha,state,passed_at,passed_canary_count',
      'FROM platform_release_test_qa_gates',
      "WHERE build_sha=$1 AND state='passed' AND passed_canary_count>=2",
    ].join(' '),[row.build_sha])).rows[0]
    if(!testGate)throw refuse('A verified platform Test/canary quality gate is required.')
  }else throw refuse('Unknown tenant update mode.')
  const pool=(await db.query('SELECT * FROM platform_runtime_pools WHERE id=$1 AND environment=$2',
    [row.pool_id,'live'])).rows[0]
  if(!pool||pool.build_sha!==row.build_sha||!verifiedRuntimePool(pool,now).verified)
    throw refuse('A healthy verified Production pool for this exact build is required.')
  const published=await db.query('SELECT 1 FROM hi5central_published_release_notes WHERE build_sha=$1',[row.build_sha])
  if(!published.rowCount)throw refuse('Hi5Central has not published the application release.')
  let start=now,approver=null
  if(row.update_mode==='admin_controlled'){
    if(!userId||confirmed!==true)throw refuse('Customer must explicitly approve the Production update.',400)
    if(requestedAt!=null){
      start=new Date(requestedAt)
      if(!Number.isFinite(start.getTime())||start.getTime()<now.getTime()||
        start.getTime()>now.getTime()+90*86400000)
        throw refuse('Choose a time in the next 90 days.',400)
    }
    approver=userId
  }else{
    if(row.live_auto_promote!==true)throw refuse('Managed automatic updates are disabled.')
    const hours=Number(row.live_delay_hours)
    if(!Number.isInteger(hours)||hours<0||hours>720)throw refuse('Invalid managed release delay.')
    start=new Date(Math.max(now.getTime(),
      new Date(testGate.passed_at).getTime()+hours*3600000))
  }
  const updated=await db.query([
    "UPDATE tenant_runtime_update_offers SET state='scheduled',",
    'maintenance_not_before=$3,promotion_approved_at=$4,promotion_approved_by=$5,updated_at=$6',
    "WHERE id=$1 AND tenant_id=$2 AND state='offered'",
    'RETURNING id,environment,build_sha,state,maintenance_not_before',
  ].join(' '),[offerId,tenantId,start,approver?now:null,approver,now])
  if(!updated.rowCount)throw refuse('Offer state changed during scheduling.')
  await db.query([
    'INSERT INTO tenant_runtime_release_events',
    '(tenant_id,offer_id,event_type,actor_user_id,build_sha,details)',
    "VALUES($1,$2,'production_scheduled',$3,$4,$5::jsonb)",
  ].join(' '),[tenantId,offerId,approver,row.build_sha,
    JSON.stringify({mode:row.update_mode,notBefore:start.toISOString(),hostActivation:false})])
  return updated.rows[0]
}
