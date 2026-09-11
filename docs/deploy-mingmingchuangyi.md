# Ddayup 上线部署清单（mingmingchuangyi.cn）

> 前提：
> - ICP 备案已通过
> - 公安联网备案号/数据码已拿到：`8b2b48e7d25a8ce7a8e171f8cfb1cea4`
> - 服务器系统：**CentOS**（截图显示为 CentOS，不是 Ubuntu）
> - 服务器公网 IP：`43.139.15.112`
> - 支付宝应用公钥已换成 `qnP+...` 版
> - `app/.env` 的 `HMDAO_PUBLIC_BASE` 已改为 `https://mingmingchuangyi.cn`

---

## 步骤 1：域名解析（腾讯云 DNS）

1. 登录腾讯云控制台 → 云解析 DNS → `mingmingchuangyi.cn`
2. 添加 **A 记录**：
   - 主机记录 `@` → 记录值 `43.139.15.112`
   - 主机记录 `www` → 记录值 `43.139.15.112`（可选）
3. 本地验证：`ping mingmingchuangyi.cn` 能解析到 `43.139.15.112` 即成功。

---

## 步骤 2：腾讯云轻量服务器防火墙放行 80/443

腾讯云控制台 → 轻量应用服务器 → 你的实例 → **防火墙** → 添加规则：
- 协议 `TCP`，端口 `80`
- 协议 `TCP`，端口 `443`

> 轻量服务器的防火墙**独立于**服务器内 firewalld，控制台不放行会被云厂商拦截。

---

## 步骤 3：把代码上传到服务器

在本地 PowerShell / 终端执行（排除 node_modules/.git 节省流量）：

```powershell
# 方式A：scp 整个项目
scp -r f:\Work\HMDAODAO root@43.139.15.112:/opt/ddayup

# 方式B：git clone（如果你已推送到远程）
ssh root@43.139.15.112 "cd /opt && git clone <你的仓库> ddayup"
```

---

## 步骤 4：一键部署（CentOS）

SSH 登录服务器后直接执行：

```bash
ssh root@43.139.15.112
cd /opt/ddayup
sudo bash deploy/centos-deploy.sh
```

脚本会自动完成：
- 安装 Node.js v20、pm2、Caddy
- `npm install` + `npm run build`
- 生成 `HMDAO_API_KEY`（保存在 `/opt/ddayup/.apikey`）
- 配置 Caddy（自动 HTTPS，自动续期 Let's Encrypt 证书）
- 启动后端：`ddayup-backend` (127.0.0.1:8792) + `ddayup-web-proxy` (127.0.0.1:3000)
- 仅暴露 443/80，8792/3000 不外放

---

## 步骤 5：验证

```bash
# 服务器本地
systemctl status caddy
pm2 status
curl -k https://127.0.0.1/api/health

# 外网（本地电脑）
curl https://mingmingchuangyi.cn/api/health
```

都应返回 200 且含 `localPostBackends` 等字段。

---

## 步骤 6：添加公安联网备案信息到网页底部

拿到公安联网备案数据码：`8b2b48e7d25a8ce7a8e171f8cfb1cea4`

必须在网站底部展示：

```html
<a target="_blank" href="https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=8b2b48e7d25a8ce7a8e171f8cfb1cea4">
  公安备案号：8b2b48e7d25a8ce7a8e171f8cfb1cea4
</a>
```

> 如果正式备案号（如 `京公网安备 xxxxxxxx号`）与这个数据码不同，以**正式备案号**展示，数据码仅作内部记录。

本项目前端入口在 `app/dist`，构建后把上述 HTML 加到首页底部即可。本地修改 `app` 内的前端源码 → 重新 `npm run build` → `pm2 restart all`。

---

## 步骤 7：真机支付验证

1. 本地：`node app/scripts/check-pay-env.mjs` 全绿
2. 浏览器打开 `https://mingmingchuangyi.cn` → 扩展侧栏「订阅」→ 选支付宝/微信 → 扫码
3. 手机支付 0.01 元 → 应自动激活；后台日志出现 `alipay notify verified` / `wechat notify`
4. 若回调失败：查 Caddy 访问日志 `/var/log/caddy/access.log` 或 `pm2 logs`

---

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 域名打不开，ping 不通 IP | DNS 解析未生效或未配置 A 记录 | 去腾讯云 DNS 检查 |
| ping 通 IP，但浏览器超时 | 腾讯云防火墙/安全组没放行 80/443 | 轻量控制台防火墙加规则 |
| 能打开但提示证书错误 | Caddy 还没拿到证书，或域名没解析到本机 | 等 1-2 分钟，看 `systemctl status caddy` |
| 支付宝 ISV_INVALID_SIGNATURE | `.env` 私钥与平台应用公钥不配对 | 确认平台公钥是 `qnP+` 版 |
| 微信签名错误 | `HMDAO_WX_API_KEY` 与商户平台 APIv3 key 不一致 | 重新核对商户平台 API 安全 |
| 前端空白 | 忘了 `npm run build` | 重新执行部署脚本 |
| 收到回调但 403 | `HMDAO_API_KEY` 与扩展端填写不一致 | 用 `/opt/ddayup/.apikey` 里的值 |
