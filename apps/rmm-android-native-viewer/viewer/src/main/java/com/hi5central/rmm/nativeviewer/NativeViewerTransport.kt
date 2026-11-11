package com.hi5central.rmm.nativeviewer

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*
import java.util.UUID
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

internal data class ViewerLaunch(
    val session:String, val device:String, val token:String, val websocket:String,
    val ice:List<PeerConnection.IceServer>
) {
    companion object {
        fun from(urlString:String?):ViewerLaunch? {
            val uri=Uri.parse(urlString ?: return null)
            if(uri.scheme!="https" || !(uri.host?.endsWith("-rmm.hi5central.com")?:false)
                || !uri.path.orEmpty().startsWith("/rmm-viewer/"))return null
            val query=Uri.parse("https://viewer.invalid/?" + (uri.fragment ?: return null))
            val sid=query.getQueryParameter("session_id") ?: return null
            val did=query.getQueryParameter("device_id") ?: return null
            val tok=query.getQueryParameter("token") ?: return null
            if(runCatching{UUID.fromString(sid)}.isFailure ||
                runCatching{UUID.fromString(did)}.isFailure || !tok.startsWith("h5v"))return null
            val ws=Uri.parse(query.getQueryParameter("wss_url")?:return null)
            val host=ws.host ?: return null
            if(ws.scheme!="wss" || (host!="hi5central.com"&&!host.endsWith(".hi5central.com")))return null
            val socket=ws.buildUpon().appendQueryParameter("session_id",sid)
                .appendQueryParameter("device_id",did).appendQueryParameter("token",tok)
                .appendQueryParameter("client","browser").build().toString()
            val servers=mutableListOf<PeerConnection.IceServer>()
            runCatching {
                val b64=query.getQueryParameter("ice")?:""
                val array=JSONArray(String(Base64.decode(b64,Base64.URL_SAFE or Base64.NO_WRAP)))
                for(i in 0 until array.length()){
                    val server=array.optJSONObject(i)?:continue
                    val urls=server.optJSONArray("urls")
                    val values=if(urls==null)listOf(server.optString("urls"))
                               else (0 until urls.length()).map{urls.optString(it)}
                    val permitted=values.filter{
                        it.startsWith("stun:")||it.startsWith("turn:")||it.startsWith("turns:")
                    }
                    if(permitted.isNotEmpty())servers+=PeerConnection.IceServer.builder(permitted)
                        .setUsername(server.optString("username"))
                        .setPassword(server.optString("credential")).createIceServer()
                }
            }
            return ViewerLaunch(sid,did,tok,socket,servers)
        }
    }
}

internal interface ViewerEvents {
    fun status(text:String)
    fun size(width:Int,height:Int)
    fun chat(author:String,body:String)
    fun files(path:String,items:List<Pair<String,String>>)
}

private open class SdpCallback:SdpObserver {
    override fun onCreateSuccess(sdp:SessionDescription){}
    override fun onCreateFailure(error:String){}
    override fun onSetSuccess(){}
    override fun onSetFailure(error:String){}
}

