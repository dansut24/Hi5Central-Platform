import assert from 'node:assert/strict'
import {
  differenceList,applyReviewedChanges,valueAtPath,valueDigest,safeToPromote,
} from '../src/configurationReleaseDiff.js'
const live={security:{requireMfa:false,sessionHours:'12',mfaEnforcedAt:null},
  theme:{accent:'blue'},itsm:{queues:{pageSize:'25'}},
  integrations:{oauth:{clientSecret:'never-copy'}}}
const uat={security:{requireMfa:true,sessionHours:'12',mfaEnforcedAt:'2026-10-11T12:00:00.000Z'},
  theme:{accent:'purple'},itsm:{queues:{pageSize:'25'}},
  integrations:{oauth:{clientSecret:'fake-secret'}}}
const changes=differenceList(live,uat)
const mfa=changes.find(x=>x.id==='security.requireMfa')
const colour=changes.find(x=>x.id==='theme.accent')
assert.equal(mfa.promotable,true)
assert.equal(mfa.versionUpgradeRequired,false)
assert.equal(mfa.from,false)
assert.equal(mfa.to,true)
assert.equal(colour.promotable,true)
assert.equal(changes.find(x=>x.id==='integrations.oauth.clientSecret').promotable,false)
assert.equal(changes.some(x=>x.id==='security.mfaEnforcedAt'),false)
assert.equal(safeToPromote(['security','mfaEnforcedAt']),false)
assert.equal(safeToPromote(['users','email']),false)
assert.equal(safeToPromote(['security','requireMfa']),true)
assert.equal(safeToPromote(['itsm','__proto__']),false)
assert.equal(safeToPromote(['itsm','constructor']),false)
const pick=({id,beforeHash,afterHash})=>({id,beforeHash,afterHash})
const at=new Date('2026-10-11T13:00:00.000Z')
const applied=applyReviewedChanges(live,uat,[pick(mfa)],at)
assert.equal(applied.security.requireMfa,true)
assert.equal(applied.security.mfaEnforcedAt,at.toISOString())
assert.equal(applied.theme.accent,'blue','Unselected UAT changes must not be copied')
assert.equal(live.security.requireMfa,false,'The input must not be mutated')
assert.throws(()=>applyReviewedChanges({...live,security:{...live.security,requireMfa:true}},uat,[pick(mfa)]),/changed since/)
assert.throws(()=>applyReviewedChanges(live,{...uat,security:{...uat.security,requireMfa:false}},[pick(mfa)]),/changed since/)
assert.throws(()=>applyReviewedChanges(live,uat,[pick(mfa),pick(mfa)]),/more than once/)
assert.throws(()=>applyReviewedChanges(live,uat,[pick(changes.find(x=>!x.promotable))]),/reviewed|safe promotion/)
assert.equal(valueDigest(null,false),valueDigest(null,false))
assert.notEqual(valueDigest(null,false),valueDigest(null,true))
const arr=differenceList({itsm:{fields:['one']}},{itsm:{fields:['one','two']}})
assert.equal(arr.length,1)
assert.equal(arr[0].id,'itsm.fields')
const types=differenceList({itsm:{form:'legacy'}},{itsm:{form:{layout:'new'}}})
assert.equal(types.length,1)
assert.equal(types[0].id,'itsm.form')
const empty=differenceList({theme:{accent:'blue'}},{theme:{accent:'blue'}})
assert.equal(empty.length,0)
console.log('PASS: automatic UAT configuration diff, selected promotion and MFA security boundaries')
