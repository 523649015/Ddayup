// 生成浅色主题覆盖 CSS。
// 扫描 src 中所有 Tailwind 任意色值（bg-/text-/border-/ring-/divide-/outline-[#hex]），
// 仅对“暗色”令牌在 html:not(.dark) 下生成浅色等价覆盖。
// 暗色模式（html.dark）保持原始 hex，零回归。
// 用法: node scripts/gen-light-theme.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../src');
const OUT = path.resolve(__dirname, '../src/theme/light-overrides.css');
const EXT = new Set(['.tsx', '.ts', '.jsx', '.js', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor']);

const PROP_DECL = {
  bg: 'background-color',
  text: 'color',
  border: 'border-color',
  divide: 'border-color',
  outline: 'outline-color',
  ring: '--tw-ring-color',
};

const byHex = new Map();

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p);
    } else if (EXT.has(path.extname(e.name).toLowerCase())) {
      let src;
      try {
        src = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const re = /(?:hover:)?(bg|text|border|ring|divide|outline)-\[#([0-9a-fA-F]{3,8})\]/g;
      let m;
      while ((m = re.exec(src))) {
        const prop = m[1];
        const hex = m[2].toLowerCase();
        if (!byHex.has(hex)) byHex.set(hex, new Set());
        byHex.get(hex).add(prop);
      }
    }
  }
}
walk(ROOT);

function lum(hex) {
  let h = hex;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function surfaceLight(L) {
  if (L < 0.04) return '#ffffff';
  if (L < 0.12) return '#f6f8fa';
  if (L < 0.22) return '#eef1f4';
  return '#e6e9ed';
}

function saturation(hex) {
  let h = hex;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  return maxc - minc;
}

const blocks = [];
blocks.push('/* 自动生成的浅色主题覆盖（scripts/gen-light-theme.mjs）。');
blocks.push('   仅 html:not(.dark) 生效：将写死的暗色调色板重映射到浅色。');
blocks.push('   跳过饱和的强调色（保持品牌色），仅重映射近中性的暗色灰阶。');
blocks.push('   暗色模式（html.dark 或缺省）保持原始 hex，零回归。请勿手改，改生成器重跑。 */');
blocks.push('');

let count = 0;
const hexes = [...byHex.keys()].sort();
for (const hex of hexes) {
  const L = lum(hex);
  if (L > 0.55) continue; // 跳过亮色（白/浅灰/亮强调色），保持原样
  if (saturation(hex) > 0.18) continue; // 跳过饱和强调色（品牌青/蓝/绿/红/橙等），保持原色
  const props = [...byHex.get(hex)].filter((p) => PROP_DECL[p]);
  if (props.length === 0) continue;
  const sl = surfaceLight(L);
  const bl = '#d0d7de';
  const tl = L < 0.2 ? '#1f2328' : '#59636e';
  const rules = [];
  for (const prop of props) {
    const decl = PROP_DECL[prop];
    let val = sl;
    if (prop === 'text') val = tl;
    else if (prop === 'border' || prop === 'divide' || prop === 'ring' || prop === 'outline') val = bl;
    rules.push(`  html:not(.dark) .${prop}-\\[\\#${hex}\\] { ${decl}: ${val}; }`);
    count++;
  }
  if (rules.length) blocks.push(rules.join('\n'));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, blocks.join('\n') + '\n', 'utf8');
console.log(`Wrote ${count} override rules for ${hexes.length} distinct hex tokens -> ${OUT}`);
