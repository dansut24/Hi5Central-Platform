package com.hi5central.rmm.nativeviewer

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.webrtc.SurfaceViewRenderer
import kotlin.math.min

/**
 * Standalone native screen for the existing Hi5Central Android application.
 * Launch with a fresh session browserUrl from the authenticated RMM API.
 */
class NativeViewerActivity:Activity(),ViewerEvents {
    companion object {
        const val EXTRA_VIEWER_URL="com.hi5central.rmm.nativeviewer.URL"
    }
    private var transport:NativeViewerTransport?=null
    private var renderer:SurfaceViewRenderer?=null
    private lateinit var status:TextView
    private var videoW=0
    private var videoH=0
    private val chatLog=mutableListOf<String>()
    private var chatMessages:TextView?=null
    private var lastFilePath="/"
    private var fileDialog:AlertDialog?=null
    private var pendingFileName="download"
    private var pendingFileBytes:ByteArray?=null
    private val saveFileCode=1008

    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        val launch=ViewerLaunch.from(intent.getStringExtra(EXTRA_VIEWER_URL))
        if(launch==null){
            Toast.makeText(this,"Invalid or expired Hi5Central remote session",Toast.LENGTH_LONG).show()
            finish()
            return
        }
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root=LinearLayout(this).apply{
            orientation=LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        val header=LinearLayout(this).apply{
            orientation=LinearLayout.HORIZONTAL
            gravity=Gravity.CENTER_VERTICAL
            setPadding(14,8,10,8)
            setBackgroundColor(Color.rgb(25,30,42))
        }
        status=TextView(this).apply{
            text="Hi5Central · Connecting"
            textSize=15f
            setTextColor(Color.WHITE)
            layoutParams=LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f)
        }
        header.addView(status)
        val close=Button(this).apply{
            text="Close"
            setOnClickListener{
                AlertDialog.Builder(this@NativeViewerActivity)
                    .setTitle("End remote session?")
                    .setNegativeButton("Cancel",null)
                    .setPositiveButton("Disconnect"){_,_->finish()}
                    .show()
            }
        }
        header.addView(close)
        root.addView(header)
        val stream=SurfaceViewRenderer(this)
        renderer=stream
        stream.setBackgroundColor(Color.BLACK)
        root.addView(stream,LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,0,1f))
        val controls=HorizontalScrollView(this).apply{
            isHorizontalScrollBarEnabled=false
            setBackgroundColor(Color.rgb(25,30,42))
        }
        val actionRow=LinearLayout(this).apply{
            orientation=LinearLayout.HORIZONTAL
            setPadding(4,4,4,4)
        }
        fun action(label:String, callback:()->Unit){
            actionRow.addView(Button(this).apply{
                text=label
                setOnClickListener{callback()}
                minimumHeight=48
            })
        }
        action("Chat"){showChat()}
        action("Files"){transport?.files(lastFilePath)}
        action("Keyboard"){showTextEntry()}
        action("Windows"){transport?.input("shortcut",org.json.JSONObject().put("action","start_menu"))}
        action("Ctrl+Alt+Del"){
            AlertDialog.Builder(this)
                .setTitle("Send Ctrl+Alt+Del?")
                .setNegativeButton("Cancel",null)
                .setPositiveButton("Send"){_,_->transport?.cad()}.show()
        }
        controls.addView(actionRow)
        root.addView(controls)
        setContentView(root)
        transport=NativeViewerTransport(this,stream,launch,this)
        stream.setOnTouchListener{v,event->
            if(event.actionMasked==MotionEvent.ACTION_UP && videoW>0&&videoH>0){
                val w=v.width.toDouble()
                val h=v.height.toDouble()
                val ratio=min(w/videoW,h/videoH)
                val drawnW=videoW*ratio
                val drawnH=videoH*ratio
                val x=(event.x-(w-drawnW)/2)/drawnW
                val y=(event.y-(h-drawnH)/2)/drawnH
                if(x in 0.0..1.0 && y in 0.0..1.0)transport?.tap(x,y)
                true
            }else true
        }
        transport?.start()
    }

    private fun showTextEntry(){
        val field=EditText(this).apply{
            hint="Type on remote computer"
            setSingleLine(false)
        }
        AlertDialog.Builder(this).setTitle("Remote keyboard")
            .setView(field).setNegativeButton("Cancel",null)
            .setPositiveButton("Send"){_,_->transport?.type(field.text.toString())}
            .show()
    }

    private fun showChat(){
        val layout=LinearLayout(this).apply{
            orientation=LinearLayout.VERTICAL
            setPadding(20,10,20,10)
        }
        val history=TextView(this).apply{
            text=chatLog.joinToString("\n\n").ifEmpty{"No messages yet"}
            setTextColor(Color.DKGRAY)
            textSize=14f
        }
        chatMessages=history
        val scroll=ScrollView(this)
        scroll.addView(history)
        layout.addView(scroll,LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,320))
        val draft=EditText(this).apply{hint="Write a message"}
        layout.addView(draft)
        AlertDialog.Builder(this).setTitle("Remote chat")
            .setView(layout)
            .setNegativeButton("Done"){_,_->chatMessages=null}
            .setPositiveButton("Send"){_,_->transport?.chat(draft.text.toString())}
            .show()
    }

    override fun status(text:String){
        runOnUiThread{if(::status.isInitialized)status.text="Hi5Central · "+text}
    }
    override fun size(width:Int,height:Int){
        videoW=width;videoH=height
    }
    override fun chat(author:String,body:String){
        runOnUiThread{
            chatLog.add(author+": "+body)
            chatMessages?.text=chatLog.joinToString("\n\n")
        }
    }
    override fun files(path:String,items:List<Pair<String,String>>){
        lastFilePath=path
        runOnUiThread{
            fileDialog?.dismiss()
            val options=mutableListOf("⬆ Parent folder")
            options.addAll(items.map{(name,encoded)->
                if(encoded.startsWith("D:"))"📁 "+name else "📄 "+name
            })
            fileDialog=AlertDialog.Builder(this)
                .setTitle("Remote files · "+path)
                .setItems(options.toTypedArray()){_,which->
                    if(which==0){
                        val parent=path.trimEnd('/').substringBeforeLast('/',"")
                        transport?.files(if(parent.isBlank())"/" else parent)
                    }else{
                        val file=items[which-1].second
                        if(file.startsWith("D:"))transport?.files(file.removePrefix("D:"))
                        else{
                            Toast.makeText(this,"File download is being added",Toast.LENGTH_SHORT).show()
                        }
                    }
                }
                .setNegativeButton("Done",null)
                .create()
            fileDialog?.show()
        }
    }

    override fun onDestroy(){
        fileDialog?.dismiss()
        transport?.close()
        transport=null
        renderer=null
        super.onDestroy()
    }
}
