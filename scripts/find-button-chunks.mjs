// 在 dist 中找每个按钮属于哪个 chunk
import fs from 'node:fs';
import path from 'node:path';

const distDir = 'F:/Work/HMDAODAO/app/dist/assets';
const keywords = ['删除选中', '导出 JSON', '导入工作流', '音频分离', '视频修复', '下载', '加入 Agent'];

for (const kw of keywords) {
  const hits = [];
  for (const f of fs.readdirSync(distDir)) {
    if (!f.endsWith('.js')) continue;
    const c = fs.readFileSync(path.join(distDir, f), 'utf8');
    if (c.includes(kw)) hits.push(f);
  }
  console.log(`${kw}: ${hits.length === 0 ? 'NONE' : hits.join(', ')}`);
}
