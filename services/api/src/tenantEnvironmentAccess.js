import pg from 'pg'
import { readFileSync } from 'node:fs'
import { pool } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import { provisionTenantSandboxes } from './tenantEnvironmentProvisioner.js'
import { itsmEnvironmentsForMode } from './tenantEnvironmentPolicy.js'

const { Client }=pg
const SANDBOXES=['test','uat']

/** Live is the sole source of identity and environment access grants. */
export async function permittedTenantEnvironment(tenantId,userId,environment,{db=pool}={}) {
  if(!SANDBOXES.includes(environment))return false
  const result=await db.query(
    `SELECT m.role,COALESCE(a.granted,false) AS explicit_grant
       FROM tenant_memberships m
       JOIN tenants t ON t.id=m.tenant_id
       JOIN tenant_environment_state e ON e.tenant_id=m.tenant_id AND e.environment=$3
       JOIN tenant_release_preferences p ON p.tenant_id=m.tenant_id
       LEFT JOIN tenant_member_environment_access a
         ON a.tenant_id=m.tenant_id AND a.user_id=m.user_id AND a.environment=$3
      WHERE m.tenant_id=$1 AND m.user_id=$2
        AND t.status='active' AND m.status='active' AND e.status='ready'
        AND (e.environment='test' OR p.update_mode='admin_controlled')`,
    [tenantId,userId,environment],
  )
  return result.rowCount>0 && (result.rows[0].role==='owner'||result.rows[0].explicit_grant===true)
}

export async function environmentMembers(tenantId,{db=pool}={}){
  const result=await db.query(
    `SELECT m.user_id AS "userId",u.email,u.name,m.role,m.status,
            m.role='owner' OR COALESCE(a_test.granted,false) AS test,
            p.update_mode='admin_controlled' AND
              (m.role='owner' OR COALESCE(a_uat.granted,false)) AS uat
       FROM tenant_memberships m JOIN users u ON u.id=m.user_id
       JOIN tenant_release_preferences p ON p.tenant_id=m.tenant_id
       LEFT JOIN tenant_member_environment_access a_test
         ON a_test.tenant_id=m.tenant_id AND a_test.user_id=m.user_id AND a_test.environment='test'
       LEFT JOIN tenant_member_environment_access a_uat
         ON a_uat.tenant_id=m.tenant_id AND a_uat.user_id=m.user_id AND a_uat.environment='uat'
      WHERE m.tenant_id=$1 ORDER BY u.name,u.email`,
    [tenantId],
  )
  return result.rows
}

async function revokeEnvironmentSessions(tenantId,userId,environment){
  const path=process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL_FILE`]
  const connectionString=path?readFileSync(path,'utf8').trim():process.env[`TENANT_${environment.toUpperCase()}_DATABASE_URL`]
  if(!connectionString)throw Error(`${environment.toUpperCase()} database is not configured`)
  const client=new Client({connectionString,connectionTimeoutMillis:6000})
  try{
    await client.connect()
    await client.query(
      `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now())
       WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [tenantId,userId],
    )
  }finally{await client.end().catch(()=>{})}
}

export async function assignEnvironmentPermissions(
  tenantId,userId,{test,uat},actorUserId,{db=pool,sync=true}={},
){
  if(typeof test!=='boolean'||typeof uat!=='boolean'){
    const error=new Error('Specify true or false for both Test and UAT access.')
    error.status=400
    throw error
  }
  const target=await db.query(
    `SELECT m.role,m.status,p.update_mode
       FROM tenant_memberships m JOIN tenant_release_preferences p ON p.tenant_id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.user_id=$2`,
    [tenantId,userId],
  )
  if(!target.rowCount||target.rows[0].status!=='active'){
    const error=new Error('This person must have an active Hi5Central tenant account.')
    error.status=404
    throw error
  }
  const environments=itsmEnvironmentsForMode(target.rows[0].update_mode)
  if(!environments.includes('uat')&&uat){
    const error=new Error('Managed ITSM does not have a UAT environment.')
    error.status=403
    throw error
  }
  if(target.rows[0].role==='owner'&&(!test||(environments.includes('uat')&&!uat))){
    const error=new Error('Organisation owners must retain both Test and UAT access.')
    error.status=403
    throw error
  }
  for(const [environment,granted] of [['test',test],['uat',uat]]){
    await db.query(
      `INSERT INTO tenant_member_environment_access
         (tenant_id,user_id,environment,granted,granted_by)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id,user_id,environment)
       DO UPDATE SET granted=EXCLUDED.granted,granted_by=EXCLUDED.granted_by,updated_at=now()`,
      [tenantId,userId,environment,granted,actorUserId],
    )
  }
  if(sync&&deployment.runtimeEnvironment==='live'){
    // Reconcile the account in shared Test/UAT first (existing local sandbox
    // data is retained). Never replicate password hashes or user MFA secrets.
    const result=await provisionTenantSandboxes(tenantId,{source:db})
    for(const environment of environments){
      if(result[environment]?.status!=='ready'){
        const error=new Error(`${environment.toUpperCase()} account synchronisation failed.`)
        error.status=503
        throw error
      }
    }
    // Ensure existing sessions cannot outlive an administrator's revocation.
    for(const [environment,allowed] of [['test',test],['uat',uat]]){
      if(!environments.includes(environment))continue
      if(!allowed)await revokeEnvironmentSessions(tenantId,userId,environment)
    }
  }
  const members=await environmentMembers(tenantId,{db})
  return members.find(row=>row.userId===userId)
}

export function registerTenantEnvironmentAccessRoutes(app){
  app.get('/api/v1/people/environment-access',async c=>{
    const s=await resolveSession(c)
    if(!s)return c.json({error:'Authentication required.'},401)
    if(deployment.runtimeEnvironment!=='live'||!originMatchesTenant(c.req.header('origin'),s.slug))
      return c.json({error:'Use your Live organisation to manage environment access.'},403)
    if(!['owner','admin'].includes(s.tenant_role))
      return c.json({error:'Organisation admin access required.'},403)
    return c.json({members:await environmentMembers(s.tenant_id)})
  })
  app.put('/api/v1/people/environment-access/:userId',async c=>{
    const s=await resolveSession(c)
    if(!s)return c.json({error:'Authentication required.'},401)
    if(deployment.runtimeEnvironment!=='live'||!originMatchesTenant(c.req.header('origin'),s.slug))
      return c.json({error:'Use your Live organisation to manage environment access.'},403)
    if(!['owner','admin'].includes(s.tenant_role))
      return c.json({error:'Organisation admin access required.'},403)
    const userId=String(c.req.param('userId')||'')
    if(!/^[0-9a-f-]{36}$/i.test(userId))return c.json({error:'Invalid user account.'},400)
    let body
    try {body=await c.req.json()}catch{return c.json({error:'Valid JSON required.'},400)}
    try {
      const member=await assignEnvironmentPermissions(
        s.tenant_id,userId,{test:body?.test,uat:body?.uat},s.user_id,
      )
      return c.json({member})
    }catch(error){
      console.error('Tenant environment permission update failed',{tenantId:s.tenant_id,code:error.code||'UNKNOWN'})
      return c.json({error:error.message||'Could not update environment access.'},error.status||500)
    }
  })
}
