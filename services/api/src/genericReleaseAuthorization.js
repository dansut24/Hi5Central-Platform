/** Default-DENY generic Dev-release planning authorisations. No writes. */
export const GENERIC_STAGES=Object.freeze(['test','uat','live'])
const SHA=/^[a-f0-9]{40}$/
const valid=value=>value!=null&&Number.isFinite(new Date(value).getTime())

export function authorisedGenericReleaseStage({approval,sha,stage,now=new Date()}={}){
 if(!SHA.test(String(sha||''))||!GENERIC_STAGES.includes(stage))
  return {allowed:false,reason:'Invalid immutable release SHA or environment.'}
 if(approval?.build_sha!==sha||approval?.environment!==stage
   ||approval.planning_enabled!==true||!approval.approved_by
   ||!valid(approval.approved_at)||!valid(approval.expires_at)
   ||!(new Date(approval.approved_at)<=new Date(now)
     &&new Date(now)<new Date(approval.expires_at))
   ||!approval.evidence||typeof approval.evidence!=='object'
   ||Array.isArray(approval.evidence)||Object.keys(approval.evidence).length===0)
   return {allowed:false,reason:'No current staff-approved stage-specific generic planning authorisation.'}
 return {allowed:true,reason:'Approved generic planning scope; worker execution is independently gated.'}
}

export async function readGenericReleaseApprovals(db,{sha}={}){
 if(!SHA.test(String(sha||'')))throw Error('Exact release SHA is required.')
 // Before the additive migration, read-only previews DENY all generic stages.
 const exists=await db.query(
  "SELECT to_regclass('public.platform_release_generic_stage_approvals') AS approvals")
 if(!exists.rows[0]?.approvals)return {}
 const res=await db.query([
  'SELECT build_sha,environment,planning_enabled,execution_enabled,',
  'approved_by,approved_at,expires_at,evidence',
  'FROM platform_release_generic_stage_approvals WHERE build_sha=$1',
 ].join(' '),[sha])
 return Object.fromEntries(res.rows.map(r=>[r.environment,r]))
}
