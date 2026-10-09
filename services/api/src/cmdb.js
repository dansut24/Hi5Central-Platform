import { pool, withTransaction } from './db.js'
import { originMatchesTenant } from './deploymentConfig.js'
import { resolveSession } from './session.js'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const statuses = new Set(['Active', 'In maintenance', 'Retired', 'Planned'])
const criticalities = new Set(['Low', 'Medium', 'High', 'Critical'])
const relationships = new Set(['Depends on', 'Hosted on', 'Connected to', 'Related to'])

const text = (value, max = 255) => String(value ?? '').trim().slice(0, max)
const tags = (value) => Array.isArray(value)
  ? [...new Set(value.map((tag) => text(tag, 60)).filter(Boolean))].slice(0, 30)
  : []
const snapshot = (row) => ({
  id: row.id, reference: row.reference, name: row.name, ciType: row.ci_type,
  status: row.status, criticality: row.criticality, environment: row.environment,
  service: row.service, ownerName: row.owner_name, ownerTeam: row.owner_team,
  site: row.site, manufacturer: row.manufacturer, model: row.model,
  serialNumber: row.serial_number, ipAddress: row.ip_address,
  linkedDeviceId: row.linked_device_id, description: row.description,
  tags: Array.isArray(row.tags) ? row.tags : [],
  createdAt: row.created_at, updatedAt: row.updated_at,
})

async function workspace(c, write = false) {
  const session = await resolveSession(c)
  if (!session) return { error: c.json({ error: 'Authentication required.' }, 401) }
  if (!originMatchesTenant(c.req.header('origin'), session.slug)) {
    return { error: c.json({ error: 'Tenant session mismatch.' }, 403) }
  }
  if (session.tenant_role === 'requester') {
    return { error: c.json({ error: 'Technician workspace access is required.' }, 403) }
  }
  if (write && !['owner', 'admin', 'analyst'].includes(session.tenant_role)) {
    return { error: c.json({ error: 'CMDB editor access is required.' }, 403) }
  }
  return { session }
}

async function item(client, tenantId, key) {
  return (await client.query(
    'SELECT * FROM cmdb_items WHERE tenant_id = $1 AND (id::text = $2 OR reference = $2) LIMIT 1',
    [tenantId, key],
  )).rows[0]
}

function normalize(body, prior = {}) {
  const fields = {
    name: text(body.name === undefined ? prior.name : body.name, 240),
    ci_type: text(body.ciType === undefined ? prior.ci_type : body.ciType, 100) || 'Other',
    status: body.status === undefined ? (prior.status || 'Active') : body.status,
    criticality: body.criticality === undefined ? (prior.criticality || 'Medium') : body.criticality,
    environment: text(body.environment === undefined ? prior.environment : body.environment, 80) || 'Production',
    service: text(body.service === undefined ? prior.service : body.service, 160),
    owner_name: text(body.ownerName === undefined ? prior.owner_name : body.ownerName, 160),
    owner_team: text(body.ownerTeam === undefined ? prior.owner_team : body.ownerTeam, 160),
    site: text(body.site === undefined ? prior.site : body.site, 160),
    manufacturer: text(body.manufacturer === undefined ? prior.manufacturer : body.manufacturer, 160),
    model: text(body.model === undefined ? prior.model : body.model, 160),
    serial_number: text(body.serialNumber === undefined ? prior.serial_number : body.serialNumber, 160),
    ip_address: text(body.ipAddress === undefined ? prior.ip_address : body.ipAddress, 100),
    linked_device_id: text(body.linkedDeviceId === undefined ? prior.linked_device_id : body.linkedDeviceId, 160),
    description: text(body.description === undefined ? prior.description : body.description, 20000),
    tags: tags(body.tags === undefined ? prior.tags : body.tags),
  }
  if (fields.name.length < 2) throw Object.assign(new Error('CI name must be at least two characters.'), { status: 400 })
  if (!statuses.has(fields.status)) throw Object.assign(new Error('Invalid CI status.'), { status: 400 })
  if (!criticalities.has(fields.criticality)) throw Object.assign(new Error('Invalid CI criticality.'), { status: 400 })
  return fields
}

