const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../public/rmm-viewer/renderer.js'), 'utf8')
// The live Viewer now accepts a validated one-shot AV1 preconnect SDP
// proof. Keep this test aligned with the production-preserved function.
const start = source.indexOf('function universalBrowserCodecQuery(')
const end = source.indexOf('\nasync function inspectActualViewerCodecOffer()', start)
const connectAt = source.indexOf("\nfunction connectViewerSignaling(reason = 'initial') {", end)
assert.ok(start > 0 && end > start && connectAt > end,
  'capability query must precede socket creation')
const querySource = source.slice(start, end)
assert.match(source.slice(connectAt, connectAt + 1000), /universalBrowserCodecQuery\(\)/)
assert.match(source, /type: 'viewer_codec_observation'/)

function query(codecs) {
  const sandbox = { RTCRtpReceiver: codecs === null ? undefined :
    { getCapabilities: () => ({ codecs }) }, encodeURIComponent,
    preconnectAv1SdpProof: null }
  vm.runInNewContext(querySource, sandbox)
  return sandbox.universalBrowserCodecQuery()
}

test('old Safari with no receiver capability API preserves legacy handshake', () => {
  assert.equal(query(null), '')
})

test('browser advertises only actual receiver codecs, including AV1 when supported', () => {
  const result = query([
    {mimeType:'video/VP8'},
    {mimeType:'video/H264',sdpFmtpLine:'profile-level-id=42e01f'},
    {mimeType:'video/AV1'}
  ])
  assert.match(result, /codec_caps_v1=1/)
  assert.match(result, /video_codecs=vp8%2Ch264%2Cav1/)
  assert.match(result, /h264_level4=0/)
  assert.doesNotMatch(result, /h265/)
})

test('H264 level 4 only when an actual advertised receive profile supports it', () => {
  const result = query([{mimeType:'video/h264',sdpFmtpLine:'level-asymmetry-allowed=1;profile-level-id=42e028;packetization-mode=1'}])
  assert.match(result, /video_codecs=h264/)
  assert.match(result, /h264_level4=1/)
})

test('a codec-free browser does not assert support', () => {
  assert.equal(query([{mimeType:'video/rtx'}]), '')
})

test('HEVC support is never inferred; it requires the browser to advertise an HEVC decoder', () => {
  assert.match(query([{mimeType:'video/H265'}]),/video_codecs=h265/)
  assert.match(query([{mimeType:'video/HEVC'}]),/video_codecs=h265/)
  assert.equal(query([{mimeType:'video/rtx'}, {mimeType:'video/unsupported'}]),'')
})


test('production Viewer avoids false idle-screen freeze recovery', () => {
  const begin = source.indexOf('function startTransitionWatchdog()')
  const end = source.indexOf('function requestRemoteKeyframe(', begin)
  assert.ok(begin > 0 && end > begin)
  const watchdog = source.slice(begin, end)
  // A stopped cursor or unchanged static screen is not decoder failure.
  assert.match(watchdog, /const actionableStall = stalledFor > FRAME_STALL_MS/)
  assert.match(watchdog, /lastVisualActionAtMs > lastFrameAtMs/)
  assert.match(watchdog, /lastMediaPacketAtMs > lastFrameAtMs/)
  assert.match(watchdog, /requestRemoteKeyframe\("actionable-decoded-frame-stall"\)/)
  assert.doesNotMatch(watchdog, /viewer_codec_failure/)
})

test('production AV1 receive-only SDP proof is session-local and requires success', () => {
  // Preserve the working live SDP guard, which replaced the obsolete 12s
  // codec-quarantine helper from the older Viewer implementation.
  const offered = query([{mimeType:'video/vp8'}])
  assert.doesNotMatch(offered, /av1/)
  const sandbox = {
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [{mimeType:'video/vp8'}] }) },
    encodeURIComponent, preconnectAv1SdpProof: null
  }
  vm.runInNewContext(querySource, sandbox)
  const accepted=sandbox.universalBrowserCodecQuery({
    sdp_probe_ok:true, sdp_av1:true, sdp_codecs:['vp8','av1']
  })
  assert.match(accepted,/video_codecs=vp8%2Cav1/)
  const rejected=sandbox.universalBrowserCodecQuery({
    sdp_probe_ok:false, sdp_av1:true, sdp_codecs:['av1']
  })
  assert.doesNotMatch(rejected,/av1/)
})
