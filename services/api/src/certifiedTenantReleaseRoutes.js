import {verifyOfficialReleaseRun,verifyDevReleaseSmoke,listOfficialReleaseCandidates} from './officialReleaseCertification.js'
import {previewGenericCertifiedRelease} from './genericReleaseDiscovery.js'
import {authoriseDirectCustomerReleaseStages,fanoutCertifiedRelease} from './certifiedReleaseFanout.js'
import {supersedeOlderCustomerReleases} from './automaticReleaseSupersession.js'
import {saveCustomerReleaseDraft,readCustomerReleasePreparation,publishCustomerReleaseNotes} from './customerReleasePreparation.js'
import {readGenericReleaseApprovals} from './genericReleaseAuthorization.js'
import {verifyDevHandoff,processDevHandoff} from './devReleaseHandoff.js'
import {readGenericTenantScope} from './genericReleaseTenantScope.js'
import {approveGenericPlanningOnly,approveGenericExecutionOnly,revokeGenericStageApproval} from './genericReleaseAdminApproval.js'

/**
 * Mainline port of reviewed PR #79 release-control endpoints.
 * Keep existing Platform Admin session authentication and audit callbacks.
 * Endpoints alone cannot grant safe worker activation; DB stage boundaries,
 * schema reconciliation, ten QA baselines and gateway proof remain separate.
 */
