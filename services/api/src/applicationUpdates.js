import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'
import {callCentralDevHandoff} from './devReleaseHandoff.js'

let manifest
try {manifest=JSON.parse(readFileSync(resolve(process.cwd(),'release-manifest.json'),'utf8'))}
catch {manifest={schemaVersion:1,sha:'',version:'development',builtAt:null,commits:[]}}
const SHA=/^[0-9a-f]{40}$/
const LIST_LIMIT=70
const CATEGORIES=new Set(['feature','improvement','fix','security','other'])
const CUSTOMER_VERSION_PATTERN=/^v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc)(?:[.-]?\d+)?)?$/i
export function customerVersionLabel(value) {
  return String(value||'').trim().replace(/\+[a-f0-9]{8,40}$/i,'')
}
export function validateCustomerVersion(value) {
  const version=String(value||'').trim()
  if(!CUSTOMER_VERSION_PATTERN.test(version)||version.length>32)
    throw new Error('Enter a customer version such as 1.0.1 or 2026.10.1. Build IDs are tracked separately.')
  return version
}
function trimmed(value,max=250){return String(value??'').trim().slice(0,max)}
export function validateReleaseNotes(input){
  const buildSha=trimmed(input?.buildSha,40).toLowerCase()
  const versionLabel=validateCustomerVersion(input?.versionLabel)
  const title=trimmed(input?.title,180)
  const summary=trimmed(input?.summary,1200)
  if(!SHA.test(buildSha)||!versionLabel||!title)
    throw new Error('A valid build, version name and release title are required.')
  if(!Array.isArray(input?.entries)||input.entries.length<1||input.entries.length>35)
    throw new Error('Provide between 1 and 35 customer-facing release note entries.')
  const entries=input.entries.map((item,i)=>{
    const category=trimmed(item?.category,32).toLowerCase()
    const heading=trimmed(item?.title,160)
    const description=trimmed(item?.description,950)
    if(!CATEGORIES.has(category)||heading.length<3)
      throw new Error('Each release note needs a category and a descriptive title.')
    return {category,title:heading,description}
  })
  return {buildSha,versionLabel,title,summary,entries}
}
export function releaseCatalog(version=manifest){
  const commits=Array.isArray(version.commits)?version.commits:[]
  return {version:String(version.version||'development'),
    releaseName:String(version.releaseName||version.version||'Development build'),
    sha:String(version.sha||''),builtAt:version.builtAt||null,
    changes:commits.filter(c=>SHA.test(String(c.sha||''))).slice(0,LIST_LIMIT)
      .map(c=>({sha:c.sha,title:c.subject,date:c.date,category:c.kind||'maintenance',
        components:Array.isArray(c.components)?c.components:[],
        migrations:Array.isArray(c.migrations)?c.migrations:[],
        files:Array.isArray(c.files)?c.files:[]})),
  }
}
export function changesSince(versions,liveSha){
  if(!SHA.test(String(liveSha||'')))return {knownBaseline:false,changes:[],reason:'Production version unavailable.'}
  if(versions.sha===liveSha)return {knownBaseline:true,changes:[]}
  const index=versions.changes.findIndex(item=>item.sha===liveSha)
  return index<0?{knownBaseline:false,changes:[],reason:'Baseline outside history.'}
    :{knownBaseline:true,changes:versions.changes.slice(0,index)}
}
async function requireUser(c,admin=false){
  const session=await resolveSession(c)
  if(!session)return {error:c.json({error:'Authentication required.'},401)}
  if(!originMatchesTenant(c.req.header('origin'),session.slug))
    return {error:c.json({error:'Workspace origin mismatch.'},403)}
  if(admin&&!['owner','admin'].includes(session.tenant_role))
    return {error:c.json({error:'Organisation administrator access required.'},403)}
  return {session}
}
async function requireHi5Developer(c){
  const auth=await requireUser(c)
  if(auth.error)return auth
  if(deployment.runtimeEnvironment!=='dev')
    return {error:c.json({error:'Release notes are authored only in Dev.'},403)}
  const membership=await pool.query(
    "SELECT 1 FROM platform_admin_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
    [auth.session.user_id])
  // Dev's dedicated internal workspace owner is the development release
  // author. Never grant this privilege to owners of other tenant slugs.
  const devTeamOwner=auth.session.slug==='dev'
    &&['owner','admin'].includes(auth.session.tenant_role)
  if(!membership.rowCount&&!devTeamOwner)
    return {error:c.json({error:'Hi5Central Dev release author access required.'},403)}
  return auth
}
function publicItem(row){
  return {buildSha:row.build_sha,versionLabel:customerVersionLabel(row.version_label),title:row.title,
    summary:row.summary,entries:row.entries,publishedAt:row.published_at}
}
async function centralPublished(){
  const result=await pool.query(
    'SELECT build_sha,version_label,title,summary,entries,published_at FROM hi5central_published_release_notes ORDER BY published_at DESC LIMIT 40')
  return result.rows.map(publicItem)
}
async function publishedReleases(){
  if(deployment.runtimeEnvironment==='live'||deployment.deploymentMode==='self_hosted')
    return centralPublished()
  try{
    const response=await fetch('https://api.'+deployment.rootDomain+'/api/v1/updates/published',
      {headers:{Accept:'application/json'},signal:AbortSignal.timeout(3500)})
    if(!response.ok)return []
    const payload=await response.json()
    return Array.isArray(payload.releases)?payload.releases:[]
  }catch{return []}
}
export function registerApplicationUpdatesRoutes(app){
  app.get('/api/v1/updates/version',c=>c.json({sha:manifest.sha,version:manifest.version,
    releaseName:manifest.releaseName||manifest.version,builtAt:manifest.builtAt,
    environment:deployment.runtimeEnvironment}))
  // Public information consists ONLY of explicitly published notes. Never
  // include private commits, migrations, feature flags or Dev drafts.
  app.get('/api/v1/updates/published',async c=>{
    if(deployment.runtimeEnvironment!=='live'&&deployment.deploymentMode!=='self_hosted')
      return c.json({error:'Central release authority only.'},403)
    c.header('Cache-Control','public,max-age=60')
    return c.json({releases:await centralPublished()})
  })
  app.get('/api/v1/updates',async c=>{
    const auth=await requireUser(c)
    if(auth.error)return auth.error
    const releases=await publishedReleases()
    return c.json({sha:manifest.sha,version:manifest.version,
      releaseName:manifest.releaseName||manifest.version,builtAt:manifest.builtAt,
      environment:deployment.runtimeEnvironment,
      releases,latestPublished:releases[0]||null,
      availableReleases:releases.filter(item=>item.buildSha!==manifest.sha)})
  })
  // Dev prepares one central release record. This is an authenticated
  // Dev-session -> signed central service request; the browser never receives
  // signing keys or Platform Admin authority.
  async function devHandoff(c,action){
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    if(auth.session.slug!=='dev')
      return c.json({error:'Use the internal Hi5Central Dev workspace to submit releases.'},403)
    const request=action==='candidates'?{}:action==='read'?
      {sha:String(c.req.param('sha')||'')}:
      await c.req.json().catch(()=>null)
    if(!request||((action==='save'||action==='submit')&&!request.sha))
      return c.json({error:'Choose a verified GitHub commit.'},400)
    try{
      const result=await callCentralDevHandoff({
        action,...request,authorId:auth.session.user_id,devSlug:'dev',
      })
      return c.json(result,action==='submit'?202:200)
    }catch(error){return c.json({error:String(error.message||error)},409)}
  }
  app.get('/api/v1/updates/dev-release/candidates',c=>devHandoff(c,'candidates'))
  app.get('/api/v1/updates/dev-release/:sha',c=>devHandoff(c,'read'))
  app.put('/api/v1/updates/dev-release',c=>devHandoff(c,'save'))
  app.post('/api/v1/updates/dev-release/submit',c=>devHandoff(c,'submit'))

  // Dev release authors can correct customer-facing version metadata of
  // earlier published builds even after the Dev application itself upgrades.
  app.get('/api/v1/updates/dev-notes/history',async c=>{
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    const result=await pool.query(`
      SELECT build_sha,version_label,title,status,version_sync_state,
             published_at,version_requested_at
      FROM hi5central_release_note_drafts
      WHERE status='published'
      ORDER BY published_at DESC LIMIT 40`)
    return c.json({releases:result.rows.map(row=>({
      buildSha:row.build_sha,versionLabel:row.version_label,
      title:row.title,status:row.status,versionSyncState:row.version_sync_state,
      publishedAt:row.published_at,versionRequestedAt:row.version_requested_at,
    }))})
  })

  app.get('/api/v1/updates/dev-notes',async c=>{
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    const result=await pool.query(
      'SELECT build_sha,version_label,title,summary,entries,status,version_sync_state,edited_at,requested_at,published_at FROM hi5central_release_note_drafts WHERE build_sha=$1',
      [manifest.sha])
    const row=result.rows[0]
    return c.json({buildSha:manifest.sha,defaultVersion:customerVersionLabel(manifest.releaseName||manifest.version),
      notes:row?{buildSha:row.build_sha,versionLabel:row.version_label,
        versionSyncState:row.version_sync_state,
        title:row.title,summary:row.summary,entries:row.entries,status:row.status,
        editedAt:row.edited_at,requestedAt:row.requested_at,publishedAt:row.published_at}:null})
  })
  app.put('/api/v1/updates/dev-notes',async c=>{
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    return c.json({error:'Use the shared Dev release preparation form. Legacy local drafts are read-only.'},410)
  })
  // Version labels are editorial metadata. A correction to a published
  // release is relayed separately to the Live catalogue by the host operator.
  // Other notes and the immutable application SHA remain locked.
  app.put('/api/v1/updates/dev-notes/version',async c=>{
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    const body=await c.req.json().catch(()=>null)
    const buildSha=String(body?.buildSha||'').toLowerCase()
    if(!SHA.test(buildSha))return c.json({error:'Choose a valid published release build.'},400)
    let version
    try { version=validateCustomerVersion(body?.versionLabel) }
    catch(e){return c.json({error:e.message},400)}
    const existing=await pool.query(
      'SELECT version_label,status,version_sync_state FROM hi5central_release_note_drafts WHERE build_sha=$1',
      [buildSha])
    if(!existing.rowCount||existing.rows[0].status!=='published')
      return c.json({error:'A published release is required before changing its version.'},409)
    if(existing.rows[0].version_sync_state==='pending')
      return c.json({error:'A version correction is already pending publication.'},409)
    if(existing.rows[0].version_label===version)
      return c.json({status:'unchanged',versionLabel:version})
    const result=await pool.query(`
      UPDATE hi5central_release_note_drafts SET
        version_label=$2,version_sync_state='pending',
        version_requested_at=now(),edited_by=$3,edited_at=now()
      WHERE build_sha=$1 AND status='published' AND version_sync_state='synced'
      RETURNING build_sha,version_label,version_sync_state`,
      [buildSha,version,auth.session.user_id])
    if(!result.rowCount)return c.json({error:'The release is already being updated. Refresh and try again.'},409)
    return c.json({status:'pending',versionLabel:version,
      message:'The new customer version number is queued for the central publication service. No application deployment is required.'},202)
  })

  app.post('/api/v1/updates/dev-notes/publish',async c=>{
    const auth=await requireHi5Developer(c)
    if(auth.error)return auth.error
    return c.json({error:'Use Dev → Submit for Platform Admin approval. Legacy local publication is retired.'},410)
  })

  app.get('/api/v1/updates/uat-review',async c=>{
    const auth=await requireUser(c,true)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='uat')return c.json({error:'Reviews are recorded in UAT.'},403)
    const result=await pool.query(
      'SELECT build_sha,approved_change_shas,evidence,status,reviewed_at,requested_at FROM tenant_application_release_reviews WHERE tenant_id=$1 AND build_sha=$2',
      [auth.session.tenant_id,manifest.sha])
    const row=result.rows[0]
    return c.json({review:row?{
      buildSha:row.build_sha,approvedShas:row.approved_change_shas,
      evidence:row.evidence,status:row.status,reviewedAt:row.reviewed_at,requestedAt:row.requested_at,
    }:null})
  })

  app.post('/api/v1/updates/uat-review',async c=>{
    const auth=await requireUser(c,true)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='uat')return c.json({error:'Reviews are recorded in UAT.'},403)
    if(!SHA.test(manifest.sha))return c.json({error:'The running build has no verifiable manifest.'},409)
    const body=await c.req.json().catch(()=>null)
    const approved=body?.acceptWholeBuild===true
      ?releaseCatalog().changes.map(change=>change.sha)
      :Array.isArray(body?.approvedShas)?[...new Set(body.approvedShas.map(String))]:[]
    const evidence=String(body?.evidence||'').trim().slice(0,4000)
    const request=body?.requestLive===true
    const baselineSha=String(body?.baselineSha||'')
    const known=new Set(releaseCatalog().changes.map(change=>change.sha))
    if(approved.length>LIST_LIMIT||approved.some(sha=>!SHA.test(sha)||!known.has(sha)))
      return c.json({error:'The review includes changes not present in this build.'},400)
    if(request&&evidence.length<12)
      return c.json({error:'Record what was tested in UAT before requesting promotion.'},400)
    if(request){
      const published=await publishedReleases()
      if(!published.some(item=>item.buildSha===manifest.sha))
        return c.json({error:'Hi5Central must publish the developer-written release notes from Dev before this version can be requested for Live.'},409)
    }
    if(request) {
      // Verify Production's actual version rather than accepting a baseline
      // chosen by the requester. Missing Live version reporting falls back
      // to reviewing the entire bounded manifest (no implicit omissions).
      let verifiedProductionSha=''
      if(deployment.deploymentMode==='managed'){
        try{
          const live=await fetch('https://api.'+deployment.rootDomain+'/api/v1/updates/version',
            {headers:{Accept:'application/json'},signal:AbortSignal.timeout(3500)})
          if(live.ok)verifiedProductionSha=String((await live.json()).sha||'')
        }catch{ /* existing Live version may predate this endpoint */ }
      }
      if(verifiedProductionSha&&verifiedProductionSha!==baselineSha)
        return c.json({error:'Production changed during UAT review. Refresh and compare the releases again.'},409)
      const comparison=verifiedProductionSha
        ?changesSince(releaseCatalog(),verifiedProductionSha):{knownBaseline:false,changes:releaseCatalog().changes}
      const required=comparison.knownBaseline?comparison.changes:releaseCatalog().changes
      if(required.some(change=>!approved.includes(change.sha)))
        return c.json({error:'Every code change in this immutable build must be tested; excluding code requires a new release build.'},409)
      if(verifiedProductionSha===manifest.sha)
        return c.json({error:'This build is already running in Production.'},409)
    }
    const sql=[
      'INSERT INTO tenant_application_release_reviews',
      '(tenant_id,build_sha,approved_change_shas,evidence,status,reviewed_by,reviewed_at,requested_at,updated_at)',
      'VALUES($1,$2,$3::jsonb,$4,$5,$6,now(),CASE WHEN $7 THEN now() ELSE NULL END,now())',
      'ON CONFLICT(tenant_id,build_sha) DO UPDATE SET',
      'approved_change_shas=EXCLUDED.approved_change_shas,evidence=EXCLUDED.evidence,',
      'status=EXCLUDED.status,reviewed_by=EXCLUDED.reviewed_by,',
      'reviewed_at=now(),requested_at=EXCLUDED.requested_at,updated_at=now()',
      'RETURNING build_sha,status,reviewed_at,requested_at',
    ].join(' ')
    const result=await pool.query(sql,
      [auth.session.tenant_id,manifest.sha,JSON.stringify(approved),evidence,request?'requested':'approved',auth.session.user_id,request])
    return c.json({review:result.rows[0],message:request
      ?'UAT review saved and Live deployment requested. Shared production code still requires Platform Admin approval.'
      :'UAT review saved.'})
  })
}
