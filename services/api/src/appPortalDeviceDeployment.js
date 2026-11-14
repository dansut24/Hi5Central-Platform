import { readFileSync } from 'node:fs'
export const SELF_SERVICE_PORTAL_SHA256 = '309BC60398A71868C6E7B4FF481C90FE97F9D0367EE4D99F93C68CC35F859625'
export const SELF_SERVICE_PATCHHOST_SHA256 = '42389534EAEA555CFBF01FE45D1ED0D1DD69850AC47D611D171E11F30DA4252E'
export const SELF_SERVICE_VERSION = '0.2.1'
export function selfServicePowerShell(enable) {
  if (typeof enable !== 'boolean') throw new Error('Self Service state must be a boolean')
  if (!enable) return [
    "$ErrorActionPreference='Stop'",
    "$root=Join-Path $env:ProgramData 'Hi5Central\\Agent\\SelfService'",
    "New-Item -ItemType Directory -Force -Path $root | Out-Null",
    // Block any old scheduled task from recreating the portal.
    "$marker=Join-Path $root 'disabled.txt'",
    "Set-Content -LiteralPath $marker -Value 'Hi5Central Self Service disabled by RMM' -Encoding UTF8",
    "foreach ($name in @('Hi5CentralSelfServiceOnBoot','Hi5CentralSelfServiceHourly')) {",
    "  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {",
    "    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop",
    "  }",
    "}",
    // Do not modify Agent, PatchHost, or any other Program Files directory.
    "$svc=Get-CimInstance Win32_Service -Filter \"Name='Hi5CentralAgent'\" -ErrorAction Stop",
    "if (-not $svc) { throw 'Hi5Central Agent service missing' }",
    "$servicePath=[string]$svc.PathName",
    "if ($servicePath -match '^\\\"([^\\\"]+)\\\"') { $exe=$Matches[1] } else { $exe=($servicePath -split '\\s+--')[0].Trim('\\\"') }",
    "$agentDir=Split-Path -Parent $exe",
    "$pf=[Environment]::GetFolderPath('ProgramFiles')",
    "$allowed=@((Join-Path $pf 'Hi5Central\\Agent'),(Join-Path $pf 'Hi5Tech\\Agent'))",
    "if (-not ($allowed | Where-Object { [IO.Path]::GetFullPath($_).TrimEnd('\\') -ieq [IO.Path]::GetFullPath($agentDir).TrimEnd('\\') })) { throw 'Refusing to remove an app outside a recognised Hi5Central Agent directory' }",
    "$portal=Join-Path $agentDir 'Hi5CentralAppPortal.exe'",
    "$shortcut=Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs\\Hi5Central Self Service.lnk'",
    "if (Test-Path -LiteralPath $portal) {",
    "  $running=@(Get-CimInstance Win32_Process -Filter \"Name='Hi5CentralAppPortal.exe'\" -ErrorAction SilentlyContinue)",
    "  foreach ($proc in $running) {",
    "    if ([string]$proc.ExecutablePath -ieq $portal) { Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop }",
    "  }",
    "  Remove-Item -LiteralPath $portal -Force -ErrorAction Stop",
    "}",
    "if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction Stop }",
    "foreach ($name in @('reconcile.ps1','Hi5CentralAppPortal.exe.before-self-service.bak')) {",
    "  $leftover=Join-Path $root $name",
    "  if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force -ErrorAction Stop }",
    "}",
    "if ((Test-Path -LiteralPath $portal) -or (Test-Path -LiteralPath $shortcut)) { throw 'Self Service removal did not complete' }",
    "$state=[pscustomobject]@{state='removed';applicationRetained=$false;agentRetained=$true;patchHostRetained=$true;removedAt=[DateTime]::UtcNow.ToString('o')}",
    "$state | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'status.json') -Encoding UTF8",
    "$state | ConvertTo-Json -Compress",
  ].join('\n')
  const source = readFileSync(new URL('./appPortalDeviceReconcile.ps1', import.meta.url), 'utf8')
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference='Stop'",
    "$root=Join-Path $env:ProgramData 'Hi5Central\\Agent\\SelfService'",
    "New-Item -ItemType Directory -Force -Path $root | Out-Null",
    "$path=Join-Path $root 'reconcile.ps1'",
    "[IO.File]::WriteAllText($path,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))",
    "Remove-Item -LiteralPath (Join-Path $root 'disabled.txt') -Force -ErrorAction SilentlyContinue",
    // Reconciliation schedules are installed before immediate update so
    // an opened Self Service window can defer a locked EXE update until the
    // user closes it. Never forcibly terminate the end-user portal.
    "$scriptCommand='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $path",
    "schtasks.exe /Create /F /TN 'Hi5CentralSelfServiceOnBoot' /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $scriptCommand | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'Boot reconciliation task creation failed' }",
    "schtasks.exe /Create /F /TN 'Hi5CentralSelfServiceHourly' /SC HOURLY /MO 1 /RU SYSTEM /RL HIGHEST /TR $scriptCommand | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'Hourly reconciliation task creation failed' }",
    "& $path",
    "Write-Output 'Hi5Central Self Service deployed with boot and hourly reconciliation'",
  ].join('\n')
}
export function classifySelfServiceDeployment(row, now = Date.now()) {
  if (!row) return 'not_enabled'
  const status = row.job_status
  if (!row.enabled) {
    if (status === 'queued') return 'removal_queued'
    if (status === 'claimed') return 'removing'
    if (status === 'failed' || status === 'cancelled') return 'removal_failed'
    if (status === 'completed') {
      const exitCode = row.job_result?.exit_code
      return exitCode === 0 || exitCode === '0' ? 'removed' : 'removal_failed'
    }
    return 'not_enabled'
  }
  if (status === 'queued') return 'queued'
  if (status === 'claimed') {
    const claimedAt = Date.parse(String(row.claimed_at || ''))
    if (Number.isFinite(claimedAt) && now - claimedAt > 390_000) return 'stalled'
    return 'installing'
  }
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'completed') {
    const exitCode = row.job_result?.exit_code
    return (exitCode === 0 || exitCode === '0') ? 'installed' : 'failed'
  }
  return 'waiting_for_device'
}
