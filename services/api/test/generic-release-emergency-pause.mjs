// Security regression tests run ONLY against GitHub Actions' disposable
// hi5_rollout_ci database. Never create roles or test pauses on real tenants.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

test('restricted worker can auditably pause but cannot unpause the fleet', async () => {
  const dsn=process.env.DATABASE_URL||''
  assert(dsn.includes('/hi5_rollout_ci'),
    'SECURITY TEST REFUSED: database must be disposable hi5_rollout_ci')
  const admin=new pg.Client({connectionString:dsn})
  await admin.connect()
  const role='h5c_ci_pause_worker'
  const password='ci_only_emergency_pause_test'
  const workerDsn=new URL(dsn)
  workerDsn.username=role
  workerDsn.password=password
  let worker
  try{
    await admin.query("CREATE ROLE h5c_ci_pause_worker LOGIN PASSWORD 'ci_only_emergency_pause_test'")
    await admin.query('GRANT USAGE ON SCHEMA public TO h5c_ci_pause_worker')
    worker=new pg.Client({connectionString:workerDsn.toString()})
    await worker.connect()
    const request=[
      'h5c-dynamic-uat-ci',
      'Unverified gateway restoration requires immediate operator intervention',
    ]
    await assert.rejects(
      worker.query('SELECT public.hi5_release_emergency_pause($1,$2)',request),
      /permission denied/i,
      'Default PUBLIC must never execute privileged emergency pause')
    await admin.query(
      'GRANT EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) TO h5c_ci_pause_worker')
    const privileges=await worker.query([
      'SELECT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,',
      "has_table_privilege(current_user,'public.platform_release_rollout_control','UPDATE') AS control_update",
    ].join(' '))
    assert.equal(privileges.rows[0].superuser,false)
    assert.equal(privileges.rows[0].control_update,false)
    await assert.rejects(
      worker.query('UPDATE platform_release_rollout_control SET paused=false WHERE singleton=true'),
      /permission denied/i, 'Worker must never have direct rollout control UPDATE')
    await assert.rejects(
      worker.query('SELECT public.hi5_release_emergency_pause($1,$2)',
        ['invalid-worker',request[1]]),
      /Invalid release emergency pause request/)
    const result=await worker.query(
      'SELECT public.hi5_release_emergency_pause($1,$2) AS paused',request)
    assert.equal(result.rows[0].paused,true)
    const control=await admin.query(
      'SELECT paused,reason FROM platform_release_rollout_control WHERE singleton=true')
    assert.equal(control.rows[0].paused,true)
    assert.equal(control.rows[0].reason,request[1])
    const event=await admin.query([
      'SELECT requested_role,worker_id,reason',
      'FROM platform_release_emergency_pause_events',
      'ORDER BY id DESC LIMIT 1',
    ].join(' '))
    assert.deepEqual(event.rows[0],{
      requested_role:role,worker_id:request[0],reason:request[1],
    })
    await admin.query(
      'REVOKE EXECUTE ON FUNCTION public.hi5_release_emergency_pause(text,text) FROM h5c_ci_pause_worker')
    await assert.rejects(
      worker.query('SELECT public.hi5_release_emergency_pause($1,$2)',request),
      /permission denied/i)
  }finally{
    await worker?.end().catch(()=>{})
    await admin.query('DROP ROLE IF EXISTS h5c_ci_pause_worker').catch(()=>{})
    await admin.end()
  }
})
