import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from './db.js'
import { deployment, originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'

let manifest
try {
  manifest = JSON.parse(readFileSync(resolve(process.cwd(),'release-manifest.json'),'utf8'))
} catch {
  manifest = { schemaVersion:1,sha:'',version:'development',builtAt:null,commits:[] }
}
const SHA=/^[0-9a-f]{40}$/
const LIST_LIMIT=70

export function releaseCatalog(version=manifest) {
  const commits=Array.isArray(version.commits)?version.commits:[]
  return {
    version:String(version.version||'development'),
    releaseName:String(version.releaseName||version.version||'Development build'),
    sha:String(version.sha||''),
    builtAt:version.builtAt||null,
    changes:commits.filter(c=>c.sha&&SHA.test(c.sha))
      .slice(0,LIST_LIMIT).map(c=>({
        sha:c.sha,
        title:c.subject,
        date:c.date,
        category:c.kind||'maintenance',
        components:Array.isArray(c.components)?c.components:[],
        migrations:Array.isArray(c.migrations)?c.migrations:[],
        files:Array.isArray(c.files)?c.files:[],
      })),
  }
}

export function changesSince(versions, liveSha) {
  if (!SHA.test(String(liveSha||''))) return { knownBaseline:false,changes:[],reason:'The Production version is not available yet.' }
  if (versions.sha===liveSha) return { knownBaseline:true,changes:[] }
  const index=versions.changes.findIndex(entry=>entry.sha===liveSha)
  return index<0
    ?{knownBaseline:false,changes:[],reason:'Production is older than the recorded history. Review the complete build.'}
    :{knownBaseline:true,changes:versions.changes.slice(0,index)}
}

async function requireUser(c, admin=false) {
  const session=await resolveSession(c)
  if(!session)return {error:c.json({error:'Authentication required.'},401)}
  if(!originMatchesTenant(c.req.header('origin'),session.slug))
    return {error:c.json({error:'Workspace origin mismatch.'},403)}
  if(admin&&!['owner','admin'].includes(session.tenant_role))
    return {error:c.json({error:'Organisation admin access required.'},403)}
  return {session}
}

export function registerApplicationUpdatesRoutes(app) {
  // Minimal public version only. Internal file names and notes require login.
  app.get('/api/v1/updates/version', c=>c.json({
    sha:manifest.sha,
    version:manifest.version,
    releaseName:manifest.releaseName||manifest.version,
    builtAt:manifest.builtAt,
    environment:deployment.runtimeEnvironment,
  }))

  app.get('/api/v1/updates',async c=>{
    const auth=await requireUser(c)
    if(auth.error)return auth.error
    const {changes:allChanges,...version}=releaseCatalog()
    const changes=allChanges.map(({files,...item})=>item)
    return c.json({ ...version,environment:deployment.runtimeEnvironment,
      changes,historyCount:changes.length,
      hasReviewedChanges:changes.some(c=>['feature','fix','improvement','database'].includes(c.category)),
    })
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
    const approved=Array.isArray(body?.approvedShas)?[...new Set(body.approvedShas.map(String))]:[]
    const evidence=String(body?.evidence||'').trim().slice(0,4000)
    const request=body?.requestLive===true
    const baselineSha=String(body?.baselineSha||'')
    const known=new Set(releaseCatalog().changes.map(change=>change.sha))
    if(approved.length>LIST_LIMIT||approved.some(sha=>!SHA.test(sha)||!known.has(sha)))
      return c.json({error:'The review includes changes not present in this build.'},400)
    if(request&&evidence.length<12)
      return c.json({error:'Record what was tested in UAT before requesting promotion.'},400)
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
