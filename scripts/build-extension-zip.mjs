// 打包 extension/ 为商店提交用的 .zip（纯 Node，无第三方依赖）。
// 排除项：开发脚本、测试产物、.md、.ps1、native-host 二进制/exe（商店不需要原生主机二进制）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '../extension');
const OUT = path.resolve(__dirname, '../dist-store/Ddayup-extension.zip');

// 不应进入商店 zip 的条目（相对 extension/ 的路径，或目录名）。
const EXCLUDE_NAMES = new Set([
  'STORE_SUBMISSION_NOTES.md',
  'native-host', // 原生主机单独分发，商店包不含 exe/ps1
]);
// 额外按扩展名排除
const EXCLUDE_EXT = new Set(['.ps1', '.md', '.txt', '.cjs', '.wasm', '.exe', '.json']);

function shouldInclude(relPath) {
  const parts = relPath.split(path.sep);
  // native-host 整个目录排除
  if (parts[0] === 'native-host') return false;
  const base = parts[parts.length - 1];
  if (EXCLUDE_NAMES.has(base)) return false;
  // 保留 manifest.json / vendor 下的 .json / vendor 下的 .wasm（模型推理所需）
  if (base === 'manifest.json') return true;
  if (relPath.startsWith('vendor' + path.sep) && (base.endsWith('.json') || base.endsWith('.wasm'))) return true;
  if (EXCLUDE_EXT.has(path.extname(base))) return false;
  return true;
}

// 收集文件清单
const files = [];
function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const r = rel ? path.join(rel, ent.name) : ent.name;
    const relNorm = r.split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (relNorm.split('/')[0] === 'native-host') continue; // 整目录排除，不递归
      walk(full, r);
    } else if (shouldInclude(relNorm)) {
      files.push({ full, rel: relNorm });
    }
  }
}
walk(EXT_DIR, '');

// 校验清单：manifest 必须在，且引用的关键文件都在
const required = ['manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.js', 'detect.js', 'inject-main.js', 'model-api-capture.js', 'icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png'];
for (const r of required) {
  if (!files.some(f => f.rel === r)) {
    console.error('MISSING required file in zip list: ' + r);
    process.exit(1);
  }
}

// 确保输出目录
fs.mkdirSync(path.dirname(OUT), { recursive: true });
// 若存在旧 zip 先删
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

// 用系统 zip（PowerShell Compress-Archive 不可用时的 Node 替代：用 child_process 调系统 zip）
// Windows 优先用 PowerShell Compress-Archive，但排除逻辑已在上面算好，直接逐个 Add 成本高。
// 改用 Node 写 zip：借助内置无，于是调用 powershell Compress-Archive 按文件列表。
// 为可靠，先用 tar（Windows 10+ 自带 bsdtar）打 zip。
const listFile = path.resolve(__dirname, '../dist-store/_filelist.txt');
fs.writeFileSync(listFile, files.map(f => f.full).join('\n'), 'utf8');

try {
  // bsdtar 在 Windows 自带，支持 -a 自动选 zip 格式
  execSync(`tar -a -cf "${OUT}" -C "${EXT_DIR}" ${files.map(f => `"${f.rel}"`).join(' ')}`, { stdio: 'inherit', shell: true });
} catch (e) {
  console.error('tar zip failed, fallback to powershell', e.message);
  fs.unlinkSync(listFile);
  process.exit(1);
}
fs.unlinkSync(listFile);

const size = fs.statSync(OUT).size;
console.log('ZIP_OK ' + OUT + ' files=' + files.length + ' bytes=' + size);
