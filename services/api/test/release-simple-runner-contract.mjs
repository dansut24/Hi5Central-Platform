import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read=filename=>readFileSync(new URL(filename,import.meta.url),'utf8')
const scheduler=read('../src/releaseSimpleScheduler.mjs')
const worker=read('../src/releaseSimpleWorker.mjs')
test('one scheduler operates approved direct Managed/Custom release flow only',()=>{
 assert.match(scheduler,/scope:'generic'/)
 assert.match(scheduler,/deliveryMode:'direct_customer_release'/)
 assert.match(scheduler,/ORDER BY n\.published_at DESC/)
 assert.match(scheduler,/RELEASE_SCHEDULER_ACTIVE/)
 assert.match(scheduler,/session_user.*hi5_release_planner/)
 assert.doesNotMatch(scheduler,/\bspawn\b|docker\s+run/)
})
test('one worker supervises stage-restricted executors, default-standby',()=>{
 assert.match(worker,/stages=\['test','uat','live'\]/)
 assert.match(worker,/RELEASE_WORKER_ACTIVE!=='true'/)
 assert.match(worker,/RELEASE_DATABASE_URL_/)
 assert.match(worker,/delete childEnv\['RELEASE_DATABASE_URL_'/)
 assert.match(worker,/RELEASE_GATEWAY=stage/)
 assert.match(worker,/RELEASE_WORKER_STANDBY=standby\?'true':'false'/)
 assert.match(worker,/tenantReleaseExecutor\.mjs/)
})
