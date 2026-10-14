import { pool } from './db.js'
import { qa26BillingAuth } from './qa26DemoBilling.js'
import { qa26DemoBillingPortalHtml } from './qa26DemoBillingPortal.js'

const DAY=86400000
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QA=new Set(['h5c-managed-qa26','h5c-custom-qa26'])
const modBool=(value,key)=>Boolean(value&&typeof value==='object'&&value[key]===true)

export async function qa26DemoAccountView(tenantId,slug,db=pool,now=new Date()) {
  if(!QA.has(slug)||!UUID.test(tenantId))return null
  const result=await db.query(
    "SELECT t.created_at,ts.modules,a.example_itsm,a.example_rmm,a.fake_paid_plan,a.extension_days"+
    " FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id"+
    " LEFT JOIN qa26_demo_account_state a ON a.tenant_id=t.id"+
    " WHERE t.id=$1 AND t.slug=$2",[tenantId,slug])
  if(!result.rowCount)return null
  const r=result.rows[0]
  const started=new Date(r.created_at).getTime(),originalEnd=started+30*DAY
  const extensionDays=Number(r.extension_days)||0
  const ends=originalEnd+extensionDays*DAY,nowMs=new Date(now).getTime()
  const remaining=Math.max(0,Math.ceil((ends-nowMs)/DAY))
  const daysElapsed=Math.max(0,Math.floor((nowMs-started)/DAY))
  const itsm=r.example_itsm??modBool(r.modules,'itsm')
  const rmm=r.example_rmm??modBool(r.modules,'rmm')
  const logs=await db.query('SELECT kind,fake_sent_at FROM qa26_demo_reminder_log WHERE tenant_id=$1',[tenantId])
  const delegates=await db.query(
    "SELECT b.user_id AS id,u.email,u.name,b.granted_at FROM qa26_demo_billing_delegates b"+
    " JOIN users u ON u.id=b.user_id JOIN tenant_memberships m ON m.tenant_id=b.tenant_id"+
    " AND m.user_id=b.user_id AND m.status='active' WHERE b.tenant_id=$1 ORDER BY b.granted_at",[tenantId])
  const fakePaid=r.fake_paid_plan===true
  return {
    demo:true,realPayments:false,commercialSettingsChanged:false,
    tenant:{id:tenantId,slug},
    trial:{daysTotal:30,daysElapsed,daysRemaining:fakePaid?null:remaining,
      startedAt:new Date(started).toISOString(),originalEndsAt:new Date(originalEnd).toISOString(),
      endsAt:new Date(ends).toISOString(),expired:!fakePaid&&nowMs>=ends,
      extended:extensionDays===14,canRestore:!fakePaid&&nowMs>=originalEnd
        &&extensionDays===0&&nowMs<=originalEnd+30*DAY,upgradedToPaidDemo:fakePaid},
    modules:{itsm,rmm,availableToAdd:['itsm','rmm'].filter(key=>!(key==='itsm'?itsm:rmm))},
    topology:{itsmReleasePolicy:'managed-or-custom-based-on-ITSM-plan',
      rmmManagement:'single-managed-portal',rmmPortals:1,rmmHasUat:false,rmmHasTest:false},
    billingAdmins:delegates.rows.map(d=>({id:d.id,email:d.email,name:d.name,grantedAt:d.granted_at})),
    reminders:{day14:{day:14,due:daysElapsed>=14&&!fakePaid},
      day30:{day:30,due:daysElapsed>=30&&!fakePaid},
      fakeEvents:logs.rows.map(d=>({kind:d.kind,fakeSentAt:d.fake_sent_at})),
      emailsActuallySent:0,deliveryMode:'PREVIEW_ONLY'},
    banner:fakePaid?'FAKE UPGRADE COMPLETE - No money moved'
      :remaining>0?'30-day QA trial: '+remaining+' day'+(remaining===1?'':'s')+' remaining'
      :'QA trial expired - one-time 14-day extension available',
  }
}
function isWrite(c,session) {
  const origin=String(c.req.header('origin')||'').toLowerCase()
  const allowed=new Set(['https://'+session.slug+'.hi5central.com',
    'https://'+session.slug+'-admin.hi5central.com'])
  return allowed.has(origin)&&String(c.req.header('content-type')||'').startsWith('application/json')
}
const parseBody=c=>c.req.json().catch(()=>null)
export function registerQa26DemoControlPlaneRoutes(app,resolveSession,db=pool){
  async function verify(c,ownerOnly=false){
    const auth=await qa26BillingAuth(c,resolveSession,db)
    if(auth.error)return auth
    if(ownerOnly&&!auth.isOwner)return {error:c.json({error:'Tenant owner approval required.'},403)}
    return auth
  }
  app.get('/qa26/demo-portal',c=>{
    c.header('Cache-Control','no-store')
    c.header('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return c.html(qa26DemoBillingPortalHtml)
  })
  app.get('/api/v1/qa26/demo-account',async c=>{
    const auth=await verify(c)
    if(auth.error)return auth.error
    const account=await qa26DemoAccountView(auth.session.tenant_id,auth.session.slug,db)
    if(!account)return c.json({error:'QA account unavailable.'},404)
    return c.json({...account,access:{owner:auth.isOwner,billingAdmin:auth.isBillingAdmin||auth.isOwner}})
  })
  app.post('/api/v1/qa26/demo-account/add-module',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(!isWrite(c,auth.session))return c.json({error:'QA origin and JSON required.'},403)
    const body=await parseBody(c)
    if(!['rmm','itsm'].includes(body?.module))return c.json({error:'Choose ITSM or RMM.'},400)
    const view=await qa26DemoAccountView(auth.session.tenant_id,auth.session.slug,db)
    if(!view)return c.json({error:'QA account unavailable.'},404)
    const itsm=view.modules.itsm||body.module==='itsm',rmm=view.modules.rmm||body.module==='rmm'
    await db.query(
      "INSERT INTO qa26_demo_account_state(tenant_id,example_itsm,example_rmm) VALUES($1,$2,$3)"+
      " ON CONFLICT(tenant_id) DO UPDATE SET example_itsm=qa26_demo_account_state.example_itsm OR EXCLUDED.example_itsm,"+
      " example_rmm=qa26_demo_account_state.example_rmm OR EXCLUDED.example_rmm,updated_at=now()",
      [auth.session.tenant_id,itsm,rmm])
    return c.json({demo:true,realEntitlementChanged:false,moduleAdded:body.module,
      rmmHasUat:false,rmmHasTest:false,rmmPortalCount:1})
  })
  app.post('/api/v1/qa26/demo-account/activate',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(!isWrite(c,auth.session))return c.json({error:'QA origin and JSON required.'},403)
    const view=await qa26DemoAccountView(auth.session.tenant_id,auth.session.slug,db)
    if(!view)return c.json({error:'QA account unavailable.'},404)
    await db.query(
      "INSERT INTO qa26_demo_account_state(tenant_id,example_itsm,example_rmm,fake_paid_plan)"+
      " VALUES($1,$2,$3,true) ON CONFLICT(tenant_id) DO UPDATE SET fake_paid_plan=true,updated_at=now()",
      [auth.session.tenant_id,view.modules.itsm,view.modules.rmm])
    return c.json({demo:true,fakePaidPlan:true,stripeCalled:false,moneyTaken:false})
  })
  app.post('/api/v1/qa26/demo-account/extend',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(!isWrite(c,auth.session))return c.json({error:'QA origin and JSON required.'},403)
    const view=await qa26DemoAccountView(auth.session.tenant_id,auth.session.slug,db)
    if(!view?.trial.canRestore)return c.json({error:'One-time restoration is available after QA trial expiry only.'},409)
    const result=await db.query(
      "INSERT INTO qa26_demo_account_state(tenant_id,example_itsm,example_rmm,extension_days)"+
      " VALUES($1,$2,$3,14) ON CONFLICT(tenant_id) DO UPDATE SET extension_days=14,updated_at=now()"+
      " WHERE qa26_demo_account_state.extension_days=0 RETURNING tenant_id",
      [auth.session.tenant_id,view.modules.itsm,view.modules.rmm])
    if(!result.rowCount)return c.json({error:'Restoration already used.'},409)
    return c.json({demo:true,extensionDays:14,realSubscriptionChanged:false})
  })
  app.post('/api/v1/qa26/demo-account/billing-admins',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(!isWrite(c,auth.session))return c.json({error:'QA origin and JSON required.'},403)
    const body=await parseBody(c)
    const email=String(body?.email||'').trim().toLowerCase()
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||email.length>254)
      return c.json({error:'Enter a valid existing tenant member email.'},400)
    const result=await db.query(
      "INSERT INTO qa26_demo_billing_delegates(tenant_id,user_id,granted_by)"+
      " SELECT m.tenant_id,m.user_id,$2 FROM tenant_memberships m JOIN users u ON u.id=m.user_id"+
      " WHERE m.tenant_id=$1 AND lower(u.email)=$3 AND m.status='active'"+
      " ON CONFLICT(tenant_id,user_id) DO NOTHING RETURNING user_id",
      [auth.session.tenant_id,auth.session.user_id,email])
    if(!result.rowCount){
      const found=await db.query(
        "SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id"+
        " WHERE m.tenant_id=$1 AND lower(u.email)=$2 AND m.status='active'",
        [auth.session.tenant_id,email])
      if(!found.rowCount)return c.json({error:'Invite them through People first. Only existing active tenant members may be added.'},404)
    }
    return c.json({demo:true,role:'billing_admin',onlyDemoBillingAccess:true})
  })
  app.delete('/api/v1/qa26/demo-account/billing-admins/:id',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(c.req.header('origin')!=='https://'+auth.session.slug+'-admin.hi5central.com')
      return c.json({error:'Tenant billing origin required.'},403)
    const id=c.req.param('id')
    if(!UUID.test(id))return c.json({error:'Invalid user ID.'},400)
    await db.query('DELETE FROM qa26_demo_billing_delegates WHERE tenant_id=$1 AND user_id=$2',
      [auth.session.tenant_id,id])
    return c.json({demo:true,revoked:true,otherPermissionsUnaffected:true})
  })
  app.post('/api/v1/qa26/demo-account/reminder',async c=>{
    const auth=await verify(c,true)
    if(auth.error)return auth.error
    if(!isWrite(c,auth.session))return c.json({error:'QA origin and JSON required.'},403)
    const body=await parseBody(c)
    if(!['day14_checkin','day30_expired','extension_granted'].includes(body?.kind))
      return c.json({error:'Invalid example reminder.'},400)
    await db.query(
      'INSERT INTO qa26_demo_reminder_log(tenant_id,kind) VALUES($1,$2) ON CONFLICT(tenant_id,kind) DO NOTHING',
      [auth.session.tenant_id,body.kind])
    return c.json({demo:true,previewOnly:true,emailActuallySent:false,kind:body.kind})
  })
}
