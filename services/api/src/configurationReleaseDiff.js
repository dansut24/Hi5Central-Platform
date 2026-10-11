import {createHash} from 'node:crypto'

// These settings are deployment configuration, not operational tenant data.
// Connector credentials, billing details and account-specific secrets are never
// transferred by the generic configuration promoter.
const excludedAreas=new Set(['integrations','billing','users'])
const derivedFields=new Set(['mfaEnforcedAt'])
const sensitiveKey=/(secret|password|token|credential|private.?key|api.?key|refresh.?key|connection.?string|smtp|oauth|client.?secret|recovery.?code)/i
const MAX_DEPTH=12
const MAX_ITEMS=1200
const hasOwn=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key)
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const stable=value=>Array.isArray(value)
  ? value.map(stable)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value
const canonical=value=>JSON.stringify(stable(value))
export function valueDigest(value,exists=true) {
  return createHash('sha256').update(exists?'value:'+canonical(value):'missing').digest('hex')
}
export function valueAtPath(config,path) {
  let v=config
  for(const key of path) {
    if(!object(v)||!hasOwn(v,key))return {exists:false,value:null}
    v=v[key]
  }
  return {exists:true,value:v}
}
export function safeToPromote(path){
  if(!Array.isArray(path)||!path.length||path.length>MAX_DEPTH)return false
  if(!path.every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x)))return false
  if(excludedAreas.has(path[0])||path.some(x=>derivedFields.has(x)))return false
  return !path.some(key=>sensitiveKey.test(key))
}
export function differenceList(live,uat){
  const result=[]
  function visit(before,after,path=[]){
    if(result.length>=MAX_ITEMS)throw Error('Too many configuration differences to review safely.')
    if(path.length>MAX_DEPTH)throw Error('Configuration nesting exceeds the supported depth.')
    const oldObject=before.exists&&object(before.value)
    const newObject=after.exists&&object(after.value)
    if((oldObject||newObject)&&(!before.exists||!after.exists||oldObject===newObject)) {
      const keys=new Set([...Object.keys(oldObject?before.value:{}),...Object.keys(newObject?after.value:{})])
      for(const k of [...keys].sort()){
        const bp=oldObject&&hasOwn(before.value,k)?{exists:true,value:before.value[k]}:{exists:false,value:null}
        const ap=newObject&&hasOwn(after.value,k)?{exists:true,value:after.value[k]}:{exists:false,value:null}
        visit(bp,ap,[...path,k])
      }
      return
    }
    const beforeHash=valueDigest(before.value,before.exists)
    const afterHash=valueDigest(after.value,after.exists)
    if(beforeHash!==afterHash&&path.length){
      const canPromote=safeToPromote(path)
      result.push({
        path,id:path.join('.'),beforeHash,afterHash,
        promotable:canPromote,versionUpgradeRequired:false,
        // Only a boolean is safe to preview generically (never expose secrets).
        from:canPromote&&typeof before.value==='boolean'?before.value:null,
        to:canPromote&&typeof after.value==='boolean'?after.value:null,
      })
    }
  }
  visit({exists:true,value:live||{}},{exists:true,value:uat||{}})
  return result
}
export function setAtPath(config,path,newValue,exists=true){
  if(!safeToPromote(path))throw Error('This setting requires its own safe promotion handler.')
  const result=structuredClone(config||{})
  let cursor=result
  for(let i=0;i<path.length-1;i++){
    const key=path[i]
    if(!object(cursor[key]))cursor[key]={}
    cursor=cursor[key]
  }
  const last=path[path.length-1]
  if(exists)cursor[last]=structuredClone(newValue)
  else delete cursor[last]
  return result
}
export function applyReviewedChanges(live,uat,picks,now=new Date()){
  if(!Array.isArray(picks)||picks.length===0||picks.length>100)
    throw Error('Select between 1 and 100 tracked changes to promote.')
  const list=differenceList(live,uat)
  const byId=new Map(list.map(row=>[row.id,row]))
  const seen=new Set()
  let result=structuredClone(live||{})
  for(const pick of picks){
    const id=String(pick?.id||'')
    if(seen.has(id))throw Error('A change was selected more than once.')
    seen.add(id)
    const match=byId.get(id)
    if(!match||!match.promotable||pick?.beforeHash!==match.beforeHash||pick?.afterHash!==match.afterHash)
      throw Error('UAT or Production changed since this item was reviewed. Refresh and approve the latest values.')
    const source=valueAtPath(uat,match.path)
    result=setAtPath(result,match.path,source.value,source.exists)
  }
  // MFA security state is environment-specific even though policy is promotable.
  // When enabling in Production, its own enforcement clock begins on promotion.
  const wasRequired=live?.security?.requireMfa===true
  const required=result?.security?.requireMfa===true
  if(seen.has('security.requireMfa')){
    result.security.mfaEnforcedAt=required
      ? (wasRequired ? live?.security?.mfaEnforcedAt||now.toISOString():now.toISOString())
      : null
  }
  return result
}
