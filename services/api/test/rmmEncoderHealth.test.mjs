import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(root, '../src/rmmRemote.js'), 'utf8')
const begin = source.indexOf('    const lastEncoderHealthAt = new Map()')
const end = source.indexOf('    const relayFromAgent = (buffer) => {', begin)
assert.ok(begin > 0 && end > begin)
function createHarness() {
  let clock = 10000
  const entries = []
  const sessionId = 'existing-session'
  const active = { finalized: false }
  const activeViewerSessions = new Map([[sessionId, active]])
  const context = {
    Date: { now: () => clock },
    Map, JSON, Number, Math,
    active, activeViewerSessions, sessionId,
    clean: x => String(x ?? '').trim(),
    console: { info(tag, line) { entries.push({ tag, payload: JSON.parse(line) }) } },
  }
  vm.createContext(context)
  vm.runInContext(source.slice(begin, end) + '\nthis.__log = logAgentEncoderHealth', context)
  return {
    log: payload => context.__log(payload),
    advance: ms => { clock += ms },
    finalize: () => { active.finalized = true },
    entries,
  }
}

test('logs bounded encoded and transport timing separately', () => {
  const h = createHarness()
  h.log({ type: 'stream_encoder_diagnostics', codec: 'VP9', encoded_frames: 29, sent_frames: 27,
    encode_avg_ms: 9.4, encode_max_ms: 28.5, send_avg_ms: 3.1, send_max_ms: 18.2,
    width: 1920, height: 1080, target_fps: 30, bitrate_kbps: 4500 })
  assert.equal(h.entries.length, 1)
  assert.equal(h.entries[0].tag, '[rmm.encoder.health]')
  assert.equal(h.entries[0].payload.codec, 'VP9')
  assert.equal(h.entries[0].payload.encode_avg_ms, 9.4)
  assert.equal(h.entries[0].payload.rtp_enqueue_max_ms, 18.2)
  assert.equal(h.entries[0].payload.width, 1920)
  h.advance(1000)
  h.log({ type: 'stream_encoder_diagnostics', codec: 'VP9', encoded_frames: 99 })
  assert.equal(h.entries.length, 1)
  h.advance(4000)
  h.log({ type: 'stream_encoder_diagnostics', codec: 'VP9', encoded_frames: 11 })
  assert.equal(h.entries.length, 2)
})

test('rejects stale and unknown diagnostics', () => {
  const h = createHarness()
  h.log({ type: 'stream_encoder_diagnostics', codec: 'FAKE' })
  h.log({ type: 'webrtc_offer', codec: 'VP9' })
  assert.equal(h.entries.length, 0)
  h.finalize()
  h.log({ type: 'stream_encoder_diagnostics', codec: 'H264' })
  assert.equal(h.entries.length, 0)
})

test('supports H264 and VP8 without collecting content', () => {
  const h = createHarness()
  h.log({ type: 'stream_encoder_diagnostics', codec: 'H264', sent_frames: 21, contents: 'private-desktop-pixels' })
  h.log({ type: 'stream_encoder_diagnostics', codec: 'VP8', sent_frames: 20, typed_password: 'secret' })
  assert.equal(h.entries.length, 2)
  assert.ok(!JSON.stringify(h.entries).includes('private-desktop-pixels'))
  assert.ok(!JSON.stringify(h.entries).includes('secret'))
})
