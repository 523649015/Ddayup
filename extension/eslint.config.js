// ESLint 扁平配置（flat config，ESLint >= 9）
// 用于 extension/ 下的 MV3 经典脚本与 MAIN/ISOLATED world 注入脚本。
// 复用仓库 app/ 已安装的 eslint 生态运行（无需为扩展新增依赖）。
// 运行：node ../app/node_modules/.bin/eslint .
const path = require('path');
const appNodeModules = path.resolve(__dirname, '..', 'app', 'node_modules');
const globals = require(path.join(appNodeModules, 'globals'));

// 扩展运行时由经典脚本/vendor 注入到全局的标识符（非标准浏览器 API，需显式声明）
const vendorGlobals = {
  // background.js SW 全局
  importScripts: 'writable',
  // vendor 经典脚本挂到 window 的全局
  Hls: 'readonly',
  MP4Box: 'readonly',
  Mp4Muxer: 'readonly',
  // 跨脚本注入的运行时全局（由 importScripts 注入 shared/messages.js 等）
  HMDAO_MSG: 'readonly',
  self: 'writable',
};

const baseLang = {
  ecmaVersion: 2022,
  globals: {
    ...globals.browser,
    ...globals.webextensions,
    ...vendorGlobals,
  },
};

module.exports = [
  {
    // 全局忽略：构建产物、vendor 第三方库、测试脚本、本配置文件
    ignores: ['vendor/**', 'node_modules/**', 'scripts/**', '**/*.min.js', '**/*.cjs', 'eslint.config.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: { ...baseLang, sourceType: 'script' },
    rules: {
      // 基础质量护栏：捕获拆分/重构时最容易犯的「漏挂 self」「未定义变量」
      'no-undef': 'warn',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-unreachable': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-cond-assign': ['warn', 'except-parens'],
      'prefer-const': 'warn',
      'no-var': 'warn',
    },
  },
  {
    // ESM 模块（沙箱预览页与 3D 模型沙箱）
    files: ['model-preview.js', 'sandbox-model.js'],
    languageOptions: { ...baseLang, sourceType: 'module' },
    rules: {
      'no-undef': 'warn',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'prefer-const': 'warn',
      'no-var': 'warn',
    },
  },
];
