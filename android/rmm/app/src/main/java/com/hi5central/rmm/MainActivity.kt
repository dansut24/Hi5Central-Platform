package com.hi5central.rmm

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.net.URI

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private var portal: WebView? = null
    private var viewer: WebView? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var nativeKeyboard: RemoteKeyboardController? = null
    private val prefs by lazy { getSharedPreferences("workspace", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(9, 20, 42)
        window.navigationBarColor = Color.rgb(9, 20, 42)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(9, 20, 42))
        setContentView(root)
        createNotificationChannel(this)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 120)
        }
        // Requires app/google-services.json; the debug APK remains usable without Firebase.
        if (FirebaseApp.initializeApp(this) != null) {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                prefs.edit().putString("pending_fcm_token", token).apply()
                // A tenant-authenticated server registration endpoint is required
                // before device alert pushes can be enabled.
            }
        }
        val workspace = prefs.getString("workspace", "") ?: ""
        if (workspace.isEmpty()) showWorkspaceSetup() else openWorkspace(workspace)
    }

    private fun showWorkspaceSetup() {
        closeViewer()
        portal?.let { root.removeView(it); it.destroy() }
        portal = null
        root.removeAllViews()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 72, 48, 48)
            setBackgroundColor(Color.rgb(9, 20, 42))
            gravity = Gravity.CENTER_VERTICAL
        }
        val heading = TextView(this).apply {
            text = "Hi5Central RMM"
            setTextColor(Color.WHITE)
            textSize = 28f
            gravity = Gravity.CENTER
        }
        val help = TextView(this).apply {
            text = "Enter your tenant name to open your secure RMM workspace."
            setTextColor(Color.LTGRAY)
            textSize = 16f
            gravity = Gravity.CENTER
        }
        val entry = EditText(this).apply {
            hint = "Company name or company-rmm.hi5central.com"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.WHITE)
            setHintTextColor(Color.LTGRAY)
        }
        val start = Button(this).apply { text = "Open workspace" }
        layout.addView(heading)
        layout.addView(help)
        layout.addView(entry)
        layout.addView(start)
        root.addView(layout, FrameLayout.LayoutParams(-1, -1))
        start.setOnClickListener {
            val url = parseWorkspace(entry.text.toString())
            if (url == null) {
                entry.error = "Enter a valid Hi5Central tenant name"
            } else {
                prefs.edit().putString("workspace", url).apply()
                openWorkspace(url)
            }
        }
    }

    private fun parseWorkspace(rawInput: String): String? {
        val text = rawInput.trim().lowercase().removeSuffix("/")
        val host = if (text.startsWith("https://")) {
            try {
                val uri = URI(text)
                if (uri.port != -1 || !uri.path.isNullOrEmpty() && uri.path != "/" || uri.query != null || uri.fragment != null) return null
                uri.host ?: return null
            } catch (_: Exception) { return null }
        } else text.removePrefix("http://")
        val slug = when {
            host.endsWith("-rmm.hi5central.com") -> host.removeSuffix("-rmm.hi5central.com")
            !host.contains('.') -> host
            else -> return null
        }
        if (!Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").matches(slug)) return null
        return "https://${slug}-rmm.hi5central.com/"
    }

    private fun openWorkspace(url: String) {
        root.removeAllViews()
        val web = createWebView()
        portal = web
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        web.loadUrl(url)
    }

    private fun createWebView(): WebView {
        val web = WebView(this)
        web.setBackgroundColor(Color.rgb(9, 20, 42))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (view === viewer && isTrustedViewerUrl(url)) {
                    if (nativeKeyboard == null) {
                        nativeKeyboard = RemoteKeyboardController(this@MainActivity, root, web) {
                            viewer === web && isTrustedViewerUrl(web.url)
                        }
                    }
                    nativeKeyboard?.showLauncher()
                } else if (view === viewer) {
                    nativeKeyboard?.dispose()
                    nativeKeyboard = null
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return true
                if (url.scheme == "https" && isAllowedHost(url.host)) return false
                // Do not let authentication, session fragments or tokens leave
                // the tenant-owned in-app browsing context.
                if (url.scheme == "http" || url.scheme == "https") {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
                if (viewer != null || resultMsg == null) return false
                val child = createWebView()
                viewer = child
                root.addView(child, FrameLayout.LayoutParams(-1, -1))
                root.keepScreenOn = true
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                transport.webView = child
                resultMsg.sendToTarget()
                return true
            }
            override fun onCloseWindow(window: WebView?) {
                if (window === viewer) closeViewer()
            }
            override fun onPermissionRequest(request: PermissionRequest?) {
                // Remote viewing is receive-only. Do not grant camera or mic access.
                request?.deny()
            }
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null || fullscreenView != null) return
                fullscreenView = view
                fullscreenCallback = callback
                root.addView(view, FrameLayout.LayoutParams(-1, -1))
                nativeKeyboard?.bringToFront()
                window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            override fun onHideCustomView() { leaveFullscreen() }
        }
        return web
    }

    private fun isTrustedViewerUrl(value: String?): Boolean {
        return try {
            val uri = android.net.Uri.parse(value ?: return false)
            val workspace = android.net.Uri.parse(prefs.getString("workspace", "") ?: "")
            uri.scheme == "https" &&
                uri.host.equals(workspace.host, ignoreCase = true) &&
                uri.path == "/rmm-viewer/index.html"
        } catch (_: Exception) {
            false
        }
    }

    private fun isAllowedHost(host: String?): Boolean {
        val value = host?.lowercase() ?: return false
        return value == "hi5central.com" || value.endsWith(".hi5central.com")
    }

    private fun leaveFullscreen() {
        fullscreenView?.let { root.removeView(it) }
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        window.decorView.systemUiVisibility = 0
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun closeViewer() {
        nativeKeyboard?.dispose()
        nativeKeyboard = null
        leaveFullscreen()
        viewer?.let { root.removeView(it); it.stopLoading(); it.destroy() }
        viewer = null
        root.keepScreenOn = false
    }

    @Deprecated("Supports Android system Back navigation for the embedded viewer")
    override fun onBackPressed() {
        if (nativeKeyboard?.isOpen() == true) { nativeKeyboard?.hideKeyboard(); return }
        if (fullscreenView != null) { leaveFullscreen(); return }
        val child = viewer
        if (child != null) {
            if (child.canGoBack()) child.goBack() else closeViewer()
            return
        }
        val web = portal
        if (web?.canGoBack() == true) { web.goBack(); return }
        AlertDialog.Builder(this)
            .setTitle("Hi5Central RMM")
            .setItems(arrayOf("Change workspace", "Close app")) { _, which ->
                if (which == 0) { prefs.edit().remove("workspace").apply(); showWorkspaceSetup() }
                else finish()
            }
            .show()
    }

    override fun onDestroy() {
        closeViewer()
        portal?.destroy()
        super.onDestroy()
    }
}
