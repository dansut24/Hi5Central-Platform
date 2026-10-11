import { createHash, timingSafeEqual } from 'node:crypto'
import { pool, withTransaction } from './db.js'
import { deployment } from './deploymentConfig.js'
import { validateReleaseNotes, validateCustomerVersion } from './applicationUpdates.js'
import { verifiedRuntimePool } from './runtimePoolPolicy.js'
import { buildHostRoutingManifest } from './runtimePoolControl.js'
import {registerTenantUatHostAttestation} from './runtimePoolHostAttestation.js'

function configuredToken() {
  return String(process.env.RELEASE_OPERATOR_TOKEN || '').trim()
}

function authorised(c) {
  const expected = configuredToken()
  if (expected.length < 32) return false
  const header = String(c.req.header('authorization') || '')
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!supplied) return false
  const left = Buffer.from(createHash('sha256').update(supplied).digest('hex'))
  const right = Buffer.from(createHash('sha256').update(expected).digest('hex'))
  return left.length === right.length && timingSafeEqual(left, right)
}

function requireOperator(c) {
  if (configuredToken().length < 32) {
    return c.json({ error: 'Release operator is not configured.', code: 'RELEASE_OPERATOR_UNAVAILABLE' }, 503)
  }
  if (!authorised(c)) return c.json({ error: 'Release operator authentication required.' }, 401)
  return null
}



function localWindowParts(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    return Object.fromEntries(parts.map((part) => [part.type, part.value]))
  } catch {
    return localWindowParts('UTC', date)
  }
}

function minuteOfDay(value, fallback) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/)
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return hour * 60 + minute
}

function withinMaintenanceWindow(windowValue, now = new Date()) {
  const window = windowValue && typeof windowValue === 'object' && !Array.isArray(windowValue) ? windowValue : {}
  const timeZone = String(window.timezone || 'UTC')
  const local = localWindowParts(timeZone, now)
  const weekday = String(local.weekday || '').toLowerCase().slice(0,3)
  const configuredDays = Array.isArray(window.days)
    ? window.days.map((day) => String(day).toLowerCase().slice(0,3)).filter(Boolean)
    : []
  if (configuredDays.length && !configuredDays.includes(weekday)) return false
  const current = Number(local.hour || 0) * 60 + Number(local.minute || 0)
  const start = minuteOfDay(window.start, 0)
  const end = minuteOfDay(window.end, 24 * 60 - 1)
  if (start === end) return true
  return start < end ? current >= start && current < end : current >= start || current < end
}

async function queueManagedPromotion(db, { fromEnvironment, toEnvironment, releaseRef, changeIds, notBefore = null }) {
  const existing = await db.query(
    `SELECT id FROM platform_release_promotions
      WHERE from_environment=$1 AND to_environment=$2 AND release_ref=$3
        AND status IN ('requested','running','succeeded')
      LIMIT 1`,
    [fromEnvironment,toEnvironment,releaseRef],
  )
  if (existing.rowCount) return existing.rows[0].id

  const promotion = await db.query(
    `INSERT INTO platform_release_promotions
      (from_environment,to_environment,status,release_ref)
     VALUES ($1,$2,'requested',$3)
     RETURNING id`,
    [fromEnvironment,toEnvironment,releaseRef],
  )
  for (const changeId of changeIds) {
    await db.query(
      'INSERT INTO platform_release_promotion_items (promotion_id,change_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [promotion.rows[0].id,changeId],
    )
  }
  await db.query(
    `INSERT INTO platform_environment_actions
      (environment,action,payload,not_before)
     VALUES ($1,'promote',$2::jsonb,COALESCE($3::timestamptz,now()))`,
    [
      toEnvironment,
      JSON.stringify({ promotionId: promotion.rows[0].id, changeIds, releaseRef, source: 'hi5-managed-policy' }),
      notBefore,
    ],
  )
  return promotion.rows[0].id
}

