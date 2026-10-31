const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const path=require('node:path')
const source=fs.readFileSync(path.join(__dirname,'../../../native/viewer/web/renderer.js'),'utf8')
function extract(start,end){
 const a=source.indexOf(start),b=source.indexOf(end,a)
 assert.ok(a>=0&&b>a,'native codec helper must exist')
 return source.slice(a,b)
}
const capsSource=extract('function nativeViewerCodecCapabilitiesQuery(){',
 'function connectViewerSignaling(reason = \'initial\') {')
const offerSource=extract('function nativeOfferedVideoCodec(sdp) {',
 'async function handleOffer(msg) {')
function evalFn(code,func,args,codecs){
 const sandbox={encodeURIComponent,RTCRtpReceiver:codecs===null?undefined:
  {getCapabilities:()=>({codecs})}}
 vm.runInNewContext(code,sandbox)
 return sandbox[func](...args)
}
test('native receiver advertises actual AV1 and HEVC only',()=>{
 assert.equal(evalFn(capsSource,'nativeViewerCodecCapabilitiesQuery',[],null),'')
 const caps=evalFn(capsSource,'nativeViewerCodecCapabilitiesQuery',[],[
  {mimeType:'video/VP8'}, {mimeType:'video/AV1'},
  {mimeType:'video/HEVC'}, {mimeType:'video/H264',sdpFmtpLine:'profile-level-id=42e028'}])
 assert.match(caps,/video_codecs=vp8%2Ch264%2Cav1%2Ch265/)
 assert.match(caps,/h264_level4=1/)
 const old=evalFn(capsSource,'nativeViewerCodecCapabilitiesQuery',[],[
  {mimeType:'video/VP8'}, {mimeType:'video/rtx'}])
 assert.match(old,/video_codecs=vp8&h264_level4=0/)
 assert.doesNotMatch(old,/av1|h265/)
})
test('native offer identifies AV1 and H265 from authenticated SDP',()=>{
 const av1='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 105 96\r\na=rtpmap:105 AV1/90000\r\na=rtpmap:96 VP8/90000\r\n'
 const h265='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 106\r\na=rtpmap:106 H265/90000\r\n'
 assert.equal(evalFn(offerSource,'nativeOfferedVideoCodec',[av1],null),'av1')
 assert.equal(evalFn(offerSource,'nativeOfferedVideoCodec',[h265],null),'h265')
 assert.equal(evalFn(offerSource,'nativeOfferedVideoCodec',['m=video 0 UDP/TLS/RTP/SAVPF 105\r\na=rtpmap:105 AV1/90000'],null),'')
})
test('native renderer includes verified decode and bounded packet metrics',()=>{
 assert.match(source,/type:'viewer_codec_observation'/)
 assert.match(source,/type:'viewer_codec_failure'/)
 assert.match(source,/packet_loss_rate: packetSampleCount>0/)
 assert.match(source,/packets_sampled: packetSampleCount/)
})


test('12-second first-frame codec failure requires active RTP, not idle or network stall', () => {
  const start=source.indexOf('function shouldTriggerCodecDecoderFallback({')
  const end=source.indexOf('function startTransitionWatchdog()',start)
  assert.ok(start>=0 && end>start)
  const sandbox={}
  vm.runInNewContext(source.slice(start,end),sandbox)
  const check=sandbox.shouldTriggerCodecDecoderFallback
  const good={codec:'av1',offeredAtMs:1000,lastPacketAtMs:12900,
    nowMs:13000,rendered:false,connected:true}
  assert.equal(check(good),true)
  assert.equal(check({...good,codec:''}),false)
  assert.equal(check({...good,rendered:true}),false)
  assert.equal(check({...good,connected:false}),false)
  assert.equal(check({...good,lastPacketAtMs:0}),false)
  assert.equal(check({...good,lastPacketAtMs:3000}),false)
  assert.equal(check({...good,nowMs:7000,lastPacketAtMs:6900}),false)
})
