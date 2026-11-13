/**
 * RMM device-health observations, intentionally NOT persisted monitoring alerts.
 * This uses only the already tenant-scoped device inventory passed to the UI.
 */
export function deviceAttentionItems(devices = []) {
  if (!Array.isArray(devices)) return []
  const order = { Critical: 0, High: 1, Medium: 2 }
  return devices.flatMap((device) => {
    if (!device || typeof device !== 'object') return []
    const id = String(device.id || '').trim()
    if (!id) return []
    const name = String(device.name || device.hostname || id).trim()
    const status = String(device.status || '').trim().toLowerCase()
    const health = String(device.health || '').trim().toLowerCase()
    const offline = status === 'offline'
    if (!offline && !['critical', 'warning'].includes(health)) return []
    const severity = health === 'critical' ? 'Critical' : offline ? 'High' : 'Medium'
    const problem = offline ? 'Offline' : health === 'critical' ? 'Critical' : 'Warning'
    return [{
      id: 'device-health:' + id,
      deviceId: id,
      device: name,
      severity,
      title: name + ' — ' + problem,
      detail: offline
        ? 'The latest device inventory reports this device as offline. This is not an evaluated monitoring-policy alert.'
        : 'The latest device inventory reports ' + problem.toLowerCase() + ' health. This is not an evaluated monitoring-policy alert.',
      raised: 'Current device inventory',
      policy: 'Inventory state',
      source: 'device-health',
      status: 'Open',
    }]
  }).sort((a, b) => order[a.severity] - order[b.severity] || a.device.localeCompare(b.device))
}
