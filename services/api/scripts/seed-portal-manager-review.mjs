/**
 * Local-only review manager for the Hi5Central End User Portal / ITSM.
 * Preview: node scripts/seed-portal-manager-review.mjs --tenant local
 * Create:  node scripts/seed-portal-manager-review.mjs --tenant local --apply
 * Toggle:  --grant-itsm, --revoke-itsm, or --reset-password (independent commands)
 * No passwords, hashes or credentials are committed to Git.
 */
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { hashPassword } from '../src/password.js'
import { ensureDefaultRoles } from '../src/access.js'

const { Client } = pg
const env = process.env
const flag = (name) => process.argv.includes(name)
const modes = ['--apply', '--grant-itsm', '--revoke-itsm', '--reset-password'].filter(flag)
if (modes.length > 1) throw new Error('Choose only one operation at a time.')
const operation = modes[0] || '--preview'
const at = process.argv.indexOf('--tenant')
const slug = at >= 0 ? process.argv[at + 1] : ''
const url = env.APP_URL || ''
const marker = 'HI5-LOCAL-MANAGER-REVIEW-1'
const seedPrefix = 'hi5-local-portal-manager-review-v1/'
const name = 'Hi5Central Review Manager'

function localUrl(value) {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return parsed.protocol === 'http:' && (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  } catch { return false }
}
if (env.NODE_ENV !== 'development' || env.RUNTIME_ENVIRONMENT !== 'dev' ||
    env.TENANCY_MODE !== 'single' || env.FEATURE_MODE !== 'all_enabled' ||
    !localUrl(url)) {
  throw new Error('Refusing operation outside a local, single-tenant, all-features DEV environment.')
}
if (!slug || slug !== env.PRIMARY_TENANT_SLUG) {
  throw new Error('--tenant must equal PRIMARY_TENANT_SLUG configured in local Docker.')
}
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.')

const email = 'workflow-manager-' + slug + '@hi5central.test'
const employeeEmail = 'workflow-employee-' + slug + '@hi5central.test'
const portalUrl = (env.PORTAL_URL || url + '/portal').replace(/\/$/, '')
const db = new Client({ connectionString: env.DATABASE_URL })
let inTransaction = false

async function managerLookup(tenantId) {
  const result = await db.query(
    'SELECT u.id,u.email,u.name,m.role AS member_role,p.id AS person_id,p.external_key FROM users u ' +
    'LEFT JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=$2 ' +
    'LEFT JOIN organisation_people p ON p.user_id=u.id AND p.tenant_id=$2 ' +
    'WHERE u.email=$1',
    [email, tenantId],
  )
  const account = result.rows[0] || null
  if (account && (account.external_key !== marker || !account.member_role)) {
    throw new Error('Existing email is not the dedicated review manager. No changes made.')
  }
  return account
}

async function markerRequest(tenantId, key) {
  const result = await db.query(
    'SELECT reference,status FROM service_requests ' +
    'WHERE tenant_id=$1 AND operational_data->>\'reviewSeedKey\'=$2 LIMIT 1',
    [tenantId, seedPrefix + key],
  )
  return result.rows[0] || null
}

async function addRole(tenantId, userId, systemKey) {
  const result = await db.query(
    'INSERT INTO access_user_roles (tenant_id,user_id,role_id) ' +
    'SELECT $1,$2,id FROM access_roles WHERE tenant_id=$1 AND system_key=$3 AND active=true ' +
    'ON CONFLICT DO NOTHING RETURNING role_id',
    [tenantId,userId,systemKey],
  )
  const exists = await db.query(
    'SELECT 1 FROM access_user_roles ur JOIN access_roles r ON ur.role_id=r.id ' +
    'WHERE ur.tenant_id=$1 AND ur.user_id=$2 AND r.system_key=$3 AND r.active=true',
    [tenantId,userId,systemKey],
  )
  if (!exists.rowCount) throw new Error('Required role is missing or disabled: ' + systemKey)
  return result.rowCount > 0
}

function freshPassword() {
  return 'Review-' + randomBytes(24).toString('base64url') + 'A9!'
}

