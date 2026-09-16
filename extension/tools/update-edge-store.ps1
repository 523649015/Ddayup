<#
.SYNOPSIS
    Ddayup 网页素材采集扩展 · Edge 加载项「一键更新」工具

.DESCRIPTION
    一条命令完成：构建商店包 → （有凭证时）自动走 Edge 加载项更新 API 上传提审；
    无凭证或 API 失败时，自动回退为「打开 Partner Center 产品页 + 打印点击式清单」。

    ⚠️ 本脚本包含两条【相互独立】的链路，请勿混淆：
      · 链路 A「打包」：复用 ../build-store-package.ps1（与上传无关，永远执行）
      · 链路 B「API 上传」：仅当存在 EDGE_ADDON_API_KEY + EDGE_ADDON_CLIENT_ID 时触发
        API 凭证属于「Edge 商店发布」范畴，与「一键打包」完全分离，单独分类存储（见下方）。

.PARAMETER BumpPatch
    自动将 manifest.json 的 version 末位 +1 后再打包（满足商店要求：新包版本号必须递增）。

.PARAMETER Notes
    提审备注 / What's new（仅 API 上传时使用）。默认值见 $DefaultNotes。

.PARAMETER ApiKey
    Edge 加载项 API 的 ApiKey（v1.1）。缺省读环境变量 EDGE_ADDON_API_KEY。
    也可放在分类存储文件 extension/tools/edge-api-config.ps1 中（见 EDGE_UPDATE_GUIDE.md）。

.PARAMETER ClientId
    Edge 加载项 API 的 ClientID（v1.1）。缺省读环境变量 EDGE_ADDON_CLIENT_ID。

.PARAMETER DryRun
    只打包 + 走半自动回退（打开网页 + 打印清单），不调用任何 API。便于本地验证打包链路。

.EXAMPLE
    .\update-edge-store.ps1                 # 打包；有凭证则自动上传，无则回退清单
    .\update-edge-store.ps1 -BumpPatch      # 先升版本号再打包上传
    .\update-edge-store.ps1 -DryRun         # 只打包并打开商店页，不调 API
#>

