import {lstatSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

// Offline, operator-approved recipient binding, NOT an invitation or a user.
// Keep outside the repository and database; this file contains personal data.
export function verifyPilotAdminRecipientFile(path,expected){
  if(typeof path!=='string'||!path.trim())throw new Error('A protected first-Admin recipient file is required.')
  const target=resolve(path)
  const stat=lstatSync(target)
  if(!stat.isFile()||stat.size<25||stat.size>4096||(stat.mode&0o077))
    throw new Error('First-Admin recipient must be in an owner-only regular file.')
  if(typeof process.getuid==='function' && stat.uid!==process.getuid())
    throw new Error('The recipient file must belong to the approving operator.')
  let data
  try{data=JSON.parse(readFileSync(target,'utf8'))}
  catch{throw new Error('The protected first-Admin recipient file is invalid.')}
  if(!data||typeof data!=='object'||Array.isArray(data)
    ||data.version!==1||data.type!=='first-platform-admin-recipient'
    ||data.status!=='recipient_authorized_identity_and_signer_approvals_pending'
    ||data.invitationIssued!==false
    ||typeof data.email!=='string'||data.email!==expected.email
    ||typeof data.scopeId!=='string'||data.scopeId!==expected.scopeId)
    throw new Error('Pilot Admin invitation recipient or control-plane scope differs from the approved request.')
  return {email:data.email,scopeId:data.scopeId}
}