async function detail(tenantId, key) {
  const ci = await item(pool, tenantId, key)
  if (!ci) return null
  const [edges, records] = await Promise.all([
    pool.query(
      `SELECT r.id, r.source_id, r.target_id, r.relationship_type, a.reference AS source_ref,
        a.name AS source_name, b.reference AS target_ref, b.name AS target_name
       FROM cmdb_relationships r
       JOIN cmdb_items a ON a.id = r.source_id AND a.tenant_id = r.tenant_id
       JOIN cmdb_items b ON b.id = r.target_id AND b.tenant_id = r.tenant_id
       WHERE r.tenant_id=$1 AND (r.source_id=$2 OR r.target_id=$2) ORDER BY r.created_at`,
      [tenantId, ci.id],
    ),
    pool.query(
      'SELECT id, record_reference AS reference FROM cmdb_record_links WHERE tenant_id=$1 AND ci_id=$2 ORDER BY created_at DESC',
      [tenantId, ci.id],
    ),
  ])
  return {
    ...snapshot(ci),
    relationships: edges.rows.map((edge) => ({
      id: edge.id, type: edge.relationship_type,
      direction: edge.source_id === ci.id ? 'outbound' : 'inbound',
      itemId: edge.source_id === ci.id ? edge.target_id : edge.source_id,
      reference: edge.source_id === ci.id ? edge.target_ref : edge.source_ref,
      name: edge.source_id === ci.id ? edge.target_name : edge.source_name,
    })),
    records: records.rows,
  }
}

