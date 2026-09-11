const body = JSON.stringify({ channel: 'wechat', plan: 'basic', amount: 99, subject: '基础服务包月付' });
const r = await fetch('http://127.0.0.1:8793/api/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
});
console.log('status', r.status);
console.log(await r.text());
