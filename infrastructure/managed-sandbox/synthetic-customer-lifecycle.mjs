import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const localSmtpDriver = String.raw`
const net=require('node:net')
const fs=require('node:fs')
let mailCount=0
net.createServer(socket=>{
  socket.setEncoding('utf8')
  socket.write('220 synthetic-phase15 ESMTP\r\n')
  let buffer='',data='',inData=false,loginStage=0
  socket.on('data',chunk=>{
    buffer+=chunk
    let index
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index).replace(/\r$/,'')
      buffer=buffer.slice(index+1)
      if(inData){
        if(line==='.'){
          mailCount++
          fs.writeFileSync('/tmp/phase15-mail-'+mailCount+'.eml',data,{mode:0o600})
          console.log('PH15_MAIL_RECEIVED '+mailCount)
          data='';inData=false
          socket.write('250 accepted for isolated delivery\r\n')
        }else data+=(line.startsWith('..')?line.slice(1):line)+'\n'
      }else if(/^EHLO|^HELO/i.test(line)){
        socket.write('250-synthetic-phase15\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
      }else if(/^AUTH PLAIN/i.test(line)){
        socket.write('235 Synthetic local authentication accepted\r\n')
      }else if(/^AUTH LOGIN/i.test(line)){
        loginStage=1;socket.write('334 VXNlcm5hbWU6\r\n')
      }else if(loginStage===1){
        loginStage=2;socket.write('334 UGFzc3dvcmQ6\r\n')
      }else if(loginStage===2){
        loginStage=0;socket.write('235 Synthetic local authentication accepted\r\n')
      }else if(/^MAIL FROM|^RCPT TO|^RSET/i.test(line)){
        socket.write('250 OK\r\n')
      }else if(/^DATA/i.test(line)){
        inData=true;socket.write('354 End with dot\r\n')
      }else if(/^QUIT/i.test(line)){
        socket.write('221 Closing\r\n');socket.end()
      }else if(/^NOOP/i.test(line)){
        socket.write('250 OK\r\n')
      }else socket.write('250 OK\r\n')
    }
  })
}).listen(2525,'0.0.0.0',()=>console.log('PH15_SMTP_READY'))
setInterval(()=>{},30000)
`

const nodeHttpDriver = String.raw`
(async()=>{
  let buffer=''
  for await(const chunk of process.stdin) buffer+=String(chunk)
  const {path,method,origin,cookie,body}=JSON.parse(buffer)
  const headers={'content-type':'application/json',Origin:origin}
  if(cookie) headers.Cookie=cookie
  const res=await fetch('http://127.0.0.1:3001'+path,{
    method,headers,
    body:method==='GET'?undefined:JSON.stringify(body??{}),
    signal:AbortSignal.timeout(6000),redirect:'manual',
  })
  const raw=await res.text()
  let data
  try{data=JSON.parse(raw)}catch{data={error:'unexpected_non_json',length:raw.length}}
  process.stdout.write(JSON.stringify({
    status:res.status,
    data,
    cookie:res.headers.get('set-cookie')||'',
    cacheControl:res.headers.get('cache-control')||'',
  }))
})().catch(error=>{console.error('Synthetic API request failed:',error.message);process.exitCode=2})
`

