/**
 * 查出某个扩展 ID 对应哪个扩展（读 Edge 本地配置文件，不需要打开浏览器）
 *
 * 用法：node who-is-extension.js [扩展ID]
 *   默认查 capohkkfagimodmlpnahjoijgoocdjhd（控制台报错里的那个）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TARGET = process.argv[2] || 'capohkkfagimodmlpnahjoijgoocdjhd';
const BASE = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');

function readProfile(dir, label) {
  const out = [];
  for (const f of ['Preferences', 'Secure Preferences']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const settings = (j.extensions && j.extensions.settings) || {};
      for (const [id, v] of Object.entries(settings)) {
        out.push({
          id,
          name: (v.manifest && v.manifest.name) || '(无名称)',
          version: (v.manifest && v.manifest.version) || '',
          enabled: v.state === 1 || v.enabled === true,
          source: `${label}/${f}`,
        });
      }
    } catch (e) { /* 忽略解析失败的 profile */ }
  }
  return out;
}

(async () => {
  console.log('============================================================');
  console.log('查询扩展 ID:', TARGET);
  console.log('Edge 配置目录:', BASE);
  console.log('============================================================\n');

  if (!fs.existsSync(BASE)) { console.log('❌ 未找到 Edge 配置目录'); return; }

  let all = [];
  const entries = fs.readdirSync(BASE, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'Default' || /^Profile \d+$/.test(e.name)) {
      all = all.concat(readProfile(path.join(BASE, e.name), e.name));
    }
  }

  console.log(`已安装扩展总数: ${all.length}\n`);

  const hit = all.find((x) => x.id === TARGET);
  if (hit) {
    console.log('🎯 【找到该扩展】');
    console.log('   名称  :', hit.name);
    console.log('   版本  :', hit.version);
    console.log('   ID    :', hit.id);
    console.log('   启用  :', hit.enabled ? '是' : '否');
    console.log('   来源  :', hit.source);
    console.log('\n   → 控制台里 /video/BV.../null 的 404 就是【这个扩展】发出的。');
    console.log('   → 若要消除，请在 edge://extensions 找到它并停用/移除。\n');
  } else {
    console.log(`⚠ 在本地配置中未找到 ID = ${TARGET}`);
    console.log('  可能原因：该扩展已卸载 / 属于其他浏览器(Chrome) / 由策略部署。\n');
  }

  // 顺便列出所有含 "bilibili/B站/下载/助手/字幕" 关键词的扩展（疑似干扰源）
  const suspects = all.filter((x) => /bili|B站|bilibili|下载|助手|字幕|视频|media|video|download/i.test(x.name || ''));
  if (suspects.length) {
    console.log('--- 疑似相关的扩展（名称含 视频/下载/助手/字幕 等关键词）---');
    suspects.forEach((s) => {
      console.log(`  ${s.id}  ${s.enabled ? '[启用]' : '[停用]'}  ${s.name}  v${s.version}`);
    });
  }

  // 找 Ddayup（确认本扩展 ID）
  const ddayup = all.filter((x) => /ddayup|hmdao/i.test(x.name || ''));
  if (ddayup.length) {
    console.log('\n--- 本扩展（Ddayup）---');
    ddayup.forEach((s) => console.log(`  ${s.id}  ${s.name}  v${s.version}`));
  }
  console.log('\n============================================================');
})().catch((e) => { console.error('查询失败:', e.message); });
