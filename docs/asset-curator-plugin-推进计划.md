# 资产库智能归纳插件 —— 分析与推进计划

> 依据 `C:\Users\123\Desktop\爬虫.txt` 的需求，结合 HMDao 资产库现有能力，梳理「爬虫式素材采集 → AI 打分/标签/分类/去重/管理」诉求，落地为**资产库专属插件**：用户指定本地路径即可自动识别、打标签、归纳去重，并与资产库联网搜索打通，同时收敛分散的「相似搜索」能力。

---

## 1. 爬虫文档分析（取其意，不取其形）

### 1.1 文档要做什么
爬虫文档描述了一个独立产品：浏览器插件 + 跨平台 EXE，从网络/本地成批采集 AI 绘画素材，经**本地 ONNX（CLIP/NSFW/Aesthetic/标签器）打分与打标**，再按相似度**聚类去重**，最后入库管理、支持「以图搜图 / 相似检索 / 标签浏览」。

### 1.2 与 HMDao 路线的冲突（为何不直接照做）
- **法律与合规风险**：文档核心是「公开网络爬取 AI 图站」并附带「规避水印/反爬」倾向，直接落地存在版权与平台 ToS 风险。
- **重复造轮子**：HMDao 资产库**已经具备**目录导入、ONNX 本地推理（autoClassifier / aesthetic / nsfw）、标签分类、相似去重、联网搜图、以图搜图。重写一套爬虫 + EXE 是巨大浪费。
- **架构错配**：HMDao 是桌面端 + 本地 Node 后端 + React 资产库，没有「浏览器插件 + 独立 EXE」的发布通道。

### 1.3 可取的核心能力（转译为插件需求）
| 爬虫文档能力 | 在 HMDao 的落地形态 |
|---|---|
| 指定目录批量读取素材 | 用户填写/选择本地路径 → `importAssetDirectory` |
| 自动识别类型 + 打标签 + 分类 | 后端 `autoClassifier` 已做（后端 `import-directory` 返回 `autoTaggedCount` / `autoClassifiedCount`） |
| 相似度去重/聚类 | 后端导入即去重（`duplicateCount`）+ 本地相似面板 |
| 入库管理 + 标签浏览 | 资产库目录 + 搜索（模糊/拼音/布尔） |
| 以图搜图 / 相似检索 | 本地相似面板 + 联网搜图（Openverse 等免 Key 平台） |
| 按需运行、可下载安装 | 作为「扩展包」出现在**模型下载面板**，点击激活后按需运行 |

---

## 2. HMDao 现状能力映射

| 能力 | 现状 | 位置 |
|---|---|---|
| 目录导入 + 自动打标/分类/去重 | ✅ 已具备（服务端） | `server/hmdao-api.mjs` `processAssetLibraryImportDirectory` |
| 本地 ONNX 推理（标签/美学/NSFW） | ✅ 已具备 | `services/autoClassifier.ts`、`onnxInferenceService` |
| 本地相似检索 | ✅ 已具备（基于标签语义） | `LocalSimilarPanel` + `assetSimilarityService.findSimilarByTags` |
| 联网搜图 / 以图搜图 | ✅ 已具备（免 Key Openverse/Wikimedia） | `WebSearchPanel` + `freeImageSearchService` |
| 增强搜索（模糊/拼音/布尔） | ✅ 已具备 | `searchAssets` + `hmdao-asset-search-engine` |
| 扩展包下载/激活入口 | ✅ 已具备 | `ModelDownloadPanel` `SEARCH_EXTENSIONS` |
| 批量「指定任意路径」一键归纳的**统一入口** | ❌ 缺失 | **本次新增插件填补** |

**结论**：技术底座齐备，缺的是一个把上述能力「串成一步」的插件入口，以及把重复的「相似搜索」收敛掉。

---

## 3. 功能重叠分析（相似搜索重复，需优化/删除）

当前「相似检索」存在 **3 处入口、2 套实现** 的重叠：

1. **本地相似**：预览区 `本地相似素材` 按钮 → `LocalSimilarPanel`（基于标签语义）。
2. **联网搜相似**：卡片/预览/右键菜单的「相似搜索」→ `WebSearchPanel` 反向搜图。
3. 右键菜单 `联网搜相似素材` 与卡片「相似搜索」按钮**功能完全一致**，属冗余。

### 优化方案（消除重叠）
- **统一入口**：以「资产库智能归纳插件」为唯一「相似/补充」栖息地，同时承载本地相似 + 联网补充（已在插件第 3 步实现）。
- **删除冗余**：右键菜单的 `联网搜相似素材` 改为 `智能归纳`；卡片/预览的「相似搜索」按钮保留一个，统一跳转到联网补充（不再各自维护）。
- **预览区「本地相似素材」**：保留作为详情区能力，但数据来源与插件共用 `assetSimilarityService`，避免双份逻辑。