function request(e,{path,method='GET',body=null,origin=null,cookie=''}) {
  const payload=JSON.stringify({
    path,method,body,cookie,
    origin:origin===null?`https://${e.customerSlug}${e.env}.hi5central.com`:origin,
  })
  const result=spawnSync('docker',['exec','-i',e.api,'node','-e',nodeHttpDriver],{
    input:payload,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
  })
  if(result.status!==0)throw new Error(
    'Sandbox API request process failed: '+String(result.stderr||'').slice(0,240)
  )
  return JSON.parse(result.stdout)
}
function expect(response,status,step) {
  if(response.status!==status)throw new Error(step+' expected '+status+' got '+
    response.status+' code='+(response.data?.code||'none')+
    ' error='+String(response.data?.error||'').slice(0,160))
}
function totp(secret) {
  const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits=0,acc=0
  const bytes=[]
  for(const char of secret.toUpperCase().replace(/=+$/,'')){
    const n=letters.indexOf(char)
    if(n<0)throw new Error('Malformed synthetic MFA secret')
    acc=(acc<<5)|n;bits+=5
    if(bits>=8){bits-=8;bytes.push((acc>>>bits)&255)}
  }
  const input=Buffer.alloc(8)
  input.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const mac=createHmac('sha1',Buffer.from(bytes)).update(input).digest()
  return String((mac.readUInt32BE(mac[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0')
}
function insertTenant(e,sql) {
  const tid=randomUUID(),controlTid=randomUUID(),requestId=randomUUID()
  e.customerSlug=e.env==='uat'?'synthacme':'synthbravo'
  e.customerId=tid
  e.requestId=requestId
  e.ownerEmail=`first-owner-${e.env}@example.invalid`
  e.ownerPassword='Phase15-Synthetic-Strong-Passphrase!'
  e.ownerToken=randomBytes(32).toString('base64url')
  const tokenHash=createHash('sha256').update(e.ownerToken).digest('hex')
  const commonHost=`${e.customerSlug}${e.env}.hi5central.com`
  sql(e,`INSERT INTO tenants (id,slug,company_name,status)
    VALUES ('${tid}','${e.customerSlug}','Phase 15 synthetic ${e.env}','suspended');`)
  sql(e,`INSERT INTO tenant_settings
    (tenant_id,modules,onboarding_step,tenant_url,portal_url,rmm_url)
    VALUES ('${tid}','{"itsm":true,"selfService":true,"rmm":false}'::jsonb,
    'complete','https://${commonHost}',
    'https://${e.customerSlug}${e.env}-portal.hi5central.com',NULL);`)
  sql(e,`INSERT INTO managed_environment_tenant_bootstrap
    (control_request_id,control_tenant_id,local_tenant_id,environment,
     database_instance_id,expected_hostname)
    VALUES ('${requestId}','${controlTid}','${tid}','${e.env}',
      '${e.instanceId}','${commonHost}');`)
  sql(e,`INSERT INTO managed_environment_invitations
     (tenant_id,email,name,role,token_hash,expires_at)
     VALUES ('${tid}','${e.ownerEmail}','Synthetic First Owner','owner',
     '${tokenHash}',now()+interval '24 hours');`)
}
const acceptPath='/api/v1/auth/sandbox-invitations/accept'
const loginPath='/api/v1/auth/login-secure'
const sessionPath='/api/v1/auth/session'
const invitationIssuePath='/api/v1/auth/sandbox-invitations/issue'
function createSyntheticStaff(e,sql,role,issuerCookie,mailIndex){
  const email=`phase16-${role}-${e.env}@example.invalid`
  const password='Phase16-Role-Matrix-Strong-Passphrase!'
  const created=request(e,{path:invitationIssuePath,method:'POST',cookie:issuerCookie,
    body:{email,name:`Synthetic ${role}`,role}})
  expect(created,201,e.env+' issue '+role+' invitation')
  const mail=spawnSync('docker',['exec',e.smtp,'cat',`/tmp/phase15-mail-${mailIndex}.eml`],{
    encoding:'utf8',timeout:9000,maxBuffer:1024*1024,
  })
  if(mail.status!==0 || !mail.stdout.includes(email))
    throw new Error(e.env+' '+role+' invitation email not delivered')
  const link=mail.stdout.replace(/=\r?\n/g,'').replace(/=3D/gi,'=')
    .match(/accept-invitation\?token=([A-Za-z0-9_-]{43})/)
  if(!link)throw new Error(e.env+' '+role+' invitation token missing')
  const accepted=request(e,{path:acceptPath,method:'POST',
    body:{tenantSlug:e.customerSlug,token:link[1],password}})
  expect(accepted,200,e.env+' '+role+' accepts invitation')
  if(accepted.cookie)throw new Error(e.env+' '+role+' invitation bypassed MFA')
  expect(request(e,{path:acceptPath,method:'POST',
    body:{tenantSlug:e.customerSlug,token:link[1],password}}),401,
    e.env+' '+role+' token replay')
  const login=request(e,{path:loginPath,method:'POST',
    body:{tenantSlug:e.customerSlug,email,password}})
  expect(login,200,e.env+' '+role+' login')
  if(!login.data?.mfaRequired || login.cookie || !login.data.challengeToken)
    throw new Error(e.env+' '+role+' MFA challenge skipped')
  const challengeToken=login.data.challengeToken
  const setup=request(e,{path:'/api/v1/auth/mfa/setup',method:'POST',
    body:{challengeToken}})
  expect(setup,200,e.env+' '+role+' MFA setup')
  const verified=request(e,{path:'/api/v1/auth/mfa/verify',method:'POST',
    body:{challengeToken,code:totp(setup.data.secret)}})
  expect(verified,200,e.env+' '+role+' MFA verification')
  if(!verified.cookie.startsWith('hi5central_'+e.env+'_session=')
    || !verified.cookie.includes('Secure') || !verified.cookie.includes('HttpOnly')
    || /Domain=/i.test(verified.cookie))throw new Error(e.env+' '+role+' cookie scope invalid')
  const cookie=verified.cookie.split(';')[0]
  expect(request(e,{path:sessionPath,cookie}),200,e.env+' '+role+' staff session')
  const result=sql(e,`SELECT role FROM tenant_memberships m
    JOIN users u ON u.id=m.user_id WHERE u.email='${email}';`).trim()
  if(result!==role)throw new Error(e.env+' '+role+' membership mismatch: '+result)
  return {cookie,email}
}

function acceptance(e,opts={}){
  return request(e,{path:acceptPath,method:'POST',body:{
    tenantSlug:e.customerSlug,token:e.ownerToken,password:e.ownerPassword,
  },...opts})
}

export async function runSyntheticCustomerLifecycle(entries,sql,report){
  for(const e of entries){
    insertTenant(e,sql)
    // A tenant identity and a token are NOT an activation.
    expect(acceptance(e),423,e.env+' suspended invitation')
    sql(e,`INSERT INTO managed_environment_access_approvals
      (tenant_id,bootstrap_request_id,state,approved_by,approved_at)
      VALUES ('${e.customerId}','${e.requestId}','approved',
       'synthetic-independent-reviewer',now());`)
    expect(acceptance(e),423,e.env+' approved but still suspended')
    sql(e,`UPDATE tenants SET status='active' WHERE id='${e.customerId}';`)
    const origin=`https://${e.customerSlug}${e.env}.hi5central.com`
    expect(acceptance(e,{origin:`https://other${e.env}.hi5central.com`}),
      403,e.env+' wrong-origin invitation')
    const accepted=acceptance(e)
    expect(accepted,200,e.env+' initial owner invite acceptance')
    if(!accepted.data?.mfaRequired || accepted.cookie)
      throw new Error(e.env+' invitation bypassed mandatory MFA')
    expect(acceptance(e),401,e.env+' invite token replay')
    const login=request(e,{path:loginPath,method:'POST',body:{
      tenantSlug:e.customerSlug,email:e.ownerEmail,password:e.ownerPassword,
    }})
    expect(login,200,e.env+' secure login challenge')
    if(!login.data?.mfaRequired || !login.data?.setupRequired
       || login.cookie || !login.data.challengeToken)
      throw new Error(e.env+' password login bypassed MFA challenge')
    const token=login.data.challengeToken
    const wrongOrigin=request(e,{path:'/api/v1/auth/mfa/setup',method:'POST',
      body:{challengeToken:token},origin:`https://other${e.env}.hi5central.com`})
    expect(wrongOrigin,403,e.env+' MFA setup other-origin')
    const setup=request(e,{path:'/api/v1/auth/mfa/setup',method:'POST',
      body:{challengeToken:token}})
    expect(setup,200,e.env+' MFA setup')
    if(!setup.data?.secret)throw new Error(e.env+' authenticator seed missing')
    const correctCode=totp(setup.data.secret)
    const incorrectCode=correctCode==='000000'?'000001':'000000'
    const bad=request(e,{path:'/api/v1/auth/mfa/verify',method:'POST',
      body:{challengeToken:token,code:incorrectCode}})
    expect(bad,401,e.env+' wrong TOTP rejected')
    const verified=request(e,{path:'/api/v1/auth/mfa/verify',method:'POST',
      body:{challengeToken:token,code:correctCode}})
    expect(verified,200,e.env+' correct TOTP')
    if(!verified.cookie || !verified.cookie.includes('HttpOnly') ||
      !verified.cookie.includes('Secure') ||
      /Domain=/i.test(verified.cookie))
      throw new Error(e.env+' session cookie lacks security or is parent-domain scoped')
    e.ownerCookie=verified.cookie.split(';')[0]
    const session=request(e,{path:sessionPath,cookie:e.ownerCookie})
    expect(session,200,e.env+' owner session')
    // The same cookie must be rejected from a different customer Origin.
    const crossed=request(e,{path:sessionPath,cookie:e.ownerCookie,
      origin:`https://other${e.env}.hi5central.com`})
    expect(crossed,401,e.env+' cross-customer origin session')
    const noOrigin=request(e,{path:sessionPath,cookie:e.ownerCookie,origin:''})
    expect(noOrigin,401,e.env+' origin-less session')
    const wrongInvite=request(e,{path:invitationIssuePath,method:'POST',
      cookie:e.ownerCookie,origin:`https://other${e.env}.hi5central.com`,
      body:{email:'requester@example.invalid',name:'Request User',role:'requester'}})
    expect(wrongInvite,401,e.env+' cross-customer invitation session')
    if(Number(sql(e,'SELECT count(*) FROM tenant_memberships;').split('\n')[0])!==1)
      throw new Error(e.env+' unexpected memberships after owner invite')

    // Actual API email delivery is captured by the isolated scratch SMTP inbox.
    const requesterEmail=`synthetic-requester-${e.env}@example.invalid`
    const invitation=request(e,{
      path:invitationIssuePath,method:'POST',cookie:e.ownerCookie,
      body:{email:requesterEmail,name:'Synthetic Requester',role:'requester'},
    })
    expect(invitation,201,e.env+' owner issues requester invite via SMTP')
    const mail=spawnSync('docker',['exec',e.smtp,'cat','/tmp/phase15-mail-1.eml'],{
      encoding:'utf8',timeout:9000,maxBuffer:1024*1024,
    })
    if(mail.status!==0 || !mail.stdout.includes(requesterEmail))
      throw new Error(e.env+' isolated mailbox did not receive requester email')
    const decoded=mail.stdout.replace(/=\r?\n/g,'').replace(/=3D/gi,'=')
    const link=decoded.match(/accept-invitation\?token=([A-Za-z0-9_-]{43})/)
    if(!link)throw new Error(e.env+' email did not contain the one-time acceptance link')
    const requesterPortalOrigin=`https://${e.customerSlug}${e.env}-portal.hi5central.com`
    const requesterPassword='Phase15-Requester-Strong-Passphrase!'
    const acceptedRequester=request(e,{path:acceptPath,method:'POST',body:{
      tenantSlug:e.customerSlug,token:link[1],password:requesterPassword,
    },origin:requesterPortalOrigin})
    expect(acceptedRequester,200,e.env+' requester redeems emailed link')
    if(acceptedRequester.cookie)throw new Error('Requester invitation bypassed MFA')
    const requesterLogin=request(e,{path:loginPath,method:'POST',body:{
      tenantSlug:e.customerSlug,email:requesterEmail,password:requesterPassword,
    },origin:requesterPortalOrigin})
    expect(requesterLogin,200,e.env+' requester login challenge')
    if(!requesterLogin.data?.mfaRequired || !requesterLogin.data.challengeToken
        || requesterLogin.cookie) throw new Error(e.env+' requester MFA skipped')
    const requesterChallenge=requesterLogin.data.challengeToken
    const requesterSetup=request(e,{path:'/api/v1/auth/mfa/setup',method:'POST',
      body:{challengeToken:requesterChallenge},origin:requesterPortalOrigin})
    expect(requesterSetup,200,e.env+' requester MFA enrolment')
    const requesterVerified=request(e,{path:'/api/v1/auth/mfa/verify',method:'POST',
      body:{challengeToken:requesterChallenge,code:totp(requesterSetup.data.secret)},
      origin:requesterPortalOrigin})
    expect(requesterVerified,200,e.env+' requester MFA completed')
    if(!requesterVerified.cookie.startsWith('hi5central_'+e.env+'_portal_session=')
      || !requesterVerified.cookie.includes('HttpOnly')
      || !requesterVerified.cookie.includes('Secure')
      || /Domain=/i.test(requesterVerified.cookie)) {
      throw new Error(e.env+' requester MFA did not issue a secure host-only Portal cookie')
    }
    e.requesterCookie=requesterVerified.cookie.split(';')[0]
    if(!e.requesterCookie)throw new Error(e.env+' requester session missing')
    expect(request(e,{path:sessionPath,cookie:e.requesterCookie,origin:requesterPortalOrigin}),200,
      e.env+' requester authenticated session')
    // A customer Portal session must not authorize ITSM staff workspace.
    expect(request(e,{path:sessionPath,cookie:e.requesterCookie}),401,
      e.env+' requester Portal session cannot become staff workspace session')
    const forbidden=request(e,{
      path:invitationIssuePath,method:'POST',cookie:e.requesterCookie,
      origin:requesterPortalOrigin,
      body:{email:'another-requester@example.invalid',name:'Another User',role:'requester'},
    })
    expect(forbidden,403,e.env+' requester RBAC denies invite')
    if(Number(sql(e,'SELECT count(*) FROM tenant_memberships;').split('\n')[0])!==2)
      throw new Error(e.env+' requester membership count unexpected')
    const admin=createSyntheticStaff(e,sql,'admin',e.ownerCookie,2)
    const analyst=createSyntheticStaff(e,sql,'analyst',e.ownerCookie,3)
    expect(request(e,{path:invitationIssuePath,method:'POST',cookie:admin.cookie,
      body:{email:`unapproved-owner-${e.env}@example.invalid`,name:'New Owner',role:'owner'}}),
      400,e.env+' admin cannot invite owner')
    expect(request(e,{path:invitationIssuePath,method:'POST',cookie:analyst.cookie,
      body:{email:`unapproved-analyst-${e.env}@example.invalid`,name:'Denied User',role:'requester'}}),
      403,e.env+' analyst cannot invite')
    expect(request(e,{path:invitationIssuePath,method:'POST',cookie:admin.cookie,
      origin:`https://another${e.env}.hi5central.com`,
      body:{email:'wrong-tenant@example.invalid',name:'Other Tenant',role:'requester'}}),
      401,e.env+' admin cross-tenant invitation denied')
    expect(request(e,{path:sessionPath,cookie:admin.cookie,
      origin:`https://${e.customerSlug}${e.env}-portal.hi5central.com`}),
      401,e.env+' staff cookie cannot access Portal session')
    expect(request(e,{path:invitationIssuePath,method:'POST',cookie:admin.cookie,
      body:{email:`admin-invited-${e.env}@example.invalid`,
        name:'Admin Invited User',role:'requester'}}),
      201,e.env+' admin may invite requester')
    if(Number(sql(e,'SELECT count(*) FROM tenant_memberships;').split('\n')[0])!==4)
      throw new Error(e.env+' expected owner/requester/admin/analyst memberships')
    e.adminCookie=admin.cookie
    e.analystCookie=analyst.cookie
    report(e.env,'role matrix owner, admin, analyst, requester and cross-origin denial PASS')
    report(e.env,'isolated email delivery, requester MFA and RBAC denial passed')

    report(e.env,'synthetic invite one-time, MFA challenge and TOTP, host-only session, cross-customer denial PASS')
  }

  for(const e of entries){
    const other=entries.find(x=>x!==e)
    const cookieCross=request(other,{path:sessionPath,cookie:e.ownerCookie})
    expect(cookieCross,401,e.env+' cross-environment cookie')
    report(e.env,'cross-environment cookie denied')
  }

  for(const e of entries){
    sql(e,`UPDATE managed_environment_access_approvals
        SET state='revoked',reviewed_at=now() WHERE tenant_id='${e.customerId}';`)
    const revoked=request(e,{path:sessionPath,cookie:e.ownerCookie})
    expect(revoked,401,e.env+' approval revocation invalidates existing session')
    const denied=request(e,{path:loginPath,method:'POST',body:{
      tenantSlug:e.customerSlug,email:e.ownerEmail,password:e.ownerPassword,
    }})
    expect(denied,423,e.env+' revoked approval denies new login')
    sql(e,`UPDATE tenants SET status='suspended' WHERE id='${e.customerId}';`)
    const noSession=request(e,{path:sessionPath,cookie:e.ownerCookie})
    expect(noSession,401,e.env+' suspended tenant revokes session')
    expect(request(e,{path:sessionPath,cookie:e.requesterCookie,origin:`https://${e.customerSlug}${e.env}-portal.hi5central.com`}),401,
      e.env+' suspended tenant revokes requester session')
    const noLogin=request(e,{path:loginPath,method:'POST',body:{
      tenantSlug:e.customerSlug,email:e.ownerEmail,password:e.ownerPassword,
    }})
    expect(noLogin,403,e.env+' suspended tenant denies login')
    report(e.env,'approval revocation and tenant suspension deny sessions and login')
  }
  return {
    environments:entries.map(e=>e.env),
    syntheticCustomers:entries.length,
    approvedExternalCustomers:0,
    status:'synthetic_customer_lifecycle_passed',
  }
}
