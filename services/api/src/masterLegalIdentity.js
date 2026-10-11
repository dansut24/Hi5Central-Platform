import {timingSafeEqual} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {deployment} from './deploymentConfig.js'
import {pool} from './db.js'

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const slugPattern=/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/
const clean=value=>String(value||'').trim().toLowerCase()
const bearer=request=>String(request.req.header('authorization')||'').replace(/^Bearer\s+/i,'').trim()
const sharedSecret=settings=>String(settings.ENV_IDENTITY_SHARED_SECRET_FILE
 ?readFileSync(settings.ENV_IDENTITY_SHARED_SECRET_FILE,'utf8').trim()
 :settings.ENV_IDENTITY_SHARED_SECRET||'')
const authorized=(request,secret)=>{const received=bearer(request);return secret.length>=32
 &&received.length===secret.length&&timingSafeEqual(Buffer.from(secret),Buffer.from(received))}

export function masterLegalIdentityScope(session,{environment=deployment.runtimeEnvironment,settings=process.env}={}){
 const pilot=clean(settings.ENV_SHARED_MASTER_PILOT_TENANT_SLUG)
 const suffix=environment==='uat'?'uat':environment==='test'?'test':null
 const tenantId=String(session?.tenant_id||'')
 if(!suffix||!slugPattern.test(pilot)||!idPattern.test(tenantId)
   ||clean(session?.slug)!==pilot+'-'+suffix)return null
 return {tenantId,pilot,environment}
}

// The shared master READ-ONLY database exposes directory tables only.
// Legal identity is therefore retrieved through the existing authenticated
// Production environment-identity channel, never by broadening DB grants.
export async function readMasterLegalIdentity(session,{environment=deployment.runtimeEnvironment,
 settings=process.env,fetchImpl=fetch}={}){
 const scope=masterLegalIdentityScope(session,{environment,settings})
 if(!scope)return null
 const secret=sharedSecret(settings)
 const base=String(settings.ENV_IDENTITY_API_URL||'').replace(/\/$/,'')
 if(secret.length<32||!/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(base))
  throw Error('Production master identity service is unavailable.')
 const response=await fetchImpl(base+'/api/v1/internal/environment-identity/legal-name',{
  method:'POST',redirect:'error',cache:'no-store',
  headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
  body:JSON.stringify({tenantId:scope.tenantId,tenantSlug:scope.pilot,environment:scope.environment}),
  signal:AbortSignal.timeout(6000),
 })
 if(!response.ok)throw Error('Production master legal identity could not be verified.')
 const value=await response.json()
 if(value?.tenantId!==scope.tenantId||value?.tenantSlug!==scope.pilot
   ||typeof value.legalName!=='string')
  throw Error('Production master identity response did not match the tenant.')
 return {legalName:value.legalName}
}

export function registerMasterLegalIdentityRoutes(app,{
 database=pool,environment=deployment.runtimeEnvironment,settings=process.env}={}){
 app.post('/api/v1/internal/environment-identity/legal-name',async c=>{
  if(environment!=='live')return c.json({error:'Live identity authority only.'},403)
  let secret
  try{secret=sharedSecret(settings)}catch{return c.json({error:'Identity authority unavailable.'},503)}
  if(!authorized(c,secret))return c.json({error:'Unauthorised.'},401)
  const body=await c.req.json().catch(()=>null)
  const pilot=clean(settings.ENV_SHARED_MASTER_PILOT_TENANT_SLUG)
  const tenantId=String(body?.tenantId||''),tenantSlug=clean(body?.tenantSlug)
  if(!idPattern.test(tenantId)||!slugPattern.test(pilot)
    ||tenantSlug!==pilot||!['test','uat'].includes(body?.environment))
   return c.json({error:'Unknown master identity request.'},404)
  const r=await database.query(
   `SELECT COALESCE(NULLIF(ts.configuration #>> '{company,legalName}', ''),
          NULLIF(ts.onboarding_data #>> '{company,legalName}', ''), '') AS legal_name
      FROM tenant_settings ts JOIN tenants t ON t.id=ts.tenant_id
      WHERE t.id=$1 AND t.slug=$2 AND t.status='active' LIMIT 1`,
   [tenantId,pilot])
  if(r.rowCount!==1)return c.json({error:'Master organisation not found.'},404)
  return c.json({tenantId,tenantSlug:pilot,legalName:String(r.rows[0].legal_name||'')},
   200,{'Cache-Control':'no-store'})
 })
}

export function applyMasterLegalIdentity(payload,identity){
 if(!identity)return payload
 return {...payload,masterIdentity:{companyLegalNameReadOnly:true,source:'production'},
  settings:{...payload.settings,
   company:{...(payload.settings?.company||{}),legalName:identity.legalName}}}
}
export function protectMasterLegalIdentity(company,identity){
 if(!identity)return company
 if(Object.hasOwn(company,'legalName')&&company.legalName!==identity.legalName)
  throw Error('The registered company name is managed in Production. Update it there.')
 // No environment-local copy: display the verified Production value on reads.
 const {legalName:ignored,...environmentSettings}=company
 return environmentSettings
}
