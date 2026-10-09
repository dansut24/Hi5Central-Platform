/**
 * Populate the local, single-tenant DEV environment with exactly five Changes
 * and five Service Requests to review record Tasks/Approvals UI.
 *
 * Usage (from the monorepo root, after scripts/start-dev.ps1):
 *   docker compose --env-file .env.local -f deploy/docker-compose.dev.yml exec api \
 *     node scripts/seed-record-workflow-review.mjs --tenant local --apply
 *
 * No --apply => read-only preview. Reruns skip seed-marked rows; they never
 * overwrite technician edits. No production/cloud tenants are supported.
 */
import pg from 'pg'

const { Client } = pg
const SEED = 'hi5-record-workflow-review-v1'
const apply = process.argv.includes('--apply')
const argIndex = process.argv.indexOf('--tenant')
const tenantSlug = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.PRIMARY_TENANT_SLUG
const appUrl = process.env.APP_URL || ''
const env = process.env

function localAddress(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return url.protocol === 'http:' && (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  } catch { return false }
}

if (env.NODE_ENV !== 'development' || env.RUNTIME_ENVIRONMENT !== 'dev' ||
    env.TENANCY_MODE !== 'single' || env.FEATURE_MODE !== 'all_enabled' ||
    !localAddress(appUrl)) {
  throw new Error('Refusing seed: requires single-tenant, all-features local DEV with a private HTTP APP_URL.')
}
if (!tenantSlug || tenantSlug !== env.PRIMARY_TENANT_SLUG || !/^[a-z0-9-]{3,48}$/.test(tenantSlug)) {
  throw new Error('Refusing seed: --tenant must match the explicit PRIMARY_TENANT_SLUG of this local stack.')
}
if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing.')

const changes = [
  {
    key: 'change-01', title: 'Review: Update firewall rules for support VPN',
    description: 'Allow the new support VPN range to reach the approved management subnet.\nValidate the rules against the change plan, capture a rollback configuration, and confirm that management access remains available.',
    status: 'Assessment', priority: 'High', service: 'Network & Security',
    tasks: [
      ['Review VPN source ranges and ACLs', 'Completed', 'Record current firewall ACLs and scope the new source CIDR.'],
      ['Validate network impact and rollback plan', 'In Progress', 'Confirm that access can be rolled back without a full firewall reload.'],
      ['Obtain security sign-off', 'Open', 'Security review is required before implementation.'],
    ],
    notes: ['Change assessment started. Current ACL export captured.', 'Security team is reviewing the proposed access list.'],
  },
  {
    key: 'change-02', title: 'Review: Expand Windows update pilot ring',
    description: 'Extend the Windows quality-update rollout from the IT pilot group to a wider group of devices after compliance checks.\nDo not proceed until change approval is granted.',
    status: 'Awaiting Approval', priority: 'Medium', service: 'Endpoint Management',
    tasks: [
      ['Confirm pilot device compliance', 'Completed', 'Check failures, reboot state, and recent rollback events.'],
      ['Confirm approval and change window', 'Blocked', 'This task must remain blocked until the change is authorised.'],
    ],
    notes: ['Pilot ring completed successfully.', 'Approval requested for expanding the rollout cohort.'],
  },
  {
    key: 'change-03', title: 'Review: Core switch firmware maintenance',
    description: 'Schedule firmware updates across the lab network switches, with a backup and outage notification.\nPlanned impact: a short maintenance window for test devices.',
    status: 'Scheduled', priority: 'High', service: 'Network Infrastructure',
    tasks: [
      ['Back up switch configuration', 'Open', 'Download the configuration and verify that it is restorable.'],
      ['Confirm maintenance notification', 'Open', 'Send a notification to the impacted users.'],
      ['Upgrade and verify uplinks', 'Open', 'Run connectivity and VLAN checks following the firmware upgrade.'],
    ],
    notes: ['Maintenance window agreed with the infrastructure team.'],
  },
  {
    key: 'change-04', title: 'Review: Renew remote access gateway certificate',
    description: 'Renew the TLS certificate used by the remote access gateway.\nConfirm the SAN names, deploy the new chain, and validate clients on Windows, macOS and Linux.',
    status: 'Implementing', priority: 'Critical', service: 'Remote Access',
    tasks: [
      ['Validate replacement certificate', 'Completed', 'Confirm expiry, SAN entries and certificate chain.'],
      ['Deploy new certificate', 'In Progress', 'Replace certificates on all gateway replicas.'],
      ['Verify viewer connection after renewal', 'Open', 'Test a new remote session from each supported viewer.'],
    ],
    notes: ['Certificate issued and checked.', 'Rollout underway; viewer validation remains outstanding.'],
  },
  {
    key: 'change-05', title: 'Review: Validate completed MFA policy rollout',
    description: 'Post-change review of the revised MFA sign-in flow and conditional access rollout.\nCheck that ITSM, RMM and Platform Admin sign-in still respects the correct access permissions.',
    status: 'Review', priority: 'Low', service: 'Identity & Access',
    tasks: [
      ['Run login regression checks', 'Completed', 'Verify MFA for new and established sessions.'],
      ['Review sign-in logs and exceptions', 'Completed', 'Confirm no unexpected access issues.'],
      ['Sign off change evidence', 'Open', 'Attach regression evidence and complete the review.'],
    ],
    notes: ['The deployment completed without incident.', 'Post-implementation evidence is ready for review.'],
  },
]

