// 验证 P0 1.1 隐私政策页面：内容完整、结构合法、与 manifest 引用的路径一致。
// manifest 已替换为 GitHub Pages 真实 URL：https://523649015.github.io/Ddayup/privacy-policy.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(__dirname, '../extension/privacy-policy.html');
const ROOT_HTML = path.resolve(__dirname, '../privacy-policy.html');
const MANIFEST = path.resolve(__dirname, '../extension/manifest.json');

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  OK ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + d); } };

console.log('== P0 1.1 隐私政策页面完整性 ==');
check('文件存在', fs.existsSync(HTML));
const html = fs.readFileSync(HTML, 'utf8');
check('合法 HTML（含 <!DOCTYPE html>）', html.trimStart().startsWith('<!DOCTYPE html>'));
check('含 <title>', /<title>[\s\S]*<\/title>/.test(html));
check('含 lang=zh-CN', /lang="zh-CN"/.test(html));
check('声明不收集浏览历史', /不收集|不上传/.test(html));
check('声明 Cookie 不上传', /Cookie[\s\S]*不上传|不上传[\s\S]*Cookie/.test(html));
check('声明原生主机仅本机运行', /原生主机[\s\S]*本机运行|本机[\s\S]*原生主机/.test(html));
check('含权限说明章节', /必需权限说明/.test(html));
check('含联系方式章节', /联系我们/.test(html));

check('仓库根目录存在 privacy-policy.html（GitHub Pages /root 源所需）', fs.existsSync(ROOT_HTML));

const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const policyUrl = m.privacy_policy_url || '';
check('manifest 引用 privacy-policy.html 路径', policyUrl.endsWith('/privacy-policy.html'), policyUrl);
check('manifest 隐私政策 URL 已替换为真实 GitHub Pages 地址', policyUrl === 'https://523649015.github.io/Ddayup/privacy-policy.html', policyUrl);
check('manifest 不再使用占位域名', !policyUrl.includes('ddayup.example'), policyUrl);

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail === 0 ? 0 : 1);
