// 验证 dist 中是否还有"删除选中"按钮（不是"删除"二字其他用法）
import fs from 'node:fs';
import path from 'node:path';

const distDir = 'F:/Work/HMDAODAO/app/dist/assets';
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));

for (const f of files) {
  const content = fs.readFileSync(path.join(distDir, f), 'utf8');
  // 抓"删除选中"周围 80 字符的上下文
  const re = /删除选中/g;
  let m;
  let cnt = 0;
  while ((m = re.exec(content)) !== null && cnt < 3) {
    const start = Math.max(0, m.index - 60);
    const end = Math.min(content.length, m.index + 60);
    const ctx = content.slice(start, end).replace(/\s+/g, ' ');
    console.log(`${f}: ...${ctx}...`);
    cnt++;
  }
}
