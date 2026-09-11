# DDayup 后端 API 镜像（仅后端 hmdao-api.mjs，前端走 CloudBase 静态托管）
# 后端是纯 Node ESM，唯一第三方运行时依赖是 busboy。
FROM node:20-alpine

# 后端不需要原生编译，固定平台避免拉错
WORKDIR /app

# 复制 package.json 用于装依赖（只装运行时需要的 busboy）
COPY package.json ./
RUN npm install --no-save --omit=dev busboy@^1.6.0 || npm install --no-save busboy@^1.6.0

# 复制后端源码（server 整个目录，含所有 .mjs 与本地 lib）
COPY server/ ./server/

# 数据目录挂持久卷（用户库 users.json / 已激活 provider / 工作流元数据）
ENV HMDAO_DATA_DIR=/data
ENV HMDAO_API_HOST=0.0.0.0
ENV HMDAO_API_PORT=8792

EXPOSE 8792

# 云端只跑 API：登录注册 + 模型网关转发；本地运行时类能力由用户本机插件提供
CMD ["node", "server/hmdao-api.mjs"]