internal class NativeViewerTransport(
    context:Context, private val display:SurfaceViewRenderer,
    private val launch:ViewerLaunch, private val events:ViewerEvents
):WebSocketListener(),PeerConnection.Observer {
    private val main=Handler(Looper.getMainLooper())
    private val http=OkHttpClient.Builder().pingInterval(20,TimeUnit.SECONDS).build()
    private val egl=EglBase.create()
    private val factory:PeerConnectionFactory
    private var ws:WebSocket?=null
    private var pc:PeerConnection?=null
    private var dc:DataChannel?=null
    private var remoteReady=false
    private val pending=mutableListOf<IceCandidate>()
    private var closed=false

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
            .builder(context.applicationContext).createInitializationOptions())
        factory=PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext,true,true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        display.init(egl.eglBaseContext,object:RendererCommon.RendererEvents{
            override fun onFirstFrameRendered(){status("Streaming")}
            override fun onFrameResolutionChanged(width:Int,height:Int,rotation:Int){
                main.post{events.size(width,height)}
            }
        })
        display.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    }
    private fun status(text:String){main.post{events.status(text)}}
    fun start(){ws=http.newWebSocket(Request.Builder().url(launch.websocket).build(),this)}
    private fun send(type:String,extra:JSONObject=JSONObject()){
        if(closed)return
        val msg=JSONObject().put("type",type).put("session_id",launch.session)
        val keys=extra.keys()
        while(keys.hasNext()){val k=keys.next();msg.put(k,extra.opt(k))}
        ws?.send(msg.toString())
    }
    override fun onOpen(webSocket:WebSocket,response:Response){status("Signalling connected")}
    override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?){status("Connection interrupted")}
    override fun onMessage(webSocket:WebSocket,text:String){
        val json=runCatching{JSONObject(text)}.getOrNull()?:return
        when(json.optString("type")){
            "webrtc_offer"->createAnswer(json.optString("sdp"))
            "ice_candidate"->{
                val candidate=IceCandidate(json.optString("mid",json.optString("sdpMid")),
                    json.optInt("mline_index",json.optInt("sdpMLineIndex")),
                    json.optString("candidate"))
                if(remoteReady)pc?.addIceCandidate(candidate)
                else synchronized(pending){pending.add(candidate)}
            }
            "session_config"->status("Negotiating video")
            "chat_message"->main.post{events.chat(
                json.optString("display_name",json.optString("sender","Remote")),
                json.optString("body",json.optString("message")))}
            "remote_file_list"->{
                val path=json.optString("path","/")
                val entries=json.optJSONArray("entries")?:JSONArray()
                val result=(0 until entries.length()).mapNotNull{n->
                    val row=entries.optJSONObject(n)?:return@mapNotNull null
                    val name=row.optString("name")
                    if(name.isEmpty())return@mapNotNull null
                    val full=row.optString("path").ifEmpty{path.trimEnd('/')+"/"+name}
                    val folder=row.optBoolean("isDirectory")||row.optBoolean("is_dir")
                    name to (if(folder)"D:"+full else "F:"+full)
                }
                main.post{events.files(path,result)}
            }
        }
    }
    private fun createAnswer(sdp:String){
        if(sdp.isBlank())return
        pc?.close()
        remoteReady=false
        val config=PeerConnection.RTCConfiguration(launch.ice)
        config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN
        val peer=factory.createPeerConnection(config,this)?:run{
            status("Could not create native peer");return
        }
        pc=peer
        status("Negotiating native WebRTC")
        peer.setRemoteDescription(object:SdpCallback(){
            override fun onSetSuccess(){
                remoteReady=true
                synchronized(pending){pending.forEach{peer.addIceCandidate(it)};pending.clear()}
                val constraints=MediaConstraints().apply{
                    mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo","true"))
                    mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio","true"))
                }
                peer.createAnswer(object:SdpCallback(){
                    override fun onCreateSuccess(answer:SessionDescription){
                        peer.setLocalDescription(object:SdpCallback(){
                            override fun onSetSuccess(){send("webrtc_answer",JSONObject()
                                .put("sdp",answer.description).put("sdp_type","answer"))}
                        },answer)
                    }
                },constraints)
            }
            override fun onSetFailure(error:String){status("Remote SDP unsupported")}
        },SessionDescription(SessionDescription.Type.OFFER,sdp))
    }
    fun input(kind:String,extra:JSONObject=JSONObject()){
        val msg=JSONObject().put("kind",kind)
        val keys=extra.keys()
        while(keys.hasNext()){val k=keys.next();msg.put(k,extra.opt(k))}
        val ch=dc
        if(ch?.state()==DataChannel.State.OPEN){
            ch.send(DataChannel.Buffer(ByteBuffer.wrap(msg.toString().toByteArray()),false))
        }else send("input_event",msg)
    }
    fun tap(x:Double,y:Double){input("mouse_click",JSONObject()
        .put("x_norm",x.coerceIn(0.0,1.0)).put("y_norm",y.coerceIn(0.0,1.0)).put("button",0))}
    fun type(value:String){if(value.isNotBlank())input("text_input",JSONObject().put("text",value.take(4000)))}
    fun chat(value:String){
        val body=value.trim().take(2000)
        if(body.isEmpty())return
        val id=UUID.randomUUID().toString()
        send("chat_message",JSONObject().put("message_id",id).put("messageId",id)
            .put("sessionId",launch.session).put("sender","tech")
            .put("display_name","Technician").put("body",body).put("message",body).put("text",body))
        main.post{events.chat("You",body)}
    }
    fun files(path:String="/"){if(path.length<1024)send("remote_file_list_request",
        JSONObject().put("sessionId",launch.session).put("path",path))}
    fun cad(){send("service_shortcut",JSONObject()
        .put("kind","service_shortcut").put("action","ctrl_alt_del_service"))}
    override fun onSignalingChange(state:PeerConnection.SignalingState){}
    override fun onIceConnectionChange(state:PeerConnection.IceConnectionState){
        if(state==PeerConnection.IceConnectionState.CONNECTED||
            state==PeerConnection.IceConnectionState.COMPLETED)status("Connected")
        if(state==PeerConnection.IceConnectionState.FAILED)status("Native ICE failed")
    }
    override fun onIceConnectionReceivingChange(receiving:Boolean){}
    override fun onIceGatheringChange(state:PeerConnection.IceGatheringState){}
    override fun onIceCandidate(candidate:IceCandidate){
        send("ice_candidate",JSONObject().put("candidate",candidate.sdp)
            .put("mid",candidate.sdpMid).put("sdpMid",candidate.sdpMid)
            .put("mline_index",candidate.sdpMLineIndex).put("sdpMLineIndex",candidate.sdpMLineIndex))
    }
    override fun onIceCandidatesRemoved(candidates:Array<out IceCandidate>){}
    override fun onAddStream(stream:MediaStream){stream.videoTracks.firstOrNull()?.addSink(display)}
    override fun onRemoveStream(stream:MediaStream){}
    override fun onDataChannel(channel:DataChannel){
        if(channel.label()=="input"||channel.label()=="input-control")dc=channel
    }
    override fun onRenegotiationNeeded(){}
    override fun onAddTrack(receiver:RtpReceiver,streams:Array<out MediaStream>){
        (receiver.track() as? VideoTrack)?.addSink(display)
    }
    override fun onTrack(transceiver:RtpTransceiver){
        (transceiver.receiver.track() as? VideoTrack)?.addSink(display)
    }
    fun close(){
        closed=true
        ws?.close(1000,"closed")
        pc?.close()
        factory.dispose()
        display.release()
        egl.release()
        http.dispatcher.executorService.shutdown()
    }
}
