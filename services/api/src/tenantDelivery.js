import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import { pool } from './db.js'

function encryptionKey() {
  const raw = String(process.env.TENANT_SECRET_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY || '').trim()
  if (!raw) throw new Error('Tenant secret encryption is not configured.')

  let key
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex')
  else {
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

function cleanHost(value='') {
  return String(value).trim().toLowerCase().replace(/^https?:///,'').replace(//.*$/,'').replace(/.$/,'')
}

function cleanEmail(value='') {
  return String(value).trim().toLowerCase()
}

function cleanText(value='', max=200) {
  return String(value || '').trim().slice(0,max)
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

export async function readTenantDeliverySettings(tenantId, db=pool) {
  const result = await db.query('SELECT * FROM tenant_delivery_settings WHERE tenant_id=$1 LIMIT 1',[tenantId])
  return result.rows[0] || null
}

export async function saveTenantDeliverySettings(tenantId, input={}, db=pool) {
  const existing = await readTenantDeliverySettings(tenantId, db)
  const domainMode = input.domainMode === 'custom' ? 'custom' : 'default'
  const smtpMode = input.smtpMode === 'custom' ? 'custom' : 'default'
  const workspaceDomain = domainMode === 'custom' ? cleanHost(input.customWorkspaceDomain) : null
  const portalDomain = domainMode === 'custom' ? cleanHost(input.customPortalDomain) : null
  const domainChanged = workspaceDomain !== (existing?.custom_workspace_domain || null)
    || portalDomain !== (existing?.custom_portal_domain || null)

  if (domainMode === 'custom' && !workspaceDomain) throw new Error('Enter a custom workspace domain.')

  const smtpHost = smtpMode === 'custom' ? cleanHost(input.smtpHost) : null
  const smtpPort = smtpMode === 'custom' ? Number(input.smtpPort || 587) : null
  const smtpSecurity = smtpMode === 'custom' && ['starttls','tls','plain'].includes(input.smtpSecurity)
    ? input.smtpSecurity
    : (smtpMode === 'custom' ? 'starttls' : null)
  const smtpUsername = smtpMode === 'custom' ? cleanText(input.smtpUsername,320) : null
  const smtpFromName = smtpMode === 'custom' ? cleanText(input.smtpFromName,160) : null
  const smtpFromEmail = smtpMode === 'custom' ? cleanEmail(input.smtpFromEmail) : null
  const newPassword = smtpMode === 'custom' ? String(input.smtpPassword || '') : ''
  let passwordEnvelope = smtpMode === 'custom' ? (existing?.smtp_password_encrypted || null) : null
  if (smtpMode === 'custom' && newPassword) {
    const existingPassword = existing?.smtp_password_encrypted ? decryptSecret(existing.smtp_password_encrypted) : ''
    if (newPassword !== existingPassword) passwordEnvelope = encryptSecret(newPassword)
  }

  if (smtpMode === 'custom') {
    if (!smtpHost || !smtpPort || smtpPort < 1 || smtpPort > 65535) throw new Error('Enter a valid SMTP host and port.')
    if (!smtpUsername) throw new Error('Enter the SMTP username.')
    if (!passwordEnvelope) throw new Error('Enter the SMTP password.')
    if (!smtpFromEmail || !/^[^@s]+@[^@s]+.[^@s]+$/.test(smtpFromEmail)) throw new Error('Enter a valid From email address.')
  }

  const verificationToken = domainMode === 'custom'
    ? (domainChanged || !existing?.domain_verification_token ? randomBytes(18).toString('base64url') : existing.domain_verification_token)
    : null
  const domainStatus = domainMode === 'custom'
    ? (domainChanged ? 'pending' : existing?.domain_status === 'verified' ? 'verified' : 'pending')
    : 'default'

  const result = await db.query(
    `INSERT INTO tenant_delivery_settings (
      tenant_id,domain_mode,custom_workspace_domain,custom_portal_domain,domain_status,domain_verification_token,
      smtp_mode,smtp_host,smtp_port,smtp_security,smtp_username,smtp_password_encrypted,smtp_from_name,smtp_from_email,
      smtp_verified_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
      CASE WHEN $7='custom' THEN NULL ELSE NULL END,now())
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
          OR tenant_delivery_settings.smtp_username IS DISTINCT FROM EXCLUDED.smtp_username
          OR tenant_delivery_settings.smtp_password_encrypted IS DISTINCT FROM EXCLUDED.smtp_password_encrypted
        THEN NULL
        ELSE tenant_delivery_settings.smtp_verified_at
      END,
      updated_at=now()
    RETURNING *`,
    [tenantId,domainMode,workspaceDomain,portalDomain,domainStatus,verificationToken,smtpMode,smtpHost,smtpPort,smtpSecurity,smtpUsername,passwordEnvelope,smtpFromName,smtpFromEmail],
  )
  return safeConfig(result.rows[0])
}

function smtpTransportOptions(row, passwordOverride='') {
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

export async function verifyTenantSmtp(tenantId, candidate={}) {
  const existing = await readTenantDeliverySettings(tenantId)
  const row = {
    smtp_host: cleanHost(candidate.smtpHost || existing?.smtp_host),
    smtp_port: Number(candidate.smtpPort || existing?.smtp_port || 587),
    smtp_security: ['starttls','tls','plain'].includes(candidate.smtpSecurity) ? candidate.smtpSecurity : (existing?.smtp_security || 'starttls'),
    smtp_username: cleanText(candidate.smtpUsername || existing?.smtp_username,320),
    smtp_password_encrypted: existing?.smtp_password_encrypted || null,
  }
  const passwordOverride = String(candidate.smtpPassword || '')
  if (!row.smtp_host || !row.smtp_username || (!passwordOverride && !row.smtp_password_encrypted)) {
    throw new Error('Complete the SMTP connection details before testing.')
  }
  const transporter = nodemailer.createTransport(smtpTransportOptions(row,passwordOverride))
  await transporter.verify()
  return true
}

export async function markTenantSmtpVerified(tenantId) {
  await pool.query('UPDATE tenant_delivery_settings SET smtp_verified_at=now(),updated_at=now() WHERE tenant_id=$1',[tenantId])
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
