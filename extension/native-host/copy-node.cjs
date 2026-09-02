const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'node_src.exe');
const where = execSync('where node').toString().trim().split('\n')[0].trim();
fs.copyFileSync(where, out);
console.log('copied', where, '->', out);
