#!/usr/bin/env node
// EXPLICIT PRIVATE PILOT ONLY. Creates ONE synthetic Platform Admin in the
// separate pilot control database, exercises MFA and ALWAYS deletes fixture.
// Never routes a hostname, publishes a port, or uses a real customer account.
import assert from 'node:assert/strict'
import { randomBytes,scryptSync,createHmac } from 'node:crypto'
import { execFileSync,spawnSync } from 'node:child_process'

if(process.env.HI5_PRIVATE_PILOT_MFA_SMOKE!=='1'
  || process.argv.join(' ')!==process.argv.slice(0,2).concat(
    ['--run','--confirm','PRIVATE_PILOT_SYNTHETIC_ADMIN_ONLY']).join(' ')) {
  throw new Error('Usage: HI5_PRIVATE_PILOT_MFA_SMOKE=1 node private-admin-mfa-smoke.mjs --run --confirm PRIVATE_PILOT_SYNTHETIC_ADMIN_ONLY')
}
const api='hi5central-pilot-control-api-1'
const db='hi5central-pilot-control-postgres-1'
const prefix='hi5central-pilot-control'
function docker(args,input){
  const p=spawnSync('docker',args,{input,encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024})
  if(p.status!==0)throw new Error('Pilot Docker command failed. No credentials logged.')
  return String(p.stdout||'').trim()
}
for(const service of ['postgres','redis','api','admin']){
  const id=prefix+'-'+service+'-1'
  const info=JSON.parse(docker(['inspect',id]))
  assert.equal(info[0].Config.Labels['com.docker.compose.project'],prefix)
  assert.deepEqual(info[0].HostConfig.PortBindings,{},'No host port mappings allowed')
  const networks=Object.keys(info[0].NetworkSettings.Networks)
  assert.ok(networks.every(n=>n.startsWith(prefix)||n==='hi5central-pilot-control-edge'))
}
const adminMfa=docker(['exec',api,'node','-e',
  'process.stdout.write(String(process.env.PLATFORM_ADMIN_MFA_REQUIRED))'])
assert.equal(adminMfa,'true','Pilot must have independently required Admin MFA')

