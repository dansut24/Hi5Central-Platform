import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lookup, resolveTxt } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import { pool } from './db.js'
import { deployment } from './deploymentConfig.js'

function encryptionKey() {
  const raw = String(process.env.TENANT_SECRET_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY || '').trim()
  if (!raw) throw new Error('Tenant secret encryption is not configured.')

  let key
  if (raw.length === 64 && [...raw].every((char) => '0123456789abcdefABCDEF'.includes(char))) {
    key = Buffer.from(raw, 'hex')
  } else {
    try { key = Buffer.from(raw, 'base64') } catch { key = Buffer.alloc(0) }
  }

  if (key.length !== 32) throw new Error('Tenant secret encryption key must contain exactly 32 bytes of key material.')
  return key
}

function encryptSecret(value) {
  if (!value) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.')
}

function decryptSecret(envelope) {
  if (!envelope) return ''
  const [iv, tag, encrypted] = String(envelope).split('.')
  if (!iv || !tag || !encrypted) throw new Error('Stored SMTP credential is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function cleanHost(value = '') {
  let host = String(value || '').trim().toLowerCase()
  if (!host) return ''

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase()
    } catch {
      return ''
    }
  } else if (host.includes('/')) {
    host = host.split('/')[0]
  }

  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function validDomain(value = '') {
  const host = cleanHost(value)
  if (!host || host.length > 253 || !host.includes('.')) return false

  const labels = host.split('.')
  return labels.every((label) => {
    if (!label || label.length > 63) return false
    if (!/[a-z0-9]/i.test(label[0]) || !/[a-z0-9]/i.test(label[label.length - 1])) return false
    return [...label].every((char) => /[a-z0-9-]/i.test(char))
  })
}

function cleanEmail(value = '') {
  return String(value || '').trim().toLowerCase()
}

function validEmail(value = '') {
  const email = cleanEmail(value)
  const parts = email.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  return validDomain(parts[1])
}

