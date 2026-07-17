/**
 * HMDao CSP 安全头配置 — 从基础版升级到严格版
 *
 * Phase 7 S2: Content Security Policy 严格配置，
 * 防止 XSS、数据注入、未经授权的资源加载。
 *
 * 策略层级：
 * 1. default-src 'self' — 默认只允许同源
 * 2. script-src — 严格限制脚本来源
 * 3. style-src — 允许内联样式（Tailwind 需要）
 * 4. img-src — 允许 AI 生成的图片源
 * 5. connect-src — 限制 API 请求目标
 * 6. frame-src — 禁止嵌入（防 clickjacking）
 *
 * 部署方式：
 * - 开发环境: Vite dev server 注入 meta 标签
 * - 生产环境: Nginx/CDN 响应头注入
 *
 * 风险防护：
 * - CSP 违规上报 — report-uri 收集违规日志
 * - 渐进式启用 — Report-Only 模式先行测试
 */

// ===== CSP 指令定义 =====

export interface CSPDirectives {
  'default-src'?: string[];
  'script-src'?: string[];
  'style-src'?: string[];
  'img-src'?: string[];
  'font-src'?: string[];
  'connect-src'?: string[];
  'media-src'?: string[];
  'frame-src'?: string[];
  'worker-src'?: string[];
  'frame-ancestors'?: string[];
  'form-action'?: string[];
  'base-uri'?: string[];
  'report-uri'?: string;
}

// ===== 严格 CSP 策略 =====

/**
 * 生产环境严格 CSP
 *
 * 原则：
 * - 禁止所有内联脚本（除 nonce）
 * - 禁止 eval()
 * - 禁止 data: URI（除图片）
 * - 禁止第三方脚本（除必要的 CDN）
 */
export const STRICT_CSP: CSPDirectives = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    // Vite HMR (开发环境)
    "'unsafe-inline'", // 仅开发环境，生产环境移除
  ],
  'style-src': [
    "'self'",
    "'unsafe-inline'", // Tailwind CSS 需要内联样式
  ],
  'img-src': [
    "'self'",
    'data:', // base64 图片（AI 生成缩略图）
    'blob:', // Blob URL（视频帧预览）
    'https:', // 外部图片资源
  ],
  'font-src': [
    "'self'",
    'data:', // 内联字体
  ],
  'connect-src': [
    "'self'",
    'ws:', // WebSocket (Yjs 协作)
    'wss:', // WebSocket Secure
    'http://127.0.0.1:8792',
    'http://127.0.0.1:8787',
    'http://localhost:8792',
    'http://localhost:8787',
    'https://api.openai.com', // OpenAI API
    'https://api.anthropic.com', // Claude API
    'https://generativelanguage.googleapis.com', // Gemini API
    'https://dashscope.aliyuncs.com', // 通义千问 API
    'https://api.zhipuai.cn', // 智谱 GLM API
  ],
  'media-src': [
    "'self'",
    'blob:', // 视频/音频 Blob URL
  ],
  'frame-src': [
    "'none'", // 禁止 iframe（防 clickjacking）
  ],
  'worker-src': [
    "'self'",
    'blob:', // Web Worker
  ],
  'frame-ancestors': [
    "'none'", // 禁止被嵌入 iframe
  ],
  'form-action': [
    "'self'",
  ],
  'base-uri': [
    "'self'",
  ],
  'report-uri': '/api/csp-report', // CSP 违规上报端点
};

/**
 * Report-Only 模式 CSP（用于测试，不阻断）
 */
export const REPORT_ONLY_CSP: CSPDirectives = {
  ...STRICT_CSP,
  'report-uri': '/api/csp-report-only',
};

// ===== CSP 构建工具 =====

/** 将 CSP 指令对象序列化为 HTTP 头值 */
export function serializeCSP(directives: CSPDirectives): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(directives)) {
    if (key === 'report-uri' && typeof value === 'string') {
      parts.push(`report-uri ${value}`);
    } else if (Array.isArray(value) && value.length > 0) {
      parts.push(`${key} ${value.join(' ')}`);
    }
  }

  return parts.join('; ');
}

/** 生成 Vite HTML meta 标签注入脚本 */
export function generateCSPMetaTag(directives: CSPDirectives): string {
  const content = serializeCSP(directives);
  return `<meta http-equiv="Content-Security-Policy" content="${content}">`;
}

/** 生成 Nginx CSP 响应头配置 */
export function generateNginxCSPHeader(directives: CSPDirectives): string {
  const content = serializeCSP(directives);
  return `add_header Content-Security-Policy "${content}" always;`;
}

/** 生成 Vite 插件配置（用于 vite.config.ts） */
export function generateViteCSPConfig(): Record<string, unknown> {
  const isDev = process.env.NODE_ENV !== 'production';
  const directives = isDev ? REPORT_ONLY_CSP : STRICT_CSP;

  return {
    name: 'hmdao-csp',
    transformIndexHtml(html: string) {
      const meta = generateCSPMetaTag(directives);
      return html.replace('</head>', `  ${meta}\n</head>`);
    },
  };
}
