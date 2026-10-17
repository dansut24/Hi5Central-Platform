import {createHash} from 'node:crypto'

export const QA_HOSTS=new Map([
  ['h5c-managed-qa26-test.hi5central.com','qaRealCandidate'],
  ['h5c-custom-qa26-test.hi5central.com','qaRealCandidateCustom'],
])
export const checksum=text=>createHash('sha256').update(text).digest('hex')

/**
 * Remove one allowlisted tenant's Caddy handle without changing any peer
 * routing. Pure function: never writes Docker, files, database or Caddy.
 */
export function removeQaTenantVersionOverride({config,host}={}){
  if(!QA_HOSTS.has(host))throw Error('Only QA26 Test tenant routes are supported.')
  if(typeof config!=='string'||!config.includes('http://test.hi5central.com {'))
    throw Error('Unexpected shared Test gateway config.')
  const matcher=QA_HOSTS.get(host)
  const header='  @'+matcher+' header X-Forwarded-Host '+host
  const lines=config.split('\n')
  const matches=[]
  for(let i=0;i<lines.length;i++)if(lines[i]===header)matches.push(i)
  if(matches.length!==1)throw Error('Exactly one current tenant override is required.')
  const at=matches[0]
  if(lines[at+1]!=='  handle @'+matcher+' {')
    throw Error('Tenant override has an unexpected handle structure.')
  let depth=0,end=-1
  for(let i=at+1;i<lines.length;i++){
    const line=lines[i].trim()
    if(line.endsWith('{'))depth++
    if(line==='}')depth--
    if(depth===0){end=i;break}
    if(depth<0)throw Error('Unbalanced Caddy route block.')
  }
  if(end<0||end>at+17||lines[end]!=='  }')
    throw Error('Tenant override is not a recognized bounded route block.')
  if(!lines.slice(at+2,end).some(line=>line.includes('reverse_proxy hi5pool-test-')))
    throw Error('Expected immutable QA runtime pool missing.')
  let start=at
  if(start>0&&/^  # (QA-only exact tenant release|TEST ONLY: one tenant)/.test(lines[start-1]))start--
  const retained=lines.slice(0,start).concat(lines.slice(end+1)).join('\n')
  if(!retained.includes('http://test.hi5central.com {'))
    throw Error('Core gateway site would be removed.')
  for(const [peer,peerMatcher] of QA_HOSTS)
    if(peer!==host&&config.includes('X-Forwarded-Host '+peer)
      && !retained.includes('  @'+peerMatcher+' header X-Forwarded-Host '+peer))
      throw Error('Peer tenant routing changed.')
  return {
    host,matcher,
    previousSha256:checksum(config),
    candidateSha256:checksum(retained),
    config:retained,
    removedBlock:lines.slice(start,end+1).join('\n'),
  }
}

/**
 * Restore exactly one tenant's previous route from its own saved gateway
 * snapshot. Keep every other tenant's *current* route (not the snapshot
 * version). Essential when one tenant rolls back after peers have updated.
 */
export function restoreQaTenantFromSnapshot({current,snapshot,host}={}){
  if(!QA_HOSTS.has(host))throw Error('Only QA26 Test tenant routes are supported.')
  if(typeof current!=='string'||typeof snapshot!=='string')
    throw Error('Both actual and saved Caddyfile sources are required.')
  const marker='  @'+QA_HOSTS.get(host)+' header X-Forwarded-Host '+host
  const currentOverride=current.includes(marker)
    ?removeQaTenantVersionOverride({config:current,host}):null
  const snapshotOverride=snapshot.includes(marker)
    ?removeQaTenantVersionOverride({config:snapshot,host}):null
  if(!currentOverride)throw Error('Target currently lacks a version override.')
  const clean=currentOverride.config
  const anchor='http://test.hi5central.com {'
  if(clean.split(anchor).length!==2)
    throw Error('Cannot safely place the restored tenant-specific route.')
  const restored=snapshotOverride?.removedBlock
    ?clean.replace(anchor,anchor+'\n'+snapshotOverride.removedBlock)
    :clean
  const peer=[...QA_HOSTS.keys()].find(v=>v!==host)
  const pMarker='  @'+QA_HOSTS.get(peer)+' header X-Forwarded-Host '+peer
  if(current.includes(pMarker)!==restored.includes(pMarker))
    throw Error('Rollback would affect an independently deployed peer.')
  if(restored===current)throw Error('Rollback would be a no-op.')
  return {host,config:restored,
    originalSha256:checksum(current),
    restoredSha256:checksum(restored),
    previousRoute:snapshotOverride?.removedBlock||null}
}