async function nextRequestReference(tenantId, config) {
  const itsm = (config && config.itsm) || {}
  const rawPrefix = itsm.numberingMode === 'custom'
    ? itsm.recordPrefixes?.serviceRequest : 'REQ-'
  const clean = String(rawPrefix || 'REQ-').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0,10) || 'REQ-'
  const prefix = clean.endsWith('-') ? clean : clean + '-'
  const digits = Math.max(4,Math.min(8,Number(itsm.recordDigits || 5)))
  for (let i=0;i<300;i++) {
    const result = await db.query(
      'INSERT INTO tenant_record_counters (tenant_id,record_type,next_value,updated_at) ' +
      "VALUES ($1,'service_request',1,now()) " +
      'ON CONFLICT (tenant_id,record_type) DO UPDATE SET ' +
      'next_value=tenant_record_counters.next_value+1,updated_at=now() RETURNING next_value',
      [tenantId],
    )
    const reference = prefix + String(result.rows[0].next_value).padStart(digits,'0')
    const exists = await db.query('SELECT 1 FROM service_requests WHERE tenant_id=$1 AND reference=$2', [tenantId,reference])
    if (!exists.rowCount) return reference
  }
  throw new Error('Unable to allocate a unique Service Request reference.')
}

async function addRequest(tenantId, ownerId, approverId, approverPersonId, config, scenario) {
  const existing = await markerRequest(tenantId, scenario.key)
  if (existing) return { ...existing, action: 'already exists', scenario: scenario.key }
  const reference = await nextRequestReference(tenantId, config)
  const result = await db.query(
    'INSERT INTO service_requests (' +
    'tenant_id,reference,requester_snapshot,title,description,service,priority,status,' +
    'source,approval_mode_snapshot,operational_data,created_by_user_id' +
    ') VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,\'Pending Approval\',\'dev_review_seed\',\'manager\',$8::jsonb,$9) RETURNING id',
    [
      tenantId, reference,
      JSON.stringify({ name: 'Hi5Central Review Employee', email: employeeEmail }),
      scenario.title, scenario.description, 'Employee Services', 'Medium',
      JSON.stringify({ reviewSeedKey: seedPrefix + scenario.key, demoOnly: true }),
      ownerId,
    ],
  )
  const id = result.rows[0].id
  await db.query(
    'INSERT INTO service_request_approvals (' +
    'tenant_id,request_id,sequence,label,status,approver_user_id,approver_person_id,approver_snapshot' +
    ') VALUES ($1,$2,1,$3,\'Pending\',$4,$5,$6::jsonb)',
    [
      tenantId,id,'Manager approval — ' + scenario.label,approverId,approverPersonId,
      JSON.stringify({ name, email, personId: approverPersonId }),
    ],
  )
  for (let i=0;i<2;i++) {
    const title = i === 0 ? 'Validate approved request' : 'Complete requester handover'
    await db.query(
      'INSERT INTO service_request_tasks (' +
      'tenant_id,request_id,external_key,title,status,instructions,dependencies' +
      ') VALUES ($1,$2,$3,$4,\'Waiting\',$5,$6::jsonb)',
      [
        tenantId,id,reference + '-REVIEW-' + (i+1),title,
        i===0 ? 'Start only after the manager approves.' : 'Complete after approval and validation.',
        JSON.stringify(i ? [reference + '-REVIEW-1'] : []),
      ],
    )
  }
  return { reference, status: 'Pending Approval', scenario: scenario.key, action: 'created' }
}

const scenarios = [
  { key: 'approve', label: 'new laptop request',
    title: 'Manager review — laptop replacement',
    description: 'Local DEV test. Review the replacement laptop request and approve it to release fulfilment tasks.' },
  { key: 'reject', label: 'restricted mailbox access',
    title: 'Manager review — restricted mailbox access',
    description: 'Local DEV test. Reject this unnecessary mailbox access and enter a required rejection reason.' },
]

