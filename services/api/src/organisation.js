import { pool, withTransaction } from './db.js'
import { resolveSession } from './session.js'
import { originMatchesTenant } from './deploymentConfig.js'

const collections = new Set(['people', 'teams', 'departments', 'sites'])
const maxSnapshotItems = 5000

function originMatchesSession(c, session) {
  return originMatchesTenant(c.req.header('origin'), session.slug)
}

async function requireSession(c, write = false) {
  const session = await resolveSession(c)
  if (!session) return { error: c.json({ error: 'Authentication required.' }, 401) }
  if (!originMatchesSession(c, session)) return { error: c.json({ error: 'Tenant session mismatch.' }, 403) }
  if (write && !['owner', 'admin'].includes(session.tenant_role)) {
    return { error: c.json({ error: 'Tenant administrator access is required.' }, 403) }
  }
  return { session }
}

function text(value, max = 255) {
  return String(value ?? '').trim().slice(0, max)
}

function key(value, fallback = '') {
  const cleaned = text(value || fallback, 80).replace(/[^A-Za-z0-9:_-]/g, '-').replace(/-+/g, '-')
  return cleaned || fallback
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback
}

function bool(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback
}

async function ensureOrganisationSeed(session) {
  const existing = await pool.query(
    'SELECT 1 FROM organisation_people WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
    [session.tenant_id, session.user_id],
  )
  if (existing.rowCount) return

  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [session.tenant_id])
    const locked = await client.query(
      'SELECT 1 FROM organisation_people WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
      [session.tenant_id, session.user_id],
    )
    if (locked.rowCount) return

    const ownerKey = `USR-${String(session.user_id).slice(0, 12).toUpperCase()}`
    await client.query(
      `INSERT INTO organisation_people
         (tenant_id, external_key, user_id, name, email, job_title, access_profile, directory_source)
       VALUES ($1,$2,$3,$4,$5,'Tenant Owner',$6,
               '{"provider":"local","label":"Hi5Central","managedFields":[]}'::jsonb)
       ON CONFLICT (tenant_id, external_key) DO UPDATE SET
         user_id=EXCLUDED.user_id,name=EXCLUDED.name,email=EXCLUDED.email,active=true,updated_at=now()`,
      [
        session.tenant_id,
        ownerKey,
        session.user_id,
        text(session.name, 120),
        text(session.email, 254).toLowerCase(),
        ['owner', 'admin'].includes(session.tenant_role) ? 'tenant_admin' : 'employee',
      ],
    )
  })
}

