// 目录标识归一化 + Relay 模式推断工具（从 byokService 闭包下沉，统一入口，消除重复定义）。
//
// normalizeCatalogIdentifier 将模型 id / upstreamModel / 别名 / 原始 model 等
// 任意标识归一为「小写 + 去首尾空白」的规范键，供以下链路复用：
//   - BYOK 激活记录匹配（byokService）
//   - Relay 模型发现（byokService / relayAliasCatalogId）
//   - 目录对账（catalogReconcile）
//   - APIMart 模型类型识别（apimart-model-kind，作注入 lookup 的默认回退）
//   - 主文件 MODEL_CATALOG 查找（catalogLookup）
//
// inferMode / inferNodeTypesFromMode 依据上游 endpoint 推断 relay 模态（image/video/audio/llm）
// 及其对应的节点类型集合，供中继代理层构造响应头与 payload。
// 全部保持纯函数、零依赖，确保各调用点行为与下沉前逐字节一致。

export function normalizeCatalogIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

// 依据上游 endpoint 推断 relay 模态。纯函数，仅依赖入参字符串。
export function inferMode(endpoint = '') {
  if (endpoint.includes('video')) return 'video';
  if (endpoint.includes('image')) return 'image';
  if (endpoint.includes('audio') || endpoint.includes('tts')) return 'audio';
  return 'llm';
}

// 依据模态推导对应的节点类型集合。纯函数，仅依赖入参字符串。
export function inferNodeTypesFromMode(mode) {
  if (mode === 'image') return ['image'];
  if (mode === 'video') return ['video'];
  if (mode === 'audio') return ['audio'];
  return ['text', 'script', 'storyboard', 'aiapp'];
}
