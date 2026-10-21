import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validHi5CentralReleaseNumber} from '../../../apps/admin/src/features/admin/releaseVersionValidation.js'

test('real Hi5Central YYYY.MM.DD.increment versions validate correctly',()=>{
 for(const v of ['2026.10.21.1','2026.10.20.1','1.0.0','v1.0.1','2026.10.21.12']){
  assert.equal(validHi5CentralReleaseNumber(v),true,v)
 }
 for(const v of ['','2026-10-21-1','32c1b3f06781','main','2026.10.21.1\\',
  '2026.10.21.1+commit','2026.10.21.1'.repeat(4)]){
  assert.equal(validHi5CentralReleaseNumber(v),false,v)
 }
})
test('approved release correction is visible without horizontally scrolling',()=>{
 const src=readFileSync(new URL('../../../apps/admin/src/features/admin/CertifiedReleaseControls.jsx',import.meta.url),'utf8')
 const selected=src.indexOf('current.status===\'approved\'&&canApprove')
 const table=src.indexOf('<table style=')
 assert.ok(selected>=0&&selected<table,'selected approved release has visible correction action above table')
 assert.match(src,/onClick=\{submitVersionCorrection\}/)
 assert.match(src,/validHi5CentralReleaseNumber\(desired\)/)
 assert.match(src,/validHi5CentralReleaseNumber\(versionEdit\.newVersionLabel\)/)
 assert.match(src,/aria-label="Correct published Hi5Central release number"/)
 assert.match(src,/Reason for audit \(minimum 12 characters\)/)
 assert.match(src,/setVersionEdit\(\{buildSha:current\.build_sha,/)
 assert.match(src,/onClick=\{\(\)=>revoke\(r\.build_sha\)\}/)
})
