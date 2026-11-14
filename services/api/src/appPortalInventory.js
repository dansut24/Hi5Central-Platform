// Installed software from the enrolled Windows Agent is the source of truth
// for the user-facing "Installed" state. Agent/PatchHost still independently
// verifies a just-completed install against the Windows uninstall registry.
function object(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function text(v) { return String(v ?? '').trim() }
function normalized(v) { return text(v).toLowerCase().replace(/[^a-z0-9]/g, '') }

export function findInstalledApp({ app, inventory, now = Date.now() }) {
  const payload = object(inventory)
  const scannedAt = Date.parse(text(payload.deep_inventory_collected_at || payload.collected_at))
  const age = Number.isFinite(scannedAt) ? now - scannedAt : Infinity
  const fresh = age >= 0 && age <= 48 * 60 * 60 * 1000
  if (!fresh) return { installed: false, inventoryFresh: false, installedVersion: '', detection: 'inventory_stale' }

  const items = Array.isArray(object(payload.software).items) ? payload.software.items : []
  const expectedName = normalized(app.name)
  const expectedPublisher = normalized(app.publisher)
  if (expectedName.length < 3) return { installed: false, inventoryFresh: true, installedVersion: '', detection: 'not_detected' }
  const matches = items.filter(item => {
    const candidate = normalized(item?.name)
    const publisher = normalized(item?.publisher)
    const nameOk = candidate === expectedName ||
      (candidate.startsWith(expectedName) && candidate.length <= expectedName.length + 22)
    const publisherOk = !expectedPublisher || (Boolean(publisher) && (
      publisher.includes(expectedPublisher) || expectedPublisher.includes(publisher)))
    return nameOk && publisherOk
  })
  // Do not certify a different installed version as the published revision.
  const requiredVersion = text(app.version)
  const selected = requiredVersion
    ? matches.find(item => text(item.version) === requiredVersion)
    : matches[0]
  if (!selected) return {
    installed: false, inventoryFresh: true,
    installedVersion: text(matches[0]?.version),
    detection: matches.length ? 'version_mismatch' : 'not_detected',
  }
  return {
    installed: true,
    inventoryFresh: true,
    installedVersion: text(selected.version),
    detection: 'installed_software_inventory',
  }
}