export function registerCmdbRoutes(app) {
  app.get('/api/v1/cmdb', async (c) => {
    const auth = await workspace(c)
    if (auth.error) return auth.error
    const q = text(c.req.query('q'), 160)
    const type = text(c.req.query('type'), 100)
    const status = text(c.req.query('status'), 40)
    const params = [auth.session.tenant_id]
    const where = ['tenant_id = $1']
    if (q) {
      params.push('%' + q.toLowerCase() + '%')
      where.push('(lower(name) LIKE $' + params.length + ' OR lower(reference) LIKE $' + params.length +
        ' OR lower(serial_number) LIKE $' + params.length + ' OR lower(service) LIKE $' + params.length + ')')
    }
    if (type) { params.push(type); where.push('ci_type = $' + params.length) }
    if (status && statuses.has(status)) { params.push(status); where.push('status = $' + params.length) }
    const result = await pool.query(
      'SELECT * FROM cmdb_items WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC, name ASC LIMIT 1000',
      params,
    )
    return c.json({ items: result.rows.map(snapshot) })
  })

  app.get('/api/v1/cmdb/:key', async (c) => {
    const auth = await workspace(c)
    if (auth.error) return auth.error
    const found = await detail(auth.session.tenant_id, text(c.req.param('key'), 160))
    return found ? c.json(found) : c.json({ error: 'Configuration item not found.' }, 404)
  })

  app.post('/api/v1/cmdb', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Valid CI details are required.' }, 400)
    }
    const fields = normalize(body)
    const created = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cmdb:' + auth.session.tenant_id])
      const next = await client.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(reference, '\\D', '', 'g'), '')::integer), 0) + 1 AS number
         FROM cmdb_items WHERE tenant_id=$1`, [auth.session.tenant_id],
      )
      const reference = 'CI-' + String(Number(next.rows[0]?.number || 1)).padStart(5, '0')
      const columns = Object.keys(fields)
      const values = [auth.session.tenant_id, reference, auth.session.user_id, ...Object.values(fields)]
      const params = columns.map((_, index) => '$' + (index + 4) + (columns[index] === 'tags' ? '::jsonb' : ''))
      values[values.length - 1] = JSON.stringify(fields.tags)
      const result = await client.query(
        'INSERT INTO cmdb_items(tenant_id, reference, created_by_user_id, ' + columns.join(',') +
        ') VALUES($1,$2,$3,' + params.join(',') + ') RETURNING id',
        values,
      )
      return result.rows[0].id
    })
    return c.json(await detail(auth.session.tenant_id, created), 201)
  })

  app.patch('/api/v1/cmdb/:key', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Valid CI details are required.' }, 400)
    }
    const updated = await withTransaction(async (client) => {
      const current = await item(client, auth.session.tenant_id, text(c.req.param('key'), 160))
      if (!current) return null
      const fields = normalize(body, current)
      const names = Object.keys(fields)
      const values = [current.id, auth.session.tenant_id, ...Object.values(fields)]
      values[values.length - 1] = JSON.stringify(fields.tags)
      const setters = names.map((col, i) =>
        col + '=$' + (i + 3) + (col === 'tags' ? '::jsonb' : ''))
      await client.query(
        'UPDATE cmdb_items SET ' + setters.join(',') +
        ',updated_at=now() WHERE id=$1 AND tenant_id=$2',
        values,
      )
      return current.id
    })
    return updated ? c.json(await detail(auth.session.tenant_id, updated))
      : c.json({ error: 'Configuration item not found.' }, 404)
  })

  app.post('/api/v1/cmdb/:key/relationships', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const key = text(body?.targetId, 160)
    const type = text(body?.type, 80)
    if (!relationships.has(type)) return c.json({ error: 'Unsupported relationship.' }, 400)
    const source = await item(pool, auth.session.tenant_id, text(c.req.param('key'), 160))
    const target = await item(pool, auth.session.tenant_id, key)
    if (!source || !target) return c.json({ error: 'Both CIs must exist in the current tenant.' }, 404)
    if (source.id === target.id) return c.json({ error: 'A CI cannot relate to itself.' }, 400)
    await pool.query(
      `INSERT INTO cmdb_relationships(tenant_id, source_id, target_id, relationship_type)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [auth.session.tenant_id, source.id, target.id, type],
    )
    return c.json(await detail(auth.session.tenant_id, source.id))
  })

  app.delete('/api/v1/cmdb/:key/relationships/:linkId', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const ci = await item(pool, auth.session.tenant_id, text(c.req.param('key'), 160))
    if (!ci) return c.json({ error: 'Configuration item not found.' }, 404)
    if (!uuid.test(c.req.param('linkId'))) return c.json({ error: 'Invalid relationship.' }, 400)
    await pool.query(
      'DELETE FROM cmdb_relationships WHERE id=$1 AND tenant_id=$2 AND (source_id=$3 OR target_id=$3)',
      [c.req.param('linkId'), auth.session.tenant_id, ci.id],
    )
    return c.json(await detail(auth.session.tenant_id, ci.id))
  })

  app.post('/api/v1/cmdb/:key/records', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const body = await c.req.json().catch(() => ({}))
    const reference = text(body?.reference, 80).toUpperCase()
    if (!/^[A-Z][A-Z0-9-]{2,79}$/.test(reference)) {
      return c.json({ error: 'Enter a valid ITSM record reference.' }, 400)
    }
    const ci = await item(pool, auth.session.tenant_id, text(c.req.param('key'), 160))
    if (!ci) return c.json({ error: 'Configuration item not found.' }, 404)
    // A relationship is meaningful only when the record exists in this tenant.
    const record = await pool.query(
      `SELECT 1 FROM itsm_records WHERE tenant_id=$1 AND upper(reference)=$2
       UNION ALL
       SELECT 1 FROM service_requests WHERE tenant_id=$1 AND upper(reference)=$2
       LIMIT 1`,
      [auth.session.tenant_id, reference],
    )
    if (!record.rowCount) return c.json({ error: 'No ITSM record with that reference exists in this tenant.' }, 404)
    await pool.query(
      `INSERT INTO cmdb_record_links(tenant_id, ci_id, record_reference)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [auth.session.tenant_id, ci.id, reference],
    )
    return c.json(await detail(auth.session.tenant_id, ci.id))
  })

  app.delete('/api/v1/cmdb/:key/records/:linkId', async (c) => {
    const auth = await workspace(c, true)
    if (auth.error) return auth.error
    const ci = await item(pool, auth.session.tenant_id, text(c.req.param('key'), 160))
    if (!ci) return c.json({ error: 'Configuration item not found.' }, 404)
    if (!uuid.test(c.req.param('linkId'))) return c.json({ error: 'Invalid record link.' }, 400)
    await pool.query(
      'DELETE FROM cmdb_record_links WHERE id=$1 AND tenant_id=$2 AND ci_id=$3',
      [c.req.param('linkId'), auth.session.tenant_id, ci.id],
    )
    return c.json(await detail(auth.session.tenant_id, ci.id))
  })
}
