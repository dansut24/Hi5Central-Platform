const REQUIRED_RUNTIME = [
  'DEPLOYMENT_MODE','TENANCY_MODE','RUNTIME_ENVIRONMENT','ROOT_DOMAIN',
  'COMPOSE_PROJECT_NAME','EDGE_NETWORK','API_URL','MARKETING_URL',
  'DATABASE_URL','REDIS_URL','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD',
  'REDIS_PASSWORD','MFA_ENCRYPTION_KEY',
  'POSTGRES_IMAGE','REDIS_IMAGE','API_IMAGE','ITSM_IMAGE',
]
const shaImage = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/

export function parseEnvironment(text) {
  const values={}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line=rawLine.trim()
    if(!line || line.startsWith('#')) continue
    const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if(!m) throw new Error('Invalid runtime.env line or shell directive; use KEY=value syntax.')
    if(Object.hasOwn(values,m[1])) throw new Error('Duplicate configuration key: '+m[1])
    let value=m[2]
    if (value.startsWith('"') && value.endsWith('"')) {
      value=JSON.parse(value)
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value=value.slice(1,-1)
    }
    if (/\$\{|\$\(/.test(value)) throw new Error('Environment interpolation and shell substitution are forbidden.')
    values[m[1]]=value
  }
  return values
}

function parseUrl(value, allowedProtocols, error, errors) {
  try {
    const u = new URL(value)
    if(!allowedProtocols.includes(u.protocol) || u.search || u.hash) {
      errors.push(error);return null
    }
    return u
  } catch { errors.push(error);return null }
}

export function validateSandboxEnvironment(v, peer=null) {
  const errors=[]
  for(const key of REQUIRED_RUNTIME) if(!String(v[key]??'').trim()) errors.push(key+' is required')
  const env=v.RUNTIME_ENVIRONMENT
  if(!['uat','test'].includes(env)) errors.push('RUNTIME_ENVIRONMENT must be uat or test')
  if(v.DEPLOYMENT_MODE!=='managed' || v.TENANCY_MODE!=='multi') errors.push('Managed multi-tenant mode is mandatory')
  if(v.COMPOSE_PROJECT_NAME!==`hi5-sandbox-${env}`) errors.push('Unexpected Compose project for the specified environment')
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v.ROOT_DOMAIN||''))) errors.push('ROOT_DOMAIN must be a DNS domain')
  if(v.EDGE_NETWORK!==`hi5central-sandbox-${env}-edge`) errors.push('EDGE_NETWORK must be dedicated to the selected UAT/Test runtime')
  if(v.BACKGROUND_WORKERS_ENABLED!=='false') errors.push('Background workers must remain disabled for this pilot')
  if(v.COOKIE_DOMAIN) errors.push('COOKIE_DOMAIN must be empty (host-only cookies)')
  if(v.APP_URL || v.PORTAL_URL || v.RMM_URL || v.ADMIN_URL) errors.push('Global APP/Portal/RMM/Admin URLs must not be set for shared sandboxes')
  if(v.PRIMARY_TENANT_SLUG) errors.push('A shared managed sandbox must not use PRIMARY_TENANT_SLUG')
  if(env==='uat' && v.FEATURE_MODE!=='controlled') errors.push('UAT must use controlled features')
  if(env==='test' && !['controlled','all_enabled'].includes(v.FEATURE_MODE)) errors.push('Invalid Test feature mode')
  // Parallel pilots cannot reuse existing canonical UAT/Test API hosts,
  // which are still owned by the live legacy single-tenant gateways.
  const routeChannel=v.SANDBOX_ROUTE_CHANNEL || 'canonical'
  if(!['canonical','parallel'].includes(routeChannel)) errors.push('Unsupported sandbox route channel')
  const expectedApiHost=routeChannel==='parallel'
    ? `pilot-${env}-api.${v.ROOT_DOMAIN}`
    : `${env}-api.${v.ROOT_DOMAIN}`
  if(v.API_URL!==`https://${expectedApiHost}`) errors.push('API_URL does not match sandbox route channel and environment')
  if(v.MARKETING_URL!==`https://${v.ROOT_DOMAIN}`) errors.push('Marketing URL must not redirect through an environment workspace')
  for(const key of ['POSTGRES_IMAGE','REDIS_IMAGE','API_IMAGE','ITSM_IMAGE']) {
    if(!shaImage.test(String(v[key]||''))) errors.push(key+' must use a sha256 digest, never latest/dev or mutable tag')
  }
  if(!String(v.POSTGRES_IMAGE||'').startsWith('public.ecr.aws/docker/library/postgres@sha256:')) errors.push('PostgreSQL must come from the reviewed official mirror')
  if(!String(v.REDIS_IMAGE||'').startsWith('public.ecr.aws/docker/library/redis@sha256:')) errors.push('Redis must come from the reviewed official mirror')
  if(!String(v.API_IMAGE||'').startsWith('ghcr.io/dansut24/hi5central-platform-api@sha256:')) errors.push('Unexpected API image repository')
  if(!String(v.ITSM_IMAGE||'').startsWith('ghcr.io/dansut24/hi5central-platform-itsm@sha256:')) errors.push('Unexpected ITSM image repository')
  for(const key of ['POSTGRES_PASSWORD','REDIS_PASSWORD','MFA_ENCRYPTION_KEY']) {
    if(String(v[key]||'').length<32) errors.push(key+' must be a unique high-entropy secret')
  }
  if(v.REDIS_PASSWORD === v.POSTGRES_PASSWORD || v.MFA_ENCRYPTION_KEY===v.REDIS_PASSWORD
    || v.MFA_ENCRYPTION_KEY===v.POSTGRES_PASSWORD) errors.push('The database, Redis and MFA secrets must be distinct')

  const db=parseUrl(v.DATABASE_URL,['postgres:','postgresql:'],'DATABASE_URL must be a valid local PostgreSQL DSN',errors)
  if(db){
    if(db.hostname!=='postgres' || (db.port && db.port!=='5432') || db.pathname!==`/${v.POSTGRES_DB}`
      || decodeURIComponent(db.username)!==v.POSTGRES_USER
      || decodeURIComponent(db.password)!==v.POSTGRES_PASSWORD) {
      errors.push('Database URL must target private postgres:5432 with matching sandbox credentials')
    }
  }
  const redis=parseUrl(v.REDIS_URL,['redis:'],'REDIS_URL must be a valid local Redis DSN',errors)
  if(redis){
    if(redis.hostname!=='redis' || (redis.port && redis.port!=='6379')
      || !['','/0'].includes(redis.pathname) || redis.username
      || decodeURIComponent(redis.password)!==v.REDIS_PASSWORD) {
      errors.push('Redis URL must target private redis:6379/0 with matching sandbox credentials')
    }
  }
  if(peer){
    if(peer.RUNTIME_ENVIRONMENT===env || !['uat','test'].includes(peer.RUNTIME_ENVIRONMENT)) errors.push('Peer must describe the other sandbox environment')
    for(const key of ['COMPOSE_PROJECT_NAME','EDGE_NETWORK','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD',
      'REDIS_PASSWORD','MFA_ENCRYPTION_KEY','DATABASE_URL','REDIS_URL','API_URL']) {
      if(v[key]===peer[key]) errors.push('UAT and Test must not reuse '+key)
    }
    if(peer.ROOT_DOMAIN!==v.ROOT_DOMAIN) errors.push('Peer root domain mismatch')
  }
  return errors
}

