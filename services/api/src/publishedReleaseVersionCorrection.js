import {validateCustomerVersion} from './releaseNotesValidation.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const CONFIRM='CORRECT_HI5CENTRAL_RELEASE_NUMBER'
const fail=(message,status=409)=>Object.assign(new Error(message),{status})

/**
 * This runs ONLY inside a central API transaction after its authenticated
 * platform-owner/admin membership check. It never changes customer jobs,
 * environment assignments, release source SHAs, or published release notes.
 */
export async function correctPublishedReleaseVersion(db,{buildSha,expectedVersionLabel,
  newVersionLabel,reason,confirmation,actorId,sessionId}={}){
 if(!SHA.test(String(buildSha||'')))
  throw fail('An exact published 40-character build identifier is required.',400)
 if(!UUID.test(String(actorId||''))||!UUID.test(String(sessionId||'')))
  throw fail('An authenticated administrator session is required.',403)
 if(confirmation!==CONFIRM)
  throw fail('Explicit correction confirmation is required.',400)
 if(typeof reason!=='string'||reason.trim().length<12||reason.trim().length>500)
  throw fail('Provide a reason for the correction (12–500 characters).',400)
 let desired,expected
 try{
  desired=validateCustomerVersion(newVersionLabel)
  expected=validateCustomerVersion(expectedVersionLabel)
 }catch(error){throw fail(String(error.message||error),400)}
 if(desired===expected)throw fail('New release number must differ from the existing number.',400)

 // Serialise all creation/correction of this customer-visible label.
 // The database trigger also acquires this identical advisory key so even
 // publication through other API paths cannot create a duplicate.
 await db.query(
  "SELECT pg_advisory_xact_lock(hashtext('h5c-public-release-version'),hashtext($1))",
  [desired])
 const current=await db.query([
  'SELECT version_label,title,published_at FROM hi5central_published_release_notes',
  'WHERE build_sha=$1 FOR UPDATE',
 ].join(' '),[buildSha])
 if(current.rowCount!==1)throw fail('This published release could not be found.',404)
 if(current.rows[0].version_label!==expected)
  throw fail('The published release number has changed. Refresh before correcting it.',409)
 const conflict=await db.query([
  'SELECT 1 FROM hi5central_published_release_notes',
  'WHERE version_label=$1 AND build_sha<>$2 LIMIT 1',
 ].join(' '),[desired,buildSha])
 if(conflict.rowCount)throw fail('That Hi5Central release number is already assigned to another published release.',409)
 const changed=await db.query([
  'UPDATE hi5central_published_release_notes SET version_label=$2',
  'WHERE build_sha=$1 AND version_label=$3 RETURNING build_sha,version_label,title,published_at',
 ].join(' '),[buildSha,desired,expected])
 if(changed.rowCount!==1)throw fail('The release changed while it was being corrected.',409)
 await db.query([
  'INSERT INTO hi5central_published_version_label_audit',
  '(build_sha,previous_version_label,new_version_label)',
  'VALUES($1,$2,$3)',
 ].join(' '),[buildSha,expected,desired])
 await db.query([
  'INSERT INTO platform_admin_audit_events',
  '(actor_user_id,session_id,action,target_type,target_id,metadata)',
  "VALUES($1,$2,'release.published_version_corrected','release',$3,$4::jsonb)",
 ].join(' '),[actorId,sessionId,buildSha,JSON.stringify({
  previousVersionLabel:expected,newVersionLabel:desired,reason:reason.trim(),
  customerDeploymentsStarted:0,
 })])
 return {buildSha,previousVersionLabel:expected,versionLabel:desired,
  title:changed.rows[0].title,changedAt:new Date().toISOString(),
  deploymentsStarted:0}
}
