// Offline signer: only independent approved operator machines should contain
// private signing material. No database connection and no assertion on stdout.
import {createPrivateKey,randomBytes,sign} from 'node:crypto'
import {lstatSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
function required(name){
  const value=String(process.env[name]||'').trim()
  if(!value)throw new Error('Missing '+name)
  return value
}
try{
  if(process.argv.slice(2).join(' ')!=='--sign')throw new Error('Usage: pilot-admin-bootstrap-sign.mjs --sign')
  const keyFile=resolve(required('BOOTSTRAP_PRIVATE_KEY_FILE'))
  const outputFile=resolve(required('BOOTSTRAP_SIGNATURE_OUTPUT'))
  if(keyFile===outputFile)throw new Error('Cannot overwrite a private key.')
  const stat=lstatSync(keyFile)
  if(!stat.isFile() || stat.size>16384 || (stat.mode&0o077))
    throw new Error('Private key must be an owner-only regular file.')
  const privateKey=createPrivateKey(readFileSync(keyFile,'utf8'))
  if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 key required.')
  const role=required('BOOTSTRAP_SIGNING_ROLE')
  if(!['operator','reviewer'].includes(role))throw new Error('Operator or reviewer role required.')
  const operatorId=required('BOOTSTRAP_SIGNING_OPERATOR_ID')
  const keyId=required('BOOTSTRAP_SIGNING_KEY_ID')
  const email=required('INITIAL_ADMIN_EMAIL').toLowerCase()
  const displayName=required('INITIAL_ADMIN_NAME')
  const scopeId=required('PILOT_CONTROL_SCOPE_ID')
  if(!/^[a-zA-Z0-9_.@-]{3,100}$/.test(operatorId)
    || !/^[a-zA-Z0-9_.-]{3,100}$/.test(keyId)
    || !/^[0-9a-f-]{36}$/i.test(scopeId)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || displayName.length<2 || displayName.length>120)
    throw new Error('Invalid principal or exact pilot scope.')
  const now=Date.now()
  const payload={version:1,audience:'hi5central-pilot-initial-platform-admin',
    action:'issue',role,operatorId,email,displayName,scopeId,
    issuedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+120000).toISOString(),
    nonce:randomBytes(24).toString('hex')}
  const bytes=Buffer.from(JSON.stringify(payload))
  const data=JSON.stringify({keyId,payload:bytes.toString('base64url'),
    signature:sign(null,bytes,privateKey).toString('base64url')})
  writeFileSync(outputFile,data+'\n',{flag:'wx',mode:0o600})
  console.log('Scoped two-minute bootstrap assertion written to protected file (contents hidden).')
}catch(error){console.error('Bootstrap signing denied:',error.message);process.exitCode=1}