async function organisationSnapshot(tenantId) {
  const [departmentsResult, teamsResult, sitesResult, peopleResult, membershipResult] = await Promise.all([
    pool.query('SELECT * FROM organisation_departments WHERE tenant_id = $1 ORDER BY name', [tenantId]),
    pool.query('SELECT * FROM organisation_teams WHERE tenant_id = $1 ORDER BY name', [tenantId]),
    pool.query('SELECT * FROM organisation_sites WHERE tenant_id = $1 ORDER BY name', [tenantId]),
    pool.query('SELECT * FROM organisation_people WHERE tenant_id = $1 ORDER BY name', [tenantId]),
    pool.query('SELECT * FROM organisation_team_memberships WHERE tenant_id = $1', [tenantId]),
  ])

  const departmentsById = new Map(departmentsResult.rows.map((row) => [row.id, row]))
  const teamsById = new Map(teamsResult.rows.map((row) => [row.id, row]))
  const sitesById = new Map(sitesResult.rows.map((row) => [row.id, row]))
  const peopleById = new Map(peopleResult.rows.map((row) => [row.id, row]))

  const departments = departmentsResult.rows.map((row) => ({
    id: row.external_key,
    databaseId: row.id,
    name: row.name,
    leadId: peopleById.get(row.lead_person_id)?.external_key || '',
    description: row.description,
    active: row.active,
    source: row.source || {},
  }))

  const teams = teamsResult.rows.map((row) => ({
    id: row.external_key,
    databaseId: row.id,
    name: row.name,
    leadId: peopleById.get(row.lead_person_id)?.external_key || '',
    departmentId: departmentsById.get(row.department_id)?.external_key || '',
    colour: row.colour || 'blue',
    description: row.description,
    active: row.active,
    source: row.source || {},
  }))

  const sites = sitesResult.rows.map((row) => ({
    id: row.external_key,
    databaseId: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    address1: row.address_line1,
    city: row.city,
    postcode: row.postcode,
    country: row.country,
    timezone: row.timezone,
    primaryContactId: peopleById.get(row.primary_contact_id)?.external_key || '',
    supportTeamId: teamsById.get(row.support_team_id)?.external_key || '',
    rmmSite: {
      status: row.rmm_link_status || 'not_linked',
      id: row.rmm_site_key || '',
      label: row.rmm_site_key ? row.name : '',
    },
    notes: row.notes,
    active: row.active,
    source: row.source || {},
  }))

  const people = peopleResult.rows.map((row) => {
    const team = teamsById.get(row.primary_team_id)
    const department = departmentsById.get(row.department_id) || departmentsById.get(team?.department_id)
    const site = sitesById.get(row.site_id)
    return {
      id: row.external_key,
      databaseId: row.id,
      userId: row.user_id || '',
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.job_title,
      teamId: team?.external_key || '',
      team: team?.name || '',
      departmentId: department?.external_key || '',
      managerId: peopleById.get(row.manager_id)?.external_key || '',
      siteId: site?.external_key || '',
      location: site?.name || '',
      status: row.availability,
      capacityHours: Number(row.capacity_hours || 0),
      skills: asArray(row.skills),
      workingPattern: asObject(row.working_pattern),
      accessProfile: row.access_profile,
      directorySource: asObject(row.directory_source),
      active: row.active,
    }
  })

  const teamMemberships = membershipResult.rows.map((row) => ({
    personId: peopleById.get(row.person_id)?.external_key || '',
    teamId: teamsById.get(row.team_id)?.external_key || '',
    role: row.role,
    isPrimary: row.is_primary,
  })).filter((row) => row.personId && row.teamId)

  return { people, teams, departments, sites, teamMemberships }
}

async function externalIdMaps(client, tenantId) {
  const [departments, teams, sites, people] = await Promise.all([
    client.query('SELECT id, external_key FROM organisation_departments WHERE tenant_id = $1', [tenantId]),
    client.query('SELECT id, external_key FROM organisation_teams WHERE tenant_id = $1', [tenantId]),
    client.query('SELECT id, external_key, name FROM organisation_sites WHERE tenant_id = $1', [tenantId]),
    client.query('SELECT id, external_key FROM organisation_people WHERE tenant_id = $1', [tenantId]),
  ])
  return {
    departments: new Map(departments.rows.map((row) => [row.external_key, row.id])),
    teams: new Map(teams.rows.map((row) => [row.external_key, row.id])),
    sites: new Map(sites.rows.map((row) => [row.external_key, row.id])),
    sitesByName: new Map(sites.rows.map((row) => [row.name, row.id])),
    people: new Map(people.rows.map((row) => [row.external_key, row.id])),
  }
}

async function syncDepartments(client, tenantId, items) {
  const maps = await externalIdMaps(client, tenantId)
  for (const item of items) {
    const externalKey = key(item.id, `DEPT-${Date.now()}`)
    await client.query(
      `INSERT INTO organisation_departments
         (tenant_id, external_key, name, description, lead_person_id, source, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
       ON CONFLICT (tenant_id, external_key) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         lead_person_id = EXCLUDED.lead_person_id,
         source = EXCLUDED.source,
         active = EXCLUDED.active,
         updated_at = now()`,
      [tenantId, externalKey, text(item.name, 120), text(item.description, 2000), maps.people.get(item.leadId) || null, JSON.stringify(asObject(item.source)), bool(item.active)],
    )
  }
  if (items.length) {
    await client.query(
      `UPDATE organisation_departments SET active = false, updated_at = now()
       WHERE tenant_id = $1 AND NOT (external_key = ANY($2::text[]))`,
      [tenantId, items.map((item) => key(item.id))],
    )
  }
}

