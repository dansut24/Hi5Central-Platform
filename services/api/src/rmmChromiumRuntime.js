// Opt-in integration of the existing authenticated Hi5Central Agent/Viewer
// broker with Chromium's first-frame/Jingle signaling protocol.
// This module neither starts a host nor creates a new remote-access identity.
// Feature gate defaults to off; deploy requires an Agent with an explicit
// Chromium capability response and a matching native-host ready acknowledgement.
import { WebSocketServer } from 'ws'
import { RmmChromiumSignalBridge } from './rmmChromiumSignalBridge.js'
import { RmmChromiumSessionGrants } from './rmmChromiumSessionGrants.js'

export function createRmmChromiumRuntime({
  pool, agentSocketForDevice, sendAgentMessage, subscribeAgentMessages,
  enabled = false, now = () => Date.now(),
} = {}) {
  if (!pool?.query || typeof agentSocketForDevice !== 'function' ||
      typeof sendAgentMessage !== 'function' ||
      typeof subscribeAgentMessages !== 'function') {
    throw new TypeError('Existing authenticated RMM broker required')
  }
  const active = enabled === true
  const bridge = new RmmChromiumSignalBridge({ now })

  const probeAgent = ({ agentDeviceId, sessionId, nonce, socket }) =>
    new Promise((resolve) => {
      let done = false
      let unsubscribe = () => {}
      let timer = null
      const finish = (value = null) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        resolve(value)
      }
      // Subscribe before sending to avoid missing an immediate reply.
      unsubscribe = subscribeAgentMessages(agentDeviceId, (p) => {
        if (p?.type !== 'chromium_capabilities_response' ||
            p?.request_id !== nonce || p?.session_id !== sessionId ||
            agentSocketForDevice(agentDeviceId) !== socket) return
        finish({ nonce: p.request_id, session_id: p.session_id,
          agent_device_id: agentDeviceId,
          capable: p.capable === true,
          protocol_version: p.protocol_version,
          host_sha256: p.host_sha256 })
      })
      timer = setTimeout(() => finish(null), 3000)
      timer.unref?.()
      if (!socket || socket.readyState !== 1 ||
          agentSocketForDevice(agentDeviceId) !== socket ||
          !sendAgentMessage(agentDeviceId, {
            type: 'chromium_capabilities_request',
            session_id: sessionId, request_id: nonce,
            protocol_version: 3,
          })) {
        finish(null)
      }
    })

  const grants = new RmmChromiumSessionGrants({
    pool, bridge, agentSocket: agentSocketForDevice, probeAgent,
    sendAgent: sendAgentMessage, now, enabled: active,
  })

  // Register this listener for the *authenticated* Agent device.
  // The subscriber is scoped to that particular Agent's broker channel.
  const watchHostReady = (agentDeviceId, sessionId) => {
    if (!active) return () => {}
    return subscribeAgentMessages(agentDeviceId, (p) => {
      if (p?.type !== 'chromium_host_ready' ||
          p?.session_id !== sessionId) return
      grants.agentHostReady({
        deviceId: agentDeviceId, sessionId, requestId: p.request_id,
        authenticatedSocket: agentSocketForDevice(agentDeviceId),
        protocolVersion: p.protocol_version,
        ready: p.ready === true,
      })
    })
  }

  // Browser and Windows host both connect to this server with *one-use*
  // tickets issued ONLY by grants after authenticating H5C sessions.
  // No token or SPAKE2 secret is accepted from the URL query string.
  const attachSignaling = (server) => {
    if (!active) return null
    const wss = new WebSocketServer({ noServer: true, maxPayload: 132 * 1024 })
    server.on('upgrade', (request, socket, head) => {
      let parsed
      try { parsed = new URL(request.url || '/', 'http://localhost') }
      catch { return }
      if (parsed.pathname !== '/v1/realtime/signal') return
      if (parsed.search || parsed.hash) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws))
    })
    wss.on('connection', (ws) => bridge.attach(ws))
    return wss
  }

  return { enabled: active, grants, bridge, probeAgent, watchHostReady,
    attachSignaling,
    revoke: (tenantId, sessionId, deviceId) =>
      grants.revoke({ tenantId, sessionId, deviceId }),
  }
}
