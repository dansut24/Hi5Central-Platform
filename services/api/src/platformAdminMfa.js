import {
  createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual,
} from 'node:crypto'

// Mandatory pilot-only until all existing managed estates can safely migrate.
// Without this flag, the existing non-pilot login route remains untouched.
export const platformAdminMfaRequired =
  process.env.PLATFORM_ADMIN_MFA_REQUIRED === 'true'
const CHALLENGE_SECONDS=600
const MAX_ATTEMPTS=8
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function key() {
  const value=String(process.env.MFA_ENCRYPTION_KEY||'').trim()
  const result=/^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value,'hex') : Buffer.from(value,'base64url')
  if(result.length!==32)throw new Error('Valid Admin MFA encryption key is required.')
  return result
}
export function encryptAdminTotp(secret) {
  const iv=randomBytes(12)
  const cipher=createCipheriv('aes-256-gcm',key(),iv)
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()])
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')].join('.')
}
export function decryptAdminTotp(value) {
  const parts=String(value||'').split('.')
  if(parts.length!==4||parts[0]!=='v1')throw new Error('Invalid Admin MFA record.')
  const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(parts[1],'base64url'))
  decipher.setAuthTag(Buffer.from(parts[2],'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(parts[3],'base64url')),decipher.final()]).toString('utf8')
}
function base32(buffer) {
  let result='',bits=0,value=0
  for(const byte of buffer) {
    value=(value<<8)|byte;bits+=8
    while(bits>=5){result+=BASE32[(value>>>(bits-5))&31];bits-=5}
  }
  if(bits)result+=BASE32[(value<<(5-bits))&31]
  return result
}
function fromBase32(secret) {
  let value=0,bits=0;const result=[]
  for(const char of secret) {
    const digit=BASE32.indexOf(char)
    if(digit<0)throw new Error('Invalid MFA seed.')
    value=(value<<5)|digit;bits+=5
    if(bits>=8){result.push((value>>>(bits-8))&255);bits-=8}
  }
  return Buffer.from(result)
}
export function makeAdminTotpSecret(){return base32(randomBytes(20))}
export function adminTotpCode(secret,step=Math.floor(Date.now()/30000)) {
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step))
  const digest=createHmac('sha1',fromBase32(secret)).update(counter).digest()
  const offset=digest[19]&15
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,'0')
}
export function verifyAdminTotp(secret,code,lastStep=null,now=Date.now()){
  if(!/^\d{6}$/.test(String(code||'')))return null
  const timeStep=Math.floor(now/30000)
  for(const shift of [-1,0,1]) {
    const step=timeStep+shift
    if(lastStep!==null&&lastStep!==undefined&&step<=Number(lastStep))continue
    const expected=Buffer.from(adminTotpCode(secret,step))
    if(timingSafeEqual(expected,Buffer.from(String(code))))return step
  }
  return null
}
export const adminMfaChallengeHash=token=>createHash('sha256').update(token).digest('hex')
export async function createAdminMfaChallenge(db,userId) {
  const token=randomBytes(32).toString('base64url')
  await db.query(`UPDATE platform_admin_mfa_challenges SET used_at=now()
    WHERE user_id=$1 AND used_at IS NULL`,[userId])
  await db.query(`INSERT INTO platform_admin_mfa_challenges(user_id,token_hash,expires_at)
    VALUES ($1,$2,now()+make_interval(secs=>$3::int))`,
    [userId,adminMfaChallengeHash(token),CHALLENGE_SECONDS])
  return {challengeToken:token,mfaRequired:true,expiresInSeconds:CHALLENGE_SECONDS}
}
export async function lockAdminMfaChallenge(db,token){
  if(!/^[a-zA-Z0-9_-]{43}$/.test(String(token||'')))return null
  const result=await db.query(`SELECT c.id,c.user_id,c.attempts,c.expires_at,m.role,
           a.encrypted_secret,a.enabled,a.last_used_step,a.recovery_code_hashes
     FROM platform_admin_mfa_challenges c
     JOIN platform_admin_members m ON m.user_id=c.user_id AND m.status='active'
     LEFT JOIN platform_admin_mfa_methods a ON a.user_id=c.user_id
     WHERE c.token_hash=$1 AND c.used_at IS NULL AND c.expires_at>now()
       AND c.attempts<$2 FOR UPDATE OF c`,
    [adminMfaChallengeHash(token),MAX_ATTEMPTS])
  return result.rows[0]||null
}
export async function setupAdminMfa(db,challenge) {
  if(challenge.enabled)throw Object.assign(new Error('MFA has already been enrolled.'),{status:409})
  const secret=challenge.encrypted_secret
    ? decryptAdminTotp(challenge.encrypted_secret):makeAdminTotpSecret()
  if(!challenge.encrypted_secret)await db.query(`INSERT INTO platform_admin_mfa_methods
    (user_id,encrypted_secret) VALUES($1,$2)
    ON CONFLICT(user_id) DO NOTHING`,[challenge.user_id,encryptAdminTotp(secret)])
  return {secret,setupRequired:true,issuer:'Hi5Central Platform Admin'}
}
export function makeAdminRecoveryCodes(){
  return Array.from({length:10},()=>{
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes=randomBytes(16)
    const raw=Array.from(bytes,b=>chars[b%chars.length]).join('')
    return raw.match(/.{1,4}/g).join('-')
  })
}
const recoveryHash=value=>createHash('sha256')
  .update(String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'')).digest('hex')

export async function checkAdminMfaCode(db,challenge,code) {
  if(!challenge.encrypted_secret)return {ok:false}
  const provided=String(code||'').trim()
  const secret=decryptAdminTotp(challenge.encrypted_secret)
  const step=verifyAdminTotp(secret,provided,challenge.last_used_step)
  const hashes=Array.isArray(challenge.recovery_code_hashes)
    ?challenge.recovery_code_hashes:[]
  const hash=recoveryHash(provided)
  const recoveryIndex=challenge.enabled && /^[A-Z0-9-]{16,25}$/i.test(provided)
    ?hashes.indexOf(hash):-1
  if(step===null && recoveryIndex<0) {
    await db.query('UPDATE platform_admin_mfa_challenges SET attempts=attempts+1 WHERE id=$1',[challenge.id])
    return {ok:false}
  }
  const recoveryCodes=!challenge.enabled?makeAdminRecoveryCodes():null
  const newHashes=recoveryCodes?recoveryCodes.map(recoveryHash)
    :recoveryIndex>=0?hashes.filter((_,i)=>i!==recoveryIndex):hashes
  const updated=await db.query(`UPDATE platform_admin_mfa_methods SET
    enabled=true,last_used_step=COALESCE($2,last_used_step),
    recovery_code_hashes=$3::jsonb,
    enrolled_at=COALESCE(enrolled_at,now()),updated_at=now()
    WHERE user_id=$1 AND ($2::bigint IS NULL OR last_used_step IS NULL OR last_used_step<$2)
      AND recovery_code_hashes=$4::jsonb RETURNING user_id`,
    [challenge.user_id,step,JSON.stringify(newHashes),JSON.stringify(hashes)])
  if(updated.rowCount!==1)return {ok:false}
  await db.query('UPDATE platform_admin_mfa_challenges SET used_at=now() WHERE id=$1',[challenge.id])
  return {ok:true,firstEnrollment:!challenge.enabled,recoveryCodes}
}
