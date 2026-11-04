// Temporary Chromium-native host adapter for Hi5Central RMM.
// This module is a test harness, NOT the production Agent replacement.
// It receives the unmodified Chromium host's old /signal/{alias}?access_code=
// socket ONLY on 127.0.0.1 and bridges it to H5C's one-use ticket/Jingle
// signaling. Neither access_code nor the SPAKE2 secret travels to H5C in
// the proxy WebSocket URL. No second account or registration directory.
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const ID = /^[a-zA-Z0-9_.:-]{1,128}$/
const MAX = 128 * 1024
const validXml = (s) => typeof s === 'string' &&
  Buffer.byteLength(s,'utf8') <= MAX &&
  /^\s*<iq(?:\s|>)/i.test(s) &&
  !/<!\s*(?:DOCTYPE|ENTITY)/i.test(s)
const alive = (ws) => ws?.readyState === WebSocket.OPEN
const equal = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left=Buffer.from(a),right=Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left,right)
}
const clientFrom = (xml) => {
  const m=xml.match(/\bto\s*=\s*["']([^"']+)["']/i)
  if (!m) return ''
  const resource=m[1].match(/\/chromoting_ftl_(webclient_[A-Za-z0-9_-]{1,60})$/)
  return resource?.[1] || ''
}

export function startChromiumLoopbackHostBridge({
  alias, accessCode, hostTicket, serverUrl,
  port = 0, expiresAt, onEvent = () => {},
} = {}) {
  if (!ID.test(alias || '') || typeof accessCode !== 'string' ||
      accessCode.length < 20 || typeof hostTicket !== 'string' ||
      hostTicket.length < 32 || typeof serverUrl !== 'string' ||
      !/^wss:\/\//i.test(serverUrl) || !Number.isFinite(expiresAt) ||
      expiresAt < Date.now()+1000 || expiresAt > Date.now()+8*3600_000 ||
      !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid ephemeral Hi5Central Chromium grant')
  }
  // No inbound WAN connections. Hosts connect using ws://127.0.0.1:port,
  // then the adapter makes an outbound TLS/WSS connection to the H5C API.
  const server=http.createServer((_req,res)=>{res.writeHead(404);res.end()})
  const wss=new WebSocketServer({ noServer:true, maxPayload: MAX+4096,
    perMessageDeflate:false })
  let local=null, remote=null, currentClient='', remoteAuthorised=false
  let stopped=false
  const events=[]
  const event=(name)=>{events.push(name);onEvent(name)}
  const closePeers=(reason)=>{
    if (alive(local)) local.close(1000,reason)
    if (alive(remote)) remote.close(1000,reason)
  }
  const kill=()=>new Promise((resolve)=>{
    if(stopped){resolve();return}
    stopped=true
    closePeers('session ended')
    local?.terminate()
    remote?.terminate()
    wss.close(()=>server.close(()=>resolve()))
    // If no listener was ever created, server.close may invoke callback
    // with an ERR_SERVER_NOT_RUNNING; the caller still owns timer cleanup.
  })
  const expireTimer=setTimeout(()=>{
    event('grant_expired')
    void kill()
  },Math.max(1,expiresAt-Date.now()))
  expireTimer.unref?.()
  server.on('upgrade',(req,socket,head)=>{
    if(stopped || local || req.socket.remoteAddress !== '127.0.0.1'){
      socket.destroy();return
    }
    let url
    try {url=new URL(req.url||'','http://127.0.0.1')}
    catch {socket.destroy();return}
    // Do not include the URL or accessCode in any log, even on failures.
    if(url.pathname !== '/signal/'+alias ||
       !equal(url.searchParams.get('access_code'),accessCode) ||
       [...url.searchParams.keys()].some(x=>x!=='access_code')){
      socket.destroy();return
    }
    wss.handleUpgrade(req,socket,head,(ws)=>wss.emit('connection',ws))
  })
  wss.on('connection',(ws)=>{
    local=ws
    event('native_host_local_connected')
    remote=new WebSocket(serverUrl,{
      perMessageDeflate:false,handshakeTimeout:8000,
      maxPayload:MAX+4096,
    })
    const timeout=setTimeout(()=>{if(!remoteAuthorised)void kill()},11000)
    timeout.unref?.()
    remote.on('open',()=>{
      if(!stopped)remote.send(JSON.stringify({type:'auth',
        signal_token:hostTicket,role:'host',device_id:alias}))
    })
    remote.on('message',(wire,isBinary)=>{
      if(isBinary){event('remote_nontext_dropped');return}
      let obj
      try{obj=JSON.parse(String(wire))}catch{return}
      if(!remoteAuthorised){
        if(obj?.type==='auth_ok'){
          remoteAuthorised=true
          clearTimeout(timeout)
          event('h5c_host_authenticated')
        }else{event('h5c_auth_failed');void kill()}
        return
      }
      if(obj?.type==='error'){event('h5c_signal_error');return}
      if(!ID.test(obj?.client_id||'') || !validXml(obj?.payload))return
      // A single Hi5Central Viewer owns one RMM session. Retain the
      // client ID for matching native host XML replies without trusting
      // untrusted XML to change ownership after the first frame.
      if(currentClient && currentClient !== obj.client_id) return
      currentClient=obj.client_id
      if(alive(local))local.send(obj.payload)
    })
    remote.on('close',()=>{event('h5c_signal_closed');void kill()})
    remote.on('error',()=>{event('h5c_signal_error');void kill()})
    ws.on('message',(raw,isBinary)=>{
      if(isBinary || !remoteAuthorised || !alive(remote))return
      const xml=String(raw)
      if(!validXml(xml) || !currentClient)return
      const target=clientFrom(xml)
      if(target && target!==currentClient)return
      remote.send(JSON.stringify({client_id:currentClient,payload:xml}))
    })
    ws.on('close',()=>{event('native_host_disconnected');void kill()})
    ws.on('error',()=>{event('native_host_error');void kill()})
  })
  server.listen(port,'127.0.0.1')
  const ready=new Promise((resolve,reject)=>{
    if(server.listening)resolve(server.address())
    else{
      server.once('listening',()=>resolve(server.address()))
      server.once('error',reject)
    }
  })
  return {ready,close:async()=>{clearTimeout(expireTimer);await kill()},
    events,localAddress:async()=>{
      const address=await ready
      return 'ws://127.0.0.1:'+address.port
    }}
}
