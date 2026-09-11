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
  'phase14-virtualization'
)
$totalFail = 0
foreach ($f in $tests) {
  Write-Host "=== $f ==="
  & node "F:\Work\HMDAODAO\extension\tests\$f.test.mjs"
  $code = $LASTEXITCODE
  if ($code -eq 0) { Write-Host "  [PASS]" } else { Write-Host "  [FAIL exit=$code]"; $totalFail++ }
}
Write-Host "==== TOTAL FAIL: $totalFail ===="
exit $totalFail