function sql(command){
  return docker(['exec',db,'psql','-U','pilot_user_a','-d','hi5pilotcontrol',
    '--no-psqlrc','-v','ON_ERROR_STOP=1','-At','-c',command])
}
const counts=()=>{
  const output=sql('SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM platform_admin_members),(SELECT count(*) FROM tenants);')
  return output.trim().split('\n').at(-1)
}
assert.equal(counts(),'0|0|0','Pilot database must be empty before synthetic admin test')
const suffix=randomBytes(5).toString('hex')
const email='phase18-synthetic-'+suffix+'@example.invalid'
const password='Aa1'+randomBytes(24).toString('base64url')
const salt=randomBytes(16)
const derived=scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024})
const passwordHash=['scrypt','16384','8','1',salt.toString('base64url'),derived.toString('base64url')].join('$')
const httpDriver=`
(async()=>{
 let input='';for await(const part of process.stdin)input+=String(part)
 const data=JSON.parse(input)
 const headers={'Content-Type':'application/json','Origin':data.origin||'https://pilot-admin.hi5central.com'}
 if(data.cookie)headers.Cookie=data.cookie
 const res=await fetch('http://127.0.0.1:3001'+data.path,{
   method:data.method||'GET',headers,
   body:data.method==='GET'||data.body===undefined?undefined:JSON.stringify(data.body),
   redirect:'manual',signal:AbortSignal.timeout(6000),
 })
 const parsed=await res.json().catch(()=>({}))
 process.stdout.write(JSON.stringify({status:res.status,cookie:res.headers.get('set-cookie')||'',body:parsed}))
})().catch(()=>{process.exitCode=2})
`
function http(path,body,opts={}){
  const answer=docker(['exec','-i',api,'node','-e',httpDriver],
    JSON.stringify({path,body,method:body===undefined?'GET':'POST',...opts}))
  return JSON.parse(answer)
}
function totp(secret){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let buffer=[],value=0,bits=0
  for(const symbol of secret) {
    value=(value<<5)|alphabet.indexOf(symbol);bits+=5
    if(bits>=8){buffer.push((value>>>(bits-8))&255);bits-=8}
  }
  const count=Buffer.alloc(8)
  count.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest=createHmac('sha1',Buffer.from(buffer)).update(count).digest()
  return String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0')
}
let inserted=false
try {
  sql(`INSERT INTO users(email,name,password_hash,email_verified_at)
    VALUES ('${email}','Synthetic Phase 18 Admin','${passwordHash}',now());
    INSERT INTO platform_admin_members(user_id,role,status)
      SELECT id,'owner','active' FROM users WHERE email='${email}';`)
  inserted=true
  assert.equal(counts(),'1|1|0')
  assert.equal(http('/api/platform/v1/auth/session').status,401)
  assert.equal(http('/api/platform/v1/tenants',{}, {method:'POST'}).status,401)
  assert.equal(http('/api/platform/v1/auth/login',{email,password:'incorrect'}).status,401)
  assert.equal(http('/api/platform/v1/auth/login',{email,password},
    {origin:'https://other.hi5central.com'}).status,403)
  const login=http('/api/platform/v1/auth/login',{email,password})
  assert.equal(login.status,200)
  assert.equal(login.body.mfaRequired,true)
  assert.equal(login.body.setupRequired,true)
  assert.ok(!login.cookie,'Password-only Admin session must not exist')
  const challengeToken=login.body.challengeToken
  assert.equal(http('/api/platform/v1/auth/session',{},{method:'GET',
    cookie:'hi5central_admin_session=not-a-valid-session'}).status,401)
  const setup=http('/api/platform/v1/auth/mfa/setup',{challengeToken})
  assert.equal(setup.status,200)
  assert.match(setup.body.secret,/^[A-Z2-7]{32}$/)
  const validCode=totp(setup.body.secret)
  const invalidCode=validCode==='000000'?'000001':'000000'
  const wrong=http('/api/platform/v1/auth/mfa/verify',{challengeToken,code:invalidCode})
  assert.equal(wrong.status,401)
  const verified=http('/api/platform/v1/auth/mfa/verify',{
    challengeToken,code:validCode})
  assert.equal(verified.status,200,'Correct TOTP must establish Admin session')
  assert.equal(verified.body.mfaVerified,true)
  assert.equal(verified.body.recoveryCodes.length,10)
  assert.match(verified.cookie,/HttpOnly/i)
  assert.match(verified.cookie,/Secure/i)
  assert.ok(!/Domain=/i.test(verified.cookie),'Pilot Admin session must be host-only')
  const cookie=verified.cookie.split(';')[0]
  assert.equal(http('/api/platform/v1/auth/session',undefined,{cookie}).status,200)
  const overview=http('/api/platform/v1/tenants',undefined,{cookie})
  assert.equal(overview.status,200)
  assert.equal(http('/api/platform/v1/auth/mfa/verify',{
    challengeToken,code:totp(setup.body.secret)}).status,401)
  assert.equal(http('/api/platform/v1/auth/logout',{}, {cookie}).status,200)
  assert.equal(http('/api/platform/v1/auth/session',undefined,{cookie}).status,401)
  const second=http('/api/platform/v1/auth/login',{email,password})
  assert.equal(second.body.setupRequired,false)
  const reuseTotp=http('/api/platform/v1/auth/mfa/verify',{
    challengeToken:second.body.challengeToken,code:totp(setup.body.secret)})
  assert.equal(reuseTotp.status,401,'TOTP step must not be replayed')
  const recovered=http('/api/platform/v1/auth/mfa/verify',{
    challengeToken:second.body.challengeToken,code:verified.body.recoveryCodes[0]})
  assert.equal(recovered.status,200,'One-time recovery code must work')
  assert.equal(recovered.body.recoveryCodes,undefined,'Recovery codes must be displayed only once')
  const third=http('/api/platform/v1/auth/login',{email,password})
  const replayRecovery=http('/api/platform/v1/auth/mfa/verify',{
    challengeToken:third.body.challengeToken,code:verified.body.recoveryCodes[0]})
  assert.equal(replayRecovery.status,401,'Recovery code cannot be reused')
  assert.equal(http('/api/platform/v1/auth/mfa/verify',{
    challengeToken:third.body.challengeToken,code:verified.body.recoveryCodes[1]}).status,200)
  console.log('PRIVATE_ADMIN_MFA_SYNTHETIC_SMOKE: PASS')
  console.log('Password-only bypass, TOTP enrollment/replay, host-only cookie, logout, one-time recovery: PASS')
} finally {
  if(inserted) sql(`DELETE FROM users WHERE email='${email}';`)
  assert.equal(counts(),'0|0|0','Synthetic pilot administrator must be removed')
  console.log('Private pilot test account and linked sessions removed; zero live tenants.')
}
