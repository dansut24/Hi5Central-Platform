/**
 * Platform Admin planning-only generic release control.
 * A browser/API action here NEVER grants execution, starts a worker, unpauses
 * the fleet or removes Custom tenant-UAT approval. PostgreSQL trigger audits
 * changes independently from HTTP audit events.
 */
import {GENERIC_STAGES} from './genericReleaseAuthorization.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const refuse=message=>Object.assign(new Error(message),{code:'GENERIC_RELEASE_ADMIN_REFUSED'})
export function validatedGenericPlanningRequest({sha,body,actorId}={}){
 if(!SHA.test(String(sha||''))||!UUID.test(String(actorId||'')))
  throw refuse('Exact certified revision and authenticated platform staff required.')
 if(!body||typeof body!=='object'||Array.isArray(body)
    ||!GENERIC_STAGES.includes(body.environment)
    ||body.confirmation!=='AUTHORISE_PLANNING_ONLY')
  throw refuse('Explicit environment and planning-only confirmation required.')
 // Never accept an execution approval through this endpoint, even if the
 // request includes extra undocumented fields.
 if(Object.hasOwn(body,'executionEnabled')||Object.hasOwn(body,'execution_enabled')
    ||Object.hasOwn(body,'unpause')||Object.hasOwn(body,'deployNow'))
  throw refuse('Execution/worker changes require a different reviewed certification.')
 const hours=Number(body.expiresInHours)
 const reason=String(body.reason||'').trim()
 const reviewedChange=String(body.reviewedChange||'').trim()
 if(!Number.isInteger(hours)||hours<1||hours>72
  ||reason.length<20||reason.length>500
  ||reviewedChange.length<8||reviewedChange.length>200)
  throw refuse('Time-limited approval needs a meaningful reason and reviewed change reference.')
 return {sha,environment:body.environment,approvedBy:actorId,expiresInHours:hours,
  reason,reviewedChange}
}

export async function approveGenericPlanningOnly(db,request){
 const params=validatedGenericPlanningRequest(request)
 const release=await db.query([
  'SELECT c.build_sha FROM platform_certified_application_releases c',
  'JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
  "WHERE c.build_sha=$1 AND c.status='approved' AND c.approved_by IS NOT NULL",
  'AND c.evidence @> $2::jsonb',
 ].join(' '),[params.sha,JSON.stringify({
  build:true,ci:true,security:true,migrations:true,smoke:true,
 })])
 if(release.rowCount!==1)throw refuse('Release is not independently certified and published.')
 const result=await db.query([
  'INSERT INTO platform_release_generic_stage_approvals',
  '(build_sha,environment,planning_enabled,execution_enabled,',
  'approved_by,approved_at,expires_at,evidence,reason)',
  "VALUES($1,$2,true,false,$3,now(),now()+make_interval(hours=>$4::int),$5::jsonb,$6)",
  'ON CONFLICT(build_sha,environment) DO UPDATE SET',
  'planning_enabled=true,execution_enabled=false,',
  'approved_by=excluded.approved_by,approved_at=excluded.approved_at,',
  'expires_at=excluded.expires_at,evidence=excluded.evidence,',
  'reason=excluded.reason,updated_at=now()',
  'RETURNING build_sha,environment,planning_enabled,execution_enabled,expires_at',
 ].join(' '),[params.sha,params.environment,params.approvedBy,params.expiresInHours,
  JSON.stringify({reviewedChange:params.reviewedChange,planningOnly:true}),params.reason])
 if(result.rowCount!==1)throw refuse('Generic planning approval did not persist.')
 return result.rows[0]
}

export async function revokeGenericStageApproval(db,{sha,stage,actorId}={}){
 if(!SHA.test(String(sha||''))||!GENERIC_STAGES.includes(stage)
    ||!UUID.test(String(actorId||'')))
  throw refuse('Invalid reviewed stage revocation.')
 const result=await db.query([
  'UPDATE platform_release_generic_stage_approvals',
  'SET planning_enabled=false,execution_enabled=false,',
  'approved_by=$3,updated_at=now(),reason=$4',
  'WHERE build_sha=$1 AND environment=$2',
  'RETURNING build_sha,environment,planning_enabled,execution_enabled',
 ].join(' '),[sha,stage,actorId,'Platform administrator revoked both planning and execution'])
 return result.rows[0]||{build_sha:sha,environment:stage,
  planning_enabled:false,execution_enabled:false,alreadyRevoked:true}
}
