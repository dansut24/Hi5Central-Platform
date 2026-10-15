import {createHash} from 'node:crypto'

const HOST=/^[a-z0-9](?:[a-z0-9-]{1,50}[a-z0-9])?[.]hi5central[.]com$/
const SHA=/^[a-f0-9]{40}$/
const ENV=new Set(['test','uat','live'])
export const routeDigest=value=>createHash('sha256').update(value).digest('hex')
export const releasePair=sha=>({
  api:'hi5pool-'+sha.slice(0,12)+'-api',
  web:'hi5pool-'+sha.slice(0,12)+'-web',
})
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
  let base=config
  const first=base.indexOf(begin),last=base.indexOf(end)
  if((first<0)!==(last<0))throw Error('Unpaired tenant route markers.')
  if(first>=0){
    if(base.indexOf(begin,first+begin.length)>=0||base.indexOf(end,last+end.length)>=0)
      throw Error('Duplicate tenant route markers.')
    const left=base.lastIndexOf('\n',first-1)+1
    const right=base.indexOf('\n',last)
    if(right<0||right-left>1300)throw Error('Untrusted previous route boundaries.')
    base=base.slice(0,left)+base.slice(right+1)
  }
  const pair=releasePair(buildSha)
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
  const next=base.replace(anchor,environment==='live'?block+anchor:anchor+'\n'+block)
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
  const anchor=original.includes('http://test.hi5central.com {')?
    'http://test.hi5central.com {':original.includes('http://uat.hi5central.com {')?
      'http://uat.hi5central.com {':
      '    # Isolated QA onboarding recovery frontend; other customers untouched.'
  if(result.clean.split(anchor).length!==2)throw Error('Peer gateway structure has changed.')
  return result.clean.replace(anchor,anchor.includes('http://')?
    anchor+'\n'+prior.block:prior.block+anchor)
}
