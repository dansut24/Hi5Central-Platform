import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SANDBOX_ENVIRONMENTS, itsmEnvironmentsForMode,
  environmentAllowed, sandboxModules, sandboxConfiguration, tracksItsmConfiguration,
} from '../src/tenantEnvironmentPolicy.js'

test('Managed has Test but never UAT; Custom has both', () => {
  assert.deepEqual(itsmEnvironmentsForMode('hi5_managed'), ['test'])
  assert.deepEqual(itsmEnvironmentsForMode('admin_controlled'), ['test','uat'])
  assert.equal(environmentAllowed('hi5_managed','uat'),false)
  assert.equal(environmentAllowed('admin_controlled','uat'),true)
  assert.equal(environmentAllowed('hi5_managed','live'),false)
  assert.deepEqual(SANDBOX_ENVIRONMENTS,['test','uat'])
  assert.throws(()=>itsmEnvironmentsForMode('unknown'),/fail closed/)
})

test('ITSM Test/UAT cannot turn into an RMM deployment', () => {
  const modules={itsm:true,rmm:true}
  const cfg={company:{displayName:'QA'},rmm:{sensitive:'never-copy'},itsm:{tickets:true}}
  assert.deepEqual(sandboxModules(modules),{itsm:true,rmm:false})
  assert.deepEqual(sandboxConfiguration(cfg),{company:{displayName:'QA'},itsm:{tickets:true}})
  assert.equal(modules.rmm,true)
  assert.equal(cfg.rmm.sensitive,'never-copy')
})

test('Only ITSM settings are tracked in Live and UAT, not Test or RMM',()=>{
  assert.equal(tracksItsmConfiguration('uat','itsm'),true)
  assert.equal(tracksItsmConfiguration('live','itsm'),true)
  assert.equal(tracksItsmConfiguration('test','itsm'),false)
  for(const area of ['users','company','theme','security','rmm','billing']){
    assert.equal(tracksItsmConfiguration('uat',area),false)
  }
})
