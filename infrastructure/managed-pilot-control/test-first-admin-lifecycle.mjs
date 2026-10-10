#!/usr/bin/env node
// Disposable GitHub Actions ONLY. Never run this against a real VPS or
// customer's database; the test creates a fake approval solely in CI storage.
import assert from 'node:assert/strict'
import {randomBytes,createHash,createHmac} from 'node:crypto'
import {spawnSync} from 'node:child_process'

if(process.env.GITHUB_ACTIONS!=='true'||process.env.HI5_PILOT_DISPOSABLE_CI!=='1'
  ||process.argv.slice(2).join(' ')!=='--run --confirm CI_ONLY_FAKE_APPROVALS'){
  throw new Error('Refusing non-disposable pilot first Admin integration test.')
}
const prefix='hi5central-pilot-control'
function run(args,input){
  const result=spawnSync('docker',args,{input,encoding:'utf8',
    maxBuffer:2*1024*1024,timeout:15000})
  if(result.status!==0)
    throw new Error('Isolated pilot integration Docker step failed: '+String(result.stderr).slice(-300))
  return String(result.stdout||'').trim()
}
function sql(query){
  return run(['exec',prefix+'-postgres-1','psql','-U','pilot_user_a',
    '-d','pilot_control_db','-v','ON_ERROR_STOP=1','-At','-c',query])
}
function call(method,path,body,cookie,origin='https://pilot-admin.hi5central.com'){
  const driver=`
    (async()=>{
      let s='';for await(const chunk of process.stdin)s+=String(chunk)
      const request=JSON.parse(s)
      const headers={Origin:request.origin,'content-type':'application/json'}
      if(request.cookie)headers.Cookie=request.cookie
      const response=await fetch('http://127.0.0.1:3001'+request.path,{
        method:request.method,headers,redirect:'manual',
        body:request.body===null?undefined:JSON.stringify(request.body),
        signal:AbortSignal.timeout(6000),
      })
      process.stdout.write(JSON.stringify({
        status:response.status,cookie:response.headers.get('set-cookie')||'',
        data:await response.json().catch(()=>({}))
      }))
    })().catch(()=>{process.exitCode=2})`
  return JSON.parse(run(['exec','-i',prefix+'-api-1','node','-e',driver],
    JSON.stringify({method,path,body,cookie,origin})))
}
function totp(secret){
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',bytes=[]
  let bits=0,value=0
  for(const char of secret){
    value=(value<<5)|alphabet.indexOf(char);bits+=5
    if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8}
  }
  const buf=Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest=createHmac('sha1',Buffer.from(bytes)).update(buf).digest()
  return String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0')
}
for(const service of ['postgres','redis','api','admin']){
  const info=JSON.parse(run(['inspect',prefix+'-'+service+'-1']))[0]
  assert.equal(info.Config.Labels['com.docker.compose.project'],prefix)
  assert.deepEqual(info.HostConfig.PortBindings,{})
}
assert.equal(sql('SELECT COUNT(*) FROM users;').split('\n').at(-1),'0')
assert.equal(sql('SELECT COUNT(*) FROM tenants;').split('\n').at(-1),'0')
const scopeId=sql('SELECT scope_id FROM pilot_admin_bootstrap_scope;').split('\n').at(-1)
assert.match(scopeId,/^[0-9a-f-]{36}$/)
const email='first-admin-ci@example.invalid'
const token=randomBytes(32).toString('base64url')
const digest=createHash('sha256').update(token).digest('hex')
sql(`INSERT INTO managed_control_plane_identity
  (singleton,deployment_mode,tenancy_mode,root_domain,instance_id,verified_by)
  VALUES(true,'managed','multi','hi5central.com','${scopeId}','ci-operator/ci-reviewer');
  INSERT INTO pilot_admin_bootstrap_invitations
  (scope_id,email,display_name,token_hash,issued_by,reviewed_by,
   actor_evidence_sha256,reviewer_evidence_sha256,expires_at)
  VALUES('${scopeId}','${email}','Synthetic Pilot Owner','${digest}',
    'ci-operator','ci-reviewer','${randomBytes(32).toString('hex')}',
    '${randomBytes(32).toString('hex')}',now()+interval '24 hours');`)
assert.equal(call('GET','/api/platform/v1/auth/session',null).status,401)
const password='Phase19-Synthetic-Owner-Strong-Password-1!'
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token:'x'.repeat(43),password}).status,401)
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password},null,'https://untrusted.hi5central.com').status,403)
const accepted=call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password})
assert.equal(accepted.status,200,JSON.stringify(accepted.data))
assert.equal(accepted.data.accepted,true)
assert.equal(accepted.data.mfaRequired,true)
assert.equal(accepted.data.sessionCreated,false)
assert.equal(accepted.cookie,'','First invitation must not create a session')
assert.equal(call('POST','/api/platform/v1/auth/bootstrap/accept',
  {email,token,password}).status,409)
assert.equal(sql('SELECT COUNT(*) FROM platform_admin_members;').split('\n').at(-1),'1')
assert.equal(call('GET','/api/platform/v1/auth/session',null).status,401)
const login=call('POST','/api/platform/v1/auth/login',{email,password})
assert.equal(login.status,200)
assert.equal(login.data.mfaRequired,true)
assert.equal(login.cookie,'')
const challengeToken=login.data.challengeToken
const setup=call('POST','/api/platform/v1/auth/mfa/setup',{challengeToken})
assert.equal(setup.status,200)
assert.match(setup.data.secret,/^[A-Z2-7]{32}$/)
const code=totp(setup.data.secret)
const wrong=code==='000000'?'000001':'000000'
assert.equal(call('POST','/api/platform/v1/auth/mfa/verify',
  {challengeToken,code:wrong}).status,401)
const verified=call('POST','/api/platform/v1/auth/mfa/verify',
  {challengeToken,code})
assert.equal(verified.status,200,JSON.stringify(verified.data))
assert.equal(verified.data.mfaVerified,true)
assert.equal(verified.data.recoveryCodes.length,10)
assert.match(verified.cookie,/HttpOnly/)
assert.match(verified.cookie,/Secure/)
assert.doesNotMatch(verified.cookie,/Domain=/)
const cookie=verified.cookie.split(';')[0]
assert.equal(call('GET','/api/platform/v1/auth/session',null,cookie).status,200)
assert.equal(call('GET','/api/platform/v1/tenants',null,cookie).status,200)
assert.equal(call('POST','/api/platform/v1/auth/logout',{},cookie).status,200)
assert.equal(call('GET','/api/platform/v1/auth/session',null,cookie).status,401)
console.log('PHASE19_DISPOSABLE_FIRST_ADMIN_INVITE_MFA: PASS')
console.log('Invalid and foreign-origin invite denied; one-time acceptance had no session; real TOTP, role access and logout verified.')
