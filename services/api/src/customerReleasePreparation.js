import {validateReleaseNotes} from './applicationUpdates.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[89ab][a-f0-9]{12}$/i
const rejected=message=>Object.assign(new Error(message),{code:'RELEASE_PREPARATION_REJECTED'})
const trim=(value,max)=>String(value??'').trim().slice(0,max)
const serialize=value=>JSON.stringify(value)

/** Pre-publication drafts can be unfinished; publication cannot. */
export function normaliseCustomerReleaseDraft({sha,notes}={}){
 if(!SHA.test(String(sha||''))||!notes||typeof notes!=='object'
   ||Array.isArray(notes)||!Array.isArray(notes.entries)||notes.entries.length>35)
  throw rejected('Choose an exact GitHub commit and up to 35 release entries.')
 const entries=notes.entries.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))
   throw rejected('Invalid release note entry.')
  const category=trim(entry.category,32).toLowerCase()||'feature'
  if(!['feature','improvement','fix','security','other'].includes(category))
   throw rejected('Unsupported release note category.')
  return {category,title:trim(entry.title,160),description:trim(entry.description,950)}
 })
 return {versionLabel:trim(notes.versionLabel,32),
  title:trim(notes.title,180),summary:trim(notes.summary,1200),entries}
}

async function lockRevision(db,sha){
 await db.query("SELECT pg_advisory_xact_lock(hashtext('customer-release-preparation'),hashtext($1))",[sha])
}
export async function saveCustomerReleaseDraft(db,{sha,notes,actorId}={}){
 if(!UUID.test(String(actorId||'')))throw rejected('A real platform administrator must save notes.')
 const normalized=normaliseCustomerReleaseDraft({sha,notes})
 await lockRevision(db,sha)
 const published=await db.query(
  'SELECT build_sha FROM hi5central_published_release_notes WHERE build_sha=$1',[sha])
 if(published.rowCount)throw rejected('Published release notes are immutable.')
 const result=await db.query([
  'INSERT INTO platform_release_preparation_drafts(build_sha,notes,edited_by)',
  'VALUES($1,$2::jsonb,$3)',
  'ON CONFLICT(build_sha) DO UPDATE SET notes=excluded.notes,',
  'edited_by=excluded.edited_by,edited_at=now()',
  'RETURNING build_sha,notes,edited_at',
 ].join(' '),[sha,serialize(normalized),actorId])
 return {buildSha:sha,notes:result.rows[0].notes,editedAt:result.rows[0].edited_at}
}
export async function readCustomerReleasePreparation(db,{sha}={}){
 if(!SHA.test(String(sha||'')))throw rejected('Exact GitHub commit SHA required.')
 const [draft,published]=await Promise.all([
  db.query('SELECT notes,edited_at FROM platform_release_preparation_drafts WHERE build_sha=$1',[sha]),
  db.query('SELECT version_label,title,summary,entries,published_at FROM hi5central_published_release_notes WHERE build_sha=$1',[sha]),
 ])
 const publishedRow=published.rows[0]
 return {buildSha:sha,draft:draft.rows[0]?.notes||null,
  editedAt:draft.rows[0]?.edited_at||null,
  published:publishedRow?{versionLabel:publishedRow.version_label,
   title:publishedRow.title,summary:publishedRow.summary,
   entries:publishedRow.entries,publishedAt:publishedRow.published_at}:null}
}
export async function publishCustomerReleaseNotes(db,{sha,notes}={}){
 if(!SHA.test(String(sha||'')))throw rejected('Exact GitHub commit SHA required.')
 await lockRevision(db,sha)
 let draft=notes
 if(draft==null){
  const stored=await db.query(
   'SELECT notes FROM platform_release_preparation_drafts WHERE build_sha=$1',[sha])
  draft=stored.rows[0]?.notes||null
 }
 if(draft==null){
  const published=await db.query(
   'SELECT build_sha FROM hi5central_published_release_notes WHERE build_sha=$1',[sha])
  if(published.rowCount)return {buildSha:sha,alreadyPublished:true}
  throw rejected('Add the release features and notes before publishing.')
 }
 const validated=validateReleaseNotes({buildSha:sha,...normaliseCustomerReleaseDraft({sha,notes:draft})})
 const existing=await db.query([
  'SELECT build_sha,version_label,title,summary,entries',
  'FROM hi5central_published_release_notes WHERE build_sha=$1 FOR UPDATE',
 ].join(' '),[sha])
 if(existing.rowCount){
  const row=existing.rows[0]
  const actual=validateReleaseNotes({buildSha:sha,versionLabel:row.version_label,
   title:row.title,summary:row.summary,entries:row.entries})
  if(serialize(actual)!==serialize(validated))
   throw rejected('This SHA was already published with different immutable release notes.')
  return {buildSha:sha,alreadyPublished:true}
 }
 await db.query([
  'INSERT INTO hi5central_published_release_notes',
  '(build_sha,version_label,title,summary,entries)',
  'VALUES($1,$2,$3,$4,$5::jsonb)',
 ].join(' '),[sha,validated.versionLabel,validated.title,
  validated.summary,serialize(validated.entries)])
 return {buildSha:sha,alreadyPublished:false,versionLabel:validated.versionLabel}
}
