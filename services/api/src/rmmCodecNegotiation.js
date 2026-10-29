// Universal codec handshake: small, dependency-free, strict validation.
// This module is transport-neutral; authorization remains in rmmRemote.
const SUPPORTED = new Set(['vp8','vp9','h264'])

export function parseViewerCodecCapabilities(params) {
  if (params?.get?.('codec_caps_v1') !== '1') return null
  const raw = String(params.get('video_codecs') || '')
  if (!raw || raw.length > 64) return null
  const values = raw.toLowerCase().split(',').map(value => value.trim())
  if (values.length > 8 || values.some(value => !SUPPORTED.has(value))) return null
  const codecs = [...new Set(values)]
  if (!codecs.length) return null
  return {
    codecs,
    h264_level4: codecs.includes('h264') && params.get('h264_level4') === '1',
  }
}

export function sanitizeViewerCodecObservation(payload, sessionId) {
  const codec = String(payload?.codec || '').toLowerCase().trim()
  if (!SUPPORTED.has(codec) || typeof sessionId !== 'string' || !sessionId ||
      sessionId.length > 160) return null
  const fields = [
    ['frames_decoded',10000000],
    ['keyframes_decoded',100000],
    ['frames_dropped',10000000],
    ['packets_received',100000000],
    ['width',7680],
    ['height',4320],
  ]
  const observation = { type: 'viewer_codec_observation', session_id: sessionId, codec }
  for (const [name,max] of fields) {
    const value = payload?.[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < 0 || value > max) return null
    observation[name] = value
  }
  if (observation.frames_decoded < 30 || observation.keyframes_decoded < 1 ||
      observation.width < 320 || observation.height < 240 ||
      observation.packets_received < observation.frames_decoded ||
      observation.frames_dropped > observation.frames_decoded / 5) return null
  // Other client-provided fields (including session_id) are discarded.
  return observation
}
