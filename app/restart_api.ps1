$ErrorActionPreference = 'Continue'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  if ($p.CommandLine -like '*hmdao-api.mjs*') {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host ("killed api pid=" + $p.ProcessId)
  }
}
Start-Sleep -Seconds 2
Start-Process -FilePath 'node' -ArgumentList 'server/hmdao-api.mjs' -WorkingDirectory 'f:\Work\HMDAODAO\app' -WindowStyle Hidden -RedirectStandardOutput 'f:\Work\HMDAODAO\app\tmp\api.log' -RedirectStandardError 'f:\Work\HMDAODAO\app\tmp\api.err'
Write-Host 'api started'
