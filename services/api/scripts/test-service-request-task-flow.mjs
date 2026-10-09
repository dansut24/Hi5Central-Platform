import assert from 'node:assert/strict'
import { syncServiceRequestTaskFlow, unlockDependentRequestTasks } from '../src/serviceRequestTaskFlow.js'

// Run: node scripts/test-service-request-task-flow.mjs
// Deterministic transaction-level tests, no network or database required.
const tenant='00000000-0000-4000-8000-000000000001'
const request='00000000-0000-4000-8000-000000000002'
const actor='00000000-0000-4000-8000-000000000003'
function fakeDb({status='In Progress',pending=0,total=2,done=2,taskNotes=[]}={}) {
  const queries=[]
  return {queries,async query(sql,params) {
    queries.push({sql,params})
    if(sql.includes('SELECT id,status,operational_data FROM service_requests')) return {rows:[{id:request,status,operational_data:{}}]}
    if(sql.includes('FROM service_request_approvals')) return {rows:[{pending}]}
    if(sql.includes('count(*) FILTER (WHERE status=')) return {rows:[{total,done}]}
    if(sql.includes('SELECT external_key,title,completion_notes')) return {rows:taskNotes}
    return {rows:[]}
  }}
}
async function run(label,config,taskStatus,expectedStatus,expectedChanged) {
  const db=fakeDb(config)
  const result=await syncServiceRequestTaskFlow(db,{
    tenantId:tenant,requestId:request,actorUserId:actor,
    actorSnapshot:{name:'Test Technician'},triggeringTaskKey:'REQ-001-T01',taskStatus,
  })
  assert.equal(result?.status||null,expectedStatus,label+' state')
  assert.equal(result?.changed??null,expectedChanged,label+' changed')
  const update=db.queries.find(item=>item.sql.includes('UPDATE service_requests SET'))
  if(expectedChanged) {
    assert.ok(update,label+' parent updated')
    assert.equal(update.params[1],expectedStatus)
    const history=db.queries.find(item=>item.sql.includes('INSERT INTO service_request_activities'))
    assert.ok(history,label+' history persisted')
    assert.equal(JSON.parse(history.params[6]).taskKey,'REQ-001-T01')
  } else assert.equal(update,undefined,label+' no unsafe update')
  console.log('PASS '+label)
}
await run('final task completes parent request',
  {status:'In Progress',total:2,done:2,taskNotes:[
    {external_key:'REQ-001-T01',title:'Prepare',completion_notes:'Prepared'},
    {external_key:'REQ-001-T02',title:'Deploy',completion_notes:'Installed'},
  ]},'Completed','Completed',true)
await run('partial work moves Approved request into progress',
  {status:'Approved',total:3,done:1},'Completed','In Progress',true)
await run('started task moves New request into progress',
  {status:'New',total:2,done:0},'In Progress','In Progress',true)
await run('already in progress is unchanged',
  {status:'In Progress',total:3,done:1},'In Progress','In Progress',false)
await run('pending approval prevents automatic advancement',
  {status:'New',pending:1,total:1,done:1},'Completed',null,null)
await run('rejected request stays rejected',
  {status:'Rejected',total:1,done:1},'Completed',null,null)
await run('closed request never reopens',
  {status:'Closed',total:1,done:1},'Completed',null,null)
{
  const db=fakeDb()
  await unlockDependentRequestTasks(db,request)
  assert.equal(db.queries.length,1)
  assert.match(db.queries[0].sql,/candidate.status='Waiting'/)
  assert.match(db.queries[0].sql,/previous.status<>'Completed'/)
  assert.deepEqual(db.queries[0].params,[request])
  console.log('PASS dependent tasks unlock only after predecessors complete')
}
console.log('Service Request task flow regression cases: 8/8')
