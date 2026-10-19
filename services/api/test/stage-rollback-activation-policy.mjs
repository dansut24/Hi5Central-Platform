import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {rollbackExecutorEnabledForStage} from '../src/stageRollbackActivationPolicy.js'

test('single UAT opt-in never starts Test or Production rollback',()=>{
 const inputs={enabled:'true',stages:'uat'}
 assert.equal(rollbackExecutorEnabledForStage({...inputs,stage:'uat'}),true)
 assert.equal(rollbackExecutorEnabledForStage({...inputs,stage:'live'}),false)
 assert.equal(rollbackExecutorEnabledForStage({...inputs,stage:'test'}),false)
})
test('empty and invalid stage lists fail closed',()=>{
 for(const stages of ['', 'test','uat,foo', 'all', 'live,uat,production',null]){
  assert.equal(rollbackExecutorEnabledForStage({stage:'uat',enabled:'true',stages}),false)
 }
})
test('master switch is still independently required',()=>{
 assert.equal(rollbackExecutorEnabledForStage({stage:'uat',enabled:'false',stages:'uat'}),false)
 assert.equal(rollbackExecutorEnabledForStage({stage:'live',enabled:undefined,stages:'uat,live'}),false)
 assert.equal(rollbackExecutorEnabledForStage({stage:'live',enabled:'true',stages:'live'}),true)
})
test('existing three-stage supervisor writes the scoped decision to each child',()=>{
 const source=readFileSync(new URL('../src/releaseSimpleWorker.mjs',import.meta.url),'utf8')
 assert.match(source,/stages=\['test','uat','live'\]/)
 assert.match(source,/childEnv\.H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED=rollbackExecutorEnabledForStage/)
 assert.match(source,/stage,enabled:process\.env\.H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED/)
 assert.match(source,/stages:process\.env\.H5C_STAGE_ROLLBACK_ENABLED_STAGES/)
})
