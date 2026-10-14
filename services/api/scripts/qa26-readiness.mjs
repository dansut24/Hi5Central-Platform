// QA26 operator-only read-only database preflight. No deployments or data writes.
import pg from 'pg'
import { readFileSync } from 'node:fs'
const { Client }=pg
const managed='h5c-managed-qa26', custom='h5c-custom-qa26'
const output={scope:[managed,custom],readOnly:true,checks:[],ready:false}
function add(scope,name,pass,reason=''){
  output.checks.push({scope,name,status:pass?'PASS':'BLOCKED',...(!pass?{reason}:{})})
}
function urlFor(env){
  const key=env==='live'?'DATABASE_URL':'TENANT_'+env.toUpperCase()+'_DATABASE_URL'
  const file=process.env[key+'_FILE']
  return file?readFileSync(file,'utf8').trim():String(process.env[key]||'')
}
async function rows(db,sql,args=[]){return (await db.query(sql,args)).rows}
async function schema(db,env){
  const result=await rows(db,"SELECT to_regclass('public.itsm_configuration_change_events') IS NOT NULL AS audit, to_regclass('public.tenant_member_environment_access') IS NOT NULL AS grants")
  add(env,'schema migrations applied',result[0]?.audit===true&&result[0]?.grants===true,'Apply approved migrations before deploying new API code.')
}
async function liveTenant(db,slug,mode){
  const list=await rows(db,"SELECT t.id,t.status,s.modules,p.update_mode,(SELECT count(*)::int FROM tenant_memberships m WHERE m.tenant_id=t.id AND m.status='active' AND m.role='owner') AS owners FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id JOIN tenant_release_preferences p ON p.tenant_id=t.id WHERE t.slug=$1",[slug])
  const item=list[0]
  add(slug,'active Live tenant',item?.status==='active','Missing or inactive Live tenant.')
  add(slug,'update policy',item?.update_mode===mode,'Incorrect Managed/Custom mode.')
  add(slug,'Live ITSM module',item?.modules?.itsm===true,'ITSM not enabled.')
  add(slug,'Live owner',Number(item?.owners)>0,'Active owner missing.')
  return item?.id
}
async function state(db,id,slug,env,required){
  if(!id)return
  const result=await rows(db,'SELECT status FROM tenant_environment_state WHERE tenant_id=$1 AND environment=$2',[id,env])
  const current=result[0]?.status
  add(slug,env+' control-plane state',required?current==='ready':current!=='ready',
    required?'Environment not ready.':'Managed UAT must not be ready.')
}
async function sandbox(db,id,slug,env,required){
  if(!id)return
  const list=await rows(db,"SELECT t.slug,t.status,s.modules,s.rmm_url,(SELECT count(*)::int FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' AND m.status='active' AND u.password_hash='environment-sso-only') AS owners FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id WHERE t.id=$1",[id])
  const item=list[0]
  if(!required){add(slug,'Managed UAT not provisioned',!item,'Unexpected Managed UAT tenant found.');return}
  add(slug,env+' tenant identity',item?.slug===slug+'-'+env&&item?.status==='active','Tenant mapping or status mismatch.')
  add(slug,env+' RMM isolation',item?.modules?.rmm===false&&item?.rmm_url===null,'Sandbox RMM must be disabled.')
  add(slug,env+' central identity projection',Number(item?.owners)>0,'Missing SSO-only owner.')
}
const connections={}
try{
  for(const env of ['live','test','uat']){
    try{connections[env]=urlFor(env)}catch{connections[env]=''}
    add('operator',env+' connection configured',Boolean(connections[env]),'Set approved read-only database connection.')
  }
  if(Object.values(connections).every(Boolean)){
    add('operator','distinct DB connections',new Set(Object.values(connections)).size===3,
      'Live/Test/UAT must use separate databases.')
    const authority=String(process.env.QA26_IDENTITY_API_URL||process.env.ENV_IDENTITY_API_URL||'')
    add('operator','Live identity HTTPS URL configured',/^https:\/\/[^/?#]+\/?$/.test(authority),
      'Configure the sandbox identity API URL.')
    const keyFile=process.env.ENV_IDENTITY_SHARED_SECRET_FILE
    const key=keyFile?readFileSync(keyFile,'utf8').trim():String(process.env.ENV_IDENTITY_SHARED_SECRET||'')
    add('operator','shared identity credential present',key.length>=32,'Configure existing secret, never a new tenant account.')
    const dbs={}
    try {
      for(const env of ['live','test','uat']){
        const db=new Client({connectionString:connections[env],connectionTimeoutMillis:6000,statement_timeout:6000,application_name:'qa26_read_only'})
        await db.connect()
        await db.query('BEGIN TRANSACTION READ ONLY')
        dbs[env]=db
      }
      for(const env of ['live','test','uat'])await schema(dbs[env],env)
      const m=await liveTenant(dbs.live,managed,'hi5_managed')
      const c=await liveTenant(dbs.live,custom,'admin_controlled')
      await state(dbs.live,m,managed,'test',true)
      await state(dbs.live,m,managed,'uat',false)
      await state(dbs.live,c,custom,'test',true)
      await state(dbs.live,c,custom,'uat',true)
      await sandbox(dbs.test,m,managed,'test',true)
      await sandbox(dbs.uat,m,managed,'uat',false)
      await sandbox(dbs.test,c,custom,'test',true)
      await sandbox(dbs.uat,c,custom,'uat',true)
    }catch(error){
      // Never expose connection string or provider details in errors.
      add('operator','read-only database interrogation',false,'Query error code '+String(error?.code||'UNKNOWN'))
    }finally{
      for(const db of Object.values(dbs)){await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{})}
    }
  }
}catch(error){
  add('operator','environment prerequisites',false,'Error code '+String(error?.code||'UNKNOWN'))
}
output.ready=output.checks.length>0&&output.checks.every(item=>item.status==='PASS')
console.log(JSON.stringify(output,null,2))
if(!output.ready)process.exitCode=1
