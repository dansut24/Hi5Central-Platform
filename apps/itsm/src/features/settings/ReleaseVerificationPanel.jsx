import {useCallback,useEffect,useState} from 'react'
import {CheckCircle2,ClipboardCopy,RefreshCw,ShieldAlert} from 'lucide-react'
import {deploymentConfig} from '../../lib/deploymentConfig.js'
import {buildReleaseVerificationReceipt,parseReleaseManifest,RELEASE_VERIFICATION_FEATURE} from './releaseVerification.js'
import './ReleaseVerificationPanel.css'

// This is a read-only visual release marker. It must never be used as proof
// that backend images, tenant assignments, public routes or MFA were verified.
export function ReleaseVerificationPanel(){
  const {runtimeEnvironment}=deploymentConfig()
  const [result,setResult]=useState({state:'checking',manifest:null,error:'',checkedAt:null})
  const [copyMessage,setCopyMessage]=useState('')
  const check=useCallback(async(signal)=>{
    setResult({state:'checking',manifest:null,error:'',checkedAt:null})
    setCopyMessage('')
    try{
      const response=await fetch('/release-manifest.json',{cache:'no-store',credentials:'same-origin',signal})
      if(!response.ok)throw Error('Release metadata returned HTTP '+response.status+'.')
      const contentType=response.headers.get('content-type')||''
      if(!contentType.toLowerCase().includes('application/json'))throw Error('Release metadata returned a page instead of JSON.')
      const raw=await response.json()
      const parsed=parseReleaseManifest(raw)
      if(signal?.aborted)return
      setResult({state:'verified',manifest:parsed,error:'',checkedAt:new Date().toISOString()})
    }catch(error){
      if(signal?.aborted)return
      setResult({state:'error',manifest:null,error:error.message||'Cannot verify frontend release metadata.',checkedAt:null})
    }
  },[])
  useEffect(()=>{const controller=new AbortController();void check(controller.signal);return()=>controller.abort()},[check])
  async function copyReceipt(){
    if(result.state!=='verified'||!result.manifest)return
    try{
      const receipt=buildReleaseVerificationReceipt({
        manifest:{sha:result.manifest.buildSha,version:result.manifest.version},
        environment:runtimeEnvironment,hostname:window.location.hostname,
        checkedAt:result.checkedAt,
      })
      if(!navigator.clipboard?.writeText)throw Error('Clipboard access is unavailable in this browser.')
      await navigator.clipboard.writeText(receipt)
      setCopyMessage('Frontend verification receipt copied.')
    }catch(error){setCopyMessage(error.message||'Could not copy the receipt.')}
  }
  return <section className="production-settings-panel hi5-release-verification" data-hi5-release-verification={RELEASE_VERIFICATION_FEATURE}>
    <header>
      <div>
        <h2>Release verification</h2>
        <p>Confirm this browser is serving the expected version before a release is accepted.</p>
      </div>
      <button type="button" className="hi5-release-refresh" onClick={()=>void check()} disabled={result.state==='checking'}>
        <RefreshCw size={15}/> Recheck
      </button>
    </header>
    <div className="production-settings-panel-body">
      <div className="hi5-release-verification-grid">
        <div><small>Environment</small><strong>{runtimeEnvironment.toUpperCase()}</strong></div>
        <div><small>Workspace</small><strong className="hi5-release-verification-host">{window.location.hostname}</strong></div>
        <div><small>Frontend build</small><strong data-hi5-verified-build>{result.manifest?.shortSha||'Not verified'}</strong></div>
        <div><small>Manifest check</small>
          <strong className={result.state==='verified'?'is-verified':result.state==='error'?'is-error':''}>
            {result.state==='verified'?<CheckCircle2 size={16}/>:result.state==='error'?<ShieldAlert size={16}/>:<RefreshCw size={15}/>}
            {result.state==='verified'?'Verified frontend build':result.state==='error'?'Verification failed':'Checking…'}
          </strong>
        </div>
      </div>
      {result.state==='verified'?<p className="hi5-release-verification-sha">Immutable frontend SHA: <code>{result.manifest.buildSha}</code></p>:null}
      {result.error?<p className="hi5-release-message is-error" role="alert">{result.error}</p>:null}
      <div className="hi5-release-verification-actions">
        <button type="button" className="hi5-release-refresh" disabled={result.state!=='verified'} onClick={()=>void copyReceipt()}>
          <ClipboardCopy size={15}/> Copy verification receipt
        </button>
        {copyMessage?<span role="status">{copyMessage}</span>:null}
      </div>
      <p className="hi5-release-verification-note">Read-only check. Frontend verification does not approve a release or confirm the API build. UAT approval and Production activation require separate checks and explicit authorisation.</p>
    </div>
  </section>
}
