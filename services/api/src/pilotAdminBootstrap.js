import {createHash,createPublicKey,randomBytes,verify} from 'node:crypto'

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELDS=['version','audience','action','role','operatorId','email',
  'displayName','scopeId','issuedAt','expiresAt','nonce']
const AUDIENCE='hi5central-pilot-initial-platform-admin'
function denied(){throw new Error('Signed pilot administrator bootstrap approval is invalid or unavailable.')}
function sameKeys(value,keys){
  return value && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).length===keys.length
    && keys.every(key=>Object.hasOwn(value,key))
}
export function pilotBootstrapEnabled(env=process.env){
  return env.PILOT_ADMIN_BOOTSTRAP_ENABLED==='true'
    && env.PLATFORM_ADMIN_MFA_REQUIRED==='true'
    && env.DEPLOYMENT_MODE==='managed'
    && env.TENANCY_MODE==='multi'
    && env.RUNTIME_ENVIRONMENT==='live'
    && env.FEATURE_MODE==='controlled'
    && env.ADMIN_URL==='https://pilot-admin.hi5central.com'
    && env.API_URL==='https://pilot-control-api.hi5central.com'
    && !env.COOKIE_DOMAIN
}
export function validatePilotAdminIdentity({email,displayName}){
  return typeof email==='string' && email===email.trim().toLowerCase()
    && email.length<=254 && EMAIL.test(email)
    && typeof displayName==='string'
    && displayName===displayName.trim() && displayName.length>=2
    && displayName.length<=120
}
export function bootstrapToken(){return randomBytes(32).toString('base64url')}
export function bootstrapHash(token){return createHash('sha256').update(String(token)).digest('hex')}

export function verifyPilotBootstrapPair(actorRaw,reviewerRaw,trust,expected,now=new Date()){
  function check(raw,role){
    let token,envelope,payload,bytes,signature
    try {
      if(typeof raw!=='string' || raw.length>8000)denied()
      envelope=JSON.parse(raw)
      if(!sameKeys(envelope,['keyId','payload','signature'])
        || !/^[a-zA-Z0-9_.-]{3,100}$/.test(envelope.keyId))denied()
      bytes=Buffer.from(envelope.payload,'base64url')
      signature=Buffer.from(envelope.signature,'base64url')
      if(bytes.length>3000 || signature.length!==64
        || bytes.toString('base64url')!==envelope.payload
        || signature.toString('base64url')!==envelope.signature)denied()
      payload=JSON.parse(bytes.toString('utf8'))
      if(!sameKeys(payload,FIELDS))denied()
      token=envelope
    }catch{denied()}
    const principal=trust?.principals?.find(p=>p.keyId===token.keyId)
    if(!principal || principal.id!==payload.operatorId || !principal.roles.includes(role))denied()
    const issue=Date.parse(payload.issuedAt),expiry=Date.parse(payload.expiresAt)
    if(!Number.isFinite(issue) || !Number.isFinite(expiry)
      || expiry<=issue || expiry-issue>300000
      || now.getTime()<issue || now.getTime()>=expiry
      || payload.version!==1 || payload.audience!==AUDIENCE
      || payload.action!=='issue' || payload.role!==role
      || payload.email!==expected.email
      || payload.displayName!==expected.displayName
      || payload.scopeId!==expected.scopeId
      || !UUID.test(payload.scopeId)
      || !/^[0-9a-f]{32,64}$/i.test(payload.nonce))denied()
    const key=createPublicKey(principal.publicKeyPem)
    if(key.asymmetricKeyType!=='ed25519' || !verify(null,bytes,key,signature))denied()
    return {operatorId:principal.id,keyId:principal.keyId,
      sha256:createHash('sha256').update(raw).digest('hex')}
  }
  const actor=check(actorRaw,'operator'),reviewer=check(reviewerRaw,'reviewer')
  if(actor.operatorId===reviewer.operatorId || actor.keyId===reviewer.keyId
    || actor.sha256===reviewer.sha256)denied()
  return {actor,reviewer}
}
