const body = JSON.stringify({ channel: 'alipay', plan: 'basic', amount: 99, subject: '基础服务包月付' });
const r = await fetch('http://127.0.0.1:8793/api/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
});
const text = await r.text();
console.log('status', r.status);
console.log('isForm', text.includes('alipaydev.com/gateway.do'));
console.log('hasAppId', text.includes('2021006192653226'));
console.log('snippet', text.slice(0, 160));
