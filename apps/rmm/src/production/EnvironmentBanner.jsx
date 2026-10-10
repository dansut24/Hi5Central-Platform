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
  if(environment==='live')return null
  document.documentElement.dataset.hi5Environment=environment
  const isUat=environment==='uat'
  return (
    <div className={`hi5-environment-banner hi5-environment-banner--${environment}`}
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