async function syncTeams(client, tenantId, items) {
  const maps = await externalIdMaps(client, tenantId)
  for (const item of items) {
    const externalKey = key(item.id, `TEAM-${Date.now()}`)
    await client.query(
      `INSERT INTO organisation_teams
         (tenant_id, external_key, department_id, name, description, colour, lead_person_id, source, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
       ON CONFLICT (tenant_id, external_key) DO UPDATE SET
         department_id = EXCLUDED.department_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         colour = EXCLUDED.colour,
         lead_person_id = EXCLUDED.lead_person_id,
         source = EXCLUDED.source,
         active = EXCLUDED.active,
         updated_at = now()`,
      [tenantId, externalKey, maps.departments.get(item.departmentId) || null, text(item.name, 120), text(item.description, 2000), text(item.colour || 'blue', 30), maps.people.get(item.leadId) || null, JSON.stringify(asObject(item.source)), bool(item.active)],
    )
  }
  if (items.length) {
    await client.query(
      `UPDATE organisation_teams SET active = false, updated_at = now()
       WHERE tenant_id = $1 AND NOT (external_key = ANY($2::text[]))`,
      [tenantId, items.map((item) => key(item.id))],
    )
  }
}

async function syncSites(client, tenantId, items) {
  const maps = await externalIdMaps(client, tenantId)
  for (const item of items) {
    const externalKey = key(item.id, `SITE-${Date.now()}`)
    const rmm = asObject(item.rmmSite)
    await client.query(
      `INSERT INTO organisation_sites
         (tenant_id, external_key, code, name, type, address_line1, city, postcode, country, timezone,
          primary_contact_id, support_team_id, rmm_site_key, rmm_link_status, notes, source, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,now())
       ON CONFLICT (tenant_id, external_key) DO UPDATE SET
         code = EXCLUDED.code,
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         address_line1 = EXCLUDED.address_line1,
         city = EXCLUDED.city,
         postcode = EXCLUDED.postcode,
         country = EXCLUDED.country,
         timezone = EXCLUDED.timezone,
         primary_contact_id = EXCLUDED.primary_contact_id,
         support_team_id = EXCLUDED.support_team_id,
         rmm_site_key = EXCLUDED.rmm_site_key,
         rmm_link_status = EXCLUDED.rmm_link_status,
         notes = EXCLUDED.notes,
         source = EXCLUDED.source,
         active = EXCLUDED.active,
         updated_at = now()`,
      [
        tenantId,
        externalKey,
        key(item.code || item.name, 'SITE').slice(0, 40),
        text(item.name, 120),
        text(item.type || 'Office', 60),
        text(item.address1, 240),
        text(item.city, 120),
        text(item.postcode, 40),
        text(item.country || 'United Kingdom', 120),
        text(item.timezone || 'Europe/London', 80),
        maps.people.get(item.primaryContactId) || null,
        maps.teams.get(item.supportTeamId) || null,
        text(rmm.id, 120),
        rmm.status === 'linked' ? 'linked' : 'not_linked',
        text(item.notes, 4000),
        JSON.stringify(asObject(item.source)),
        bool(item.active),
      ],
    )
  }
  await client.query(
    `UPDATE organisation_sites SET active = false, updated_at = now()
     WHERE tenant_id = $1 AND NOT (external_key = ANY($2::text[]))`,
    [tenantId, items.map((item) => key(item.id))],
  )
}