async function applyManagedTenantFeatureActivation(db, environment, changeIds) {
  if (!changeIds.length || !['uat','live'].includes(environment)) return
  const featureRows = await db.query(
    `SELECT feature_key FROM platform_release_changes
      WHERE id=ANY($1::uuid[]) AND feature_key IS NOT NULL`,
    [changeIds],
  )
  if (!featureRows.rowCount) return
  const tenants = await db.query(
    `SELECT tenant_id FROM tenant_release_preferences
      WHERE update_mode='hi5_managed'`,
  )
  for (const tenant of tenants.rows) {
    for (const change of featureRows.rows) {
      await db.query(
        `INSERT INTO tenant_environment_feature_overrides
          (tenant_id,environment,feature_key,enabled)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (tenant_id,environment,feature_key) DO UPDATE
         SET enabled=true,updated_at=now()`,
        [tenant.tenant_id,environment,change.feature_key],
      )
    }
  }
}

async function continueManagedReleaseFlow(db, current, releaseRef, changeIds) {
  const preferenceResult = await db.query(
    `SELECT * FROM platform_release_preferences WHERE preference_key='deployment' LIMIT 1`,
  )
  const preference = preferenceResult.rows[0]
  if (!preference || preference.update_mode !== 'hi5_managed') return

  if (current.environment === 'test' && current.action === 'deploy') {
    if (changeIds.length) {
      await db.query(
        `INSERT INTO platform_release_test_results
          (change_id,environment,result,notes,evidence)
         SELECT id,'test','passed','Automated Hi5Central health gate passed.',
                jsonb_build_object('source','hi5-managed-policy','releaseRef',$2::text)
           FROM platform_release_changes
          WHERE id=ANY($1::uuid[])`,
        [changeIds,releaseRef],
      )
      await db.query(
        `UPDATE platform_release_changes
            SET state='ready_for_uat',updated_at=now()
          WHERE id=ANY($1::uuid[]) AND state<>'promoted'`,
        [changeIds],
      )
    }
    if (preference.uat_auto_stage) {
      await queueManagedPromotion(db, {
        fromEnvironment: 'test',
        toEnvironment: 'uat',
        releaseRef,
        changeIds,
      })
    }
    return
  }

  if (current.environment === 'uat' && current.action === 'promote') {
    if (changeIds.length) {
      await db.query(
        `INSERT INTO platform_release_test_results
          (change_id,environment,result,notes,evidence)
         SELECT id,'uat','passed','Automated Hi5Central UAT health gate passed.',
                jsonb_build_object('source','hi5-managed-policy','releaseRef',$2::text)
           FROM platform_release_changes
          WHERE id=ANY($1::uuid[])`,
        [changeIds,releaseRef],
      )
      await db.query(
        `UPDATE platform_release_changes
            SET state='selected_for_live',updated_at=now()
          WHERE id=ANY($1::uuid[]) AND state<>'promoted'`,
        [changeIds],
      )
    }
    if (preference.live_auto_promote) {
      const delayHours = Math.max(0, Math.min(720, Number(preference.live_delay_hours || 0)))
      const notBefore = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString()
      await queueManagedPromotion(db, {
        fromEnvironment: 'uat',
        toEnvironment: 'live',
        releaseRef,
        changeIds,
        notBefore,
      })
    }
  }
}

function actionPayload(row) {
  if (!row) return null
  return {
    id: row.id,
    environment: row.environment,
    action: row.action,
    status: row.status,
    payload: row.payload || {},
    requestedAt: row.requested_at,
    notBefore: row.not_before,
    startedAt: row.started_at,
  }
}

