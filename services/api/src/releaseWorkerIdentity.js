/**
 * Strict database boundary for *generic* unattended release processes.
 * Legacy allowlisted QA workers remain unchanged until separately retired.
 *
 * Never infer least privilege from a container user, image tag or env var:
 * verify the actual authenticated PostgreSQL identity and effective ACLs.
 */
export async function assertRestrictedGenericDatabaseIdentity(db,{kind}={}){
 if(!['planner','executor'].includes(kind))
   throw Error('Invalid generic release database identity check.')
 const result=await db.query([
   'SELECT current_user::text AS effective_role,',
   'session_user::text AS login_role,',
   'r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolcanlogin,',
   "has_table_privilege(current_user,'public.platform_release_rollout_control','UPDATE') AS can_unpause,",
   "CASE WHEN to_regprocedure('public.hi5_release_emergency_pause(text,text)') IS NULL",
   'THEN false ELSE',
   "has_function_privilege(current_user,'public.hi5_release_emergency_pause(text,text)','EXECUTE') END AS can_emergency_pause",
   'FROM pg_roles r WHERE r.rolname=current_user',
 ].join(' '))
 const r=result.rows[0]
 if(!r||r.effective_role!==r.login_role||!r.rolcanlogin||
   r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolbypassrls||
   r.can_unpause)
   throw Error('Generic release database credential is not a dedicated restricted login.')
 if(kind==='planner'&&r.can_emergency_pause)
   throw Error('The generic planner must never hold emergency execution permissions.')
 if(kind==='executor'&&!r.can_emergency_pause)
   throw Error('Generic executor requires the reviewed, audited pause-only permission.')
 return {kind,role:r.effective_role,leastPrivileged:true,canDirectlyUnpause:false}
}
