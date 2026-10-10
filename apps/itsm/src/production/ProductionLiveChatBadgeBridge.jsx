import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowUpRight, Bell, Check, CheckCheck, ChevronDown, CircleDot, FilePlus2, Link2, Maximize2, MessageCircle, Minimize2, Paperclip, Send, WifiOff, X } from 'lucide-react'
import './ProductionLiveChatBadgeBridge.css'
import './ProductionFloatingTechnicianChat.css'

const API_BASE = window.__HI5_API_BASE__
const TAB_SELECTOR = '.workspace-tab-livechat, .workspace-tab[data-tab-module="livechat"]'

async function unreadCount() {
  const response = await fetch(`${API_BASE}/api/v1/live-chat/conversations`, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) return 0
  const payload = await response.json().catch(() => ({}))
  return (payload.items || []).reduce((total, item) => total + Number(item.unread || 0), 0)
}

function applyCount(count, { broadcast = true } = {}) {
  document.querySelectorAll(TAB_SELECTOR).forEach((node) => {
    if (!(node instanceof HTMLElement)) return
    node.dataset.hi5LiveUnread = count > 0 ? String(Math.min(99, count)) : ''
    node.classList.toggle('hi5-has-live-unread', count > 0)
    const legacy = node.querySelector('.live-chat-tab-notification')
    if (legacy instanceof HTMLElement) legacy.setAttribute('aria-hidden', 'true')
  })

  if (broadcast) {
    window.dispatchEvent(new CustomEvent('hi5-production-live-chat-count', {
      detail: { unread: count },
    }))
  }
}

export function ProductionLiveChatBadgeBridge() {
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const refresh = async () => {
      try {
        const count = await unreadCount()
        if (mountedRef.current) applyCount(count)
      } catch {
        if (mountedRef.current) applyCount(0)
      }
    }

    const handleServerCount = (event) => {
      const value = Number(event?.detail?.unread || 0)
      applyCount(Number.isFinite(value) ? value : 0, { broadcast: false })
    }

    // Hide historical local unread state immediately; the asynchronous
    // refresh below then paints only the PostgreSQL-backed unread count.
    applyCount(0)
    refresh()

    const observer = new MutationObserver(() => {
      document.querySelectorAll(TAB_SELECTOR).forEach((node) => {
        if (!(node instanceof HTMLElement)) return
        const legacy = node.querySelector('.live-chat-tab-notification')
        if (legacy instanceof HTMLElement) legacy.setAttribute('aria-hidden', 'true')
      })
    })
    observer.observe(document.body, { childList: true, subtree: true })

    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('visibilitychange', refresh)
    window.addEventListener('hi5-production-live-chat-count', handleServerCount)

    return () => {
      mountedRef.current = false
      observer.disconnect()
      window.clearInterval(timer)
      window.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('hi5-production-live-chat-count', handleServerCount)
    }
  }, [])

  return null
}

