import assert from 'node:assert/strict'
import {differenceList,applyReviewedChanges} from '../src/configurationReleaseDiff.js'
const live={company:{legalName:'Example Legal Ltd',displayName:'Example'},
  itsm:{liveChat:false},security:{requireMfa:false}}
const uat={company:{legalName:'Example Legal Ltd',displayName:'Example'},
  itsm:{liveChat:true},security:{requireMfa:false}}
let changes=differenceList(live,uat)
assert.deepEqual(changes.map(x=>x.id),['itsm.liveChat'],
  'Identical UAT and Production values must not appear as pending changes')
assert.equal(differenceList({...live,itsm:{liveChat:true}},uat).length,0,
  'A direct Production change matching UAT automatically resolves the pending difference')
assert.deepEqual(differenceList({...live,itsm:{liveChat:true}},{
 ...uat,itsm:{liveChat:false}}).map(x=>x.id),['itsm.liveChat'],
 'A newly diverging UAT setting must reappear in the pending list')
const reviewed=changes[0]
assert.throws(()=>applyReviewedChanges({...live,itsm:{liveChat:true}},uat,[{
 id:reviewed.id,beforeHash:reviewed.beforeHash,afterHash:reviewed.afterHash,
}]),/Refresh and approve/,'An out-of-date approval must never overwrite Production')
assert.equal(applyReviewedChanges(live,uat,[{
 id:reviewed.id,beforeHash:reviewed.beforeHash,afterHash:reviewed.afterHash,
}]).itsm.liveChat,true,'An unchanged reviewed item can be promoted')
changes=differenceList({...live,company:{...live.company,legalName:'Another Legal Ltd'}},uat)
assert.ok(changes.some(x=>x.id==='company.legalName'),
 'Legal identity is currently environment configuration, not shared master company data')
console.log('PASS: pending UAT diffs resolve on matching Production values and stale promotions are refused')
