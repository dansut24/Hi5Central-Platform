import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RmmChromiumSignalBridge } from '../src/rmmChromiumSignalBridge.js'
import { RmmChromiumSessionGrants } from '../src/rmmChromiumSessionGrants.js'

const ID = 'b74c7e77-eb34-41c3-8854-0f96cfbca2b0'
const SESSION = '67fb6d11-99c3-418f-9abd-11d5e86dd604'
const TENANT = '8434c6bc-5909-4393-b63a-03067a9eed77'
const OWNER = '6a4dad36-a51a-422f-86bd-31ff8be6884c'
const TOKEN = 'h5v_' + 'R'.repeat(43)
const sha = (v) => createHash('sha256').update(v).digest('hex')
const hostSHA = '01de5e356163896a0df967f73011e5315b2b17530d550017ee9f16799e7b20bb'
const fake = (enabled = true) => {
  let now = Date.now()
  const row = { id: SESSION, tenant_id: TENANT, agent_device_id: ID,
    created_by_user_id: OWNER, status: 'created', mode: 'console',
    viewer_client: 'browser', expires_at: new Date(now + 12 * 60_000),
    ended_at: null }
  const ws = { readyState: 1 }
  let liveSocket = ws
  const sent = []
  const flags = { supported: true, changeDuringProbe: false, rejectDispatch: false,
    alterProof: null, delayProbe: null }
  const pool = { queries: [],
    async query(sql, vals) {
      this.queries.push([sql, vals])
      return { rows: (
        vals[0] === SESSION && vals[1] === ID && vals[2] === sha(TOKEN) &&
        ['created', 'viewer_connected', 'active'].includes(row.status) &&
        !row.ended_at && Number(new Date(row.expires_at)) > now
      ) ? [{ ...row }] : [] }
    },
  }
  const bridge = new RmmChromiumSignalBridge({ now: () => now })
  const controller = new RmmChromiumSessionGrants({ pool, bridge,
    enabled, now: () => now,
    agentSocket: () => liveSocket,
    async probeAgent({ agentDeviceId, sessionId, nonce, socket }) {
      if (flags.delayProbe) await flags.delayProbe
      if (flags.changeDuringProbe) row.status = 'ended'
      if (!flags.supported) return null
      const proof = { agent_device_id: agentDeviceId, session_id: sessionId,
        nonce, protocol_version: 3, capable: true, host_sha256: hostSHA }
      return { ...proof, ...flags.alterProof }
    },
    sendAgent: (_id, message) => {
      if (flags.rejectDispatch) return false
      sent.push(message)
      return true
    },
  })
  return { row, pool, bridge, controller, sent, flags, ws, updateSocket: (s) => {liveSocket = s},
    advance: (ms) => { now += ms } }
}
const begin = (f, overrides = {}) => f.controller.begin({
  sessionId: SESSION, deviceId: ID, viewerToken: TOKEN, ...overrides,
})
const access = (f, overrides = {}) => f.controller.viewerAccess({
  sessionId: SESSION, deviceId: ID, viewerToken: TOKEN, ...overrides,
})
const ack = (f, overrides = {}) => f.controller.agentHostReady({
  sessionId: SESSION, deviceId: ID, authenticatedSocket: f.ws,
  requestId: f.sent.at(-1)?.request_id, ready: true,
  protocolVersion: 3, ...overrides,
})
const deny = async (promise, code) => assert.rejects(promise, (e) => e.code === code)

test('disabled-by-default Chromium grant controller cannot start host', async () => {
  const f = fake(false)
  await deny(begin(f), 'chromium_engine_disabled')
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.controller.status(), {enabled: false, pendingSessions: 0})
})

test('Viewer token proof is required; no arbitrary tenant or cross-device lookup', async () => {
  const f = fake()
  await deny(begin(f, { viewerToken: 'bad' }), 'invalid_viewer_credentials')
  await deny(begin(f, { viewerToken: 'h5v_' + 'X'.repeat(43) }),
    'chromium_session_not_authorised')
  await deny(begin(f, { deviceId: TENANT }), 'chromium_session_not_authorised')
  await deny(begin(f, { sessionId: TENANT }), 'chromium_session_not_authorised')
  assert.equal(f.sent.length, 0)
  assert.equal(f.pool.queries.at(-1)[1][2], sha(TOKEN))
})

test('only a live enrolled browser console session is eligible', async () => {
  const f = fake()
  f.row.mode = 'backstage'
  await deny(begin(f), 'chromium_session_not_authorised')
  f.row.mode = 'console'
  f.row.viewer_client = 'native'
  await deny(begin(f), 'chromium_session_not_authorised')
  f.row.viewer_client = 'browser'
  f.row.status = 'ended'
  await deny(begin(f), 'chromium_session_not_authorised')
  f.row.status = 'created'
  f.row.expires_at = new Date(0)
  await deny(begin(f), 'chromium_session_not_authorised')
  assert.equal(f.sent.length, 0)
})

test('Agent offline and absent Chromium capability challenge both fail closed', async () => {
  const f = fake()
  f.updateSocket({readyState: 3})
  await deny(begin(f), 'chromium_agent_offline')
  f.updateSocket(f.ws)
  f.flags.supported = false
  await deny(begin(f), 'chromium_agent_not_qualified')
  assert.equal(f.sent.length, 0)
})

