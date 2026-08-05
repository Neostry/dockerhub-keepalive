# 内容策略_DockerHub_Description（Docker Hub 完整介绍 · 发布文案）

> 用途：粘贴到 Docker Hub 仓库页的 Full description（支持 Markdown 子集）。
> 生成人：内容负责人（Content Director），2026-08-04。基于 README.md v1.0（仓库当前 main）整理。
> 截图链接基于 GitHub 仓库 raw URL——**仓库当前为私有，转公开后链接生效**（转公开前 Docker Hub 页截图不显示）。

------------------------------------------------------------------------

# dockerhub-keepalive

自动维护你的 Docker Hub 镜像：定期 pull 保活，防止镜像因 **90 天未拉取被 Docker Hub 下架**。带 WebUI，部署在 VPS 上，配置一次后**零人工干预**。

![登录页](https://github.com/Neostry/dockerhub-keepalive/raw/main/assets/screenshots/login.png)
![任务列表](https://github.com/Neostry/dockerhub-keepalive/raw/main/assets/screenshots/tasks.png)
![控制中心](https://github.com/Neostry/dockerhub-keepalive/raw/main/assets/screenshots/settings.png)

## 为什么需要它

Docker Hub 对 **90 天内无人 pull 的镜像**存在下架风险。许多开源项目没有官方镜像，自建/搬运的镜像一旦被下架就无法再使用。本工具定时帮你 pull 一遍，让镜像"永远活着"。

## 核心功能

- 🔐 **登录保护体系**：单用户登录（首次访问引导设置账号，无默认密码）、密码 Argon2id 哈希存储、可选 2FA（TOTP）、登录失败限速 + 临时锁定；**登录保护开关（F5a）**可关闭登录页，适配 Cloudflare Access 等外部访问控制（默认开启）
- 🖥️ **WebUI 配置**：两种镜像输入——Docker Hub 用户名（自动分页扫描全部公开镜像，展示估算容量/最新 tag/更新时间）或单个镜像路径（`namespace/repo`，支持多行批量）；每个任务独立 cron 表达式（默认示例：每月 1 日 03:00 `0 3 1 * *`）
- 🔄 **自动保活**：定时 pull 镜像 → 完成后**自动删除本地镜像**释放 VPS 空间；执行前自动**空间预检**（不足自动跳过并告警）
- 🧹 **清理兜底**：删除失败自动重试 + 可选深度清理（`image prune`，仅 dangling）+ 可选定时重启容器 + 手动「立即执行清理」
- 📝 **任务日志**：每次执行记录时间、触发方式、逐镜像成功/失败明细、耗时，时间倒序可回溯
- 📣 **三通道通知**：站内信（WebUI 通知中心）+ Telegram bot + 邮件 SMTP，执行完成后发送汇总报告；三通道互备，任一失败不影响其他
- 🐳 **Docker 原生部署**：docker compose 一键启动，通过挂载 `/var/run/docker.sock` 操作宿主 Docker；SQLite 单文件存储，数据卷持久化

## 快速开始

### 1. 配置环境变量

```bash
openssl rand -hex 32   # 生成主密钥
cp configs/.env.example .env   # 填写 APP_SECRET_KEY（必填，缺失拒绝启动）
```

### 2. 启动

```bash
docker compose up -d --build
docker compose ps          # 等待 Up (healthy)
curl http://127.0.0.1:8080/api/health   # 返回 {"ok":true}
```

### 3. 打开 WebUI 配置

访问 `http://<vps-ip>:8080`，首次设置用户名/密码 → 添加镜像来源（用户名扫描或镜像路径）→ 设置 cron → 保存。通知凭证在控制中心表单填写，AES-256 加密入库。

## 环境变量（常用）

| 变量 | 默认 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `APP_SECRET_KEY` | — | ✅ | 主密钥（AES-256 加密凭证/TOTP，缺失拒绝启动） |
| `WEB_PORT` | 8080 | | 监听与映射端口 |
| `TZ` | Asia/Shanghai | | cron 时区 |
| `TRUST_PROXY` | 0 | | 反向代理场景置 1 |
| `COOKIE_SECURE` | 0 | | HTTPS 反代场景置 1 |
| `LOGIN_MAX_FAILURES` | 5 | | 登录失败阈值 |
| `LOGIN_LOCK_MINUTES` | 15 | | 锁定分钟数 |
| `MAX_REPOS_SCAN` | 50 | | 用户名扫描仓库上限 |
| `MAX_TAGS_PER_REPO` | 20 | | 单仓库拉取 tag 上限 |
| `PULL_RETRIES` | 3 | | pull/rmi 重试次数 |
| `NOTIFY_RETRIES` | 3 | | 通知重试次数 |

> 完整清单见 GitHub 仓库 `configs/.env.example`。

## 安全说明

- 仅保活**公开镜像**，无需任何 Docker Hub 账号凭证，不存储账号信息
- 通知凭证（bot token / SMTP 密码 / TOTP 密钥）经 **AES-256-GCM 加密**后存入 SQLite（主密钥 `APP_SECRET_KEY` 部署 Secret），敏感字段**仅写不读**，数据库无明文
- 容器挂载 docker.sock 等效宿主管理员权限——**仅限部署在自有可信 VPS**；`/:/host` 只读挂载，登录保护默认开启

## 资源

- GitHub 仓库：https://github.com/Neostry/dockerhub-keepalive
- License：Apache-2.0

------------------------------------------------------------------------

# GitHub Topics 建议

> GitHub 仓库最多可设 20 个 topics；按"技术栈 + 用途 + 场景"组合推荐：

```text
docker, docker-hub, keepalive, cron, self-hosted, self-hosted-apps,
container, docker-image, webui, nodejs, express, vue3, sqlite,
2fa, telegram-bot, smtp, devops, registry, image-puller, cron-job
```

优先级说明：
- 必选：`docker`、`docker-hub`、`keepalive`、`cron`、`self-hosted`（检索入口）
- 强相关：`container`、`docker-image`、`webui`、`nodejs`、`sqlite`（技术属性）
- 特性标签：`2fa`、`telegram-bot`、`smtp`（差异化功能，利于定向搜索）
- 场景标签：`self-hosted-apps`、`devops`、`image-puller`（社区发现）

------------------------------------------------------------------------

# 变更记录

| 日期 | 变更内容 | 变更人 |
| ---- | -------- | ------ |
| 2026-08-04 | 初稿：基于 README v1.0 撰写 Docker Hub 完整介绍 + GitHub Topics 建议（10+ 标签）；截图链接使用 GitHub raw URL（转公开后生效） | 内容负责人 |
