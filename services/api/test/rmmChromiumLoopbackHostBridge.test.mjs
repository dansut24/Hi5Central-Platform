import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { RmmChromiumSignalBridge } from '../src/rmmChromiumSignalBridge.js'
import { startChromiumLoopbackHostBridge } from '../src/rmmChromiumLoopbackHostBridge.js'

const waitMessage=(ws)=>new Promise((resolve,reject)=>{
  const fail=setTimeout(()=>reject(new Error('message timeout')),3000)
  ws.once('message',(m)=>{clearTimeout(fail);resolve(String(m))})
})
const waitClose=(ws)=>new Promise(resolve=>{
  if(ws.readyState===WebSocket.CLOSED){resolve();return}
  ws.once('close',resolve)
  setTimeout(resolve,3000).unref()
})
test('native loopback denies host grants with unencrypted remote WebSocket',()=>{
  assert.throws(()=>startChromiumLoopbackHostBridge({
    alias:'123456789',accessCode:'very-long-unique-secret-abc123',
    hostTicket:'a'.repeat(64),serverUrl:'ws://127.0.0.1:12345/v1/realtime/signal',
    expiresAt:Date.now()+60000,
  }),/Invalid ephemeral/)
})
test('Windows host signal loopback binds 127.0.0.1 only and shuts down cleanly',async()=>{
  // Test the adapter's listener lifecycle against an unreachable WSS
  // endpoint; no host auth secrets or RMM signaling can leave the machine.
  const bridge=startChromiumLoopbackHostBridge({
    alias:'123456789',accessCode:'private-abcdefgh012345678901',
    hostTicket:'a'.repeat(64),serverUrl:'wss://127.0.0.1:1/v1/realtime/signal',
    expiresAt:Date.now()+15000,
  })
  const base=await bridge.localAddress()
  assert.match(base,/^ws:\/\/127\.0\.0\.1:[0-9]+$/)
  const ws=new WebSocket(base+'/signal/123456789?access_code=wrong')
  ws.on('error',()=>{}) // expected pre-upgrade rejection resets TCP
  await waitClose(ws)
  await bridge.close()
  assert.equal(bridge.events.length,0)
})
