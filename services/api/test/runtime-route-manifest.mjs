import assert from 'node:assert/strict'
import { buildHostRoutingManifest } from '../src/runtimePoolControl.js'
const now=new Date('2026-10-11T11:00:00Z')
const sha='a'.repeat(40)
const base={slug:'testing',environment:'uat',pool_id:'hi5pool-uat-a',
  build_sha:sha,pool_build_sha:sha,pool_state:'verified',
  api_target:'hi5pool-uat-a-api:3001',web_target:'hi5pool-uat-a-web:80',
  verified_at:'2026-10-11T10:58:00Z',last_seen_at:'2026-10-11T10:59:00Z'}
const first=buildHostRoutingManifest({environment:'uat',rows:[base],now})
const again=buildHostRoutingManifest({environment:'uat',rows:[base],now:new Date('2026-10-11T11:01:00Z')})
assert.equal(first.entries[0].host,'testing-uat.hi5central.com')
assert.equal(first.entries[0].apiUpstream,base.api_target)
assert.equal(first.sha256,again.sha256,'The same route decisions must hash identically')
assert.equal(first.sha256.length,64)
assert.deepEqual(buildHostRoutingManifest({environment:'live',rows:[],now}).entries,[])
assert.throws(()=>buildHostRoutingManifest({environment:'uat',rows:[base,base],now}),/Duplicate/)
assert.throws(()=>buildHostRoutingManifest({environment:'live',rows:[base],now}),/mismatch/)
assert.throws(()=>buildHostRoutingManifest({environment:'uat',rows:[{...base,build_sha:'b'.repeat(40)}],now}),/Unverified/)
assert.throws(()=>buildHostRoutingManifest({environment:'uat',rows:[{...base,last_seen_at:'2026-10-10T00:00:00Z'}],now}),/Unverified/)
assert.throws(()=>buildHostRoutingManifest({environment:'uat',rows:[{...base,slug:'admin.test'}],now}),/Invalid/)
console.log('PASS: deterministic exact-host route plans, strict upstream verification and isolation guards')
