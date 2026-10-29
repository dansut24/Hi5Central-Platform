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

test('browser sends only real decoding capabilities, not newer unimplemented codecs', () => {
  const result = query([
    {mimeType:'video/VP8'},
    {mimeType:'video/H264',sdpFmtpLine:'profile-level-id=42e01f'},
    {mimeType:'video/AV1'}
  ])
  assert.match(result, /codec_caps_v1=1/)
  assert.match(result, /video_codecs=vp8%2Ch264/)
  assert.match(result, /h264_level4=0/)
  assert.doesNotMatch(result, /av1/)
})

test('H264 level 4 only when an actual advertised receive profile supports it', () => {
  const result = query([{mimeType:'video/h264',sdpFmtpLine:'level-asymmetry-allowed=1;profile-level-id=42e028;packetization-mode=1'}])
  assert.match(result, /video_codecs=h264/)
  assert.match(result, /h264_level4=1/)
})

test('a codec-free browser does not assert support', () => {
  assert.equal(query([{mimeType:'video/rtx'}]), '')
})