// This component is mounted alongside the authenticated ITSM shell, not inside
// any record. It therefore retains an open conversation/draft across SPA route
// changes while still using the same PostgreSQL conversations as the full inbox.
async function floatingChatApi(path, options = {}) {
  const response = await fetch((window.__HI5_API_BASE__ || '') + path, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Live Chat request failed.'), { status: response.status })
  return payload
}

function floatingClock(value) {
  const date = new Date(value || 0)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function recordOnCurrentPage() {
  const path = decodeURIComponent(window.location.pathname || '')
  const match = path.match(/(?:^|\/)((?:INC|REQ|CHG|TASK|PRB|SR)-[0-9]{1,12})(?:\/|$)/i)
  return match ? match[1].toUpperCase() : ''
}

function floatingNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try { new Notification(title, { body, tag: 'hi5central-floating-live-chat' }) } catch { /* unsupported browser */ }
}

export function ProductionFloatingTechnicianChat() {
  const [enabled, setEnabled] = useState(false)
  const [route, setRoute] = useState(() => window.location.pathname)
  const [expanded, setExpanded] = useState(false)
  const [section, setSection] = useState('inbox')
  const [selectedRef, setSelectedRef] = useState('')
  const [items, setItems] = useState([])
  const [detail, setDetail] = useState(null)
  const [unread, setUnread] = useState(0)
  const [drafts, setDrafts] = useState({})
  const [presence, setPresence] = useState({ status: 'Offline', desiredStatus: 'Offline' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('Active')
  const [linkMode, setLinkMode] = useState(false)
  const [linkRef, setLinkRef] = useState('')
  const [transferMode, setTransferMode] = useState(false)
  const [agents, setAgents] = useState([])
  const [canned, setCanned] = useState([])
  const [alerts, setAlerts] = useState(false)
  const [panelSize, setPanelSize] = useState('compact')
  const [ops, setOps] = useState(null)
  const messageListRef = useRef(null)
  const selectedRefRef = useRef('')
  const previousUnreadRef = useRef(null)
  const desiredStatusRef = useRef('Offline')
  const openRef = useRef(false)
  const availableRef = useRef(false)
  const alertsRef = useRef(false)

  useEffect(() => { selectedRefRef.current = selectedRef }, [selectedRef])
  useEffect(() => { desiredStatusRef.current = presence.desiredStatus }, [presence.desiredStatus])
  useEffect(() => { openRef.current = expanded }, [expanded])
  useEffect(() => { availableRef.current = enabled }, [enabled])
  useEffect(() => { alertsRef.current = alerts }, [alerts])

  useEffect(() => {
    const sync = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', sync)
    window.addEventListener('hi5-routechange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hi5-routechange', sync)
    }
  }, [])

  // Feature visibility is server-authoritative (UAT is off until staged).
  useEffect(() => {
    let mounted = true
    async function verify() {
      try {
        const result = await floatingChatApi('/api/v1/live-chat/feature-status')
        if (mounted) setEnabled(result.enabled === true)
      } catch {
        if (mounted) setEnabled(false)
      }
    }
    verify()
    window.addEventListener('focus', verify)
    return () => { mounted = false; window.removeEventListener('focus', verify) }
  }, [])

  // Reuse the existing server unread event from the full workspace badge bridge.
  useEffect(() => {
    const onCount = (event) => {
      const next = Math.max(0, Number(event.detail?.unread || 0))
      setUnread(next)
    }
    window.addEventListener('hi5-production-live-chat-count', onCount)
    return () => window.removeEventListener('hi5-production-live-chat-count', onCount)
  }, [])

  // Keep the technician Online when they move between incidents and tasks.
  useEffect(() => {
    if (!enabled) return undefined
    let mounted = true
    async function refresh(heartbeat = false) {
      try {
        const next = await floatingChatApi(heartbeat
          ? '/api/v1/live-chat/presence/heartbeat' : '/api/v1/live-chat/presence',
        heartbeat ? { method: 'POST' } : {})
        if (mounted) {
          setPresence(next)
          desiredStatusRef.current = next.desiredStatus
        }
      } catch (nextError) {
        if (mounted && nextError.status === 401) setEnabled(false)
      }
    }
    refresh()
    const timer = window.setInterval(() => {
      refresh(['Online', 'Away'].includes(desiredStatusRef.current))
    }, 25000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh(['Online', 'Away'].includes(desiredStatusRef.current))
    }
    const onOtherUpdate = () => refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('hi5-livechat-presence-updated', onOtherUpdate)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('hi5-livechat-presence-updated', onOtherUpdate)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return undefined
    let mounted = true
    async function poll() {
      try {
        const data = await floatingChatApi('/api/v1/live-chat/conversations')
        if (!mounted) return
        const rows = Array.isArray(data.items) ? data.items : []
        setItems(rows)
        const count = rows.reduce((sum, row) => sum + Number(row.unread || 0), 0)
        setUnread(count)
        if (alertsRef.current && previousUnreadRef.current !== null && count > previousUnreadRef.current) {
          const newMessage = rows.find((row) => row.unread)
          floatingNotify('New Hi5Central Live Chat', newMessage?.participant?.name || 'Customer message received')
        }
        previousUnreadRef.current = count
      } catch (nextError) {
        if (mounted && nextError.status === 401) setEnabled(false)
      }
    }
    poll()
    const timer = window.setInterval(poll, openRef.current ? 4500 : 7000)
    const onVisible = () => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { mounted = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !expanded || !selectedRef || section !== 'thread') return undefined
    let mounted = true
    async function load() {
      try {
        const [chat, operations] = await Promise.all([
          floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef)),
          floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/operations').catch(() => null),
        ])
        if (mounted) { setDetail(chat); setOps(operations) }
      } catch (nextError) {
        if (mounted) setError(nextError.message)
      }
    }
    load()
    const timer = window.setInterval(load, 4000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [enabled, expanded, selectedRef, section])

  useEffect(() => {
    const container = messageListRef.current
    if (container && section === 'thread') container.scrollTop = container.scrollHeight
  }, [detail?.messages?.length, selectedRef, section])

  useEffect(() => {
    if (!expanded) return undefined
    const onEscape = (event) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [expanded])

  const visibleItems = useMemo(() => items.filter((row) => filter === 'All'
    || (filter === 'Active' ? row.status !== 'Closed' : row.status === filter)), [items, filter])

  async function pick(item) {
    setError('')
    setDetail(null)
    setOps(null)
    setSelectedRef(item.reference)
    setSection('thread')
    setLinkMode(false)
    setTransferMode(false)
    setLinkRef(recordOnCurrentPage())
    try {
      await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(item.reference) + '/read', { method: 'POST' })
      window.dispatchEvent(new CustomEvent('hi5-production-live-chat-count', { detail: { unread: Math.max(0, unread - Number(item.unread || 0)) } }))
    } catch { /* reading is best-effort; the conversation will still open */ }
  }

  async function setAvailability(status) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const next = await floatingChatApi('/api/v1/live-chat/presence', { method: 'PATCH', body: JSON.stringify({ status }) })
      setPresence(next)
      desiredStatusRef.current = next.desiredStatus
      window.dispatchEvent(new CustomEvent('hi5-livechat-presence-updated'))
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function act(path, body) {
    if (!selectedRef || busy) return
    setBusy(true); setError('')
    try {
      const result = await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + path, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (result.reference) setDetail(result)
      const data = await floatingChatApi('/api/v1/live-chat/conversations')
      setItems(data.items || [])
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function reply(event) {
    event.preventDefault()
    const message = String(drafts[selectedRef] || '').trim()
    if (!message || busy) return
    setBusy(true); setError('')
    try {
      const result = await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/messages', {
        method: 'POST', body: JSON.stringify({ message }),
      })
      setDetail(result)
      setDrafts((previous) => ({ ...previous, [selectedRef]: '' }))
      const data = await floatingChatApi('/api/v1/live-chat/conversations')
      setItems(data.items || [])
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function linkRecord(event) {
    event.preventDefault()
    if (!linkRef.trim() || !selectedRef || busy) return
    setBusy(true); setError('')
    try {
      const next = await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/link-record', {
        method: 'POST', body: JSON.stringify({ recordReference: linkRef.trim().toUpperCase() }),
      })
      setOps(next)
      setLinkMode(false)
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function loadTransfer() {
    setTransferMode(true); setLinkMode(false)
    try {
      const result = await floatingChatApi('/api/v1/live-chat/agents')
      setAgents(result.items || [])
    } catch (nextError) { setError(nextError.message) }
  }

  async function transfer(personId) {
    if (!personId || !selectedRef || busy) return
    setBusy(true); setError('')
    try {
      await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/transfer', {
        method: 'POST', body: JSON.stringify({ personId }),
      })
      setTransferMode(false)
      const chat = await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef))
      setDetail(chat)
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function attach(file) {
    if (!file || !selectedRef || busy) return
    if (file.size > 8 * 1024 * 1024) { setError('Choose a file smaller than 8 MB.'); return }
    setBusy(true); setError('')
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('Could not read the attachment.'))
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
        reader.readAsDataURL(file)
      })
      await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/attachments', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type: file.type || 'application/octet-stream', dataBase64 }),
      })
      setOps(await floatingChatApi('/api/v1/live-chat/conversations/' + encodeURIComponent(selectedRef) + '/operations'))
    } catch (nextError) { setError(nextError.message) }
    finally { setBusy(false) }
  }

  async function loadCanned() {
    if (canned.length) return
    try {
      const result = await floatingChatApi('/api/v1/live-chat/canned-responses')
      setCanned((result.items || []).filter((item) => item.active))
    } catch { /* quick replies are optional */ }
  }

  async function enableAlerts() {
    if (!('Notification' in window)) { setError('Browser notifications are unavailable here.'); return }
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission() : Notification.permission
    if (permission === 'granted') setAlerts(true)
    else setError('Allow notifications in your browser to enable chat alerts.')
  }

  const hiddenOnFullInbox = route === '/live-chat'
  if (!enabled || hiddenOnFullInbox) return null

  return createPortal(
    <div className="hi5-floating-chat-root" data-hi5-floating-chat="true">
      {expanded ? <section className={'hi5-floating-chat-panel ' + (panelSize === 'large' ? 'is-large' : '')}
        role="dialog" aria-label="Technician Live Chat" aria-modal="false">
        <header className="hi5-floating-chat-header">
          <div className="hi5-floating-chat-heading">
            <MessageCircle size={18} />
            <span><strong>Live Chat</strong><small>{presence.status === 'Online' ? 'Available' : presence.status} · {items.filter((item) => item.status !== 'Closed').length} active</small></span>
          </div>
          <div className="hi5-floating-chat-header-actions">
            <button type="button" title="Open full Live Chat inbox" aria-label="Open full inbox" onClick={() => { window.location.assign('/live-chat') }}><ArrowUpRight size={17} /></button>
            <button type="button" title={panelSize === 'large' ? 'Shrink messenger' : 'Expand messenger'} aria-label="Resize messenger"
              onClick={() => setPanelSize((size) => size === 'large' ? 'compact' : 'large')}>
              {panelSize === 'large' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" title="Minimise chat" aria-label="Minimise messenger" onClick={() => setExpanded(false)}><X size={17} /></button>
          </div>
        </header>

        <div className="hi5-floating-chat-presence">
          <span className={'hi5-floating-chat-presence-dot is-' + String(presence.status || 'Offline').toLowerCase()} />
          <label htmlFor="hi5-floating-presence">My availability</label>
          <select id="hi5-floating-presence" value={presence.desiredStatus || 'Offline'} disabled={busy} onChange={(event) => setAvailability(event.target.value)}>
            <option value="Online">Available</option><option value="Away">Away</option><option value="Offline">Offline</option>
          </select>
          <button type="button" title={alerts ? 'Alerts enabled' : 'Enable desktop alerts'} aria-label="Enable chat notifications"
            onClick={enableAlerts} disabled={alerts}><Bell size={16} />{alerts ? <Check size={11} /> : null}</button>
        </div>

        {error ? <div role="alert" className="hi5-floating-chat-error">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div> : null}

        {section === 'inbox' ? <>
          <div className="hi5-floating-chat-tabs">
            {['Active', 'Waiting', 'Open', 'All'].map((item) => <button type="button" key={item}
              aria-pressed={filter === item} className={filter === item ? 'selected' : ''}
              onClick={() => setFilter(item)}>{item}</button>)}
          </div>
          <div className="hi5-floating-chat-list">
            {visibleItems.map((item) => <button key={item.reference} type="button" className="hi5-floating-chat-list-item"
              onClick={() => pick(item)}>
              <span className="hi5-floating-chat-avatar">{String(item.participant?.name || '?').charAt(0).toUpperCase()}</span>
              <span className="hi5-floating-chat-item-copy">
                <span><strong>{item.participant?.name || 'Requester'}</strong><small>{floatingClock(item.updatedAt)}</small></span>
                <b>{item.subject || item.reference}</b>
                <small>{item.reference} · {item.status}{item.assignedTo ? ' · ' + item.assignedTo : ''}</small>
                <em>{item.lastMessage || 'Conversation started'}</em>
              </span>
              {item.unread ? <i className="hi5-floating-chat-count">{item.unread > 99 ? '99+' : item.unread}</i> : null}
            </button>)}
            {!visibleItems.length ? <div className="hi5-floating-chat-empty"><MessageCircle size={28}/><strong>No conversations</strong><span>Incoming requester messages will appear here.</span></div> : null}
          </div>
        </> : <>
          <div className="hi5-floating-chat-thread-top">
            <button type="button" aria-label="Back to chat list" onClick={() => { setSection('inbox'); setLinkMode(false); setTransferMode(false) }}><ArrowLeft size={18}/></button>
            <span><strong>{detail?.participant?.name || 'Conversation'}</strong><small>{selectedRef} · {detail?.status || 'Loading…'}</small></span>
            {detail?.status === 'Waiting' ? <button type="button" disabled={busy} onClick={() => act('/claim')} className="is-primary">Claim</button> : null}
            {detail?.status === 'Closed' ? <button type="button" disabled={busy} onClick={() => act('/state', { status: 'Open' })}>Reopen</button>
              : <button type="button" disabled={busy} onClick={() => act('/state', { status: 'Closed' })}>Close</button>}
          </div>
          <div className="hi5-floating-chat-tools">
            <button type="button" onClick={() => { setLinkMode((value) => !value); setTransferMode(false); setLinkRef(recordOnCurrentPage()) }} title="Link chat to a record"><Link2 size={14}/> Link record</button>
            <button type="button" onClick={loadTransfer} title="Transfer conversation"><ChevronDown size={14}/> Transfer</button>
            {ops?.linkedRecord?.reference ? <span className="hi5-floating-chat-linked">{ops.linkedRecord.reference}</span> : null}
          </div>
          {linkMode ? <form onSubmit={linkRecord} className="hi5-floating-chat-inline-form">
            <input aria-label="Incident, request or task reference" value={linkRef}
              onChange={(event) => setLinkRef(event.target.value)} placeholder="INC-00001 / REQ-00001" />
            <button type="submit" disabled={busy || !linkRef.trim()}>Link</button>
          </form> : null}
          {transferMode ? <div className="hi5-floating-chat-inline-form">
            <select defaultValue="" aria-label="Choose technician" onChange={(event) => { if (event.target.value) transfer(event.target.value) }}>
              <option value="">Choose technician…</option>
              {agents.map((agent) => <option key={agent.personId} value={agent.personId}>{agent.name} · {agent.presence || 'Offline'}</option>)}
            </select>
            <button type="button" onClick={() => setTransferMode(false)}>Cancel</button>
          </div> : null}
          <div className="hi5-floating-chat-messages" ref={messageListRef} aria-label="Conversation messages" aria-live="polite">
            {(detail?.messages || []).map((message) => <div key={message.id} className={'hi5-floating-chat-message is-' + (message.sender || 'system')}>
              <p>{message.text}</p><small>{message.senderName ? message.senderName + ' · ' : ''}{floatingClock(message.createdAt)}{message.sender === 'agent' ? <CheckCheck size={12}/> : null}</small>
            </div>)}
            {!detail ? <div className="hi5-floating-chat-empty">Loading conversation…</div> : null}
          </div>
          <form className="hi5-floating-chat-composer" onSubmit={reply}>
            <div className="hi5-floating-chat-compose-tools">
              <label title="Attach a file"><Paperclip size={16}/><input type="file"
                accept="image/*,.pdf,.txt,.csv,.docx,.xlsx" disabled={busy}
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; attach(file) }} /></label>
              <select title="Quick reply" aria-label="Insert canned reply" defaultValue=""
                onFocus={loadCanned} onChange={(event) => {
                  const selected = canned.find((item) => item.id === event.target.value)
                  if (selected) setDrafts((current) => ({ ...current, [selectedRef]: selected.body }))
                  event.target.value = ''
                }}>
                <option value="">Quick reply…</option>
                {canned.map((item) => <option key={item.id} value={item.id}>{item.title || item.shortcut}</option>)}
              </select>
              {ops?.attachments?.length ? <small>{ops.attachments.length} attachment(s)</small> : null}
            </div>
            <div className="hi5-floating-chat-compose-row">
              <textarea aria-label="Write chat reply" rows={2} placeholder={detail?.status === 'Closed' ? 'Reopen before replying' : 'Reply to requester…'}
                disabled={busy || detail?.status === 'Closed'} value={drafts[selectedRef] || ''}
                onChange={(event) => setDrafts((current) => ({ ...current, [selectedRef]: event.target.value }))} />
              <button type="submit" title="Send reply" aria-label="Send reply" disabled={busy || !String(drafts[selectedRef] || '').trim() || detail?.status === 'Closed'}><Send size={17}/></button>
            </div>
          </form>
        </>}
      </section> : null}
      <button type="button" className={'hi5-floating-chat-launcher' + (expanded ? ' is-open' : '')}
        aria-expanded={expanded} aria-label={expanded ? 'Minimise Live Chat messenger' : 'Open Live Chat messenger'}
        onClick={() => { setExpanded((current) => !current); setError('') }}
        title={unread ? unread + ' unread Live Chat messages' : 'Open Live Chat'}>
        {expanded ? <X size={22}/> : <MessageCircle size={23}/>}
        {!expanded && unread > 0 ? <span className="hi5-floating-chat-count">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
    </div>,
    document.body,
  )
}
