# 打包 Ddayup 扩展为可提交 Microsoft Partner Center 的 zip（0.1.4）
# 用法：在 PowerShell 中 cd 到 extension/ 目录，执行 .\build-store-package.ps1
# 排除：native-host/（原生主机单独分发）、node_modules/、开发用脚本
$ErrorActionPreference = 'Stop'

$extDir = $PSScriptRoot
$manifestText = [System.IO.File]::ReadAllText((Join-Path $extDir 'manifest.json'), [System.Text.Encoding]::UTF8)
$ver = ($manifestText | ConvertFrom-Json).version
$outName = "ddayup-edge-store-v$ver.zip"
$outPath = Join-Path $extDir $outName

# 需要排除的项（相对 extension/）
$excludeDirs = @('native-host', 'node_modules', '.git', 'tests', 'store-assets', 'vendor')
$excludeFiles = @('build-store-package.ps1', 'STORE_SUBMISSION_NOTES.md', 'README.md', 'debug_out.txt', 'eslint.config.js', 'generate-store-images.mjs')

if (Test-Path $outPath) { Remove-Item $outPath -Force }

# 收集要打包的文件
$files = Get-ChildItem -Path $extDir -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($extDir.Length).TrimStart('\','/')
    $parts = $rel -split '[\\/]'
    $top = $parts[0]
    if ($excludeDirs -contains $top) { return $false }
    if ($excludeFiles -contains $_.Name) { return $false }
    return $true
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($outPath, 'Create')

foreach ($f in $files) {
    $rel = $f.FullName.Substring($extDir.Length).TrimStart('\','/')
    $entryName = $rel -replace '\\', '/'
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entryName)
}
$zip.Dispose()

$sizeMB = [math]::Round((Get-Item $outPath).Length / 1MB, 2)
Write-Host "OK: 已生成 $outName (版本 $ver, $sizeMB MB, 文件数 $($files.Count))"
Write-Host "路径: $outPath"
