// Comparable, content-free media QoE metrics for Chromium-vs-legacy
// Hi5Central RMM. This is an opt-in browser probe, NOT screen recording.
// It samples getStats() deltas and actual presented frames separately,
// avoiding the old error of treating decoder output as screen presentation.
const clamp=(x,min,max)=>Math.min(max,Math.max(min,x))
const finite=(x)=>typeof x==='number'&&Number.isFinite(x)
const n=(x)=>finite(Number(x))?Number(x):0
const median=(values)=>{
  if(!values.length)return null
  const sorted=[...values].sort((a,b)=>a-b)
  return sorted[Math.floor((sorted.length-1)/2)]
}
const percentile=(values,p)=>{
  if(!values.length)return null
  const sorted=[...values].sort((a,b)=>a-b)
  return sorted[Math.ceil(p*sorted.length)-1]
}
const delta=(value,prior)=>value>=prior?value-prior:0
const round=(value,digits=1)=>finite(value)?Number(value.toFixed(digits)):null
export class ChromiumMediaPerformanceProbe {
  #pc
  #video
  #now
  #clock
  #prev=null
  #lastFrameAt=0
  #samples=[]
  #maxSamples
  #presented=0
  #presentSince=0
  #lastPresentCount=0
  #rvfcId=null
  #running=false

  constructor({pc,video,now=()=>Date.now(),maxSamples=120}={}) {
    if(!pc || typeof pc.getStats!=='function')throw new TypeError('RTCPeerConnection required')
    if(!video)throw new TypeError('Video element required')
    this.#pc=pc
    this.#video=video
    this.#now=now
    this.#clock=now
    this.#maxSamples=clamp(Math.floor(maxSamples),4,600)
  }

