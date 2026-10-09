import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { pool } from '../src/db.js'
import { redis } from '../src/redis.js'
import { registerManagedSandboxInvitationRoutes } from '../src/managedSandboxInvitationRoutes.js'
import { registerMfaRoutes } from '../src/mfa.js'
import { resolveSession } from '../src/session.js'

const db = new URL(process.env.DATABASE_URL || '')
const cache = new URL(process.env.REDIS_URL || '')
if (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.HI5_PROVISIONING_TEST_SCOPE !== 'isolated-github-actions'
  || !['127.0.0.1','localhost'].includes(db.hostname)
  || !['127.0.0.1','localhost'].includes(cache.hostname)
  || !/^\/h5ci_(?:uat|test)_[0-9a-f]{8}$/.test(db.pathname)
  || !['uat','test'].includes(process.env.RUNTIME_ENVIRONMENT)) {
  throw new Error('Sandbox HTTP tests are permitted only on disposable GitHub Actions databases.')
}
const environment=process.env.RUNTIME_ENVIRONMENT
const slug=environment==='uat'?'acme':'bravo'
const origin=`https://${slug}${environment}.hi5central.com`
const password='PhaseNine-Strong-Passphrase-2026'
const email=`first-owner-${environment}@example.invalid`

function totpCode(secret) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits=0, acc=0
  const bytes=[]
  for(const ch of secret.toUpperCase().replace(/=+$/,'')) {
    const n=alphabet.indexOf(ch)
    assert.notEqual(n,-1)
    acc=(acc<<5)|n
    bits+=5
    if(bits>=8){bits-=8;bytes.push((acc>>>bits)&255)}
  }
  const timestamp=Math.floor(Date.now()/30000)
  const message=Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(timestamp))
  const mac=createHmac('sha1',Buffer.from(bytes)).update(message).digest()
  const offset=mac[19]&15
  return String((mac.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,'0')
}

const app=new Hono()
registerManagedSandboxInvitationRoutes(app)
registerMfaRoutes(app)
app.get('/probe/session',async c=>{
  const session=await resolveSession(c)
  return c.json({ authenticated:Boolean(session),tenantSlug:session?.slug||null })
})

async function call(path,body,headers={}) {
  const response=await app.request('http://test.invalid'+path,{
    method:body===null?'GET':'POST',
    headers:{Origin:origin,'content-type':'application/json',...headers},
    body:body===null?undefined:JSON.stringify(body),
  })
  const data=await response.json()
  return {status:response.status,data,cookie:response.headers.get('set-cookie')||''}
}
async function main(){
  if(process.argv[2]==='--revoked'){
    const cookie=process.env.HI5_TEST_SESSION_COOKIE||''
    const check=await call('/probe/session',null,{Cookie:cookie})
    assert.equal(check.data.authenticated,false,'Suspension must invalidate sessions.')
    const denied=await call('/api/v1/auth/login-secure',{tenantSlug:slug,email,password})
    assert.equal(denied.status,403,'Suspended tenant must not be able to sign in.')
    console.log(JSON.stringify({revoked:true,sessionInvalidated:true,loginDenied:true}))
    return
  }
  if(process.argv[2]!=='--accept-mfa') throw new Error('Unsupported sandbox test action.')
  const token=process.env.HI5_TEST_INVITE_TOKEN
  const accepted=await call('/api/v1/auth/sandbox-invitations/accept',{tenantSlug:slug,token,password})
  assert.equal(accepted.status,200,JSON.stringify(accepted.data))
  assert.equal(accepted.data.mfaRequired,true)
  assert.equal(accepted.cookie,'','Invitation must not issue a session.')
  const replay=await call('/api/v1/auth/sandbox-invitations/accept',{tenantSlug:slug,token,password})
  assert.equal(replay.status,401,'Invitation token must be single-use.')
  const signin=await call('/api/v1/auth/login-secure',{tenantSlug:slug,email,password})
  assert.equal(signin.status,200,JSON.stringify(signin.data))
  assert.equal(signin.data.mfaRequired,true)
  assert.equal(signin.data.setupRequired,true)
  assert.equal(signin.cookie,'','Password login must not issue a session.')
  const challengeToken=signin.data.challengeToken
  assert.ok(challengeToken)
  const setup=await call('/api/v1/auth/mfa/setup',{challengeToken})
  assert.equal(setup.status,200,JSON.stringify(setup.data))
  const otp=totpCode(setup.data.secret)
  const verified=await call('/api/v1/auth/mfa/verify',{challengeToken,code:otp})
  assert.equal(verified.status,200,JSON.stringify(verified.data))
  assert.ok(verified.cookie,'MFA success must issue a session cookie.')
  const cookie=verified.cookie.split(';')[0]
  const session=await call('/probe/session',null,{Cookie:cookie})
  assert.equal(session.data.authenticated,true)
  assert.equal(session.data.tenantSlug,slug)
  const crossTenant=await call('/probe/session',null,{
    Origin:`https://another${environment}.hi5central.com`,Cookie:cookie,
  })
  assert.equal(crossTenant.data.authenticated,false,'Cookie must not cross customer subdomains')
  const missingOrigin=await call('/probe/session',null,{Origin:'',Cookie:cookie})
  assert.equal(missingOrigin.data.authenticated,false,'Sandbox session requires tenant origin')
  // CI-only cookie returned to isolated harness, never printed to runner logs.
  console.log(JSON.stringify({
    accepted:true,replayRejected:true,mfaChallenged:true,mfaVerified:true,
    authenticated:true,cookie,
  }))
}

main().catch(error=>{console.error('Sandbox HTTP lifecycle failed:',error.message);process.exitCode=1})
  .finally(async()=>{await Promise.allSettled([pool.end(),redis.isOpen?redis.quit():Promise.resolve()])})
