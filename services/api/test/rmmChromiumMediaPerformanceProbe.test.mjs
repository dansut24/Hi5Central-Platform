import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ChromiumMediaPerformanceProbe,assessChromiumAgainstLegacy,
} from '../../../apps/rmm/public/rmm-viewer/chromiumMediaPerformanceProbe.js'

const make=()=>{
  let now=100000
  let callback
  let cancelled=false
  const video={
    requestVideoFrameCallback(fn){callback=fn;return 42},
    cancelVideoFrameCallback(id){cancelled=id===42},
    frame(presentedFrames){
      callback?.(now,{presentedFrames})
    },
    get cancelled(){return cancelled},
  }
  const input={at:0,frames:0,received:0,lost:0,dropped:0,
    jitter:0,emitted:0,decode:0,width:1920,height:1080,rtt:0.047}
  const pc={
    iceConnectionState:'connected',
    async getStats(){
      const inbound={type:'inbound-rtp',kind:'video',
        framesDecoded:input.frames,
        framesDropped:input.dropped,
        frameWidth:input.width,frameHeight:input.height,
        bytesReceived:input.received,packetsLost:input.lost,
        jitterBufferDelay:input.jitter,jitterBufferEmittedCount:input.emitted,
        totalDecodeTime:input.decode}
      const pair={type:'candidate-pair',state:'succeeded',nominated:true,
        currentRoundTripTime:input.rtt}
      return new Map([['in',inbound],['pair',pair]])
    },
  }
  const probe=new ChromiumMediaPerformanceProbe({pc,video,now:()=>now})
  return {probe,input,video,advance(ms){now+=ms}}
}
test('records actual displayed FPS separate from decoder FPS',async()=>{
  const f=make()
  f.probe.start()
  await f.probe.sample()
  f.advance(2000)
  f.input.frames=60
  f.input.received=750000
  f.input.emitted=60
  f.input.jitter=3
  f.input.decode=0.42
  f.input.dropped=3
  f.video.frame(40)
  const sample=await f.probe.sample()
  assert.equal(sample.encodedWidth,1920)
  assert.equal(sample.encodedHeight,1080)
  assert.equal(sample.decodedFps,30)
  assert.equal(sample.renderedFps,20)
  assert.equal(sample.receivedKbps,3000)
  assert.equal(sample.avgDecodeMs,7)
  assert.equal(sample.avgJitterBufferMs,50)
  assert.equal(sample.rttMs,47)
  assert.equal(sample.droppedFrames,3)
  assert.equal(sample.elapsedSinceRenderedMs,0)
  f.probe.stop()
  assert.equal(f.video.cancelled,true)
})
test('handles no inbound stream or no presented frame callback without fake frame rates',async()=>{
  const f=make()
  f.video.requestVideoFrameCallback=undefined
  f.probe.start()
  await f.probe.sample()
  f.advance(1000)
  f.input.frames=10
  const row=await f.probe.sample()
  assert.equal(row.decodedFps,10)
  assert.equal(row.renderedFps,null)
  assert.equal(row.elapsedSinceRenderedMs,null)
  f.probe.stop()
})
test('bounded summaries and non-negative counter resets',async()=>{
  const f=make()
  f.probe.start()
  await f.probe.sample()
  for(let j=1;j<=6;j++){
    f.advance(1000)
    f.input.frames=j===5?0:j*20
    f.input.received=j*1000
    f.input.emitted=j*20
    f.input.jitter=j*1.2
    f.video.frame(j*18)
    await f.probe.sample()
  }
  const result=f.probe.summary()
  assert.equal(result.sampleCount,6)
  assert.equal(result.maxHeight,1080)
  assert.ok(result.renderedFpsMedian>=17)
  assert.equal(result.packetsLostTotal,0)
})
test('acceptance rejects Chromium without native 1080p or active motion evidence',()=>{
  const base={sampleCount:8,maxWidth:1920,maxHeight:1080,
    renderedFpsMedian:17,jitterBufferP95Ms:450,rttP95Ms:47}
  const better={...base,renderedFpsMedian:30,jitterBufferP95Ms:200,rttP95Ms:40}
  assert.equal(assessChromiumAgainstLegacy({
    legacy:base,chromium:{...better,maxWidth:1280,maxHeight:720}
  }).reason,'chromium_not_native_1080p')
  assert.equal(assessChromiumAgainstLegacy({
    legacy:base,chromium:{...better,sampleCount:2}
  }).comparable,false)
  assert.deepEqual(assessChromiumAgainstLegacy({
    legacy:base,chromium:better,
  }),{comparable:true,improved:true,
    reason:'native_detail_and_fps_gain_without_latency_regression'})
  assert.equal(assessChromiumAgainstLegacy({
    legacy:base,chromium:{...better,renderedFpsMedian:18}
  }).improved,false)
  assert.equal(assessChromiumAgainstLegacy({
    legacy:base,chromium:{...better,jitterBufferP95Ms:900}
  }).reason,'jitter_buffer_regression')
})
test('probe start/stop remains cheap, with no screen capture or network reporting',async()=>{
  const f=make()
  await assert.rejects(f.probe.sample(),/not running/)
  f.probe.start()
  f.probe.start()
  await f.probe.sample()
  assert.equal(f.probe.summary().sampleCount,0)
  f.probe.stop()
  f.probe.stop()
})
