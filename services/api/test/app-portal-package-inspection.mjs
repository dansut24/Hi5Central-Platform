import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMsiProperties, parseExeProperties, parseAuthenticode } from '../src/appPortalPackageInspection.js'

test('MSI product properties are read without execution', () => {
  const props=parseMsiProperties('Property\tValue\r\nProductName\t7-Zip 26.06 (x64 edition)\r\nManufacturer\tIgor Pavlov\r\nProductVersion\t26.06.00.0\r\nProductCode\t{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}\r\n')
  assert.equal(props.name,'7-Zip 26.06 (x64 edition)')
  assert.equal(props.publisher,'Igor Pavlov')
  assert.equal(props.version,'26.06.00.0')
  assert.equal(props.productCode,'{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}')
})
test('EXE version and company read from file metadata', () => {
  const info=parseExeProperties('[{"ProductName":"ZoomIt","CompanyName":"Microsoft","ProductVersion":12.31}]')
  assert.equal(info.name,'ZoomIt');assert.equal(info.publisher,'Microsoft');assert.equal(info.version,'12.31')
})
test('Authenticode signer auto-detected but Windows final trust still pending', () => {
 const hash='A'.repeat(64)
 const report = ["Signer's certificate:","Signer #0:","Subject: CN=Microsoft Corporation,O=Microsoft Corporation,L=Redmond",'Current message digest : '+hash,'Calculated message digest : '+hash,'Signature verification: failed'].join('\n')
 const result=parseAuthenticode(report)
 assert.equal(result.signer,'Microsoft Corporation')
 assert.equal(result.status,'pending_windows_trust')
})
test('unsigned MSI is explicitly classified, not assigned publisher as signer', () => {
 assert.equal(parseAuthenticode('MSI file has no signature\nUnable to extract existing signature').status,'unsigned')
 assert.equal(parseAuthenticode('MSI file has no signature').signer,'')
})
test('mismatching digest cannot claim signed installer', () => {
 const report="Signer's certificate:\nSigner #0:\nSubject: CN=Unknown\nCurrent message digest : "+'A'.repeat(64)+'\nCalculated message digest : '+'B'.repeat(64)
 assert.equal(parseAuthenticode(report).status,'invalid_or_unrecognised')
})