export function registerCertifiedTenantReleaseRoutes(app,{
  requireAdmin,WRITE_ROLES,pool,withTransaction,audit,deployment,
}={}){
  // Signed server-to-server transport, never a public release approval.
  // Validates HMAC/short expiry/replay and Dev-only author identity.
  app.post('/api/platform/v1/releases/dev-handoff',async c=>{
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only central release authority accepts Dev handoff.'},403)
    try{
      const payload=await c.req.text()
      const request=verifyDevHandoff({payload,headers:{
        time:c.req.header('x-h5c-dev-time'),
        nonce:c.req.header('x-h5c-dev-nonce'),
        signature:c.req.header('x-h5c-dev-signature'),
      }})
      const result=await withTransaction(async db=>{
        await db.query("DELETE FROM platform_dev_release_handoff_nonces WHERE received_at<now()-interval '1 day'")
        await db.query('INSERT INTO platform_dev_release_handoff_nonces(nonce) VALUES($1)',[request.nonce])
        return processDevHandoff(db,request)
      })
      return c.json(result)
    }catch(error){
      const conflict=error?.code==='23505'
      return c.json({error:conflict?'Dev release request was already used.':String(error.message||error)},409)
    }
  })

  app.get('/api/platform/v1/releases/dev-submissions',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const result=await pool.query([
      'SELECT build_sha,notes,ci_run_url,status,dev_author_id,edited_at,',
      'submitted_at,reviewed_at,rejection_reason',
      'FROM platform_dev_release_submissions ORDER BY edited_at DESC LIMIT 80',
    ].join(' '))
    return c.json({submissions:result.rows})
  })
  app.post('/api/platform/v1/releases/dev-submissions/:sha/reject',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const sha=c.req.param('sha')
    const body=await c.req.json().catch(()=>({}))
    const reason=String(body?.reason||'').trim().slice(0,500)
    if(!/^[a-f0-9]{40}$/.test(sha)||reason.length<8)
      return c.json({error:'An exact SHA and a rejection reason are required.'},400)
    const rejected=await withTransaction(async db=>{
      const result=await db.query([
        'UPDATE platform_dev_release_submissions',
        "SET status='rejected',rejection_reason=$2,reviewed_by=$3,reviewed_at=now()",
        "WHERE build_sha=$1 AND status='submitted' RETURNING build_sha,status",
      ].join(' '),[sha,reason,auth.session.user_id])
      if(!result.rowCount)throw new Error('Only a submitted release may be rejected.')
      await db.query(
        "INSERT INTO platform_admin_audit_events(actor_user_id,action,target_type,target_id,metadata) VALUES($1,'release.dev_submission_rejected','release',$2,$3::jsonb)",
        [auth.session.user_id,sha,JSON.stringify({reason})])
      return result.rows[0]
    })
    return c.json({submission:rejected})
  })

  app.get('/api/platform/v1/releases/candidates',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    try{
      const candidates=await listOfficialReleaseCandidates({
        token:process.env.GITHUB_RELEASE_READ_TOKEN})
      return c.json({candidates})
    }catch(error){
      return c.json({error:'GitHub release candidates unavailable: '+String(error.message||error)},503)
    }
  })
  app.get('/api/platform/v1/releases/preparations/:sha',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    try{
      const result=await readCustomerReleasePreparation(pool,{sha:c.req.param('sha')})
      return c.json(result)
    }catch(error){return c.json({error:String(error.message||error)},409)}
  })
  app.put('/api/platform/v1/releases/preparations/:sha',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    return c.json({error:'Release drafts are authored in Dev and submitted to Platform Admin for review.'},410)
  })

  app.get('/api/platform/v1/releases/certifications',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    const [certified,checkpoints,published]=await Promise.all([
      pool.query([
        'SELECT c.build_sha,c.status,c.ci_run_url,c.approved_at,c.created_at,',
        'n.version_label,n.title',
        'FROM platform_certified_application_releases c',
        'LEFT JOIN hi5central_published_release_notes n ON n.build_sha=c.build_sha',
        'ORDER BY c.created_at DESC LIMIT 80',
      ].join(' ')),
      pool.query('SELECT * FROM platform_release_fanout_checkpoints ORDER BY last_scan_at DESC LIMIT 80'),
      pool.query('SELECT build_sha,version_label,title,published_at FROM hi5central_published_release_notes ORDER BY published_at DESC LIMIT 80'),
    ])
    return c.json({certifications:certified.rows,fanout:checkpoints.rows,published:published.rows})
  })

  // Read-only automatic all-onboarded ITSM tenant discovery.
  // There is no named pilot and no need for platform staff to enrol tenants.
  app.get('/api/platform/v1/releases/generic-tenant-scope',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    try{return c.json(await readGenericTenantScope(pool))}
    catch(error){return c.json({error:String(error.message||error).slice(0,350)},409)}
  })

  app.post('/api/platform/v1/releases/generic-tenant-scope/pilot',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    return c.json({error:'Named pilot enrollment is retired. All eligible ITSM tenants are automatically discovered.'},410)
  })

  // Read-only preview of all eligible tenants for one certified revision.
  // Never enqueues jobs or exposes DB credentials. Stage approval is shown
  // separately from tenant eligibility and the global execution pause.
  app.get('/api/platform/v1/releases/generic-preview/:sha',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const sha=c.req.param('sha')
    if(!/^[a-f0-9]{40}$/.test(sha))
      return c.json({error:'Exact immutable SHA required.'},400)
    try{
      const result=await previewGenericCertifiedRelease(pool,{sha,maxTenants:10000})
      const global=(await pool.query(
        'SELECT paused FROM platform_release_rollout_control WHERE singleton=true'
      )).rows[0]
      return c.json({...result,readOnly:true,globallyPaused:global?.paused!==false})
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},409)}
  })

  app.get('/api/platform/v1/releases/generic-stage-approvals/:sha',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    const sha=c.req.param('sha')
    if(!/^[a-f0-9]{40}$/.test(sha))
      return c.json({error:'Exact immutable SHA required.'},400)
    const approvals=await readGenericReleaseApprovals(pool,{sha})
    const auditTable=(await pool.query(
      "SELECT to_regclass('public.platform_release_generic_approval_audit') AS relation"
    )).rows[0]?.relation
    const history=auditTable?(await pool.query([
      'SELECT environment,actor_id,action,previous_state,next_state,occurred_at',
      'FROM platform_release_generic_approval_audit',
      'WHERE build_sha=$1 ORDER BY occurred_at DESC LIMIT 100',
    ].join(' '),[sha])).rows:[]
    return c.json({buildSha:sha,approvals,history,executionGloballyEnabled:false})
  })

  // Human-approved planning only. It NEVER grants worker execution or unpauses
  // the fleet. The database trigger also audits direct/indirect changes.
  app.post('/api/platform/v1/releases/generic-stage-approvals/:sha/planning',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const member=await pool.query([
      'SELECT 1 FROM platform_admin_members',
      "WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
    ].join(' '),[auth.session.user_id])
    if(!member.rowCount)return c.json({error:'Platform owner/admin approval required.'},403)
    const request={sha:c.req.param('sha'),body:await c.req.json().catch(()=>null),
      actorId:auth.session.user_id}
    try{
      const result=await withTransaction(db=>approveGenericPlanningOnly(db,request))
      await audit(c,auth.session,'release.generic_planning_approved','release',
        result.build_sha,{environment:result.environment,expiresAt:result.expires_at,
          executionEnabled:false})
      return c.json({approval:result,globallyUnpaused:false},202)
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},409)}
  })

  // Distinct, audit-logged permission: authorise ONLY this certified
  // SHA/stage to execute during a short window. Global pause stays untouched;
  // host gateway and tenant/maintenance gates remain mandatory.
  app.post('/api/platform/v1/releases/generic-stage-approvals/:sha/execution',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const member=await pool.query([
      'SELECT 1 FROM platform_admin_members',
      "WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
    ].join(' '),[auth.session.user_id])
    if(!member.rowCount)return c.json({error:'Platform owner/admin execution approval required.'},403)
    const request={sha:c.req.param('sha'),body:await c.req.json().catch(()=>null),
      actorId:auth.session.user_id}
    try{
      const result=await withTransaction(db=>approveGenericExecutionOnly(db,request))
      await audit(c,auth.session,'release.generic_execution_approved','release',
        result.build_sha,{environment:result.environment,expiresAt:result.expires_at,
          globalRolloutPaused:true})
      return c.json({approval:result,workerStarted:false,globallyUnpaused:false},202)
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},409)}
  })

  app.post('/api/platform/v1/releases/generic-stage-approvals/:sha/revoke',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const member=await pool.query([
      'SELECT 1 FROM platform_admin_members',
      "WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
    ].join(' '),[auth.session.user_id])
    if(!member.rowCount)return c.json({error:'Platform owner/admin approval required.'},403)
    const body=await c.req.json().catch(()=>null)
    try{
      const result=await withTransaction(db=>revokeGenericStageApproval(db,{
        sha:c.req.param('sha'),stage:body?.environment,actorId:auth.session.user_id,
      }))
      await audit(c,auth.session,'release.generic_stage_revoked','release',
        result.build_sha,{environment:result.environment,executionEnabled:false})
      return c.json({revoked:true,approval:result})
    }catch(error){return c.json({error:String(error.message||error).slice(0,350)},409)}
  })

  app.post('/api/platform/v1/releases/certifications/approve',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only central Production authority may certify releases.'},403)
    const member=await pool.query([
      'SELECT 1 FROM platform_admin_members',
      "WHERE user_id=$1 AND status='active' AND role IN ('owner','admin') LIMIT 1",
    ].join(' '),[auth.session.user_id])
    if(!member.rowCount)return c.json({error:'Active Hi5Central staff approval is required.'},403)
    const body=await c.req.json().catch(()=>null)
    const sha=String(body?.buildSha||'').toLowerCase()
    const runUrl=String(body?.ciRunUrl||'')
    const releaseToCustomers=body?.releaseToCustomers===true
    if(!/^[a-f0-9]{40}$/.test(sha))
      return c.json({error:'Exact release SHA40 required.'},400)
    let certification,smoke
    try{
      certification=await verifyOfficialReleaseRun({
        sha,runUrl,token:process.env.GITHUB_RELEASE_READ_TOKEN,
      })
      smoke=await verifyDevReleaseSmoke({sha})
    }catch(error){
      return c.json({error:'Release gates failed: '+String(error.message||error)},409)
    }
    try{
      const saved=await withTransaction(async db=>{
        // CI and Dev smoke were checked BEFORE this transaction. Any
        // validation, scope or queue failure rolls publication back too.
        if(releaseToCustomers){
          const handoff=await db.query([
            'SELECT notes,ci_run_url,status FROM platform_dev_release_submissions',
            'WHERE build_sha=$1 FOR UPDATE',
          ].join(' '),[sha])
          const record=handoff.rows[0]
          if(record?.status!=='submitted'||record.ci_run_url!==runUrl)
            throw new Error('Dev must submit this exact GitHub SHA and CI run for Platform Admin approval first.')
          if(body?.releaseNotes!==undefined)
            throw new Error('Submitted Dev release notes are immutable; Admin may approve or reject, not rewrite.')
          await publishCustomerReleaseNotes(db,{sha,notes:record.notes})
        }else{
          const published=await db.query(
            'SELECT build_sha FROM hi5central_published_release_notes WHERE build_sha=$1',[sha])
          if(!published.rowCount)
            throw new Error('Publish the reviewed version and changelog first.')
        }
        const existing=await db.query([
          'SELECT build_sha,status,ci_run_url FROM platform_certified_application_releases',
          'WHERE build_sha=$1 FOR UPDATE',
        ].join(' '),[sha])
        const alreadyApproved=existing.rowCount===1
          &&existing.rows[0].status==='approved'
          &&existing.rows[0].ci_run_url===runUrl
        if(existing.rowCount&&!alreadyApproved)
          throw new Error('This SHA has a different certification or was revoked.')
        if(!alreadyApproved){
          const evidence={...certification.evidence,smoke:smoke.smoke,
            jobs:certification.jobs,githubVerifiedAt:certification.verifiedAt,
            devVerifiedAt:smoke.verifiedAt}
          await db.query([
            'INSERT INTO platform_certified_application_releases',
            '(build_sha,status,ci_run_url,evidence,approved_by,approved_at)',
            "VALUES($1,'approved',$2,$3::jsonb,$4,now())",
          ].join(' '),[sha,runUrl,JSON.stringify(evidence),auth.session.user_id])
          await db.query([
            'INSERT INTO platform_release_fanout_events',
            '(build_sha,event_type,actor_id,details)',
            "VALUES($1,'approved',$2,$3::jsonb)",
          ].join(' '),[sha,auth.session.user_id,JSON.stringify({
            ciRunUrl:runUrl,origin:'staff-approved-GitHub-ci-verified',
          })])
        }
        if(releaseToCustomers){
          // One staff decision authorises both customer tracks. These guards
          // never unpause workers, skip tenant UAT consent or bypass host gates.
          await authoriseDirectCustomerReleaseStages(db,{
            sha,actorId:auth.session.user_id,ciRunUrl:runUrl})
          // Retire never-claimed older-version jobs BEFORE planning the new
          // revision. The entire supersession, fanout and audit event commit
          // atomically; a failed certification never strands the queue.
          const supersession=await supersedeOlderCustomerReleases(db,{
            newSha:sha,actorId:auth.session.user_id})
          const plan=await fanoutCertifiedRelease(db,{
            sha,scope:'generic',deliveryMode:'direct_customer_release',
            limit:200,
          })
          await db.query([
            'UPDATE platform_dev_release_submissions',
            "SET status='approved',reviewed_by=$2,reviewed_at=now()",
            "WHERE build_sha=$1 AND status='submitted'",
          ].join(' '),[sha,auth.session.user_id])
          const rolloutControl=await db.query(
            'SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
          const globallyPaused=rolloutControl.rows[0]?.paused!==false
          await db.query([
            'INSERT INTO platform_release_fanout_events',
            '(build_sha,event_type,actor_id,details)',
            "VALUES($1,'release_to_customers',$2,$3::jsonb)",
          ].join(' '),[sha,auth.session.user_id,JSON.stringify({
            deliveryMode:'direct_customer_release',
            scanned:plan.scanned,queued:plan.queued,alreadyQueued:plan.alreadyQueued,
            superseded: supersession.supersededCount,
            supersededJobIds: supersession.supersededJobIds,
          })])
          return {approved:true,alreadyApproved,buildSha:sha,
            releaseToCustomers:true,queued:plan.queued,
            superseded:supersession.supersededCount,
            alreadyQueued:plan.alreadyQueued,scanned:plan.scanned,
            blocked:plan.blocked,deliveryMode:plan.deliveryMode,globallyPaused}
        }
        return {approved:true,alreadyApproved,buildSha:sha,
          queuedForPlanner:true}

      })
      await audit(c,auth.session,
        releaseToCustomers?'release.published_to_customers':'release.certified',
        'release',sha,{ciRunUrl:runUrl,automaticFanout:true,
          releaseToCustomers,queued:saved.queued??null})
      return c.json(saved,saved.alreadyApproved?200:202)
    }catch(error){return c.json({error:String(error.message||error)},409)}
  })

  app.post('/api/platform/v1/releases/certifications/:sha/revoke',async c=>{
    const auth=await requireAdmin(c,WRITE_ROLES)
    if(auth.error)return auth.error
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Central release authority only.'},403)
    const sha=c.req.param('sha')
    if(!/^[a-f0-9]{40}$/.test(sha))
      return c.json({error:'Invalid immutable release SHA.'},400)
    const result=await withTransaction(async db=>{
      const changed=await db.query([
        'UPDATE platform_certified_application_releases',
        "SET status='revoked',updated_at=now()",
        "WHERE build_sha=$1 AND status='approved' RETURNING build_sha",
      ].join(' '),[sha])
      if(changed.rowCount)await db.query([
        'INSERT INTO platform_release_fanout_events(build_sha,event_type,actor_id,details)',
        "VALUES($1,'revoked',$2,$3::jsonb)",
      ].join(' '),[sha,auth.session.user_id,JSON.stringify({
        reason:'human-revocation',note:'Existing running jobs require separate global pause',
      })])
      return changed.rowCount
    })
    if(result)await audit(c,auth.session,'release.certification_revoked','release',sha)
    return c.json({revoked:Boolean(result),buildSha:sha})
  })

}
