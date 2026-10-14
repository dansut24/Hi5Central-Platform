// RFC-style TOTP provisioning label. Authenticator apps use the issuer as
// the display service name, and the account field as the email address.
export const MFA_ISSUER = 'Hi5Central'
export function authenticatorAccount(email) {
  return String(email || '').trim().toLowerCase()
}
export function totpProvisioningUri(secret,email) {
  const account=authenticatorAccount(email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) throw Error('Valid email is required for MFA setup.')
  const key=String(secret || '').trim().toUpperCase()
  if(!/^[A-Z2-7]{16,64}$/.test(key)) throw Error('Invalid MFA provisioning key.')
  const label=`${MFA_ISSUER}:${account}`
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(key)}&issuer=${encodeURIComponent(MFA_ISSUER)}&algorithm=SHA1&digits=6&period=30`
}
