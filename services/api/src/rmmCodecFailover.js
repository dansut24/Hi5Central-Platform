// Safe, authenticated per-session decoder failure recovery.
// Pure, dependency-free helpers: no device-wide codec quarantines.
export function offeredPrimaryVideoCodec(sdp) {
  if (typeof sdp !== 'string' || sdp.length > 1000000) return ''
  const section = sdp.split(/(?:^|\r?\n)m=video\s/i)[1]?.split(/\r?\nm=/)[0] || ''
  const names = new Set()
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^a=rtpmap:\d+\s+([a-z0-9_-]+)\/90000\s*$/i)
    if (!match) continue
    const raw = match[1].toLowerCase()
    const codec = raw === 'hevc' ? 'h265' : raw
    if (['vp8','vp9','h264','av1','h265'].includes(codec)) names.add(codec)
  }
  // Never retry when SDP offers multiple primary codecs: the selected
  // RTP codec is not known and the report cannot be safely bound to it.
  return names.size === 1 ? [...names][0] : ''
}

export function canRetryOfferedCodec({viewerClient, reportedCodec, offeredCodec, attempts, reason}) {
  return viewerClient === 'browser' &&
    ['vp9','h264','av1','h265'].includes(offeredCodec) &&
    reportedCodec === offeredCodec &&
    ['decode-unavailable','media-negotiation-timeout'].includes(reason) &&
    Number.isInteger(attempts) && attempts === 0
}
