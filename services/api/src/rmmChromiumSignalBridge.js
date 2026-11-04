// Internal building block for a future Chromium/QuickDesk remote engine.
// NOT wired into production routes. The caller must first authenticate and
// authorise a tenant-scoped Hi5Central remote session (viewer or Agent).
// QuickDesk wire format: first-frame {type:"auth",signal_token,role,device_id,
// client_id?}, then {client_id,payload:"<iq ...>"} for Jingle/ICE.
// Never treat a QuickDesk device ID/access code as a Hi5Central permission.
import { randomBytes, createHash } from 'node:crypto'

const ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/
const TOKEN_TTL_MS = 30_000
const MAX_JINGLE_BYTES = 128 * 1024
const MAX_PER_SECOND = 100

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const finite = (n) => Number.isFinite(n) && n > 0
const open = (ws) => ws?.readyState === 1

const parseFrame = (raw, maxBytes) => {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))
  if (frame.byteLength === 0 || frame.byteLength > maxBytes) return null
  try {
    const obj = JSON.parse(frame.toString('utf8'))
    return obj && !Array.isArray(obj) && typeof obj === 'object' ? obj : null
  } catch { return null }
}

const validJingle = (s) => typeof s === 'string' &&
  Buffer.byteLength(s, 'utf8') <= MAX_JINGLE_BYTES &&
  /^\s*<iq(?:\s|>)/i.test(s) && !/<!\s*(?:DOCTYPE|ENTITY)/i.test(s)

export class RmmChromiumSignalBridge {
  #tickets = new Map()
  #sessions = new Map()
  #now
  #maxBytes

  constructor({ now = () => Date.now(), maxBytes = MAX_JINGLE_BYTES + 4096 } = {}) {
    this.#now = now
    this.#maxBytes = maxBytes
  }

  // Call ONLY after the existing H5C API has checked a viewer's session
  // token or an Agent's authenticated device socket.  The ticket is short
  // lived, single use and bound to the exact tenant, session, role and
  // QuickDesk host alias. Never issue a token for arbitrary input directly
  // from an unauthenticated HTTP/WebSocket request.
  issueTicket({ tenantId, sessionId, deviceId, subjectId, role, clientId = '',
    expiresAt, ttlMs = TOKEN_TTL_MS } = {}) {
    if (![tenantId, sessionId, deviceId, subjectId].every(
      (s) => typeof s === 'string' && ID_RE.test(s))) {
      throw new Error('unauthorised or invalid session identity')
    }
    if (role !== 'host' && role !== 'client') throw new Error('invalid role')
    if (role === 'client' && !ID_RE.test(clientId)) throw new Error('invalid client id')
    if (role === 'host' && clientId) throw new Error('host cannot claim a client id')
    if (!finite(expiresAt) || expiresAt <= this.#now()) throw new Error('expired H5C session')
    const timestamp = this.#now()
    // Bound memory even when issued tickets are never redeemed.
    for (const [digest, ticket] of this.#tickets) {
      if (ticket.expire <= timestamp) this.#tickets.delete(digest)
    }
    if (this.#tickets.size >= 1024) throw new Error('Chromium tickets exhausted')
    const expire = Math.min(expiresAt, timestamp + Math.max(1000, Math.min(ttlMs, TOKEN_TTL_MS)))
    const token = randomBytes(32).toString('hex')
    this.#tickets.set(sha256(token), { tenantId, sessionId, deviceId, subjectId,
      role, clientId, expire, sessionExpiresAt: expiresAt })
    return token
  }

