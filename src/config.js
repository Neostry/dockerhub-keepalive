/**
 * config.js — 环境变量配置装载
 *
 * 敏感项（APP_SECRET_KEY）缺失时 fail-fast 退出，并给出生成命令。
 * 所有可配项均提供默认值，禁止在代码中硬编码任何敏感信息。
 */

const REQUIRED_KEYS = ['APP_SECRET_KEY'];

function missingKeys() {
  return REQUIRED_KEYS.filter((k) => !process.env[k] || process.env[k].trim() === '');
}

function failFast() {
  const miss = missingKeys();
  if (miss.length === 0) return;
  console.error('[config] 启动失败：缺少必需环境变量 ' + miss.join(', '));
  console.error('[config] 生成主密钥命令：openssl rand -hex 32');
  console.error('[config] 示例：APP_SECRET_KEY="<上面命令的输出>" npm start');
  process.exit(1);
}

failFast();

function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    console.warn(`[config] 环境变量 ${name}=${v} 非整数，使用默认值 ${def}`);
    return def;
  }
  return n;
}

function floatEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (Number.isNaN(n) || n <= 0) {
    console.warn(`[config] 环境变量 ${name}=${v} 非法，使用默认值 ${def}`);
    return def;
  }
  return n;
}

function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const config = {
  // 主密钥（部署 Secret）：任意长度字符串，SHA-256 派生 32B 密钥
  appSecretKey: process.env.APP_SECRET_KEY.trim(),
  // 监听端口
  port: intEnv('WEB_PORT', 8080),
  // 数据文件路径（测试可覆盖；相对路径基于进程 CWD）
  dbPath: process.env.DB_PATH || 'data/app.db',
  // 时区（croner 使用；默认 UTC）
  tz: process.env.TZ || 'UTC',
  // 反向代理场景才信任 X-Forwarded-For（防伪造）
  trustProxy: boolEnv('TRUST_PROXY', false),
  // 登录限速
  loginMaxFailures: intEnv('LOGIN_MAX_FAILURES', 5),
  loginLockMinutes: intEnv('LOGIN_LOCK_MINUTES', 15),
  // 会话有效期（天）
  sessionTtlDays: intEnv('SESSION_TTL_DAYS', 30),
  // 用户名扫描仓库数量上限（0 = 不限，仍受 Docker Hub 分页约束）
  maxReposScan: intEnv('MAX_REPOS_SCAN', 50),
  // 单仓库拉取 tag 数量上限（0 = 全部）
  maxTagsPerRepo: intEnv('MAX_TAGS_PER_REPO', 20),
  // 重试与退避
  pullRetries: intEnv('PULL_RETRIES', 3),
  pullRetryBaseMs: intEnv('PULL_RETRY_BASE_MS', 5000),
  notifyRetries: intEnv('NOTIFY_RETRIES', 3),
  // 空间预检余量（估算容量 × headroom）
  spaceHeadroom: floatEnv('SPACE_HEADROOM', 1.1),
  // 会话 Cookie Secure 标志（HTTPS 反代场景置 1）
  cookieSecure: boolEnv('COOKIE_SECURE', false),
  // 本容器 ID（定时重启兜底用；compose 注入 HOSTNAME）
  hostname: process.env.HOSTNAME || null,
  // 宿主根挂载点（空间预检 statfs；compose 以 /:/host:ro 挂载）
  hostMount: process.env.HOST_MOUNT || '/host',
  // Docker socket 路径
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  // Docker Hub API 地址（测试可覆盖）
  dockerHubBase: process.env.DOCKER_HUB_BASE || 'https://hub.docker.com',
  // 静态资源目录（生产托管前端构建产物：src/web/dist）
  staticDir: process.env.STATIC_DIR || 'src/web/dist',
  // 是否托管静态资源（开发模式前端用 Vite dev server 时可关）
  serveStatic: boolEnv('SERVE_STATIC', true),
};

export default config;
