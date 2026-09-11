# 扩展云端域名注入脚本 · 跨平台等价说明

本目录提供两套等价脚本，用于在**打包分发扩展前**把默认的 `http://127.0.0.1:3000`
改成你的云端地址，让分发出去的版本默认连接云端，**用户无需手动填写 options**。

- `inject-cloud-domain.sh`  —— Linux / macOS（bash）
- `inject-cloud-domain.ps1` —— Windows（PowerShell）

两者逻辑完全一致，仅语法不同。下面给出逐场景的等价命令对照。

---

## 一、基本原理（两个脚本都一样）

修改扩展配置里的**默认地址**（用户在 options 页手动填写的值仍优先，存于 `chrome.storage`）：

| 文件 | 改动点 |
|---|---|
| `extension/config-runtime.js` | `const DEFAULT_API_BASE = '...'`（唯一真源，第 5 行附近） |
| `extension/config.js` | 两处回退字符串（第 24、32 行，全局未就绪时的兜底） |

> 安全约束：脚本只替换默认地址赋值，不会误伤其它引用（已实测）。

---

## 二、场景对照表

### 场景 1：注入云端域名

| 平台 | 命令 |
|---|---|
| Linux/macOS | `bash deploy/inject-cloud-domain.sh https://ddayup.example.com` |
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/inject-cloud-domain.ps1 https://ddayup.example.com` |

带端口的地址也支持：`https://1.2.3.4:3000`。

### 场景 2：恢复默认本机地址

| 平台 | 命令 |
|---|---|
| Linux/macOS | `bash deploy/inject-cloud-domain.sh reset` |
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/inject-cloud-domain.ps1 reset` |

`reset` 会把地址还原为 `http://127.0.0.1:3000`（本地开发默认值）。

---

## 三、参数说明

| 参数 | 含义 | 校验 |
|---|---|---|
| `<域名>` | 云端 API 基地址，如 `https://ddayup.example.com` | 必须以 `http://` 或 `https://` 开头 |
| `reset` | 恢复默认本机地址 | 固定关键字 |

---

## 四、典型工作流

```bash
# 1) 打包前注入云端域名（Linux 示例；Windows 用 .ps1 等价命令）
bash deploy/inject-cloud-domain.sh https://ddayup.example.com

# 2) 确认注入结果
grep "DEFAULT_API_BASE =" extension/config-runtime.js
# 期望输出：const DEFAULT_API_BASE = 'https://ddayup.example.com';

# 3) 正常打包扩展（chrome 加载已解压 / 上架 Edge 商店）分发

# 4) 若需回退到本地开发默认值
bash deploy/inject-cloud-domain.sh reset
```

> 提示：注入只影响"默认值"。若用户之前在 options 页手填过地址，那个值（存于浏览器
> `chrome.storage.local`）优先级更高，仍会生效。

---

## 五、与部署脚本的关系

- `deploy-cloud.sh` / `deploy-cloud.ps1`：部署**后端**（pm2 常驻 + 鉴权 Key + 输出云端地址）。
- 本注入脚本：部署**扩展打包默认值**。

两者配合即可实现"一键替换 3000 链接直接能用"：
1. 先跑 `deploy-cloud.*` 拿到云端地址与运维 Key；
2. 再把地址用本注入脚本写进扩展默认配置并打包分发；
3. 运维 Key 由站长保存在扩展 options 页（或写进打包配置的 `ddayupApiKey`），用于云端自助安装 yt-dlp。
