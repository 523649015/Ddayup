// 精确定位 dist 中"删除选中/音频分离"等按钮的上下文
import fs from 'node:fs';

const distFile = 'F:/Work/HMDAODAO/app/dist/assets/CanvasBoard-XohvxOX9.js';
const content = fs.readFileSync(distFile, 'utf8');

for (const kw of ['删除选中', '音频分离', '导入工作流']) {
  console.log(`\n========= ${kw} =========`);
  const re = new RegExp(kw, 'g');
  let m;
  let i = 0;
  while ((m = re.exec(content)) !== null && i < 3) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(content.length, m.index + 80);
    console.log(`-- hit ${++i} --`);
    console.log(content.slice(start, end).replace(/\s+/g, ' '));
  }
}