[CmdletBinding()]
param(
    [switch]$BumpPatch,
    [string]$Notes,
    [string]$ApiKey,
    [string]$ClientId,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'   # API 任一步失败都要捕获并回退，不可硬中断

# =====================================================================================
# ⛔ 链路 B 配置区（仅 API 上传相关 —— 与链路 A「打包」严格分离，分类存储）
# =====================================================================================
# --- 商店公开标识（仅用于商店链接与展示，【不参与】任何 API 调用）---
$CrxId            = 'jpcnchdcjaapokighokneachmbkeafan'   # CRX ID（= 商店 URL 中的扩展 ID）
$StoreSid         = '0RDCK9QLWJWP'                        # Store ID
$StoreUrl         = "https://microsoftedge.microsoft.com/addons/detail/ddayup%E7%BD%91%E9%A1%B5%E7%B4%A0%E6%9D%90%E9%87%87%E9%9B%86%E6%89%A9%E5%B1%95/$CrxId"
# --- API 专用：productID 必须是 Product ID（128 位 GUID），不是 CRX ID / Store ID ---
$ProductId        = '2f6d8ab3-b73e-4bce-b35a-356cd96cf8af'
$PartnerCenterUrl = "https://partner.microsoft.com/dashboard/microsoftedge/products/$ProductId"
# Edge 加载项更新 API（v1.1）。参考：https://learn.microsoft.com/zh-cn/microsoft-edge/extensions/update/api/
$ApiBase          = 'https://api.addons.microsoftedge.microsoft.com/v1'
$DefaultNotes     = "修复若干素材采集稳定性问题；优化 YouTube / 抖音 / 网盘资源捕获。(Fixed several media-capture stability issues; improved YouTube / Douyin / netdisk asset capture.)"
# ★修复（使用时序依赖）：提前在此定稿提审说明，供下方的回退清单与 API 上传共用。
#   此前它定义在文件末尾（函数之后），Show-FallbackChecklist 靠动态作用域侥幸取到；
#   一旦有人调整顺序，清单里的 What's new 就会静默变空。
$NotesForFallback = if ($Notes) { $Notes } else { $DefaultNotes }

# =====================================================================================
# 路径
# =====================================================================================
$ExtDir      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path   # extension/
$BuildScript = Join-Path $ExtDir 'build-store-package.ps1'
$CredFile    = Join-Path $PSScriptRoot 'edge-api-config.ps1'        # 分类存储：API 凭证（gitignore）
$manifestPath= Join-Path $ExtDir 'manifest.json'

function Write-Step($n, $msg) { Write-Host "`n=== [$n] $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)       { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)     { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)      { Write-Host "  [X] $msg" -ForegroundColor Red }
function Mask($s) { if ([string]::IsNullOrWhiteSpace($s)) { '<empty>' } else { $s.Substring(0, [Math]::Min(4, $s.Length)) + '****' } }

# 从 202 响应中提取 operationID：优先 Location 头，回退解析 RawContent（对齐微软官方示例做法）
function Get-OpIdFromResponse($resp) {
    $loc = ''
    try { $loc = [string]$resp.Headers['Location'] } catch { $loc = '' }
    if ([string]::IsNullOrWhiteSpace($loc) -and $resp.RawContent) {
        foreach ($line in ($resp.RawContent -split "`r?`n")) {
            if ($line -like 'Location:*') { $loc = $line.Split(':', 2)[1]; break }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($loc)) { $loc = $loc.Trim() }
    return $loc
}

# =====================================================================================
# 步骤 0：解析 API 凭证（仅链路 B 使用；优先级：参数 > 分类存储文件 > 环境变量）
# =====================================================================================
Write-Step 0 '解析 Edge 商店 API 凭证（仅上传链路使用，与打包无关）'
if (Test-Path $CredFile) {
    try { . $CredFile; Write-Ok "已从分类存储文件加载凭证: $(Split-Path $CredFile -Leaf)" }
    catch { Write-Warn "分类存储文件存在但加载失败: $_" }
}
if (-not $ApiKey)   { $ApiKey   = $env:EDGE_ADDON_API_KEY }
if (-not $ClientId) { $ClientId = $env:EDGE_ADDON_CLIENT_ID }
$hasCreds = (-not [string]::IsNullOrWhiteSpace($ApiKey)) -and (-not [string]::IsNullOrWhiteSpace($ClientId))
if ($hasCreds) {
    Write-Ok "检测到 API 凭证（ApiKey=$(Mask $ApiKey), ClientId=$(Mask $ClientId)）-> 将尝试全自动上传"
} else {
    Write-Warn "未检测到 API 凭证（EDGE_ADDON_API_KEY / EDGE_ADDON_CLIENT_ID）-> 将走半自动回退"
}

# =====================================================================================
# 步骤 1：版本（仅 -BumpPatch 时修改 manifest 的 version）
# =====================================================================================
Write-Step 1 '读取 / 可选自增版本号'
if (-not (Test-Path $manifestPath)) { Write-Err "找不到 manifest.json: $manifestPath"; exit 1 }
$manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$manifest     = $manifestText | ConvertFrom-Json
$version      = $manifest.version
Write-Ok "当前 manifest version = $version"

if ($BumpPatch) {
    $parts = $version.Split('.')
    if ($parts.Count -lt 3) { $parts = @('0','0','0') }
    $parts[2] = ([int]$parts[2] + 1).ToString()
    $newVer = $parts -join '.'
    $manifest.version = $newVer
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [System.Text.Encoding]::UTF8)
    $version = $newVer
    Write-Ok "已自增版本号 -> $version（已写回 manifest.json）"
}

# =====================================================================================
# 步骤 2：链路 A「打包」—— 复用 build-store-package.ps1（与上传完全无关，永远执行）
# =====================================================================================
Write-Step 2 '链路 A · 构建商店包（复用 build-store-package.ps1）'
if (-not (Test-Path $BuildScript)) { Write-Err "找不到打包脚本: $BuildScript"; exit 1 }
# ★修复（$LASTEXITCODE 误判）：用 & 调用 .ps1 【不会】设置 $LASTEXITCODE
#   （它只由原生 exe 设置）。在全新会话里 $LASTEXITCODE 是 $null，
#   而 "$null -ne 0" 求值为 True → 会误判为"打包失败"并 exit 1，导致上传链路静默中断。
#   改为：捕获 build 脚本内部的 throw；真实成败由下方「产物 zip 是否存在」判定。
try { & $BuildScript } catch { Write-Err "打包脚本执行失败: $_"; exit 1 }

$zipName = "ddayup-edge-store-v$version.zip"
$zipPath = Join-Path $ExtDir $zipName
if (-not (Test-Path $zipPath)) { Write-Err "打包后未找到产物: $zipPath"; exit 1 }
$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Ok "商店包已就绪: $zipName ($zipSizeMB MB)"

# =====================================================================================
# 步骤 3：链路 B「API 上传」—— 独立函数，仅在有凭证且非 DryRun 时调用
# =====================================================================================
function Invoke-EdgeUpload {
    param(
        [string]$ZipPath,
        [string]$CertNotes
    )
    $authHeader = "ApiKey $ApiKey"
    $hdr = @{ 'Authorization' = $authHeader; 'X-ClientID' = $ClientId }

    # --- 3.1 上传包 ---
    Write-Step '3.1' '链路 B · 上传包 POST /products/{id}/submissions/draft/package'
    $upUrl = "$ApiBase/products/$ProductId/submissions/draft/package"
    $upSplat = @{
        Uri             = $upUrl
        Method          = 'Post'
        Headers         = $hdr
        InFile          = $ZipPath
        ContentType     = 'application/zip'
        TimeoutSec      = 600
        MaximumRedirection = 0
        ErrorAction     = 'SilentlyContinue'
    }
    try {
        $resp = Invoke-WebRequest @upSplat
        if ($resp.StatusCode -ne 202) { throw "上传包返回 HTTP $($resp.StatusCode)" }
        $opId = Get-OpIdFromResponse $resp
        if ([string]::IsNullOrWhiteSpace($opId)) { throw '响应缺少 Location 操作 ID' }
        Write-Ok "包已接受，操作 ID = $opId"
    } catch {
        throw "上传包失败: $_"
    }

    # --- 3.2 轮询包上传状态 ---
    Write-Step '3.2' '链路 B · 轮询包上传状态（最多 20 次 / 每次 5s）'
    $status = $null
    for ($i = 1; $i -le 20; $i++) {
        try {
            $stUrl = "$ApiBase/products/$ProductId/submissions/draft/package/operations/$opId"
            $st = Invoke-RestMethod -Uri $stUrl -Headers $hdr -TimeoutSec 30 -ErrorAction Stop
            $status = [string]$st.status
        } catch {
            Write-Warn "状态查询异常（第 $i 次）: $_"
            Start-Sleep -Seconds 5
            continue
        }
        Write-Host "    轮询 $i : $status"
        if ($status -eq 'Succeeded') { Write-Ok '包上传完成'; break }
        if ($status -eq 'Failed')    { throw '包上传状态 = Failed' }
        Start-Sleep -Seconds 5
    }
    if ($status -ne 'Succeeded') { throw "包上传未在限定次数内完成（最后状态: $status）" }

    # --- 3.3 发布草稿（提交审核）---
    Write-Step '3.3' '链路 B · 发布草稿 POST /products/{id}/submissions'
    $pubUrl = "$ApiBase/products/$ProductId/submissions"
    # 官方要求：Notes for certification 为 JSON 格式 {"notes":"..."}
    $notesBody = @{ notes = $CertNotes }
    $pubSplat = @{
        Uri             = $pubUrl
        Method          = 'Post'
        Headers         = $hdr
        Body            = (ConvertTo-Json -InputObject $notesBody -Compress)
        ContentType     = 'application/json'
        TimeoutSec      = 120
        MaximumRedirection = 0
        ErrorAction     = 'SilentlyContinue'
    }
    try {
        $pResp = Invoke-WebRequest @pubSplat
        if ($pResp.StatusCode -ne 202) { throw "发布草稿返回 HTTP $($pResp.StatusCode)" }
        $popId = Get-OpIdFromResponse $pResp
        if ([string]::IsNullOrWhiteSpace($popId)) { throw '发布响应缺少 Location 操作 ID' }
        Write-Ok "已提交审核，操作 ID = $popId"
    } catch {
        throw "发布草稿失败: $_"
    }

    # --- 3.4 轮询发布状态 ---
    Write-Step '3.4' '链路 B · 轮询发布状态（最多 60 次 / 每次 10s）'
    $pstatus = $null
    for ($i = 1; $i -le 60; $i++) {
        try {
            $psUrl = "$ApiBase/products/$ProductId/submissions/operations/$popId"
            $ps = Invoke-RestMethod -Uri $psUrl -Headers $hdr -TimeoutSec 30 -ErrorAction Stop
            $pstatus = [string]$ps.status
        } catch {
            Write-Warn "发布状态查询异常（第 $i 次）: $_"
            Start-Sleep -Seconds 10
            continue
        }
        Write-Host "    轮询 $i : $pstatus"
        if ($pstatus -eq 'Succeeded') { Write-Ok '发布成功，已进入审核队列'; break }
        if ($pstatus -like '*Failed*' -or $pstatus -eq 'Failed') { throw "发布状态 = $pstatus" }
        Start-Sleep -Seconds 10
    }
    if ($pstatus -ne 'Succeeded') { throw "发布未在限定次数内完成（最后状态: $pstatus）" }
    return $true
}

# =====================================================================================
# 步骤 4：半自动回退 —— 打开 Partner Center 产品页 + 打印点击式清单
# =====================================================================================
function Show-FallbackChecklist {
    param([string]$Reason)
    Write-Step 4 '半自动兜底 · 打开 Partner Center + 打印点击清单'
    if (-not [string]::IsNullOrWhiteSpace($Reason)) { Write-Warn "回退原因: $Reason" }
    Write-Host "  Link: $PartnerCenterUrl"
    try { Start-Process $PartnerCenterUrl } catch { Write-Warn "无法自动打开浏览器，请手动访问: $PartnerCenterUrl" }

    $notesLines = ($NotesForFallback -split "`n" | ForEach-Object { "      $_" }) -join "`n"
    $checklist = @"

------------------------------------------------------------
 Ddayup Edge 加载项 手动更新清单（半自动兜底）
------------------------------------------------------------
商店 CRX ID  : $CrxId            （仅商店链接用）
Store ID     : $StoreSid
API Product  : $ProductId   （GUID，仅上传接口用，勿与 CRX ID 混用）
商店直链     : $StoreUrl
本地包       : $zipPath
当前版本     : $version

请在浏览器打开的 Partner Center 页面按以下步骤操作：

 1) 进入该扩展产品概览，点击顶部「Update（更新）」创建新草稿。
 2) 进入「Packages（包）」分区：
      - 移除旧包，点「Upload」选择本地文件：
        $zipPath
      - 系统校验 manifest，版本号必须 > 已发布版本（当前 $version）。
        [!] 若提示版本未递增：回到命令行加 -BumpPatch 重跑本脚本。
 3) （可选）「Listings（列表）」补英文市场信息，提升搜索可见性
      （文案见 STORE_SUBMISSION_NOTES.md 第八节）。
 4) 填「Notes for certification / What's new」：
