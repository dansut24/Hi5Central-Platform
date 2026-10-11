import {useEffect,useState} from 'react'
import {Sparkles,RefreshCw,ClipboardCopy} from 'lucide-react'
import './ItsmAiAssistPanel.css'
const BASE=window.__HI5_API_BASE__||''
export function ItsmAiAssistPanel({record}){
  const reference=record?.id||record?.reference||''
  const [status,setStatus]=useState(null)
  const [summary,setSummary]=useState('')
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)
  const [copied,setCopied]=useState(false)
  useEffect(()=>{
    let active=true
    setSummary('');setError('')
    fetch(BASE+'/api/v1/itsm-ai/status',{credentials:'include',cache:'no-store'})
      .then(async r=>{
        if(r.status===403)return {enabled:false}
        if(!r.ok)throw Error('AI Assist status unavailable')
        return r.json()
      })
      .then(s=>{if(active)setStatus(s)})
      .catch(()=>{if(active)setStatus({enabled:false})})
    return()=>{active=false}
  },[reference])
  if(!status?.enabled)return null
  async function generate(){
    setLoading(true);setError('');setCopied(false)
    try{
      const r=await fetch(BASE+'/api/v1/itsm-ai/summary',{
        method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({reference,type:record.type,title:record.title,description:record.description,status:record.status,priority:record.priority,category:record.category}),
      })
      const p=await r.json().catch(()=>({}))
      if(!r.ok)throw Error(p.error||'Could not generate a summary.')
      setSummary(String(p.summary||''))
    }catch(e){setError(e.message)}finally{setLoading(false)}
  }
  return <section className="hi5-itsm-ai-assist" aria-label="AI Assist">
    <header><span><Sparkles size={16}/> AI Assist</span>
      <small>{status.environment==='test'?'Test — latest feature':'Optional analyst assistance'}</small></header>
    <p>Generate a draft issue brief and suggested next steps. Review before using; no changes are saved automatically.</p>
    {!status.ready?<p className="hi5-itsm-ai-warning" role="status">An AI provider needs to be configured before generation is available.</p>:null}
    {error?<p role="alert" className="hi5-itsm-ai-error">{error}</p>:null}
    {summary?<div className="hi5-itsm-ai-response">
      <pre>{summary}</pre>
      <button type="button" onClick={async()=>{
        try{await navigator.clipboard.writeText(summary);setCopied(true)}
        catch{setError('Copy failed. Select the text manually.')}
      }}><ClipboardCopy size={14}/>{copied?'Copied':'Copy draft'}</button>
    </div>:null}
    <button type="button" className="hi5-itsm-ai-generate" disabled={loading||!status.ready} onClick={generate}>
      {loading?<RefreshCw size={15}/>:<Sparkles size={15}/>}
      {loading?'Generating…':summary?'Regenerate draft':'Generate AI draft'}
    </button>
    <small>Only record details needed for the brief are sent to the configured AI provider when you press Generate.</small>
  </section>
}
