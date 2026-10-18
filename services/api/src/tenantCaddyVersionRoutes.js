import {createHash} from 'node:crypto'

const HOST=/^[a-z0-9](?:[a-z0-9-]{1,50}[a-z0-9])?[.]hi5central[.]com$/
const SHA=/^[a-f0-9]{40}$/
const ENV=new Set(['test','uat','live'])
export const routeDigest=value=>createHash('sha256').update(value).digest('hex')
export const releasePair=(sha,environment)=>{
  if(!SHA.test(String(sha||''))||!ENV.has(environment))throw Error('Invalid versioned pool identity.')
  return {api:'hi5pool-'+environment+'-'+sha.slice(0,12)+'-api',
    web:'hi5pool-'+environment+'-'+sha.slice(0,12)+'-web'}
}
/**
 * Pure tenant-scoped Caddy change. No Docker, database or files.
 * Repeated updates replace only that tenant's tagged block.
 */
export function prepareTenantCaddyRoute({config,tenantSlug,environment,buildSha}={}){
  if(!/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?$/.test(String(tenantSlug||''))||
    !ENV.has(environment)||!SHA.test(String(buildSha||'')))
    throw Error('Invalid tenant, environment or immutable release.')
  const host=tenantSlug+(environment==='live'?'':'-'+environment)+'.hi5central.com'
  if(!HOST.test(host)||typeof config!=='string')throw Error('Unsafe hostname or Caddy source.')
  const anchor=environment==='live'?
    '    # Isolated QA onboarding recovery frontend; other customers untouched.':
    environment==='uat'?'http://uat.hi5central.com {':'http://test.hi5central.com {'
  if(config.split(anchor).length!==2)
    throw Error('Gateway changed since its known environment route was validated.')
  const begin='# H5C_RELEASE_ROUTE_BEGIN '+host
  const end='# H5C_RELEASE_ROUTE_END '+host
  const first=config.indexOf(begin),last=config.indexOf(end)
  let previous=null
  if((first<0)!==(last<0))throw Error('Unpaired tenant route markers.')
  if(first>=0){
    if(config.indexOf(begin,first+begin.length)>=0||config.indexOf(end,last+end.length)>=0)
      throw Error('Duplicate tenant route markers.')
    const left=config.lastIndexOf('\n',first-1)+1
    const right=config.indexOf('\n',last)
    if(right<0||right-left>1300)throw Error('Untrusted previous route boundaries.')
    previous={left,right}
  }
  const pair=releasePair(buildSha,environment)
  const key='h5cRelease'+routeDigest(host).slice(0,12)
  const p=environment==='live'?'    ':'  '
  const matcher=environment==='live'?'host '+host:'header X-Forwarded-Host '+host
  const block=[
    p+begin,
    p+'@'+key+' '+matcher,
    p+'handle @'+key+' {',
    p+'    @'+key+'Api path /api/*',
    p+'    handle @'+key+'Api {',
    p+'        reverse_proxy '+pair.api+':3001',
    p+'    }',
    p+'    handle {',
    p+'        reverse_proxy '+pair.web+':80',
    p+'    }',
    p+'}',
    p+end,
  ].join('\n')+'\n'
  const next=previous?
    config.slice(0,previous.left)+block+config.slice(previous.right+1):
    config.replace(anchor,environment==='live'?block+anchor:anchor+'\n'+block.trimEnd())
  if(next===config)throw Error('Empty route change.')
  return {host,environment,buildSha,api:pair.api,web:pair.web,
    originalSha256:routeDigest(config),newSha256:routeDigest(next),
    config:next,previousConfig:config,routeMarker:begin}
}
/**
 * Remove the target's tagged block and restore its previous tagged block (if
 * present in snapshot) without reverting any unrelated customer's routing.
 */
export function undoTenantCaddyRoute({current,original,host}={}){
  if(!HOST.test(String(host||''))||typeof current!=='string'||typeof original!=='string')
    throw Error('A verified shared gateway snapshot and hostname are required.')
  const begin='# H5C_RELEASE_ROUTE_BEGIN '+host
  const end='# H5C_RELEASE_ROUTE_END '+host
  const extract=text=>{
    const start=text.indexOf(begin),last=text.indexOf(end)
    if(start<0||last<start||text.indexOf(begin,start+begin.length)>=0)
      throw Error('Cannot isolate target tenant route for rollback.')
    const left=text.lastIndexOf('\n',start-1)+1
    const right=text.indexOf('\n',last)
    if(right<0||right-left>1300)throw Error('Untrusted target route block.')
    return {clean:text.slice(0,left)+text.slice(right+1),
      block:text.slice(left,right+1)}
  }
  const result=extract(current)
  if(!original.includes(begin))return result.clean
  const prior=extract(original)
  const first=current.indexOf(begin)
  const left=current.lastIndexOf('\n',first-1)+1
  const right=current.indexOf('\n',current.indexOf(end))
  if(right<0)throw Error('Missing target block line boundary.')
  return current.slice(0,left)+prior.block+current.slice(right+1)
}

/**
 * Clean-install shared gateway: one wildcard Caddy entrypoint for real tenant
 * Test/UAT/Production routes. No QA gateway, frozen canary or old host pools.
 * A release changes ONLY the exact tenant marker inside the shared gateway.
 */
export function prepareSharedTenantCaddyRoute({config,tenantSlug,environment,buildSha}={}){
  const slug=String(tenantSlug||'')
  if(!/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?$/.test(slug)
    ||!ENV.has(environment)||!SHA.test(String(buildSha||'')))
    throw Error('Invalid tenant, environment or immutable release.')
  if(typeof config!=='string')throw Error('Missing shared gateway configuration.')
  const anchor='  # H5C_RELEASE_ROUTE_INSERT'
  if(config.split(anchor).length!==2)throw Error('Shared Caddy tenant-route insertion anchor is missing or duplicated.')
  const host=slug+(environment==='live'?'':'-'+environment)+'.hi5central.com'
  if(!HOST.test(host))throw Error('Unsafe tenant hostname.')
  const begin='  # H5C_RELEASE_ROUTE_BEGIN '+host
  const end='  # H5C_RELEASE_ROUTE_END '+host
  const starts=config.indexOf(begin)
  const ends=config.indexOf(end)
  if((starts<0)!==(ends<0))throw Error('Partial existing route marker.')
  if(starts>=0&&(config.indexOf(begin,starts+begin.length)>=0
    ||config.indexOf(end,ends+end.length)>=0))
    throw Error('Duplicate existing tenant route markers.')
  const pair=releasePair(buildSha,environment)
  const token=routeDigest(host).slice(0,12)
  const block=[
    begin,
    '  @h5cTenant'+token+' host '+host,
    '  handle @h5cTenant'+token+' {',
    '    @h5cApi'+token+' path /api/*',
    '    handle @h5cApi'+token+' {',
    '      reverse_proxy '+pair.api+':3001',
    '    }',
    '    handle {',
    '      reverse_proxy '+pair.web+':80',
    '    }',
    '  }',
    end,
  ].join('\n')
  let clean=config
  if(starts>=0){
    const right=config.indexOf('\n',ends+end.length)
    if(right<0||right-starts>1500)throw Error('Existing tenant route boundary invalid.')
    clean=config.slice(0,starts)+config.slice(right+1)
  }
  const next=clean.replace(anchor,block+'\n'+anchor)
  return {host,environment,buildSha,api:pair.api,web:pair.web,
    originalSha256:routeDigest(config),newSha256:routeDigest(next),
    config:next,previousConfig:config}
}
