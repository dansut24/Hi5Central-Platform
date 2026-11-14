import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Search, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import './RmmWindowsSettingsLibrary.css'

const catalogueVersions = [
  {id:'26h2',label:'Windows 11 26H2 (2026)',file:'windows11_26h2_admx_v1.json'},
  {id:'25h2',label:'Windows 11 25H2 (2025)',file:'windows11_25h2_admx_v2.json'},
]
const batch = 60
const allScope = 'all'
function scopeName(scope) { return scope === 'device' ? 'Device' : scope === 'user' ? 'User' : 'Device and user' }
function readable(value) { return String(value ?? '').replaceAll('_',' ') }

export function RmmWindowsSettingsLibrary({ nativeSettings = [] }) {
  const [release, setRelease] = useState('26h2')
  const [catalogue, setCatalogue] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [scope, setScope] = useState(allScope)
  const [type, setType] = useState('all')
  const [limit, setLimit] = useState(batch)
  const [expanded, setExpanded] = useState('')
  useEffect(() => {
    let active = true
    setCatalogue(null)
    setError('')
    const controller = new AbortController()
    const version = catalogueVersions.find((item)=>item.id===release) || catalogueVersions[0]
    fetch('/catalogue/' + version.file, {signal:controller.signal,cache:'force-cache'})
      .then(async (response) => { if (!response.ok) throw new Error('Policy catalogue is not installed in this release.'); return response.json() })
      .then((result) => { if (active && Array.isArray(result.settings)) setCatalogue(result) })
      .catch((reason) => { if (active && reason.name !== 'AbortError') setError(reason.message) })
    return () => { active = false; controller.abort() }
  }, [release])
  const native = useMemo(() => nativeSettings.map((setting) => ({
    id: setting.key, name:setting.label, description:setting.description || '',
    path:setting.category, category:setting.category, scope:'device', type:setting.type,
    source:'Hi5Central built-in', sourceFile:'',supportedOn:'',registryKey:'',
    elements:[],managementStatus:'hi5central_builtin',
  })),[nativeSettings])
  const all = useMemo(() => [...native,...(catalogue?.settings || [])], [native,catalogue])
  const categories = useMemo(() => {
    const map = new Map()
    all.forEach((item) => map.set(item.category,(map.get(item.category) || 0)+1))
    return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
  },[all])
  const results = useMemo(() => {
    const needle=query.trim().toLowerCase()
    return all.filter((item) =>
      (category==='all'||item.category===category) &&
      (scope==='all'||item.scope===scope||(item.scope==='both'&&scope!=='all')) &&
      (type==='all'||item.managementStatus===type) &&
      (!needle || [item.name,item.description,item.path,item.id,item.registryKey].some((part)=>String(part||'').toLowerCase().includes(needle)))
    )
  },[all,query,category,scope,type])
  useEffect(()=>{setLimit(batch);setExpanded('')},[query,category,scope,type])
  return <section className="h5c-settings-library" aria-label="Windows settings catalogue">
    <div className="h5c-settings-library-heading">
      <div><h2><BookOpen size={20} aria-hidden="true"/> Windows settings catalogue</h2>
        <p>Explore Microsoft Windows administrative templates and Hi5Central's supported policy settings in one searchable library.</p></div>
      <div className="h5c-settings-library-release"><label>Windows template version<select value={release} onChange={(e)=>setRelease(e.target.value)}>{catalogueVersions.map((item)=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <div className="h5c-settings-library-total"><strong>{(catalogue?.importedPolicyCount || 0).toLocaleString('en-GB')}</strong><small>Imported Windows ADMX policies</small></div></div>
    </div>
    <div className="h5c-settings-library-note"><ShieldAlert size={17} aria-hidden="true"/><span>Imported settings are <strong>browse-only</strong> until Hi5Central has a verified read/apply/remove adapter. Their appearance here does not mean they can be enforced through the agent or apply to every Windows edition.</span></div>
    <div className="h5c-settings-library-filters">
      <label><span><Search size={15}/> Search by policy name or keyword</span><input type="search" placeholder="e.g. BitLocker, Defender, LAPS, USB, Windows Update..." value={query} onChange={(e)=>setQuery(e.target.value)}/></label>
      <label><span>Category</span><select value={category} onChange={(e)=>setCategory(e.target.value)}><option value="all">All categories ({categories.length})</option>{categories.map(([key,count])=><option key={key} value={key}>{key} ({count})</option>)}</select></label>
      <label><span>Target</span><select value={scope} onChange={(e)=>setScope(e.target.value)}><option value="all">All scopes</option><option value="device">Device settings</option><option value="user">User settings</option></select></label>
      <label><span>Deployment status</span><select value={type} onChange={(e)=>setType(e.target.value)}><option value="all">All settings</option><option value="hi5central_builtin">Hi5Central built-in</option><option value="catalogue_only">Imported / browse-only</option></select></label>
    </div>
    <div className="h5c-settings-library-count"><SlidersHorizontal size={15}/><strong>{results.length.toLocaleString('en-GB')}</strong> settings found <small>Showing first {Math.min(results.length,limit).toLocaleString('en-GB')}</small></div>
    {error&&<p role="alert" className="h5c-settings-library-error">{error}</p>}
    {!catalogue&&!error&&<p className="h5c-settings-library-loading">Loading Microsoft policy definitions…</p>}
    <div className="h5c-settings-library-results">
      {results.slice(0,limit).map((item)=>{
        const open = item.id===expanded
        const supported = item.managementStatus==='hi5central_builtin'
        return <div className={'h5c-settings-library-result'+(open?' is-open':'')} key={item.id}>
          <button type="button" className="h5c-settings-library-result-top" aria-expanded={open} onClick={()=>setExpanded(open?'':item.id)}>
            {open?<ChevronDown size={18}/>:<ChevronRight size={18}/>}
            <div className="h5c-settings-library-result-name"><strong>{item.name}</strong><small>{item.path} · {scopeName(item.scope)}</small></div>
            <span className={'h5c-settings-library-status '+(supported?'supported':'imported')}>{supported?'Hi5Central setting':'Catalogue only'}</span>
          </button>
          {open&&<div className="h5c-settings-library-details">
            {item.description&&<p>{item.description}</p>}
            <dl><div><dt>Source</dt><dd>{item.source}</dd></div><div><dt>Setting ID</dt><dd>{item.id}</dd></div><div><dt>Data type</dt><dd>{readable(item.type)}</dd></div>
            {item.registryKey&&<div><dt>Registry policy key</dt><dd>{item.registryKey}{item.valueName?' / '+item.valueName:''}</dd></div>}
            {item.supportedOn&&<div><dt>Windows applicability reference</dt><dd>{item.supportedOn} · check Windows edition and OS compatibility</dd></div>}</dl>
            {item.elements?.length>0&&<div><strong>Configurable fields ({item.elements.length})</strong>
              <ul>{item.elements.map((el,i)=><li key={el.id+':'+i}><strong>{el.id||el.valueName||readable(el.type)}</strong> · {readable(el.type)}
                {el.minValue||el.maxValue?' ('+[el.minValue,el.maxValue].filter(Boolean).join('–')+')':''}
                {el.options?.length?' · '+el.options.slice(0,9).map((opt)=>opt.label).join(', '):''}
              </li>)}</ul></div>}
            <small>{supported?'This setting is included in the Hi5Central policy authoring catalogue; enforcement support depends on the adapter.':'Not yet deployable by Hi5Central. Template metadata is not a Windows policy execution engine.'}</small>
          </div>}
        </div>
      })}
    </div>
    {limit<results.length&&<button type="button" className="h5c-settings-library-more" onClick={()=>setLimit((old)=>old+batch)}>Show {Math.min(batch,results.length-limit)} more settings</button>}
    {results.length===0&&catalogue&&<p className="h5c-settings-library-loading">No matching settings. Try another category or search term.</p>}
    <p className="h5c-settings-library-source">Catalogue source: {catalogue?.sourceVersion || 'Microsoft Windows administrative templates'} ({catalogue?.sourceFiles || '…'} ADMX files). <a href={catalogue?.downloadPage || 'https://www.microsoft.com/en-us/download/details.aspx?id=108847'} target="_blank" rel="noopener noreferrer">Official Microsoft download</a>. Additional Policy CSP and security-baseline data can be imported separately.</p>
  </section>
}
