import { useEffect, useState } from 'react'
import {
  Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, Cloud, GitBranch, Globe2, Headphones, Layers3,
  LockKeyhole, Menu, MonitorCog, ShieldCheck, Sparkles, TicketCheck,
  Wrench, X, Zap,
} from 'lucide-react'
import './ProfessionalMarketingHome.css'
import { RealPlatformShowcase } from './RealPlatformShowcase.jsx'

// A standalone MARKETING homepage. The existing SignupPage, auth, payments,
// tenancy and API endpoints are deliberately not changed.
// All UI preview records are illustrative, never live metrics or social proof.
const CAPABILITIES = [
  { id:'service', label:'Service management', icon:TicketCheck, eyebrow:'IT SERVICE MANAGEMENT',
    title:'Make every service interaction feel effortless.',
    detail:'Keep incidents, requests and the people behind them together in a structured workspace. Move from the first report to an outcome without losing the conversation.',
    highlights:['Incident and request management','Customer notes and communication','Knowledge and service workflows'],
    category:'Service Desk', sampleTitle:'New starter onboarding', sampleStatus:'In progress',
    stages:['Request received','Tasks assigned','Approval in progress'] },
  { id:'devices', label:'Endpoint operations', icon:MonitorCog, eyebrow:'REMOTE MONITORING & MANAGEMENT',
    title:'Understand your endpoints, then act.',
    detail:'Give technicians a clearer picture of devices and their health, alongside tools to investigate issues, run actions and support users remotely.',
    highlights:['Device inventory and monitoring','Policy-based management','Remote access and software tasks'],
    category:'Device Management', sampleTitle:'Windows workstation', sampleStatus:'Attention needed',
    stages:['Device inventory','Monitoring signal','Technician action'] },
  { id:'portal', label:'Self-service', icon:Globe2, eyebrow:'CUSTOMER PORTAL',
    title:'A better front door for everyone needing IT.',
    detail:'Make it easy for people to find answers, request services and follow progress without needing to understand the workings of a service desk.',
    highlights:['Dedicated customer Portal','Service requests and updates','Knowledge and self-service'],
    category:'Self-Service Portal', sampleTitle:'Request a software package', sampleStatus:'Awaiting approval',
    stages:['Choose a service','Submit a request','Track the outcome'] },
  { id:'automation', label:'Connected workflows', icon:GitBranch, eyebrow:'CONNECTED PLATFORM',
    title:'Keep context when work crosses teams.',
    detail:'Bring service and device context closer together. ITSM and RMM are designed to work on their own or connect when your operation calls for it.',
    highlights:['Shared operational context','Service and endpoint relationships','Structured approvals and actions'],
    category:'Operational Workflow', sampleTitle:'Investigate device alert', sampleStatus:'Being reviewed',
    stages:['Signal identified','Service context','Follow-up action'] },
]
const FAQ = [
  { question:'Can we use ITSM without RMM?',
    answer:'Yes. Choose ITSM with its self-service Portal, RMM on its own, or both products together. You can expand your selection as your needs change.' },
  { question:'Does the customer Portal have its own address?',
    answer:'Yes. For example, a customer at company.hi5central.com uses company-portal.hi5central.com for the self-service Portal. RMM, when selected, has company-rmm.hi5central.com.' },
  { question:'How do Managed and Custom updates differ?',
    answer:'Hi5Central is designed with two update paths: Managed customers have a Test environment and scheduled Production updates, while Custom customers have an additional UAT stage and customer-approved Production promotion. Release automation is still being validated.' },
  { question:'Which devices does RMM support?',
    answer:'Hi5Central is being developed for Windows, Linux and macOS agents and remote viewing, with mobile viewing as a separate client experience. Availability of individual capabilities can vary by platform.' },
]
function Logo() {
  return <a className="h5m-logo" href="/" aria-label="Hi5Central homepage">
    <span className="h5m-logo-icon"><img src="/hi5central-logo.png" alt="" /></span>
    <span>Hi5<span className="h5m-logo-emphasis">Central</span></span>
  </a>
}
function Header() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return <header className="h5m-header">
    <div className="h5m-container h5m-header-inner">
      <Logo />
      <nav className={'h5m-navigation ' + (open ? 'is-open' : '')}
        id="h5m-site-navigation" aria-label="Main navigation">
        <a href="#products" onClick={close}>Products</a>
        <a href="#capabilities" onClick={close}>Capabilities</a>
        <a href="#deployment" onClick={close}>Cloud &amp; updates</a>
        <a href="#questions" onClick={close}>FAQs</a>
        <a className="h5m-mobile-signup" href="/signup" onClick={close}>Create workspace <ArrowRight size={17} /></a>
      </nav>
      <a className="h5m-button h5m-header-cta" href="/signup">Get started <ArrowUpRight size={17} /></a>
      <button className="h5m-menu-toggle" type="button"
        aria-controls="h5m-site-navigation" aria-expanded={open}
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen(v => !v)}>{open ? <X size={22} /> : <Menu size={22} />}</button>
    </div>
  </header>
}
function ProductCard({ number, icon: Icon, tone, label, title, description, benefits }) {
  return <article className={'h5m-product-card h5m-tone-' + tone}>
    <div className="h5m-product-top"><span>0{number}</span><span className="h5m-product-icon"><Icon size={24} strokeWidth={1.8}/></span></div>
    <span className="h5m-card-label">{label}</span><h3>{title}</h3><p>{description}</p>
    <ul>{benefits.map(item => <li key={item}><Check size={17}/>{item}</li>)}</ul>
    <a className="h5m-product-link" href="#capabilities">Explore capabilities <ArrowUpRight size={18}/></a>
  </article>
}
function CapabilityExplorer() {
  const [active, setActive] = useState(CAPABILITIES[0].id)
  const current = CAPABILITIES.find(c => c.id === active) || CAPABILITIES[0]
  const CurrentIcon = current.icon
  return <div className="h5m-capability">
    <div className="h5m-capability-tabs" role="tablist" aria-label="Hi5Central capabilities">
      {CAPABILITIES.map((item, i) => {
        const Icon = item.icon
        return <button key={item.id} id={'h5m-tab-' + item.id} type="button" role="tab"
          aria-selected={active === item.id} aria-controls="h5m-capability-panel"
          tabIndex={active === item.id ? 0 : -1}
          onKeyDown={event => {
            if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
            event.preventDefault()
            const index = CAPABILITIES.findIndex(capability => capability.id === item.id)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? CAPABILITIES.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : -1) + CAPABILITIES.length) % CAPABILITIES.length
            setActive(CAPABILITIES[next].id)
            document.getElementById('h5m-tab-' + CAPABILITIES[next].id)?.focus()
          }}
          onClick={() => setActive(item.id)}><Icon size={18}/>{item.label}</button>
      })}
    </div>
    <div className="h5m-capability-panel" id="h5m-capability-panel" role="tabpanel"
      aria-labelledby={'h5m-tab-' + current.id} tabIndex={0}>
      <div className="h5m-capability-copy">
        <span className="h5m-eyebrow"><CurrentIcon size={16}/>{current.eyebrow}</span>
        <h3>{current.title}</h3><p>{current.detail}</p>
        <ul>{current.highlights.map(item => <li key={item}><CheckCircle2 size={17}/>{item}</li>)}</ul>
        <a className="h5m-inline-link" href="/signup">Build your workspace <ArrowRight size={18}/></a>
      </div>
      <div className="h5m-capability-visual" aria-label={'Example ' + current.category + ' workflow'}>
        <div className="h5m-mini-app-title"><span><Layers3 size={16}/>{current.category}</span><span>Sample workflow</span></div>
        <div className="h5m-mini-app-card"><small>WORK ITEM</small><strong>{current.sampleTitle}</strong><em>{current.sampleStatus}</em></div>
        <div className="h5m-mini-steps">{current.stages.map((step, i) =>
          <div key={step} className="h5m-mini-step"><span>{i === 0 ? <Check size={14}/> : i+1}</span><div><strong>{step}</strong><small>{i===0?'Recorded':i===1?'Connected workflow':'Next step'}</small></div></div>
        )}</div>
      </div>
    </div>
  </div>
}
function Footer() {
  return <footer className="h5m-footer">
    <div className="h5m-container h5m-footer-grid">
      <div><Logo/><p>One connected home for service management, endpoint operations and the people you support.</p></div>
      <div className="h5m-footer-links"><strong>Explore</strong><a href="#products">Our products</a><a href="#capabilities">Capabilities</a><a href="#deployment">Cloud &amp; updates</a><a href="#questions">FAQs</a></div>
      <div className="h5m-footer-links"><strong>Get started</strong><a href="/signup">Create a workspace</a><a href="#products">IT service management</a><a href="#products">Remote monitoring</a><a href="#products">Self-service Portal</a></div>
    </div>
    <div className="h5m-container h5m-footer-bottom"><span>© {new Date().getFullYear()} Hi5Central. All rights reserved.</span><span>Built for the teams who keep things running.</span></div>
  </footer>
}
export function ProfessionalMarketingHome() {
  useEffect(() => {
    const previousTitle = document.title
    const description = document.querySelector('meta[name="description"]')
    const previousDescription = description?.getAttribute('content')
    document.title = 'Hi5Central | Connected IT service management and RMM'
    description?.setAttribute('content','Hi5Central brings IT service management, remote monitoring and self-service together. Choose ITSM, RMM or both for your organisation.')
    return () => {
      document.title = previousTitle
      if (description && previousDescription !== null && previousDescription !== undefined) description.setAttribute('content',previousDescription)
    }
  }, [])
  return <div className="h5m-page">
    <a className="h5m-skip-link" href="#main-content">Skip to content</a>
    <Header/>
    <main id="main-content">
      <section className="h5m-hero" aria-labelledby="h5m-hero-title">
        <div className="h5m-container h5m-hero-grid">
          <div className="h5m-hero-copy">
            <div className="h5m-pill"><i/> A CONNECTED IT OPERATIONS PLATFORM</div>
            <h1 id="h5m-hero-title">IT works better <span>when everything connects.</span></h1>
            <p>Bring your service desk, devices and self-service experience closer together. Modern ITSM and RMM, designed to work independently or as one connected platform.</p>
            <div className="h5m-hero-actions">
              <a className="h5m-button h5m-button-large" href="/signup">Create your workspace <ArrowUpRight size={19}/></a>
              <a className="h5m-hero-secondary" href="#products">Explore Hi5Central <ArrowRight size={18}/></a>
            </div>
            <div className="h5m-hero-promises"><span><CheckCircle2 size={17}/> ITSM + Portal</span><span><CheckCircle2 size={17}/> RMM + Remote support</span><span><CheckCircle2 size={17}/> Choose either or both</span></div>
          </div>
          <RealPlatformShowcase/>
        </div>
      </section>
      <section className="h5m-value-strip" aria-label="Platform capabilities">
        <div className="h5m-container h5m-value-inner"><span><Wrench size={18}/> Service management</span><span><MonitorCog size={18}/> Endpoint operations</span><span><Globe2 size={18}/> Self-service</span><span><Zap size={18}/> Connected workflows</span></div>
      </section>
      <section className="h5m-section h5m-products" id="products" aria-labelledby="h5m-products-title">
        <div className="h5m-container">
          <div className="h5m-section-intro h5m-intro-between">
            <div><span className="h5m-eyebrow">THE HI5CENTRAL ECOSYSTEM</span><h2 id="h5m-products-title">The tools your team needs.<br/><span>Nothing you don't.</span></h2></div>
            <p>Start with the product that solves your most immediate challenge. Connect the pieces as your organisation grows.</p>
          </div>
          <div className="h5m-products-grid">
            <ProductCard number={1} icon={TicketCheck} tone="navy" label="IT SERVICE MANAGEMENT" title="Service that feels effortless."
              description="Give your team a calmer way to manage incidents, requests, changes, knowledge and everyday support."
              benefits={['Technician workspace and service workflows','Requests, approvals and customer updates','Knowledge and reporting']}/>
            <ProductCard number={2} icon={MonitorCog} tone="blue" label="REMOTE MONITORING & MANAGEMENT" title="Know your devices. Take action."
              description="See the devices you manage, spot issues sooner and put remote support and software tasks close at hand."
              benefits={['Cross-platform device visibility','Monitoring, policies and automation','Remote access and software management']}/>
            <ProductCard number={3} icon={Globe2} tone="sky" label="SELF-SERVICE PORTAL" title="Make getting help simple."
              description="Give users a dedicated space to find information, raise requests and stay up to date without extra friction."
              benefits={['Branded customer-facing experience','Service catalogue and request tracking','Dedicated customer-portal address']}/>
          </div>
        </div>
      </section>
      <section className="h5m-section h5m-capabilities-section" id="capabilities" aria-labelledby="h5m-capabilities-title">
        <div className="h5m-container">
          <div className="h5m-section-intro h5m-section-intro-centered"><span className="h5m-eyebrow">MADE FOR THE WAY IT TEAMS WORK</span><h2 id="h5m-capabilities-title">One platform. <span>More clarity in every workflow.</span></h2><p>Explore the moments that connect people, services and endpoints.</p></div>
          <CapabilityExplorer/>
        </div>
      </section>
      <section className="h5m-section h5m-delivery" id="deployment" aria-labelledby="h5m-delivery-title">
        <div className="h5m-container h5m-delivery-grid">
          <div><span className="h5m-eyebrow">BUILT WITH FLEXIBILITY IN MIND</span><h2 id="h5m-delivery-title">Your platform.<br/><span>Your way to operate.</span></h2><p>Hi5Central is designed for dedicated customer workspaces, clear product boundaries and an update path that fits how your organisation operates.</p>
            <div className="h5m-delivery-note"><LockKeyhole size={20}/><span>Each customer gets their own named workspace. The self-service Portal lives at a separate <strong>customer-portal</strong> address.</span></div>
          </div>
          <div className="h5m-deployment-cards">
            <article><div><span className="h5m-delivery-icon"><Cloud size={21}/></span><span className="h5m-delivery-type">MANAGED</span></div><h3>Updates without the overhead.</h3><p>A Test environment for evaluating changes and a scheduled Production update path.</p><span className="h5m-delivery-tag"><Clock3 size={15}/> Scheduled update windows</span></article>
            <article><div><span className="h5m-delivery-icon"><ShieldCheck size={21}/></span><span className="h5m-delivery-type">CUSTOM</span></div><h3>More control over promotion.</h3><p>A separate UAT environment gives your team a review and approval stage before Production.</p><span className="h5m-delivery-tag"><CheckCircle2 size={15}/> Customer approval path</span></article>
          </div>
        </div>
      </section>
      <section className="h5m-section h5m-benefits-section" aria-labelledby="h5m-benefits-title">
        <div className="h5m-container">
          <div className="h5m-section-intro h5m-section-intro-centered"><span className="h5m-eyebrow">WHY HI5CENTRAL</span><h2 id="h5m-benefits-title">A connected view of IT. <span>A better experience for everyone.</span></h2></div>
          <div className="h5m-benefits-grid">
            <article><span><Layers3 size={24}/></span><h3>Built around your team</h3><p>Service, endpoint and self-service workflows that feel connected without becoming complicated.</p></article>
            <article><span><Headphones size={24}/></span><h3>Support stays personal</h3><p>Keep the customer conversation visible alongside the service work that resolves it.</p></article>
            <article><span><ShieldCheck size={24}/></span><h3>Control where it matters</h3><p>Structured roles, approvals and product boundaries support deliberate operations.</p></article>
            <article><span><Sparkles size={24}/></span><h3>Ready to evolve</h3><p>Start with the features you need and make room for new automation and integrations.</p></article>
          </div>
        </div>
      </section>
      <section className="h5m-section h5m-faq-section" id="questions" aria-labelledby="h5m-questions-title">
        <div className="h5m-container h5m-faq-grid">
          <div><span className="h5m-eyebrow"><CircleHelp size={16}/> GOOD TO KNOW</span><h2 id="h5m-questions-title">A few things you might be wondering.</h2><p>Useful answers before you create your workspace.</p></div>
          <div className="h5m-faq-list">{FAQ.map(item => <details key={item.question}><summary><span>{item.question}</span><ChevronDown size={20}/></summary><p>{item.answer}</p></details>)}</div>
        </div>
      </section>
      <section className="h5m-last-cta"><div className="h5m-container h5m-last-cta-inner"><div><span className="h5m-eyebrow">YOUR NEXT CHAPTER IN IT</span><h2>Bring your IT operations together.</h2><p>Start with ITSM, RMM or both. Build a workspace that works for your people.</p></div><a className="h5m-button h5m-button-white" href="/signup">Create your workspace <ArrowUpRight size={19}/></a></div></section>
    </main>
    <Footer/>
  </div>
}
