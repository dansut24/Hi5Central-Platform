// Audited, reversible tenant controls. Deliberately no data deletion engine.
const allowed=new Set(['suspend','archive','restore','request-purge','cancel-purge','request-export','request-import'])
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
export function checkLifecycleConfirmation(action,slug,body){
  if(!allowed.has(action))throw Error('Unknown lifecycle action.')
  if(!body||typeof body!=='object'||Array.isArray(body)||body.confirmSlug!==slug)
    throw Error('Confirm the exact tenant slug.')
  if(action==='request-purge'&&body.purgeConfirmation!=='PURGE '+slug)
    throw Error('Confirm PURGE and the exact tenant slug.')
  const reason=String(body.reason||'').trim()
  if(reason.length<8||reason.length>600)throw Error('Provide a reason of 8–600 characters.')
  const days=body.retentionDays==null?30:Number(body.retentionDays)
  if(action==='archive'&&(!Number.isInteger(days)||days<30||days>365))
    throw Error('Retention must be 30–365 days.')
  return {reason,days}
}
export function purgeEligible({state,deadline,legalHold,exportCompleted,now=new Date()}){
  const date=new Date(deadline||'')
  return state==='archived'&&!legalHold&&exportCompleted===true
    &&Number.isFinite(date.getTime())&&new Date(now)>=date
}
const query=`SELECT t.id,t.slug,t.status,l.lifecycle_state,l.previous_tenant_status,
  l.archived_at,l.restore_deadline,l.retention_days,l.legal_hold,
  l.disabled_agent_ids,l.purge_requested_at,l.reason
  FROM tenants t LEFT JOIN platform_tenant_lifecycle l ON l.tenant_id=t.id WHERE t.id=$1`
const completedExport=async(db,id)=>(await db.query(
  "SELECT EXISTS(SELECT 1 FROM platform_tenant_data_requests WHERE tenant_id=$1 AND request_type='export' AND status='completed') AS completed",
  [id])).rows[0].completed