export function validateComposeGraph(config, env) {
  const errors=[]
  const services=config?.services || {}
  const expected=['postgres','redis','migrate','api','itsm']
  if(Object.keys(services).sort().join(',')!==expected.sort().join(',')) errors.push('Unexpected container service in pilot stack')
  if(config?.name!==env.COMPOSE_PROJECT_NAME) errors.push('Unexpected project name after Compose interpolation')
  const net=config?.networks||{}
  if(net.private_data?.internal!==true) errors.push('Private database network must be internal')
  if(net.managed_edge?.external!==true || net.managed_edge?.name!==env.EDGE_NETWORK) errors.push('Edge must reference the reviewed external reverse-proxy network')
  for(const [name,service] of Object.entries(services)){
    if(service.ports?.length || service.network_mode || service.privileged || service.pid || service.devices?.length || service.container_name) {
      errors.push(name+' must not publish ports or enable host access')
    }
    const names=Object.keys(service.networks||{}).sort()
    const expectedNetworks=(name==='api'?['managed_edge','private_data']
      :name==='itsm'?['managed_edge']:['private_data']).sort()
    if(names.join(',')!==expectedNetworks.join(',')) errors.push(name+' network isolation mismatch')
  }
  for(const name of ['postgres','redis']){
    if((services[name]?.volumes||[]).some(x=>x.type!=='volume')) errors.push(name+' must use named storage, not host paths')
    if(!services[name]?.healthcheck) errors.push(name+' health check required')
  }
  if(services.api?.image!==env.API_IMAGE || services.migrate?.image!==env.API_IMAGE
    || services.itsm?.image!==env.ITSM_IMAGE) errors.push('API, migration and frontend must match approved image digests')
  if((services.itsm?.environment||{}).RMM_URL) errors.push('RMM remains disabled in pilot')
  if((services.itsm?.environment||{}).API_URL!==env.API_URL) errors.push('Frontend API must match isolated API origin')
  return errors
}
