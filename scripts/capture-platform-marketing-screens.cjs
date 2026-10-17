// Screenshot ACTUAL Platform ITSM/RMM components with locally intercepted,
// synthetic session/records. Zero live customer API calls or customer data.
// Output assets are committed only to a draft marketing-review branch.
// Marketing copy must label these "Actual Platform UI · sample data".
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const out = path.resolve('apps/itsm/public/marketing')
fs.mkdirSync(out,{recursive:true})
const now='2026-10-17T09:00:00Z'
const tenant={id:'00000000-0000-4000-8000-000000000001',slug:'showcase',companyName:'Example IT Services',status:'active',type:'managed'}
const session={
 authenticated:true,tenant,
 user:{id:'00000000-0000-4000-8000-000000000002',name:'Alex Taylor',email:'alex@example.invalid',tenantRole:'owner'},
 onboarding:{completedAt:now,data:{theme:{mode:'light',brandName:'Example IT Services'}}},
 userExperience:{firstLoginCompletedAt:now,platformCoachmarksCompletedAt:now,platformGettingStartedDismissedAt:now},
 platformAccess:{itsm:true,rmm:true,portal:true,admin:true},
 access:{permissions:['*'],effectivePermissions:['*']},
 security:{mfaVerified:true},
 settings:{theme:{mode:'light',brandName:'Example IT Services'}},
 preferences:{appearance:{theme:'light',density:'comfortable'},navigation:{sidebarMode:'expanded'}},
}
const queueItems=[
 {id:'INC-1048',type:'Incident',title:'VPN connection unavailable',category:'Connectivity',status:'In Progress',priority:'High',requester:'Morgan Ellis',team:'Service Desk',assignee:'Alex Taylor',service:'Remote Access',updatedAt:now,createdAt:now},
 {id:'INC-1046',type:'Incident',title:'Laptop intermittently disconnects',category:'Hardware',status:'New',priority:'Medium',requester:'Jamie Clarke',team:'Service Desk',assignee:'Avery Chen',service:'Workplace',updatedAt:now,createdAt:now},
 {id:'INC-1045',type:'Incident',title:'Mailbox synchronisation delay',category:'Email',status:'Waiting',priority:'Medium',requester:'Taylor Fox',team:'Messaging',assignee:'Alex Taylor',service:'Email',updatedAt:now,createdAt:now},
 {id:'INC-1042',type:'Incident',title:'Shared printer queue error',category:'Printing',status:'Resolved',priority:'Low',requester:'Riley Brooks',team:'Service Desk',assignee:'Avery Chen',service:'Printing',updatedAt:now,createdAt:now},
]
const devices=[
 {reference:'DEV-1001',name:'LAPTOP-024',platform:'Windows',operating_system:'Windows 11',os_version:'24H2',agent_device_id:'sample-agent-01',agent_online:true,agent_cpu_percent:22,agent_memory_used_percent:43,agent_disk_used_percent:61,agent_patch_total_count:25,agent_patch_current_count:24,agent_patch_pending_count:1,assigned_person_name:'Alex Taylor',assigned_site_name:'Head Office',compliance_state:'compliant'},
 {reference:'DEV-1002',name:'DESKTOP-018',platform:'Windows',operating_system:'Windows 11',os_version:'24H2',agent_device_id:'sample-agent-02',agent_online:true,agent_cpu_percent:12,agent_memory_used_percent:51,agent_disk_used_percent:39,assigned_person_name:'Jamie Clarke',assigned_site_name:'Head Office',compliance_state:'compliant'},
 {reference:'DEV-1003',name:'MACBOOK-011',platform:'macOS',operating_system:'macOS',os_version:'15',agent_device_id:'sample-agent-03',agent_online:false,assigned_person_name:'Morgan Ellis',assigned_site_name:'Remote',compliance_state:'unknown'},
 {reference:'DEV-1004',name:'LINUX-VM-02',platform:'Linux',operating_system:'Ubuntu',os_version:'26.04',agent_device_id:'sample-agent-04',agent_online:true,assigned_person_name:'IT Operations',assigned_site_name:'Cloud',compliance_state:'compliant'},
]
function syntheticReply(url) {
 const u=new URL(url),name=u.pathname
 if(name.endsWith('/auth/session')||name.endsWith('/onboarding/session'))return session
 if(name.includes('/auth/tenant-state/'))return {managed:true,slug:'showcase',companyName:tenant.companyName,status:'active'}
 if(name.includes('/itsm-queue/saved-views'))return {items:[]}
 if(name.includes('/itsm-queue'))return {items:queueItems,total:queueItems.length,filters:{statuses:['New','In Progress','Waiting','Resolved'],priorities:['Low','Medium','High'],teams:['Service Desk','Messaging'],assignees:['Alex Taylor','Avery Chen'],services:['Remote Access','Email','Workplace']}}
 if(name.endsWith('/rmm/devices'))return {devices}
 if(name.endsWith('/organisation'))return {sites:[{id:'sample-site',name:'Head Office',active:true}]}
 if(name.endsWith('/auth/preferences')||name.includes('/user-experience'))return {preferences:session.preferences,userExperience:session.userExperience}
 // All other fetches remain local synthetic responses; NO live API requests.
 return {items:[],devices:[],sites:[],records:[],tickets:[],total:0,data:{}}
}
async function mockApi(page) {
 let seen=0
 await page.route('**/api/**', async route=>{
  const response=syntheticReply(route.request().url())
  if(seen++ < 24) console.log('Mocked API (specific): '+route.request().url().slice(0,170))
  await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(response)})
 })
 // Prevent unexpected third-party requests and data leaking from CI browser.
 await page.route('**/*',async route=>{
  const url=route.request().url()
  if(url.startsWith('http://showcase.hi5central.com:4173/')||
     url.startsWith('http://showcase-rmm.hi5central.com:4174/')||
     url.startsWith('data:')||url.startsWith('blob:')) return route.continue()
  // API was previously handled by first-registered route above.
  if(url.includes('/api/')){
    if(seen++ < 24) console.log('Mocked API (catch-all): '+url.slice(0,170))
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(syntheticReply(url))})
  }
  return route.abort('blockedbyclient')
 })
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--host-resolver-rules=MAP showcase.hi5central.com 127.0.0.1, MAP showcase-rmm.hi5central.com 127.0.0.1']})
 try{
  for(const entry of [
    {name:'itsm',url:'http://showcase.hi5central.com:4173/incidents',marker:/Incidents|All Records|Service Desk|VPN connection/i},
    {name:'rmm',url:'http://showcase-rmm.hi5central.com:4174/',marker:/LAPTOP-024|Devices|RMM|Endpoint/i},
  ]){
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1,colorScheme:'light'})
    page.on('pageerror',e=>console.log('Platform '+entry.name+' JS notice: '+String(e.message).slice(0,180)))
    page.on('console',m=>{if(m.type()==='error')console.log('Platform '+entry.name+' console error: '+m.text().slice(0,280))})
    page.on('requestfailed',req=>console.log('Platform '+entry.name+' failed request: '+req.url().slice(0,170)))
    page.on('response',response=>{if(response.status()>=400) console.log('Platform '+entry.name+' HTTP '+response.status()+' '+response.url().slice(0,220))})
    await mockApi(page)
    await page.goto(entry.url,{waitUntil:'domcontentloaded',timeout:40000})
    console.log('Platform '+entry.name+' preview runtime: '+JSON.stringify(await page.evaluate(()=>({base:window.__HI5_API_BASE__,env:window.__HI5_CONFIG__?.runtimeEnvironment,host:window.location.host}))))
    await page.waitForTimeout(5500)
    const text=await page.locator('body').innerText()
    console.log(entry.name+' sample visible UI: '+text.slice(0,400).replace(/\s+/g,' '))
    await page.screenshot({path:path.join(out,'platform-'+entry.name+'-sample.png'),fullPage:false,animations:'disabled'})
    assert.match(text,entry.marker,entry.name+' must render real Platform interface, not a blank or login screen')
    assert(!/Could not restore this session|Sign in again|Welcome back to|Tenant unavailable/i.test(text.slice(0,500)),entry.name+' UI is not an authenticated demo surface')
    console.log('PASS: captured genuine '+entry.name+' Platform UI with exclusively synthetic sample data')
    await page.close()
  }
 }finally{await browser.close()}
})().catch(e=>{console.error('BLOCKED: '+e.message);process.exit(1)})
