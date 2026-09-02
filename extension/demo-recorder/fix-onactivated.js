// 修复：切 tab 完全清空 window.assets（不保留 dlUrls）
const fs = require('fs');
const p = 'f:/Work/HMDAODAO/extension/sidepanel.js';
let c = fs.readFileSync(p, 'utf8');
// 用一个独特的 "preserved.filter" 锚点
const old = 'const preserved = window.assets.filter(a => dlUrls.includes(a.url));\n        window.assets = batchAssets.concat(preserved.filter(a => !batchAssets.some(b => b.url === a.url))).slice();';
const ne = '// ★2026-08-31：切 tab 完全清空（不保留 dlUrls），避免跨平台混合残留。batchAssets 保留。\n        window.assets = batchAssets.slice();';
if (c.includes(old)) {
  c = c.replace(old, ne);
  fs.writeFileSync(p, c);
  console.log('OK - replaced');
} else {
  console.log('NOT FOUND, try one-line version');
  const old2 = 'const preserved = window.assets.filter(a => dlUrls.includes(a.url));';
  const idx = c.indexOf(old2);
  if (idx >= 0) {
    // 找到位置后，替换整段（从 preserved 块开始到 window.assets = ...slice(); 结束）
    const after = c.indexOf('.slice();', idx);
    if (after > 0) {
      const beforeText = c.substring(idx, after + '.slice();'.length);
      const newText = '// ★2026-08-31：切 tab 完全清空（不保留 dlUrls），避免跨平台混合残留。batchAssets 保留。\n        window.assets = batchAssets.slice();';
      c = c.substring(0, idx) + newText + c.substring(after + '.slice();'.length);
      fs.writeFileSync(p, c);
      console.log('OK - replaced (fallback)');
    } else {
      console.log('END NOT FOUND');
    }
  } else {
    console.log('ANCHOR NOT FOUND');
  }
}
