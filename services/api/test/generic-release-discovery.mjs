import test from 'node:test'
import assert from 'node:assert/strict'
import {authorisedGenericReleaseStage,readGenericReleaseApprovals} from
 '../src/genericReleaseAuthorization.js'
import {previewGenericCertifiedRelease} from '../src/genericReleaseDiscovery.js'
import {fanoutCertifiedRelease} from '../src/certifiedReleaseFanout.js'

const sha='a'.repeat(40)
const user='a1aabcde-6755-498f-889a-8e8afced12a1'
const now=new Date('2026-10-17T07:00:00Z')
const past='2026-10-15T01:00:00Z'
const grant=stage=>({
 build_sha:sha,environment:stage,planning_enabled:true,execution_enabled:false,
 approved_by:user,approved_at:'2026-10-16T06:00:00Z',
 expires_at:'2026-10-19T06:00:00Z',evidence:{review:'PR test'},
})
const window={timezone:'Europe/London',start:'08:00',end:'22:00',
 days:['mon','tue','wed','thu','fri','sat','sun']}
const tenant=(slug,mode='hi5_managed')=>({
 id:slug==='managed'?'11111111-1111-4111-8111-111111111111':
 slug==='custom'?'22222222-2222-4222-8222-222222222222':
 '33333333-3333-4333-8333-333333333333',
 slug,status:'active',mode,itsm:true,test_auto_sync:true,
 uat_auto_stage:mode==='admin_controlled',live_auto_promote:mode==='hi5_managed',
 live_delay_hours:24,maintenance_window:window,blackout_periods:[],
})
const tenants=[tenant('managed'),tenant('custom','admin_controlled'),
 tenant('managed-disabled')]
tenants[2].test_auto_sync=false

function mockDb({approved=[],jobsByTenant={},offersByTenant={},gate=null,missingApprovals=false}={}){
 const statements=[]
 const db={statements,query:async(sql,params=[])=>{
  statements.push(String(sql))
  const q=String(sql)
  if(q.includes('FROM platform_certified_application_releases c')&&q.includes('JOIN hi5central_published_release_notes'))
   return {rowCount:1,rows:[{build_sha:sha,status:'approved',
    published_at:past,approved_at:past,approved_by:user,
    version_label:'0.2.0',evidence:{build:true,ci:true,security:true,migrations:true,smoke:true}}]}
  if(q.includes("to_regclass('public.platform_release_generic_stage_approvals')"))
   return {rows:[{approvals:missingApprovals?null:'platform_release_generic_stage_approvals'}]}
  if(q.includes('FROM platform_release_generic_stage_approvals'))
   return {rows:approved}
  if(q.includes('FROM platform_release_test_qa_gates'))
   return {rows:gate?[gate]:[]}
  if(q.includes('FROM tenants t')&&q.includes('JOIN tenant_settings ts')){
   const cursor=params[1]
   const ordered=tenants.filter(t=>!cursor||t.id>cursor).slice(0,params[0])
   return {rows:ordered}
  }
  if(q.includes('FROM tenant_release_rollout_jobs WHERE tenant_id='))
   return {rows:jobsByTenant[params[0]]||[]}
  if(q.includes('FROM tenant_runtime_update_offers WHERE tenant_id='))
   return {rows:offersByTenant[params[0]]||[]}
  throw Error('Unexpected SQL in generic release test: '+q.slice(0,170))
 }}
 return db
}

test('stage approvals fail closed without human identity, valid interval and exact SHA',()=>{
 assert.equal(authorisedGenericReleaseStage({approval:null,sha,stage:'test',now}).allowed,false)
 assert.equal(authorisedGenericReleaseStage({approval:{...grant('test'),approved_by:null},sha,stage:'test',now}).allowed,false)
 assert.equal(authorisedGenericReleaseStage({approval:{...grant('test'),build_sha:'b'.repeat(40)},sha,stage:'test',now}).allowed,false)
 assert.equal(authorisedGenericReleaseStage({approval:{...grant('test'),expires_at:'2026-10-16'},sha,stage:'test',now}).allowed,false)
 assert.equal(authorisedGenericReleaseStage({approval:grant('test'),sha,stage:'live',now}).allowed,false)
 assert.equal(authorisedGenericReleaseStage({approval:grant('test'),sha,stage:'test',now}).allowed,true)
})

test('schema absent always means NO generic authorisations',async()=>{
 const db=mockDb({missingApprovals:true})
 assert.deepEqual(await readGenericReleaseApprovals(db,{sha}),{})
 assert.equal(db.statements.some(s=>s.includes('FROM platform_release_generic_stage_approvals')),false)
})

test('generic preview pages all tenant IDs and does not write any DB data',async()=>{
 const db=mockDb()
 const p=await previewGenericCertifiedRelease(db,{sha,now,limit:1})
 assert.equal(p.scanned,3)
 assert.equal(p.eligible,0)
 assert.equal(p.approvalBlocked,2)
 assert.equal(p.policyBlocked,1)
 assert.deepEqual(p.tenants.map(t=>t.slug),['managed','custom','managed-disabled'])
 assert.deepEqual(p.tenants.map(t=>t.status),
  ['approval_required','approval_required','blocked'])
 assert.ok(db.statements.every(s=>/^(SELECT|\s*SELECT)/.test(s.trim())))
})

test('explicit approved TEST scope yields two schedulable tenants only',async()=>{
 const db=mockDb({approved:[grant('test')]})
 const p=await previewGenericCertifiedRelease(db,{sha,now,limit:2})
 assert.equal(p.eligible,2)
 assert.equal(p.tenants[0].proposedStage,'test')
 assert.equal(p.tenants[1].proposedStage,'test')
 assert.ok(p.tenants[0].proposedAt.endsWith('Z'))
 assert.equal(p.tenants[2].status,'blocked')
 assert.equal(p.stageApprovals.live.allowed,false)
})

test('CUSTOM next stage is UAT and never LIVE before acceptance',async()=>{
 const custom=tenants[1]
 const job={environment:'test',build_sha:sha,status:'succeeded',
  completed_at:'2026-10-16T08:00:00Z'}
 const db=mockDb({approved:[grant('uat')],jobsByTenant:{[custom.id]:[job]}})
 const p=await previewGenericCertifiedRelease(db,{sha,now})
 assert.equal(p.tenants.find(t=>t.slug==='custom').status,'eligible')
 assert.equal(p.tenants.find(t=>t.slug==='custom').proposedStage,'uat')
 assert.equal(p.tenants.find(t=>t.slug==='managed').status,'approval_required')
})

test('generic write fanout refuses when no staff-approved stage; no SQL mutations',async()=>{
 const db={queries:[],query:async(sql)=>{
  db.queries.push(sql)
  if(String(sql).includes('to_regclass'))return {rows:[{approvals:null}]}
  throw Error('Unexpected database action')
 }}
 await assert.rejects(fanoutCertifiedRelease(db,{sha,scope:'generic'}),
  /No explicit staff-approved generic release planning stage/)
 assert.equal(db.queries.length,1)
})

test('QA release cohort still requires an explicit tenant allowlist',async()=>{
 const db={query:async()=>{throw Error('DB must never be queried')}}
 await assert.rejects(fanoutCertifiedRelease(db,{sha,scope:'qa',qaTenantSlugs:null}),
  /explicit nonempty tenant allowlist/)
})
