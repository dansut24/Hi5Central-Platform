// Read-only security validation for a wholly separate managed pilot control plane.
// Checking a Compose config is not proof of human MFA, DNS/TLS or pilot approval.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function parsePilotEnv(source) {
  const vars={}
  for(const line of String(source).split(/\r?\n/)){
    const trimmed=line.trim()
    if(!trimmed || trimmed.startsWith('#'))continue
    const match=trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if(!match)throw new Error('Invalid pilot environment line.')
    if(Object.hasOwn(vars,match[1]))throw new Error('Duplicate pilot environment setting.')
    vars[match[1]]=match[2].replace(/^"(.*)"$/,'$1')
  }
  return vars
}
const digest=/^[-a-z0-9./]+@sha256:[a-f0-9]{64}$/
const strong=value=>typeof value==='string' && value.length>=24
  && !/REPLACE|CHANGEME|PLACEHOLDER|DEFAULT|EXAMPLE/i.test(value)
const expected={
  COMPOSE_PROJECT_NAME:'hi5central-pilot-control',
  DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
  RUNTIME_ENVIRONMENT:'live',FEATURE_MODE:'controlled',
  BACKGROUND_WORKERS_ENABLED:'false',
  ROOT_DOMAIN:'hi5central.com',
  COOKIE_DOMAIN:'',APP_URL:'',PORTAL_URL:'',RMM_URL:'',TURN_URL:'',
  PRIMARY_TENANT_SLUG:'',
  ADMIN_URL:'https://pilot-admin.hi5central.com',
  API_URL:'https://pilot-control-api.hi5central.com',
}
function url(raw,protocol,hostname){
  try{
    const parsed=new URL(raw)
    return parsed.protocol===protocol && parsed.hostname===hostname
      && !parsed.search && !parsed.hash && !parsed.username.includes('%')
      ? parsed:null
  }catch{return null}
}
export function validatePilotEnvironment(env) {
  const errors=[]
  for (const [key,value] of Object.entries(expected)) {
    if(env?.[key]!==value)errors.push(key+' must be exactly '+(value||'(empty)'))
  }
  for(const key of ['POSTGRES_USER','POSTGRES_DB']){
    if(!/^[a-z][a-z0-9_]{7,39}$/.test(String(env[key]||'')))
      errors.push(key+' must be a unique restricted identifier')
  }
  for(const key of ['POSTGRES_PASSWORD','REDIS_PASSWORD','MFA_ENCRYPTION_KEY','CONNECT_CODE_HMAC_KEY']){
    if(!strong(env[key]))errors.push(key+' missing distinct high-entropy secret')
  }
  if([env.POSTGRES_PASSWORD,env.REDIS_PASSWORD,env.MFA_ENCRYPTION_KEY,env.CONNECT_CODE_HMAC_KEY].some(
    (v,i,a)=>a.indexOf(v)!==i))errors.push('Pilot database, Redis, MFA and Connect secrets must differ')
  for(const key of ['POSTGRES_IMAGE','REDIS_IMAGE','API_IMAGE','ADMIN_IMAGE']){
    if(!digest.test(String(env[key]||'')))errors.push(key+' must use immutable OCI digest')
  }
  const db=url(env.DATABASE_URL,'postgresql:','postgres')
  if(!db || db.username!==env.POSTGRES_USER ||
    db.pathname!=='/'+env.POSTGRES_DB ||
    decodeURIComponent(db.password)!==env.POSTGRES_PASSWORD)
    errors.push('DATABASE_URL must target only the local private pilot PostgreSQL service')
  const cache=url(env.REDIS_URL,'redis:','redis')
  if(!cache || cache.pathname!=='/0' || cache.username ||
    decodeURIComponent(cache.password)!==env.REDIS_PASSWORD)
    errors.push('REDIS_URL must target only the local private pilot Redis service database 0')
  return errors
}
function networkNames(service) {
  return Object.keys(service?.networks||{})
}
export function validatePilotCompose(config) {
  const errors=[]
  if(config?.name!=='hi5central-pilot-control')errors.push('Unexpected project name')
  const services=config?.services||{}
  const names=Object.keys(services).sort()
  if(names.join(',')!==['admin','api','migrate','postgres','redis'].join(','))
    errors.push('Control stack must include exactly API, Admin, migrator, Postgres and Redis')
  const networkDef=config?.networks||{}
  if(networkDef.pilot_data?.internal!==true)
    errors.push('Pilot database bridge must be Docker-internal')
  if(networkDef.pilot_edge?.external!==true
    || networkDef.pilot_edge?.name!=='hi5central-pilot-control-edge')
    errors.push('Pilot edge must be a separate, explicitly created reviewed network')
  for(const [name,service] of Object.entries(services)){
    if(service.ports?.length || service.network_mode || service.privileged
      || service.pid || service.ipc || service.devices?.length
      || service.extra_hosts?.length || service.volumes?.some(v=>
        String(v.source||'').includes('/') || String(v.target||'').includes('docker.sock')))
      errors.push(name+' may not expose host ports, privileges or host filesystem')
    if(!digest.test(String(service.image||'')))errors.push(name+' requires image digest')
    const allowed=name==='api'?['pilot_data','pilot_edge']
      : name==='admin'?['pilot_edge']:['pilot_data']
    if(networkNames(service).sort().join(',')!==allowed.sort().join(','))
      errors.push(name+' network attachments violate isolation')
  }
  for(const name of ['postgres','redis']){
    if(networkNames(services[name]).includes('pilot_edge'))
      errors.push(name+' must never attach to gateway edge')
  }
  for(const key of Object.keys(networkDef)){
    if(!['pilot_edge','pilot_data'].includes(key))errors.push('Unexpected network '+key)
  }
  return errors
}
const script=fileURLToPath(import.meta.url)
if(process.argv[1]&&resolve(process.argv[1])===script) {
  console.error('Use preflight.mjs --check with protected environment and Compose config; no deployment is supported by this validator.')
  process.exit(2)
}
