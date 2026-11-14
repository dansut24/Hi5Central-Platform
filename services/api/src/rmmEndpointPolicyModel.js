// Hi5Central endpoint policy catalogue and deterministic per-setting exception resolution.
// This is a control-plane preview, NOT an agent enforcement implementation.
export const ENDPOINT_SETTINGS = Object.freeze([
  { key: 'windows.smb1.enabled', label: 'SMBv1 protocol', category: 'Security baseline', type: 'boolean', risk: 'critical', defaultValue: false, description: 'Keep the legacy SMBv1 component disabled.' },
  { key: 'windows.firewall.domain.enabled', label: 'Domain firewall', category: 'Security baseline', type: 'boolean', risk: 'high', defaultValue: true },
  { key: 'windows.firewall.private.enabled', label: 'Private firewall', category: 'Security baseline', type: 'boolean', risk: 'high', defaultValue: true },
  { key: 'windows.firewall.public.enabled', label: 'Public firewall', category: 'Security baseline', type: 'boolean', risk: 'high', defaultValue: true },
  { key: 'windows.usb.storage.enabled', label: 'USB mass storage', category: 'Configuration profile', type: 'boolean', risk: 'medium', defaultValue: false },
  { key: 'windows.filesystem.long_paths_enabled', label: 'Win32 long file paths', category: 'Configuration profile', type: 'boolean', risk: 'low', defaultValue: true, description: 'Allow supported Win32 applications to use paths beyond MAX_PATH. Supports verified apply and restore.' },
  { key: 'windows.laps.backup_directory', label: 'Windows LAPS backup directory', category: 'Windows LAPS', type: 'enum', values: ['entra', 'ad'], defaultValue: 'entra', description: 'Windows LAPS only supports Entra ID or Active Directory as native backup destinations.' },
  { key: 'windows.laps.password_age_days', label: 'Windows LAPS rotation period (days)', category: 'Windows LAPS', type: 'integer', min: 1, max: 365, defaultValue: 30 },
  { key: 'windows.laps.password_length', label: 'Windows LAPS password length', category: 'Windows LAPS', type: 'integer', min: 8, max: 64, defaultValue: 20 },
  { key: 'windows.laps.password_complexity', label: 'Windows LAPS password complexity', category: 'Windows LAPS', type: 'enum', values: ['4','5','6','7','8'], options: { '4': 'Letters, numbers and special characters', '5': 'Improved readability (Windows 11 24H2+)', '6': 'Long-word passphrase (24H2+)', '7': 'Short-word passphrase (24H2+)', '8': 'Unique-prefix passphrase (24H2+)' }, defaultValue: '4' },
  { key: 'windows.laps.passphrase_length', label: 'Windows LAPS passphrase words (24H2+)', category: 'Windows LAPS', type: 'integer', min: 3, max: 10, defaultValue: 6 },
  { key: 'windows.laps.post_auth_reset_hours', label: 'Windows LAPS post-authentication reset delay (hours)', category: 'Windows LAPS', type: 'integer', min: 0, max: 24, defaultValue: 24 },
  { key: 'windows.laps.post_auth_actions', label: 'Windows LAPS post-authentication action', category: 'Windows LAPS', type: 'enum', values: ['1','3','5','11'], options: { '1': 'Rotate password', '3': 'Rotate and sign out', '5': 'Rotate and reboot', '11': 'Rotate, sign out and terminate processes (24H2+)' }, defaultValue: '3' },
  { key: 'windows.laps.ad_password_encryption', label: 'Encrypt Windows LAPS password in Active Directory', category: 'Windows LAPS', type: 'boolean', defaultValue: true, description: 'Requires AD backup and appropriate domain functional level.' },
  { key: 'windows.laps.managed_account', label: 'Windows LAPS managed account', category: 'Windows LAPS', type: 'text', maxLength: 20, defaultValue: '', description: 'Empty selects the built-in local administrator account. A custom account must already exist.' },
])
const byKey = new Map(ENDPOINT_SETTINGS.map((entry) => [entry.key, entry]))
export function endpointSetting(key) { return byKey.get(key) || null }
export function settingAllowedInProfile(kind, key) {
  const category = endpointSetting(key)?.category
  return kind === 'laps' ? category === 'Windows LAPS' : kind === 'baseline' ? category === 'Security baseline' : kind === 'configuration' ? Boolean(category && category !== 'Windows LAPS') : false
}
export function highRiskEndpointOverride(key, value, mode) {
  return mode === 'override' && (
    (key === 'windows.smb1.enabled' && value === true) ||
    (key.startsWith('windows.firewall.') && value === false) ||
    (key === 'windows.usb.storage.enabled' && value === true)
  )
}
export function validateSettingValue(key, value) {
  const setting = endpointSetting(key)
  if (!setting) throw new Error('Unsupported endpoint setting: ' + key)
  if (setting.type === 'boolean' && typeof value !== 'boolean') throw new Error(setting.label + ' must be true or false.')
  if (setting.type === 'enum' && !setting.values.includes(value)) throw new Error(setting.label + ' has an invalid option.')
  if (setting.type === 'integer' && (!Number.isInteger(value) || value < setting.min || value > setting.max)) throw new Error(setting.label + ' is outside the supported range.')
  if (setting.type === 'text' && (typeof value !== 'string' || value.length > setting.maxLength || /[\r\n]/.test(value))) throw new Error(setting.label + ' must be a short single-line value.')
  return value
}
export function validateSettings(settings) {
  if (!Array.isArray(settings) || settings.length > ENDPOINT_SETTINGS.length) throw new Error('Settings must be a supported list.')
  const found = new Set()
  return settings.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || found.has(item.key)) throw new Error('Duplicate or invalid setting.')
    found.add(item.key)
    return { key: item.key, value: validateSettingValue(item.key, item.value) }
  })
}
const specificity = { user: 100, group: 200, device: 300 }
export function resolveEndpointSetting({ key, configuredValue, exceptions = [], deviceId, groupIds = [], userKey = '', at = new Date() }) {
  const now = new Date(at).getTime()
  const groups = new Set(groupIds.map(String))
  const candidates = exceptions.filter((item) => {
    if (item.setting_key !== key || item.revoked_at || (item.expires_at && new Date(item.expires_at).getTime() <= now)) return false
    if (item.scope_type === 'device') return String(item.scope_id) === String(deviceId)
    if (item.scope_type === 'group') return groups.has(String(item.scope_id))
    if (item.scope_type === 'user') return userKey && String(item.scope_id).toLowerCase() === String(userKey).toLowerCase()
    return false
  }).sort((a, b) => specificity[b.scope_type] - specificity[a.scope_type] || String(a.id).localeCompare(String(b.id)))
  if (!candidates.length) return { key, state: 'configured', value: configuredValue, exception: null }
  const highest = specificity[candidates[0].scope_type]
  const winners = candidates.filter((item) => specificity[item.scope_type] === highest)
  const signatures = new Set(winners.map((item) => JSON.stringify([item.mode, item.mode === 'override' ? item.value : null])))
  if (signatures.size > 1) return { key, state: 'conflict', value: null, exception: null, conflicts: winners.map((e) => e.id) }
  const selected = winners[0]
  return { key, state: selected.mode === 'exclude' ? 'excluded' : 'overridden', value: selected.mode === 'exclude' ? null : selected.value, exception: { id: selected.id, mode: selected.mode, scopeType: selected.scope_type, scopeId: selected.scope_id, reason: selected.reason, expiresAt: selected.expires_at } }
}
export function resolveEndpointProfile({ profile, exceptions, device, groups = [], at = new Date() }) {
  const groupIds = groups.filter((group) => group.deviceIds.includes(device.reference)).map((group) => group.id)
  const userKey = String(device.user_principal_name || device.assigned_person_email || '').trim().toLowerCase()
  const scopeMatch = profile.scope_type === 'estate' || (profile.scope_type === 'device' && String(profile.scope_id) === String(device.id)) || (profile.scope_type === 'group' && groupIds.includes(profile.scope_id)) || (profile.scope_type === 'user' && userKey === profile.scope_id.toLowerCase())
  if (!scopeMatch || profile.status === 'disabled') return { applicable: false, disabled: profile.status === 'disabled', settings: [], deviceId: device.id, profileId: profile.id }
  return { applicable: true, deviceId: device.id, profileId: profile.id, settings: profile.settings.map((entry) => resolveEndpointSetting({ key: entry.key, configuredValue: entry.value, exceptions, deviceId: device.id, groupIds, userKey, at })) }
}
