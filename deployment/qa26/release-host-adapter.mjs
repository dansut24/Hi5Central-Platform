#!/usr/bin/env node
/**
 * Trusted VPS-only adapter for a generic tenant upgrade worker.
 * Exposes a group-restricted Unix socket, never HTTP or the Docker socket.
 * Every mutable request is checked AGAIN against real control-plane leases.
 * The only child executable is the pinned tenant host cutover script.
 * Runs in a separate host-side container with Docker authority; planners and
 * generic executor containers NEVER receive /var/run/docker.sock.
 */
import net from 'node:net'
import {spawn} from 'node:child_process'
import {existsSync,mkdirSync,lstatSync,unlinkSync,chmodSync,chownSync} from 'node:fs'
import {dirname} from 'node:path'
import {validateHostRequest} from '../../services/api/src/releaseHostTransport.js'

const SOCKET=process.env.H5C_RELEASE_HOST_SOCKET||'/run/hi5central-release/host.sock'
const GID=Number(process.env.H5C_RELEASE_HOST_GROUP_ID||10002)
if(!SOCKET.startsWith('/run/hi5central-release/')||SOCKET.length>150
 ||!Number.isSafeInteger(GID)||GID<100||GID>65535)
 throw Error('Trusted host adapter requires a fixed private Unix socket and assigned group.')
if(process.getuid?.()!==0)throw Error('Host adapter must run in the isolated trusted Docker authority container.')
const queue=new Set()
const maxOutput=20000
const readJson=x=>JSON.parse(String(x).trim().split('\n').at(-1))

