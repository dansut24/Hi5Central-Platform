import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity, ArrowUpRight, Check, ChevronRight, Database, GitBranch, Link2,
  Monitor, Plus, RefreshCw, Search, Server, SlidersHorizontal, X,
} from 'lucide-react'
import { deploymentConfig } from '../lib/deploymentConfig.js'
import { resolveTenantSurface } from '../lib/tenantSurface.js'
import './ProductionCmdb.css'

const API_BASE = window.__HI5_API_BASE__
const TYPES = ['Workstation', 'Laptop', 'Server', 'Virtual machine', 'Network', 'Printer', 'Application', 'Service', 'Cloud resource', 'Other']
const STATUSES = ['Active', 'In maintenance', 'Planned', 'Retired']
const CRITICALITIES = ['Low', 'Medium', 'High', 'Critical']
const RELATIONSHIPS = ['Depends on', 'Hosted on', 'Connected to', 'Related to']

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Could not complete the CMDB request.')
  return payload
}

function blank() {
  return {
    name: '', ciType: 'Workstation', status: 'Active', criticality: 'Medium',
    environment: 'Production', service: '', ownerName: '', ownerTeam: '',
    site: '', manufacturer: '', model: '', serialNumber: '', ipAddress: '',
    linkedDeviceId: '', description: '', tagsText: '',
  }
}

function fromItem(item) {
  return { ...blank(), ...item, tagsText: (item?.tags || []).join(', ') }
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(date)
}

function rmmDeviceHref(deviceId) {
  const encoded = encodeURIComponent(String(deviceId || '').toUpperCase())
  const surface = resolveTenantSurface()
  const deployment = deploymentConfig()
  if (deployment.tenancyMode === 'single') {
    return deployment.rmmUrl ? `${deployment.rmmUrl}/devices/${encoded}` : `/rmm/devices/${encoded}`
  }
  if (surface?.canonical && surface?.tenantSlug) {
    return `https://${surface.tenantSlug}-rmm.${deployment.rootDomain}/devices/${encoded}`
  }
  return `/rmm/devices/${encoded}`
}

function recordHref(reference) {
  const ref = String(reference || '').toUpperCase()
  const section = ref.startsWith('INC-') ? 'incidents' : ref.startsWith('PRB-') ? 'problems'
    : ref.startsWith('CHG-') ? 'changes' : ref.startsWith('REQ-') || ref.startsWith('SR-') ? 'requests' : 'tickets'
  return '/' + section + '/' + encodeURIComponent(ref)
}

function Field({ label, field, draft, setDraft, type = 'text', placeholder = '' }) {
  return (
    <label className="pcm-field">
      <span>{label}</span>
      <input
        value={draft[field] || ''}
        type={type}
        placeholder={placeholder}
        onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
      />
    </label>
  )
}

