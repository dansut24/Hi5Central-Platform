import assert from 'node:assert/strict'
import pg from 'pg'
const db=new pg.Client({connectionString:process.env.DATABASE_URL})
await db.connect()
try {
  await db.query('BEGIN')
  const tenantId='aaaaaaaa-0000-4000-8000-000000000001'
  const actor='aaaaaaaa-0000-4000-8000-000000000002'
  await db.query(`INSERT INTO tenants(id,slug,company_name,status)
      VALUES($1,'config-ci-tenant','Configuration CI','active')`,[tenantId])
  await db.query(`INSERT INTO tenant_settings(tenant_id,tenant_url,portal_url)
      VALUES($1,'https://config-ci-tenant.example.invalid','https://config-ci-tenant-portal.example.invalid')`,[tenantId])
  await db.query(`INSERT INTO tenant_configuration_tracking_pilots(tenant_id,enabled) VALUES ($1,true)`,[tenantId])
  await db.query("SELECT set_config('hi5.actor_user_id',$1,true)",[actor])
  await db.query(`UPDATE tenant_settings SET configuration=$2::jsonb WHERE tenant_id=$1`,[
    tenantId,JSON.stringify({security:{requireMfa:false},theme:{accent:'blue'}})])
  await db.query(`UPDATE tenant_settings SET configuration=$2::jsonb WHERE tenant_id=$1`,[
    tenantId,JSON.stringify({security:{requireMfa:true},theme:{accent:'blue'}})])
  let r=await db.query(
    `SELECT changed_path,actor_user_id,operation FROM tenant_configuration_change_events
      WHERE tenant_id=$1 ORDER BY id`,[tenantId])
  assert.equal(r.rows.filter(x=>x.changed_path.join('.')==='security.requireMfa').length,2)
  assert.equal(r.rows.filter(x=>x.changed_path.join('.')==='theme.accent').length,1)
  assert.ok(r.rows.every(x=>x.actor_user_id===actor&&x.operation==='update'))
  const before=r.rowCount
  await db.query(`UPDATE tenant_settings SET updated_at=now() WHERE tenant_id=$1`,[tenantId])
  r=await db.query('SELECT id FROM tenant_configuration_change_events WHERE tenant_id=$1',[tenantId])
  assert.equal(r.rowCount,before,'Unchanged configuration must create no new event')
  const cap=await db.query('SELECT count(*)::int AS total FROM platform_configuration_capability_requirements')
  assert.equal(cap.rows[0].total,0,'Ordinary settings do not require an application upgrade')
  console.log('PASS: raw PostgreSQL writes automatically record leaf-level UAT changes and actor')
} finally {
  await db.query('ROLLBACK').catch(()=>{})
  await db.end()
}
