<#
Hi5Central EPM local broker connectivity test.
Run from a non-elevated PowerShell in the same interactive Windows session
where the native UAC prompt will be shown. READ-ONLY; no UAC request, admin
credential, file launch, API mutation, privilege or account change.
#>
$ErrorActionPreference='Stop'
$service=Get-CimInstance Win32_Service -Filter "Name='Hi5CentralEpmPilot'"
if(!$service) {throw 'FAIL: Hi5CentralEpmPilot Windows service is not installed.'}
Write-Host ("Service: {0} | PID: {1} | RunAs: {2}" -f $service.State,$service.ProcessId,$service.StartName)
if($service.State -ne 'Running' -or $service.ProcessId -le 0) {
  throw 'FAIL: Hi5Central Windows broker is stopped.'
}
Write-Host ("Windows user: {0} | PID: {1} | Session: {2}" -f
  [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  $PID,(Get-Process -Id $PID).SessionId)
$pipe=$null
try {
  $pipe=[System.IO.Pipes.NamedPipeClientStream]::new(
    '.', 'Hi5CentralEpmPilot',
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None,
    [System.Security.Principal.TokenImpersonationLevel]::Impersonation
  )
  $pipe.Connect(5000)
  $pipe.ReadMode=[System.IO.Pipes.PipeTransmissionMode]::Message
  $request=[System.Text.Encoding]::UTF8.GetBytes('{"type":"watch"}')
  $pipe.Write($request,0,$request.Length)
  $pipe.Flush()
  $stream=[System.IO.MemoryStream]::new()
  try {
    $buffer=New-Object byte[] 4096
    do {
      $read=$pipe.Read($buffer,0,$buffer.Length)
      if($read -le 0){throw 'The EPM Windows broker disconnected without responding.'}
      $stream.Write($buffer,0,$read)
      if($stream.Length -gt 16384){throw 'Broker response exceeded safe bounds.'}
    } while (-not $pipe.IsMessageComplete)
    $response=[System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } finally {$stream.Dispose()}
  if($response.success -ne $true) {
    $reason=if($response.error){$response.error}else{'Unknown broker rejection'}
    throw "Broker responded but refused request: $reason"
  }
  Write-Host 'PASS: current Windows user authenticated to EPM SYSTEM broker, and named-pipe request/reply succeeded.' -ForegroundColor Green
  Write-Host 'This only proves local communication. It does not approve or elevate any UAC action.'
} catch {
  Write-Warning ("Broker test failed: "+$_.Exception.Message)
  Write-Host 'Check Windows service health, the named pipe ACL and the Windows pipe error shown by the Hi5Central UAC tile.'
  throw
} finally {
  if($pipe){$pipe.Dispose()}
}
