const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../public/rmm-viewer/renderer.js'), 'utf8')
const start = source.indexOf('function universalBrowserCodecQuery() {')
const end = source.indexOf("\nfunction connectViewerSignaling(reason = 'initial') {", start)
assert.ok(start > 0 && end > start, 'capability query must precede socket creation')
const querySource = source.slice(start, end)
assert.match(source.slice(end, end + 800), /universalBrowserCodecQuery\(\)/)
assert.match(source, /type: 'viewer_codec_observation'/)

function query(codecs) {
  const sandbox = { RTCRtpReceiver: codecs === null ? undefined :
    { getCapabilities: () => ({ codecs }) }, encodeURIComponent }
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


test('12-second first-frame codec failure requires active RTP, not idle or network stall', () => {
  const start=source.indexOf('function shouldTriggerCodecDecoderFallback({')
  const end=source.indexOf('function startTransitionWatchdog()',start)
  assert.ok(start>=0 && end>start)
  const sandbox={}
  vm.runInNewContext(source.slice(start,end),sandbox)
  const check=sandbox.shouldTriggerCodecDecoderFallback
  const good={codec:'av1',offeredAtMs:1000,lastPacketAtMs:12900,
    nowMs:13000,rendered:false,connected:true}
  assert.equal(check(good),true)
  assert.equal(check({...good,codec:''}),false)
  assert.equal(check({...good,rendered:true}),false)
  assert.equal(check({...good,connected:false}),false)
  assert.equal(check({...good,lastPacketAtMs:0}),false)
  assert.equal(check({...good,lastPacketAtMs:3000}),false)
  assert.equal(check({...good,nowMs:7000,lastPacketAtMs:6900}),false)
})

test('reconnect timeout cannot quarantine a codec without the real RTP decode failure predicate',()=>{
  const match=source.match(/if\s*\(reason\s*===?\s*'media-negotiation-timeout'[\s\S]{0,450}/)
  assert.ok(match,'codec failure report guard must exist')
  assert.match(match[0],/shouldTriggerCodecDecoderFallback/)
  assert.match(source,/lastPacketAtMs:\s*lastMediaPacketAtMs/)
})
