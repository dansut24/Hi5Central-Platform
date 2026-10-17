import test from 'node:test'
import assert from 'node:assert/strict'
import {formatInstalledVersionDetails} from '../src/production/installedVersionCopy.js'

const running='2199e58a540ff912cccdbd137fdfbb9e8d48f3c5'
const latest='f51d2e634e450e03214f10d845f90f73f7b2d506'

test('copies the full installed SHA and version, never a newer available release',()=>{
 const result=formatInstalledVersionDetails({
  versionLabel:'1.3.0',buildSha:running,environment:'live',
  latestReleaseSha:latest,
 })
 assert.equal(result,
  'Hi5Central ITSM\nInstalled version: 1.3.0\nEnvironment: Production\nBuild SHA: '+running)
 assert.equal(result.includes(latest),false)
})
test('correctly identifies the Development, Test and UAT environments',()=>{
 for(const [environment,name] of [['dev','Development'],['test','Test'],['uat','UAT']]){
  const copied=formatInstalledVersionDetails({buildSha:running,environment})
  assert.match(copied,new RegExp('Environment: '+name))
  assert.match(copied,/Installed version: Preview build/)
 }
})
test('reports unpublished Live version accurately instead of inventing a label',()=>{
 const copied=formatInstalledVersionDetails({buildSha:running,environment:'live'})
 assert.match(copied,/Installed version: Not yet published/)
})
test('fails closed if the running build is missing, shortened or unversioned',()=>{
 for(const buildSha of [null,undefined,'local-unversioned','2199e58a',latest.slice(0,39),'']){
  assert.equal(formatInstalledVersionDetails({versionLabel:'2.0.0',buildSha,environment:'live'}),null)
 }
})
test('normalises a multiline customer version label and SHA casing',()=>{
 const copied=formatInstalledVersionDetails({
  versionLabel:'Release 1\nEnvironment: fake\t',buildSha:running.toUpperCase(),
  environment:'uat',
 })
 assert.match(copied,/Installed version: Release 1 Environment: fake/)
 assert.match(copied,/Environment: UAT/)
 assert.match(copied,new RegExp('Build SHA: '+running))
 assert.equal(copied.split('\n').length,4)
})
