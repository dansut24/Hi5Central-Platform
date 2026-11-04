import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RmmChromiumSignalBridge } from '../src/rmmChromiumSignalBridge.js'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent = []
  closeCode = null
  send(s) { this.sent.push(JSON.parse(s)) }
  receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  close(code) { this.readyState = 3; this.closeCode = code; this.emit('close') }
}
const now = { value: 1_000_000 }
const broker = () => new RmmChromiumSignalBridge({ now: () => now.value })
const identity = (role, suffix = '', overrides = {}) => ({
  tenantId: 'tenant-1', sessionId: 'rmm-session-1', deviceId: '123456789',
  subjectId: role === 'host' ? 'agent-1' : 'technician-1',
  clientId: role === 'client' ? 'webclient_abc' + suffix : '',
  role, expiresAt: now.value + 120000, ...overrides,
})
function attachAuthorised(bridge, role, suffix = '', overrides = {}) {
  const auth = identity(role, suffix, overrides)
  const token = bridge.issueTicket(auth)
  const sock = new FakeSocket()
  bridge.attach(sock)
  sock.receive({ type: 'auth', signal_token: token, role,
    device_id: auth.deviceId, ...(role === 'client' ? { client_id: auth.clientId } : {}) })
  return { sock, auth, token }
}
const iq = '<iq type="set"><jingle xmlns="urn:xmpp:jingle:1" action="session-initiate"/></iq>'

test('QuickDesk native host and WebClient Jingle roundtrip is tenant/session bound', () => {
  const b = broker()
  const { sock: host } = attachAuthorised(b, 'host')
  const { sock: client } = attachAuthorised(b, 'client')
  assert.deepEqual(host.sent.shift(), { type: 'auth_ok' })
  assert.deepEqual(client.sent.shift(), { type: 'auth_ok' })
  client.receive({ client_id: 'webclient_abc', payload: iq })
  assert.deepEqual(host.sent.pop(), { client_id: 'webclient_abc', payload: iq })
  host.receive({ client_id: 'webclient_abc', payload: iq })
  assert.deepEqual(client.sent.pop(), { client_id: 'webclient_abc', payload: iq })
  assert.deepEqual(b.metrics(), { pendingTickets: 0, activeSessions: 1 })
  b.revokeSession('tenant-1', 'rmm-session-1')
  assert.equal(host.closeCode, 4403)
  assert.equal(client.closeCode, 4403)
  assert.deepEqual(b.metrics(), { pendingTickets: 0, activeSessions: 0 })
})

test('Chromium first-frame tickets are one-use and bound to role and alias', () => {
  const b = broker(), auth = identity('client'), token = b.issueTicket(auth)
  const bad = new FakeSocket()
  b.attach(bad)
  bad.receive({ type: 'auth', signal_token: token, role: 'client',
    device_id: 'wrong-device', client_id: auth.clientId })
  assert.equal(bad.closeCode, 4401)
  const replay = new FakeSocket()
  b.attach(replay)
  replay.receive({ type: 'auth', signal_token: token, role: 'client',
    device_id: auth.deviceId, client_id: auth.clientId })
  assert.equal(replay.closeCode, 4401)
  const hostTicket = b.issueTicket(identity('host'))
  const spoof = new FakeSocket()
  b.attach(spoof)
  spoof.receive({ type: 'auth', signal_token: hostTicket, role: 'client',
    device_id: auth.deviceId, client_id: auth.clientId })
  assert.equal(spoof.closeCode, 4401)
})

test('cross-client, cross-session and cross-tenant signaling cannot route', () => {
  const b = broker()
  const host = attachAuthorised(b, 'host').sock
  const a = attachAuthorised(b, 'client', '1').sock
  const c = attachAuthorised(b, 'client', '2').sock
  const other = attachAuthorised(b, 'client', '9',
    { tenantId: 'tenant-2', sessionId: 'rmm-session-2' }).sock
  const prior = host.sent.length
  a.receive({ client_id: 'webclient_abc2', payload: iq })
  assert.equal(a.closeCode, 4403)
  assert.equal(host.sent.length, prior)
  const previousClientMessages = c.sent.length
  host.receive({ client_id: 'webclient_abc9', payload: iq })
  assert.equal(c.sent.length, previousClientMessages)
  assert.equal(other.sent.at(-1).type, 'auth_ok')
  c.receive({ client_id: 'webclient_abc2', payload: iq })
  assert.equal(host.sent.at(-1).client_id, 'webclient_abc2')
  b.revokeSession('tenant-2', 'rmm-session-2')
  assert.equal(host.readyState, 1)
  assert.equal(c.readyState, 1)
})

