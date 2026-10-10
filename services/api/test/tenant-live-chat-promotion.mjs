import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import pg from 'pg'
import { pool } from '../src/db.js'
import { stageTenantLiveChat, verifyTenantLiveChatUat, promoteTenantLiveChat, tenantLiveChatState } from '../src/tenantFeatureRollouts.js'

const {Client}=pg
const uatUrl=process.env.TENANT_UAT_DATABASE_URL
if (!uatUrl) throw Error('Isolated UAT database URL required')
const suffix=randomBytes(5).toString('hex')
const client=new Client({connectionString:uatUrl})
await client.connect()
let liveTenantId,ownerId,otherId
try{
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
  await assert.rejects(()=>promoteTenantLiveChat(liveTenantId,ownerId,opts),/must pass UAT/)
  result=await stageTenantLiveChat(liveTenantId,ownerId,opts)
  assert.equal(result.state,'staged')
  assert.equal(result.uatEnabled,true)
  assert.equal(result.liveEnabled,false)
  assert.equal(result.liveOverridePresent,true)
  await assert.rejects(()=>promoteTenantLiveChat(liveTenantId,ownerId,opts),/must pass UAT/)
  result=await verifyTenantLiveChatUat(liveTenantId,ownerId,opts)
  assert.equal(result.state,'uat_passed')
  assert(result.verifiedAt)
  const promoted=await promoteTenantLiveChat(liveTenantId,ownerId,opts)
  assert.equal(promoted.state,'promoted')
  assert.equal(promoted.liveEnabled,true)
  result=await tenantLiveChatState(liveTenantId,opts)
  assert.equal(result.state,'promoted')
  assert.equal(result.liveEnabled,true)
  assert.equal(result.uatEnabled,true)
  const others=await pool.query('SELECT count(*)::int n FROM tenant_environment_feature_overrides WHERE tenant_id=$1',[otherId])
  assert.equal(others.rows[0].n,0,'another tenant must not be touched')
  const uat=await client.query("SELECT enabled FROM tenant_environment_feature_overrides WHERE tenant_id=$1 AND environment='uat' AND feature_key='itsm.live_chat'",[liveTenantId])
  assert.equal(uat.rows[0].enabled,true)
  const live=await pool.query("SELECT enabled FROM tenant_environment_feature_overrides WHERE tenant_id=$1 AND environment='live' AND feature_key='itsm.live_chat'",[liveTenantId])
  assert.equal(live.rows[0].enabled,true)
  console.log('PASS: stage UAT=true / Live=false, require acceptance, promote Live=true, isolate other tenants')
} finally {
  await client.end().catch(()=>{})
  await pool.end()
}