export function ProductionCmdb() {
  const [active, setActive] = useState(() => /^\/cmdb(?:\/|$)/.test(window.location.pathname))
  const [target, setTarget] = useState(null)
  const [items, setItems] = useState([])
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(blank)
  const [recordReference, setRecordReference] = useState('')
  const [relatedId, setRelatedId] = useState('')
  const [relatedType, setRelatedType] = useState('Depends on')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const sync = () => setActive(/^\/cmdb(?:\/|$)/.test(window.location.pathname))
    window.addEventListener('popstate', sync)
    window.addEventListener('hi5-routechange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hi5-routechange', sync)
    }
  }, [])

  useEffect(() => {
    if (!active) { setTarget(null); return undefined }
    let mounted = null
    const attach = () => {
      const element = document.querySelector('.content-frame')
      if (!(element instanceof HTMLElement)) return false
      mounted = element
      mounted.classList.add('production-cmdb-mounted')
      setTarget(element)
      return true
    }
    if (attach()) return () => mounted?.classList.remove('production-cmdb-mounted')
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { subtree: true, childList: true })
    return () => { observer.disconnect(); mounted?.classList.remove('production-cmdb-mounted') }
  }, [active])

  async function reload(preferred) {
    setLoading(true)
    try {
      setError('')
      const payload = await request('/api/v1/cmdb')
      const nextItems = payload.items || []
      setItems(nextItems)
      const routeKey = decodeURIComponent(window.location.pathname.split('/')[2] || '')
      const key = preferred || routeKey || selected?.reference
      const match = nextItems.find((item) => item.reference === key || item.id.toLowerCase() === String(key).toLowerCase())
      const first = match || (!key ? nextItems[0] : null)
      if (first) setSelected(await request('/api/v1/cmdb/' + encodeURIComponent(first.reference)))
      else setSelected(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (active) reload()
  }, [active])

  const types = useMemo(() => [...new Set(items.map((item) => item.ciType).filter(Boolean))].sort(), [items])
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    return items.filter((item) => {
      if (statusFilter !== 'All' && item.status !== statusFilter) return false
      if (typeFilter !== 'All' && item.ciType !== typeFilter) return false
      return !search || [
        item.reference, item.name, item.serialNumber, item.service, item.ownerName, item.site,
      ].some((value) => String(value || '').toLowerCase().includes(search))
    })
  }, [items, query, statusFilter, typeFilter])

  function routeTo(item) {
    if (!item) return
    window.history.replaceState({}, '', '/cmdb/' + encodeURIComponent(item.reference))
    window.dispatchEvent(new Event('hi5-routechange'))
  }

  async function choose(item) {
    setEditing(false)
    setError('')
    routeTo(item)
    try {
      setSelected(await request('/api/v1/cmdb/' + encodeURIComponent(item.reference)))
    } catch (err) { setError(err.message) }
  }

  function startCreate() {
    setSelected(null)
    setDraft(blank())
    setEditing(true)
    setError('')
  }

  function startEdit() {
    setDraft(fromItem(selected))
    setEditing(true)
    setError('')
  }

  async function save(event) {
    event.preventDefault()
    if (draft.name.trim().length < 2) { setError('Enter a CI name.'); return }
    setBusy(true)
    setError('')
    try {
      const body = { ...draft, tags: draft.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean) }
      delete body.tagsText
      const saved = await request(
        selected ? '/api/v1/cmdb/' + encodeURIComponent(selected.reference) : '/api/v1/cmdb',
        { method: selected ? 'PATCH' : 'POST', body: JSON.stringify(body) },
      )
      setEditing(false)
      routeTo(saved)
      await reload(saved.reference)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function writeDetail(suffix, method, data) {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const next = await request('/api/v1/cmdb/' + encodeURIComponent(selected.reference) + suffix, {
        method, ...(data ? { body: JSON.stringify(data) } : {}),
      })
      setSelected(next)
      if (suffix === '/records') setRecordReference('')
      if (suffix === '/relationships') setRelatedId('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  function cancel() {
    setEditing(false)
    setError('')
    if (!selected) reload()
  }

  const typeOptions = [...new Set([...TYPES, draft.ciType].filter(Boolean))]
  const visibleCount = items.filter((item) => item.status === 'Active').length

  if (!active || !target) return null

  return createPortal(
    <div className="production-cmdb-root">
      <header className="pcm-masthead">
        <div className="pcm-masthead-title">
          <div className="pcm-mark"><Database size={20} /></div>
          <div><span>Knowledge & Data</span><h1>Configuration Management</h1><p>Assets, services, ownership and dependencies in one place.</p></div>
        </div>
        <div className="pcm-header-actions">
          <button className="pcm-button" type="button" onClick={() => reload()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
          <button className="pcm-button primary" type="button" onClick={startCreate}><Plus size={16} /> New CI</button>
        </div>
      </header>

      <div className="pcm-stats">
        <div><small>Total CIs</small><strong>{items.length}</strong></div>
        <div><small>Active</small><strong>{visibleCount}</strong></div>
        <div><small>In maintenance</small><strong>{items.filter((item) => item.status === 'In maintenance').length}</strong></div>
        <div><small>High / Critical</small><strong>{items.filter((item) => ['High', 'Critical'].includes(item.criticality)).length}</strong></div>
      </div>

      {error ? <div className="pcm-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div> : null}

      <div className="pcm-workspace">
        <aside className="pcm-inventory">
          <div className="pcm-inventory-head"><strong>Configuration items</strong><small>{filtered.length} shown</small></div>
          <div className="pcm-controls">
            <label className="pcm-search"><Search size={15} /><input aria-label="Search configuration items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, reference, owner…" /></label>
            <div className="pcm-filters">
              <label><SlidersHorizontal size={14} /><select aria-label="Filter by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option>All</option>{types.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
            </div>
          </div>
          <div className="pcm-list">
            {filtered.map((item) => (
              <button type="button" key={item.id} className={selected?.id === item.id && !editing ? 'active' : ''} onClick={() => choose(item)}>
                <span className="pcm-list-icon">{item.ciType === 'Workstation' || item.ciType === 'Laptop' ? <Monitor size={18} /> : <Server size={18} />}</span>
                <span className="pcm-list-copy"><small>{item.reference} · {item.ciType}</small><strong>{item.name}</strong><em>{item.ownerName || item.service || 'Unassigned'}</em></span>
                <span className={'pcm-status ' + item.status.toLowerCase().replace(/\W+/g, '-')}>{item.status}</span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!filtered.length && <div className="pcm-empty"><Database size={27} /><strong>No matching configuration items</strong><p>{items.length ? 'Try a different filter.' : 'Create your first CI to build the CMDB.'}</p></div>}
          </div>
        </aside>

        <main className="pcm-main">
          {editing ? (
            <form className="pcm-editor" onSubmit={save}>
              <header className="pcm-detail-head">
                <div><span className="pcm-eyebrow">{selected?.reference || 'New configuration item'}</span><h2>{selected ? 'Edit configuration item' : 'Add configuration item'}</h2></div>
                <div className="pcm-header-actions"><button type="button" className="pcm-button" onClick={cancel}>Cancel</button><button type="submit" className="pcm-button primary" disabled={busy}><Check size={16} /> {busy ? 'Saving…' : 'Save CI'}</button></div>
              </header>
              <section className="pcm-panel">
                <h3>Configuration item</h3>
                <div className="pcm-form-grid">
                  <Field label="Name" field="name" draft={draft} setDraft={setDraft} placeholder="e.g. Finance-Laptop-01" />
                  <label className="pcm-field"><span>CI type</span><select value={draft.ciType} onChange={(event) => setDraft((d) => ({ ...d, ciType: event.target.value }))}>{typeOptions.map((type) => <option key={type}>{type}</option>)}</select></label>
                  <label className="pcm-field"><span>Status</span><select value={draft.status} onChange={(event) => setDraft((d) => ({ ...d, status: event.target.value }))}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
                  <label className="pcm-field"><span>Criticality</span><select value={draft.criticality} onChange={(event) => setDraft((d) => ({ ...d, criticality: event.target.value }))}>{CRITICALITIES.map((level) => <option key={level}>{level}</option>)}</select></label>
                  <Field label="Environment" field="environment" draft={draft} setDraft={setDraft} />
                  <Field label="Service" field="service" draft={draft} setDraft={setDraft} />
                  <Field label="Owner" field="ownerName" draft={draft} setDraft={setDraft} />
                  <Field label="Owner team" field="ownerTeam" draft={draft} setDraft={setDraft} />
                  <Field label="Site" field="site" draft={draft} setDraft={setDraft} />
                  <Field label="Manufacturer" field="manufacturer" draft={draft} setDraft={setDraft} />
                  <Field label="Model" field="model" draft={draft} setDraft={setDraft} />
                  <Field label="Serial number" field="serialNumber" draft={draft} setDraft={setDraft} />
                  <Field label="IP address" field="ipAddress" draft={draft} setDraft={setDraft} />
                  <Field label="RMM device ID" field="linkedDeviceId" draft={draft} setDraft={setDraft} placeholder="Optional: device reference" />
                  <Field label="Tags (comma separated)" field="tagsText" draft={draft} setDraft={setDraft} />
                </div>
                <label className="pcm-field"><span>Description / notes</span><textarea rows={5} value={draft.description} onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))} /></label>
              </section>
            </form>
          ) : selected ? (
            <article className="pcm-detail">
              <header className="pcm-detail-head">
                <div><span className="pcm-eyebrow">{selected.reference} · {selected.ciType}</span><h2>{selected.name}</h2><p>{selected.description || 'No description supplied.'}</p></div>
                <div className="pcm-header-actions"><span className={'pcm-status ' + selected.status.toLowerCase().replace(/\W+/g, '-')}>{selected.status}</span><button className="pcm-button primary" onClick={startEdit}>Edit CI</button></div>
              </header>
              <div className="pcm-detail-grid">
                <section className="pcm-panel">
                  <h3><Activity size={16} /> Overview</h3>
                  <div className="pcm-facts">
                    {[
                      ['Status', selected.status], ['Criticality', selected.criticality],
                      ['Environment', selected.environment], ['Service', selected.service],
                      ['Owner', selected.ownerName], ['Team', selected.ownerTeam],
                      ['Site', selected.site], ['Last updated', formatDate(selected.updatedAt)],
                    ].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value || '—'}</strong></div>)}
                  </div>
                </section>
                <section className="pcm-panel">
                  <h3><Server size={16} /> Technical details</h3>
                  <div className="pcm-facts">
                    {[
                      ['Manufacturer', selected.manufacturer], ['Model', selected.model],
                      ['Serial number', selected.serialNumber], ['IP address', selected.ipAddress],
                      ['RMM device ID', selected.linkedDeviceId],
                    ].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value || '—'}</strong></div>)}
                  </div>
                  {selected.linkedDeviceId ? <div className="pcm-device-action">
                    <a className="pcm-button" href={rmmDeviceHref(selected.linkedDeviceId)} target="_blank" rel="noopener noreferrer"><Monitor size={15} /> Open device in RMM <ArrowUpRight size={14} /></a>
                  </div> : null}
                  {selected.tags?.length ? <div className="pcm-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
                </section>
                <section className="pcm-panel">
                  <h3><GitBranch size={16} /> Relationships</h3>
                  <div className="pcm-linked-list">
                    {selected.relationships?.length ? selected.relationships.map((edge) =>
                      <div key={edge.id}>
                        <span><small>{edge.direction === 'outbound' ? edge.type : 'Referenced by · ' + edge.type}</small><button type="button" onClick={() => { const item = items.find((it) => it.id === edge.itemId); if (item) choose(item) }}>{edge.reference} · {edge.name}</button></span>
                        <button type="button" className="pcm-remove" disabled={busy} title="Remove relationship" onClick={() => writeDetail('/relationships/' + edge.id, 'DELETE')}><X size={15} /></button>
                      </div>,
                    ) : <p>No dependencies or related CIs yet.</p>}
                  </div>
                  <form className="pcm-link-form" onSubmit={(event) => { event.preventDefault(); if (relatedId) writeDetail('/relationships', 'POST', { targetId: relatedId, type: relatedType }) }}>
                    <select aria-label="Relationship type" value={relatedType} onChange={(event) => setRelatedType(event.target.value)}>{RELATIONSHIPS.map((type) => <option key={type}>{type}</option>)}</select>
                    <select aria-label="Related configuration item" value={relatedId} onChange={(event) => setRelatedId(event.target.value)}><option value="">Select another CI</option>{items.filter((item) => item.id !== selected.id).map((item) => <option key={item.id} value={item.id}>{item.reference} · {item.name}</option>)}</select>
                    <button className="pcm-button" disabled={busy || !relatedId}><Plus size={14} /> Link</button>
                  </form>
                </section>
                <section className="pcm-panel">
                  <h3><Link2 size={16} /> Linked service records</h3>
                  <div className="pcm-linked-list">
                    {selected.records?.length ? selected.records.map((record) =>
                      <div key={record.id}><a href={recordHref(record.reference)}>{record.reference} <ArrowUpRight size={13} /></a><button type="button" className="pcm-remove" disabled={busy} title="Remove record link" onClick={() => writeDetail('/records/' + record.id, 'DELETE')}><X size={15} /></button></div>,
                    ) : <p>No incidents, requests, problems or changes linked yet.</p>}
                  </div>
                  <form className="pcm-link-form" onSubmit={(event) => { event.preventDefault(); if (recordReference.trim()) writeDetail('/records', 'POST', { reference: recordReference.trim() }) }}>
                    <input aria-label="ITSM record reference" value={recordReference} onChange={(event) => setRecordReference(event.target.value)} placeholder="INC-00001, REQ-00001…" />
                    <button className="pcm-button" disabled={busy || !recordReference.trim()}><Plus size={14} /> Link</button>
                  </form>
                </section>
              </div>
            </article>
          ) : <div className="pcm-empty large"><Database size={42} /><strong>{loading ? 'Loading configuration items…' : 'No configuration item selected'}</strong><p>{loading ? 'Reading the CMDB.' : 'Select a CI from the list or create a new one.'}</p><button className="pcm-button primary" onClick={startCreate}><Plus size={15} /> New CI</button></div>}
        </main>
      </div>
    </div>, target,
  )
}
