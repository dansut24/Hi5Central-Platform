import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(here, '../src/rmmRemote.js'), 'utf8')
const start = source.indexOf('async function supersedePriorTechnicianRemoteSessions(')
const end = source.indexOf('\nexport function registerRmmRemoteRoutes(app) {', start)
assert.ok(start >= 0 && end > start, 'Supersession implementation exists')
const implementation = source.slice(start, end)

function harness({ active = [], ended = [], live = new Map() } = {}) {
  const messages = []
  const dbUpdates = []
  const queries = []
  const agent = { readyState: 1 }
  const ctx = {
    pool: {
      async query(sql, args) {
        queries.push({ sql, args })
        if (sql.includes('SELECT id')) return { rows: sql.includes('BETWEEN now()') ? ended : active }
        dbUpdates.push({ sql, args })
        return { rowCount: 1 }
      },
    },
    activeViewerSessions: live,
    safeSend(socket, payload) { messages.push({ socket, payload }); return true },
    Promise, Set, String,
  }
  vm.createContext(ctx)
  vm.runInContext(implementation, ctx)
  const run = () => ctx.supersedePriorTechnicianRemoteSessions({
    tenantId: 'tenant-one', agentDeviceId: 'device-one',
    userId: 'tech-one', mode: 'console', liveAgentWs: agent,
  })
  return { run, queries, messages, dbUpdates, agent, live }
}

test('recently ended session still sends scoped Agent cleanup', async () => {
  const h = harness({ ended: [{ id: 'ended-but-still-streaming' }] })
  await h.run()
  assert.deepEqual(h.messages.map(x => x.payload.type), ['end_session'])
  assert.equal(h.messages[0].payload.session_id, 'ended-but-still-streaming')
  assert.equal(h.messages[0].payload.reason, 'stale_agent_session_reclaim')
  assert.equal(h.messages[0].socket, h.agent)
  assert.equal(h.dbUpdates.length, 0)
  assert.equal(h.queries[0].args[1], 'device-one')
  assert.equal(h.queries[1].args[2], 'tech-one')
  assert.ok(h.queries[1].sql.includes("mode=$4"))
  assert.ok(h.queries[1].sql.includes('LIMIT 2'))
})

test('active session is stopped and marked ended before new session creation', async () => {
  const h = harness({ active: [{ id: 'prior-active' }] })
  await h.run()
  assert.equal(h.messages.length, 1)
  assert.equal(h.messages[0].payload.type, 'end_session')
  assert.equal(h.messages[0].payload.session_id, 'prior-active')
  assert.equal(h.dbUpdates.length, 1)
  assert.equal(h.dbUpdates[0].args[0], 'prior-active')
})

test('in-memory live session is finalized once and awaited before takeover', async () => {
  let release
  const block = new Promise((resolve) => { release = resolve })
  let finalizeCalls = 0
  const live = new Map([['live-old', {
    viewerWs: { close() {} },
    async finalize() { ++finalizeCalls; await block },
  }]])
  const h = harness({ active: [{ id: 'live-old' }], ended: [{ id: 'live-old' }], live })
  let done = false
  const work = h.run().then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finalizeCalls, 1)
  assert.equal(done, false, 'Must wait for prior session close to finish')
  assert.equal(h.messages[0].payload.type, 'session_terminated')
  release()
  await work
  assert.equal(done, true)
  assert.equal(h.dbUpdates.length, 0)
})

test('delayed frames from a finalized old Viewer are guarded before forwarding', () => {
  assert.ok(source.includes('if (active.finalized || activeViewerSessions.get(sessionId) !== active ||'))
  assert.ok(source.includes('active.viewerWs !== viewerWs) return'))
})
