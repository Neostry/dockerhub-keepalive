# syntax=docker/dockerfile:1
# =============================================================================
# dockerhub-keepalive —— Docker Hub 镜像保活工具
# 多阶段构建：前端 Vite build → 后端生产依赖（含原生模块）→ node:24-slim 运行时
# 依据：系统架构设计_Architecture.md 第 6 节 部署视图
# =============================================================================

# ---------- 阶段 1：前端构建（Vite build → dist） ----------
FROM node:24-slim AS frontend-build
WORKDIR /build/web
# 先复制锁文件安装依赖，利用构建缓存
COPY src/web/package.json src/web/package-lock.json ./
RUN npm ci
# 再复制源码构建
COPY src/web ./
RUN npm run build
# 产物：/build/web/dist

# ---------- 阶段 2：后端生产依赖（含 better-sqlite3 / argon2 原生模块） ----------
FROM node:24-slim AS deps
WORKDIR /app
# 原生模块编译兜底（prebuilt 不可用时 node-gyp 编译）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 阶段 3：运行时 ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# 运行时无需编译工具；node:24-slim 自带 glibc、tzdata 与 Node 内置 CA
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# 覆盖为多阶段构建出的最新前端产物（避免带入本地开发 dist）
COPY --from=frontend-build /build/web/dist ./src/web/dist

EXPOSE 8080

# 健康检查：/api/health（端口随 WEB_PORT 自适应，见系统架构设计 模块E）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
