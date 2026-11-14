// Hi5Central local administrator credential vault encryption.
// Secret bytes are never stored in agent job records, inventory or audit metadata.
// Each record is AEAD-bound to tenant, device, account and rotation ID.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
const ENVELOPE_VERSION = 'h5lap1'
let cachedKey

function vaultMasterKey() {
  if (cachedKey) return cachedKey
  const path = process.env.RMM_LOCAL_ADMIN_VAULT_KEY_FILE
  const supplied = path ? readFileSync(path, 'utf8').trim() : String(process.env.RMM_LOCAL_ADMIN_VAULT_KEY || '').trim()
  if (!/^[0-9a-f]{64}$/i.test(supplied)) {
    const error = new Error('Local administrator vault master key is not configured.')
    error.status = 503
    throw error
  }
  cachedKey = Buffer.from(supplied, 'hex')
  return cachedKey
}
function recordKey(tenantId, agentId) {
  return Buffer.from(hkdfSync('sha256', vaultMasterKey(), Buffer.from(String(tenantId)), Buffer.from('hi5central-laps-v1:'+agentId), 32))
}
function associatedData({ tenantId, agentId, accountId, rotationId }) {
  if (![tenantId,agentId,accountId,rotationId].every((value)=>/^[\da-f-]{36}$/i.test(String(value)))) throw new Error('Invalid local administrator credential identity.')
  return Buffer.from([ENVELOPE_VERSION,tenantId,agentId,accountId,rotationId].join(':'),'utf8')
}
export function protectLocalAdminPassword(password, context) {
  if (!validLocalAdminPassword(password)) throw new Error('Invalid generated local administrator password.')
  const aad = associatedData(context)
  const key = recordKey(context.tenantId,context.agentId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm',key,nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(password,'utf8'),cipher.final()])
  const tag = cipher.getAuthTag()
  key.fill(0)
  return [ENVELOPE_VERSION,nonce.toString('base64url'),tag.toString('base64url'),ciphertext.toString('base64url')].join('.')
}
export function revealLocalAdminPassword(envelope,context) {
  const parts = String(envelope||'').split('.')
  if (parts.length!==4 || parts[0]!==ENVELOPE_VERSION) throw new Error('Unsupported local admin vault envelope.')
  const [_,nonceValue,tagValue,ciphertextValue] = parts
  const nonce=Buffer.from(nonceValue,'base64url')
  const tag=Buffer.from(tagValue,'base64url')
  const ciphertext=Buffer.from(ciphertextValue,'base64url')
  if (nonce.length!==12||tag.length!==16||ciphertext.length<24||ciphertext.length>256) throw new Error('Invalid local administrator credential envelope.')
  const key=recordKey(context.tenantId,context.agentId)
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,nonce)
    decipher.setAAD(associatedData(context))
    decipher.setAuthTag(tag)
    const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8')
    if (!validLocalAdminPassword(plaintext)) throw new Error('Invalid decrypted credential.')
    return plaintext
  } finally { key.fill(0) }
}
export function validLocalAdminPassword(password) {
  return typeof password==='string' && password.length >= 32 && password.length <= 64 &&
    /^[A-Za-z0-9!#$%&*+?@^_~-]+$/.test(password) && /[a-z]/.test(password) &&
    /[A-Z]/.test(password) && /[0-9]/.test(password) && /[!#$%&*+?@^_~-]/.test(password)
}
export function validateDedicatedLocalAdminName(name) {
  const value=String(name||'').trim()
  if (!/^Hi5[A-Za-z0-9_-]{3,16}$/.test(value) || /^Hi5Administrator$/i.test(value)) {
    throw new Error('Use a dedicated Hi5-prefixed account name, such as Hi5Recovery.')
  }
  return value
}
export function revealMfaRecent(session,now=Date.now()) {
  const when=Date.parse(String(session?.mfa_verified_at||''))
  return Boolean(session?.session_id && Number.isFinite(when) && now>=when && now-when<=5*60*1000)
}
export function rotationMetadata(row) {
  return row ? {
    id:row.id, state:row.state, createdAt:row.created_at, escrowedAt:row.escrowed_at,
    activatedAt:row.activated_at, revealedAt:row.revealed_at,
    revealCount:Number(row.reveal_count||0),
  } : null
}
