// Read-only admin tenant details: all facts are tenant-scoped.
// No invoices or backups are synthesized from estimates or stale filesystem data.
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
export const BILLING_IDLE_DAYS=30

export function billableDeviceCount(devices,now=new Date()){
  const cutoff=new Date(now).getTime()-BILLING_IDLE_DAYS*86400000
  if(!Number.isFinite(cutoff))throw Error('Invalid billing clock.')
  return devices.filter(device=>{
    if(device.disabled_at)return false
    const last=[device.last_telemetry_at,device.last_authenticated_at,
      device.websocket_connected_at].reduce((most,entry)=>{
      if(!entry)return most
      const time=new Date(entry).getTime()
      return Number.isFinite(time)?Math.max(most,time):most
    },-Infinity)
    return last>=cutoff
  }).length
}

export function estimateDeviceCharge({rmmEnabled,basePence,perDevicePence,billableCount}){
  if(!Number.isInteger(billableCount)||billableCount<0)throw Error('Invalid device count.')
  const base=basePence==null?null:Number(basePence)
  const unit=perDevicePence==null?null:Number(perDevicePence)
  if((base!==null&&(!Number.isInteger(base)||base<0))||
     (unit!==null&&(!Number.isInteger(unit)||unit<0)))
    throw Error('Invalid configured billing price.')
  return {
    baseMonthlyPence:base,deviceUnitPricePence:unit,
    billableDevices:rmmEnabled?billableCount:0,
    estimatedMonthlyPence:base!==null&&(!rmmEnabled||unit!==null)
      ?base+(rmmEnabled?unit*billableCount:0):null,
    estimatedOnly:true,excludesTax:true,
  }
}

