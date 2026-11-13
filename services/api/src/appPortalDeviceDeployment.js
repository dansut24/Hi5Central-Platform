import { readFileSync } from 'node:fs'
export const SELF_SERVICE_PORTAL_SHA256 = '635024FD1037D894FE4075240B5C8033F9B072654D311502C6D9B509840CA647'
export const SELF_SERVICE_PATCHHOST_SHA256 = '42389534EAEA555CFBF01FE45D1ED0D1DD69850AC47D611D171E11F30DA4252E'
export const SELF_SERVICE_VERSION = '0.2.0'
export function selfServicePowerShell(enable) {
  if (typeof enable !== 'boolean') throw new Error('Self Service state must be a boolean')
  if (!enable) return [
    "$ErrorActionPreference='Stop'",
    "foreach ($name in @('Hi5CentralSelfServiceOnBoot','Hi5CentralSelfServiceHourly')) {",
    "  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }",
    "}",
    "$root=Join-Path $env:ProgramData 'Hi5Central\\Agent\\SelfService'",
    "if (Test-Path $root) { Set-Content -LiteralPath (Join-Path $root 'disabled.txt') -Value 'Disabled by Hi5Central RMM; existing application retained' -Encoding UTF8 }",
    "[pscustomobject]@{ state='disabled'; applicationRetained=$true } | ConvertTo-Json -Compress",
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
    "& $path",
    "$scriptCommand='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $path",
    "schtasks.exe /Create /F /TN 'Hi5CentralSelfServiceOnBoot' /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $scriptCommand | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'Boot reconciliation task creation failed' }",
    "schtasks.exe /Create /F /TN 'Hi5CentralSelfServiceHourly' /SC HOURLY /MO 1 /RU SYSTEM /RL HIGHEST /TR $scriptCommand | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw 'Hourly reconciliation task creation failed' }",
    "Write-Output 'Hi5Central Self Service deployed with boot and hourly reconciliation'",
  ].join('\n')
}
export function classifySelfServiceDeployment(row) {
  if (!row?.enabled) return 'not_enabled'
  const job = row?.job_status
  if (job === 'queued') return 'queued'
  if (job === 'claimed') return 'installing'
  if (job === 'failed' || job === 'cancelled') return 'failed'
  if (job === 'completed') return 'installed'
  return 'waiting_for_device'
}