---

## 4. 插件设计（已落地切片）

### 4.1 入口与形态
- 作为扩展包 `hmdao-asset-curator` 出现在 **模型下载面板「搜索与 AI 扩展包」**（内置、已激活）。
- 资产库工具栏新增 **「智能归纳」** 按钮，按需展开面板运行。

### 4.2 三步工作流（已实现对口）
1. **指定路径**：文本输入或系统选择框（可留空，运行时弹窗）。→ `pickAssetLibraryDirectory` / `importAssetDirectory`
2. **识别 / 打标签 / 归纳 / 去重**：复用服务端导入，返回 `importedCount / autoTaggedCount / autoClassifiedCount / duplicateCount` 报告。
3. **增强检索（联网 + 本地合一）**：
   - 基于路径推导关键词 → 一键 **联网补充检索**（打开 `WebSearchPanel` 并预填 `initialQuery`）。
   - 抽样资产 → 一键 **本地相似**（复用预览区 `LocalSimilarPanel`）。

### 4.3 新增/改动文件
| 文件 | 改动 |
|---|---|
| `app/src/config/presetModels.ts` | `SEARCH_EXTENSIONS` 新增 `hmdao-asset-curator` |
| `app/src/components/AssetCuratorPanel.tsx` | **新增** 插件面板（三步工作流） |
| `app/src/components/AssetLibrary.tsx` | 引入面板、新增「智能归纳」按钮与回调 |
| `app/src/components/WebSearchPanel.tsx` | 支持 `initialQuery` 预填关键词 |

---

## 5. 推进计划（分阶段）

### 阶段 0：需求对齐与合规界定（已完成）
- 明确「不做网络爬虫 / 不碰版权素材站」，改为「本地资产归纳 + 联网补充检索」。
- 复用而非重建 HMDao 既有能力。

### 阶段 1：MVP（本次交付）
- [x] 插件入口进入模型下载面板
- [x] 指定路径 → 自动识别/打标签/归纳/去重（服务端复用）
- [x] 归纳报告展示
- [x] 联网补充检索打通（initialQuery 预填）
- [x] 本地相似检索打通
- [ ] 联调验证：指定一个真实图片目录跑通导入 + 报告 + 联网补充

### 阶段 2：重叠收敛（建议紧随）
- [ ] 右键菜单 `联网搜相似素材` 替换为 `智能归纳` 入口
- [ ] 卡片/预览「相似搜索」按钮统一指向联网补充，移除重复实现
- [ ] 预览区 `本地相似素材` 与插件共用同一 `assetSimilarityService` 实例

### 阶段 3：能力增强（可选）
- [ ] 导入后展示** Top 标签云 / 分类分布**（前端拉 `fetchPersistedAssetCatalog` 聚合）
- [ ] 支持「仅归纳不打库」（预览识别结果，用户勾选后再入库）
- [ ] 相似度聚类可视化（按 `assetSimilarityService` 分数分组，替代纯去重）
- [ ] 插件独立打包为可发布扩展（脱离「内置」，走真正的下载/安装/版本管理）

### 阶段 4：发布与校验
- [ ] CI 跑通 `npm run build`（3000 端口静态产物）
- [ ] 编写插件使用说明（README 段落）
- [ ] 验收：用户指定路径 → 资产库准确识别/打标签/归纳/去重 → 一键联网补充相似素材

---

## 6. 验收标准
1. 模型下载面板出现「资产库智能归纳插件」且可激活。
2. 资产库工具栏「智能归纳」可展开面板。
3. 指定本地图片目录后，服务端返回正确的 入库/打标签/分类/去重 计数。
4. 点击「联网补充」后 `WebSearchPanel` 自动预填关键词并出结果。
5. 点击「本地相似」后预览区展示该资产的本地相似结果。
6. 原有三处「相似搜索」冗余入口完成收敛，无功能回退。

---

## 7. 关键复用点（避免重复劳动）
- **识别/打标签/归纳/去重**：`server/hmdao-api.mjs` 的 `import-directory`（无需新写后端）。
- **本地相似**：`services/assetSimilarityService.ts` + `LocalSimilarPanel`。
- **联网搜图**：`services/freeImageSearchService.ts` + `WebSearchPanel`（免 Key 平台开箱即用）。
- **扩展包形态**：`ModelDownloadPanel` 的 `SEARCH_EXTENSIONS` 渲染逻辑。
