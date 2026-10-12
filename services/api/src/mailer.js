import nodemailer from 'nodemailer'
import { deployment } from './deploymentConfig.js'

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT || 587)
  const user = process.env.SMTP_USER || ''
  const pass = process.env.SMTP_PASSWORD || ''
  const host = process.env.SMTP_HOST || 'smtp.ionos.co.uk'

  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be configured before email can be sent.')
  }

  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function emailShell({ kicker, title, body, actionLabel, actionUrl, footer }) {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f3f6fb;font-family:Arial,sans-serif;color:#10213f">
    <table width="100%" role="presentation" cellspacing="0" cellpadding="0" style="padding:32px 16px;background:#f3f6fb">
      <tr>
        <td align="center">
          <table width="100%" role="presentation" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe6ef;border-radius:16px;overflow:hidden">
            <tr><td style="padding:28px 32px;background:#10213f;color:#ffffff;font-size:20px;font-weight:700">Hi5Central</td></tr>
            <tr>
              <td style="padding:32px">
                <div style="font-size:14px;color:#5d6b82;margin-bottom:12px">${escapeHtml(kicker)}</div>
                <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(title)}</h1>
                <p style="font-size:16px;line-height:1.6;margin:0 0 18px">${body}</p>
                <p style="margin:26px 0"><a href="${actionUrl}" style="display:inline-block;background:#f59e0b;color:#10213f;text-decoration:none;font-weight:700;padding:14px 20px;border-radius:10px">${escapeHtml(actionLabel)}</a></p>
                <p style="font-size:14px;line-height:1.6;color:#5d6b82;margin:0">${footer}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export async function sendVerificationEmail({ to, name, companyName, token, tenantUrl }) {
  const transporter = nodemailer.createTransport(smtpConfig())
  const apiBase = deployment.apiUrl || deployment.appUrl || `https://${deployment.rootDomain}`
  const verificationUrl = `${apiBase}/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`
  const from = process.env.SMTP_FROM || process.env.SMTP_USER

  return transporter.sendMail({
    from,
    to,
    subject: `Verify your ${companyName} Hi5Central workspace`,
    text: [
      `Hi ${name},`,
      '',
      `Your Hi5Central workspace for ${companyName} has been reserved.`,
      `Verify your email and continue setup: ${verificationUrl}`,
      '',
      'This link expires in 24 hours and can only be used once.',
      `Workspace: ${tenantUrl}`,
    ].join('\n'),
    html: emailShell({
      kicker: 'Verify your workspace',
      title: `Welcome to Hi5Central, ${name}.`,
      body: `Your workspace for <strong>${escapeHtml(companyName)}</strong> has been reserved. Verify this email address to activate the tenant and continue setup.`,
      actionLabel: 'Verify email and continue',
      actionUrl: verificationUrl,
      footer: `This link expires in 24 hours and can only be used once.<br>Workspace: ${escapeHtml(tenantUrl)}`,
    }),
  })
}

export async function sendPasswordResetEmail({ to, name, companyName, token, tenantUrl }) {
  const transporter = nodemailer.createTransport(smtpConfig())
  const resetUrl = `${tenantUrl}/reset-password?token=${encodeURIComponent(token)}`
  const from = process.env.SMTP_FROM || process.env.SMTP_USER

  return transporter.sendMail({
    from,
    to,
    subject: `Reset your ${companyName} Hi5Central password`,
    text: [
      `Hi ${name},`,
      '',
      `A password reset was requested for your ${companyName} Hi5Central account.`,
      `Reset your password: ${resetUrl}`,
      '',
      'This link expires in 60 minutes and can only be used once.',
      'If you did not request this reset, you can ignore this email.',
    ].join('\n'),
    html: emailShell({
      kicker: 'Password reset',
      title: `Reset your Hi5Central password`,
      body: `A password reset was requested for your <strong>${escapeHtml(companyName)}</strong> account. If this was you, choose a new password using the secure link below.`,
      actionLabel: 'Reset password',
      actionUrl: resetUrl,
      footer: 'This link expires in 60 minutes and can only be used once. If you did not request it, no action is required.',
    }),
  })
}

