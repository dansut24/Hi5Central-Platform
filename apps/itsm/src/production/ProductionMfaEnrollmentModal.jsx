import {useEffect,useState} from 'react'
import {createPortal} from 'react-dom'
import {QRCodeSVG} from 'qrcode.react'
import {Check,Copy,KeyRound,ShieldCheck,X} from 'lucide-react'
import './ProductionMfaEnrollmentModal.css'

// Authenticator secrets and QR codes are rendered locally. No third-party
// image/QR endpoint receives this user's provisioning URL.
export function ProductionMfaEnrollmentModal({
  flow,setup,code,onCodeChange,recoveryCodes=[],error='',busy=false,
  onVerify,onCancel,onContinue,
}) {
  const [copied,setCopied]=useState(false)
  useEffect(()=>{setCopied(false)},[setup?.secret])
  if(!flow)return null
  const enrolling=Boolean(flow.setupRequired)
  const recovering=Boolean(recoveryCodes.length)
  const safeUri=String(setup?.otpauthUri||'')
  const showQr=enrolling&&safeUri.startsWith('otpauth://totp/')
  const account=String(setup?.account||flow.user?.email||'')
  const copyKey=async()=>{
    if(!setup?.secret)return
    try{await navigator.clipboard.writeText(setup.secret);setCopied(true)}
    catch{setCopied(false)}
  }
  const close=(e)=>{if(e)e.preventDefault();if(!busy)onCancel()}
  return createPortal(
    <div className="hi5-mfa-overlay" role="presentation">
      <section className="hi5-mfa-dialog" role="dialog" aria-modal="true"
        aria-labelledby="hi5-mfa-heading" aria-describedby="hi5-mfa-description">
        <header className="hi5-mfa-header">
          <div className="hi5-mfa-header-icon"><ShieldCheck size={23}/></div>
          <div>
            <span className="hi5-mfa-kicker">Hi5Central account security</span>
            <h2 id="hi5-mfa-heading">{recovering?'Save your recovery codes':enrolling?'Set up your authenticator':'Verify your identity'}</h2>
          </div>
          <button type="button" className="hi5-mfa-close" disabled={busy}
            aria-label="Return to sign in" onClick={close}><X size={20}/></button>
        </header>
        {recovering ? (
          <div className="hi5-mfa-main">
            <p id="hi5-mfa-description">Keep these one-time recovery codes somewhere secure. They will not be displayed again.</p>
            <div className="hi5-mfa-recovery">
              {recoveryCodes.map((item,i)=><code key={i}>{item}</code>)}
            </div>
            <button className="hi5-mfa-primary" type="button" disabled={busy}
              onClick={onContinue}>{busy?'Opening Hi5Central…':'I have saved my recovery codes'}</button>
          </div>
        ) : (
          <form className="hi5-mfa-main" onSubmit={onVerify}>
            <p id="hi5-mfa-description">{enrolling
              ? 'Multi-factor authentication is required. Scan this QR code with Duo Mobile, Microsoft Authenticator, Google Authenticator or another compatible app, then enter its six-digit code.'
              : 'Enter the six-digit code from your authenticator, or an unused recovery code.'}</p>
            {enrolling ? (
              <>
                <div className="hi5-mfa-setup">
                  <div className="hi5-mfa-qr">
                    {showQr?<QRCodeSVG value={safeUri} size={186} bgColor="#ffffff" fgColor="#102044"
                      level="M" marginSize={2} title="Hi5Central authenticator setup QR code"/>
                      :<span className="hi5-mfa-loading">Preparing QR code…</span>}
                  </div>
                  <div className="hi5-mfa-setup-info">
                    <strong>Add Hi5Central to your authenticator</strong>
                    <span>Account</span>
                    <b>{account}</b>
                    <span>Can't scan the QR code? Enter this key manually:</span>
                    <div className="hi5-mfa-manual-key"><code>{setup?.secret||'Preparing…'}</code>
                      <button type="button" onClick={copyKey} disabled={!setup?.secret}
                        aria-label="Copy manual authenticator setup key">
                        {copied?<Check size={17}/>:<Copy size={17}/>}
                      </button>
                    </div>
                    <small>Issuer: Hi5Central. This authenticator works with Production, UAT and Test.</small>
                    {showQr?<a href={safeUri}>Open in authenticator app</a>:null}
                  </div>
                </div>
              </>
            ) : <div className="hi5-mfa-verify-note"><KeyRound size={18}/> Hi5Central · {flow.user?.email||'Your account'}</div>}
            <label className="hi5-mfa-code-label" htmlFor="hi5-mfa-code">
              {enrolling?'Confirm your six-digit authenticator code':'Authenticator or recovery code'}
            </label>
            <input id="hi5-mfa-code" autoComplete="one-time-code" autoFocus
              inputMode={enrolling?'numeric':'text'}
              maxLength={enrolling?6:20} placeholder={enrolling?'000000':'000000 or recovery code'}
              value={code} onChange={e=>onCodeChange(e.target.value)}
              disabled={busy||enrolling&&!setup} required/>
            {error?<p className="hi5-mfa-error" role="alert">{error}</p>:null}
            <button className="hi5-mfa-primary" type="submit"
              disabled={busy||!code.trim()||(enrolling&&!showQr)}>
              {busy?'Verifying…':enrolling?'Verify and enable MFA':'Verify and sign in'}
            </button>
            <button className="hi5-mfa-secondary" type="button" onClick={close} disabled={busy}>Back to sign in</button>
            {/^testing(?:-test|-uat)?\.hi5central\.com$/i.test(window.location.hostname) ? <a className="hi5-mfa-secondary" href="https://api.hi5central.com/api/v1/auth/mfa-recovery/start" rel="noreferrer">Lost your authenticator and recovery codes?</a> : null}
          </form>
        )}
      </section>
    </div>,document.body)
}
