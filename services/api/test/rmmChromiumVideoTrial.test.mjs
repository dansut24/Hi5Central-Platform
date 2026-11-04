import test from 'node:test'
import assert from 'node:assert/strict'
import { Hi5ChromiumVideoTrial } from '../../../apps/rmm/public/rmm-viewer/chromiumVideoTrial.js'

const make=({timeoutMs=500}={})=>{
  let firstFrame
  const old={id:'legacy_media_track'}
  const chrome={id:'chromium_media_track'}
  const trialVideo={
    srcObject:null,videoWidth:1920,videoHeight:1080,
    async play(){return true},
    requestVideoFrameCallback(cb){firstFrame=cb;return 1},
  }
  const primaryVideo={
    srcObject:old,
    async play(){return true},
  }
  const adapter={
    callbacks:null,disconnected:false,
    async connect(args){this.callbacks=args;return {state:'negotiating',connected:false}},
    disconnect(){this.disconnected=true},
    track(){
      this.callbacks.onTrack({track:{kind:'video'},streams:[chrome]})
    },
    fail(){this.callbacks.onStateChange({newState:'FAILED'})},
  }
  const bench=new Hi5ChromiumVideoTrial({adapter,trialVideo,primaryVideo,timeoutMs})
  return {bench,adapter,trialVideo,primaryVideo,old,chrome,
    firstFrame(width=1920,height=1080){firstFrame?.(0,{width,height})}}
}

test('first confirmed 1080p frame marks ready without replacing the legacy stream',async()=>{
  const f=make()
  const pending=f.bench.start({grant:{fake:true}})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame(1920,1080)
  const result=await pending
  assert.deepEqual(result,{ready:true,engine:'chromium',width:1920,height:1080,
    measuredFps:null,streamSwitched:false})
  assert.equal(f.primaryVideo.srcObject,f.old)
  assert.equal(f.bench.status,'ready')
  assert.equal(f.adapter.disconnected,false)
  f.bench.promote()
  assert.equal(f.primaryVideo.srcObject,f.chrome)
  assert.equal(f.bench.promoted,true)
  f.bench.rollback()
  assert.equal(f.primaryVideo.srcObject,f.old)
  assert.equal(f.adapter.disconnected,true)
  assert.equal(f.bench.status,'rolled_back')
})

test('720p rendered frame cannot take over primary video',async()=>{
  const f=make()
  const pending=f.bench.start({})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame(1280,720)
  await assert.rejects(pending,/chromium_native_1080p_not_verified/)
  assert.equal(f.primaryVideo.srcObject,f.old)
  assert.equal(f.trialVideo.srcObject,null)
  assert.equal(f.adapter.disconnected,true)
})

test('no first frame triggers timely fallback with the old video intact',async()=>{
  const f=make({timeoutMs:100})
  await assert.rejects(f.bench.start({}),/chromium_first_native_frame_timeout/)
  assert.equal(f.primaryVideo.srcObject,f.old)
  assert.equal(f.adapter.disconnected,true)
})

test('negotiation failure rolls back before presenting media',async()=>{
  const f=make()
  const pending=f.bench.start({})
  await Promise.resolve()
  f.adapter.fail()
  await assert.rejects(pending,/chromium_media_connection_failed/)
  assert.equal(f.primaryVideo.srcObject,f.old)
})

test('RTC failure after Chromium promotion restores exactly the legacy stream',async()=>{
  const f=make()
  const pending=f.bench.start({})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame()
  await pending
  f.bench.promote()
  f.adapter.fail()
  assert.equal(f.bench.status,'rolled_back')
  assert.equal(f.bench.failure,'chromium_media_connection_failed')
  assert.equal(f.primaryVideo.srcObject,f.old)
})

test('RTC failure before promotion prevents swapping dead media',async()=>{
  const f=make()
  const pending=f.bench.start({})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame()
  await pending
  f.adapter.fail()
  assert.throws(()=>f.bench.promote(),/not presented/)
  assert.equal(f.primaryVideo.srcObject,f.old)
})

test('cannot start two parallel Chromium host trial sessions',async()=>{
  const f=make()
  const pending=f.bench.start({})
  await assert.rejects(f.bench.start({}),/already started/)
  f.bench.rollback()
  await assert.rejects(pending,/cancelled/)
})

test('a successful first frame without motion is not falsely treated as a freeze',async()=>{
  const f=make({timeoutMs:150})
  const pending=f.bench.start({})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame()
  await pending
  await new Promise(r=>setTimeout(r,180))
  assert.equal(f.bench.status,'ready')
  f.bench.rollback()
})


test('QoE measurements follow visible Chromium video and stop on rollback',async()=>{
  const f=make()
  f.adapter.peerConnection={id:'chromium_peer'}
  const probes=[]
  const bench=new Hi5ChromiumVideoTrial({
    adapter:f.adapter,trialVideo:f.trialVideo,primaryVideo:f.primaryVideo,
    probeFactory:({pc,video})=>{
      const p={pc,video,started:false,stopped:false,
        start(){this.started=true},
        stop(){this.stopped=true},
        async sample(){return {decodedFps:29,renderedFps:28}},
        summary(){return {renderedFpsMedian:28}},
      }
      probes.push(p)
      return p
    },
  })
  const pending=bench.start({})
  await Promise.resolve()
  f.adapter.track()
  f.firstFrame()
  await pending
  assert.equal(probes.length,1)
  assert.equal(probes[0].pc,f.adapter.peerConnection)
  assert.equal(probes[0].video,f.trialVideo)
  assert.equal(probes[0].started,true)
  assert.deepEqual(bench.performance,{renderedFpsMedian:28})
  bench.promote()
  assert.equal(probes.length,2)
  assert.equal(probes[0].stopped,true)
  assert.equal(probes[1].video,f.primaryVideo)
  assert.equal(f.trialVideo.srcObject,null)
  assert.equal(probes[1].started,true)
  bench.rollback()
  assert.equal(probes[1].stopped,true)
  assert.equal(f.primaryVideo.srcObject,f.old)
})
