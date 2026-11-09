package com.hi5central.rmm

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONObject

/**
 * Native IME adapter for the existing Hi5Central browser viewer.
 *
 * It sends input only to the authenticated tenant viewer WebView, using the
 * same sendInput() function the web viewer uses for its own mobile keyboard.
 * Nothing is stored or forwarded to a separate native service.
 */
class RemoteKeyboardController(
    private val activity: Activity,
    private val root: FrameLayout,
    private val viewer: WebView,
    private val isTrustedViewer: () -> Boolean
) {
    private var launcher: Button? = null
    private var panel: LinearLayout? = null
    private var field: EditText? = null
    private var lastText = ""
    private var resetting = false

    private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    fun showLauncher() {
        if (!isTrustedViewer() || launcher != null) return
        val type = Button(activity).apply {
            text = "⌨ Type"
            setAllCaps(false)
            textSize = 13f
            setTextColor(Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(Color.rgb(22, 98, 205))
            contentDescription = "Type on remote computer with Android keyboard"
            setOnClickListener { openKeyboard() }
        }
        launcher = type
        val params = FrameLayout.LayoutParams(dp(100), dp(49), Gravity.BOTTOM or Gravity.END)
        params.setMargins(dp(8), dp(8), dp(12), dp(76))
        root.addView(type, params)
        type.bringToFront()
    }

    fun bringToFront() {
        panel?.bringToFront()
        launcher?.bringToFront()
    }

    fun isOpen(): Boolean = panel != null

    private fun openKeyboard() {
        if (!isTrustedViewer()) {
            Toast.makeText(activity, "Open an active remote session first.", Toast.LENGTH_SHORT).show()
            return
        }
        if (panel != null) return
        launcher?.visibility = View.GONE

        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(4), dp(6), dp(4))
            setBackgroundColor(Color.rgb(12, 20, 35))
        }
        val input = EditText(activity).apply {
            hint = "Type directly on remote..."
            setSingleLine(true)
            textSize = 16f
            setTextColor(Color.WHITE)
            setHintTextColor(Color.LTGRAY)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            // Do not allow external apps to extract any text typed into the remote session.
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    if (resetting) return
                    val value = s?.toString() ?: ""
                    forwardDifference(lastText, value)
                    lastText = value
                }
            })
            setOnEditorActionListener { _, _, _ ->
                sendKey("Enter")
                resetEditor()
                true
            }
        }
        field = input
        bar.addView(input, LinearLayout.LayoutParams(0, dp(48), 1f))

        fun action(label: String, description: String, width: Int, handler: () -> Unit) {
            val button = Button(activity).apply {
                text = label
                contentDescription = description
                setAllCaps(false)
                textSize = 12f
                setOnClickListener { handler() }
            }
            bar.addView(button, LinearLayout.LayoutParams(dp(width), dp(48)))
        }
        action("⌫", "Backspace on remote computer", 48) {
            // IMEs do not emit a text change when deleting from an empty field.
            if (input.text.isNullOrEmpty()) sendKey("Backspace")
            else {
                val editable = input.text ?: return@action
                val end = editable.length
                val count = Character.charCount(Character.codePointBefore(editable, end))
                editable.delete(end - count, end)
            }
        }
        action("↵", "Enter on remote computer", 48) {
            sendKey("Enter")
            resetEditor()
        }
        action("Hide", "Hide Android keyboard", 58) { hideKeyboard() }

        panel = bar
        val params = FrameLayout.LayoutParams(-1, dp(60), Gravity.BOTTOM)
        root.addView(bar, params)
        bar.bringToFront()
        input.requestFocus()
        input.post {
            (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun resetEditor() {
        resetting = true
        field?.text?.clear()
        lastText = ""
        resetting = false
    }

    private fun forwardDifference(before: String, after: String) {
        if (!isTrustedViewer() || before == after) return
        // A single IME edit may replace a composed character or a suggested
        // word. Correct the remote text by deleting the changed suffix first.
        var prefix = 0
        while (prefix < before.length && prefix < after.length && before[prefix] == after[prefix]) prefix++
        // Do not split a UTF-16 surrogate pair.
        if (prefix > 0 && prefix < before.length && Character.isHighSurrogate(before[prefix - 1])) prefix--
        if (prefix > 0 && prefix < after.length && Character.isHighSurrogate(after[prefix - 1])) prefix--
        val removed = before.substring(prefix).codePointCount(0, before.length - prefix)
        repeat(removed.coerceAtMost(1000)) { sendKey("Backspace") }
        val added = after.substring(prefix)
        if (added.isNotEmpty()) sendText(added)
    }

    private fun execute(script: String) {
        if (!isTrustedViewer()) return
        viewer.evaluateJavascript(
            """(function(){if(typeof currentSession==='undefined'||!currentSession||typeof sendInput!=='function')return; $script})()""",
            null
        )
    }

    private fun sendText(text: String) {
        if (text.isEmpty()) return
        execute("sendInput('text_input',{text:${JSONObject.quote(text)}},true);")
    }

    private fun sendKey(name: String) {
        if (name != "Enter" && name != "Backspace") return
        val quoted = JSONObject.quote(name)
        execute(
            """sendInput('key_down',{code:$quoted,key:$quoted,repeat:false,ctrl:false,alt:false,shift:false,meta:false},true);
            sendInput('key_up',{code:$quoted,key:$quoted,ctrl:false,alt:false,shift:false,meta:false},true);"""
        )
    }

    fun hideKeyboard() {
        field?.let {
            (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(it.windowToken, 0)
        }
        panel?.let { root.removeView(it) }
        panel = null
        field = null
        lastText = ""
        launcher?.visibility = View.VISIBLE
    }

    fun dispose() {
        hideKeyboard()
        launcher?.let { root.removeView(it) }
        launcher = null
    }
}
