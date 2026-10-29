// An inventory snapshot is not the same thing as the live Agent heartbeat.
// The Agent deliberately defers full scans while a remote session is active.
export function describeInventoryAge(collectedAt, now = Date.now()) {
  if (!collectedAt) return { label: 'Not yet scanned', ageMs: null, older: false, reported: false }
  const timestamp = Date.parse(String(collectedAt))
  if (!Number.isFinite(timestamp)) return { label: 'Scan time unavailable', ageMs: null, older: false, reported: false }
  const ageMs = Math.max(0, Number(now) - timestamp)
  const minutes = Math.floor(ageMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const label = minutes < 1 ? 'Just now'
    : minutes < 60 ? `${minutes}m ago`
    : hours < 24 ? `${hours}h ${minutes % 60}m ago`
    : `${days}d ago`
  // An older snapshot is an informational cue, not an offline/fault status.
  return { label, ageMs, older: ageMs > 10 * 60_000, reported: true }
}
