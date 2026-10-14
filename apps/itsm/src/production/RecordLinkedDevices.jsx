import { ExternalLink, Laptop, Monitor } from 'lucide-react'

/**
 * Context-only device actions. Remote access is deliberately routed through the
 * RMM device workspace, which enforces its own session and viewer checks.
 * The caller must pass tenant-scoped inventory and effective RMM permissions.
 */
export function RecordLinkedDevices({ devices = [], canView = false, canRemote = false, getDeviceUrl, onShowAll, onStartRemote, remoteBusy = false }) {
  if (!canView || !devices.length || typeof getDeviceUrl !== 'function') return null

  return (
    <section className="record-lab-device-module" aria-label="Managed devices">
      <div className="record-lab-inspector-section-title">
        <span>Managed devices</span>
        <small>{devices.length}</small>
      </div>
      {devices.slice(0, 3).map((device, index) => {
        const reference = device.rmmReference || device.reference || ''
        const name = device.name || device.hostname || reference || 'Device'
        const hasAgent = Boolean(device.agentDeviceId)
        const online = device.agentOnline === true
        const url = reference ? getDeviceUrl(reference) : ''
        return (
          <div className="record-lab-device-row" key={device.id || reference || index}>
            <span className="record-lab-device-symbol"><Laptop size={17} aria-hidden="true" /></span>
            <div>
              <strong title={name}>{name}</strong>
              <small>{hasAgent ? `Hi5Central Agent · ${online ? 'Online' : 'Offline'}` : (device.type || 'Inventory device')}</small>
            </div>
            <div className="record-lab-device-actions">
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name} in RMM`} title="Open device in RMM"><ExternalLink size={16} aria-hidden="true" /></a> : null}
              {canRemote && hasAgent && url ? (
                online
                  ? (typeof onStartRemote === 'function'
                    ? <button type="button" className="is-online" disabled={remoteBusy} onClick={() => onStartRemote(device)} aria-label={`Start remote desktop for ${name}`} title="Start remote desktop"><Monitor size={16} aria-hidden="true" /></button>
                    : <a href={url} className="is-online" target="_blank" rel="noopener noreferrer" aria-label={`Remote desktop for ${name}`} title="Open RMM to start remote desktop"><Monitor size={16} aria-hidden="true" /></a>)
                  : <span className="record-lab-device-remote-disabled" aria-label={`Remote unavailable for ${name}: agent offline`} title="Agent offline — remote unavailable"><Monitor size={16} aria-hidden="true" /></span>
              ) : null}
            </div>
          </div>
        )
      })}
      {devices.length > 3 && onShowAll ? <button className="record-lab-device-more" type="button" onClick={onShowAll}>View all {devices.length} devices <ExternalLink size={13} aria-hidden="true" /></button> : null}
    </section>
  )
}
