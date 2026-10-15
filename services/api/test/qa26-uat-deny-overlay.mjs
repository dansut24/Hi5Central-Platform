import test from 'node:test'
import assert from 'node:assert/strict'
import {renderQa26UatDeny} from '../../../deployment/qa26/qa26-uat-deny-overlay.mjs'

const baseline=[
  '{',
  '  email admin@hi5central.com',
  '}',
  'http://uat.hi5central.com {',
  '  @qaCustomUatRelease header X-Forwarded-Host h5c-custom-qa26-uat.hi5central.com',
  '  handle @qaCustomUatRelease {',
  '    reverse_proxy hi5pool-uat-custom-web:80',
  '  }',
  '}',
  'http://uat-rmm.hi5central.com {',
  '  reverse_proxy rmm-web:80',
  '}',
].join('\n')+'\n'

test('QA26 UAT deny applies to Managed workspace and portal, and to both RMM aliases',()=>{
  const rendered=renderQa26UatDeny(baseline)
  assert.match(rendered,/X-Forwarded-Host h5c-managed-qa26-uat[.]hi5central[.]com/)
  assert.match(rendered,/X-Forwarded-Host h5c-managed-qa26-uat-portal[.]hi5central[.]com/)
  assert.match(rendered,/X-Forwarded-Host h5c-managed-qa26-uat-rmm[.]hi5central[.]com/)
  assert.match(rendered,/X-Forwarded-Host h5c-custom-qa26-uat-rmm[.]hi5central[.]com/)
  assert.match(rendered,/hi5pool-uat-custom-web:80/)
  assert.equal(renderQa26UatDeny(rendered),rendered)
})
test('QA26 overlay refuses arbitrary gateway source or half-applied markers',()=>{
  assert.throws(()=>renderQa26UatDeny('invalid'),/Unexpected UAT/)
  assert.throws(()=>renderQa26UatDeny(
    baseline.replace('http://uat.hi5central.com {','http://uat.hi5central.com {\n# H5C_QA26_MANAGED_UAT_DENY_BEGIN'),
  ),/Partially applied/)
})
