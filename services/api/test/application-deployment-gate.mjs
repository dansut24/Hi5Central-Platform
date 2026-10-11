import assert from 'node:assert/strict'
import {
  APPLICATION_OBSERVATION_MAX_AGE_MS,
  applicationReadyForPromotion,
  normaliseDeploymentRow,
} from '../src/applicationDeployment.js'

const now = new Date('2026-10-11T09:00:00Z')
const a='a'.repeat(40),b='b'.repeat(40)
const uat=normaliseDeploymentRow({
  status:'verified',api_sha:a,itsm_sha:a,observed_at:'2026-10-11T08:59:00Z',
},now)
const same=normaliseDeploymentRow({
  status:'verified',api_sha:a,itsm_sha:a,observed_at:'2026-10-11T08:58:00Z',
},now)
const older=normaliseDeploymentRow({
  status:'verified',api_sha:b,itsm_sha:b,observed_at:'2026-10-11T08:58:00Z',
},now)
assert.equal(uat.verified,true)
assert.equal(applicationReadyForPromotion({uat,live:same,testedApiSha:a,testedItsmSha:a}).ready,true)
assert.match(applicationReadyForPromotion({uat,live:older,testedApiSha:a,testedItsmSha:a}).reason,/Deploy the approved/)
assert.equal(applicationReadyForPromotion({uat,live:same,testedApiSha:null,testedItsmSha:a}).ready,false)
assert.equal(applicationReadyForPromotion({uat:older,live:same,testedApiSha:a,testedItsmSha:a}).ready,false)
const stale=normaliseDeploymentRow({
  status:'verified',api_sha:a,itsm_sha:a,
  observed_at:new Date(now.getTime()-APPLICATION_OBSERVATION_MAX_AGE_MS-1),
},now)
assert.equal(stale.status,'stale')
assert.equal(stale.verified,false)
assert.equal(applicationReadyForPromotion({uat,live:stale,testedApiSha:a,testedItsmSha:a}).ready,false)
assert.equal(normaliseDeploymentRow(null,now).verified,false)
assert.equal(normaliseDeploymentRow({status:'failed',api_sha:a,itsm_sha:a,observed_at:now},now).verified,false)
assert.equal(normaliseDeploymentRow({status:'verified',api_sha:'latest',itsm_sha:a,observed_at:now},now).verified,false)
console.log('PASS: exact application revision gate, stale/missing observations and unverified hosts')
