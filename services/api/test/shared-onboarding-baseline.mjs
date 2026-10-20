import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {sharedBaselineImages,replaceSharedBaselineImages} from '../src/sharedOnboardingBaseline.js'
const old='a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c'
const latest='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const pinned='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const compose=[
 'services:',
 '  api:',
 '    image: ghcr.io/dansut24/hi5central-platform-api:sha-'+old,
 '    environment:',
 '      ROOT_DOMAIN: hi5central.com',
 '  api-control:',
 '    image: ghcr.io/dansut24/hi5central-platform-api:sha-'+pinned,
 '  itsm:',
 '    image: ghcr.io/dansut24/hi5central-platform-itsm:sha-'+old,
 '  itsm-dev:',
 '    image: ghcr.io/dansut24/hi5central-platform-itsm:sha-'+pinned,
 '  hi5pool-live-d05e592ef6e4-api:',
 '    image: ghcr.io/dansut24/hi5central-platform-api:sha-'+pinned,
].join('\n')+'\n'
test('only immutable, perfectly matched shared signup pair is valid',()=>{
 assert.deepEqual(sharedBaselineImages(compose),{api:old,itsm:old})
 for(const wrong of [
  compose.replace('sha-'+old+'\n  itsm-dev','sha-'+pinned+'\n  itsm-dev'),
  compose.replace('  api:\n','  api-old:\n'),
  compose.replace('  api:\n','  api:\n  api:\n'),
  compose.replace('platform-api:sha-'+old,'platform-api:latest'),
 ]){
  assert.throws(()=>sharedBaselineImages(wrong))
 }
})
test('approved SHA changes ONLY the shared signup API and frontend',()=>{
 const result=replaceSharedBaselineImages(compose,latest)
 assert.equal(result.changed,true)
 assert.equal(result.previousSha,old)
 assert.deepEqual(sharedBaselineImages(result.source),{api:latest,itsm:latest})
 assert.equal(result.source.replaceAll(latest,old),compose)
 assert.ok(result.source.includes('api-control:\n    image: ghcr.io/dansut24/hi5central-platform-api:sha-'+pinned))
 assert.ok(result.source.includes('itsm-dev:\n    image: ghcr.io/dansut24/hi5central-platform-itsm:sha-'+pinned))
 assert.equal(replaceSharedBaselineImages(result.source,latest).changed,false)
 assert.throws(()=>replaceSharedBaselineImages(compose,'main'))
})
test('supervisor sync is optional and cannot change stage rollback entitlement',()=>{
 const worker=readFileSync(new URL('../src/releaseSimpleWorker.mjs',import.meta.url),'utf8')
 const sync=readFileSync(new URL('../src/sharedOnboardingBaselineSync.mjs',import.meta.url),'utf8')
 assert.match(worker,/H5C_SHARED_ONBOARDING_BASELINE_SYNC_ENABLED==='true'/)
 assert.match(worker,/if\(signupSyncEnabled&&!preflight\)/)
 assert.match(worker,/databaseUrl:urlFor\('live'\)/)
 assert.match(worker,/H5C_STAGE_ROLLBACK_EXECUTOR_ENABLED=rollbackExecutorEnabledForStage/)
 assert.match(sync,/identity\.session_user!=='hi5_release_executor_live'/)
 assert.match(sync,/c\.status='approved'/)
 assert.match(sync,/c\.approved_by IS NOT NULL/)
 assert.match(sync,/ORDER BY n\.published_at DESC/)
 assert.match(sync,/image.*inspect/)
 assert.match(sync,/--no-deps','api','itsm'/)
 assert.doesNotMatch(sync,/caddy reload|Caddyfile|host-deploy\.mjs/)
})
