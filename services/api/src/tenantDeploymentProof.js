import {createHash,timingSafeEqual} from 'node:crypto'
import {pool} from './db.js'
import {deployment} from './deploymentConfig.js'

const SHA=/^[a-f0-9]{40}$/
export const MAX_TENANT_PROOF_AGE_MS=24*60*60*1000
export function validTenantDeploymentProof({row,buildSha,now=new Date()}){
  if(!row||row.status!=='verified'||!SHA.test(String(buildSha||'')))return false
  if(row.api_sha!==buildSha||row.itsm_sha!==buildSha)return false
  const age=now.getTime()-new Date(row.verified_at).getTime()
  return Number.isFinite(age)&&age>=0&&age<=MAX_TENANT_PROOF_AGE_MS
}
function requireTrustedOperator(c){
  const expected=String(process.env.RELEASE_OPERATOR_TOKEN||'')
  if(expected.length<32)return c.json({error:'Trusted operator is not configured.'},503)
  const bearer=String(c.req.header('authorization')||'')
  const received=bearer.startsWith('Bearer ')?bearer.slice(7).trim():''
  if(!received)return c.json({error:'Operator authentication required.'},401)
  const x=createHash('sha256').update(received).digest()
  const y=createHash('sha256').update(expected).digest()
  if(!timingSafeEqual(x,y))return c.json({error:'Operator authentication required.'},401)
  return null
}
export async function verifyTenantPublicBuild({slug,environment,sha,rootDomain='hi5central.com',transport=fetch}){
  if(!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(slug)
    ||!['uat','live'].includes(environment)||!SHA.test(sha)
    ||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(rootDomain))
    throw Error('Invalid deployment proof parameters.')
  const appHost=environment==='uat'?slug+'-uat.'+rootDomain:slug+'.'+rootDomain
  const apiHost=environment==='uat'?appHost:'api.'+rootDomain
  const origin='https://'+appHost
  const probes=[
    {url:'https://'+apiHost+'/api/v1/updates/version',type:'api'},
    {url:origin+'/release-manifest.json',type:'itsm'},
  ]
  const hashes={}
  for(const probe of probes){
    const response=await transport(probe.url,{
      headers:{Origin:origin},cache:'no-store',redirect:'error',
      signal:AbortSignal.timeout(9000),
    })
    if(response.status!==200)throw Error('Public '+probe.type+' runtime check failed.')
    const data=await response.json()
    if(!SHA.test(String(data.sha||''))||data.sha!==sha)
      throw Error('Public '+probe.type+' is not running the approved build.')
    hashes[probe.type]=data.sha
  }
  return {apiSha:hashes.api,itsmSha:hashes.itsm,appHost}
}
export function registerTenantDeploymentProofRoutes(app){
  app.post('/api/platform-operator/v1/tenant-deployments/verify',async c=>{
    const auth=requireTrustedOperator(c)
    if(auth)return auth
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority required.'},403)
    let body
    try{body=await c.req.json()}catch{return c.json({error:'JSON body required.'},400)}
    const slug=String(body?.tenantSlug||'').toLowerCase().trim()
    const environment=String(body?.environment||'').toLowerCase()
    const sha=String(body?.buildSha||'').toLowerCase()
    const pilot=String(process.env.CONFIGURATION_RELEASE_PILOT_TENANT_SLUG||'').toLowerCase().trim()
    const approved=String(process.env.CONFIGURATION_RELEASE_AI_APPROVED_BUILD_SHA||'').toLowerCase().trim()
    if(!pilot||slug!==pilot||!['uat','live'].includes(environment)
      ||!SHA.test(approved)||sha!==approved)
      return c.json({error:'Not an approved tenant release build.'},403)
    try{
      const selected=await pool.query('SELECT id FROM tenants WHERE slug=$1 AND status=$2',[slug,'active'])
      if(selected.rowCount!==1)return c.json({error:'Active tenant not found.'},404)
      const publicProof=await verifyTenantPublicBuild({
        slug,environment,sha,rootDomain:deployment.rootDomain,
      })
      const tenantId=selected.rows[0].id
      await pool.query(`INSERT INTO tenant_application_deployment_proofs
        (tenant_id,environment,api_sha,itsm_sha,status,verified_at)
        VALUES($1,$2,$3,$4,'verified',now())
        ON CONFLICT (tenant_id,environment) DO UPDATE
        SET api_sha=EXCLUDED.api_sha,itsm_sha=EXCLUDED.itsm_sha,
          status='verified',verified_at=now()`,
      [tenantId,environment,publicProof.apiSha,publicProof.itsmSha])
      return c.json({verified:true,tenantSlug:slug,environment,
        apiSha:publicProof.apiSha,itsmSha:publicProof.itsmSha,
        source:'trusted_operator_public_probe'})
    }catch(e){
      console.error('Tenant software verification rejected',{message:String(e.message||'failed')})
      return c.json({error:'The tenant API and ITSM application must both serve the approved build before it can be verified.'},409)
    }
  })
}
