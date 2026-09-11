// 在 dist CanvasBoard 中找到 toolbar 工具数组，定位"删除选中"在哪个 render path
import fs from 'node:fs';

const distFile = 'F:/Work/HMDAODAO/app/dist/assets/CanvasBoard-XohvxOX9.js';
const content = fs.readFileSync(distFile, 'utf8');

// 找"删除选中"位置
const idx = content.indexOf('删除选中');
if (idx === -1) { console.log('NOT FOUND'); process.exit(0); }

// 往回找最近的 tools 数组定义或 icon 引用
const before = content.slice(Math.max(0, idx - 500), idx);
const after = content.slice(idx, idx + 200);
console.log('--- BEFORE (500 chars) ---');
console.log(before);
console.log('\n--- AFTER (200 chars) ---');
console.log(after);
