# 支付宝支付 · 凭证与开通记录

## 开通信息
- 支付产品：电脑网站支付（alipay.trade.page.pay）
- 开通凭证号：`20260827MFPI1080301060810241007`
- 开通时间：2026-08-27
- 开通账号：hm****@foxmail.com（个体户：宁乡市鸣鸣创意信息技术服务工作室）
- 状态：已开通 / 长期有效

## 已配置凭证（完整值见 .env，勿提交）
| 项目 | 值 | 来源 |
|---|---|---|
| APPID | `2021006192653226` | 开放平台应用详情页 |
| 应用私钥 | 已生成（PKCS8 PEM） | 支付宝密钥工具 |
| 支付宝公钥 | 已获取（平台展示） | 接口加签方式保存后 |
| 商户号 PID | 待填（2088 开头，可选） | 账户中心→商户信息 |
| 加签方式 | RSA2（SHA256）公钥模式 | 接口加签方式 |

## 切换生产步骤
1. 复制 `.env.example` → `.env`
2. `.env` 填 APPID / 应用私钥 / 支付宝公钥
3. `ALIPAY_ENV=prod`
4. `ALIPAY_NOTIFY_URL` / `ALIPAY_RETURN_URL` 填公网 HTTPS 域名（需 ICP 备案）
5. 后端部署到该域名服务器，重启 `server.mjs`
6. 前端 `VITE_PAY_API` 指向该域名

## 前置依赖（未备案前无法真实交易）
- [ ] ICP 备案域名（如 www.mingmingchuangyi.cn）
- [ ] 公网服务器 + SSL 证书
- [ ] notify_url 公网可访问且返回纯文本 "success"

## 沙箱联调（无需备案，当前可用）
- ALIPAY_ENV=sandbox（默认）
- 网关自动用 openapi.alipaydev.com
- 真实收款需切 prod + 备案域名
