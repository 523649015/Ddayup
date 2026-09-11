const URL = 'https://www.xinpianchang.com/a13763798';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const html = await fetch(URL, { headers: { 'User-Agent': UA, 'Referer': 'https://www.xinpianchang.com/' } }).then(r => r.text());
import fs from 'fs';
fs.writeFileSync('f:/Work/HMDAODAO/tmp_xpc_raw.html', html);
// 提取所有疑似 api 路径
const apis = html.match(/\/(?:api|mod-api|graphql|v\d+)[^"'\\<>\s]*/g) || [];
console.log('API 路径线索:', [...new Set(apis)].slice(0, 20));
const scripts = html.match(/<script[^>]+src="([^"]+)"/g) || [];
console.log('脚本数:', scripts.length);
scripts.slice(0, 5).forEach(s => console.log(s.slice(0, 90)));