export async function sendPortalActivationEmail({ to, name, companyName, token, portalUrl }) {
  const transporter = nodemailer.createTransport(smtpConfig())
  const activationUrl = `${portalUrl}/activate?token=${encodeURIComponent(token)}`
  const from = process.env.SMTP_FROM || process.env.SMTP_USER

  return transporter.sendMail({
    from,
    to,
    subject: `Activate your ${companyName} Help Centre access`,
    text: [
      `Hi ${name},`,
      '',
      `${companyName} uses Hi5Central for IT help and service requests.`,
      `Activate your Help Centre access: ${activationUrl}`,
      '',
      'This link expires in 60 minutes and can only be used once.',
      `Help Centre: ${portalUrl}`,
    ].join('\n'),
    html: emailShell({
      kicker: 'Activate your Help Centre',
      title: `Welcome, ${name}.`,
      body: `<strong>${escapeHtml(companyName)}</strong> uses Hi5Central for IT help and service requests. Create your Portal access to submit requests and follow their progress.`,
      actionLabel: 'Activate Help Centre access',
      actionUrl: activationUrl,
      footer: `This link expires in 60 minutes and can only be used once.<br>Help Centre: ${escapeHtml(portalUrl)}`,
    }),
  })
}

export async function sendTenantOwnerTransferApprovalEmail({
  to, name, companyName, proposedOwnerEmail, token, requestedBy,
}) {
  const transporter = nodemailer.createTransport(smtpConfig())
  const apiBase = deployment.apiUrl || deployment.appUrl || `https://${deployment.rootDomain}`
  const approvalUrl = `${apiBase}/api/platform/v1/tenant-owner-transfer/confirm?token=${encodeURIComponent(token)}`
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  const requester = requestedBy ? ` by ${requestedBy}` : ''

  return transporter.sendMail({
    from,
    to,
    subject: `Approve the ${companyName} Hi5Central owner change`,
    text: [
      `Hi ${name},`,
      '',
      `A Hi5Central platform administrator${requester} requested that ownership of ${companyName} be transferred to ${proposedOwnerEmail}.`,
      `Review and approve the transfer: ${approvalUrl}`,
      '',
      'Nothing changes unless you approve it. This link expires in 24 hours and can only be used once.',
      'If you did not expect this request, do not approve it and contact Hi5Central support.',
    ].join('\n'),
    html: emailShell({
      kicker: 'Tenant ownership approval',
      title: `Approve the owner change for ${companyName}`,
      body: `A Hi5Central platform administrator${escapeHtml(requester)} requested that ownership be transferred to <strong>${escapeHtml(proposedOwnerEmail)}</strong>. Nothing changes until you approve this request.`,
      actionLabel: 'Review owner transfer',
      actionUrl: approvalUrl,
      footer: 'This link expires in 24 hours and can only be used once. If you did not expect this request, do not approve it and contact Hi5Central support.',
    }),
  })
}

export async function verifySmtpConnection() {
  const transporter = nodemailer.createTransport(smtpConfig())
  await transporter.verify()
  return true
}

export async function sendMfaRecoveryEmail({ to, name, token }) {
  const transporter = nodemailer.createTransport(smtpConfig())
  // The secret is in the URL fragment; browsers never transmit fragments to
  // HTTP servers, proxies, or ordinary access logs.
  const recoveryUrl = `${deployment.apiUrl}/api/v1/auth/mfa-recovery/confirm#token=${encodeURIComponent(token)}`
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Hi5Central account authenticator recovery',
    text: [
      `Hi ${name},`, '',
      'A request was made to replace your Hi5Central authenticator.',
      `Open this secure recovery link: ${recoveryUrl}`,
      '',
      'This link expires after 15 minutes and can only be used once.',
      'You will need your current account password again to continue.',
      'If this was not you, ignore the email and contact Hi5Central support.'
    ].join('\n'),
    html: emailShell({
      kicker:'Account security recovery',
      title:'Replace your Hi5Central authenticator',
      body:'A request was made to replace the authenticator protecting your account. You will be asked to confirm your existing password before your old factor is invalidated.',
      actionLabel:'Continue secure recovery',
      actionUrl:recoveryUrl,
      footer:'This link expires after 15 minutes and can only be used once. If you did not request this, ignore this email and contact support.'
    })
  })
}


