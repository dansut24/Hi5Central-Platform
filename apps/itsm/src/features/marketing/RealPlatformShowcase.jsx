import { useState } from 'react'
import { ArrowUpRight, MonitorCog, TicketCheck } from 'lucide-react'
import './RealPlatformShowcase.css'

// Genuine current Hi5Central frontend screenshots, captured in isolated CI.
// All tickets, users, names and devices shown are synthetic test fixtures.
const shots = {
  itsm: {label:'ITSM workspace', heading:'Service management',
    image:'/marketing/platform-itsm-sample.png',
    alt:'Hi5Central ITSM incidents workspace, rendered by the actual Platform with fictional service records',
    icon:TicketCheck},
  rmm: {label:'RMM workspace', heading:'Endpoint operations',
    image:'/marketing/platform-rmm-sample.png',
    alt:'Hi5Central RMM dashboard, rendered by the actual Platform with fictional device data',
    icon:MonitorCog},
}
export function RealPlatformShowcase() {
  const [selected, setSelected] = useState('itsm')
  const active = shots[selected]
  return <div className="h5m-real-showcase">
    <div className="h5m-real-topbar">
      <span className="h5m-real-topbar-heading"><span className="h5m-real-live-dot"/> HI5CENTRAL PLATFORM</span>
      <span className="h5m-real-sample-label">Actual UI · Example data</span>
    </div>
    <div className="h5m-real-tabs" role="tablist" aria-label="Real Platform screenshots">
      {Object.entries(shots).map(([id,shot])=>{
        const Icon=shot.icon
        return <button key={id} id={'h5m-real-tab-'+id} type="button" role="tab"
          aria-controls="h5m-real-panel" aria-selected={selected===id}
          tabIndex={selected===id?0:-1}
          onKeyDown={event=>{
            if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
            event.preventDefault()
            const next=event.key==='Home'?'itsm':event.key==='End'?'rmm':selected==='itsm'?'rmm':'itsm'
            setSelected(next)
            document.getElementById('h5m-real-tab-'+next)?.focus()
          }}
          onClick={()=>setSelected(id)}>
          <Icon size={16}/>{shot.label}
        </button>
      })}
    </div>
    <div className="h5m-real-image-wrap" id="h5m-real-panel" role="tabpanel"
      aria-labelledby={'h5m-real-tab-'+selected}>
      <a href={active.image} target="_blank" rel="noopener noreferrer"
        aria-label={'Open full-size '+active.label+' screenshot'}>
        <img key={selected} src={active.image} alt={active.alt}
          width="1440" height="900" loading="eager" decoding="async"/>
        <span className="h5m-real-view-full">View full screenshot <ArrowUpRight size={15}/></span>
      </a>
    </div>
    <div className="h5m-real-caption">
      <strong>{active.heading}</strong>
      <span>Captured from the real Hi5Central Platform frontend. Names, devices and records shown are illustrative.</span>
    </div>
  </div>
}