export function registerPlatformTenantLifecycleRoutes(app,{pool,withTransaction,requireAdmin,audit,writeRoles}){
  app.get('/api/platform/v1/tenants/:id/lifecycle',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    const id=String(c.req.param('id')||'')
    if(!uuid.test(id))return c.json({error:'Invalid tenant.'},400)
    const [r,requests,exportDone]=await Promise.all([
      pool.query(query,[id]),
      pool.query(`SELECT id,request_type,status,reason,created_at,reviewed_at
        FROM platform_tenant_data_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 15`,[id]),
      completedExport(pool,id),
    ])
    if(!r.rowCount)return c.json({error:'Tenant not found.'},404)
    const row=r.rows[0],state=row.lifecycle_state||(row.status==='active'?'active':'legacy_'+row.status)
    return c.json({tenantId:id,slug:row.slug,tenantStatus:row.status,state,
      reason:row.reason||'',archivedAt:row.archived_at,restoreDeadline:row.restore_deadline,
      retentionDays:row.retention_days??30,legalHold:Boolean(row.legal_hold),
      purgeRequestedAt:row.purge_requested_at,completedExport:exportDone,
      canRequestPurge:purgeEligible({state,deadline:row.restore_deadline,
        legalHold:row.legal_hold,exportCompleted:exportDone}),
      requests:requests.rows,canManage:writeRoles.has(auth.session.role),
      canRequestPurge:auth.session.role==='owner',executionMode:'review_required_for_data_operations'})
  })
  app.post('/api/platform/v1/tenants/:id/lifecycle/:action',async c=>{
    const action=String(c.req.param('action')||'')
    const auth=await requireAdmin(c,action==='request-purge'?new Set(['owner']):writeRoles)
    if(auth.error)return auth.error
    const id=String(c.req.param('id')||'')
    if(!uuid.test(id)||!allowed.has(action))return c.json({error:'Invalid tenant or action.'},400)
    const body=await c.req.json().catch(()=>null)
    try{
      const outcome=await withTransaction(async db=>{
        const locked=await db.query(query+' FOR UPDATE OF t',[id])
        const t=locked.rows[0]
        if(!t){const e=Error('Tenant not found.');e.status=404;throw e}
        const {reason,days}=checkLifecycleConfirmation(action,t.slug,body)
        await db.query('INSERT INTO platform_tenant_lifecycle(tenant_id) VALUES($1) ON CONFLICT (tenant_id) DO NOTHING',[id])
        const {rows:[l]}=await db.query('SELECT * FROM platform_tenant_lifecycle WHERE tenant_id=$1 FOR UPDATE',[id])
        if(action==='suspend'||action==='archive'){
          if(!['active','suspended'].includes(l.lifecycle_state)||!['active','suspended'].includes(t.status))
            throw Error('Tenant must be active or suspended, not archived.')
          if(action==='suspend'&&l.lifecycle_state==='suspended')throw Error('Tenant is already suspended.')
          await db.query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()),revoked_reason='platform_tenant_lifecycle' WHERE tenant_id=$1 AND revoked_at IS NULL",[id])
          await db.query("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL",[id])
          const devices=await db.query('UPDATE rmm_agent_devices SET disabled_at=now(),updated_at=now() WHERE tenant_id=$1 AND disabled_at IS NULL RETURNING id',[id])
          const disabled=[...new Set([...(l.disabled_agent_ids||[]),...devices.rows.map(x=>x.id)])]
          await db.query('UPDATE tenants SET status=$2,updated_at=now() WHERE id=$1',[id,action==='archive'?'closed':'suspended'])
          await db.query(`UPDATE platform_tenant_lifecycle SET lifecycle_state=$2,
            previous_tenant_status=$3,
            archived_at=CASE WHEN $2='archived' THEN now() ELSE NULL END,
            restore_deadline=CASE WHEN $2='archived' THEN now()+make_interval(days=>$4::int) ELSE NULL END,
            retention_days=$4,disabled_agent_ids=$5::uuid[],reason=$6,
            updated_by=$7,updated_at=now() WHERE tenant_id=$1`,
            [id,action==='archive'?'archived':'suspended',
             l.lifecycle_state==='suspended'?(l.previous_tenant_status||'active'):t.status,
             days,disabled,reason,auth.session.user_id])
        }else if(action==='restore'){
          if(!['suspended','archived'].includes(l.lifecycle_state))throw Error('Tenant cannot be restored from its current state.')
          if(l.lifecycle_state==='archived'&&(!l.restore_deadline||new Date(l.restore_deadline)<new Date()))
            throw Error('Restore window has expired. Escalate for compliance review.')
          await db.query('UPDATE tenants SET status=$2,updated_at=now() WHERE id=$1',
            [id,l.previous_tenant_status==='pending_verification'?'pending_verification':'active'])
          if(l.disabled_agent_ids?.length)await db.query(
            'UPDATE rmm_agent_devices SET disabled_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
            [id,l.disabled_agent_ids])
          await db.query(`UPDATE platform_tenant_lifecycle SET lifecycle_state='active',
            previous_tenant_status=NULL,archived_at=NULL,restore_deadline=NULL,
            disabled_agent_ids='{}'::uuid[],purge_requested_at=NULL,purge_requested_by=NULL,
            reason=$2,updated_by=$3,updated_at=now() WHERE tenant_id=$1`,
            [id,reason,auth.session.user_id])
        }else if(action==='request-purge'){
          if(!purgeEligible({state:l.lifecycle_state,deadline:l.restore_deadline,
            legalHold:l.legal_hold,exportCompleted:await completedExport(db,id)}))
            throw Error('Purge requires expired retention, no legal hold and verified completed export.')
          await db.query(`UPDATE platform_tenant_lifecycle SET lifecycle_state='purge_requested',
            purge_requested_at=now(),purge_requested_by=$2,reason=$3,
            updated_by=$2,updated_at=now() WHERE tenant_id=$1`,
            [id,auth.session.user_id,reason])
          await db.query(`INSERT INTO platform_tenant_data_requests(tenant_id,request_type,requested_by,reason)
            VALUES($1,'purge',$2,$3)`,[id,auth.session.user_id,reason])
        }else if(action==='cancel-purge'){
          if(l.lifecycle_state!=='purge_requested')throw Error('No purge request is pending.')
          const cancelled=await db.query(`UPDATE platform_tenant_data_requests SET
            status='cancelled',updated_at=now() WHERE tenant_id=$1 AND request_type='purge'
            AND status='awaiting_review' RETURNING id`,[id])
          if(!cancelled.rowCount)throw Error('A reviewed purge request cannot be cancelled here.')
          await db.query(`UPDATE platform_tenant_lifecycle SET lifecycle_state='archived',
            purge_requested_at=NULL,purge_requested_by=NULL,reason=$2,updated_by=$3,
            updated_at=now() WHERE tenant_id=$1`,[id,reason,auth.session.user_id])
        }else{
          if(l.lifecycle_state==='purge_requested')throw Error('Transfers are blocked during a purge request.')
          const type=action==='request-export'?'export':'import'
          if(type==='import'&&t.status!=='active')throw Error('Restore the tenant before requesting an import.')
          const found=await db.query(`SELECT id FROM platform_tenant_data_requests
            WHERE tenant_id=$1 AND request_type=$2
            AND status IN ('awaiting_review','approved','processing') LIMIT 1`,[id,type])
          if(found.rowCount)throw Error('An open request already exists.')
          await db.query(`INSERT INTO platform_tenant_data_requests(tenant_id,request_type,requested_by,reason)
            VALUES($1,$2,$3,$4)`,[id,type,auth.session.user_id,reason])
        }
        await audit(c,auth.session,'tenant.lifecycle.'+action,'tenant',id,
          {slug:t.slug,reason,retentionDays:action==='archive'?days:undefined},db)
        return {ok:true,action,requestOnly:action.startsWith('request-'),slug:t.slug}
      })
      return c.json(outcome,action.startsWith('request-')?202:200)
    }catch(error){
      return c.json({error:String(error.message||'Lifecycle operation failed.')},
        error.status===404?404:409)
    }
  })
}
