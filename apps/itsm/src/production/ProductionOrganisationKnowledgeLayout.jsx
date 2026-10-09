import { useEffect } from 'react'
import './ProductionOrganisationKnowledgeLayout.css'

// Keep the active workspace surface authoritative even if another production
// portal was mounted into the content frame before a tab navigation.
export function ProductionOrganisationKnowledgeLayout() {
  useEffect(() => {
    function sync() {
      const path = window.location.pathname
      const view = /^\/people(?:\/|$)/.test(path) ? 'people'
        : /^\/knowledge(?:\/|$)/.test(path) ? 'knowledge' : ''
      const frame = document.querySelector('.content-frame')
      if (!frame) return
      if (view) frame.dataset.hi5DetailView = view
      else delete frame.dataset.hi5DetailView

      if (!view) return
      // Knowledge owns its own portal; People is the direct runtime child.
      const allowed = view === 'knowledge' ? 'production-knowledge-mounted' : ''
      for (const name of Array.from(frame.classList)) {
        if (name.startsWith('production-') && name.endsWith('-mounted') && name !== allowed) {
          frame.classList.remove(name)
        }
      }
    }

    sync()
    window.addEventListener('popstate', sync)
    window.addEventListener('hi5-routechange', sync)
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hi5-routechange', sync)
    }
  }, [])
  return null
}
