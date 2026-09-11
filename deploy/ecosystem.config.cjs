/**
 * Ddayup 后端 pm2 常驻配置（云端部署）。
 *
 * 单进程 hmdao-api.mjs 同时提供：
 *   - 8792  API（扩展 / 前端调用的后端接口）
 *   - 3000  ui-static-proxy（Web UI 静态托管 + 反代到 8792）
 *
 * 用法：
 *   cd app
 *   pm2 start ../deploy/ecosystem.config.cjs --env production
 *   pm2 save        # 开机自启（需先 pm2 startup 注册系统服务）
 *
 * 环境变量说明：
 *   HMDAO_API_HOST  监听地址。默认 127.0.0.1（仅本机/Caddy 反代可达）。
 *                   生产环境也保持 127.0.0.1 —— 8792 不再 0.0.0.0 暴露公网，
 *                   所有外网流量必须经 deploy/Caddyfile(443) → 3000 → 8792。
 *                   如需本机直连调试可临时设 0.0.0.0，但生产禁止。
 *   HMDAO_API_KEY   服务端运维 Key。设了之后 /api/health/local-post/runtime/* 写操作必须带此 Key，
 *                   防止匿名用户滥用服务器算力跑 yt-dlp 安装（扩展端在「选项」页填写同一 Key 可自助安装）。
 *   HMDAO_API_PORT  API 端口，默认 8792（一般不动）。
 *   HMDAO_APP_PORT  Web UI 端口，默认 3000（扩展默认连这个端口）。
 */
module.exports = {
  apps: [
    {
      name: 'ddayup-backend',
      cwd: __dirname + '/..',
      script: 'server/hmdao-api.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'development',
        HMDAO_API_HOST: '127.0.0.1',
        HMDAO_API_PORT: 8792,
        HMDAO_APP_PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        // ★ 安全加固：8792 仅监听本机，公网必须经 Caddy(443) 反代进入。
        HMDAO_API_HOST: '127.0.0.1',
        HMDAO_API_PORT: 8792,
        HMDAO_APP_PORT: 3000,
        // 3000 也仅监听本机，由 Caddy 反代（不再 0.0.0.0 直暴露）。
        HMDAO_PROXY_HOST: '127.0.0.1',
        // ★ 部署时请修改为强随机值，例如：openssl rand -hex 32
        HMDAO_API_KEY: process.env.HMDAO_API_KEY || '',
        // 用 Caddy/Nginx 反代到 443，扩展填 https://域名 即可，无需带端口。
      },
    },
    {
      name: 'ddayup-web-proxy',
      cwd: __dirname + '/..',
      script: 'server/ui-static-proxy.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'development',
        HMDAO_APP_PORT: 3000,
        HMDAO_PROXY_HOST: '127.0.0.1',
        HMDAO_API_TARGET: 'http://127.0.0.1:8792',
      },
      env_production: {
        NODE_ENV: 'production',
        HMDAO_APP_PORT: 3000,
        HMDAO_PROXY_HOST: '127.0.0.1',
        HMDAO_API_TARGET: 'http://127.0.0.1:8792',
      },
    },
  ],
};