export async function sendOnboardingCompletionEmail({
  to, name, companyName, updateMode, environments,
}) {
  const safeCompany = String(companyName || 'your organisation').slice(0, 160)
  const safeName = String(name || 'there').slice(0, 160)
  const managed = updateMode === 'hi5_managed'
  const descriptions = {
    live: 'Your everyday Production workspace',
    test: 'Restricted evaluation area with the latest features — not for everyday tickets',
    uat: 'Review and approve updates before releasing them into Production',
  }
  const links = environments.filter(item =>
    ['live', 'test', 'uat'].includes(item.environment) &&
    /^https:\/\/[a-z0-9-]+\.hi5central\.com$/i.test(String(item.url || ''))
  )
  const title = 'Your Hi5Central workspaces are ready'
  const body = [
    `Hello ${safeName},`, '',
    `Onboarding for ${safeCompany} is complete.`,
    '',
    ...links.flatMap(({ environment, url }) => [
      `${environment === 'live' ? 'Production' : environment.toUpperCase()}: ${url}`,
      descriptions[environment],
      '',
    ]),
    managed
      ? 'Updates: Hi5Central-managed. Approved Production releases are scheduled during your maintenance window. You do not have a customer UAT workspace.'
      : 'Updates: Customer-controlled. Test releases in UAT, then approve promotion to Production when ready.',
    '',
    'You can find these links again under Releases / Environments in your Production workspace.',
    'Use your existing Hi5Central login and required multi-factor authentication to access permitted environments.',
    '',
    'Hi5Central'
  ].join('\n')
  const linkRows = links.map(({ environment, url }) =>
    `<tr><td style="padding:12px 0;border-bottom:1px solid #e3eaf3">
      <strong style="color:#10213f;font-size:15px">${escapeHtml(environment === 'live' ? 'Production' : environment.toUpperCase())}</strong>
      <div style="margin-top:4px;font-size:13px;color:#5b7089">${escapeHtml(descriptions[environment])}</div>
      <a href="${escapeHtml(url)}" style="display:block;margin-top:6px;overflow-wrap:anywhere;color:#086eb3;font-size:14px">${escapeHtml(url)}</a>
    </td></tr>`
  ).join('')
  const notice = managed
    ? 'Hi5Central manages Production update scheduling; Test is a restricted preview.'
    : 'Approve your tested UAT changes before they enter Production.'
  const transporter = nodemailer.createTransport({
    ...smtpConfig(), connectionTimeout: 7000, greetingTimeout: 7000, socketTimeout: 10000,
  })
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `Your ${safeCompany} Hi5Central workspaces are ready`,
    text: body,
    html: emailShell({
      kicker: 'Onboarding complete',
      title,
      body: `Your workspace for <strong>${escapeHtml(safeCompany)}</strong> is ready.
        <table width="100%" cellspacing="0" cellpadding="0" role="presentation">${linkRows}</table>
        <span style="display:block;margin-top:18px;color:#5b7089;font-size:13px">${escapeHtml(notice)}</span>`,
      actionLabel: 'Open Production workspace',
      actionUrl: links.find(item => item.environment === 'live')?.url || 'https://hi5central.com',
      footer: 'Keep this email for reference. All access requires your existing credentials and MFA; no passwords or security codes are included.',
    }),
  })
}
