import assert from 'node:assert/strict'
import test from 'node:test'
import { itsmAuditValueChanges } from '../src/itsmAuditValueDisplay.js'
import { recordItsmConfigurationChange,listItsmConfigurationChanges } from '../src/itsmConfigurationChanges.js'

const tenantId='11111111-1111-4111-8111-111111111111'
const actorUserId='22222222-2222-4222-8222-222222222222'
const saved={projects:{showMilestones:true,requireOwner:true}}
const edited={projects:{showMilestones:false,requireOwner:true}}

test('Show milestones was turned off: previous On and new Off are recorded',()=>{
 const result=itsmAuditValueChanges(saved,edited,['projects.showMilestones'])
 assert.deepEqual(result,[{
   path:'projects.showMilestones',kind:'boolean',
   before:true,after:false,beforeSource:'saved',
 }])
})

test('Missing persisted showMilestones uses documented built-in On default',()=>{
 const result=itsmAuditValueChanges({projects:{}},{projects:{showMilestones:false}},
   ['projects.showMilestones'])
 assert.deepEqual(result,[{
   path:'projects.showMilestones',kind:'boolean',
   before:true,after:false,beforeSource:'default',
 }])
})

test('Numeric SLA changes may show safe bounded values, never full policy bodies',()=>{
 const result=itsmAuditValueChanges(
   {slaTargets:{High:{responseMinutes:'30',resolutionMinutes:'480'}}},
   {slaTargets:{High:{responseMinutes:'45',resolutionMinutes:'480'}}},
   ['slaTargets.High.responseMinutes'])
 assert.deepEqual(result,[{
   path:'slaTargets.High.responseMinutes',kind:'number',
   before:'30',after:'45',beforeSource:'saved',
 }])
})

test('Only whitelisted primitive values can enter persistent value summaries',()=>{
 const input={
  projects:{showMilestones:true},
  supportEmail:'secret-contact@example.org',
  webhookEndpoint:'https://token:secret@example.org/callback',
  token:'private-token-dont-store',
  slaTargets:{High:{responseMinutes:'30'}},
 }
 const output={
  projects:{showMilestones:false},
  supportEmail:'another-contact@example.org',
  webhookEndpoint:'https://secret2@example.org/callback',
  token:'private-new-token-dont-store',
  slaTargets:{High:{responseMinutes:'long-secret-string'}},
 }
 const actual=itsmAuditValueChanges(input,output,[
  'projects.showMilestones','supportEmail','webhookEndpoint','token',
  'slaTargets.High.responseMinutes','integrations.secret',
 ])
 assert.deepEqual(actual,[{
  path:'projects.showMilestones',kind:'boolean',before:true,after:false,beforeSource:'saved',
 }])
 const encoded=JSON.stringify(actual)
 for(const secret of ['secret-contact','secret2','private-token','private-new-token','long-secret'])
   assert(!encoded.includes(secret),secret)
})

test('Hash-only historic rows stay value-free and new value summaries are stored atomically',async()=>{
 const calls=[]
 const db={query:async(sql,params)=>{
   calls.push({sql,params})
   return {rows:sql.includes('INSERT')?[{id:'event'}]:[{id:'past',valueChanges:[]}]}
 }}
 const result=await recordItsmConfigurationChange({
  db,tenantId,actorUserId,environment:'uat',before:saved,after:edited,
  changedPaths:['projects.showMilestones'],
 })
 assert.equal(result.recorded,true)
 assert.equal(calls.length,1)
 assert.match(calls[0].sql,/value_changes/)
 assert.deepEqual(JSON.parse(calls[0].params[7]),[{
   path:'projects.showMilestones',kind:'boolean',before:true,after:false,beforeSource:'saved',
 }])
 const rows=await listItsmConfigurationChanges({db,tenantId,environment:'uat'})
 assert.deepEqual(rows,[{id:'past',valueChanges:[]}])
 assert.match(calls[1].sql,/value_changes AS "valueChanges"/)
 const old=await recordItsmConfigurationChange({db,tenantId,actorUserId,
  environment:'uat',before:{supportEmail:'a'},after:{supportEmail:'b'}})
 assert.deepEqual(old.valueChanges,[])
})

test('Missing previous value is never invented for an unknown boolean default',()=>{
 const result=itsmAuditValueChanges({}, {catalogue:{enabled:false}}, ['catalogue.enabled'])
 assert.deepEqual(result,[{
  path:'catalogue.enabled',kind:'boolean',before:null,after:false,beforeSource:'unknown',
 }])
})
