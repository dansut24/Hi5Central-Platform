import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseReleaseManifest,buildReleaseVerificationReceipt,RELEASE_VERIFICATION_FEATURE} from './releaseVerification.js'

const sha='444581139ef7c5fbca5333b06c8a9b1af8555d3c'

test('uses exactly the immutable 40-character public frontend manifest revision',()=>{
  const parsed=parseReleaseManifest({sha:sha.toUpperCase(),versionLabel:'2026.10-QA1'})
  assert.deepEqual(parsed,{buildSha:sha,shortSha:'44458113',version:'2026.10-QA1'})
})

test('fails closed for missing, malformed or HTML-fallback manifests',()=>{
  for(const invalid of [null,{},[],{sha:'44458113'},{sha:'<html></html>'},{sha:'z'.repeat(40)}]){
    assert.throws(()=>parseReleaseManifest(invalid),Error)
  }
})

test('copyable receipt includes the environment, hostname and exact frontend SHA',()=>{
  const receipt=buildReleaseVerificationReceipt({
    manifest:{sha},environment:'uat',hostname:'h5c-custom-qa26-uat.hi5central.com',
    checkedAt:'2026-10-12T20:00:00.000Z',
  })
  assert.match(receipt,/Environment: UAT/)
  assert.match(receipt,/Hostname: h5c-custom-qa26-uat\.hi5central\.com/)
  assert.match(receipt,new RegExp('Frontend SHA: '+sha))
  assert.match(receipt,/Scope: frontend manifest only/)
  assert.match(receipt,new RegExp('Feature: '+RELEASE_VERIFICATION_FEATURE))
  assert.doesNotMatch(receipt,/Approved for Production|API verified/)
})

test('does not generate a receipt for unknown hosts, environments or timestamps',()=>{
  const common={manifest:{sha},environment:'test',hostname:'h5c-managed-qa26-test.hi5central.com',checkedAt:'2026-10-12T20:00:00Z'}
  assert.throws(()=>buildReleaseVerificationReceipt({...common,environment:'production'}),/Unknown/)
  assert.throws(()=>buildReleaseVerificationReceipt({...common,hostname:'https://invalid.tld/path'}),/hostname/)
  assert.throws(()=>buildReleaseVerificationReceipt({...common,checkedAt:'not-a-time'}),/time/)
})
