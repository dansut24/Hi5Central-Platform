// Explicit, allowlisted Windows policy adapters via the existing authenticated agent job channel.
// Never pass user-authored PowerShell to this builder.
import { validateSettingValue } from './rmmEndpointPolicyModel.js'
export const WINDOWS_POLICY_WRITE_KEYS = Object.freeze(['windows.filesystem.long_paths_enabled'])
export const WINDOWS_POLICY_READ_KEYS = Object.freeze([...WINDOWS_POLICY_WRITE_KEYS, 'windows.smb1.enabled', 'windows.firewall.domain.enabled', 'windows.firewall.private.enabled', 'windows.firewall.public.enabled', 'windows.laps.backup_directory'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POWERSHELL_TEMPLATE = "\n$ErrorActionPreference = 'Stop'\n$descriptor = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('H5C_DESCRIPTOR_B64')) | ConvertFrom-Json\n$results = @()\nfunction Read-H5CSetting([string] $Key) {\n  if ($Key -eq 'windows.filesystem.long_paths_enabled') {\n    return ([int](Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled) -eq 1\n  }\n  if ($Key -eq 'windows.smb1.enabled') {\n    $feature = Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -ErrorAction Stop\n    return @('Enabled','EnablePending') -contains [string]$feature.State\n  }\n  if ($Key -like 'windows.firewall.*.enabled') {\n    $profileName = ($Key.Split('.')[2])\n    $profile = Get-NetFirewallProfile -Name $profileName -ErrorAction Stop\n    return [bool]$profile.Enabled\n  }\n  if ($Key -eq 'windows.laps.backup_directory') {\n    $roots = @('HKLM:\\SOFTWARE\\Microsoft\\Policies\\LAPS','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\LAPS','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\LAPS\\Config')\n    foreach ($root in $roots) {\n      if (Test-Path $root) {\n        $found = Get-ItemProperty -Path $root -Name BackupDirectory -ErrorAction SilentlyContinue\n        if ($null -ne $found) {\n          if ([int]$found.BackupDirectory -eq 1) { return 'entra' }\n          if ([int]$found.BackupDirectory -eq 2) { return 'ad' }\n          return 'disabled'\n        }\n      }\n    }\n    return 'unconfigured'\n  }\n  throw 'Unsupported setting'\n}\nforeach ($setting in $descriptor.settings) {\n  $key = [string]$setting.key\n  try {\n    $before = Read-H5CSetting $key\n    if ($descriptor.action -eq 'audit') {\n      $results += [ordered]@{ key=$key; action='audit'; observed=$before; status='observed' }\n      continue\n    }\n    if ($key -ne 'windows.filesystem.long_paths_enabled') { throw 'Write adapter unavailable' }\n    $base = 'HKLM:\\SOFTWARE\\Hi5Central\\EndpointPolicyBackups'\n    $backupPath = Join-Path $base ([string]$descriptor.profileId)\n    $backupName = 'LongPathsEnabled'\n    if ($descriptor.action -eq 'apply') {\n      $existing = Get-ItemProperty -Path $backupPath -Name $backupName -ErrorAction SilentlyContinue\n      if ($null -eq $existing) {\n        New-Item -Path $backupPath -Force | Out-Null\n        New-ItemProperty -Path $backupPath -Name $backupName -PropertyType DWord -Value ([int]$before) -Force | Out-Null\n      }\n      $expected = [bool]$setting.value\n    } else {\n      $backup = Get-ItemProperty -Path $backupPath -Name $backupName -ErrorAction SilentlyContinue\n      if ($null -eq $backup) { throw 'No previously saved value; refusing unsafe default restoration' }\n      $expected = [bool]([int]$backup.LongPathsEnabled -eq 1)\n    }\n    New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -PropertyType DWord -Value ([int]$expected) -Force | Out-Null\n    $observed = Read-H5CSetting $key\n    if ($observed -ne $expected) { throw 'Post-write verification mismatch' }\n    if ($descriptor.action -eq 'restore') { Remove-ItemProperty -Path $backupPath -Name $backupName -ErrorAction Stop }\n    $results += [ordered]@{ key=$key; action=$descriptor.action; before=$before; expected=$expected; observed=$observed; status='verified' }\n  } catch {\n    $results += [ordered]@{ key=$key; action=$descriptor.action; status='failed'; error=[string]$_.Exception.Message }\n  }\n}\n$out = [ordered]@{ protocol='h5c.endpoint.v1'; profileId=$descriptor.profileId; action=$descriptor.action; results=@($results); collectedAt=[DateTime]::UtcNow.ToString('o') }\nWrite-Output ('H5C_ENDPOINT_POLICY=' + ($out | ConvertTo-Json -Compress -Depth 6))\nif (@($results | Where-Object { $_.status -eq 'failed' }).Count -gt 0) { exit 2 }\n";
export function buildWindowsPolicyCommand({ profileId, action, settings }) {
  if (!uuidPattern.test(profileId)) throw new Error('Invalid profile ID.')
  if (!['audit','apply','restore'].includes(action)) throw new Error('Invalid action.')
  if (!Array.isArray(settings) || !settings.length || settings.length > 32) throw new Error('Invalid setting list.')
  const keys = new Set()
  const items = settings.map((item) => {
    if (!item || keys.has(item.key)) throw new Error('Duplicate setting.')
    keys.add(item.key)
    if (!(action === 'audit' ? WINDOWS_POLICY_READ_KEYS : WINDOWS_POLICY_WRITE_KEYS).includes(item.key)) throw new Error('Windows adapter unavailable for ' + item.key)
    return { key: item.key, value: validateSettingValue(item.key,item.value) }
  })
  if (action !== 'audit' && items.length !== 1) throw new Error('Apply or restore exactly one setting.')
  const descriptor = Buffer.from(JSON.stringify({ version:1,profileId,action,settings:items }), 'utf8').toString('base64')
  return POWERSHELL_TEMPLATE.replace('H5C_DESCRIPTOR_B64',descriptor)
}
export function parseWindowsPolicyResult(output) {
  const marker = 'H5C_ENDPOINT_POLICY='
  const line = String(output || '').split(/\r?\n/).find((line)=>line.startsWith(marker))
  if (!line) return null
  try {
    const result = JSON.parse(line.slice(marker.length))
    return result.protocol === 'h5c.endpoint.v1' && Array.isArray(result.results) ? result : null
  } catch { return null }
}
