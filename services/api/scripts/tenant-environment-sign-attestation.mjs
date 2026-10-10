// Offline operator workstation utility. It never connects to a database,
// sends a network request, or prints credentials/signatures to stdout.
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import { readFileSync, lstatSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function required(name) {
  const value=String(process.env[name]||'').trim()
  if (!value) throw new Error(name+' must be supplied on the secure signing workstation.')
  return value
}
function signOffline() {
  if(process.argv.length!==3 || process.argv[2]!=='--sign'){
    throw new Error('Usage: tenant-environment-sign-attestation.mjs --sign')
  }
  const keyPath=resolve(required('SANDBOX_SIGNING_PRIVATE_KEY_FILE'))
  const output=resolve(required('SANDBOX_SIGNING_OUTPUT_FILE'))
  if (keyPath===output) throw new Error('The signature output cannot overwrite a private key.')
  const fileStat=lstatSync(keyPath)
  if(!fileStat.isFile() || fileStat.size>16384 || (fileStat.mode&0o077)){
    throw new Error('Private signing key must be a non-symlink, owner-only file.')
  }
  const key=createPrivateKey(readFileSync(keyPath,'utf8'))
  if(key.asymmetricKeyType!=='ed25519'){
    throw new Error('Only Ed25519 operator signing keys are supported.')
  }
  const action=required('SANDBOX_SIGNING_ACTION')
  const role=required('SANDBOX_SIGNING_ROLE')
  if(!['approve','activate','suspend'].includes(action)
    || !['operator','reviewer','executor'].includes(role)
    || (role==='executor' && action!=='activate')
    || (role==='operator' && action==='activate')){
    throw new Error('Action and signing role are incompatible.')
  }
  const value={
    version:1,
    audience:'hi5central-managed-sandbox-activation',
    action,role,operatorId:required('SANDBOX_SIGNING_OPERATOR_ID'),
    tenantSlug:required('TENANT_SLUG'),environment:required('TARGET_ENVIRONMENT'),
    controlRequestId:required('PROVISION_REQUEST_ID'),
    localTenantId:required('LOCAL_TENANT_ID'),
    databaseInstanceId:required('DATABASE_INSTANCE_ID'),
    redisInstanceId:required('REDIS_INSTANCE_ID'),
    issuedAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+2*60_000).toISOString(),
    nonce:randomBytes(24).toString('hex'),
  }
  if(!['uat','test'].includes(value.environment)
    || !/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(value.tenantSlug)
    || !/^[a-zA-Z0-9_.@-]{3,100}$/.test(value.operatorId)
    || !['controlRequestId','localTenantId','databaseInstanceId','redisInstanceId']
      .every(field=>UUID.test(value[field]))){
    throw new Error('Invalid environment, tenant, operator or scope identifier.')
  }
  const keyId=required('SANDBOX_SIGNING_KEY_ID')
  if(!/^[a-zA-Z0-9_.-]{3,100}$/.test(keyId)) throw new Error('Invalid key ID.')
  const bytes=Buffer.from(JSON.stringify(value))
  const envelope={keyId,payload:bytes.toString('base64url'),
    signature:sign(null,bytes,key).toString('base64url')}
  // Exclusive create, mode 0600: no overwrite and never print assertions.
  writeFileSync(output,JSON.stringify(envelope)+'\n',{flag:'wx',mode:0o600})
  console.log('Signed, short-lived operator assertion written to a restricted file.')
}
try {signOffline()}catch(e){console.error('Offline signing denied:',e.message);process.exitCode=1}
