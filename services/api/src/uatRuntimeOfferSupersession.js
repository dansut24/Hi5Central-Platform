/**
 * Finalise a host-verified Custom UAT upgrade without colliding with an
 * existing accepted/testing offer for the previous UAT revision.
 *
 * Run inside the same stage-restricted transaction as the verified
 * assignment, fresh route attestation and replacement offer. Never touch
 * Production offers or erase historic UAT acceptance evidence.
 */
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const SHA=/^[a-f0-9]{40}$/
export async function retireSupersededUatOffers(db,{tenantId,buildSha}={}){
 if(!UUID.test(String(tenantId||''))||!SHA.test(String(buildSha||'')))
   throw Error('Exact tenant and verified release SHA are required for UAT offer transition.')
 return db.query([
   'UPDATE tenant_runtime_update_offers',
   "SET state='blocked',",
   "last_gate_reason='Superseded by verified newer UAT application build',",
   'updated_at=now()',
   "WHERE tenant_id=$1 AND environment='uat' AND build_sha<>$2",
   "AND state IN ('offered','uat_testing','uat_accepted','scheduled','activating')",
   'RETURNING id,build_sha',
 ].join(' '),[tenantId,buildSha])
}
