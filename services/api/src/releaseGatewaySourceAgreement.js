import {createHash} from 'node:crypto'
const digest=body=>createHash('sha256').update(String(body)).digest('hex')
const canonical=value=>Array.isArray(value)?value.map(canonical):
 value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))
 :value
const json=raw=>{
 try{
  const value=typeof raw==='string'?JSON.parse(raw):raw
  if(!value||typeof value!=='object'||Array.isArray(value)
     ||!value.apps?.http?.servers)return null
  return JSON.stringify(canonical(value))
 }catch{return null}
}
/** All three sources must agree. Ignore JSON key order, never route order. */
export function verifyReleaseGatewaySourceAgreement({hostSource,mountedSource,
 adaptedRuntime,loadedRuntime}={}){
 if(typeof hostSource!=='string'||typeof mountedSource!=='string'
  ||!hostSource.length||!mountedSource.length)
  return {agreed:false,reason:'Missing host or mounted gateway Caddyfile.'}
 const hostSha256=digest(hostSource),mountedSha256=digest(mountedSource)
 if(hostSha256!==mountedSha256)
  return {agreed:false,reason:'Host and mounted gateway sources differ.',
   hostSha256,mountedSha256,loadedMatchesMounted:null}
 const adapted=json(adaptedRuntime),loaded=json(loadedRuntime)
 if(!adapted||!loaded)
  return {agreed:false,reason:'Active runtime or adapted gateway JSON unavailable.',
   hostSha256,mountedSha256,loadedMatchesMounted:false}
 const sourceRuntimeSha256=digest(adapted),activeRuntimeSha256=digest(loaded)
 if(sourceRuntimeSha256!==activeRuntimeSha256)
  return {agreed:false,reason:'Currently loaded Caddy routes differ from the mounted source.',
   hostSha256,mountedSha256,sourceRuntimeSha256,activeRuntimeSha256,
   loadedMatchesMounted:false}
 return {agreed:true,reason:'Host, mount and live runtime match.',
  hostSha256,mountedSha256,sourceRuntimeSha256,activeRuntimeSha256,
  loadedMatchesMounted:true}
}
