// Records the last verified device-side operation for each setting/profile/device.
// An exclusion, profile deletion or removal from desired configuration is NOT a
// Windows rollback. We refuse withdrawal while any supported previously-applied
// setting still requires a verified restoration.
export function unresolvedEndpointRestores(jobs = []) {
  const latest = new Map()
  for (const job of [...jobs].sort((a,b) => new Date(b.created_at)-new Date(a.created_at))) {
    const meta = job.request_metadata || {}
    if (!meta.endpoint_profile_id || !meta.device_id || !meta.setting_key) continue
    if (!['apply','restore'].includes(meta.action) || job.status !== 'completed') continue
    const key = [meta.endpoint_profile_id,meta.device_id,meta.setting_key].join(':')
    if (latest.has(key)) continue
    if (meta.action === 'restore' && job.verifiedRestore !== true) continue
    latest.set(key,{profileId:meta.endpoint_profile_id,deviceId:meta.device_id,settingKey:meta.setting_key,action:meta.action})
  }
  return [...latest.values()].filter((entry) => entry.action === 'apply')
}
