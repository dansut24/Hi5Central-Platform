#!/usr/bin/env node
// Phase 14: disposable runtime proving attestation and API security using
// real built images. Never route this through Caddy, use real customer data,
// persist volumes, publish host ports, or create operator approvals.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'

const IS_EXPLICIT = process.argv.length === 5
  && process.argv[2] === '--run'
  && process.argv[3] === '--confirm'
  && process.argv[4] === 'EPHEMERAL_SYNTHETIC_ONLY'
if (!IS_EXPLICIT || process.env.HI5_PHASE14_SMOKE !== '1') {
  console.error('Explicit local-only test: HI5_PHASE14_SMOKE=1 node synthetic-runtime-smoke.mjs --run --confirm EPHEMERAL_SYNTHETIC_ONLY')
  process.exit(2)
}

function docker(args,options={}){
  return execFileSync('docker',args,{
    encoding:'utf8',timeout:options.timeout||30000,
    maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
  }).trim()
}
function safelyRun(args){
  try {return {ok:true,text:docker(args)}} catch(error) {
    return {ok:false,text:String(error.stdout||'')+'\n'+String(error.stderr||'')}
  }
}
const suffix=randomBytes(4).toString('hex')
const pgImage='public.ecr.aws/docker/library/postgres:17-alpine'
const redisImage='redis:8-alpine'
const apiImage='ghcr.io/dansut24/hi5central-platform-api:dev'
const itsmImage='ghcr.io/dansut24/hi5central-platform-itsm:dev'
const environments=['uat','test']
const entries=[]
const created={containers:[],networks:[]}
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms))
function check(condition,message){
  if(!condition) throw new Error(message)
}
function safeLog(name,s){
  console.log(name+': '+s)
}
async function waitUntil(fn,description,tries=35){
  for(let i=0;i<tries;i++){
    if(fn()) return
    await wait(1200)
  }
  throw new Error('Timeout: '+description)
}
function startContainer(args,name) {
  const id=docker(['run','--detach','--pull','never','--name',name,
    '--restart','no',...args])
  check(id.length>=12,'Container did not start: '+name)
  created.containers.push(name)
}
function publiclessNetwork(e){
  const args=['network','create','--internal','--driver','bridge',
    '--label','com.hi5central.scope=phase14-disposable-smoke',
    '--label','com.hi5central.environment='+e.env,e.network]
  docker(args)
  created.networks.push(e.network)
}
function state(name){
  const text=docker(['inspect',name,'--format','{{.State.Status}}'])
  return text
}
function logs(name) {
  const result=spawnSync('docker',['logs','--tail','180',name],{
    encoding:'utf8',timeout:9000,maxBuffer:24*1024*1024,
  })
  return String(result.stdout||'')+'\n'+String(result.stderr||'')
}
function envPairs(input){
  return Object.entries(input).flatMap(([key,value])=>['--env',key+'='+value])
}
function apiEnv(e){
  return {
    NODE_ENV:'production',PORT:'3001',
    DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
    RUNTIME_ENVIRONMENT:e.env,ROOT_DOMAIN:'hi5central.com',
    FEATURE_MODE:'controlled',BACKGROUND_WORKERS_ENABLED:'false',
    COOKIE_DOMAIN:'',PRIMARY_TENANT_SLUG:'',
    APP_URL:'',RMM_URL:'',ADMIN_URL:'',
    API_URL:`https://pilot-${e.env}-api.hi5central.com`,
    DATABASE_URL:`postgresql://h5probe:${e.dbPassword}@${e.pg}:5432/h5phase14`,
    REDIS_URL:`redis://:${e.redisPassword}@${e.redis}:6379/0`,
    MFA_ENCRYPTION_KEY:e.mfaKey,
    // The previously published API image still loads the disabled Connect module.
    // Supply a synthetic ephemeral key until the dedicated sandbox build lands.
    CONNECT_CODE_HMAC_KEY:e.connectKey,
    DB_POOL_MAX:'2',
  }
}
async function apiProbe(e,mode){
  const name=`hi5-p14-${e.env}-${mode}-${suffix}`
  docker(['create','--pull','never','--name',name,'--network',e.network,
    ...envPairs(apiEnv(e)),'--entrypoint','node',apiImage,'dist/index.mjs'])
  created.containers.push(name)
  docker(['start',name])
  if(mode==='verified'){
    await waitUntil(()=>state(name)==='running' && logs(name).includes('Hi5Central API listening on port 3001'),
      e.env+' verified API startup',28)
    return name
  }
  await waitUntil(()=>logs(name).includes('Managed customer runtime startup blocked:')
    ||state(name)==='exited',e.env+' fail-closed '+mode,20)
  const out=logs(name)
  if(!out.includes('Managed customer runtime startup blocked:')) {
    const cleaned=out.replaceAll(e.dbPassword,'[REDACTED]')
      .replaceAll(e.redisPassword,'[REDACTED]')
      .replaceAll(e.mfaKey,'[REDACTED]').replaceAll(e.connectKey,'[REDACTED]')
    throw new Error(e.env+' failed for wrong reason in '+mode+': '+('len='+cleaned.length+' tail='+JSON.stringify(cleaned.slice(-950))))
  }
  check(!out.includes('Hi5Central API listening on port 3001'),e.env+' unapproved API listener started')
  check(mode==='without-database' ? out.includes('no operator-attested identity')
    :out.includes('Redis has no operator-attested runtime identity'),
    e.env+' expected attestation guard was not triggered: '+mode)
  docker(['rm','--force',name])
  created.containers=created.containers.filter(c=>c!==name)
}
function sql(e,statement){
  return docker(['exec',e.pg,'psql','-X','-v','ON_ERROR_STOP=1',
    '-At','-U','h5probe','-d','h5phase14','-c',statement])
}
function redisSet(e,key,payload){
  const result=docker(['exec','-e','REDISCLI_AUTH='+e.redisPassword,
    e.redis,'redis-cli','SET',key,payload])
  check(result==='OK',e.env+' Redis binding failed')
}
function readApi(e,apiName,path,method='GET'){
  const code=`(async()=>{let r=await fetch('http://127.0.0.1:3001'+process.argv[1],{
    method:process.argv[2],redirect:'manual',
    headers:{origin:'https://phase14test'+process.argv[3]+'.hi5central.com'},
    signal:AbortSignal.timeout(5500)});
    let d=await r.text(); console.log(JSON.stringify({status:r.status,body:d.slice(0,450)}))
  })().catch(e=>{console.error(e.message);process.exitCode=2})`
  return JSON.parse(docker(['exec',apiName,'node','-e',code,path,method,e.env],{timeout:8000}))
}
function testNetwork(e,foreign){
  const ip=docker(['inspect',foreign.pg,'--format',
    `{{(index .NetworkSettings.Networks "${foreign.network}").IPAddress}}`])
  check(/^\d+\.\d+\.\d+\.\d+$/.test(ip),'Unable to identify synthetic peer IP')
  const script=`const net=require('net');let done=false;
  const s=net.connect({host:process.argv[1],port:5432,timeout:1300});
  function exit(code){if(done)return;done=true;s.destroy();process.exit(code)}
  s.on('connect',()=>exit(4));s.on('error',()=>exit(0));
  s.on('timeout',()=>exit(0));setTimeout(()=>exit(0),1800)`
  const out=safelyRun(['exec',e.api,'node','-e',script,ip])
  check(out.ok,e.env+' can reach the other sandbox PostgreSQL network')
}
async function main(){
  try {
  const apiRevision=docker(['image','inspect',apiImage,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'])
  const itsmRevision=docker(['image','inspect',itsmImage,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'])
  check(apiRevision.length>=7 && itsmRevision===apiRevision,
    'API and ITSM images must represent exactly the same published revision')
  for(const env of environments){
    const e={
      env,
      network:`hi5-p14-scratch-${env}-${suffix}`,
      pg:`hi5-p14-pg-${env}-${suffix}`,
      redis:`hi5-p14-redis-${env}-${suffix}`,
      dbPassword:randomBytes(24).toString('hex'),
      redisPassword:randomBytes(24).toString('hex'),
      mfaKey:randomBytes(32).toString('hex'),
      connectKey:randomBytes(32).toString('hex'),
    }
    entries.push(e)
    publiclessNetwork(e)
    startContainer(['--network',e.network,
      '--env','POSTGRES_USER=h5probe','--env','POSTGRES_DB=h5phase14',
      '--env','POSTGRES_PASSWORD='+e.dbPassword,pgImage],e.pg)
    startContainer(['--network',e.network,
      redisImage,'redis-server','--appendonly','no','--save','',
      '--requirepass',e.redisPassword],e.redis)
    await waitUntil(()=>safelyRun(['exec',e.pg,'pg_isready','-U','h5probe','-d','h5phase14']).ok,
      env+' PostgreSQL readiness')
    await waitUntil(()=>safelyRun(['exec','-e','REDISCLI_AUTH='+e.redisPassword,
      e.redis,'redis-cli','PING']).text.trim()==='PONG',env+' Redis readiness')
    // No application migrations are run against any existing named database.
    const migrated=docker(['run','--rm','--pull','never','--network',e.network,
      '--env','DATABASE_URL='+apiEnv(e).DATABASE_URL,
      '--entrypoint','node',apiImage,'dist/migrate.mjs'],{timeout:200000})
    check(migrated.includes('Database migrations are current'),env+' migration did not complete')
    safeLog(env,'scratch DB and Redis ready; migrations applied')
    await apiProbe(e,'without-database')
    safeLog(env,'API correctly rejected missing DB attestation')
    const identity=sql(e,`INSERT INTO managed_runtime_database_identity
      (environment,root_domain,verified_by) VALUES ('${env}','hi5central.com',
       'phase14-synthetic-check') RETURNING instance_id;`).split('\n')[0].trim()
    check(/^[0-9a-f-]{36}$/.test(identity),'Malformed scratch DB UUID')
    await apiProbe(e,'without-redis')
    safeLog(env,'API correctly rejected missing Redis attestation')
    const binding={
      environment:env,rootDomain:'hi5central.com',databaseInstanceId:identity,
      redisInstanceId:randomUUID(),verifiedBy:'phase14-synthetic-check',
      verifiedAt:new Date().toISOString(),
    }
    redisSet(e,'hi5central:managed:runtime:identity',JSON.stringify(binding))
    e.api=await apiProbe(e,'verified')
    check(logs(e.api).includes('Managed sandbox RMM broker disabled'),
      env+' must not launch a broker')
    const live=readApi(e,e.api,'/live')
    const health=readApi(e,e.api,'/health')
    const deployment=readApi(e,e.api,'/api/v1/system/deployment')
    const rmm=readApi(e,e.api,'/api/v1/rmm/devices')
    const connect=readApi(e,e.api,'/api/v1/connect/host')
    const session=readApi(e,e.api,'/api/v1/auth/session')
    check(live.status===200 && health.status===200,env+' API is unhealthy')
    const config=JSON.parse(deployment.body)
    check(config.tenancyMode==='multi'&&config.runtimeEnvironment===env,
      env+' API reports incorrect runtime identity')
    check(config.backgroundWorkersEnabled===false,env+' background workers started')
    check(rmm.status===423 && connect.status===423,env+' RMM/Connect not locked')
    check(session.status===401,env+' unauthenticated session was accepted')
    check(Number(sql(e,'SELECT count(*) FROM tenants;').split('\n')[0])===0,
      env+' created a tenant unexpectedly')
    safeLog(env,'API healthy; multi-tenant runtime attested; RMM/Connect 423; unauthenticated sessions 401; tenants 0')
    const webName=`hi5-p14-web-${env}-${suffix}`
    startContainer(['--network',e.network,
      ...envPairs({
        DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
        RUNTIME_ENVIRONMENT:env,FEATURE_MODE:'controlled',
        ROOT_DOMAIN:'hi5central.com',
        API_URL:`https://pilot-${env}-api.hi5central.com`,
        MARKETING_URL:'https://hi5central.com',PRIMARY_TENANT_SLUG:'',
        APP_URL:'',PORTAL_URL:'',RMM_URL:'',ADMIN_URL:'',TURN_URL:'',
      }),itsmImage],webName)
    await waitUntil(()=>safelyRun(['exec',webName,'wget','-q','-O','-',
      'http://127.0.0.1/healthz']).text.trim()==='ok',env+' ITSM frontend',20)
    const runtime=docker(['exec',webName,'wget','-q','-O','-',
      'http://127.0.0.1/runtime-config.js'])
    const homepage=docker(['exec',webName,'wget','-q','-O','-','http://127.0.0.1/'])
    check(homepage.includes('<!doctype html>') || homepage.includes('<!DOCTYPE html>'),
      env+' frontend does not serve the application entry point')
    for(const item of [
      `runtimeEnvironment: "${env}"`,
      'tenancyMode: "multi"',
      `apiUrl: "https://pilot-${env}-api.hi5central.com"`,
      'rmmUrl: ""','adminUrl: ""','primaryTenantSlug: ""',
    ]) check(runtime.includes(item),env+' unsafe frontend runtime configuration: '+item)
    safeLog(env,'ITSM/Portal healthy; environment API set; no RMM/Admin; no default demo customer')

  }
  testNetwork(entries[0],entries[1])
  testNetwork(entries[1],entries[0])
  console.log('PHASE14_SYNTHETIC_RUNTIME_SMOKE: PASS')
  console.log('Scratch UAT/Test isolated by independent internal networks and ephemeral DB/Redis containers; no gateway or customer tenant.')
} finally {
  for(const container of created.containers.reverse()){
    safelyRun(['rm','--force',container])
  }
  for(const network of created.networks.reverse()){
    safelyRun(['network','rm',network])
  }
  for(const e of entries){
    const network=safelyRun(['network','inspect',e.network])
    if(network.ok) {
      console.error('CLEANUP FAILURE: scratch network '+e.network+' still exists')
      process.exitCode=1
    }
  }
  safeLog('cleanup','temporary containers and networks removed; approved pilot bridges unchanged')
}
}
main().catch(error=>{
  // Do not dump Docker stderr here: application configuration can contain secrets.
  console.error('PHASE14_SYNTHETIC_RUNTIME_SMOKE: FAILED: '+String(error.message).slice(0,1800))
  process.exitCode=1
})
