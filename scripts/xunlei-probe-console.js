// ============================================================================
// 迅雷分享直链诊断脚本（贴到迅雷分享页 Console 执行，不是 Node 脚本）
// 用途：把 file_info / download_url 的完整响应打出来，定位 404 根因。
// 用法：
//   1) 打开 https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=...
//   2) 按 F12 打开 Console，把下面全部内容粘贴进去回车。
//   3) 等几秒，把输出（尤其是 [PROBE] 开头的部分）贴给 AI。
// 注意：这是浏览器页面脚本，用页面自身 cookie/鉴权发请求（游客态也能调 file_info）。
// ============================================================================
(async function () {
  const SHARE_ID = 'VOj-h8suAkW9oy_-90W8M4r9A1';
  const PWD = 'qkva';
  const FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1'; // 植物大战僵尸杂交版v2.5.zip 的分享条目 id
  const base = 'https://api-pan.xunlei.com/drive/v1/share';

  // 1) 先拿顶层列表，取权威 pass_code_token + 看顶层响应有没有 space 字段
  const topUrl = `${base}?share_id=${encodeURIComponent(SHARE_ID)}&pass_code=${encodeURIComponent(PWD)}&limit=100&page_token=&thumbnail_size=SIZE_SMALL`;
  console.log('[PROBE] 顶层列表 URL=', topUrl);
  let passToken = '', topJson = null, topKeys = [];
  try {
    const r = await fetch(topUrl, { headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
    const t = await r.text();
    topJson = JSON.parse(t);
    passToken = topJson.pass_code_token || '';
    topKeys = Object.keys(topJson);
    console.log('[PROBE] 顶层列表 status=', r.status, ' pass_code_token=', passToken.slice(0, 20) + '...', ' topKeys=', JSON.stringify(topKeys));
    // 打印第一个文件条目的完整字段（找 space / sub_file_id）
    const files = topJson.files || topJson.list || topJson.file_list || (topJson.data && (topJson.data.files || topJson.data.list)) || [];
    console.log('[PROBE] 顶层 first item FULL=', JSON.stringify(files[0] || {}, null, 2));
  } catch (e) { console.log('[PROBE] 顶层列表 ERR=', e.message); }

  // 2) file_info：打印完整响应，找 space / sub_file_id / download_url
  for (const sp of ['', 'share', 'drive']) {
    const fiUrl = `${base}/file_info?pass_code_token=${encodeURIComponent(passToken)}` + (sp ? `&space=${encodeURIComponent(sp)}` : '') + `&file_id=${encodeURIComponent(FID)}&share_id=${encodeURIComponent(SHARE_ID)}&pass_code=${encodeURIComponent(PWD)}`;
    try {
      const r = await fetch(fiUrl, { headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
      const t = await r.text();
      console.log(`[PROBE] file_info space="${sp}" status=${r.status} body(前1500)=`, t.slice(0, 1500));
      try {
        const j = JSON.parse(t);
        const fi = j.file_info || (j.data && j.data.file_info);
        if (fi) console.log(`[PROBE] file_info space="${sp}" 字段 keys=`, JSON.stringify(Object.keys(fi)), ' space=', fi.space, ' space_name=', fi.space_name, ' sub_file_id=', fi.sub_file_id, ' download_url=', fi.download_url || '(无)');
      } catch (_) {}
    } catch (e) { console.log(`[PROBE] file_info space="${sp}" ERR=`, e.message); }
  }

  // 3) download_url：分别试 "不带 space" 和 "带 space=share/drive"，看哪个能 200
  const spaceTry = ['', 'share', 'drive'];
  for (const sp of spaceTry) {
    const dlUrl = `${base}/download_url?share_id=${encodeURIComponent(SHARE_ID)}` + (sp ? `&space=${encodeURIComponent(sp)}` : '') + `&file_id=${encodeURIComponent(FID)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(PWD)}`;
    try {
      const r = await fetch(dlUrl, { headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
      const t = await r.text();
      console.log(`[PROBE] download_url space="${sp}" status=${r.status} dlUrl=`, dlUrl);
      console.log(`[PROBE] download_url space="${sp}" body(前1500)=`, t.slice(0, 1500));
    } catch (e) { console.log(`[PROBE] download_url space="${sp}" ERR=`, e.message); }
  }

  console.log('[PROBE] DONE. 把上面 [PROBE] 开头的所有输出贴给 AI。');
})();
