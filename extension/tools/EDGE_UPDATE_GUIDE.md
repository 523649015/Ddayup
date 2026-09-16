# Ddayup Edge 加载项「一键更新」使用指南

本目录下的 `update-edge-store.ps1` 把「打包」与「上传」合为一条命令：

- **链路 A · 打包**：永远执行，复用 `../build-store-package.ps1` 生成 `ddayup-edge-store-vX.Y.Z.zip`。
- **链路 B · 上传 API**：仅当你已拿到微软下发的 **ApiKey + ClientID** 时自动触发，走 Edge 加载项更新 API（v1.1）把包直接推到 Partner Center 提审；无凭证或任一步失败则自动回退为「打开网页 + 打印清单」的半自动模式。

> 两条链路相互独立、互不混淆。API 凭证属于「商店发布」范畴，与「一键打包」分离，单独分类存储（见下文第三节）。

---

## 零、已确认的商店标识（分类存档）与仍缺失的凭证

### 已确认（均为公开标识，**不含任何密钥**）

| 名称 | 值 | 用途 |
|---|---|---|
| 商店 URL | https://microsoftedge.microsoft.com/addons/detail/jpcnchdcjaapokighokneachmbkeafan | 分发链接 |
| Store ID | `0RDCK9QLWJWP` | 商店标识 |
| CRX ID | `jpcnchdcjaapokighokneachmbkeafan` | 扩展 ID，**仅用于商店链接** |
| Product ID | `2f6d8ab3-b73e-4bce-b35a-356cd96cf8af` | ★ **上传 API 的 `$productID`，128 位 GUID** |
| Public key | `MIIBIjANBgkqhkiG9w0B...` | 扩展签名公钥 |

⚠️ **关键区分（官方文档明确）**：API 路径 `/products/$productID/...` 里的 `$productID` 是
**128 位 GUID 的 Product ID**，**不是** CRX ID、**不是** Store ID。
脚本已按此修正：`$ProductId` = GUID（上传用），`$CrxId` = CRX ID（仅商店链接用）。

### ✅ 凭证已配置（2026-09-15 完成）

| 凭证 | 状态 |
|---|---|
| **Client ID** | 已配置于 `edge-api-config.ps1`（Client ID `49dc58a4-…`） |
| **ApiKey（API key）** | 已配置于同一文件，**不落任何文档** |

- 存储位置：`extension/tools/edge-api-config.ps1`（已被 `.gitignore` 忽略，**不会入库**）。
- 获取方式回顾：Partner Center → Microsoft Edge 程序 → **发布 API** → 启用新体验(v1.1) → 创建 API 凭据。
- 配置完成后 `.\update-edge-store.ps1` 即全自动上传，无需再点网页。

### 首次全自动提交记录（2026-09-15）

- 版本 `0.2.7`（含「版本更新提醒 + 自动更新」新功能）已通过 API 全自动上传并成功提交审核。
- 实测链路：上传包(202) → 轮询 Succeeded → 发布草稿(202) → 轮询 Succeeded → 进入审核队列。
- 结论：一键全自动更新链路已跑通，后续发版只需 `.\update-edge-store.ps1`（必要时 `-BumpPatch`）。

### API 能力边界（微软官方说明）

- ✅ 能做：上传新包更新已有草稿、查询上传状态、发布草稿、查询发布状态（即可全自动更新版本）。
- ❌ 不能做：**创建新 product**、**修改元数据**（名称/描述/截图/商店列表）。
  → 所以「补英文商店列表提升搜索可见性」仍必须在 Partner Center 网页手动完成（见 `../STORE_SUBMISSION_NOTES.md` 第八节）。

---

## 一、申请 ApiKey + ClientID（微软下发，需人工一步）

> 这是唯一需要你手动做的事。脚本无法代你申请，因为凭证由微软审核后通过页面/邮件下发。

1. 打开并登录发布扩展所用的 Microsoft 账号：
   https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd
2. 在控制台进入 **「Microsoft Edge 程序」** → **「发布 API」** 页面。
3. **启用 v1.1 新体验**：若页面提示「启用新体验」，点「启用」切换到用 API 密钥的 v1.1 模式（v1 已于 2024-12-31 停用）。
4. 点 **「创建 API 凭据」**（文档提示可能需几分钟）。
5. 页面自动生成并显示两项，**立即复制并安全保存**：
   - **客户端 ID（ClientID）**
   - **API 密钥（ApiKey）**（注意到期日期）
