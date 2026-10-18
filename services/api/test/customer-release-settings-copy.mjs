import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const ui=readFileSync(new URL('../../../apps/itsm/src/features/settings/ProductionReleaseManagement.jsx',import.meta.url),'utf8')
test('Managed releases do not imply UAT or show legacy UAT delay',()=>{
 assert.match(ui,/Certified ITSM updates install automatically in Production during your approved maintenance window\. No UAT approval is needed\./)
 assert.doesNotMatch(ui,/Production delay after UAT/)
 assert.doesNotMatch(ui,/stages UAT automatically/)
})
test('Custom UAT is automatic but Production requires tenant approval',()=>{
 assert.match(ui,/New certified releases appear automatically in UAT/)
 assert.match(ui,/explicitly approve the matching Production upgrade/)
})
test('maintenance day errors display within customer release form',()=>{
 assert.match(ui,/Choose at least one maintenance day before saving/)
 assert.match(ui,/hi5-release-policy-save/)
 assert.match(ui,/hi5-release-message is-error" role="alert"/)
})
