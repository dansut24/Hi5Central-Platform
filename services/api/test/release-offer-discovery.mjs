import assert from 'node:assert/strict'
import {rolloutLane} from '../src/runtimePoolManagedScheduler.js'
assert.equal(rolloutLane('admin_controlled'),'uat')
assert.equal(rolloutLane('hi5_managed'),'live')
assert.equal(rolloutLane('unknown'),null)
assert.equal(rolloutLane(''),null)
console.log('PASS: Custom offers target UAT, Managed offers target Live; invalid mode cannot be discovered')