  start(){
    if(this.#running)return
    this.#running=true
    this.#presentSince=this.#clock()
    if(typeof this.#video.requestVideoFrameCallback==='function') {
      const callback=(_now,metadata)=>{
        if(!this.#running)return
        // Monotonic presentedFrames lets us detect compositor skips.
        const count=n(metadata?.presentedFrames)
        this.#presented=count>this.#presented?count:this.#presented+1
        this.#lastFrameAt=this.#clock()
        this.#rvfcId=this.#video.requestVideoFrameCallback(callback)
      }
      this.#rvfcId=this.#video.requestVideoFrameCallback(callback)
    }
  }

  stop(){
    this.#running=false
    if(this.#rvfcId!==null &&
       typeof this.#video.cancelVideoFrameCallback==='function') {
      this.#video.cancelVideoFrameCallback(this.#rvfcId)
    }
    this.#rvfcId=null
  }

  async sample(){
    if(!this.#running)throw new Error('Probe not running')
    const now=this.#now()
    const stats=await this.#pc.getStats()
    let inbound=null,pair=null,remote=null
    stats.forEach((s)=>{
      if(s.type==='inbound-rtp' && s.kind==='video' && !s.isRemote) {
        if(!inbound || n(s.bytesReceived)>n(inbound.bytesReceived))inbound=s
      }
      if(s.type==='candidate-pair' && s.state==='succeeded' && s.nominated)
        pair=s
      if(s.type==='remote-inbound-rtp' && s.kind==='video')remote=s
    })
    if(!inbound){
      return {available:false,at:now,iceState:this.#pc.iceConnectionState||'unknown'}
    }
    const current={
      at:now,frames:n(inbound.framesDecoded),
      received:n(inbound.bytesReceived),lost:n(inbound.packetsLost),
      dropped:n(inbound.framesDropped),
      jitter:n(inbound.jitterBufferDelay),
      jitterEmitted:n(inbound.jitterBufferEmittedCount),
      totalDecode:n(inbound.totalDecodeTime),
      presented:this.#presented,
    }
    const prior=this.#prev
    const duration=prior?Math.max(0.001,(current.at-prior.at)/1000):0
    const decoded=prior?delta(current.frames,prior.frames):0
    const jitterEmitted=prior?delta(current.jitterEmitted,prior.jitterEmitted):0
    const avgJitterMs=jitterEmitted>0
      ?1000*delta(current.jitter,prior.jitter)/jitterEmitted:null
    const sample={
      available:true,
      at:now,
      durationSeconds:round(duration,3),
      encodedWidth:n(inbound.frameWidth)||null,
      encodedHeight:n(inbound.frameHeight)||null,
      decodedFps:duration?round(decoded/duration):null,
      renderedFps:duration&&this.#video.requestVideoFrameCallback
        ?round(delta(current.presented,prior.presented)/duration):null,
      receivedKbps:duration?round((delta(current.received,prior.received)*8)/duration/1000):null,
      lostPackets:prior?delta(current.lost,prior.lost):null,
      droppedFrames:prior?delta(current.dropped,prior.dropped):null,
      avgJitterBufferMs:round(avgJitterMs),
      avgDecodeMs:decoded>0?round(1000*delta(current.totalDecode,prior.totalDecode)/decoded):null,
      rttMs:round(finite(pair?.currentRoundTripTime)
        ?pair.currentRoundTripTime*1000
        :finite(remote?.roundTripTime)?remote.roundTripTime*1000:null),
      iceState:this.#pc.iceConnectionState||'unknown',
      elapsedSinceRenderedMs:this.#lastFrameAt>0
        ?Math.max(0,now-this.#lastFrameAt):null,
    }
    this.#prev=current
    if(prior){
      this.#samples.push(sample)
      if(this.#samples.length>this.#maxSamples)this.#samples.shift()
    }
    return sample
  }

  summary(){
    const available=this.#samples.filter(x=>x.available)
    const points=(key)=>available.map(s=>s[key]).filter(finite)
    const render=points('renderedFps')
    const decode=points('decodedFps')
    const jitter=points('avgJitterBufferMs')
    const rtt=points('rttMs')
    return {
      sampleCount:available.length,
      decodedFpsMedian:round(median(decode)),
      renderedFpsMedian:round(median(render)),
      renderedFpsP10:round(percentile(render,0.1)),
      jitterBufferP95Ms:round(percentile(jitter,0.95)),
      rttP95Ms:round(percentile(rtt,0.95)),
      packetsLostTotal:available.reduce((x,s)=>x+n(s.lostPackets),0),
      framesDroppedTotal:available.reduce((x,s)=>x+n(s.droppedFrames),0),
      maxWidth:Math.max(0,...available.map(s=>s.encodedWidth||0)),
      maxHeight:Math.max(0,...available.map(s=>s.encodedHeight||0)),
    }
  }
}
// Metrics are only useful if they come from equivalent active-motion windows.
// An idle desktop's zero-FPS is NOT automatically classified as a freeze.
export function assessChromiumAgainstLegacy({chromium,legacy}={}){
  if(!chromium || !legacy || chromium.sampleCount<5 || legacy.sampleCount<5)
    return {comparable:false,reason:'insufficient_live_motion_samples'}
  if(chromium.maxWidth<1920 || chromium.maxHeight<1080)
    return {comparable:true,improved:false,reason:'chromium_not_native_1080p'}
  if(!finite(chromium.renderedFpsMedian) || !finite(legacy.renderedFpsMedian))
    return {comparable:false,reason:'rendered_frame_metric_unavailable'}
  const fpsImproved=chromium.renderedFpsMedian>=legacy.renderedFpsMedian*1.2
  const jitterGood=!finite(chromium.jitterBufferP95Ms) ||
    !finite(legacy.jitterBufferP95Ms) ||
    chromium.jitterBufferP95Ms<=legacy.jitterBufferP95Ms*1.15
  const rttGood=!finite(chromium.rttP95Ms) || !finite(legacy.rttP95Ms) ||
    chromium.rttP95Ms<=legacy.rttP95Ms*1.2
  return {comparable:true,improved:fpsImproved&&jitterGood&&rttGood,
    reason:!fpsImproved?'fps_gain_below_20_percent':
      !jitterGood?'jitter_buffer_regression':!rttGood?'network_latency_regression':
      'native_detail_and_fps_gain_without_latency_regression'}
}
