import pg from 'pg'
import {readFileSync} from 'node:fs'
import {deployment} from './deploymentConfig.js'

// Only the named, provisioned customer may read shared legal identity.
// All other data (records, security, workflows, environment configuration)
// stays in the environment's own PostgreSQL database.
export function masterLegalIdentityScope(session,{environment=deployment.runtimeEnvironment,settings=process.env}={}){
 const pilot=String(settings.ENV_SHARED_MASTER_PILOT_TENANT_SLUG||'').trim().toLowerCase()
 const suffix=environment==='uat'?'uat':environment==='test'?'test':null
 const tenantId=String(session?.tenant_id||'')
 if(!suffix||!pilot||!/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]$/.test(pilot)
   ||!(/^[a-f0-9-]{36}$/i).test(tenantId)
   ||String(session?.slug||'').toLowerCase()!==pilot+'-'+suffix)return null
 return {tenantId,pilot}
}

export async function readMasterLegalIdentity(session,{environment=deployment.runtimeEnvironment,
 settings=process.env,connect=connection=>new pg.Client({connectionString:connection,
 connectionTimeoutMillis:6000})}={}){
 const scope=masterLegalIdentityScope(session,{environment,settings})
 if(!scope)return null
 const source=String(settings.ENV_MASTER_DATABASE_URL_FILE||'').trim()
 if(!source)throw new Error('Production master identity is unavailable for this environment.')
 const connection=readFileSync(source,'utf8').trim()
 if(!connection)throw new Error('Production master identity connection is unavailable.')
 const client=connect(connection)
 try{
  await client.connect()
  const result=await client.query(
   `SELECT CASE WHEN ts.configuration<>'{}'::jsonb THEN ts.configuration ELSE ts.onboarding_data END
            #>> '{company,legalName}' AS legal_name
      FROM tenant_settings ts JOIN tenants t ON t.id=ts.tenant_id
     WHERE t.id=$1 AND t.slug=$2 AND t.status='active' LIMIT 1`,
   [scope.tenantId,scope.pilot])
  if(result.rowCount!==1)throw new Error('Production master organisation identity is unavailable.')
  return {legalName:String(result.rows[0].legal_name||'')}
 }finally{await client.end().catch(()=>{})}
}

export function applyMasterLegalIdentity(payload,identity){
 if(!identity)return payload
 return {...payload,masterIdentity:{companyLegalNameReadOnly:true,source:'production'},
  settings:{...payload.settings,
  company:{...(payload.settings?.company||{}),legalName:identity.legalName}}}
}
export function protectMasterLegalIdentity(company,identity){
 if(!identity)return company
 if(Object.hasOwn(company,'legalName')
   &&company.legalName!==identity.legalName)
   throw new Error('The registered company name is managed in Production. Update it there.')
 // The sandbox must not persist a second copy of the master legal name.
 // Its reads are projected from Production and the remaining company
 // settings continue to be environment-local.
 const {legalName:ignored,...environmentSettings}=company
 return environmentSettings
}
