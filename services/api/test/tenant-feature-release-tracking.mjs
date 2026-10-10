import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import pg from 'pg'
import { pool } from '../src/db.js'
import { stageTenantLiveChat, verifyTenantLiveChatUat, promoteTenantLiveChat, tenantLiveChatState, effectiveTenantLiveChatEnabled } from '../src/tenantFeatureRollouts.js'

const {Client}=pg
const uatUrl=process.env.TENANT_UAT_DATABASE_URL
const testUrl=process.env.TENANT_TEST_DATABASE_URL
if (!uatUrl || !testUrl) throw Error('Independent Test and UAT database URLs required')
const suffix=randomBytes(5).toString('hex')
const client=new Client({connectionString:uatUrl})
await client.connect()
let liveTenantId,ownerId,otherId
try{
  // Migration 143 must be installed in the independent Test database too.
  const testDb=new Client({connectionString:testUrl})
  await testDb.connect()
  try {
    const schema=await testDb.query(
      "SELECT 1 FROM schema_migrations WHERE version='143_tenant_feature_release_tracking.sql'")
    assert.equal(schema.rowCount,1,'Test migration 143 must be applied')
    const feature=await testDb.query(
      "SELECT 1 FROM platform_feature_definitions WHERE feature_key='itsm.live_chat'")
    assert.equal(feature.rowCount,1,'Test must know about Live Chat')
  }finally{await testDb.end()}
  const tenant=await pool.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",['release-'+suffix,'Live Chat Release CI'])
  liveTenantId=tenant.rows[0].id
  const other=await pool.query("INSERT INTO tenants(slug,company_name,status) VALUES($1,$2,'active') RETURNING id",['other-'+suffix,'Unrelated CI Tenant'])
  otherId=other.rows[0].id
  const user=await pool.query("INSERT INTO users(email,name,password_hash,email_verified_at) VALUES($1,$2,'ci-hash-disabled',now()) RETURNING id",['release-'+suffix+'@example.invalid','CI Owner'])
  ownerId=user.rows[0].id
  await pool.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",[liveTenantId,ownerId])
  await pool.query("UPDATE tenant_release_preferences SET update_mode='admin_controlled' WHERE tenant_id=$1",[liveTenantId])
  await pool.query("UPDATE tenant_environment_state SET status='ready' WHERE tenant_id=$1 AND environment='uat'",[liveTenantId])
  await client.query("INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES($1,$2,$3,'environment-sso-only',now())",[ownerId,'release-'+suffix+'@example.invalid','CI Owner'])
  await client.query("INSERT INTO tenants(id,slug,company_name,status) VALUES($1,$2,$3,'active')",[liveTenantId,'release-'+suffix+'-uat','UAT Release CI'])
  const opts={source:pool,targets:{uat:uatUrl}}
  let result=await tenantLiveChatState(liveTenantId,opts)
  assert.equal(result.state,'not_staged')
  assert.equal(result.liveOverridePresent,false)
  assert.equal(result.uatOverridePresent,false)
  // An unassigned UAT release cannot inherit a legacy local Live Chat toggle.
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'uat',{source:client}),false)
  // Test is intentionally unrestricted, while Live has no explicit decision yet.
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'test',{source:client}),true)
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'live',{source:pool}),null)
  await assert.rejects(()=>promoteTenantLiveChat(liveTenantId,ownerId,opts),/must pass UAT/)

  // Force a failure only at the final Live ledger INSERT, after UAT was set
  // to enabled. The saga must restore the previous flag and leave no history.
  const faultFunction='ci_fail_release_'+suffix
  const faultTrigger='ci_fail_release_'+suffix
  await pool.query(`CREATE FUNCTION ${faultFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action='staged_uat' AND NEW.notes='ci-simulated-ledger-failure' THEN
        RAISE EXCEPTION 'CI simulated release ledger failure';
      END IF;
      RETURN NEW;
    END; $$`)
  await pool.query(`CREATE TRIGGER ${faultTrigger}
    BEFORE INSERT ON tenant_feature_release_events FOR EACH ROW
    EXECUTE FUNCTION ${faultFunction}()`)
  try {
    await assert.rejects(
      ()=>stageTenantLiveChat(liveTenantId,ownerId,{...opts,notes:'ci-simulated-ledger-failure'}),
      /CI simulated release ledger failure/)
    let failedStage=await tenantLiveChatState(liveTenantId,opts)
    assert.equal(failedStage.state,'not_staged','failed ledger write cannot create an approval')
    assert.equal(failedStage.history.length,0,'failed ledger write cannot leave an audit event')
    assert.equal(failedStage.uatOverridePresent,false,'previously absent UAT override must be removed')
    assert.equal(failedStage.liveOverridePresent,false,'Live must remain untouched')
    assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'uat',{source:client}),false)

    // Re-test with an existing disabled UAT override. Its exact metadata must
    // survive compensation instead of being overwritten or deleted.
    await client.query(
      `INSERT INTO tenant_environment_feature_overrides
        (tenant_id,environment,feature_key,enabled,updated_by)
       VALUES($1,'uat','itsm.live_chat',false,$2)`,[liveTenantId,ownerId])
    const beforeFailure=await client.query(
      `SELECT enabled,updated_by,updated_at FROM tenant_environment_feature_overrides
       WHERE tenant_id=$1 AND environment='uat' AND feature_key='itsm.live_chat'`,[liveTenantId])
    await assert.rejects(
      ()=>stageTenantLiveChat(liveTenantId,ownerId,{...opts,notes:'ci-simulated-ledger-failure'}),
      /CI simulated release ledger failure/)
    const afterFailure=await client.query(
      `SELECT enabled,updated_by,updated_at FROM tenant_environment_feature_overrides
       WHERE tenant_id=$1 AND environment='uat' AND feature_key='itsm.live_chat'`,[liveTenantId])
    assert.deepEqual(afterFailure.rows,beforeFailure.rows,'existing UAT override must be restored exactly')
    failedStage=await tenantLiveChatState(liveTenantId,opts)
    assert.equal(failedStage.state,'not_staged')
    assert.equal(failedStage.history.length,0)
    assert.equal(failedStage.liveOverridePresent,false)
    await client.query(
      "DELETE FROM tenant_environment_feature_overrides WHERE tenant_id=$1 AND environment='uat' AND feature_key='itsm.live_chat'",[liveTenantId])
  }finally{
    await pool.query(`DROP TRIGGER IF EXISTS ${faultTrigger} ON tenant_feature_release_events`)
    await pool.query(`DROP FUNCTION IF EXISTS ${faultFunction}()`)
  }
  result=await stageTenantLiveChat(liveTenantId,ownerId,opts)
  assert.equal(result.state,'staged')
  assert.equal(result.uatEnabled,true)
  assert.equal(result.liveEnabled,false)
  assert.equal(result.liveOverridePresent,true)
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'uat',{source:client}),true)
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'live',{source:pool}),false)
  await assert.rejects(()=>promoteTenantLiveChat(liveTenantId,ownerId,opts),/must pass UAT/)
  await assert.rejects(()=>verifyTenantLiveChatUat(liveTenantId,ownerId,opts),/Enter UAT test evidence/)
  result=await verifyTenantLiveChatUat(liveTenantId,ownerId,{...opts,notes:'Validated Live Chat opening, messages and closing in the UAT workspace.'})
  assert.equal(result.state,'uat_passed')
  assert(result.verifiedAt)
  const promoted=await promoteTenantLiveChat(liveTenantId,ownerId,opts)
  assert.equal(promoted.state,'promoted')
  assert.equal(promoted.liveEnabled,true)
  result=await tenantLiveChatState(liveTenantId,opts)
  assert.equal(result.state,'promoted')
  assert.equal(result.liveEnabled,true)
  assert.equal(result.uatEnabled,true)
  assert.equal(await effectiveTenantLiveChatEnabled(liveTenantId,'live',{source:pool}),true)
  assert.equal(result.history.length,3)
  assert.deepEqual(result.history.map(e=>e.action),['promoted_live','uat_passed','staged_uat'])
  assert(result.history.some(e=>e.action==='uat_passed'&&e.notes.includes('Validated Live Chat')))
  assert(result.history.every(e=>e.releaseRef===result.releaseRef))
  const priorRef=result.releaseRef
  const stagedAgain=await stageTenantLiveChat(liveTenantId,ownerId,{...opts,notes:'A second test cycle after promotion'})
  assert.equal(stagedAgain.state,'staged')
  assert.notEqual(stagedAgain.releaseRef,priorRef)
  assert.equal(stagedAgain.liveEnabled,true,'restaging must not disable a previously promoted Live feature')
  assert.equal(stagedAgain.history.length,4,'prior feature promotion history must be retained')
  const others=await pool.query('SELECT count(*)::int n FROM tenant_environment_feature_overrides WHERE tenant_id=$1',[otherId])
  assert.equal(others.rows[0].n,0,'another tenant must not be touched')
  const uat=await client.query("SELECT enabled FROM tenant_environment_feature_overrides WHERE tenant_id=$1 AND environment='uat' AND feature_key='itsm.live_chat'",[liveTenantId])
  assert.equal(uat.rows[0].enabled,true)
  const live=await pool.query("SELECT enabled FROM tenant_environment_feature_overrides WHERE tenant_id=$1 AND environment='live' AND feature_key='itsm.live_chat'",[liveTenantId])
  assert.equal(live.rows[0].enabled,true)
  console.log('PASS: separate Test migration, failed-ledger compensation, UAT approval, promotion, audit history and tenant isolation')
} finally {
  await client.end().catch(()=>{})
  await pool.end()
}
