import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const AUDIENCE = 'hi5central-managed-sandbox-activation'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{30,4096}$/
const MAX_AGE_MS = 5 * 60_000
const FIELDS = ['version','audience','action','role','operatorId','tenantSlug',
  'environment','controlRequestId','localTenantId','databaseInstanceId',
  'redisInstanceId','issuedAt','expiresAt','nonce']

function fail() { throw new Error('Operator cryptographic attestation missing, expired or invalid.') }
function exactShape(value,fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value,field)))
}
function decodeToken(raw) {
  try {
    if (!raw || raw.length > 8192) fail()
    const envelope=JSON.parse(raw)
    if (!exactShape(envelope,['keyId','payload','signature'])
      || !/^[a-zA-Z0-9_.-]{3,100}$/.test(envelope.keyId)
      || !TOKEN.test(envelope.payload) || !TOKEN.test(envelope.signature)) fail()
    const bytes=Buffer.from(envelope.payload,'base64url')
    if (bytes.toString('base64url') !== envelope.payload) fail()
    const payload=JSON.parse(bytes.toString('utf8'))
    if (!exactShape(payload,FIELDS)) fail()
    const signature=Buffer.from(envelope.signature,'base64url')
    if (signature.length!==64 || signature.toString('base64url')!==envelope.signature) fail()
    return {envelope,payload,bytes,signature}
  } catch { fail() }
}

// Trust anchors must be provisioned out-of-band by authorised platform security
// administrators. A caller-provided public key must NEVER be trusted.
export function readOperatorTrustFile(filePath) {
  if (!filePath) fail()
  const stat=statSync(filePath)
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022)) fail()
  const trust=JSON.parse(readFileSync(filePath,'utf8'))
  if (!exactShape(trust,['version','principals']) || trust.version!==1
    || !Array.isArray(trust.principals) || trust.principals.length<3
    || trust.principals.length>50) fail()
  const identities=new Set(),keys=new Set(),fingerprints=new Set()
  for (const principal of trust.principals) {
    if (!exactShape(principal,['id','keyId','publicKeyPem','roles'])
      || typeof principal.id!=='string'
      || !/^[a-zA-Z0-9_.@-]{3,100}$/.test(principal.id)
      || !/^[a-zA-Z0-9_.-]{3,100}$/.test(principal.keyId)
      || !Array.isArray(principal.roles) || !principal.roles.length
      || principal.roles.some(role=>!['operator','reviewer','executor'].includes(role))
      || identities.has(principal.id) || keys.has(principal.keyId)) fail()
    const key=createPublicKey(principal.publicKeyPem)
    if (key.asymmetricKeyType!=='ed25519') fail()
    const fingerprint=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')
    if (fingerprints.has(fingerprint)) fail() // aliases must not permit a one-key two-person approval
    identities.add(principal.id);keys.add(principal.keyId);fingerprints.add(fingerprint)
  }
  return trust
}

export function verifyOperatorEvidence(raw, trust, expected, now=new Date()) {
  const {envelope,payload,bytes,signature}=decodeToken(raw)
  const principal=trust?.principals?.find(item=>item.keyId===envelope.keyId)
  if (!principal || principal.id!==payload.operatorId
    || !principal.roles.includes(expected.role)) fail()
  const duration=Date.parse(payload.expiresAt)-Date.parse(payload.issuedAt)
  const age=now.getTime()-Date.parse(payload.issuedAt)
  if (!Number.isFinite(duration) || !Number.isFinite(age)
    || duration<=0 || duration>MAX_AGE_MS || age<0 || age>duration
    || !/^[0-9a-f]{32,64}$/i.test(payload.nonce)
    || payload.version!==1 || payload.audience!==AUDIENCE
    || !['approve','activate','suspend'].includes(payload.action)) fail()
  for(const field of ['action','role','operatorId','tenantSlug','environment',
    'controlRequestId','localTenantId','databaseInstanceId','redisInstanceId']) {
    if (payload[field]!==expected[field]) fail()
  }
  for(const field of ['controlRequestId','localTenantId','databaseInstanceId','redisInstanceId']) {
    if (!UUID.test(payload[field])) fail()
  }
  if (!verify(null,bytes,createPublicKey(principal.publicKeyPem),signature)) fail()
  return {operatorId:principal.id,keyId:principal.keyId,
    digest:createHash('sha256').update(raw).digest('hex')}
}

export function verifyOperatorPair({actorToken,reviewerToken,trust,expected,now=new Date()}) {
  const actor=verifyOperatorEvidence(actorToken,trust,{...expected,role:expected.action==='activate'?'executor':'operator',operatorId:expected.actor},now)
  const reviewer=verifyOperatorEvidence(reviewerToken,trust,{...expected,role:'reviewer',operatorId:expected.reviewer},now)
  if (actor.operatorId===reviewer.operatorId || actor.keyId===reviewer.keyId
    || actor.digest===reviewer.digest) fail()
  return {actor,reviewer}
}