$notesLines
 5) 点「Submit（提交）」-> 自动预检 -> 进入人工审核（通常 1-3 个工作日）。
 6) 审核通过即自动覆盖线上版本，用户浏览器后台静默升级。

如需「全自动上传」免手动点击，请先按 EDGE_UPDATE_GUIDE.md 申请
Edge 加载项 API 凭证（ApiKey + ClientID），再设置环境变量后重跑本脚本。
------------------------------------------------------------
"@
    Write-Host $checklist
}

# =====================================================================================
# 主流程分发
# =====================================================================================
if ($DryRun) {
    Write-Warn 'DryRun 模式：跳过 API 上传，仅走半自动回退'
    Show-FallbackChecklist -Reason 'DryRun 显式指定'
    exit 0
}

if ($hasCreds) {
    try {
        Write-Step 3 '链路 B · 全自动上传（Edge 加载项更新 API v1.1）'
        $ok = Invoke-EdgeUpload -ZipPath $zipPath -CertNotes $NotesForFallback
        if ($ok) {
            Write-Host "`n[OK] 全自动上传成功！版本 $version 已提交审核。" -ForegroundColor Green
            exit 0
        }
    } catch {
        Write-Err "全自动上传失败，转半自动回退: $_"
        Show-FallbackChecklist -Reason $_.Exception.Message
        exit 0
    }
} else {
    Show-FallbackChecklist -Reason '未配置 EDGE_ADDON_API_KEY / EDGE_ADDON_CLIENT_ID'
    exit 0
}