async function syncPeople(client, tenantId, items) {
  let maps = await externalIdMaps(client, tenantId)

  for (const item of items) {
    const externalKey = key(item.id, `USR-${Date.now()}`)
    const siteId = maps.sites.get(item.siteId) || maps.sitesByName.get(item.location) || null
    const teamId = maps.teams.get(item.teamId) || null
    const departmentId = maps.departments.get(item.departmentId) || null
    await client.query(
      `INSERT INTO organisation_people
         (tenant_id, external_key, user_id, primary_team_id, department_id, site_id, manager_id,
          name, email, phone, job_title, availability, capacity_hours, skills, working_pattern,
          access_profile, directory_source, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17,now())
       ON CONFLICT (tenant_id, external_key) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, organisation_people.user_id),
         primary_team_id = EXCLUDED.primary_team_id,
         department_id = EXCLUDED.department_id,
         site_id = EXCLUDED.site_id,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         job_title = EXCLUDED.job_title,
         availability = EXCLUDED.availability,
         capacity_hours = EXCLUDED.capacity_hours,
         skills = EXCLUDED.skills,
         working_pattern = EXCLUDED.working_pattern,
         access_profile = EXCLUDED.access_profile,
         directory_source = EXCLUDED.directory_source,
         active = EXCLUDED.active,
         updated_at = now()`,
      [
        tenantId,
        externalKey,
        item.userId || null,
        teamId,
        departmentId,
        siteId,
        text(item.name, 120),
        text(item.email, 254).toLowerCase(),
        text(item.phone, 80),
        text(item.role, 160),
        text(item.status || 'Available', 40),
        Math.max(0, Math.min(168, Number(item.capacityHours || 0))),
        JSON.stringify(asArray(item.skills)),
        JSON.stringify(asObject(item.workingPattern)),
        text(item.accessProfile || 'employee', 60),
        JSON.stringify(asObject(item.directorySource, { provider: 'local', label: 'Hi5Central', managedFields: [] })),
        bool(item.active),
      ],
    )
  }

  maps = await externalIdMaps(client, tenantId)
  for (const item of items) {
    const personId = maps.people.get(key(item.id))
    if (!personId) continue
    const managerId = maps.people.get(item.managerId) || null
    await client.query('UPDATE organisation_people SET manager_id = $2 WHERE id = $1', [personId, managerId])
    await client.query('DELETE FROM organisation_team_memberships WHERE tenant_id = $1 AND person_id = $2 AND is_primary = true', [tenantId, personId])
    const teamId = maps.teams.get(item.teamId)
    if (teamId) {
      await client.query(
        `INSERT INTO organisation_team_memberships (tenant_id, person_id, team_id, role, is_primary)
         VALUES ($1,$2,$3,'member',true)
         ON CONFLICT (person_id, team_id) DO UPDATE SET is_primary = true`,
        [tenantId, personId, teamId],
      )
    }
  }

  if (items.length) {
    await client.query(
      `UPDATE organisation_people SET active = false, updated_at = now()
       WHERE tenant_id = $1 AND NOT (external_key = ANY($2::text[]))`,
      [tenantId, items.map((item) => key(item.id))],
    )
  }
}

function editDenied(message = 'You do not have permission to change this organisation entry.') {
  throw Object.assign(new Error(message), { status: 403 })
}

function validName(value) {
  const name = text(value, 120)
  if (name.length < 2) throw Object.assign(new Error('A name of at least two characters is required.'), { status: 400 })
  return name
}