await db.connect()
try {
  const found = await db.query(
    'SELECT t.id,t.slug,t.status,ts.modules,ts.onboarding_completed_at,ts.configuration,ts.onboarding_data ' +
    'FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id WHERE t.slug=$1 LIMIT 1',
    [slug],
  )
  if (!found.rowCount || found.rows[0].status !== 'active' ||
      found.rows[0].modules?.itsm !== true ||
      !found.rows[0].onboarding_completed_at) {
    throw new Error('Local tenant must be active, onboarded and ITSM enabled.')
  }
  const tenant = found.rows[0]
  let account = await managerLookup(tenant.id)
  const existing = await Promise.all(scenarios.map(async (item) => ({ key: item.key, record: await markerRequest(tenant.id,item.key) })))
  console.log('Local tenant: ' + slug)
  console.log('Manager: ' + email)
  console.log('Portal: ' + portalUrl)
  console.log('ITSM: ' + url)
  if (operation === '--preview') {
    console.log('Account: ' + (account ? 'present' : 'not created'))
    for (const item of existing) console.log(item.key + ': ' + (item.record ? item.record.reference + ' (' + item.record.status + ')' : 'not created'))
    console.log('Preview only. Re-run with --apply to create an account and missing review requests.')
  } else {
    await db.query('BEGIN')
    inTransaction = true
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [marker,tenant.id])
    account = await managerLookup(tenant.id)
    let displayedPassword = ''
    if (operation === '--apply') {
      await ensureDefaultRoles(db,tenant.id)
      if (!account) {
        const pass = freshPassword()
        const result = await db.query(
          'INSERT INTO users (email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
          [email,name,await hashPassword(pass)],
        )
        const userId = result.rows[0].id
        await db.query(
          "INSERT INTO tenant_memberships (tenant_id,user_id,role,status) VALUES ($1,$2,'requester','active')",
          [tenant.id,userId],
        )
        await db.query(
          'INSERT INTO organisation_people (tenant_id,external_key,user_id,name,email,job_title,access_profile,active) ' +
          "VALUES ($1,$2,$3,$4,$5,'Team Manager','manager',true)",
          [tenant.id,marker,userId,name,email],
        )
        displayedPassword = pass
        account = await managerLookup(tenant.id)
      }
      await addRole(tenant.id,account.id,'requester')
      await addRole(tenant.id,account.id,'approver')
      const employeeMarker = marker + '-EMPLOYEE'
      const employeeExisting = await db.query(
        'SELECT id FROM organisation_people WHERE tenant_id=$1 AND external_key=$2',
        [tenant.id,employeeMarker],
      )
      if (!employeeExisting.rowCount) {
        await db.query(
          'INSERT INTO organisation_people (' +
          'tenant_id,external_key,name,email,job_title,access_profile,manager_id,active' +
          ") VALUES ($1,$2,'Hi5Central Review Employee',$3,'Review Test','employee',$4,true)",
          [tenant.id,employeeMarker,employeeEmail,account.person_id],
        )
      }
      const owner = await db.query(
        'SELECT m.user_id FROM tenant_memberships m WHERE m.tenant_id=$1 AND m.status=\'active\' ' +
        "AND m.role IN ('owner','admin') ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1",
        [tenant.id],
      )
      if (!owner.rowCount) throw new Error('Active owner/admin is required to own seeded request records.')
      const config = Object.keys(tenant.configuration || {}).length ? tenant.configuration : (tenant.onboarding_data || {})
      const records = []
      for (const item of scenarios) {
        records.push(await addRequest(tenant.id,owner.rows[0].user_id,account.id,account.person_id,config,item))
      }
      await db.query('COMMIT')
      inTransaction = false
      console.log('Manager account and review requests are ready:')
      for (const item of records) console.log(item.scenario + ': ' + item.reference + ' (' + item.action + ') — ' + url + '/requests/' + item.reference)
      if (displayedPassword) {
        console.log('ONE-TIME LOCAL CREDENTIALS — SAVE NOW:')
        console.log('Email: ' + email)
        console.log('Password: ' + displayedPassword)
        console.log('Generated password is not stored in Git or printed on reruns.')
      } else console.log('Existing test account retained. To rotate the password, use --reset-password.')
      console.log('Portal Requester + Approver roles ensured. Existing ITSM permissions (if any) were left unchanged.')
    } else {
      if (!account) throw new Error('Create the manager first using --apply.')
      if (operation === '--reset-password') {
        const pass = freshPassword()
        await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [account.id,await hashPassword(pass)])
        await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [account.id])
        await db.query('COMMIT')
        inTransaction=false
        console.log('Password rotated and existing sessions revoked.')
        console.log('Email: ' + email)
        console.log('NEW PASSWORD (SAVE NOW): ' + pass)
      } else if (operation === '--grant-itsm') {
        await ensureDefaultRoles(db,tenant.id)
        await addRole(tenant.id,account.id,'analyst')
        await db.query("UPDATE tenant_memberships SET role='analyst' WHERE tenant_id=$1 AND user_id=$2", [tenant.id,account.id])
        await db.query('COMMIT')
        inTransaction=false
        console.log('ITSM Analyst access granted for this local test manager. Sign out and in again to test.')
      } else if (operation === '--revoke-itsm') {
        await db.query(
          'DELETE FROM access_user_roles ur USING access_roles r ' +
          "WHERE ur.role_id=r.id AND ur.tenant_id=$1 AND ur.user_id=$2 AND r.system_key='analyst'",
          [tenant.id,account.id],
        )
        await db.query("UPDATE tenant_memberships SET role='requester' WHERE tenant_id=$1 AND user_id=$2", [tenant.id,account.id])
        await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [account.id])
        await db.query('COMMIT')
        inTransaction=false
        console.log('ITSM Analyst access revoked; manager retains Portal roles. Sign in again.')
      }
    }
  }
} catch(error) {
  if (inTransaction) await db.query('ROLLBACK')
  throw error
} finally {
  await db.end()
}
