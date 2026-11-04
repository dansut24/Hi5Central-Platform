// Hi5Central-branded Chromium Viewer integration seam. The normal Hi5Central
// Viewer stays responsible for MFA, tenant permissions, session creation and
// connecting to /viewer/ws. This module receives a grant ONLY from that already
// authenticated socket; it never reads secrets from URLs or browser storage.
//
// Requires a pinned, locally-hosted Chromium WebClient Session module with
// third_party/quickdesk/patches/0001-h5c-bound-browser-client-id.patch.
// Never load the unmodified QuickDesk remote.html or its external CDN importmap.
const CLIENT_RE=/^webclient_[a-f0-9]{24}$/
const ALIAS_RE=/^[1-9][0-9]{8}$/
const SIGNAL_RE=/^[a-f0-9]{64}$/
const CODE_RE=/^[A-Za-z0-9_-]{24,96}$/
const CODECS=new Set(['vp8','vp9','av1','h264','h265',''])
const isWssBase=(url)=>{
  try {
    const parsed=new URL(url)
    return parsed.protocol==='wss:' &&
      parsed.username==='' && parsed.password==='' &&
      parsed.search==='' && parsed.hash==='' &&
      (parsed.pathname==='/' || parsed.pathname==='') &&
      parsed.hostname!==''
  } catch { return false }
}
const validGrant=(grant,now)=>{
  if(!grant || grant.type!=='chromium_access_result' ||
      grant.engine!=='chromium' || grant.state!=='host_ready' ||
      !CLIENT_RE.test(grant.client_id||'') ||
      !ALIAS_RE.test(grant.device_alias||'') ||
      !SIGNAL_RE.test(grant.signal_token||'') ||
      !CODE_RE.test(grant.spake2_secret||'')) return false
  const expiry=Date.parse(grant.expires_at||'')
  return Number.isFinite(expiry) && expiry>now+1000 && expiry<now+8*3600_000
}

export class Hi5ChromiumViewerAdapter {
  #Session
  #now
  #active=null
  constructor({ Session, now=()=>Date.now() }={}) {
    if(typeof Session!=='function')throw new TypeError('Pinned Chromium Session required')
    this.#Session=Session
    this.#now=now
  }

  async connect({grant,signalingBaseUrl,iceServers=[],preferredVideoCodec='',
    onTrack=()=>{},onStateChange=()=>{} }={}) {
    if(this.#active)throw new Error('Chromium session already attached')
    if(!validGrant(grant,this.#now()))throw new Error('Invalid or expired Hi5Central Chromium handoff')
    if(!isWssBase(signalingBaseUrl))throw new Error('Signaling must use the Hi5Central WSS origin root')
    if(!Array.isArray(iceServers) || !CODECS.has(preferredVideoCodec)) {
      throw new Error('Invalid Hi5Central WebRTC configuration')
    }
    // Upstream WebSocketTransport appends /v1/realtime/signal to this base.
    // Passing a path would create /v1/realtime/signal/v1/realtime/signal.
    const session=new this.#Session({
      signalingUrl:signalingBaseUrl,
      iceServers,
      preferredVideoCodec,
      clientId:grant.client_id,
    })
    // Fail closed if the browser session implementation ignores H5C's
    // authorised client ID; otherwise the native host would reject SPAKE2.
    if(session.h5cAuthorizedClientId!==grant.client_id) {
      session.disconnect?.()
      throw new Error('Chromium Session must honour Hi5Central client identity')
    }
    session.addEventListener?.('track',(event)=>onTrack(event?.detail))
    session.addEventListener?.('stateChange',(event)=>onStateChange(event?.detail))
    this.#active=session
    try {
      await session.connect(grant.device_alias,grant.spake2_secret,grant.signal_token)
      if(this.#active!==session)throw new Error('Chromium session closed during setup')
      // An SDP offer is not a connected remote stream. The first decoded
      // and *presented* native frame must be confirmed by VideoTrial before
      // this engine is ever shown as working or allowed to replace VP8/HEVC.
      return {engine:'chromium',state:'negotiating',connected:false}
    } catch(e) {
      try{session.disconnect?.()}catch{}
      if(this.#active===session)this.#active=null
      throw e
    }
  }

  disconnect(){
    const session=this.#active
    this.#active=null
    try{session?.disconnect?.()}catch{}
  }

  // Frame-level diagnostics can sample Chromium's actual RTCPeerConnection,
  // but not its SPAKE2 or signaling credentials.
  get peerConnection(){return this.#active?.pc||null}

  get active(){return Boolean(this.#active)}
}
