import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve,dirname} from 'node:path'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const read=path=>readFileSync(resolve(root,path),'utf8')
const planner=read('services/api/src/releaseFanoutDaemon.mjs')
const executor=read('services/api/src/tenantReleaseExecutor.mjs')
const host=read('deployment/qa26/tenant-release-host-executor.mjs')
const queue=read('services/api/src/tenantReleaseQueue.js')
const sql=read('deployment/qa26/sql/restricted-release-workers.sql')
const fanout=read('services/api/src/certifiedReleaseFanout.js')
const plannerDocker=read('deployment/qa26/Dockerfile.certified-release-planner')
const executorDocker=read('deployment/qa26/Dockerfile.tenant-release-executor')

test('all four worker entrypoints are tracked and syntax-compilable',()=>{
 assert.match(planner,/assertDatabaseIdentity/)
 assert.match(executor,/assertDatabaseIdentity/)
 assert.match(host,/assertLiveGatewaySource/)
 assert.match(planner,/services\/api\/src|fanoutCertifiedRelease/)
 assert.match(executor,/tenantReleaseQueue\.js/)
})
test('each worker rejects shared privileged DB credentials',()=>{
 assert.match(planner,/login!=='hi5_release_planner'/)
 assert.match(planner,/role!=='hi5_release_planner'/)
 assert.match(executor,/expectedDbIdentity='hi5_release_executor_'\+gateway/)
 assert.match(executor,/login!==expectedDbIdentity/)
 assert.match(executor,/role!==expectedDbIdentity/)
})
test('host cutover remains fenced and gateway-scoped',()=>{
 assert.match(host,/H5C_RELEASE_LEASE_AUTH/)
 assert.match(host,/--preflight/)
 assert.match(host,/--restore/)
 assert.match(executor,/assertFencedLease/)
 assert.match(executor,/assertQaReleaseTenantAllowed/)
 assert.match(executor,/activeTenantMaintenanceWindow/)
 assert.match(queue,/platform_release_generic_stage_approvals/)
 assert.match(queue,/execution_enabled=true/)
 assert.match(queue,/platform_release_rollout_control/)
})
test('worker cannot directly unpause and UAT uses only vetted cross-stage function',()=>{
 assert.doesNotMatch(executor,/UPDATE platform_release_rollout_control/)
 assert.match(executor,/hi5_release_emergency_pause/)
 assert.match(executor,/hi5_release_prepare_live_after_uat/)
 assert.doesNotMatch(executor,/await registerVerifiedPool\(tx,'live'/)
 assert.match(sql,/SECURITY DEFINER/)
 assert.match(sql,/session_user <> 'hi5_release_executor_uat'/)
 assert.match(sql,/lease_expires_at>now\(\)/)
 assert.match(sql,/execution_enabled=true/)
 assert.match(sql,/a\.checked_at BETWEEN/)
})
test('four NOLOGIN identities and no secrets embedded',()=>{
 for(const role of ['hi5_release_planner','hi5_release_executor_test','hi5_release_executor_uat','hi5_release_executor_live']){
  assert.match(sql,new RegExp(role))
 }
 assert.match(sql,/NOLOGIN NOINHERIT NOSUPERUSER/)
 assert.match(sql,/NOBYPASSRLS/)
 assert.doesNotMatch(sql,/ALTER ROLE.*LOGIN PASSWORD|PASSWORD '\S+'/i)
 assert.match(sql,/GRANT SELECT ON[\s\S]*platform_release_rollout_control/)
 assert.doesNotMatch(sql,/GRANT UPDATE ON\s+public\.platform_release_rollout_control/)
})
test('planner can activate only pending jobs without changing leases',()=>{
 assert.ok(sql.includes('GRANT UPDATE(status,updated_at)'), 'planner column-only GRANT')
 assert.ok(sql.includes('h5c_release_planner_activate'), 'planner RLS policy')
 assert.ok(sql.includes("USING (status='pending'"), 'only pending jobs can be promoted')
 assert.ok(sql.includes("WITH CHECK (status='scheduled'"), 'new status must be scheduled')
 assert.ok(sql.includes('hi5_release_qa_canary'), 'legacy Test canary preserved')
})
test('all stage-bearing tables use PostgreSQL row-level security',()=>{
 for(const table of [
  'tenant_release_rollout_jobs','tenant_release_rollout_events',
  'platform_runtime_pools','tenant_runtime_assignments',
  'tenant_runtime_route_attestations','tenant_runtime_update_offers',
  'platform_release_gateway_owners','platform_release_worker_heartbeats']){
  assert.ok(sql.includes('ALTER TABLE public.'+table+' ENABLE ROW LEVEL SECURITY'),table)
 }
 assert.match(sql,/FOR UPDATE TO %I USING \(%I=%L\) WITH CHECK \(%I=%L\)/)
 assert.match(sql,/FOR INSERT TO %I WITH CHECK \(%I=%L\)/)
})
test('planner image has no Docker CLI and executor cannot silently inherit secrets',()=>{
 assert.match(plannerDocker,/FROM node:22-alpine/)
 assert.doesNotMatch(plannerDocker,/docker:27-cli|docker\.sock/)
 assert.match(executorDocker,/FROM docker:27-cli/)
 assert.match(executorDocker,/COPY services\/api\/src\//)
 assert.match(executorDocker,/tenantReleaseExecutor\.mjs/)
 assert.doesNotMatch(executorDocker,/ENV DATABASE_URL|ARG DATABASE_URL/)
})

test('restricted planner performs certification lookup without UPDATE-level row locks',()=>{
 assert.doesNotMatch(fanout,/FOR (SHARE|UPDATE) OF c/)
 assert.match(fanout,/c\.status='approved'/)
 assert.match(fanout,/c\.evidence @> \$2::jsonb/)
 assert.match(planner,/assertReadOnlyCertificationQuery/)
 assert.match(planner,/await assertReadOnlyCertificationQuery\(\)/)
})
test('standby is an independent fail-closed job-admission boundary',()=>{
 assert.match(planner,/const standby=process\.env\.RELEASE_WORKER_STANDBY==='true'/)
 assert.match(planner,/if\(standby\)\{/)
 assert.match(planner,/else await cycle\(\)/)
 assert.match(executor,/const standby=process\.env\.RELEASE_WORKER_STANDBY==='true'/)
 assert.match(executor,/if\(standby\)\{\s*await heartbeat\('paused'\)\s*return false/)
 const standbyIndex=executor.indexOf("if(standby){\n    await heartbeat('paused')")
 const claimIndex=executor.indexOf('claimDueRollouts(tx,')
 assert.ok(standbyIndex>=0 && claimIndex>standbyIndex,
  'standby bypasses all claim and host-execution paths')
})