const requests = [
  {
    key: 'request-01', title: 'Review: Replace damaged staff laptop',
    description: 'A staff member needs a replacement laptop due to battery swelling.\nPlease provide a suitable laptop, transfer data securely and arrange collection of the existing device.',
    status: 'Pending Approval', priority: 'High', service: 'Hardware Requests',
    approval: ['Pending', 'Manager approval — replacement device', ''],
    tasks: [
      ['Approve laptop replacement', 'Waiting', 'Do not purchase a replacement before the manager approves.'],
      ['Prepare and enroll replacement laptop', 'Waiting', 'Enroll the replacement with Hi5Central Agent and verify compliance.'],
      ['Transfer data and hand over device', 'Waiting', 'Validate access, data and user acceptance.'],
    ],
    notes: ['Request received; waiting for a manager decision.'],
  },
  {
    key: 'request-02', title: 'Review: Enable VPN for remote employee',
    description: 'Provision standard VPN access to approved corporate networks.\nConfirm the user identity, assign entitlement and test a successful MFA-authenticated connection.',
    status: 'In Progress', priority: 'Medium', service: 'Access Requests',
    approval: null,
    tasks: [
      ['Check VPN access eligibility', 'Completed', 'Review the access request against policy.'],
      ['Assign VPN security group', 'In Progress', 'Add the user and validate membership propagation.'],
      ['Confirm MFA VPN sign-in', 'Ready', 'Test the VPN client and confirm the access works.'],
    ],
    notes: ['Eligibility confirmed.', 'Security group assignment is underway.'],
  },
  {
    key: 'request-03', title: 'Review: Purchase design software licence',
    description: 'Provide a new licence for the design team.\nThe requester needs the software assigned through the application catalogue after approval and procurement.',
    status: 'Pending Approval', priority: 'Medium', service: 'Software Requests',
    approval: ['Pending', 'Budget owner approval — annual software licence', ''],
    tasks: [
      ['Confirm licence pricing', 'Waiting', 'Confirm the approved annual cost.'],
      ['Purchase and assign licence', 'Waiting', 'Buy a seat and apply entitlement to the requester.'],
      ['Verify software installation', 'Waiting', 'Check that the application is installed and activated.'],
    ],
    notes: ['Finance approval is required before purchasing.'],
  },
  {
    key: 'request-04', title: 'Review: New starter workspace setup',
    description: 'Prepare a standard starter kit for an upcoming employee.\nCreate required access, prepare a Windows laptop, configure Microsoft 365 and complete the handover checklist.',
    status: 'In Progress', priority: 'High', service: 'Employee Onboarding',
    approval: ['Approved', 'Line manager approval — starter package', 'Approved for standard starter kit.'],
    tasks: [
      ['Approve onboarding package', 'Completed', 'Line manager confirmed the starter package.'],
      ['Prepare Windows laptop', 'In Progress', 'Install applications and enroll the device.'],
      ['Assign Microsoft 365 access', 'Ready', 'Provision licences, mailbox and initial security groups.'],
      ['Handover to employee', 'Waiting', 'Complete after device and access are ready.'],
    ],
    notes: ['Manager approved the request.', 'Laptop preparation is in progress.'],
  },
  {
    key: 'request-05', title: 'Review: Add external user to shared mailbox',
    description: 'The requester proposed granting an external contact access to an internal shared mailbox.\nThis test case demonstrates a rejected approval and a cancelled fulfilment task.',
    status: 'Rejected', priority: 'Low', service: 'Email & Collaboration',
    approval: ['Rejected', 'Information security approval — external access', 'Rejected: external mailbox access does not meet current security policy.'],
    tasks: [
      ['Assess shared mailbox membership', 'Cancelled', 'Request rejected by the security approver.'],
    ],
    notes: ['Security review completed.', 'Access request rejected and no mailbox changes made.'],
  },
]

