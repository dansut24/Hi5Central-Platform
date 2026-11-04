// Unexposed Chromium host handoff. A live H5C Viewer session token and an
// authenticated Agent capability challenge are required before host launch.
// No QuickDesk accounts, access-code directory, or public registration.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

const hash = (s) => createHash('sha256').update(s).digest('hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const active = new Set(['created', 'viewer_connected', 'active'])
const HOST_SHA = '01de5e356163896a0df967f73011e5315b2b17530d550017ee9f16799e7b20bb'
const validId = (s) => typeof s === 'string' && UUID.test(s)
const online = (ws) => ws?.readyState === 1

export class ChromiumGrantError extends Error {
  constructor(code, status = 403) {
    super(code)
    this.code = code
    this.status = status
  }
}
const fail = (code, status) => { throw new ChromiumGrantError(code, status) }

export class RmmChromiumSessionGrants {
  #pool
  #bridge
  #agentSocket
  #probeAgent
  #sendAgent
  #now
  #enabled
  #pending = new Map()
  #preparing = new Set()

  constructor({ pool, bridge, agentSocket, probeAgent, sendAgent,
    now = () => Date.now(), enabled = false } = {}) {
    if (!pool?.query || !bridge?.issueTicket || !bridge?.revokeSession ||
        typeof agentSocket !== 'function' || typeof probeAgent !== 'function' ||
        typeof sendAgent !== 'function') throw new TypeError('Authenticated RMM dependencies required')
    this.#pool = pool
    this.#bridge = bridge
    this.#agentSocket = agentSocket
    this.#probeAgent = probeAgent
    this.#sendAgent = sendAgent
    this.#now = now
    this.#enabled = enabled === true
  }

  async #checkViewer({ sessionId, deviceId, viewerToken }) {
    if (!validId(sessionId) || !validId(deviceId) ||
        typeof viewerToken !== 'string' || !/^h5v_[A-Za-z0-9_-]{30,256}$/.test(viewerToken)) {
      fail('invalid_viewer_credentials', 401)
    }
    // Viewer token in DB is a hash. Never accept a supplied tenant ID.
    // The current H5C remote session must own the device, be unexpired,
    // browser/console mode, and the Agent must still be enrolled.
    const sql = [
      'SELECT s.id,s.tenant_id,s.agent_device_id,s.created_by_user_id,',
      's.mode,s.viewer_client,s.status,s.expires_at,s.ended_at',
      'FROM rmm_remote_sessions s JOIN rmm_agent_devices a',
      'ON a.id=s.agent_device_id AND a.tenant_id=s.tenant_id',
      'WHERE s.id=$1 AND s.agent_device_id=$2 AND s.viewer_token_hash=$3',
      "AND s.status IN ('created','viewer_connected','active')",
      'AND s.expires_at>now() AND s.ended_at IS NULL',
      'AND a.disabled_at IS NULL LIMIT 1',
    ].join(' ')
    const result = await this.#pool.query(sql, [sessionId, deviceId, hash(viewerToken)])
    const s = result.rows?.[0]
    if (!s || !active.has(s.status) || s.mode !== 'console' ||
        s.viewer_client !== 'browser' || !validId(String(s.tenant_id)) ||
        !validId(String(s.created_by_user_id)) ||
        Number(new Date(s.expires_at)) <= this.#now()) {
      fail('chromium_session_not_authorised')
    }
    return s
  }

  async begin({ sessionId, deviceId, viewerToken } = {}) {
    if (!this.#enabled) fail('chromium_engine_disabled', 404)
    const key = JSON.stringify([sessionId, deviceId])
    if (this.#preparing.has(key)) fail('chromium_prepare_in_progress', 409)
    this.#preparing.add(key)
    try {
      if (this.#pending.has(key)) fail('chromium_session_already_prepared', 409)
      const s = await this.#checkViewer({ sessionId, deviceId, viewerToken })
      const socket = this.#agentSocket(deviceId)
      if (!online(socket)) fail('chromium_agent_offline', 409)

      // Proof must originate from the authenticated H5C Agent WebSocket,
      // match this nonce, and attest the pinned host binary. Agent 1.0.305
      // has no such handler and therefore fails closed.
      const challenge = randomUUID()
      const proof = await this.#probeAgent({ agentDeviceId: deviceId,
        sessionId, nonce: challenge, socket })
      if (!proof || proof.nonce !== challenge ||
          proof.session_id !== sessionId || proof.agent_device_id !== deviceId ||
          proof.capable !== true || proof.protocol_version !== 3 ||
          proof.host_sha256 !== HOST_SHA ||
          !online(socket) || this.#agentSocket(deviceId) !== socket) {
        fail('chromium_agent_not_qualified', 409)
      }

      // Revalidate after the asynchronous probe (session could have ended).
      const confirmed = await this.#checkViewer({ sessionId, deviceId, viewerToken })
      if (String(confirmed.tenant_id) !== String(s.tenant_id) ||
          String(confirmed.created_by_user_id) !== String(s.created_by_user_id)) {
        fail('chromium_session_changed_during_probe', 409)
      }
      const alias = String(randomInt(100_000_000, 1_000_000_000))
      const secret = randomBytes(24).toString('base64url')
      const nonce = randomUUID()
      const expiry = Math.min(Number(new Date(s.expires_at)), this.#now() + 90_000)
      if (expiry <= this.#now()) fail('chromium_session_expired')
      const tenantId = String(s.tenant_id)
      const hostToken = this.#bridge.issueTicket({ tenantId, sessionId,
        deviceId: alias, subjectId: deviceId, role: 'host', expiresAt: expiry })
      const record = { tenantId, owner: String(s.created_by_user_id),
        alias, secret, nonce, expiry, ready: false, deviceId, socket }
      this.#pending.set(key, record)
      const delivered = this.#sendAgent(deviceId, {
        type: 'chromium_start', session_id: sessionId, request_id: nonce,
        device_alias: alias, spake2_secret: secret, signal_token: hostToken,
        protocol_version: 3, session_expires_at: new Date(expiry).toISOString(),
      })
      if (!delivered) {
        this.revoke({ tenantId, sessionId, deviceId })
        fail('chromium_agent_dispatch_failed', 503)
      }
      // Deliberately exclude the SPAKE2 secret and client ticket until the
      // *authenticated Agent* acknowledges the actual native host is ready.
      return { sessionId, engine: 'chromium', state: 'awaiting_agent_host_ready' }
    } finally {
      this.#preparing.delete(key)
    }
  }

  // Invoke ONLY from the existing authenticated Agent message subscriber,
  // and pass the actual Agent WebSocket object (never a user-supplied claim).
  agentHostReady({ sessionId, deviceId, authenticatedSocket, requestId,
    protocolVersion, ready } = {}) {
    if (!this.#enabled) return false
    const r = this.#pending.get(JSON.stringify([sessionId, deviceId]))
    if (!r || this.#now() >= r.expiry || !online(r.socket) ||
        authenticatedSocket !== r.socket || this.#agentSocket(deviceId) !== r.socket ||
        requestId !== r.nonce || protocolVersion !== 3 || ready !== true) return false
    r.ready = true
    return true
  }

  async viewerAccess({ sessionId, deviceId, viewerToken } = {}) {
    if (!this.#enabled) fail('chromium_engine_disabled', 404)
    const s = await this.#checkViewer({ sessionId, deviceId, viewerToken })
    const r = this.#pending.get(JSON.stringify([sessionId, deviceId]))
    if (!r || !r.ready || this.#now() >= r.expiry ||
        !online(r.socket) || this.#agentSocket(deviceId) !== r.socket ||
        r.tenantId !== String(s.tenant_id) ||
        r.owner !== String(s.created_by_user_id)) fail('chromium_host_not_ready', 409)
    const clientId = 'webclient_' + randomBytes(12).toString('hex')
    const signalToken = this.#bridge.issueTicket({ tenantId: r.tenantId,
      sessionId, deviceId: r.alias, subjectId: r.owner, role: 'client',
      clientId, expiresAt: r.expiry })
    // Return ONLY over the existing authenticated H5C Viewer control socket.
    // Never put the SPAKE2 secret or signalToken into a URL, log or localStorage.
    return { engine: 'chromium', state: 'host_ready', device_alias: r.alias,
      client_id: clientId, signal_token: signalToken, spake2_secret: r.secret,
      expires_at: new Date(r.expiry).toISOString() }
  }

  revoke({ tenantId, sessionId, deviceId } = {}) {
    const key = JSON.stringify([sessionId, deviceId])
    const r = this.#pending.get(key)
    if (!r || r.tenantId !== tenantId) return false
    this.#pending.delete(key)
    this.#bridge.revokeSession(tenantId, sessionId)
    if (online(r.socket) && this.#agentSocket(deviceId) === r.socket) {
      this.#sendAgent(deviceId, { type: 'chromium_stop',
        session_id: sessionId, request_id: r.nonce,
        reason: 'hi5central_session_ended' })
    }
    return true
  }

  status() {
    return { enabled: this.#enabled, pendingSessions: this.#pending.size }
  }
}
