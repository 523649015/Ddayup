import fs from 'node:fs';
const c = fs.readFileSync('.env.alipay', 'utf8');
const m = c.match(/ALIPAY_PRIVATE_KEY="([\s\S]*?)"/);
if (!m) { console.log('no match'); process.exit(1); }
const raw = m[1];
const restored = raw.replace(/\\n/g, '\n');
console.log('raw len', raw.length, 'restored len', restored.length);
console.log('head', JSON.stringify(restored.slice(0, 35)));
console.log('tail', JSON.stringify(restored.slice(-35)));
console.log('hasRealNewline', restored.includes('\n'));
console.log('firstLine', restored.split('\n')[0]);
console.log('lastLine', restored.split('\n').pop());
