import { useEffect, useRef, useState } from 'react'
import './ProductionOrganisationWriteThrough.css'

const API_BASE = window.__HI5_API_BASE__
const SAVE_EVENT = 'hi5-organisation-save-request'

const collections = [
  { id: 'departments', storageKey: 'hi5central-organisation-departments-v1' },
  { id: 'teams', storageKey: 'hi5central-organisation-teams-v1' },
  { id: 'people', storageKey: 'hi5central-organisation-people-v1' },
]

function mergeRecords(server = [], changes = []) {
  const changesById = new Map(changes.filter((item) => item?.id).map((item) => [item.id, item]))
  const merged = server.map((item) => changesById.get(item.id) || item)
  const serverIds = new Set(server.map((item) => item.id))
  for (const item of changes) {
    if (item?.id && !serverIds.has(item.id)) merged.push(item)
  }
  return merged
}

function cacheSnapshot(snapshot = {}) {
  for (const { id, storageKey } of collections) {
    if (Array.isArray(snapshot[id])) {
      window.localStorage.setItem(storageKey, JSON.stringify(snapshot[id]))
    }
  }
}

function publishSnapshot(snapshot = {}) {
  cacheSnapshot(snapshot)
  window.dispatchEvent(new CustomEvent('hi5-organisation-hydrated', { detail: snapshot }))
}

async function fetchOrganisation() {
  const response = await fetch(`${API_BASE}/api/v1/organisation`, {
    credentials: 'include',
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error=new Error(payload.error || 'Could not load the production Organisation directory.')
    if(response.status===401)error.code='AUTHENTICATION_PENDING'
    throw error
  }
  return payload
}

async function upsertEntry(collection, item) {
  const response = await fetch(`${API_BASE}/api/v1/organisation/${encodeURIComponent(collection)}/upsert`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Could not save ${collection}.`)
  return payload
}

export function ProductionOrganisationWriteThrough() {
  const [phase, setPhase] = useState('idle')
  const [notice, setNotice] = useState(null)
  const activeRef = useRef(true)
  const saveQueueRef = useRef(Promise.resolve())

  useEffect(() => {
    activeRef.current = true

    function hydrateWhenSignedIn(){
      // This companion component mounts before the workspace login. Expected
      // 401 responses must not display a spurious 'Authentication required'
      // toast while the user is still being redirected to central sign-in.
      fetchOrganisation()
        .then((snapshot) => {
          if (activeRef.current) {
            setNotice(null)
            publishSnapshot(snapshot)
          }
        })
        .catch((error) => {
          if (!activeRef.current || error.code === 'AUTHENTICATION_PENDING') return
          console.error('Production Organisation hydration failed.', error)
          setNotice({ type: 'error', message: error?.message || 'Could not connect the People directory to PostgreSQL.' })
        })
    }
    try {
      const cached=JSON.parse(window.localStorage.getItem('hi5central-production-session-v1')||'null')
      if(cached?.source==='production')hydrateWhenSignedIn()
    }catch { /* The current server session is authoritative. */ }
    window.addEventListener('hi5-production-session-ready',hydrateWhenSignedIn)

    function handleSaveRequest(event) {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {}
      const requestedChanges = detail.changes && typeof detail.changes === 'object' ? detail.changes : {}
      const hasChanges = collections.some(({ id }) => Array.isArray(requestedChanges[id]) && requestedChanges[id].length)
      if (!hasChanges) return

      saveQueueRef.current = saveQueueRef.current
        .catch(() => null)
        .then(async () => {
          if (!activeRef.current) return
          setPhase('saving')
          setNotice(null)
          try {
            let authoritative = await fetchOrganisation()

            for (const { id } of collections) {
              const changes = Array.isArray(requestedChanges[id]) ? requestedChanges[id] : []
              if (!changes.length) continue
              for (const entry of changes) {
                authoritative = await upsertEntry(id, entry)
              }
            }

            if (!activeRef.current) return
            publishSnapshot(authoritative)
            setNotice({
              type: 'success',
              message: detail.message || 'Organisation changes saved to PostgreSQL.',
            })
          } catch (error) {
            console.error('Production Organisation write-through failed.', error)
            // Undo optimistic local changes when the API denies or rejects an edit.
            try { publishSnapshot(await fetchOrganisation()) } catch { /* retain error notice */ }
            if (!activeRef.current) return
            setNotice({
              type: 'error',
              message: error?.message || 'Organisation changes could not be saved.',
            })
          } finally {
            if (activeRef.current) setPhase('idle')
          }
        })
    }

    window.addEventListener(SAVE_EVENT, handleSaveRequest)
    return () => {
      activeRef.current = false
      window.removeEventListener(SAVE_EVENT, handleSaveRequest)
      window.removeEventListener('hi5-production-session-ready',hydrateWhenSignedIn)
    }
  }, [])

  return (
    <>
      {phase === 'saving' ? (
        <div className="production-org-write-overlay" role="status" aria-live="polite">
          <div>
            <span className="production-org-write-spinner" aria-hidden="true" />
            <strong>Saving organisation changes…</strong>
            <small>Writing People, Teams and Departments to PostgreSQL.</small>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className={`production-org-write-notice ${notice.type === 'error' ? 'error' : 'success'}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      ) : null}
    </>
  )
}