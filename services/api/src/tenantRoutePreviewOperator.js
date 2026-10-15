import {pool} from './db.js'
import {deployment} from './deploymentConfig.js'
import {buildTenantRouteCutover} from './tenantRouteCutover.js'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POOL=/^[a-z][a-z0-9-]{2,62}$/

/**
 * Protected, read-only bridge from a claimed rollout job to an exact
 * candidate Caddy route generation. The trusted host must separately
 * verify the gateway, sign and apply a generation and prove its routing.
 * This API must NEVER switch Caddy or update tenant assignments.
 */
export function registerTenantRoutePreviewOperator(app,requireOperator){
  app.post('/api/platform-operator/v1/runtime-pools/tenant-cutover-preview',async c=>{
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only central Live release authority may prepare cutovers.'},403)
    const body=await c.req.json().catch(()=>null)
    const jobId=String(body?.jobId||''),poolId=String(body?.poolId||'')
    if(!UUID.test(jobId)||!POOL.test(poolId))
      return c.json({error:'Valid rollout job and versioned pool IDs are required.'},400)
    const db=await pool.connect()
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const jobResult=await db.query([
        'SELECT j.*,t.slug,t.status AS tenant_status,r.update_mode,',
        "COALESCE((ts.modules->>'itsm')::boolean,false) AS itsm_entitled",
        'FROM tenant_release_rollout_jobs j',
        'JOIN tenants t ON t.id=j.tenant_id',
        'JOIN tenant_release_preferences r ON r.tenant_id=j.tenant_id',
        'JOIN tenant_settings ts ON ts.tenant_id=j.tenant_id',
        'WHERE j.id=$1',
      ].join(' '),[jobId])
      const job=jobResult.rows[0]
      if(!job||job.tenant_status!=='active'||job.itsm_entitled!==true)
        throw Error('Active, ITSM-entitled rollout job not found.')
      const candidateResult=await db.query([
        'SELECT id,environment,build_sha,state,api_target,web_target,',
        'verified_at,last_seen_at FROM platform_runtime_pools',
        'WHERE id=$1 AND environment=$2 AND build_sha=$3',
      ].join(' '),[poolId,job.environment,job.build_sha])
      const p=candidateResult.rows[0]
      if(!p)throw Error('Exact immutable runtime pool is not registered.')
      const routeResult=await db.query([
        'SELECT a.tenant_id,t.slug,a.environment,a.pool_id,a.build_sha,',
        'r.update_mode,',
        "COALESCE((ts.modules->>'itsm')::boolean,false) AS itsm_entitled,",
        'p.build_sha AS pool_build_sha,p.state AS pool_state,p.api_target,p.web_target,',
        'p.verified_at,p.last_seen_at',
        'FROM tenant_runtime_assignments a',
        'JOIN tenants t ON t.id=a.tenant_id AND t.status=$2',
        'JOIN tenant_release_preferences r ON r.tenant_id=t.id',
        'JOIN tenant_settings ts ON ts.tenant_id=t.id',
        'JOIN platform_runtime_pools p ON p.id=a.pool_id AND p.environment=a.environment',
        'WHERE a.environment=$1 ORDER BY t.slug',
      ].join(' '),[job.environment,'active'])
      const proposal=buildTenantRouteCutover({
        environment:job.environment,tenantId:job.tenant_id,
        slug:job.slug,mode:job.update_mode,itsmEntitled:job.itsm_entitled,
        job,candidate:{
          tenant_id:job.tenant_id,slug:job.slug,
          environment:job.environment,itsm_entitled:job.itsm_entitled,
          update_mode:job.update_mode,pool_id:p.id,pool_id_verified:p.id,
          build_sha:job.build_sha,pool_build_sha:p.build_sha,pool_state:p.state,
          api_target:p.api_target,web_target:p.web_target,
          verified_at:p.verified_at,last_seen_at:p.last_seen_at,
        },activeRows:routeResult.rows,domain:deployment.rootDomain,
      })
      await db.query('COMMIT')
      return c.json({proposal,activationAllowed:false})
    }catch(error){
      await db.query('ROLLBACK').catch(()=>{})
      const blocked=error?.code==='ROUTE_PREVIEW_BLOCKED'
      return c.json({error:blocked?error.message:'Unable to validate the current immutable route generation.',
        activationAllowed:false},409)
    }finally{db.release()}
  })
}
