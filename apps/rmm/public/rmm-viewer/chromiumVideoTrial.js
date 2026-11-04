// Video-only Chromium A/B trial for the existing Hi5Central browser Viewer.
// The legacy video track is not replaced until a Chromium frame is genuinely
// presented at native 1080p (not merely SDP/ICE connected). On any failure,
// the already-working Hi5Central Agent/Viewer remains available.
// No clipboard/keyboard/mouse routing switches in this experimental stage.
export class Hi5ChromiumVideoTrial {
  #adapter
  #trialVideo
  #primaryVideo
  #makeStream
  #minWidth
  #minHeight
  #timeoutMs
  #status='idle'
  #promoted=false
  #priorStream=null
  #timer=null
  #settle=null
  #failure=null
  #started=false

  constructor({adapter,trialVideo,primaryVideo,
    makeStream=(track)=>new MediaStream([track]),
    minWidth=1920,minHeight=1080,timeoutMs=12000}={}) {
    if(!adapter || typeof adapter.connect!=='function' ||
       typeof adapter.disconnect!=='function' ||
       !trialVideo || typeof trialVideo.requestVideoFrameCallback!=='function' ||
       !primaryVideo || typeof makeStream!=='function') {
      throw new TypeError('Video trial needs the Hi5Central adapter and two video elements')
    }
    this.#adapter=adapter
    this.#trialVideo=trialVideo
    this.#primaryVideo=primaryVideo
    this.#makeStream=makeStream
    this.#minWidth=Math.max(1,Math.floor(minWidth))
    this.#minHeight=Math.max(1,Math.floor(minHeight))
    this.#timeoutMs=Math.min(60000,Math.max(100,Math.floor(timeoutMs)))
  }

  async start(options) {
    if(this.#started)throw new Error('Chromium trial already started')
    this.#started=true
    this.#status='negotiating'
    this.#priorStream=this.#primaryVideo.srcObject
    const outcome=new Promise((resolve,reject)=>{
      this.#settle={resolve,reject}
    })
    this.#timer=setTimeout(()=>{
      this.#fail('chromium_first_native_frame_timeout')
    },this.#timeoutMs)
    this.#timer.unref?.()

    const onTrack=({track,streams}={})=>{
      if(this.#status!=='negotiating' || track?.kind!=='video')return
      try {
        this.#trialVideo.srcObject=streams?.[0]||this.#makeStream(track)
        // The test video must be physically attached to the page and
        // playing. A compositor-hidden video can otherwise give false
        // "0 FPS" results even with healthy media transport.
        this.#trialVideo.muted=true
        this.#trialVideo.playsInline=true
        this.#trialVideo.autoplay=true
        const playback=this.#trialVideo.play?.()
        playback?.catch?.(()=>this.#fail('chromium_video_play_rejected'))
        this.#trialVideo.requestVideoFrameCallback((_ts,meta)=>{
          if(this.#status!=='negotiating')return
          const width=Math.max(0,Number(meta?.width||this.#trialVideo.videoWidth)||0)
          const height=Math.max(0,Number(meta?.height||this.#trialVideo.videoHeight)||0)
          if(width<this.#minWidth || height<this.#minHeight){
            this.#fail('chromium_native_1080p_not_verified')
            return
          }
          clearTimeout(this.#timer)
          this.#timer=null
          this.#status='ready'
          const settle=this.#settle
          this.#settle=null
          settle?.resolve({
            ready:true,engine:'chromium',width,height,
            // This is only a *first frame* checkpoint, not a claim
            // of 30 FPS or improved long-term performance.
            measuredFps:null,streamSwitched:false,
          })
        })
      } catch {
        this.#fail('chromium_video_track_setup_failed')
      }
    }
    const onStateChange=({newState}={})=>{
      if(this.#status==='negotiating' &&
         ['FAILED','CLOSED'].includes(newState)){
        this.#fail('chromium_media_connection_failed')
      }
      if(this.#status==='promoted' &&
         ['FAILED','CLOSED'].includes(newState)){
        this.rollback()
      }
    }
    void this.#adapter.connect({...options,onTrack,onStateChange})
      .catch(()=>this.#fail('chromium_negotiation_failed'))
    return outcome
  }

  promote(){
    if(this.#status!=='ready' || !this.#trialVideo.srcObject) {
      throw new Error('Chromium has not presented native resolution video')
    }
    this.#primaryVideo.srcObject=this.#trialVideo.srcObject
    this.#status='promoted'
    this.#promoted=true
    this.#primaryVideo.play?.()?.catch?.(()=>this.rollback())
    return {engine:'chromium',promoted:true}
  }

  #fail(reason){
    if(this.#status==='rolled_back' || this.#status==='ready' ||
       this.#status==='promoted')return
    this.#failure=reason
    const settle=this.#settle
    this.#settle=null
    this.rollback()
    settle?.reject(new Error(reason))
  }

  rollback(){
    if(this.#status==='rolled_back')return
    if(this.#timer){clearTimeout(this.#timer);this.#timer=null}
    const unsettled=this.#settle
    this.#settle=null
    this.#status='rolled_back'
    if(this.#promoted){
      this.#primaryVideo.srcObject=this.#priorStream
      this.#primaryVideo.play?.()?.catch?.(()=>{})
    }
    this.#promoted=false
    this.#trialVideo.srcObject=null
    this.#adapter.disconnect()
    if(unsettled)unsettled.reject(new Error('chromium_trial_cancelled'))
  }

  get status(){return this.#status}
  get failure(){return this.#failure}
  get promoted(){return this.#promoted}
}
