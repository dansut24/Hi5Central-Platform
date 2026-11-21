// Client capability hint for authorised RMM sessions; NOT an access
// control, codec qualification, or encryption policy. The RMM API
// already authenticates the viewer token before accepting the hint.
const supported = new Set(['vp8','vp9','av1','h264','h265'])
export function normalizeStreamCoreVideoCodecs(raw) {
  if (typeof raw !== 'string' || raw.length > 128) return []
  const unique = new Set()
  for (const token of raw.toLowerCase().split(',')) {
    const code = token.trim()
    if (supported.has(code)) unique.add(code)
  }
  return [...unique].slice(0, 5)
}
export function normalizeStreamCoreBrowserFamily(value) {
  return value === 'ios-safari' ? 'ios-safari' : 'other'
}