export function registerPlatformTenantOverviewRoutes(app,{requireAdmin,pool}){
  app.get('/api/platform/v1/tenants/:id/overview',async c=>{
    const auth=await requireAdmin(c)
    if(auth.error)return auth.error
    const id=String(c.req.param('id')||'')
    if(!uuid.test(id))return c.json({error:'Invalid tenant.'},400)
    const tenant=await pool.query(`SELECT
      t.id,t.slug,t.company_name,t.status,t.created_at,
      ts.modules,ts.onboarding_completed_at,ts.tenant_url,ts.portal_url,ts.rmm_url,
      cs.plan_key,cs.billing_status,cs.billing_cycle,cs.currency,
      cs.monthly_price_pence,cs.base_monthly_price_pence,
      cs.rmm_device_price_pence,cs.trial_ends_at,cs.renewal_at,cs.next_invoice_at,
      cs.notes AS billing_notes,
      p.update_mode,p.test_auto_sync,p.uat_auto_stage,p.live_auto_promote,
      p.live_delay_hours,p.maintenance_window,
      lc.lifecycle_state,lc.archived_at,lc.restore_deadline,lc.legal_hold,
      lc.retention_days,lc.purge_requested_at
      FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id
      LEFT JOIN tenant_commercial_settings cs ON cs.tenant_id=t.id
      LEFT JOIN tenant_release_preferences p ON p.tenant_id=t.id
      LEFT JOIN platform_tenant_lifecycle lc ON lc.tenant_id=t.id
      WHERE t.id=$1 LIMIT 1`,[id])
    if(!tenant.rowCount)return c.json({error:'Tenant not found.'},404)
    const t=tenant.rows[0]
    const [devices,envs,offers,backups,invoices]=await Promise.all([
      pool.query(`SELECT id,disabled_at,last_telemetry_at,last_authenticated_at,
        websocket_connected_at,websocket_status FROM rmm_agent_devices WHERE tenant_id=$1`,[id]),
      pool.query(`SELECT e.environment,e.status,e.active_release_ref,
        e.last_deployed_at,e.updated_at,
        a.build_sha AS assigned_build_sha,a.activated_at AS assigned_at,
        p.build_sha AS pool_build_sha,p.verified_at AS pool_verified_at
        FROM tenant_environment_state e
        LEFT JOIN tenant_runtime_assignments a ON a.tenant_id=e.tenant_id
          AND a.environment=e.environment
        LEFT JOIN platform_runtime_pools p ON p.id=a.pool_id
        WHERE e.tenant_id=$1 ORDER BY CASE e.environment
          WHEN 'live' THEN 1 WHEN 'uat' THEN 2 WHEN 'test' THEN 3 ELSE 4 END`,[id]),
      pool.query(`SELECT environment,state,build_sha,maintenance_not_before,
        uat_accepted_at,promotion_approved_at,created_at
        FROM tenant_runtime_update_offers WHERE tenant_id=$1
          ORDER BY created_at DESC LIMIT 30`,[id]),
      pool.query(`SELECT DISTINCT ON(environment) environment,completed_at,
        size_bytes,verified_at,checksum_sha256,source
        FROM platform_tenant_backup_records
        WHERE tenant_id=$1 AND status='verified' ORDER BY environment,completed_at DESC`,[id]),
      pool.query(`SELECT external_invoice_id,issued_at,due_at,currency,
        total_pence,status,source
        FROM platform_tenant_invoice_records WHERE tenant_id=$1
        ORDER BY issued_at DESC LIMIT 12`,[id]),
    ])
    const rmmEnabled=Boolean(t.modules?.rmm)
    const total=devices.rows.length
    const billable=rmmEnabled?billableDeviceCount(devices.rows):0
    const cutoff=Date.now()-BILLING_IDLE_DAYS*86400000
    const last=device=>[device.last_telemetry_at,device.last_authenticated_at,
      device.websocket_connected_at].reduce((max,d)=>d?Math.max(max,new Date(d).getTime()):max,-Infinity)
    const offlineOver30Days=devices.rows.filter(d=>!d.disabled_at&&last(d)<cutoff).length
    const connected=devices.rows.filter(d=>!d.disabled_at&&d.websocket_status==='Connected'
      &&last(d)>=cutoff).length
    const disabled=devices.rows.filter(d=>Boolean(d.disabled_at)).length
    const pricing=estimateDeviceCharge({
      rmmEnabled,basePence:t.base_monthly_price_pence,
      perDevicePence:t.rmm_device_price_pence,billableCount:billable})
    const byEnv=Object.fromEntries(envs.rows.map(e=>[e.environment,e]))
    const latestBackup=Object.fromEntries(backups.rows.map(b=>[b.environment,b]))
    const pending=offers.rows.filter(o=>!['applied','cancelled','rejected','failed','rolled_back'].includes(o.state))
    return c.json({
      tenant:{id:t.id,slug:t.slug,companyName:t.company_name,status:t.status,
        createdAt:t.created_at,onboardingCompletedAt:t.onboarding_completed_at,
        modules:t.modules||{},workspaceUrl:t.tenant_url,portalUrl:t.portal_url,rmmUrl:t.rmm_url},
      subscription:{plan:t.plan_key||'custom',status:t.billing_status||'trial',
        cycle:t.billing_cycle||'monthly',trialEndsAt:t.trial_ends_at,
        renewalAt:t.renewal_at,nextInvoiceAt:t.next_invoice_at,
        currency:t.currency||'GBP',configuredMonthlyPence:t.monthly_price_pence,
        notes:t.billing_notes||'',...pricing},
      deviceUsage:{total,connected,offlineOver30Days,disabled,
        billable,windowDays:BILLING_IDLE_DAYS,
        rule:'Enabled agents with authenticated connection or telemetry in the last 30 days.'},
      environments:envs.rows.map(e=>({
        ...e,verifiedBuildSha:e.pool_verified_at&&e.assigned_build_sha===e.pool_build_sha
          ?e.assigned_build_sha:null,
        versionConfidence:e.pool_verified_at&&e.assigned_build_sha===e.pool_build_sha
          ?'host_recorded':'unverified',
        pendingUpdates:pending.filter(o=>o.environment===e.environment),
        lastVerifiedBackup:latestBackup[e.environment]||null,
      })),
      updatePolicy:{mode:t.update_mode||'unknown',
        testAutoSync:t.test_auto_sync,uatAutoStage:t.uat_auto_stage,
        liveAutoPromote:t.live_auto_promote,liveDelayHours:t.live_delay_hours,
        maintenanceWindow:t.maintenance_window||{}},
      backup:{availability:backups.rows.length?'verified_records':'no_verified_backup_records',
        environments:latestBackup},
      invoices:{items:invoices.rows,source:invoices.rows.length?'external_verified':'no_issued_invoices_recorded'},
      lifecycle:{state:t.lifecycle_state||t.status,archivedAt:t.archived_at,
        restoreDeadline:t.restore_deadline,legalHold:Boolean(t.legal_hold),
        retentionDays:t.retention_days,purgeRequestedAt:t.purge_requested_at},
      asOf:new Date().toISOString(),
    })
  })
}
