import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(directory, '../src/rmmRemote.js'), 'utf8')
const start = source.indexOf('    const lastStreamHealthBySource = new Map()')
const end = source.indexOf('    const relayFromAgent = (buffer) => {', start)
assert.ok(start > 0 && end > start)

function harness() {
  let now = 10000
  const log = []
  const active = { finalized: false }
  const sessionId = 'test-session'
  const activeViewerSessions = new Map([[sessionId, active]])
  const context = {
    Date: { now: () => now },
    Map, Number, JSON, Math,
    clean: x => String(x ?? '').trim(),
    active, activeViewerSessions, sessionId,
    console: { info(tag, message) { log.push({ tag, data: JSON.parse(message) }) } },
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, end), context)
  return {
    report: (payload) => context.logAgentStreamHealth(payload),
    advance: (milliseconds) => { now += milliseconds },
    logs: log,
    setFinalized: () => { active.finalized = true },
  }
}
const diagnostic = (values = {}) => ({
  type: 'stream_diagnostics', source: 'normal', active_desktop: 'normal',
  target_fps: 30, frames_forwarded_total: 100,
  written_frames: 100, capture_attempts: 100, capture_resets: 0, ...values,
})

test('forwarded, captured and written fps can be separated', () => {
  const h = harness()
  h.report(diagnostic())
  h.advance(5000)
  h.report(diagnostic({ frames_forwarded_total: 200, written_frames: 175, capture_attempts: 250 }))
  assert.equal(h.logs.length, 2)
  assert.equal(h.logs[1].data.forwarded_fps, 20)
  assert.equal(h.logs[1].data.written_fps, 15)
  assert.equal(h.logs[1].data.capture_fps, 30)
})

test('logs are bounded to one per five seconds per source', () => {
  const h = harness()
  h.report(diagnostic())
  h.advance(1000)
  h.report(diagnostic({ frames_forwarded_total: 160 }))
  assert.equal(h.logs.length, 1)
  h.advance(4000)
  h.report(diagnostic({ frames_forwarded_total: 200 }))
  assert.equal(h.logs.length, 2)
})

test('ignores stale sessions and unrelated Agent messages', () => {
  const h = harness()
  h.report({ type: 'webrtc_offer', source: 'normal' })
  h.report(diagnostic({ source: 'bogus' }))
  assert.equal(h.logs.length, 0)
  h.setFinalized()
  h.report(diagnostic())
  assert.equal(h.logs.length, 0)
})
