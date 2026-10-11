import assert from 'node:assert/strict'
import {aiEnabledInEnvironment,summariseRecordViaProvider} from '../src/itsmAiAssist.js'
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:false}},'uat'),false)
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:true}},'uat'),true)
assert.equal(aiEnabledInEnvironment({itsm:{aiAssistant:false}},'live'),false)
assert.equal(aiEnabledInEnvironment({},'test'),true)
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
