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
$excludeDirs = @('native-host', 'node_modules', '.git', 'tests', 'store-assets', 'vendor', 'demo-recorder', 'tools',
                 'probe_jingxuan')
# 开发/评审文档与探针脚本一律不进商店包（属于代码残留）
$excludeFiles = @('build-store-package.ps1', 'STORE_SUBMISSION_NOTES.md', 'README.md', 'debug_out.txt', 'eslint.config.js', 'generate-store-images.mjs',
                  'ARCHITECTURE_REVIEW_screenshot-ocr.md', 'ARCHITECTURE_REVIEW_screenshot-ocr-v2.md',
                  'QA_screenshot-review.md', 'screenshot-fix-overview.md', 'test-auth-sync.mjs')

if (Test-Path $outPath) { Remove-Item $outPath -Force }

# 收集要打包的文件
$files = Get-ChildItem -Path $extDir -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($extDir.Length).TrimStart('\','/')
    $parts = $rel -split '[\\/]'
    $top = $parts[0]
    if ($excludeDirs -contains $top) { return $false }
    if ($excludeFiles -contains $_.Name) { return $false }
    # ★绝不把历次商店包（.zip）嵌套进新包：旧包会虚增体积并被商店质疑。
    if ($_.Extension -ieq '.zip') { return $false }
    # 隐藏目录（.git / .workbuddy / .codebuddy 等开发产物）一律不进包；
    # Chromium 加载时本身也会忽略点开头条目，但打包必须显式排除以免体积虚高。
    if ($parts | Where-Object { $_ -like '.*' }) { return $false }
    return $true
}

# 安全网：Chromium 拒绝扩展内任何以 "_" 开头的文件 / 目录（仅 _locales 例外）。
# 一旦打包树里混入这类条目，本地「加载解压缩的扩展」会直接失败，商店也会拒包。
# 这里提前拦截，避免再次出现 _dbg2.mjs / demo-recorder/output/_raw 这类问题。
$offenders = @($files | Where-Object {
    $rel = $_.FullName.Substring($extDir.Length).TrimStart('\','/')
    # 只看非隐藏路径：Chromium 会忽略 . 开头条目，故 .workbuddy 等不影响加载
    ($rel -split '[\\/]' | Where-Object { $_ -notlike '.*' -and $_ -like '_*' -and $_ -ne '_locales' }).Count -gt 0
})
if ($offenders.Count -gt 0) {
    $list = ($offenders | ForEach-Object { $_.FullName.Substring($extDir.Length).TrimStart('\','/') }) -join ', '
    throw "打包中止：以下条目以下划线开头，Chromium 会拒绝加载、商店会拒绝该包 → $list"
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