6. 至此你已具备调用更新 API 的资格。所有端点位于：
   `https://api.addons.microsoftedge.microsoft.com/v1/products/{productId}/...`

---

## 二、一条命令用法

在 `extension/` 目录下用 PowerShell 运行（脚本会自动定位父目录的 `build-store-package.ps1`）：

```powershell
# 1) 已配置凭证 → 打包 + 全自动上传提审
cd extension/tools
.\update-edge-store.ps1

# 2) 先把版本号末位 +1 再打包上传（商店要求新包版本必须递增）
.\update-edge-store.ps1 -BumpPatch

# 3) 不调 API，只打包并打开商店页 + 打印点击清单（本地验证打包链路用）
.\update-edge-store.ps1 -DryRun
```

脚本行为判定：

| 条件 | 行为 |
|---|---|
| 有 ApiKey + ClientID | 链路 A 打包 → 链路 B 上传 → 轮询至 Succeeded → 完成 |
| 无凭证 | 链路 A 打包 → 打开 Partner Center 产品页 → 打印手动清单 |
| 任一 API 步骤失败/超时 | 捕获异常 → 同上回退清单（不中断） |
| `-DryRun` | 仅打包 + 回退清单，不调 API |

---

## 三、凭证的分类存储（与「一键打包」隔离）

不要把 API 密钥混进打包脚本或提交到仓库。本工具提供独立、被 `.gitignore` 忽略的存储位：

**方式一（推荐）· 专用分类文件**
1. 复制模板：`extension/tools/edge-api-config.example.ps1` → `extension/tools/edge-api-config.ps1`
2. 填入密钥（该文件已被 `.gitignore` 忽略，不会入库）：
   ```powershell
   $env:EDGE_ADDON_API_KEY   = '此处粘贴微软下发的 ApiKey'
   $env:EDGE_ADDON_CLIENT_ID = '此处粘贴微软下发的 ClientID'
   ```
3. 之后直接 `.\update-edge-store.ps1` 即可，脚本会自动 dot-source 此文件。

**方式二 · 系统环境变量**
```powershell
$env:EDGE_ADDON_API_KEY   = '...'
$env:EDGE_ADDON_CLIENT_ID = '...'
```

**方式三 · 命令行参数（不持久）**
```powershell
.\update-edge-store.ps1 -ApiKey '...' -ClientId '...'
```

优先级：**参数 > 分类文件 > 环境变量**。密钥在日志中一律遮蔽显示（仅显示前 4 字符）。

---

## 四、版本号规则

- 商店要求：新包 `version` **必须 >** 已发布版本，否则上传/发布被拒。
- 当前 `manifest.json` 版本：`0.2.6`（对应已发布产品 ID `jpcnchdcjaapokighokneachmbkeafan`）。
- 若本次仍是 0.2.6 且线上已是其更新版本，运行前加 `-BumpPatch` 自动升至 0.2.7 再打包。
- 只有显式 `-BumpPatch` 才会改写 `manifest.json`，否则直接复用当前版本。

---

## 五、手动回退步骤摘要（无凭证或 API 失败时）

完整人工流程见 `../STORE_SUBMISSION_NOTES.md` 第八、九、十一节。摘要：

1. Partner Center 进入该扩展 → 点 **Update** 创建草稿。
2. **Packages** 区移除旧包，上传 `ddayup-edge-store-vX.Y.Z.zip`。
3. （可选）**Listings** 补英文市场信息，提升搜索可见性。
4. 填 **Notes for certification / What's new**。
5. 点 **Submit** → 预检 → 人工审核（通常 1–3 个工作日）→ 自动覆盖线上版本，用户浏览器静默升级。

---

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 脚本只走半自动、没自动上传 | 检查 ApiKey/ClientID 是否配置（方式一/二/三），或运行 `-DryRun` 确认打包链路 |
| 上传返回版本未递增错误 | 加 `-BumpPatch` 重跑 |
| API 返回 401 | ApiKey/ClientID 填错或未启用 v1.1；回 Partner Center「发布 API」核对 |
| 包过大上传超时 | 默认超时 600s；确认 zip 不含 native-host/node_modules（由 build-store-package.ps1 排除） |
| 提交后长时间 InProgressSubmission | 属微软服务端队列正常，可在 Partner Center Overview 查看最终状态 |
