$tests = @(
  'phase1-grab-e2e',
  'phase1-multifeed',
  'phase2-cover-batch',
  'phase3-batch-ui',
  'phase4-bilibili-multi',
  'phase5-bili-bykey',
  'phase6-douyin-single-flow',
  'phase7-diagnose-cover-chain',
  'phase8-rescan-batch-persist',
  'phase9-diag-logic',
  'phase10-scantab-tdz-order',
  'phase11-source-play-isolation',
  'phase12-active-tab-capture',
  'phase13-imini-cover-regression',
  'phase14-virtualization',
  'phase15-userdir-persist',
  'phase16-userdir-absolute-only',
  'phase17-frame-budget-batch',
  'phase18-userdir-backend-path',
  'phase19-userdir-adversarial',
  # ★2026-09-16 补登记：此前 phase24~28 从未进入总入口（写了却永远不跑，等于"没跑回归"）
  'phase24-bugfix-6494bba',
  'phase25-ext-update-notice',
  'phase26-trial-subscribe',
  'phase27-license-trial-stack',
  'phase28-ytdlp-banner'
)
$totalFail = 0
foreach ($f in $tests) {
  Write-Host "=== $f ==="
  & node "F:\Work\HMDAODAO\extension\tests\$f.test.mjs"
  $code = $LASTEXITCODE
  if ($code -eq 0) { Write-Host "  [PASS]" } else { Write-Host "  [FAIL exit=$code]"; $totalFail++ }
}

# phase20：真实浏览器 E2E（核心验收：指定路径必须有文件 + sha256 一致）。.e2e.mjs 单独跑。
Write-Host "=== phase20-userdir-pick-and-save (E2E) ==="
& node "F:\Work\HMDAODAO\extension\tests\phase20-userdir-pick-and-save.e2e.mjs"
$code20 = $LASTEXITCODE
if ($code20 -eq 0) { Write-Host "  [PASS]" } else { Write-Host "  [FAIL exit=$code20]"; $totalFail++ }

Write-Host "==== TOTAL FAIL: $totalFail ===="
exit $totalFail