async function execute(command,args,timeout=30000){
 return new Promise((resolve,reject)=>{
  const proc=spawn(command,args,{env:{...process.env},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',done=false
  const timer=setTimeout(()=>{proc.kill('SIGKILL');if(!done){done=true;reject(Error('Trusted host command deadline exceeded.'))}},timeout)
  proc.stdout.on('data',part=>{stdout+=part;if(stdout.length>maxOutput)proc.kill('SIGKILL')})
  proc.stderr.on('data',part=>{stderr+=part;if(stderr.length>maxOutput)proc.kill('SIGKILL')})
  proc.on('error',error=>{if(!done){done=true;clearTimeout(timer);reject(error)}})
  proc.on('close',code=>{
   clearTimeout(timer)
   if(done)return
   done=true
   if(code!==0)return reject(Error('Trusted host command denied: '+stderr.slice(-350)))
   resolve(stdout)
  })
 })
}
async function queryPostgres(sql){
 // Identifier and version values were strictly validated by the socket
 // contract. No user-controlled shell tokens or arbitrary SQL are accepted.
 const output=await execute('docker',['exec','hi5central-postgres','sh','-c',
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "'+sql+'"'],12000)
 return output.trim()
}
async function authorise(request){
 if(request.mode==='pool_health')return
 const {jobId,sha,slug,environment,leaseToken,leaseFence,mode}=request
 const liveStage=mode==='stage'
 const jobEnvironment=liveStage?'uat':environment
 const checkLease=mode==='apply'||mode==='restore'||liveStage
 const lease=checkLease
  ?["j.status='running'","j.lease_token='"+leaseToken+"'",
    'j.lease_fence='+leaseFence,'j.lease_expires_at>now()'].join(' AND ')
  :["j.status='succeeded'","j.completed_at IS NOT NULL",
    'EXISTS (SELECT 1 FROM tenant_release_rollout_events e WHERE e.job_id=j.id',
    "AND e.event_type='verified' AND e.fence=j.lease_fence)"].join(' AND ')
 const scoped=checkLease?[
  'JOIN platform_certified_application_releases c ON c.build_sha=j.build_sha',
  'JOIN platform_release_generic_stage_approvals a ON a.build_sha=j.build_sha',
  "AND a.environment=j.environment AND a.planning_enabled=true AND a.execution_enabled=true",
  'AND a.approved_at<=now() AND a.expires_at>now()',
  'AND a.approved_by IS NOT NULL',
 ]:[]
 const eligibility=checkLease?[
  "AND c.status='approved'",
  'AND public.hi5_release_generic_tenant_permitted(j.tenant_id)=true',
  ...(mode==='restore'?[]:["AND (SELECT paused=false FROM platform_release_rollout_control WHERE singleton=true)"]),
  ...(liveStage?["AND p.update_mode='admin_controlled' AND p.uat_auto_stage=true"]:[]),
  ...(mode==='apply'&&environment==='live'?[
   "AND (p.update_mode='hi5_managed' OR EXISTS (",
   'SELECT 1 FROM tenant_runtime_update_offers o',
   "WHERE o.tenant_id=j.tenant_id AND o.environment='live'",
   "AND o.build_sha=j.build_sha AND o.state='scheduled'",
   'AND o.promotion_approved_by IS NOT NULL))',
  ]:[]),
 ]:[]
 const query=[
  'SELECT CASE WHEN EXISTS(SELECT 1 FROM tenant_release_rollout_jobs j',
  'JOIN tenants t ON t.id=j.tenant_id',
  'JOIN tenant_release_preferences p ON p.tenant_id=j.tenant_id',
  ...scoped,
  "WHERE j.id='"+jobId+"'::uuid",
  "AND j.environment='"+jobEnvironment+"'",
  "AND j.build_sha='"+sha+"' AND t.slug='"+slug+"'",
  "AND t.status='active' AND "+lease,
  ...eligibility,") THEN 'ALLOW' ELSE 'DENY' END",
 ].join(' ')
 if(await queryPostgres(query)!=='ALLOW')
  throw Error('Release job is not independently authorised for this exact tenant, SHA and host stage.')
}
async function checkPool({environment,sha}){
 const prefix='hi5pool-'+environment+'-'+sha.slice(0,12)
 const names=[prefix+'-api',prefix+'-web']
 try{
  // Inspect only four bounded non-secret fields. Never transmit Docker
  // inspection JSON (which may include sensitive container environment).
  const output=await execute('docker',['inspect','--format',
   '{{.Name}}|{{.State.Running}}|{{.State.Health.Status}}|{{.Config.Image}}',...names],10000)
  const lines=output.trim().split('\n')
  return {status:'pool_health',healthy:lines.length===2&&lines.every((line,i)=>{
    const [name,running,health,image]=line.split('|')
    return name==='/'+names[i]&&running==='true'&&health==='healthy'
     &&image?.endsWith(':sha-'+sha)===true
   }),environment,buildSha:sha}
 }catch{return {status:'pool_health',healthy:false,environment,buildSha:sha}}
}
async function runAction(request){
 if(request.mode==='pool_health')return checkPool(request)
 await authorise(request)
 const args=[request.environment,request.slug,request.sha,'--'+request.mode]
 if(request.backup)args.push(request.backup)
 const timeout=request.mode==='confirm'?25000:request.mode==='restore'?90000:330000
 const childEnv={
  H5C_RELEASE_JOB_ID:request.jobId,
  H5C_RELEASE_LEASE_AUTH:'worker-gateway-fenced',
  H5C_RELEASE_LEASE_TOKEN:request.leaseToken||'',
  H5C_RELEASE_LEASE_FENCE:String(request.leaseFence||''),
 }
 // Never pass arbitrary commands, paths, flags, env names or file contents
 // supplied by a socket client to the privileged host executable.
 const processArgs=['deployment/qa26/tenant-release-host-executor.mjs',...args]
 return new Promise((resolve,reject)=>{
  const proc=spawn('node',processArgs,{env:{...process.env,...childEnv},
   stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',done=false
  const timer=setTimeout(()=>{proc.kill('SIGKILL');if(!done){done=true;reject(Error('Host cutover deadline exceeded.'))}},timeout)
  proc.stdout.on('data',part=>{stdout+=part;if(stdout.length>maxOutput)proc.kill('SIGKILL')})
  proc.stderr.on('data',part=>{stderr+=part;if(stderr.length>maxOutput)proc.kill('SIGKILL')})
  proc.on('error',error=>{if(!done){done=true;clearTimeout(timer);reject(error)}})
  proc.on('close',code=>{
   clearTimeout(timer)
   if(done)return;done=true
   if(code!==0)return reject(Error('Trusted cutover refused: '+stderr.slice(-350)))
   try{resolve(readJson(stdout))}catch{reject(Error('Trusted cutover produced no machine-verifiable proof.'))}
  })
 })
}
const base=dirname(SOCKET)
mkdirSync(base,{recursive:true,mode:0o770})
chownSync(base,0,GID);chmodSync(base,0o770)
if(existsSync(SOCKET)){
 if(!lstatSync(SOCKET).isSocket())throw Error('Refusing to replace a non-socket filesystem entry.')
 throw Error('Trusted host socket already exists; resolve duplicate adapter before restart.')
}
const server=net.createServer(socket=>{
 socket.setEncoding('utf8')
 let buffer='',answered=false
 const respond=body=>{
  if(answered)return;answered=true
  socket.end(JSON.stringify(body)+'\n')
 }
 socket.setTimeout(360000,()=>respond({ok:false,error:'Host request timed out.'}))
 socket.on('data',async chunk=>{
  if(answered)return
  buffer+=chunk
  if(buffer.length>5000)return respond({ok:false,error:'Host request too large.'})
  const nl=buffer.indexOf('\n');if(nl<0)return
  let request
  try{request=validateHostRequest(JSON.parse(buffer.slice(0,nl)))}
  catch(error){return respond({ok:false,error:error.message})}
  const lockKey=request.environment
  if(request.mode!=='pool_health'){
   if(queue.has(lockKey))return respond({ok:false,error:'Host gateway is busy; retry within tenant window.'})
   queue.add(lockKey)
  }
  try{
   const proof=await runAction(request)
   respond({ok:true,proof})
  }catch(error){
   respond({ok:false,error:String(error.message||error).slice(0,400)})
  }finally{queue.delete(lockKey)}
 })
 socket.on('error',()=>{})
})
server.listen(SOCKET,()=>{
 chownSync(SOCKET,0,GID);chmodSync(SOCKET,0o660)
 console.log('TRUSTED_RELEASE_HOST_ADAPTER_READY (Unix only, no public port)')
})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
 server.close(()=>{try{unlinkSync(SOCKET)}catch{};process.exit(0)})
})
