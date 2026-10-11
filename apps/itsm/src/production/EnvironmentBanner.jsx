import { useEffect, useRef } from 'react'
import './EnvironmentBanner.css'

function currentEnvironment() {
  const configured=String(window.__HI5_CONFIG__?.runtimeEnvironment||import.meta.env.VITE_RUNTIME_ENVIRONMENT||'').toLowerCase()
  if (configured==='test'||configured==='uat') return configured
  // Fallback only for named managed subdomains: never classify a normal
  // customer slug like "testing" as an environment.
  const host=window.location.hostname.toLowerCase()
  if (/^[a-z0-9-]+-uat(?:-rmm|-portal)?\.hi5central\.com$/.test(host)) return 'uat'
  if (/^[a-z0-9-]+-test(?:-rmm|-portal)?\.hi5central\.com$/.test(host)) return 'test'
  return 'live'
}

export function EnvironmentBanner() {
  const environment=currentEnvironment()
  const bannerRef=useRef(null)
  useEffect(()=>{
    if(environment==='live')return undefined
    document.documentElement.dataset.hi5Environment=environment
    const banner=bannerRef.current
    if(!banner)return undefined
    const update=()=>{
      const height=Math.max(36,Math.ceil(banner.getBoundingClientRect().height))
      document.documentElement.style.setProperty('--hi5-environment-banner-height',height+'px')
    }
    update()
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(update):null
    observer?.observe(banner)
    window.addEventListener('resize',update)
    return()=>{
      observer?.disconnect()
      window.removeEventListener('resize',update)
      document.documentElement.style.removeProperty('--hi5-environment-banner-height')
    }
  },[environment])
  if(environment==='live')return null
  const isUat=environment==='uat'
  return (
    <div ref={bannerRef} className={`hi5-environment-banner hi5-environment-banner--${environment}`}
      role="status" aria-label={isUat?'UAT staging environment':'Test environment'}>
      <span className="hi5-environment-banner__label">
        {isUat?'UAT / STAGING ENVIRONMENT':'TEST ENVIRONMENT'}
      </span>
      <span className="hi5-environment-banner__message">
        {isUat
          ? 'Not Production · Changes must be promoted to go live'
          : 'Not Production · Test data and changes are isolated'}
      </span>
    </div>
  )
}