function numbering(config, kind) {
  const itsm = config?.itsm || {}
  const keys = { change: ['change', 'CHG-'], service_request: ['serviceRequest', 'REQ-'] }
  const [setting, fallback] = keys[kind]
  const value = itsm.numberingMode === 'custom' ? itsm.recordPrefixes?.[setting] : fallback
  const base = String(value || fallback).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10) || fallback
  const digits = Math.max(4, Math.min(8, Number(itsm.recordDigits || 5)))
  return { prefix: base.endsWith('-') ? base : base + '-', digits }
}

async function referenceFor(client, tenantId, kind, config) {
  const { prefix, digits } = numbering(config, kind)
  for (let i = 0; i < 300; i++) {
    const next = await client.query(
      `INSERT INTO tenant_record_counters (tenant_id, record_type, next_value, updated_at)
       VALUES ($1,$2,1,now())
       ON CONFLICT (tenant_id,record_type) DO UPDATE SET
         next_value=tenant_record_counters.next_value+1, updated_at=now()
       RETURNING next_value`,
      [tenantId, kind],
    )
    const reference = prefix + String(next.rows[0].next_value).padStart(digits, '0')
    const table = kind === 'change' ? 'itsm_records' : 'service_requests'
    const existing = await client.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND reference=$2`, [tenantId, reference])
    if (!existing.rowCount) return reference
  }
  throw new Error(`Could not allocate an unused ${kind} reference (counter out of sync).`)
}

async function findSeed(client, table, field, tenantId, key) {
  const result = await client.query(
    `SELECT reference FROM ${table} WHERE tenant_id=$1 AND ${field}->>'reviewSeedKey'=$2 LIMIT 1`,
    [tenantId, `${SEED}/${key}`],
  )
  return result.rows[0]?.reference || null
}

function json(value) { return JSON.stringify(value) }
function requester(index) {
  return { name: `UI Review Requester ${String(index).padStart(2, '0')}`, email: `ui-review-${index}@example.invalid`, jobTitle: 'Test colleague', department: 'IT' }
}

async function createChange(client, tenantId, authorId, config, entry, index) {
  const existing = await findSeed(client, 'itsm_records', 'record_data', tenantId, entry.key)
  if (existing) return { type: 'Change', reference: existing, outcome: 'already exists' }
  const reference = await referenceFor(client, tenantId, 'change', config)
  const recordData = { reviewSeedKey: `${SEED}/${entry.key}`, changeType: 'Normal', environment: 'Local DEV', risk: entry.priority, implementationPlan: entry.description }
  const row = await client.query(
    `INSERT INTO itsm_records (
       tenant_id, reference, record_type, requester_snapshot, title, description,
       service, category, priority, status, source, record_data, created_by_user_id
     ) VALUES ($1,$2,'Change',$3::jsonb,$4,$5,$6,'Change Management',$7,$8,'dev_review_seed',$9::jsonb,$10)
     RETURNING id`,
    [tenantId, reference, json(requester(index)), entry.title, entry.description, entry.service, entry.priority, entry.status, json(recordData), authorId],
  )
  const recordId = row.rows[0].id
  for (const [taskTitle, status, instructions] of entry.tasks) {
    await client.query(
      `INSERT INTO itsm_record_tasks (tenant_id, record_id, title, status, instructions, created_by_user_id, created_by_snapshot, completed_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,CASE WHEN $4='Completed' THEN now() ELSE NULL END, now()+interval '7 days')`,
      [tenantId, recordId, taskTitle, status, instructions, authorId, json({ name: 'UI Review Seed' })],
    )
  }
  for (let i = 0; i < entry.notes.length; i++) {
    await client.query(
      `INSERT INTO itsm_record_activities
       (tenant_id, record_id, actor_user_id, actor_snapshot, kind, visibility, body_text, metadata, created_at)
       VALUES ($1,$2,$3,$4::jsonb,'note','internal',$5,$6::jsonb,now() - ($7::int * interval '1 day'))`,
      [tenantId, recordId, authorId, json({ name: 'UI Review Technician' }), entry.notes[i], json({ reviewSeedKey: SEED }), entry.notes.length - i],
    )
  }
  return { type: 'Change', reference, outcome: 'created' }
}

async function createRequest(client, tenantId, author, entry, index, config) {
  const existing = await findSeed(client, 'service_requests', 'operational_data', tenantId, entry.key)
  if (existing) return { type: 'Service Request', reference: existing, outcome: 'already exists' }
  const reference = await referenceFor(client, tenantId, 'service_request', config)
  const operationalData = { reviewSeedKey: `${SEED}/${entry.key}`, demoOnly: true }
  const reviewInformation = [
    { label: 'Purpose', value: 'Test the record workflow design and interactions' },
    { label: 'Environment', value: 'Local DEV' },
    { label: 'Review scenario', value: entry.status },
  ]
  const row = await client.query(
    `INSERT INTO service_requests (
       tenant_id, reference, requester_snapshot, title, description, service,
       priority, status, source, request_information, approval_mode_snapshot,
       operational_data, created_by_user_id, response_due_at, resolution_due_at, sla_paused_at
     ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,'dev_review_seed',$9::jsonb,$10,$11::jsonb,$12,
       now() + interval '4 hours',now() + interval '2 days',
       CASE WHEN $8='Pending Approval' THEN now() ELSE NULL END)
     RETURNING id`,
    [tenantId, reference, json(requester(index + 5)), entry.title, entry.description, entry.service,
      entry.priority, entry.status, json(reviewInformation), entry.approval ? 'manager' : 'none',
      json(operationalData), author.id],
  )
  const requestId = row.rows[0].id
  for (let i = 0; i < entry.tasks.length; i++) {
    const [taskTitle, status, instructions] = entry.tasks[i]
    await client.query(
      `INSERT INTO service_request_tasks
       (tenant_id, request_id, external_key, title, status, instructions, created_at, completed_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()+($7::int * interval '1 minute'),
         CASE WHEN $5='Completed' THEN now() ELSE NULL END, now()+interval '7 days')`,
      [tenantId, requestId, `${reference}-REVIEW-${i+1}`, taskTitle, status, instructions, i],
    )
  }
  if (entry.approval) {
    const [status, label, note] = entry.approval
    await client.query(
      `INSERT INTO service_request_approvals (
         tenant_id, request_id, sequence, label, status, approver_user_id,
         approver_snapshot, decision_note, decided_at
       ) VALUES ($1,$2,1,$3,$4,$5,$6::jsonb,$7,
         CASE WHEN $4='Pending' THEN NULL ELSE now() END)`,
      [tenantId, requestId, label, status, author.id,
        json({ name: author.name, email: author.email, personId: '' }), note],
    )
  }
  for (let i = 0; i < entry.notes.length; i++) {
    await client.query(
      `INSERT INTO service_request_activities
       (tenant_id, request_id, actor_user_id, actor_snapshot, kind, visibility,
         body_text, metadata, created_at)
       VALUES ($1,$2,$3,$4::jsonb,'work','internal',$5,$6::jsonb,now()-($7::int * interval '1 day'))`,
      [tenantId, requestId, author.id, json({ name: 'UI Review Technician' }),
        entry.notes[i], json({ reviewSeedKey: SEED }), entry.notes.length - i],
    )
  }
  return { type: 'Service Request', reference, outcome: 'created' }
}

const client = new Client({ connectionString: env.DATABASE_URL })
await client.connect()
let transactionOpen = false
try {
  const result = await client.query(
    `SELECT t.id,t.slug,t.status,ts.modules,ts.configuration,ts.onboarding_data
     FROM tenants t JOIN tenant_settings ts ON ts.tenant_id=t.id
     WHERE t.slug=$1 LIMIT 1`,
    [tenantSlug],
  )
  if (!result.rowCount) throw new Error(`Tenant "${tenantSlug}" does not exist. Nothing was changed.`)
  const tenant = result.rows[0]
  if (tenant.status !== 'active' || tenant.modules?.itsm !== true) throw new Error('Tenant is not active with ITSM enabled.')
  const authorResult = await client.query(
    `SELECT u.id,u.name,u.email FROM tenant_memberships m
     JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1 AND m.status='active' AND m.role IN ('owner','admin')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,u.created_at
     LIMIT 1`,
    [tenant.id],
  )
  if (!authorResult.rowCount) throw new Error('No active tenant owner/admin to own the review approvals.')
  const author = authorResult.rows[0]
  const config = tenant.configuration && Object.keys(tenant.configuration).length
    ? tenant.configuration : (tenant.onboarding_data || {})

  console.log(`Tenant: ${tenant.slug} | App: ${appUrl} | Mode: ${apply ? 'APPLY' : 'PREVIEW'}`)
  console.log('Review records: 5 Changes and 5 Service Requests.')
  if (!apply) {
    for (const [table, field, entries] of [
      ['itsm_records', 'record_data', changes],
      ['service_requests', 'operational_data', requests],
    ]) {
      for (const item of entries) {
        const ref = await findSeed(client, table, field, tenant.id, item.key)
        console.log(`  ${ref || '(new)'.padEnd(12)} ${item.title} — ${item.status}`)
      }
    }
    console.log('PREVIEW only. Run again with --apply to create any missing records.')
  } else {
    await client.query('BEGIN')
    transactionOpen = true
    // Serialise this fixture for a tenant, including concurrent invocations.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [SEED, tenant.id])
    const output = []
    for (let i=0;i<changes.length;i++) output.push(await createChange(client, tenant.id, author.id, config, changes[i], i+1))
    for (let i=0;i<requests.length;i++) output.push(await createRequest(client, tenant.id, author, requests[i], i+1, config))
    await client.query('COMMIT')
    transactionOpen = false
    for (const item of output) {
      const route = item.type === 'Change' ? 'changes' : 'requests'
      console.log(`  ${item.outcome.padEnd(14)} ${appUrl}/${route}/${item.reference}`)
    }
    console.log(`Review set ready: ${output.filter(o=>o.outcome==='created').length} new, ${output.filter(o=>o.outcome==='already exists').length} already present.`)
    console.log('Fixture inserted directly into local PostgreSQL; API notification handlers were not called.')
  }
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
