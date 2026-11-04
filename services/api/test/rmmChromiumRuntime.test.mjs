import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { createRmmChromiumRuntime } from '../src/rmmChromiumRuntime.js'

const ID='b74c7e77-eb34-41c3-8854-0f96cfbca2b0'
const SESSION='67fb6d11-99c3-418f-9abd-11d5e86dd604'
const TENANT='8434c6bc-5909-4393-b63a-03067a9eed77'
const HOSTSHA='01de5e356163896a0df967f73011e5315b2b17530d550017ee9f16799e7b20bb'
const live = () => {
  const subscribers = new Map(), wire=[]
  const ws={readyState:1}
  let currentSocket=ws
  const broker = {
    pool: {async query(){return {rows:[]}}},
    agentSocketForDevice:()=>currentSocket,
    sendAgentMessage:(deviceId,message)=>{wire.push({deviceId,message});return true},
    subscribeAgentMessages:(deviceId,callback)=>{
      const callbacks=subscribers.get(deviceId)||new Set()
      callbacks.add(callback)
      subscribers.set(deviceId,callbacks)
      return ()=>{callbacks.delete(callback)}
    },
  }
  const receive=(deviceId,payload)=>{for(const cb of (subscribers.get(deviceId)||[]))cb(payload)}
  return {broker,receive,wire,ws,subscribers,setSocket:(s)=>{currentSocket=s}}
}
const waitOnce=(target,event)=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('event timeout: '+event)),3000)
  target.once(event,(...args)=>{clearTimeout(timeout);resolve(args[0])})
})
test('Chromium runtime is inert when feature flag is absent',()=>{
  const f=live(),runtime=createRmmChromiumRuntime({...f.broker})
  const http=new EventEmitter()
  assert.equal(runtime.enabled,false)
  assert.equal(runtime.attachSignaling(http),null)
  assert.equal(http.listenerCount('upgrade'),0)
  assert.equal(runtime.watchHostReady(ID,SESSION) instanceof Function,true)
  assert.deepEqual(runtime.grants.status(),{enabled:false,pendingSessions:0})
})

test('Agent capability request goes through existing broker and nonce response',async()=>{
  const f=live(),runtime=createRmmChromiumRuntime({...f.broker,enabled:true})
  const challenge='a4eeb177-702a-4cd8-8356-6d046fd03941'
  const response=runtime.probeAgent({agentDeviceId:ID,sessionId:SESSION,nonce:challenge,socket:f.ws})
  assert.equal(f.wire.length,1)
  assert.deepEqual(f.wire[0],{deviceId:ID,message:{
    type:'chromium_capabilities_request',session_id:SESSION,
    request_id:challenge,protocol_version:3}})
  f.receive(ID,{type:'chromium_capabilities_response',session_id:SESSION,
    request_id:'wrong',capable:true,protocol_version:3,host_sha256:HOSTSHA})
  assert.equal(f.subscribers.get(ID).size,1)
  f.receive(ID,{type:'chromium_capabilities_response',session_id:SESSION,
    request_id:challenge,capable:true,protocol_version:3,host_sha256:HOSTSHA})
  const proof=await response
  assert.equal(proof.nonce,challenge)
  assert.equal(proof.agent_device_id,ID)
  assert.equal(proof.host_sha256,HOSTSHA)
  assert.equal(f.subscribers.get(ID)?.size||0,0)
})

test('the Agent capability probe fails if socket is no longer authenticated',async()=>{
  const f=live(),runtime=createRmmChromiumRuntime({...f.broker,enabled:true})
  f.setSocket({readyState:3})
  const result=await runtime.probeAgent({agentDeviceId:ID,sessionId:SESSION,
    nonce:'nonce',socket:f.ws})
  assert.equal(result,null)
  assert.equal(f.wire.length,0)
})

test('native host ready can only be issued from matching authenticated Agent channel',()=>{
  const f=live(),runtime=createRmmChromiumRuntime({...f.broker,enabled:true})
  const unwatch=runtime.watchHostReady(ID,SESSION)
  assert.equal(f.subscribers.get(ID).size,1)
  f.receive(ID,{type:'chromium_host_ready',session_id:SESSION,
    request_id:'unapproved',ready:true,protocol_version:3})
  assert.equal(runtime.grants.status().pendingSessions,0)
  unwatch()
  assert.equal(f.subscribers.get(ID).size,0)
})

test('real WebSocket host/browser Jingle passes over in-process H5C server',async()=>{
  const f=live(),runtime=createRmmChromiumRuntime({...f.broker,enabled:true})
  const server=createServer((_request,response)=>{response.statusCode=404;response.end()})
  const wss=runtime.attachSignaling(server)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=server.address().port
  const url='ws://127.0.0.1:'+port+'/v1/realtime/signal'
  const expiry=Date.now()+60000
  const deviceId='123456789'
  const hostTicket=runtime.bridge.issueTicket({tenantId:TENANT,sessionId:SESSION,
    deviceId,subjectId:ID,role:'host',expiresAt:expiry})
  const clientTicket=runtime.bridge.issueTicket({tenantId:TENANT,sessionId:SESSION,
    deviceId,subjectId:'agent-owner',role:'client',clientId:'webclient_abc',expiresAt:expiry})
  let host,client
  try{
    host=new WebSocket(url)
    await waitOnce(host,'open')
    host.send(JSON.stringify({type:'auth',signal_token:hostTicket,role:'host',device_id:deviceId}))
    assert.equal(JSON.parse(await waitOnce(host,'message')).type,'auth_ok')
    client=new WebSocket(url)
    await waitOnce(client,'open')
    client.send(JSON.stringify({type:'auth',signal_token:clientTicket,role:'client',
      device_id:deviceId,client_id:'webclient_abc'}))
    assert.equal(JSON.parse(await waitOnce(client,'message')).type,'auth_ok')
    const iq='<iq type="set"><jingle action="session-initiate"/></iq>'
    client.send(JSON.stringify({client_id:'webclient_abc',payload:iq}))
    assert.equal(JSON.parse(await waitOnce(host,'message')).payload,iq)
    host.send(JSON.stringify({client_id:'webclient_abc',payload:iq}))
    assert.equal(JSON.parse(await waitOnce(client,'message')).payload,iq)
    runtime.bridge.revokeSession(TENANT,SESSION)
    await Promise.all([waitOnce(host,'close'),waitOnce(client,'close')])
    assert.deepEqual(runtime.bridge.metrics(),{pendingTickets:0,activeSessions:0})
  }finally{
    host?.terminate()
    client?.terminate()
    await new Promise(resolve=>wss.close(resolve))
    await new Promise(resolve=>server.close(resolve))
  }
})
