/** Strict, immutable image pairing for the shared new-signup/onboarding fallback. */
const SHA=/^[a-f0-9]{40}$/
const repository='ghcr.io/dansut24/hi5central-platform-'
export function sharedBaselineImages(source){
 if(typeof source!=='string')throw Error('Missing shared runtime compose source.')
 const result={}
 const lines=source.split('\n')
 for(const [service,kind] of [['api','api'],['itsm','itsm']]){
  const starts=lines.map((l,i)=>l==='  '+service+':'?i:-1).filter(i=>i>=0)
  if(starts.length!==1)throw Error('Shared service '+service+' declaration missing or ambiguous.')
  const st=starts[0]
  let end=st+1
  while(end<lines.length&&!/^  [a-zA-Z0-9_-]+:$/.test(lines[end]))end++
  const expected='    image: '+repository+kind+':sha-'
  const images=lines.slice(st+1,end).filter(l=>l.startsWith(expected))
  if(images.length!==1||!SHA.test(images[0].slice(expected.length)))
    throw Error('Expected exactly one immutable shared '+service+' image.')
  result[service]=images[0].slice(expected.length)
 }
 if(result.api!==result.itsm)throw Error('Shared onboarding API/frontend image versions differ.')
 return result
}
export function replaceSharedBaselineImages(source,approvedSha){
 if(!SHA.test(String(approvedSha||'')))throw Error('A certified immutable SHA40 is required.')
 const current=sharedBaselineImages(source)
 if(current.api===approvedSha)return {changed:false,source,previousSha:approvedSha}
 let updated=source
 for(const [service,kind] of [['api','api'],['itsm','itsm']]){
  const previous='    image: '+repository+kind+':sha-'+current[service]
  const next='    image: '+repository+kind+':sha-'+approvedSha
  // Replace only the known shared service declaration, not any other stage.
  const lines=updated.split('\n')
  const start=lines.indexOf('  '+service+':')
  let end=start+1
  while(end<lines.length&&!/^  [a-zA-Z0-9_-]+:$/.test(lines[end]))end++
  const positions=[]
  for(let i=start+1;i<end;i++)if(lines[i]===previous)positions.push(i)
  if(positions.length!==1)throw Error('Shared service image changed during approval.')
  lines[positions[0]]=next
  updated=lines.join('\n')
 }
 if(sharedBaselineImages(updated).api!==approvedSha)
  throw Error('Unable to plan exact shared onboarding build.')
 return {changed:true,source:updated,previousSha:current.api}
}