test('host digest, protocol, device and nonce are explicitly checked', async () => {
  for (const change of [
    { host_sha256: 'bad' }, { protocol_version: 2 },
    { nonce: 'wrong' }, { agent_device_id: TENANT },
    { session_id: TENANT }, { capable: false },
  ]) {
    const f = fake()
    f.flags.alterProof = change
    await deny(begin(f), 'chromium_agent_not_qualified')
    assert.equal(f.sent.length, 0)
  }
})

test('session is revalidated after slow Agent challenge', async () => {
  const f = fake()
  f.flags.changeDuringProbe = true
  await deny(begin(f), 'chromium_session_not_authorised')
  assert.equal(f.sent.length, 0)
})

test('Agent gets host secret, but Viewer gets no secret before native host ACK', async () => {
  const f = fake()
  const response = await begin(f)
  assert.deepEqual(response, { sessionId: SESSION, engine: 'chromium',
    state: 'awaiting_agent_host_ready' })
  assert.equal('spake2_secret' in response, false)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].type, 'chromium_start')
  assert.equal(f.sent[0].device_alias.length, 9)
  assert.match(f.sent[0].spake2_secret, /^[A-Za-z0-9_-]{30,}$/)
  assert.match(f.sent[0].signal_token, /^[a-f0-9]{64}$/)
  await deny(access(f), 'chromium_host_not_ready')
  assert.equal(ack(f, {requestId: 'bad'}), false)
  assert.equal(ack(f, {authenticatedSocket: {readyState:1}}), false)
  assert.equal(ack(f, {protocolVersion: 2}), false)
  assert.equal(ack(f, {ready: false}), false)
  assert.equal(ack(f), true)
  const client = await access(f)
  assert.equal(client.engine, 'chromium')
  assert.equal(client.state, 'host_ready')
  assert.equal(client.device_alias, f.sent[0].device_alias)
  assert.equal(client.spake2_secret, f.sent[0].spake2_secret)
  assert.notEqual(client.signal_token, f.sent[0].signal_token)
  assert.match(client.client_id, /^webclient_[a-f0-9]{24}$/)
  const next = await access(f)
  assert.notEqual(next.client_id, client.client_id)
  assert.notEqual(next.signal_token, client.signal_token)
  assert.equal(f.bridge.metrics().pendingTickets, 3)
})

test('wrong Viewer bearer is rejected even after host ready', async () => {
  const f = fake()
  await begin(f)
  assert.equal(ack(f), true)
  await deny(access(f, {viewerToken: 'h5v_' + 'Q'.repeat(43)}),
    'chromium_session_not_authorised')
  await deny(access(f, {deviceId: TENANT}), 'chromium_session_not_authorised')
  assert.equal(f.controller.status().pendingSessions, 1)
})

test('expiry or Agent socket takeover invalidates existing host proof', async () => {
  const f = fake()
  await begin(f)
  assert.equal(ack(f), true)
  f.updateSocket({readyState:1})
  await deny(access(f), 'chromium_host_not_ready')
  f.updateSocket(f.ws)
  f.advance(91_000)
  await deny(access(f), 'chromium_host_not_ready')
  assert.equal(ack(f), false)
})

test('Hi5Central revoke tears down client/host tickets and instructs the Agent', async () => {
  const f = fake()
  await begin(f)
  assert.equal(ack(f), true)
  await access(f)
  assert.equal(f.controller.revoke({tenantId: TENANT,sessionId: SESSION,deviceId: ID}), true)
  assert.equal(f.sent.at(-1).type, 'chromium_stop')
  assert.deepEqual(f.bridge.metrics(), {pendingTickets: 0, activeSessions: 0})
  await deny(access(f), 'chromium_host_not_ready')
  assert.equal(f.controller.revoke({tenantId: TENANT,sessionId: SESSION,deviceId: ID}), false)
})

test('failed Agent dispatch revokes both tickets and pending session', async () => {
  const f = fake()
  f.flags.rejectDispatch = true
  await deny(begin(f), 'chromium_agent_dispatch_failed')
  assert.equal(f.controller.status().pendingSessions, 0)
  assert.deepEqual(f.bridge.metrics(), {pendingTickets: 0, activeSessions: 0})
})

test('concurrent prepare requests cannot start two hosts for one H5C grant', async () => {
  const f = fake()
  let finish
  f.flags.delayProbe = new Promise((resolve) => {finish = resolve})
  const first = begin(f)
  await new Promise((resolve) => setImmediate(resolve))
  await deny(begin(f), 'chromium_prepare_in_progress')
  finish()
  await first
  await deny(begin(f), 'chromium_session_already_prepared')
  assert.equal(f.sent.length, 1)
})

test('never trust an Agent from a replaced websocket during capabilities probe', async () => {
  const f = fake()
  f.flags.delayProbe = new Promise((resolve) => setImmediate(() => {
    f.updateSocket({ readyState: 1 })
    resolve()
  }))
  await deny(begin(f), 'chromium_agent_not_qualified')
  assert.equal(f.sent.length, 0)
})
