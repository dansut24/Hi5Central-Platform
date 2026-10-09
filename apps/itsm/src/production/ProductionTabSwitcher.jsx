import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListFilter, Search, X } from 'lucide-react'

/**
 * Searchable desktop companion to the native ITSM tab list.
 * Kept separate from the tab engine so record routing, protected pinned tabs,
 * right-click actions and mobile navigation remain authoritative.
 */
export function ProductionTabSwitcher({
  tabs,
  activeTabKey,
  onActivate,
  onClose,
  onCloseGroup,
  onCloseOthers,
  onCloseAll,
}) {
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedKeys, setSelectedKeys] = useState([])
  const [recentKeys, setRecentKeys] = useState(() => [activeTabKey])
  const [position, setPosition] = useState({ left: 12, top: 68 })
  const [palette, setPalette] = useState({})

  useEffect(() => {
    setRecentKeys((previous) => [activeTabKey, ...previous.filter((key) => key !== activeTabKey)].slice(0, 100))
  }, [activeTabKey])

  useEffect(() => {
    const existing = new Set(tabs.map((tab) => tab.key))
    setSelectedKeys((current) => current.filter((key) => existing.has(key)))
  }, [tabs])

  useEffect(() => {
    if (!open) return undefined
    inputRef.current?.focus()

    function onPointerDown(event) {
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    function onResize() { setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const ranked = useMemo(() => {
    const recentPositions = new Map(recentKeys.map((key, index) => [key, index]))
    const needle = query.trim().toLocaleLowerCase()
    return tabs
      .filter((tab) => !needle || [tab.title, tab.key, tab.viewId, tab.recordId].some(
        (value) => String(value || '').toLocaleLowerCase().includes(needle),
      ))
      .sort((left, right) => (
        (recentPositions.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (recentPositions.get(right.key) ?? Number.MAX_SAFE_INTEGER)
      ))
  }, [tabs, query, recentKeys])

  const selectedClosable = selectedKeys.filter((key) => tabs.some((tab) => tab.key === key && !tab.pinned))
  const canCloseOthers = tabs.some((tab) => !tab.pinned && tab.key !== activeTabKey)
  const canCloseAll = tabs.some((tab) => !tab.pinned)

  function toggle() {
    if (open) { setOpen(false); return }
    const bounds = triggerRef.current?.getBoundingClientRect()
    const width = Math.min(370, window.innerWidth - 24)
    setPosition({
      left: Math.max(12, Math.min((bounds?.right || width) - width, window.innerWidth - width - 12)),
      top: Math.max(8, Math.min((bounds?.bottom || 54) + 9, window.innerHeight - 170)),
    })
    // The workspace's colour tokens are defined on .app-shell. This popup
    // portals to document.body to avoid being clipped by the tab list, so it
    // must copy the current theme and accent values explicitly.
    if (triggerRef.current) {
      const computed = getComputedStyle(triggerRef.current)
      const nextPalette = {}
      for (const name of ['--surface', '--surface-soft', '--ink', '--muted', '--line', '--accent-rgb', '--accent-ink']) {
        nextPalette[name] = computed.getPropertyValue(name).trim()
      }
      setPalette(nextPalette)
    }
    setQuery('')
    setSelectedKeys([])
    setOpen(true)
  }

  function selectTab(tab) {
    setOpen(false)
    onActivate(tab)
  }

  function toggleSelected(key) {
    setSelectedKeys((previous) => previous.includes(key)
      ? previous.filter((value) => value !== key)
      : [...previous, key])
  }

  function closeSelected() {
    if (!selectedClosable.length) return
    onCloseGroup(selectedClosable, activeTabKey)
    setSelectedKeys([])
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Find an open tab, ${tabs.length} tabs open`}
        className={`tab-switcher-trigger${open ? ' is-open' : ''}`}
        onClick={toggle}
        ref={triggerRef}
        title="Find and manage open tabs"
        type="button"
      >
        <ListFilter size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          aria-label="Find and manage open workspace tabs"
          className="hi5-tab-switcher-popover"
          ref={panelRef}
          role="dialog"
          style={{ left: position.left, top: position.top, ...palette }}
        >
          <div className="hi5-tab-switcher-heading">
            <div>
              <strong>Open tabs</strong>
              <small>{tabs.length} open · Recently used first</small>
            </div>
            <button aria-label="Close tab switcher" className="hi5-tab-switcher-icon" onClick={() => setOpen(false)} type="button">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <label className="hi5-tab-switcher-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search open tabs"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tabs or record references..."
              ref={inputRef}
              type="search"
              value={query}
            />
          </label>
          <div className="hi5-tab-switcher-results" role="list">
            {ranked.length === 0 ? (
              <p className="hi5-tab-switcher-empty">No matching open tabs.</p>
            ) : ranked.map((tab) => (
              <div className={`hi5-tab-switcher-row${tab.key === activeTabKey ? ' is-current' : ''}`} key={tab.key} role="listitem">
                <button
                  aria-label={`Switch to ${tab.title}`}
                  className="hi5-tab-switcher-open"
                  onClick={() => selectTab(tab)}
                  title={tab.title}
                  type="button"
                >
                  <span className="hi5-tab-switcher-name">{tab.title}</span>
                  <small>{tab.key === activeTabKey ? 'Current' : (tab.viewId === 'record' ? 'Record' : 'Workspace')}</small>
                </button>
                {!tab.pinned ? (
                  <>
                    <label className="hi5-tab-switcher-select" title={`Select ${tab.title} for closing`}>
                      <input
                        aria-label={`Select ${tab.title} for closing`}
                        checked={selectedKeys.includes(tab.key)}
                        onChange={() => toggleSelected(tab.key)}
                        type="checkbox"
                      />
                    </label>
                    <button
                      aria-label={`Close ${tab.title}`}
                      className="hi5-tab-switcher-icon"
                      onClick={() => onClose(tab.key)}
                      title="Close tab"
                      type="button"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </>
                ) : <span className="hi5-tab-switcher-pinned">Pinned</span>}
              </div>
            ))}
          </div>
          <div className="hi5-tab-switcher-footer">
            <button disabled={!selectedClosable.length} onClick={closeSelected} type="button">
              Close selected{selectedClosable.length ? ` (${selectedClosable.length})` : ''}
            </button>
            <button disabled={!canCloseOthers} onClick={() => { onCloseOthers(activeTabKey); setOpen(false) }} type="button">Close others</button>
            <button disabled={!canCloseAll} onClick={() => { onCloseAll(); setOpen(false) }} type="button">Close all</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