async function upsertOrganisationEntry(client, session, collection, item) {
  const tenantId = session.tenant_id
  const isTenantAdmin = ['owner', 'admin'].includes(session.tenant_role)
  const actorResult = await client.query(
    'SELECT * FROM organisation_people WHERE tenant_id=$1 AND user_id=$2 LIMIT 1',
    [tenantId, session.user_id],
  )
  const actor = actorResult.rows[0] || null
  const profile = isTenantAdmin ? 'tenant_admin' : actor?.access_profile || 'employee'
  const peopleAdmin = isTenantAdmin || profile === 'people_admin'
  const maps = await externalIdMaps(client, tenantId)
  const itemKey = key(item?.id)
  if (!itemKey) throw Object.assign(new Error('An organisation identifier is required.'), { status: 400 })

  const actorTeam = actor?.primary_team_id || null
  const actorDepartmentResult = actor?.department_id ? actor.department_id : actorTeam
    ? (await client.query('SELECT department_id FROM organisation_teams WHERE tenant_id=$1 AND id=$2', [tenantId, actorTeam])).rows[0]?.department_id
    : null
  const actorDepartment = actorDepartmentResult || null

  const lookup = {
    people: 'organisation_people', teams: 'organisation_teams', departments: 'organisation_departments',
  }
  if (!lookup[collection]) throw Object.assign(new Error('Unsupported organisation collection.'), { status: 404 })
  const found = await client.query(
    'SELECT * FROM ' + lookup[collection] + ' WHERE tenant_id=$1 AND external_key=$2 FOR UPDATE',
    [tenantId, itemKey],
  )
  const current = found.rows[0] || null
  const creating = !current

  // Non-admin edits must be checked against the DATABASE role and scope,
  // never the browser's editable People profile or a submitted accessProfile.
  if (collection === 'departments') {
    if (!peopleAdmin) editDenied('People administrator access is required to manage departments.')
    const name = validName(item.name)
    const source = isTenantAdmin ? asObject(item.source) : asObject(current?.source)
    await client.query(
      `INSERT INTO organisation_departments
        (tenant_id, external_key, name, description, lead_person_id, source, active, updated_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,now())
       ON CONFLICT(tenant_id, external_key) DO UPDATE
         SET name=EXCLUDED.name, description=EXCLUDED.description, lead_person_id=EXCLUDED.lead_person_id,
             source=EXCLUDED.source, active=EXCLUDED.active, updated_at=now()`,
      [
        tenantId, itemKey, name, text(item.description, 2000),
        maps.people.get(item.leadId) || null, JSON.stringify(source), bool(item.active),
      ],
    )
    return
  }

  if (collection === 'teams') {
    const nextDepartmentId = maps.departments.get(item.departmentId) || null
    if (item.departmentId && !nextDepartmentId) {
      throw Object.assign(new Error('Choose a department in this tenant.'), { status: 400 })
    }
    if (!peopleAdmin && !(profile === 'department_manager' && actorDepartment &&
      nextDepartmentId === actorDepartment && (creating || current.department_id === actorDepartment))) {
      editDenied('You can only manage teams in your department.')
    }
    const name = validName(item.name)
    const source = isTenantAdmin ? asObject(item.source) : asObject(current?.source)
    await client.query(
      `INSERT INTO organisation_teams
         (tenant_id,external_key,department_id,name,description,colour,lead_person_id,source,active,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now())
       ON CONFLICT(tenant_id,external_key) DO UPDATE
         SET department_id=EXCLUDED.department_id, name=EXCLUDED.name,
             description=EXCLUDED.description, colour=EXCLUDED.colour,
             lead_person_id=EXCLUDED.lead_person_id, source=EXCLUDED.source,
             active=EXCLUDED.active, updated_at=now()`,
      [
        tenantId, itemKey, nextDepartmentId, name, text(item.description, 2000),
        text(item.colour || 'blue', 30), maps.people.get(item.leadId) || null,
        JSON.stringify(source), bool(item.active),
      ],
    )
    return
  }

  if (creating && !peopleAdmin) editDenied('Only People administrators can create people.')
  const ownRecord = Boolean(actor && current && actor.id === current.id)
  const currentTeam = current?.primary_team_id || null
  const currentDepartment = current?.department_id || (currentTeam
    ? (await client.query('SELECT department_id FROM organisation_teams WHERE tenant_id=$1 AND id=$2', [tenantId, currentTeam])).rows[0]?.department_id
    : null)
  const departmentScoped = profile === 'department_manager' && actorDepartment &&
    currentDepartment === actorDepartment
  const teamScoped = profile === 'team_manager' && actorTeam && currentTeam === actorTeam
  const canBasic = peopleAdmin || ownRecord || departmentScoped || teamScoped
  const canOrganisation = peopleAdmin || departmentScoped || teamScoped
  if (!canBasic) editDenied('You can only edit people within your permitted scope.')

  const source = asObject(current?.directory_source)
  const managed = new Set(asArray(source.managedFields))
  const allowed = (field, canEdit) => canEdit && (isTenantAdmin || !managed.has(field))
  const pick = (field, previous, canEdit) =>
    item[field] !== undefined && allowed(field, canEdit) ? item[field] : previous
  const selectedTeam = pick('teamId', null, canOrganisation)
  const nextTeamId = selectedTeam === null ? currentTeam : maps.teams.get(selectedTeam) || null
  if (selectedTeam && !nextTeamId) {
    throw Object.assign(new Error('Choose a team in this tenant.'), { status: 400 })
  }
  const selectedDepartment = pick('departmentId', null, canOrganisation)
  const nextDepartmentId = selectedDepartment === null
    ? (current?.department_id || null)
    : (maps.departments.get(selectedDepartment) || null)
  if (selectedDepartment && !nextDepartmentId) {
    throw Object.assign(new Error('Choose a department in this tenant.'), { status: 400 })
  }
  const nextTeamDepartment = nextTeamId
    ? (await client.query('SELECT department_id FROM organisation_teams WHERE tenant_id=$1 AND id=$2', [tenantId, nextTeamId])).rows[0]?.department_id
    : null
  const targetDepartment = nextTeamDepartment || nextDepartmentId
  if (departmentScoped && targetDepartment !== actorDepartment) {
    editDenied('You cannot move a person outside your department.')
  }
  if (teamScoped && nextTeamId !== actorTeam) {
    editDenied('You cannot move a person outside your team.')
  }

  const selectedSite = pick('siteId', null, canOrganisation)
  const nextSiteId = selectedSite === null ? (current?.site_id || null) : (maps.sites.get(selectedSite) || null)
  if (selectedSite && !nextSiteId) {
    throw Object.assign(new Error('Choose a site in this tenant.'), { status: 400 })
  }
  const selectedManager = pick('managerId', null, canOrganisation)
  const nextManagerId = selectedManager === null ? (current?.manager_id || null) : (maps.people.get(selectedManager) || null)
  if (selectedManager && !nextManagerId) {
    throw Object.assign(new Error('Choose a manager in this tenant.'), { status: 400 })
  }
  const name = validName(pick('name', current?.name || '', canBasic))
  const values = [
    name,
    text(pick('email', current?.email || '', canOrganisation), 254).toLowerCase(),
    text(pick('phone', current?.phone || '', canBasic), 80),
    text(pick('role', current?.job_title || '', canBasic), 160),
    text(pick('status', current?.availability || 'Available', canBasic), 40),
    Math.max(0, Math.min(168, Number(pick('capacityHours', current?.capacity_hours || 0, canBasic)) || 0)),
    JSON.stringify(asArray(pick('skills', current?.skills || [], canBasic)).map((skill) => text(skill, 100)).slice(0, 40)),
    JSON.stringify(asObject(pick('workingPattern', current?.working_pattern || {}, canBasic))),
    nextTeamId, nextDepartmentId, nextSiteId, nextManagerId,
    isTenantAdmin ? text(item.accessProfile || current?.access_profile || 'employee', 60)
      : current?.access_profile || 'employee',
    isTenantAdmin ? JSON.stringify(asObject(item.directorySource, current?.directory_source || { provider: 'local' }))
      : JSON.stringify(current?.directory_source || { provider: 'local' }),
    peopleAdmin ? bool(item.active, current?.active ?? true) : (current?.active ?? true),
  ]
  if (creating) {
    await client.query(
      `INSERT INTO organisation_people
        (tenant_id,external_key,name,email,phone,job_title,availability,capacity_hours,skills,working_pattern,
         primary_team_id,department_id,site_id,manager_id,access_profile,directory_source,active,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17,now())`,
      [tenantId, itemKey, ...values],
    )
  } else {
    await client.query(
      `UPDATE organisation_people SET name=$3,email=$4,phone=$5,job_title=$6,availability=$7,
        capacity_hours=$8,skills=$9::jsonb,working_pattern=$10::jsonb,
        primary_team_id=$11,department_id=$12,site_id=$13,manager_id=$14,
        access_profile=$15,directory_source=$16::jsonb,active=$17,updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [current.id, tenantId, ...values],
    )
  }
  const personId = current?.id || (await client.query(
    'SELECT id FROM organisation_people WHERE tenant_id=$1 AND external_key=$2',
    [tenantId, itemKey],
  )).rows[0].id
  await client.query(
    'DELETE FROM organisation_team_memberships WHERE tenant_id=$1 AND person_id=$2 AND is_primary=true',
    [tenantId, personId],
  )
  if (nextTeamId) {
    await client.query(
      `INSERT INTO organisation_team_memberships(tenant_id,person_id,team_id,role,is_primary)
       VALUES($1,$2,$3,'member',true)
       ON CONFLICT(person_id,team_id) DO UPDATE SET is_primary=true`,
      [tenantId, personId, nextTeamId],
    )
  }
}

export function registerOrganisationRoutes(app) {
  app.get('/api/v1/organisation', async (c) => {
    const auth = await requireSession(c)
    if (auth.error) return auth.error
    await ensureOrganisationSeed(auth.session)
    return c.json(await organisationSnapshot(auth.session.tenant_id))
  })

  // Per-entry writes avoid full-collection replacement and enforce scope server-side.
  app.post('/api/v1/organisation/:collection/upsert', async (c) => {
    const auth = await requireSession(c)
    if (auth.error) return auth.error
    if (auth.session.tenant_role === 'requester') return c.json({ error: 'Technician access required.' }, 403)
    const collection = text(c.req.param('collection'), 40).toLowerCase()
    if (!['people', 'teams', 'departments'].includes(collection)) {
      return c.json({ error: 'Unsupported organisation collection.' }, 404)
    }
    const body = await c.req.json().catch(() => null)
    const entry = body?.item
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || JSON.stringify(entry).length > 50000) {
      return c.json({ error: 'Valid organisation entry required.' }, 400)
    }
    await ensureOrganisationSeed(auth.session)
    await withTransaction((client) => upsertOrganisationEntry(client, auth.session, collection, entry))
    return c.json(await organisationSnapshot(auth.session.tenant_id))
  })

  app.put('/api/v1/organisation/:collection', async (c) => {
    const auth = await requireSession(c, true)
    if (auth.error) return auth.error
    const collection = String(c.req.param('collection') || '').toLowerCase()
    if (!collections.has(collection)) return c.json({ error: 'Unknown organisation collection.' }, 404)

    let body
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'A valid JSON request body is required.' }, 400)
    }
    const items = body?.items
    if (!Array.isArray(items)) return c.json({ error: 'Organisation items must be an array.' }, 400)
    if (items.length > maxSnapshotItems) return c.json({ error: 'Organisation snapshot is too large.' }, 413)
    if (JSON.stringify(items).length > 2_000_000) return c.json({ error: 'Organisation snapshot is too large.' }, 413)

    await ensureOrganisationSeed(auth.session)
    await withTransaction(async (client) => {
      if (collection === 'departments') await syncDepartments(client, auth.session.tenant_id, items)
      if (collection === 'teams') await syncTeams(client, auth.session.tenant_id, items)
      if (collection === 'sites') await syncSites(client, auth.session.tenant_id, items)
      if (collection === 'people') await syncPeople(client, auth.session.tenant_id, items)
    })

    return c.json(await organisationSnapshot(auth.session.tenant_id))
  })
}
