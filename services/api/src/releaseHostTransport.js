import net from 'node:net'
const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SLUG=/^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])?$/
export const HOST_MODES=Object.freeze(['stage','apply','restore','confirm','pool_health'])
export function validateHostRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||!HOST_MODES.includes(input.mode)
  ||!['test','uat','live'].includes(input.environment)
  ||!SHA.test(String(input.sha||'')))
  throw Error('A bounded host action, environment and exact immutable SHA are required.')
 const mode=input.mode
 if(mode==='pool_health')return {mode,environment:input.environment,sha:input.sha}
 if(!SLUG.test(String(input.slug||''))||!UUID.test(String(input.jobId||'')))
  throw Error('A specific tenant and durable release job are required.')
 if(mode==='stage'&&input.environment!=='live')
  throw Error('Only Custom UAT may pre-stage a Live candidate.')
 if(mode==='apply'||mode==='restore'||mode==='stage'){
  if(!UUID.test(String(input.leaseToken||''))
   ||!Number.isSafeInteger(Number(input.leaseFence))||Number(input.leaseFence)<1)
   throw Error('A current fenced database lease is required.')
 }
 if(['restore','confirm'].includes(mode)
  &&(!/^[a-z0-9-]{20,180}$/.test(String(input.backup||''))))
  throw Error('A bounded tenant-specific recovery snapshot is required.')
 return {mode,environment:input.environment,slug:input.slug,sha:input.sha,
  jobId:input.jobId,leaseToken:input.leaseToken||null,
  leaseFence:Number(input.leaseFence)||null,backup:input.backup||null}
}
/** No shell or Docker access inside the generic upgrade worker. Only a
 * non-network Unix socket to an independently fenced host adapter.
 */
export async function requestTrustedHostAction(input,{
 socketPath=process.env.H5C_RELEASE_HOST_SOCKET||'/run/hi5central-release/host.sock',
 timeoutMs=330000,
}={}){
 const data=validateHostRequest(input)
 if(typeof socketPath!=='string'||!socketPath.startsWith('/')
   ||socketPath.length>200||timeoutMs<1000||timeoutMs>360000)
  throw Error('Trusted host transport is not configured.')
 return new Promise((resolve,reject)=>{
  let buffer='',done=false
  const socket=net.createConnection({path:socketPath})
  const settle=(error,result)=>{
   if(done)return;done=true;clearTimeout(timer);socket.destroy()
   if(error)reject(error);else resolve(result)
  }
  const timer=setTimeout(()=>settle(Error('Trusted host action timed out.')),timeoutMs)
  socket.setEncoding('utf8')
  socket.on('connect',()=>socket.write(JSON.stringify(data)+'\n'))
  socket.on('data',chunk=>{
   buffer+=chunk
   if(buffer.length>16000)return settle(Error('Invalid oversized host response.'))
   const nl=buffer.indexOf('\n')
   if(nl<0)return
   try{
    const response=JSON.parse(buffer.slice(0,nl))
    if(response.ok!==true||!response.proof)
     return settle(Error(String(response.error||'Trusted host action refused.').slice(0,400)))
    settle(null,response.proof)
   }catch{settle(Error('Trusted host response was not valid JSON.'))}
  })
  socket.on('error',error=>settle(Error('Trusted host transport unavailable: '+error.code)))
  socket.on('end',()=>{if(!done)settle(Error('Trusted host connection closed without proof.'))})
 })
}
