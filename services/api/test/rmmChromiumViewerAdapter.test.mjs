import test from 'node:test'
import assert from 'node:assert/strict'
import { Hi5ChromiumViewerAdapter } from '../../../apps/rmm/public/rmm-viewer/chromiumSessionAdapter.js'

const now=Date.UTC(2026,10,4,22,30)
const grant=()=>({
  type:'chromium_access_result',
  engine:'chromium',state:'host_ready',
  device_alias:'123456789',
  client_id:'webclient_'+'b'.repeat(24),
  signal_token:'a'.repeat(64),
  spake2_secret:'a_valid_H5C_secret_abcdefghijklmnopqrstuvwxyz',
  expires_at:new Date(now+60_000).toISOString(),
})
class FakeSession {
  static instances=[]
  constructor(options){
    this.options=options
    this.h5cAuthorizedClientId=options.clientId
    this.events=[]
    this.calls=[]
    FakeSession.instances.push(this)
  }
  addEventListener(name,listener){this.events.push({name,listener})}
  async connect(...args){this.calls.push(args)}
  disconnect(){this.disconnected=true}
}
const make=()=>new Hi5ChromiumViewerAdapter({Session:FakeSession,now:()=>now})
const connect=(adapter,g=grant())=>adapter.connect({
  grant:g,
  signalingBaseUrl:'wss://api.hi5central.com',
  iceServers:[{urls:'turn:turn.hi5central.com:3478'}],
  preferredVideoCodec:'vp9',
})

test('passes server-issued H5C identity, SPAKE2 secret and token into pinned browser Session',async()=>{
  const adapter=make()
  const credentials=grant()
  const response=await connect(adapter,credentials)
  assert.deepEqual(response,{engine:'chromium',connected:true})
  const s=FakeSession.instances.at(-1)
  assert.equal(s.options.clientId,credentials.client_id)
  assert.equal(s.options.signalingUrl,'wss://api.hi5central.com')
  assert.equal(s.options.preferredVideoCodec,'vp9')
  assert.equal(s.options.iceServers.length,1)
  assert.deepEqual(s.calls,[[credentials.device_alias,credentials.spake2_secret,credentials.signal_token]])
  assert.equal(adapter.active,true)
  adapter.disconnect()
  assert.equal(s.disconnected,true)
  assert.equal(adapter.active,false)
})

test('rejects generic QuickDesk handoff and mismatched browser identity',async()=>{
  const adapter=make()
  for(const change of [
    {type:'auth_ok'}, {engine:'quickdesk'}, {state:'waiting'},
    {client_id:'webclient_bad'}, {device_alias:'123'},
    {signal_token:'abc'}, {spake2_secret:'short'},
    {expires_at:new Date(now-1).toISOString()},
  ]){
    await assert.rejects(connect(adapter,{...grant(),...change}),/Invalid or expired/)
  }
  class UnpatchedSession extends FakeSession{
    constructor(options){super(options);this.h5cAuthorizedClientId=undefined}
  }
  const unpatched=new Hi5ChromiumViewerAdapter({Session:UnpatchedSession,now:()=>now})
  await assert.rejects(connect(unpatched),/must honour/)
  assert.equal(UnpatchedSession.instances.at(-1).disconnected,true)
})

test('refuses URL query credentials and duplicated WebSocket signaling path',async()=>{
  const adapter=make()
  for(const url of [
    'ws://api.hi5central.com','wss://api.hi5central.com/v1/realtime/signal',
    'wss://api.hi5central.com/?st=token','wss://user:pass@api.hi5central.com',
    'https://api.hi5central.com','wss://api.hi5central.com/#ticket',
  ]){
    await assert.rejects(adapter.connect({grant:grant(),signalingBaseUrl:url}),/Signaling must/)
  }
})

test('failed SPAKE2/RTC setup disconnects the new Chromium session and preserves legacy Viewer',async()=>{
  class FailingSession extends FakeSession {
    async connect(){throw new Error('peer ICE failed')}
  }
  const adapter=new Hi5ChromiumViewerAdapter({Session:FailingSession,now:()=>now})
  await assert.rejects(connect(adapter),/peer ICE failed/)
  assert.equal(adapter.active,false)
  assert.equal(FailingSession.instances.at(-1).disconnected,true)
})

test('prevents concurrent Chromium session creation',async()=>{
  const adapter=make()
  await connect(adapter)
  await assert.rejects(connect(adapter),/already attached/)
  adapter.disconnect()
})
