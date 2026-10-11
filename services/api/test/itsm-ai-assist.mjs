import assert from 'node:assert/strict'
import {aiEnabledInEnvironment,summariseRecordViaProvider,hasAiPilotAccess,loadAiRecord} from '../src/itsmAiAssist.js'
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:false}},'uat'),false)
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:true}},'uat'),true)
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:false}},'live'),false)
assert.equal(aiEnabledInEnvironment({},'test'),true)
const testing={slug:'testing'}
const testingUat={slug:'testing-uat'}
const testingTest={slug:'testing-test'}
const other={slug:'other-customer'}
assert.equal(hasAiPilotAccess(testingUat,'uat',{ITSM_AI_PILOT_TENANT_SLUG:'testing'}),true)
assert.equal(hasAiPilotAccess(testingTest,'test',{ITSM_AI_PILOT_TENANT_SLUG:'testing'}),true)
assert.equal(hasAiPilotAccess(testing,'live',{ITSM_AI_PILOT_TENANT_SLUG:'testing'}),false,
  'Enabling AI in UAT must not enable it in Production.')
assert.equal(hasAiPilotAccess(testing,'live',{ITSM_AI_LIVE_PILOT_TENANT_SLUG:'testing'}),false,
  'Production must require an independent explicit enabled switch.')
assert.equal(hasAiPilotAccess(testing,'live',{ITSM_AI_LIVE_PILOT_TENANT_SLUG:'testing',ITSM_AI_LIVE_PILOT_ENABLED:'true'}),true)
assert.equal(hasAiPilotAccess(other,'live',{ITSM_AI_LIVE_PILOT_TENANT_SLUG:'testing',ITSM_AI_LIVE_PILOT_ENABLED:'true'}),false)
assert.equal(hasAiPilotAccess(testing,'live',{ITSM_AI_LIVE_PILOT_TENANT_SLUG:'testing',ITSM_AI_LIVE_PILOT_ENABLED:'false'}),false)
assert.equal(hasAiPilotAccess(testing,'dev',{ITSM_AI_LIVE_PILOT_TENANT_SLUG:'testing',ITSM_AI_LIVE_PILOT_ENABLED:'true'}),false)

const tenantId='00000000-0000-4000-a000-000000000001'
const otherTenantId='00000000-0000-4000-a000-000000000002'
const databaseRows=[
  {tenant_id:tenantId,reference:'INC-1234',record_type:'Incident',title:'Authoritative VPN outage',description:'Stored description',status:'New',priority:'High',category:'Network'},
  {tenant_id:otherTenantId,reference:'INC-9988',record_type:'Incident',title:'Private other tenant incident',description:'Not visible',status:'New',priority:'High',category:'Network'},
]
let queryCount=0
const fakeDb={async query(sql,params){
  queryCount++
  assert.match(sql,/FROM itsm_records/)
  assert.match(sql,/tenant_id\s*=\s*\$1/)
  assert.match(sql,/upper\(reference\)\s*=\s*upper\(\$2\)/)
  const [tenant,reference]=params
  const row=databaseRows.find(r=>r.tenant_id===tenant&&r.reference.toUpperCase()===reference.toUpperCase())
  return {rows:row?[row]:[]}
}}
const own=await loadAiRecord(tenantId,'INC-1234',{db:fakeDb})
assert.equal(own.title,'Authoritative VPN outage')
assert.equal((await loadAiRecord(tenantId,'INC-9988',{db:fakeDb})),null,
  'Cross-tenant record must not be accessible by reference.')
assert.equal((await loadAiRecord(tenantId,'INC-000000',{db:fakeDb})),null,
  'Fabricated record references must not produce provider context.')
assert.equal(queryCount,3)

let request
const transport=async (url,options)=>{
  request={url,options,body:JSON.parse(options.body)}
  return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Issue: VPN inaccessible.\nNext steps: Check gateway.'}]}]})}
}
const item={reference:'INC-1234',record_type:'Incident',title:'VPN outage',description:'Remote access affected',status:'New',priority:'High'}
const a=await summariseRecordViaProvider(item,{apiKey:'unit-test-token',model:'gpt-4.1-mini',transport})
assert.match(a.summary,/VPN inaccessible/)
assert.equal(a.saved,false)
assert.equal(request.body.store,false)
assert.equal(request.body.model,'gpt-4.1-mini')
assert.ok(request.body.input[0].content.includes('VPN outage'))
assert.equal(request.options.headers.Authorization,'Bearer unit-test-token')
const failed=async()=>({ok:false})
await assert.rejects(()=>summariseRecordViaProvider(item,{apiKey:'test',transport:failed}),/provider could not complete/)
await assert.rejects(()=>summariseRecordViaProvider(item,{apiKey:'',transport}),/not configured/)
console.log('PASS: AI Assist environment gating, real provider request contract and safe no-auto-save result')
