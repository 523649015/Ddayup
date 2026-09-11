$ErrorActionPreference = 'Continue'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  if ($p.CommandLine -like '*ui-static-proxy*') {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host ("killed proxy pid=" + $p.ProcessId)
  }
}
Start-Sleep -Seconds 2
Start-Process -FilePath 'node' -ArgumentList 'server/ui-static-proxy.mjs','--port','3000','--api','http://127.0.0.1:8792' -WorkingDirectory 'f:\Work\HMDAODAO\app' -WindowStyle Hidden -RedirectStandardOutput 'f:\Work\HMDAODAO\app\tmp\proxy3000.log' -RedirectStandardError 'f:\Work\HMDAODAO\app\tmp\proxy3000.err'
Write-Host 'proxy3000 started'
