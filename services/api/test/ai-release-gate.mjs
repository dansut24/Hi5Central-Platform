import assert from 'node:assert/strict'
import {AI_CONFIG_PATH,TESTED_AI_BUILD_SHA,acceptedAiChange,verifiedAiProductionBuild,shouldApplyAiVersionGate} from '../src/aiReleaseGate.js'
const afterHash='a'.repeat(64)
const change={id:AI_CONFIG_PATH,to:true,afterHash}
const acceptance={tested_build_sha:TESTED_AI_BUILD_SHA,uat_configuration_hash:afterHash}
assert.equal(acceptedAiChange({change,acceptance}),true)
assert.equal(acceptedAiChange({change:{...change,to:false},acceptance}),false)
assert.equal(acceptedAiChange({change:{...change,afterHash:'b'.repeat(64)},acceptance}),false)
assert.equal(acceptedAiChange({change,acceptance:{...acceptance,tested_build_sha:'f'.repeat(40)}}),false)
assert.equal(acceptedAiChange({change,acceptance:null}),false)
assert.equal(shouldApplyAiVersionGate(change),true)
assert.equal(shouldApplyAiVersionGate({...change,to:false}),false)
const now=new Date('2026-10-11T20:00:00.000Z')
const verified={status:'verified',api_sha:TESTED_AI_BUILD_SHA,itsm_sha:TESTED_AI_BUILD_SHA,
  observed_at:'2026-10-11T19:55:00.000Z'}
assert.equal(verifiedAiProductionBuild({row:verified,now}),true)
assert.equal(verifiedAiProductionBuild({row:{...verified,status:'unverified'},now}),false)
assert.equal(verifiedAiProductionBuild({row:{...verified,api_sha:'0'.repeat(40)},now}),false)
assert.equal(verifiedAiProductionBuild({row:{...verified,itsm_sha:'0'.repeat(40)},now}),false)
assert.equal(verifiedAiProductionBuild({row:{...verified,observed_at:'2026-10-10T10:00:00.000Z'},now}),false)
assert.equal(verifiedAiProductionBuild({row:null,now}),false)
console.log('PASS: AI UAT acceptance, source hash, exact API/UI build and freshness guard')
