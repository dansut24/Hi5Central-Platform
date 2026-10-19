/**
 * Staff-reviewed rollback gates. No action here can deploy images, change
 * Caddy, create a customer request, or impersonate a customer administrator.
 * The staff actor is supplied by the existing central auth session ONLY.
 */
const SHA=/^[a-f0-9]{40}$/
const DIGEST=/^[a-f0-9]{64}$/
const SLUG=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/
const deny=(message,status=400)=>Object.assign(new Error(message),{status})
function reason(value){
 if(typeof value!=='string'||value.trim().length<20||value.trim().length>500)
  throw deny('Explain the exact compatibility or executor review in 20–500 characters.')
 return value.trim()
}
function expiry(value){
 if(!Number.isSafeInteger(value)||value<1||value>24)
  throw deny('Review expiry must be an integer between 1 and 24 hours.')
 return value
}
export function reviewedRollbackCompatibilityRequest(body){
 if(!body||body.confirm!=='APPROVE_EXACT_CUSTOM_ROLLBACK_COMPATIBILITY'
   ||!SLUG.test(String(body.tenantSlug||''))
   ||!SHA.test(String(body.sourceBuildSha||''))
   ||!SHA.test(String(body.targetBuildSha||''))
   ||body.sourceBuildSha===body.targetBuildSha)
   throw deny('The exact Custom tenant and distinct original/target release SHAs must be confirmed.')
 const evidence=body.evidence||{}
 if(evidence.schemaChecked!==true||evidence.previousImagePulled!==true
   ||evidence.recoveryTestPassed!==true
   ||!DIGEST.test(String(evidence.previousSnapshotSha256||''))
   ||!DIGEST.test(String(evidence.restoredRouteSha256||''))
   ||!Number.isSafeInteger(evidence.qaRunId)||evidence.qaRunId<1)
   throw deny('Attach verified backward-schema, immutable image, gateway restoration and QA evidence.')
 return {tenantSlug:body.tenantSlug,sourceSha:body.sourceBuildSha,
  targetSha:body.targetBuildSha,reason:reason(body.reason),
  expiresHours:expiry(body.expiresHours),evidence:{
   schemaChecked:true,previousImagePulled:true,recoveryTestPassed:true,
   previousSnapshotSha256:evidence.previousSnapshotSha256,
   restoredRouteSha256:evidence.restoredRouteSha256,qaRunId:evidence.qaRunId,
  }}
}
export function reviewedRollbackExecutorRequest(body){
 if(!body||body.confirm!=='CERTIFY_EXACT_CUSTOM_ROLLBACK_EXECUTOR'
   ||!SHA.test(String(body.revisionSha||'')))
   throw deny('Review and explicitly confirm the exact immutable rollback worker revision.')
 const proof=body.evidence||{}
 if(proof.independentHostTest!==true||proof.customerIsolationTest!==true
   ||!Number.isSafeInteger(proof.qaRunId)||proof.qaRunId<1
   ||!SHA.test(String(proof.testedRevisionSha||''))
   ||proof.testedRevisionSha!==body.revisionSha)
   throw deny('Independent host crash-recovery and tenant-isolation evidence must match the exact revision.')
 for(const field of [
  'gatewayFenceTested','restrictedRoleTested','customerOnlyRouteTested',
  'failureCompensationTested','publicVersionVerified','auditCompletionTested',
 ]){
  if(body[field]!==true)throw deny('Executor review missing independently verified '+field)
 }
 return {revisionSha:body.revisionSha,
  reason:reason(body.reason),expiresHours:expiry(body.expiresHours),
  evidence:{independentHostTest:true,customerIsolationTest:true,
   qaRunId:proof.qaRunId,testedRevisionSha:proof.testedRevisionSha}}
}
export async function reviewRollbackCompatibility(db,review,actorId){
 const tenants=await db.query([
  'SELECT t.id,t.slug FROM tenants t',
  'JOIN tenant_release_preferences p ON p.tenant_id=t.id',
  "WHERE t.slug=$1 AND t.status='active' AND p.update_mode='admin_controlled'",
 ],[review.tenantSlug])
 if(tenants.rowCount!==1)throw deny('Staff cannot approve rollback for a non-Custom or inactive tenant.',409)
 const jobs=await db.query([
  'SELECT j.id FROM tenant_release_rollout_jobs j',
  "WHERE j.tenant_id=$1 AND j.environment='live' AND j.status='succeeded'",
  'AND j.build_sha=$2 AND j.previous_build_sha=$3',
  'AND EXISTS(SELECT 1 FROM tenant_release_rollout_events e',
  " WHERE e.job_id=j.id AND e.event_type='verified'",
  " AND e.details->>'previousSha'=j.previous_build_sha",
  " AND length(e.details->>'backup')>20) ORDER BY j.completed_at DESC LIMIT 1",
 ].join(' '),[tenants.rows[0].id,review.sourceSha,review.targetSha])
 if(jobs.rowCount!==1)throw deny('A real host-verified original Custom Production job is mandatory.',409)
 const result=await db.query([
  'INSERT INTO platform_release_rollback_compatibility',
  '(from_build_sha,to_build_sha,state,schema_backward_compatible,',
  'immutable_images_verified,recovery_snapshot_verified,',
  'reviewed_by,reviewed_at,expires_at,evidence,reason)',
  "VALUES($1,$2,'approved',true,true,true,$3,now(),now()+($4*interval '1 hour'),$5::jsonb,$6)",
  'ON CONFLICT(from_build_sha,to_build_sha) DO UPDATE SET',
  "state='approved',schema_backward_compatible=true,immutable_images_verified=true,",
  'recovery_snapshot_verified=true,reviewed_by=excluded.reviewed_by,',
  'reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,',
  'evidence=excluded.evidence,reason=excluded.reason',
  "WHERE platform_release_rollback_compatibility.state IN ('blocked','revoked')",
  'RETURNING from_build_sha,to_build_sha,expires_at',
 ].join(' '),[review.sourceSha,review.targetSha,actorId,
  review.expiresHours,JSON.stringify({...review.evidence,
   tenantSlug:review.tenantSlug,originalReleaseJobId:jobs.rows[0].id}),
  review.reason])
 if(result.rowCount!==1)throw deny('Current approved compatibility requires explicit revocation before a new review.',409)
 return {...result.rows[0],tenantSlug:review.tenantSlug,
  originalReleaseJobId:jobs.rows[0].id}
}
export async function reviewRollbackExecutor(db,review,actorId){
 const result=await db.query([
  'INSERT INTO platform_release_customer_rollback_executor_certifications',
  '(revision_sha,state,worker_role,gateway_fence_tested,restricted_role_tested,',
  'customer_only_route_tested,failure_compensation_tested,',
  'public_version_verified,audit_completion_tested,reviewed_by,reviewed_at,',
  'expires_at,reason,evidence)',
  "VALUES($1,'approved','hi5_release_rollback_executor',true,true,true,true,true,true,",
  "$2,now(),now()+($3*interval '1 hour'),$4,$5::jsonb)",
  'ON CONFLICT(revision_sha) DO UPDATE SET',
  "state='approved',gateway_fence_tested=true,restricted_role_tested=true,",
  'customer_only_route_tested=true,failure_compensation_tested=true,',
  'public_version_verified=true,audit_completion_tested=true,',
  'reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,',
  'expires_at=excluded.expires_at,reason=excluded.reason,evidence=excluded.evidence',
  "WHERE platform_release_customer_rollback_executor_certifications.state IN ('blocked','revoked')",
  'RETURNING revision_sha,expires_at',
 ].join(' '),[review.revisionSha,actorId,review.expiresHours,
  review.reason,JSON.stringify(review.evidence)])
 if(result.rowCount!==1)throw deny('An approved worker revision must be revoked before re-certification.',409)
 return result.rows[0]
}
export function reviewedRollbackRevocation(body){
 if(!body||body.confirm!=='REVOKE_CUSTOM_PRODUCTION_ROLLBACK_REVIEW'
    ||!['compatibility','executor'].includes(body.type))
  throw deny('Confirm which exact rollback approval must be revoked.')
 if(body.type==='compatibility'
   &&(!SHA.test(String(body.sourceBuildSha||''))
     ||!SHA.test(String(body.targetBuildSha||''))))
  throw deny('The exact rollback SHA pair is mandatory.')
 if(body.type==='executor'&&!SHA.test(String(body.revisionSha||'')))
  throw deny('The exact worker revision SHA is mandatory.')
 return {type:body.type,sourceSha:body.sourceBuildSha,
  targetSha:body.targetBuildSha,revisionSha:body.revisionSha,
  reason:reason(body.reason)}
}