function privateAddress(address = '') {
  const value = String(address || '').toLowerCase()
  const family = isIP(value)

  if (family === 6) {
    if (value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
    if (value.startsWith('::ffff:')) return privateAddress(value.slice(7))
    return false
  }

  if (family !== 4) return false
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true

  if (octets[0] === 127 || octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  if (octets[0] === 169 && octets[1] === 254) return true
  return false
}

async function assertManagedSmtpHostAllowed(host) {
  if (deployment.deploymentMode !== 'managed' || deployment.runtimeEnvironment !== 'live') return

  const value = cleanHost(host)
  if (!value || value === 'localhost' || value.endsWith('.local') || privateAddress(value)) {
    throw new Error('Managed Hi5Central cannot connect custom SMTP to a private or local address.')
  }

  const addresses = await lookup(value, { all: true })
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new Error('Managed Hi5Central custom SMTP must resolve only to public addresses.')
  }
}

function cleanText(value = '', max = 200) {
  return String(value || '').trim().slice(0, max)
}

function safeConfig(row) {
  if (!row) return null
  return {
    domainMode: row.domain_mode,
    customWorkspaceDomain: row.custom_workspace_domain || '',
    customPortalDomain: row.custom_portal_domain || '',
    domainStatus: row.domain_status || 'default',
    domainVerificationToken: row.domain_verification_token || '',
    smtpMode: row.smtp_mode,
    smtpHost: row.smtp_host || '',
    smtpPort: row.smtp_port || 587,
    smtpSecurity: row.smtp_security || 'starttls',
    smtpUsername: row.smtp_username || '',
    smtpPasswordConfigured: Boolean(row.smtp_password_encrypted),
    smtpFromName: row.smtp_from_name || '',
    smtpFromEmail: row.smtp_from_email || '',
    smtpVerifiedAt: row.smtp_verified_at || null,
  }
}

export async function readTenantDeliverySettings(tenantId, db = pool) {
  const result = await db.query(
    'SELECT * FROM tenant_delivery_settings WHERE tenant_id=$1 LIMIT 1',
    [tenantId],
  )
  return result.rows[0] || null
}

export async function saveTenantDeliverySettings(tenantId, input = {}, db = pool) {
  const existing = await readTenantDeliverySettings(tenantId, db)
  const domainMode = input.domainMode === 'custom' ? 'custom' : 'default'
  const smtpMode = input.smtpMode === 'custom' ? 'custom' : 'default'

  const workspaceDomain = domainMode === 'custom' ? cleanHost(input.customWorkspaceDomain) : null
  const portalDomain = domainMode === 'custom' ? cleanHost(input.customPortalDomain) : null
  const domainChanged = workspaceDomain !== (existing?.custom_workspace_domain || null)
    || portalDomain !== (existing?.custom_portal_domain || null)

  if (domainMode === 'custom' && !workspaceDomain) throw new Error('Enter a custom workspace domain.')
  if (domainMode === 'custom' && !validDomain(workspaceDomain)) {
    throw new Error('Enter a valid workspace domain such as support.example.com.')
  }
  if (domainMode === 'custom' && portalDomain && !validDomain(portalDomain)) {
    throw new Error('Enter a valid portal domain such as help.example.com.')
  }

  const smtpHost = smtpMode === 'custom' ? cleanHost(input.smtpHost) : null
  const smtpPort = smtpMode === 'custom' ? Number(input.smtpPort || 587) : null
  const smtpSecurity = smtpMode === 'custom' && ['starttls', 'tls', 'plain'].includes(input.smtpSecurity)
    ? input.smtpSecurity
    : (smtpMode === 'custom' ? 'starttls' : null)
  const smtpUsername = smtpMode === 'custom' ? cleanText(input.smtpUsername, 320) : null
  const smtpFromName = smtpMode === 'custom' ? cleanText(input.smtpFromName, 160) : null
  const smtpFromEmail = smtpMode === 'custom' ? cleanEmail(input.smtpFromEmail) : null
  const newPassword = smtpMode === 'custom' ? String(input.smtpPassword || '') : ''

  let passwordEnvelope = smtpMode === 'custom' ? (existing?.smtp_password_encrypted || null) : null
  if (smtpMode === 'custom' && newPassword) {
    const existingPassword = existing?.smtp_password_encrypted
      ? decryptSecret(existing.smtp_password_encrypted)
      : ''
    if (newPassword !== existingPassword) passwordEnvelope = encryptSecret(newPassword)
  }

  if (smtpMode === 'custom') {
    if (!smtpHost || !smtpPort || smtpPort < 1 || smtpPort > 65535) throw new Error('Enter a valid SMTP host and port.')
    if (!smtpUsername) throw new Error('Enter the SMTP username.')
    if (!passwordEnvelope) throw new Error('Enter the SMTP password.')
    if (!validEmail(smtpFromEmail)) throw new Error('Enter a valid From email address.')
  }

  const verificationToken = domainMode === 'custom'
    ? (domainChanged || !existing?.domain_verification_token
      ? randomBytes(18).toString('base64url')
      : existing.domain_verification_token)
    : null

  const domainStatus = domainMode === 'custom'
    ? (domainChanged ? 'pending' : existing?.domain_status === 'verified' ? 'verified' : 'pending')
    : 'default'

  const result = await db.query(
    `INSERT INTO tenant_delivery_settings (
      tenant_id,domain_mode,custom_workspace_domain,custom_portal_domain,domain_status,domain_verification_token,
      smtp_mode,smtp_host,smtp_port,smtp_security,smtp_username,smtp_password_encrypted,smtp_from_name,smtp_from_email,
      smtp_verified_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,now())
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      domain_mode=EXCLUDED.domain_mode,
      custom_workspace_domain=EXCLUDED.custom_workspace_domain,
      custom_portal_domain=EXCLUDED.custom_portal_domain,
      domain_status=EXCLUDED.domain_status,
      domain_verification_token=EXCLUDED.domain_verification_token,
      smtp_mode=EXCLUDED.smtp_mode,
      smtp_host=EXCLUDED.smtp_host,
      smtp_port=EXCLUDED.smtp_port,
      smtp_security=EXCLUDED.smtp_security,
      smtp_username=EXCLUDED.smtp_username,
      smtp_password_encrypted=EXCLUDED.smtp_password_encrypted,
      smtp_from_name=EXCLUDED.smtp_from_name,
      smtp_from_email=EXCLUDED.smtp_from_email,
      smtp_verified_at=CASE
        WHEN tenant_delivery_settings.smtp_host IS DISTINCT FROM EXCLUDED.smtp_host
          OR tenant_delivery_settings.smtp_port IS DISTINCT FROM EXCLUDED.smtp_port
          OR tenant_delivery_settings.smtp_security IS DISTINCT FROM EXCLUDED.smtp_security
          OR tenant_delivery_settings.smtp_username IS DISTINCT FROM EXCLUDED.smtp_username
          OR tenant_delivery_settings.smtp_password_encrypted IS DISTINCT FROM EXCLUDED.smtp_password_encrypted
          OR tenant_delivery_settings.smtp_from_email IS DISTINCT FROM EXCLUDED.smtp_from_email
        THEN NULL
        ELSE tenant_delivery_settings.smtp_verified_at
      END,
      updated_at=now()
    RETURNING *`,
    [
      tenantId,
      domainMode,
      workspaceDomain,
      portalDomain,
      domainStatus,
      verificationToken,
      smtpMode,
      smtpHost,
      smtpPort,
      smtpSecurity,
      smtpUsername,
      passwordEnvelope,
      smtpFromName,
      smtpFromEmail,
    ],
  )

  return safeConfig(result.rows[0])
}

function smtpTransportOptions(row, passwordOverride = '') {
  const security = row.smtp_security || 'starttls'
  return {
    host: row.smtp_host,
    port: Number(row.smtp_port || 587),
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'plain',
    auth: {
      user: row.smtp_username,
      pass: passwordOverride || decryptSecret(row.smtp_password_encrypted),
    },
  }
}

export async function verifyTenantSmtp(tenantId, candidate = {}) {
  const existing = await readTenantDeliverySettings(tenantId)
  const row = {
    smtp_host: cleanHost(candidate.smtpHost || existing?.smtp_host),
    smtp_port: Number(candidate.smtpPort || existing?.smtp_port || 587),
    smtp_security: ['starttls', 'tls', 'plain'].includes(candidate.smtpSecurity)
      ? candidate.smtpSecurity
      : (existing?.smtp_security || 'starttls'),
    smtp_username: cleanText(candidate.smtpUsername || existing?.smtp_username, 320),
    smtp_password_encrypted: existing?.smtp_password_encrypted || null,
  }
  const passwordOverride = String(candidate.smtpPassword || '')

  if (!row.smtp_host || !row.smtp_username || (!passwordOverride && !row.smtp_password_encrypted)) {
    throw new Error('Complete the SMTP connection details before testing.')
  }

  await assertManagedSmtpHostAllowed(row.smtp_host)
  const transporter = nodemailer.createTransport(smtpTransportOptions(row, passwordOverride))
  await transporter.verify()
  return true
}

export async function markTenantSmtpVerified(tenantId) {
  await pool.query(
    'UPDATE tenant_delivery_settings SET smtp_verified_at=now(),updated_at=now() WHERE tenant_id=$1',
    [tenantId],
  )
}

export async function tenantNotificationTransport(tenantId) {
  const row = await readTenantDeliverySettings(tenantId)
  if (!row || row.smtp_mode !== 'custom' || !row.smtp_verified_at) return null

  return {
    transporter: nodemailer.createTransport(smtpTransportOptions(row)),
    from: row.smtp_from_email
      ? { name: row.smtp_from_name || undefined, address: row.smtp_from_email }
      : undefined,
  }
}

export function safeTenantDeliverySettings(row) {
  return safeConfig(row)
}

export async function verifyTenantDomain(tenantId) {
  const row = await readTenantDeliverySettings(tenantId)
  if (!row || row.domain_mode !== 'custom' || !row.custom_workspace_domain || !row.domain_verification_token) {
    throw new Error('Save the custom domain before verifying DNS.')
  }

  const expected = `hi5central-verification=${row.domain_verification_token}`
  const domains = [row.custom_workspace_domain, row.custom_portal_domain].filter(Boolean)

  for (const domain of domains) {
    let records
    try {
      records = await resolveTxt(`_hi5central.${domain}`)
    } catch {
      throw new Error(`DNS verification record was not found for ${domain}.`)
    }

    const values = records.map((parts) => parts.join(''))
    if (!values.includes(expected)) {
      throw new Error(`DNS verification record for ${domain} does not match the Hi5Central token.`)
    }
  }

  await pool.query(
    `UPDATE tenant_delivery_settings
     SET domain_status='verified',updated_at=now()
     WHERE tenant_id=$1`,
    [tenantId],
  )

  return safeConfig(await readTenantDeliverySettings(tenantId))
}