test('host absence is explicit; host reconnect does not grant cross-session access', () => {
  const b = broker()
  const c = attachAuthorised(b, 'client').sock
  c.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(c.sent.at(-1).code, 'HOST_OFFLINE')
  const h = attachAuthorised(b, 'host').sock
  c.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(h.sent.at(-1).payload, iq)
  h.close(1000)
  assert.equal(c.sent.at(-1).code, 'HOST_OFFLINE')
  const replacement = attachAuthorised(b, 'host').sock
  c.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(replacement.sent.at(-1).payload, iq)
})

test('reject malformed XML, DTD, overly large JSON, duplicate peers and replay auth', () => {
  const b = broker()
  const h = attachAuthorised(b, 'host').sock
  const d = new FakeSocket()
  b.attach(d)
  d.receive({ type: 'auth', signal_token: b.issueTicket(identity('host')),
    role: 'host', device_id: '123456789' })
  assert.equal(d.closeCode, 4409)
  const c = attachAuthorised(b, 'client').sock
  c.receive({ client_id: 'webclient_abc', payload: '<!DOCTYPE foo><iq/>' })
  assert.equal(c.closeCode, 4400)
  const giant = attachAuthorised(b, 'client', 'huge').sock
  giant.receive({ client_id: 'webclient_abchuge', payload: '<iq>' + 'x'.repeat(140000) + '</iq>' })
  assert.equal(giant.closeCode, 4400)
  h.receive({ type: 'auth', signal_token: 'reuse', role: 'host', device_id: '123456789' })
  assert.equal(h.closeCode, 4400)
})

test('tickets expire and cannot be used after H5C revokes remote session', () => {
  const b = broker()
  const token = b.issueTicket(identity('client'))
  now.value += 31000
  const expired = new FakeSocket()
  b.attach(expired)
  expired.receive({ type: 'auth', signal_token: token, role: 'client',
    device_id: '123456789', client_id: 'webclient_abc' })
  assert.equal(expired.closeCode, 4401)
  const next = b.issueTicket(identity('client'))
  b.revokeSession('tenant-1', 'rmm-session-1')
  const revoked = new FakeSocket()
  b.attach(revoked)
  revoked.receive({ type: 'auth', signal_token: next, role: 'client',
    device_id: '123456789', client_id: 'webclient_abc' })
  assert.equal(revoked.closeCode, 4401)
  now.value = 1_000_000
})

test('server issues no QuickDesk tickets without exact H5C grant identity', () => {
  const b = broker()
  assert.throws(() => b.issueTicket(identity('client', '', { subjectId: '' })))
  assert.throws(() => b.issueTicket(identity('host', '', { role: 'administrator' })))
  assert.throws(() => b.issueTicket(identity('client', '', { expiresAt: 1 })))
  assert.throws(() => b.issueTicket(identity('client', '', { clientId: '../bad' })))
})

test('rate limiting is bounded per socket', () => {
  const b = broker(), c = attachAuthorised(b, 'client').sock
  for (let i = 0; i < 110 && c.readyState === 1; i++) {
    c.receive({ client_id: 'webclient_abc', payload: iq })
  }
  assert.equal(c.closeCode, 4429)
})


test('in-flight connections expire with their Hi5Central session', () => {
  const b = broker()
  const host = attachAuthorised(b, 'host').sock
  const client = attachAuthorised(b, 'client').sock
  now.value += 120001
  client.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(client.closeCode, 4403)
  host.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(host.closeCode, 4403)
  now.value = 1_000_000
})

test('tenant/session keying resists separator collisions', () => {
  const b = broker()
  const host = attachAuthorised(b, 'host', '', {
    tenantId: 'tenant:a', sessionId: 'b',
  }).sock
  const client = attachAuthorised(b, 'client', '', {
    tenantId: 'tenant', sessionId: 'a:b',
  }).sock
  client.receive({ client_id: 'webclient_abc', payload: iq })
  assert.equal(client.sent.at(-1).code, 'HOST_OFFLINE')
  assert.equal(host.sent.length, 1)
})
