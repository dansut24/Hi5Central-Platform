import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateFileAutoLaunchIntent } from './rmmEpmAutoLaunchPolicy.js'

test('existing manual file requests are not made automatic',()=>{
  assert.deepEqual(validateFileAutoLaunchIntent({source:'explorer'}),{ok:true,autoLaunchOnApproval:false})
})
test('auto-start requires explicit opt-in on verified Explorer origin',()=>{
  assert.deepEqual(validateFileAutoLaunchIntent({source:'explorer',autoLaunchOnApproval:true}),
    {ok:true,autoLaunchOnApproval:true})
  assert.equal(validateFileAutoLaunchIntent({source:'explorer',autoLaunchOnApproval:false}).autoLaunchOnApproval,false)
})
test('native UAC reviews, missing origin, and malformed settings cannot auto-start',()=>{
  for(const body of [
    {source:'native-uac',autoLaunchOnApproval:true},
    {autoLaunchOnApproval:true},
    {source:'other',autoLaunchOnApproval:true},
    {source:'explorer',autoLaunchOnApproval:'true'},
    {source:'explorer',autoLaunchOnApproval:1},
    {source:'explorer',autoLaunchOnApproval:null},
  ])assert.equal(validateFileAutoLaunchIntent(body).ok,false)
})

test('a typed managed request still needs explicit auto-launch consent',()=>{
  assert.equal(validateFileAutoLaunchIntent({source:'managed-uac',autoLaunchOnApproval:true}).ok,true)
  assert.equal(validateFileAutoLaunchIntent({source:'managed-uac',autoLaunchOnApproval:false}).autoLaunchOnApproval,false)
})
