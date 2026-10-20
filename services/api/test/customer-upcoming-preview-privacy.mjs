import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {normaliseCustomerReleaseDraft,publishCustomerReleaseNotes}
 from '../src/customerReleasePreparation.js'
import {publicUpcomingPreview,publicUpcomingPreviews}
 from '../src/customerUpcomingPreview.js'

const sha='c5e91bfc0cd3984e33369714360ddbc0942191c7'
const publicNotes={
 versionLabel:'2026.10.21.1',title:'Incident workflow improvements',
 summary:'Improvements planned for incident ownership, activity and notifications.',
 entries:[{category:'improvement',title:'Clearer incident activity',
   description:'Make activity easier to follow.'}],
 upcomingVisible:true,
 internalNotes:'PRIVATE Dev implementation design, server key NEVER SHOW 123456789',
}
test('upcoming is opt-in; Dev internal notes persist only on private submission',()=>{
 const draft=normaliseCustomerReleaseDraft({sha,notes:publicNotes})
 assert.equal(draft.upcomingVisible,true)
 assert.equal(draft.internalNotes,publicNotes.internalNotes)
 assert.equal(normaliseCustomerReleaseDraft({sha,notes:{...publicNotes,upcomingVisible:false}}).upcomingVisible,false)
 assert.equal(normaliseCustomerReleaseDraft({sha,notes:{...publicNotes,upcomingVisible:'true'}}).upcomingVisible,false)
 assert.throws(()=>normaliseCustomerReleaseDraft({
  sha,notes:{...publicNotes,title:'',upcomingVisible:true},
 }),/customer title/)
 assert.throws(()=>normaliseCustomerReleaseDraft({
  sha,notes:{...publicNotes,summary:'',upcomingVisible:true},
 }),/summary/)
})
test('public preview is strict allowlist; never publish internal notes, SHA or private metadata',()=>{
 const row={status:'draft',notes:{...publicNotes,buildSha:sha,ciRunUrl:'https://private',
  authorEmail:'author@internal',secrets:{foo:'NEVER_SHOW'}}}
 const output=publicUpcomingPreview(row)
 assert.deepEqual(Object.keys(output),['title','summary','entries','status'])
 assert.deepEqual(Object.keys(output.entries[0]),['category','title','description'])
 assert.equal(output.status,'planned')
 const payload=JSON.stringify(output)
 for(const hidden of ['PRIVATE','NEVER SHOW','123456789',sha,'2026.10.21.1',
   'author@internal','https://private','internalNotes','upcomingVisible','ciRunUrl']){
  assert.equal(payload.includes(hidden),false,hidden)
 }
})
test('preview withdraws with opt-out or approval/rejection; only valid public content is served',()=>{
 const active={status:'draft',notes:publicNotes}
 assert.equal(publicUpcomingPreviews([
  active,{...active,status:'submitted'},{...active,status:'approved'},
  {...active,status:'rejected'},
  {...active,notes:{...publicNotes,upcomingVisible:false}},
  {...active,notes:{...publicNotes,entries:[]}},
 ]).length,2)
 assert.equal(publicUpcomingPreviews([active,active],{max:1}).length,1)
})
test('approval publication still strips private fields and preview controls',async()=>{
 const calls=[]
 const db={async query(sql,params){
  calls.push({sql:String(sql),params})
  if(String(sql).includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1}
  if(String(sql).includes('FROM hi5central_published_release_notes'))return {rows:[],rowCount:0}
  if(String(sql).includes('INSERT INTO hi5central_published_release_notes'))
   return {rows:[],rowCount:1}
  throw Error('Unexpected SQL '+sql)
 }}
 await publishCustomerReleaseNotes(db,{sha,notes:publicNotes})
 const insert=calls.find(x=>x.sql.includes('INSERT INTO hi5central_published_release_notes'))
 assert.ok(insert)
 const payload=JSON.stringify(insert.params)
 for(const hidden of ['PRIVATE','internalNotes','upcomingVisible','123456789'])
  assert.equal(payload.includes(hidden),false,hidden)
})
test('only Dev signed handoff can toggle preview; customer route filters draft columns',()=>{
 const handoff=readFileSync(new URL('../src/devReleaseHandoff.js',import.meta.url),'utf8')
 const routes=readFileSync(new URL('../src/applicationUpdates.js',import.meta.url),'utf8')
 const devUI=readFileSync(new URL('../../../apps/itsm/src/production/ProductionApplicationUpdates.jsx',import.meta.url),'utf8')
 const admin=readFileSync(new URL('../../../apps/admin/src/features/admin/CertifiedReleaseControls.jsx',import.meta.url),'utf8')
 assert.match(handoff,/Only an authenticated internal Dev author/)
 assert.match(handoff,/normaliseCustomerReleaseDraft/)
 assert.match(routes,/notes->>'upcomingVisible'='true'/)
 assert.match(routes,/publicUpcomingPreviews\(result\.rows\)/)
 assert.match(routes,/app.get\('\/api\/v1\/updates\/upcoming'/)
 assert.match(routes,/upcoming,latestPublished/)
 assert.match(devUI,/Show as an upcoming release to customers/)
 assert.match(devUI,/Internal developer notes/)
 assert.match(devUI,/update\('upcomingVisible',e\.target\.checked\)/)
 assert.match(devUI,/update\('internalNotes',e\.target\.value\)/)
 assert.match(devUI,/aria-label="Upcoming Hi5Central releases"/)
 assert.match(admin,/Private developer notes/)
 assert.match(admin,/current\.notes\.internalNotes/)
})