  attach(ws) {
    if (!ws || typeof ws.on !== 'function' || typeof ws.send !== 'function' ||
        typeof ws.close !== 'function') throw new Error('WebSocket required')
    let principal = null
    let bucketAt = this.#now(), messagesInBucket = 0
    const timer = setTimeout(() => {
      if (!principal) ws.close(4401, 'Chromium authentication required')
    }, 6000)
    timer.unref?.()

    const detach = () => {
      clearTimeout(timer)
      if (!principal) return
      const key = JSON.stringify([principal.tenantId, principal.sessionId])
      const session = this.#sessions.get(key)
      if (!session) return
      if (principal.role === 'host' && session.host === ws) {
        session.host = null
        for (const client of session.clients.values()) {
          if (open(client)) client.send(JSON.stringify({ type: 'error', code: 'HOST_OFFLINE' }))
        }
      }
      if (principal.role === 'client' && session.clients.get(principal.clientId) === ws) {
        session.clients.delete(principal.clientId)
      }
      if (!session.host && !session.clients.size) this.#sessions.delete(key)
      principal = null
    }

    ws.on('message', (raw) => {
      if (!open(ws)) return
      const now = this.#now()
      if (now - bucketAt >= 1000) { bucketAt = now; messagesInBucket = 0 }
      if (++messagesInBucket > MAX_PER_SECOND) { ws.close(4429, 'Too many signal frames'); return }
      const frame = parseFrame(raw, this.#maxBytes)
      if (!frame) { ws.close(4400, 'Invalid signaling frame'); return }
      if (!principal) {
        if (frame.type !== 'auth' || typeof frame.signal_token !== 'string' ||
            !ID_RE.test(frame.device_id) ||
            !['client', 'host'].includes(frame.role) ||
            (frame.role === 'client' && !ID_RE.test(frame.client_id))) {
          ws.close(4401, 'Invalid Chromium auth frame')
          return
        }
        const digest = sha256(frame.signal_token)
        const ticket = this.#tickets.get(digest)
        this.#tickets.delete(digest) // consume before any comparison (no replay)
        if (!ticket || now >= ticket.expire || ticket.deviceId !== frame.device_id ||
            ticket.role !== frame.role ||
            (ticket.role === 'client' && ticket.clientId !== frame.client_id)) {
          ws.close(4401, 'Expired or mismatched Chromium signal ticket')
          return
        }
        const key = JSON.stringify([ticket.tenantId, ticket.sessionId])
        const session = this.#sessions.get(key) || { deviceId: ticket.deviceId,
          host: null, clients: new Map() }
        if (session.deviceId !== ticket.deviceId ||
            (ticket.role === 'host' && open(session.host)) ||
            (ticket.role === 'client' && open(session.clients.get(ticket.clientId)))) {
          ws.close(4409, 'Chromium session already connected or mismatched')
          return
        }
        this.#sessions.set(key, session)
        principal = ticket
        if (ticket.role === 'host') session.host = ws
        else session.clients.set(ticket.clientId, ws)
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'auth_ok' }))
        return
      }

      // A ticket's 30s lifetime only bounds *connection*. The full H5C RMM
      // session expiry still applies to every frame even if the WebSocket
      // remains open. Termination/takeover also invokes revokeSession().
      if (now >= principal.sessionExpiresAt) {
        ws.close(4403, 'Hi5Central remote session expired')
        return
      }

      // H5C authorises the tenant/session; the QuickDesk wire must NEVER
      // allow a peer to pick a different client, session or device by
      // embedding arbitrary metadata in its forwarded Jingle envelope.
      const key = JSON.stringify([principal.tenantId, principal.sessionId])
      const session = this.#sessions.get(key)
      if (!session || session.deviceId !== principal.deviceId ||
          frame.type === 'auth' || !ID_RE.test(frame.client_id) ||
          !validJingle(frame.payload)) {
        ws.close(4400, 'Unrecognised or unsafe Chromium signal')
        return
      }
      if (principal.role === 'client') {
        if (frame.client_id !== principal.clientId ||
            session.clients.get(principal.clientId) !== ws) {
          ws.close(4403, 'Cross-client signaling forbidden')
          return
        }
        if (!open(session.host)) {
          ws.send(JSON.stringify({ type: 'error', code: 'HOST_OFFLINE' }))
          return
        }
        session.host.send(JSON.stringify({ client_id: principal.clientId,
          payload: frame.payload }))
      } else {
        if (session.host !== ws) { ws.close(4403, 'Stale host signal'); return }
        const destination = session.clients.get(frame.client_id)
        if (open(destination)) destination.send(JSON.stringify({
          client_id: frame.client_id, payload: frame.payload }))
      }
    })
    ws.on('close', detach)
    ws.on('error', detach)
  }

  // Called on Hi5Central session termination/takeover. Revoke unused tickets
  // and both peer transports; no Chromium signaling may outlive its RMM grant.
  revokeSession(tenantId, sessionId) {
    const key = JSON.stringify([tenantId, sessionId])
    for (const [digest, ticket] of this.#tickets) {
      if (ticket.tenantId === tenantId && ticket.sessionId === sessionId)
        this.#tickets.delete(digest)
    }
    const s = this.#sessions.get(key)
    if (!s) return
    this.#sessions.delete(key)
    for (const ws of [s.host, ...s.clients.values()]) {
      if (open(ws)) ws.close(4403, 'Hi5Central session ended')
    }
  }

  // Omit credentials, host aliases and user identities from diagnostics.
  metrics() {
    return { pendingTickets: this.#tickets.size, activeSessions: this.#sessions.size }
  }
}
