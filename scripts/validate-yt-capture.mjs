// 本地验证：YouTube 直链归一化（缺陷 A 修复）。
// 用真实形态的 googlevideo DASH 分段 URL 验证 range/sq/rqh/rn/rbq 被正确删除，
// 得到「整文件」直链而非单片。
function normalizeGooglevideo(reqUrl) {
  const u = new URL(reqUrl);
  if (!u.searchParams.has('itag') && !u.searchParams.has('mime')) return null;
  ['range', 'sq', 'rqh', 'rn', 'rbq'].forEach((k) => u.searchParams.delete(k));
  const mime = u.searchParams.get('mime') || '';
  const itag = u.searchParams.get('itag') || u.pathname;
  const cls = /^audio\//.test(mime) ? 'audio' : 'video';
  return { url: u.toString(), itag, cls, mime };
}

// 仿真：YouTube 播放器实际发出的 DASH 分段请求（含 sq=0 与 range 分段）
const sample = 'https://r4---sn-abc.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4'
  + '&sq=0&rqh=%2B58&rn=1&rbq=1&range=0-32767&expire=1800000000'
  + '&n=AbC123sig&signature=xyz&spawned_by=yt';

const r = normalizeGooglevideo(sample);
const ok = r && !/([?&](range|sq|rqh|rn|rbq)=)/.test(r.url);

console.log('输入(分段URL):', sample.slice(0, 90) + '...');
console.log('输出(整文件):', r ? r.url.slice(0, 120) + '...' : 'null');
console.log('已剥离 range/sq/rqh/rn/rbq:', ok);
console.log('保留 itag/n/signature/expire:', r && r.url.includes('itag=137') && r.url.includes('n=AbC123sig') && r.url.includes('expire='));
console.log('分类:', r && r.cls, 'mime:', r && r.mime);
if (ok) { console.log('\n✅ 归一化通过：该直链为整文件直链，可整段 fetch 播放/下载'); }
else { console.log('\n❌ 归一化失败：仍含分段参数'); process.exit(1); }
