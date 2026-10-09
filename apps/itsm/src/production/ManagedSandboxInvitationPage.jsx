import { useEffect, useState } from 'react'
import { resolveTenantSurface } from '../lib/tenantSurface.js'

const API_BASE = window.__HI5_API_BASE__

export function ManagedSandboxInvitationPage() {
  const surface = resolveTenantSurface()
  const [password,setPassword] = useState('')
  const [confirm,setConfirm] = useState('')
  const [pending,setPending] = useState(false)
  const [complete,setComplete] = useState(false)
  const [error,setError] = useState('')
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') || ''

  useEffect(() => {
    document.title = 'Accept your Hi5Central invitation'
    // Do not keep invitation secrets in browser history after they have been read.
    if (token) window.history.replaceState({}, '', window.location.pathname)
  }, [])

  async function accept(event) {
    event.preventDefault()
    setError('')
    if (!token || token.length !== 43) return setError('This invitation link is invalid.')
    if (password !== confirm) return setError('Passwords do not match.')
    if (password.length < 12) return setError('Use a strong password of at least 12 characters.')
    setPending(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/sandbox-invitations/accept`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ tenantSlug: surface.tenantSlug, token, password }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Invitation cannot be accepted at this time.')
      setPassword('')
      setConfirm('')
      setComplete(true)
    } catch (cause) {
      setError(cause.message || 'Invitation could not be accepted.')
    } finally {setPending(false)}
  }

  const styles = {
    shell: { minHeight:'100dvh', display:'grid', placeItems:'center', background:'#eef3fb',
      color:'#142342', padding:24, fontFamily:'Inter,system-ui,sans-serif' },
    panel: { width:'min(100%,460px)', padding:'32px 28px', borderRadius:18,
      background:'#fff', border:'1px solid #d9e3f1', boxShadow:'0 16px 52px rgba(19,37,72,.09)' },
    field: { width:'100%', boxSizing:'border-box', border:'1px solid #bdcbe0',
      padding:'13px 14px', borderRadius:10, marginTop:7, marginBottom:16, fontSize:14 },
    action: { width:'100%', background:'#ef9c18', color:'#16223b', border:0,
      borderRadius:10, padding:14, fontWeight:800, cursor:pending?'wait':'pointer' },
  }

  return (
    <main style={styles.shell}>
      <section style={styles.panel}>
        <img src="/hi5central-logo.png" alt="Hi5Central" style={{height:54,width:54,objectFit:'contain'}}/>
        <p style={{fontSize:12,fontWeight:800,letterSpacing:'.08em',color:'#5d6f8d'}}>
          {surface.environment?.toUpperCase() || 'SANDBOX'} INVITATION
        </p>
        <h1 style={{fontSize:25,margin:'8px 0 12px'}}>Join {surface.tenantName}</h1>
        {complete ? (
          <>
            <p style={{lineHeight:1.6}}>Your invitation has been accepted. Sign in with your password
              and complete multi-factor authentication before using this environment.</p>
            <a href="/" style={{color:'#204b9d',fontWeight:700}}>Continue to secure sign-in</a>
          </>
        ) : (
          <>
            <p style={{fontSize:14,lineHeight:1.6,color:'#4c5c76'}}>
              Create or confirm your password. Your UAT/Test account is separate from Production.
              Accepting an invitation does not sign you in.
            </p>
            <form onSubmit={accept}>
              <label htmlFor="sandbox-new-password" style={{fontWeight:700,fontSize:14}}>Password</label>
              <input id="sandbox-new-password" autoComplete="new-password" type="password"
                required value={password} onChange={e=>setPassword(e.target.value)} style={styles.field}/>
              <label htmlFor="sandbox-confirm-password" style={{fontWeight:700,fontSize:14}}>Confirm password</label>
              <input id="sandbox-confirm-password" autoComplete="new-password" type="password"
                required value={confirm} onChange={e=>setConfirm(e.target.value)} style={styles.field}/>
              {error ? <p role="alert" style={{color:'#b42318',fontSize:13}}>{error}</p> : null}
              <button disabled={pending||!token} type="submit" style={styles.action}>
                {pending?'Checking invitation…':'Accept invitation'}
              </button>
            </form>
          </>
        )}
        <p style={{fontSize:12,color:'#60718d',lineHeight:1.5,marginTop:20}}>
          Invitations are single-use and expire after 24 hours. This page cannot activate
          an environment that has not passed Hi5Central isolation approval.
        </p>
      </section>
    </main>
  )
}
