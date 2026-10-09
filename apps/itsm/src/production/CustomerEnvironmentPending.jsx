import { resolveTenantSurface } from '../lib/tenantSurface.js'

// A deliberately non-authenticated, fail-closed landing page. It must not
// fetch Production session data or attempt a Production API login.
export function CustomerEnvironmentPending() {
  const surface = resolveTenantSurface()
  const name = surface.environment === 'uat' ? 'UAT' : 'Test'
  return (
    <main style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center',
      background: '#eef3fb', color: '#142342', padding: 24,
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <section style={{
        width: 'min(100%, 480px)', padding: '32px 28px', borderRadius: 18,
        background: '#fff', border: '1px solid #d9e3f1',
        boxShadow: '0 16px 52px rgba(19,37,72,.09)',
      }}>
        <img src="/hi5central-logo.png" alt="Hi5Central" style={{ height: 56, width: 56, objectFit: 'contain' }} />
        <p style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.09em', color: '#5d6f8d' }}>
          CUSTOMER {name.toUpperCase()} ENVIRONMENT
        </p>
        <h1 style={{ fontSize: 25, margin: '8px 0 12px' }}>{name} is being prepared</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#4c5c76' }}>
          This customer environment has not been activated. Hi5Central keeps it
          separate from Production until its data and access controls are ready.
        </p>
        <p style={{ fontSize: 13, color: '#4c5c76' }}>
          Organisation: <strong>{surface.tenantName}</strong>
        </p>
        <a href="https://hi5central.com" style={{ color: '#204b9d', fontWeight: 700, fontSize: 13 }}>
          Return to Hi5Central
        </a>
      </section>
    </main>
  )
}