export function registerReleaseOperatorRoutes(app) {
  registerTenantUatHostAttestation(app,requireOperator)
  // Host-attested pools are immutable Docker image revisions. Neither the
  // tenant browser nor Platform Admin can provide an arbitrary upstream.
  app.post('/api/platform-operator/v1/runtime-pools/attest',async c=>{
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'The central Live authority owns runtime pool verification.'},403)
    const body=await c.req.json().catch(()=>null)
    const id=String(body?.id||'')
    const environment=String(body?.environment||'')
    const buildSha=String(body?.buildSha||'')
    const apiTarget=String(body?.apiTarget||'')
    const webTarget=String(body?.webTarget||'')
    const observedAt=new Date()
    const submitted={id,environment,build_sha:buildSha,state:'verified',
      api_target:apiTarget,web_target:webTarget,verified_at:observedAt,last_seen_at:observedAt}
    const valid=verifiedRuntimePool(submitted,observedAt)
    if(!valid.verified
      ||!/^hi5pool-[a-z0-9-]+:(?:80|3001)$/.test(apiTarget)
      ||!/^hi5pool-[a-z0-9-]+:(?:80|3001)$/.test(webTarget)
      ||!apiTarget.endsWith(':3001')||!webTarget.endsWith(':80'))
      return c.json({error:valid.reason||'Only internal, host-verified API and ITSM targets are allowed.'},400)
    const response=await pool.query([
      'INSERT INTO platform_runtime_pools',
      '(id,environment,build_sha,api_target,web_target,state,verified_at,last_seen_at,health)',
      "VALUES($1,$2,$3,$4,$5,'verified',now(),now(),$6::jsonb)",
      'ON CONFLICT (id) DO UPDATE SET',
      'last_seen_at=now(),state=EXCLUDED.state,health=EXCLUDED.health,updated_at=now()',
      'WHERE platform_runtime_pools.environment=EXCLUDED.environment',
      'AND platform_runtime_pools.build_sha=EXCLUDED.build_sha',
      'AND platform_runtime_pools.api_target=EXCLUDED.api_target',
      'AND platform_runtime_pools.web_target=EXCLUDED.web_target',
      'RETURNING id,environment,build_sha,state,last_seen_at',
    ].join(' '),[id,environment,buildSha,apiTarget,webTarget,
      JSON.stringify({apiHealthy:true,webHealthy:true,checkedBy:'host_operator'})])
    if(!response.rowCount)
      return c.json({error:'Existing runtime pool identity is immutable. Use a different pool ID for another build.'},409)
    return c.json({pool:response.rows[0],routingChanged:false})
  })

  // Preview only. A host operator will later validate this exact hash and
  // stage its Caddy generation. This endpoint NEVER activates a route.
  app.post('/api/platform-operator/v1/runtime-pools/route-plan',async c=>{
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Route plans must originate from the central Live authority.'},403)
    const body=await c.req.json().catch(()=>null)
    const environment=String(body?.environment||'')
    if(!['uat','live'].includes(environment))
      return c.json({error:'Only UAT and Live support customer route assignments.'},400)
    const assignments=await pool.query([
      'SELECT t.slug,a.environment,a.pool_id,a.build_sha,',
      'p.build_sha AS pool_build_sha,p.state AS pool_state,p.api_target,p.web_target,',
      'p.verified_at,p.last_seen_at',
      'FROM tenant_runtime_assignments a',
      'JOIN tenants t ON t.id=a.tenant_id AND t.status=$2',
      'JOIN platform_runtime_pools p ON p.id=a.pool_id AND p.environment=a.environment',
      'WHERE a.environment=$1 ORDER BY t.slug',
    ].join(' '),[environment,'active'])
    try{
      const manifest=buildHostRoutingManifest({
        environment,rows:assignments.rows,domain:deployment.rootDomain,
      })
      return c.json({manifest,activationAllowed:false,
        message:'Dry-run only. A verified and approved route generation is required before host activation.'})
    }catch(error){return c.json({error:String(error.message||'Route validation failed.')},409)}
  })

  // Publication is an editorial action initiated by authorised Hi5Central
  // developers in Dev and relayed by the trusted host. A build deployment,
  // Git push or SQL migration can NEVER publish customer release notes.
  app.post('/api/platform-operator/v1/releases/publish',async c=>{
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only the central release authority may publish customer updates.'},403)
    const body=await c.req.json().catch(()=>null)
    let notes
    try{notes=validateReleaseNotes(body)}
    catch(e){return c.json({error:e.message},400)}
    const existing=await pool.query(
      'SELECT build_sha,version_label,title,summary,entries FROM hi5central_published_release_notes WHERE build_sha=$1',
      [notes.buildSha])
    if(existing.rowCount){
      const row=existing.rows[0]
      if(row.version_label!==notes.versionLabel||row.title!==notes.title||
        row.summary!==notes.summary||JSON.stringify(row.entries)!==JSON.stringify(notes.entries))
        return c.json({error:'A different release is already published for this build. Published release notes are immutable.'},409)
      return c.json({published:true,alreadyPublished:true,buildSha:notes.buildSha})
    }
    await pool.query(
      'INSERT INTO hi5central_published_release_notes(build_sha,version_label,title,summary,entries) VALUES($1,$2,$3,$4,$5::jsonb)',
      [notes.buildSha,notes.versionLabel,notes.title,notes.summary,JSON.stringify(notes.entries)])
    return c.json({published:true,buildSha:notes.buildSha},201)
  })

  // A trusted Dev-requested label correction updates ONLY customer-facing
  // version metadata. Build SHA, changelog entries and publication date remain
  // unchanged. Every actual label change is recorded for audit.
  app.post('/api/platform-operator/v1/releases/version-correction',async c=>{
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')
      return c.json({error:'Only the central release authority may correct customer versions.'},403)
    const body=await c.req.json().catch(()=>null)
    const buildSha=String(body?.buildSha||'').toLowerCase()
    if(!/^[a-f0-9]{40}$/.test(buildSha))
      return c.json({error:'Invalid release build.'},400)
    let nextLabel
    try {nextLabel=validateCustomerVersion(body?.versionLabel)}
    catch(e){return c.json({error:e.message},400)}
    const outcome=await withTransaction(async db=>{
      const selected=await db.query(
        'SELECT version_label FROM hi5central_published_release_notes WHERE build_sha=$1 FOR UPDATE',
        [buildSha])
      if(!selected.rowCount)return {error:'Release has not been published.',status:404}
      const previous=selected.rows[0].version_label
      if(previous===nextLabel)return {corrected:true,alreadyCurrent:true,buildSha,versionLabel:nextLabel}
      const conflict=await db.query(
        'SELECT build_sha FROM hi5central_published_release_notes WHERE version_label=$1 AND build_sha<>$2 LIMIT 1',
        [nextLabel,buildSha])
      if(conflict.rowCount)return {error:'This customer version number belongs to another release.',status:409}
      await db.query(
        'UPDATE hi5central_published_release_notes SET version_label=$2 WHERE build_sha=$1',
        [buildSha,nextLabel])
      await db.query(
        'INSERT INTO hi5central_published_version_label_audit(build_sha,previous_version_label,new_version_label) VALUES($1,$2,$3)',
        [buildSha,previous,nextLabel])
      return {corrected:true,buildSha,versionLabel:nextLabel}
    })
    if(outcome.error)return c.json({error:outcome.error},outcome.status)
    return c.json(outcome)
  })

  // Only the authenticated host operator may report observed running images.
  // Never trust browser-supplied version strings for deployment status.
  app.post('/api/platform-operator/v1/deployments/report', async (c) => {
    const denied = requireOperator(c)
    if (denied) return denied
    if (deployment.runtimeEnvironment !== 'live') return c.json({ error:'Report to the central Live release authority.' },403)
    let body
    try { body=await c.req.json() } catch { return c.json({ error:'Valid JSON required.' },400) }
    const environment=String(body?.environment||'').toLowerCase()
    const status=String(body?.status||'').toLowerCase()
    const apiSha=String(body?.apiSha||'').toLowerCase()
    const itsmSha=String(body?.itsmSha||'').toLowerCase()
    const releaseRef=String(body?.releaseRef||'').slice(0,300)
    const detail=String(body?.detail||'').slice(0,1200)
    if (!['dev','test','uat','live'].includes(environment) || !['verified','deploying','failed','rolled_back'].includes(status))
      return c.json({ error:'Invalid environment or deployment status.' },400)
    if (!/^[a-f0-9]{40}$/.test(apiSha) || !/^[a-f0-9]{40}$/.test(itsmSha))
      return c.json({ error:'Both API and ITSM image revisions must be immutable 40-character commit SHAs.' },400)
    const result=await withTransaction(async db=>{
      const current=await db.query('SELECT * FROM platform_application_deployment_attestations WHERE environment=$1 FOR UPDATE',[environment])
      // Event append and current state update are one DB transaction.
      await db.query(`INSERT INTO platform_application_deployment_events
         (environment,status,api_sha,itsm_sha,release_ref,detail)
         VALUES($1,$2,$3,$4,$5,$6)`,[environment,status,apiSha,itsmSha,releaseRef,detail])
      const updated=await db.query(`INSERT INTO platform_application_deployment_attestations
         (environment,status,api_sha,itsm_sha,release_ref,detail,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT(environment) DO UPDATE SET
           status=EXCLUDED.status,api_sha=EXCLUDED.api_sha,itsm_sha=EXCLUDED.itsm_sha,
           release_ref=EXCLUDED.release_ref,detail=EXCLUDED.detail,observed_at=now()
         RETURNING environment,status,api_sha,itsm_sha,observed_at`,
        [environment,status,apiSha,itsmSha,releaseRef,detail])
      return updated.rows[0]
    })
    return c.json({ deployment:result },200)
  })

  app.get('/api/platform-operator/v1/health', (c) => {
    const denied = requireOperator(c)
    if (denied) return denied
    return c.json({
      ok: true,
      environment: deployment.runtimeEnvironment,
      operatorConfigured: true,
    })
  })

  // A separate queue handles managed-cloud API+ITSM deploys. It never
  // claims tenant feature toggles or full-stack/RMM release actions.
  // UAT administrator reviews are delivered by the trusted host, never by
  // unauthenticated UAT browsers. This records a PENDING proposal and cannot
  // deploy or activate shared Production code.
  app.post('/api/platform-operator/v1/uat-requests/relay', async (c) => {
    const denied=requireOperator(c)
    if(denied)return denied
    if(deployment.runtimeEnvironment!=='live')return c.json({error:'Use central Live release authority.'},403)
    const body=await c.req.json().catch(()=>null)
    const tenantId=String(body?.tenantId||'')
    const slug=String(body?.tenantSlug||'').toLowerCase()
    const sha=String(body?.buildSha||'').toLowerCase()
    const approved=body?.approvedShas
    const evidence=String(body?.evidence||'').slice(0,4000)
    if(!/^[0-9a-f-]{36}$/.test(tenantId)||!/^[a-z0-9-]{1,80}$/.test(slug)
      ||!/^[0-9a-f]{40}$/.test(sha)||!Array.isArray(approved)
      ||approved.length>70||approved.some(v=>!/^[0-9a-f]{40}$/.test(String(v))))
      return c.json({error:'Invalid UAT review report.'},400)
    const key=tenantId+':'+sha
    const row=await pool.query([
      'INSERT INTO platform_application_release_requests',
      '(request_key,source_tenant_slug,build_sha,approved_change_shas,evidence,reviewed_at)',
      'VALUES($1,$2,$3,$4::jsonb,$5,$6)',
      'ON CONFLICT(request_key) DO NOTHING RETURNING request_key,status',
    ].join(' '),[key,slug,sha,JSON.stringify(approved),evidence,body.reviewedAt||new Date().toISOString()])
    return c.json({received:true,requestKey:key,created:row.rowCount>0})
  })

  app.post('/api/platform-operator/v1/deployments/claim', async (c) => {
    const denied=requireOperator(c)
    if(denied) return denied
    if(deployment.runtimeEnvironment!=='live') return c.json({error:'Use the Live release authority.'},403)
    const result=await withTransaction(async db=>{
      const selected=await db.query(`SELECT * FROM platform_application_deployment_jobs
        WHERE status='requested' ORDER BY requested_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1`)
      if(!selected.rowCount) return null
      const claim=await db.query(`UPDATE platform_application_deployment_jobs
        SET status='running',started_at=now(),error_message=''
        WHERE id=$1 AND status='requested' RETURNING *`,[selected.rows[0].id])
      return claim.rows[0]||null
    })
    return c.json({job:result?{
      id:result.id,
      fromEnvironment:result.from_environment,
      toEnvironment:result.to_environment,
      apiSha:result.api_sha,
      itsmSha:result.itsm_sha,
      releaseRef:result.release_ref,
    }:null})
  })

  app.post('/api/platform-operator/v1/deployments/jobs/:id/complete', async (c) => {
    const denied=requireOperator(c)
    if(denied) return denied
    if(deployment.runtimeEnvironment!=='live') return c.json({error:'Use the Live release authority.'},403)
    const id=String(c.req.param('id')||'')
    if(!/^[a-f0-9-]{36}$/i.test(id)) return c.json({error:'Invalid job ID.'},400)
    const body=await c.req.json().catch(()=>null)
    const status=String(body?.status||'').toLowerCase()
    if(!['succeeded','failed','rolled_back'].includes(status)) return c.json({error:'Invalid completion status.'},400)
    const error=String(body?.error||'').slice(0,1600)
    const detail=body?.detail && typeof body.detail==='object' && !Array.isArray(body.detail)
      ? body.detail : {}
    const result=await withTransaction(async db=>{
      const existing=await db.query('SELECT * FROM platform_application_deployment_jobs WHERE id=$1 FOR UPDATE',[id])
      const job=existing.rows[0]
      if(!job)return {notFound:true}
      if(job.status!=='running')return {conflict:job.status}
      if(status==='succeeded'){
        const observed=await db.query(`SELECT status,api_sha,itsm_sha,observed_at
          FROM platform_application_deployment_attestations WHERE environment=$1`,[job.to_environment])
        const row=observed.rows[0]
        const age=row?Date.now()-new Date(row.observed_at).getTime():Infinity
        if(!row||row.status!=='verified'||row.api_sha!==job.api_sha||row.itsm_sha!==job.itsm_sha||age<0||age>5*60*1000){
          return {conflict:'Host image verification does not match the approved job.'}
        }
      }
      await db.query(`UPDATE platform_application_deployment_jobs
        SET status=$2,completed_at=now(),error_message=$3,detail=$4::jsonb WHERE id=$1`,
        [id,status,error,JSON.stringify(detail)])
      return {status}
    })
    if(result.notFound)return c.json({error:'Deployment job not found.'},404)
    if(result.conflict)return c.json({error:result.conflict},409)
    return c.json({status:result.status})
  })

  app.post('/api/platform-operator/v1/actions/claim', async (c) => {
    const denied = requireOperator(c)
    if (denied) return denied
    const result = await withTransaction(async (db) => {
      const next = await db.query(
        `SELECT *
           FROM platform_environment_actions
          WHERE status='requested' AND not_before<=now()
          ORDER BY not_before,requested_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      )
      const candidate = next.rows[0]
      if (!candidate) return null

      if (candidate.action === 'promote' && candidate.environment === 'live') {
        const preference = await db.query(
          `SELECT update_mode,maintenance_window
             FROM platform_release_preferences
            WHERE preference_key='deployment'
            LIMIT 1`,
        )
        const policy = preference.rows[0]
        if (policy?.update_mode === 'hi5_managed' && !withinMaintenanceWindow(policy.maintenance_window)) {
          return null
        }
      }

      const claimed = await db.query(
        `UPDATE platform_environment_actions
            SET status='running',started_at=now(),error_message=''
          WHERE id=$1 AND status='requested'
          RETURNING *`,
        [candidate.id],
      )
      const row = claimed.rows[0]
      if (!row) return null
      if (row.action === 'promote') {
        const promotionId = String(row.payload?.promotionId || '')
        if (promotionId) {
          await db.query(
            `UPDATE platform_release_promotions
                SET status='running',started_at=COALESCE(started_at,now()),error_message=''
              WHERE id=$1 AND status='requested'`,
            [promotionId],
          )
        }
      }
      return row
    })
    return c.json({ action: actionPayload(result) })
  })

  app.post('/api/platform-operator/v1/actions/:id/complete', async (c) => {
    const denied = requireOperator(c)
    if (denied) return denied
    const id = String(c.req.param('id') || '').trim()
    let body
    try { body = await c.req.json() } catch { return c.json({ error: 'A valid JSON request body is required.' }, 400) }
    const status = String(body?.status || '').trim().toLowerCase()
    if (!['succeeded','failed'].includes(status)) {
      return c.json({ error: 'status must be succeeded or failed.' }, 400)
    }
    const errorMessage = String(body?.errorMessage || '').trim().slice(0, 4000)
    const details = body?.details && typeof body.details === 'object' && !Array.isArray(body.details) ? body.details : {}
    const releaseRef = String(body?.releaseRef || '').trim().slice(0, 300)

    const result = await withTransaction(async (db) => {
      const currentResult = await db.query(
        'SELECT * FROM platform_environment_actions WHERE id=$1 FOR UPDATE',
        [id],
      )
      if (!currentResult.rowCount) return { notFound: true }
      const current = currentResult.rows[0]
      if (current.status !== 'running') return { conflict: current.status }

      const mergedPayload = { ...(current.payload || {}), operatorResult: details }
      const updated = await db.query(
        `UPDATE platform_environment_actions
            SET status=$2,completed_at=now(),error_message=$3,payload=$4::jsonb
          WHERE id=$1
          RETURNING *`,
        [id,status,errorMessage,JSON.stringify(mergedPayload)],
      )

      const promotionId = String(current.payload?.promotionId || '')
      if (current.action === 'promote' && promotionId) {
        await db.query(
          `UPDATE platform_release_promotions
              SET status=$2,completed_at=now(),error_message=$3,
                  artifact_manifest=CASE WHEN $2='succeeded' THEN $4::jsonb ELSE artifact_manifest END
            WHERE id=$1`,
          [promotionId,status,errorMessage,JSON.stringify(details?.manifest || {})],
        )
      }

      if (status === 'succeeded') {
        if (current.environment === 'test' && ['reset','deploy'].includes(current.action)) {
          await db.query(
            `UPDATE platform_environment_state
                SET last_reset_at=CASE WHEN $2='reset' THEN now() ELSE last_reset_at END,
                    last_deployed_at=now(),
                    active_release_ref=COALESCE(NULLIF($1,''),active_release_ref),updated_at=now()
              WHERE environment='test'`,
            [releaseRef || String(current.payload?.releaseRef || ''),current.action],
          )
        }

        if (current.action === 'promote' && ['uat','live'].includes(current.environment)) {
          await db.query(
            `UPDATE platform_environment_state
                SET last_deployed_at=now(),
                    active_release_ref=COALESCE(NULLIF($2,''),active_release_ref),updated_at=now()
              WHERE environment=$1`,
            [current.environment,releaseRef || String(current.payload?.releaseRef || '')],
          )

          const changeIds = Array.isArray(current.payload?.changeIds)
            ? current.payload.changeIds.map(String).filter(Boolean)
            : []
          await applyManagedTenantFeatureActivation(db, current.environment, changeIds)
          if (changeIds.length && current.environment === 'live') {
            await db.query(
              `UPDATE platform_release_changes
                  SET state='promoted',promoted_at=now(),updated_at=now()
                WHERE id=ANY($1::uuid[]) AND state='selected_for_live'`,
              [changeIds],
            )
          }
        }

        const flowChangeIds = Array.isArray(current.payload?.changeIds)
          ? current.payload.changeIds.map(String).filter(Boolean)
          : []
        const flowReleaseRef = releaseRef || String(current.payload?.releaseRef || '')
        if ((current.action === 'deploy' && current.environment === 'test')
          || (current.action === 'promote' && current.environment === 'uat')) {
          await continueManagedReleaseFlow(db, current, flowReleaseRef, flowChangeIds)
        }
      }
      return { action: updated.rows[0] }
    })

    if (result.notFound) return c.json({ error: 'Environment action not found.' }, 404)
    if (result.conflict) return c.json({ error: `Environment action is ${result.conflict}, not running.` }, 409)
    return c.json({ action: actionPayload(result.action) })
  })
}
