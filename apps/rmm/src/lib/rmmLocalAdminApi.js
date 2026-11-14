const base='/api/v1/rmm/local-admin'
const root=window.__HI5_API_BASE__||''
async function request(path,options={}) {
  const response=await fetch(root+base+path,{
    credentials:'include',cache:'no-store',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})},
  })
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(body.error||'Local administrator vault request failed.')
  return body
}
export const localAdminApi={
  list:()=>request('/accounts'),
  enrol:(deviceId,name)=>request('/accounts',{method:'POST',body:JSON.stringify({agentDeviceId:deviceId,name})}),
  rotate:(accountId,reason)=>request('/accounts/'+encodeURIComponent(accountId)+'/rotate',{method:'POST',body:JSON.stringify({reason})}),
  history:(accountId)=>request('/accounts/'+encodeURIComponent(accountId)+'/rotations'),
  reveal:(accountId,rotationId,reason)=>request('/accounts/'+encodeURIComponent(accountId)+'/rotations/'+encodeURIComponent(rotationId)+'/reveal',{method:'POST',body:JSON.stringify({reason})}),
}
