import assert from 'node:assert/strict'
import {updatePublicationStatus} from '../src/production/updatePublicationStatus.js'
const latest='21d0a437e24d97918455c04169f06edb225384a8'
const previous='2199e58a540ff912cccdbd137fdfbb9e8d48f3c5'
const pilot='edfc90c119ce57695012e72fe7d3ea5dbbcb1839'
const releases=[{buildSha:latest},{buildSha:previous}]
assert.equal(updatePublicationStatus({installedSha:pilot,releases}).kind,'unlisted',
  'An independent pilot SHA is NOT a confirmed newer published release')
assert.equal(updatePublicationStatus({installedSha:latest,releases}).kind,'current')
assert.equal(updatePublicationStatus({installedSha:previous,releases}).kind,'newer-published')
assert.equal(updatePublicationStatus({installedSha:pilot,releases:[]}).kind,'none')
assert.equal(updatePublicationStatus({installedSha:'',releases:null}).kind,'none')
assert.equal(updatePublicationStatus({installedSha:pilot,releases}).label,'Pilot / unpublished build')
console.log('PASS: newer published, current, empty and unlisted pilot release reporting')
