# 部署指南

> 配套文档：[云端账号版方案与 API 契约](./cloud-saas-plan.md)、[浏览器本地多用户方案](./multi-user-browser-local-plan.md)
>
> 本文分两部分：**单机自用（默认）** 与 **云端账号版（`STORAGE=users`）**。
> 末尾有部署前必读的安全清单与运维条目。

---

## 0. 三种运行形态怎么选

`STORAGE` 环境变量决定数据放在哪（只认下面三个值，写错一律回落到 `fs`）：

| | 单机自用 `fs`（默认） | 浏览器本地 `idb` | 云端账号 `users` |
|---|---|---|---|
| 数据在哪 | 服务端 `data/` | 用户浏览器 IndexedDB | 服务端 `data/users/<用户 id>/` + `data/cloud.db` |
| 账号 / 登录 | 无，打开即用 | 无，打开即用 | 邮箱/用户名 + 口令，会话 Cookie |
| 别人的稿子 | 不存在这个问题 | 服务端没有稿子 | 有，但按目录隔离 |
| API Key 放哪 | 服务端 `data/credentials.json`（明文） | 用户浏览器（IndexedDB） | 服务端 `data/users/<id>/`（明文，靠文件权限） |
| 出网方式 | 服务端直接调厂商 | 浏览器直连（CORS 不通走中继） | 服务端直接调厂商 |
| 适合 | 自己一台机器、离线内网 | 公开站点、不想存用户数据 | 小团队/朋友间共享、需要账号与配额 |

```bash
STORAGE=fs     # 单机自用
STORAGE=idb    # 数据全在浏览器
STORAGE=users  # 云端账号版
```

---

## 1. 单机自用（`STORAGE=fs`，默认）

服务端进程同时干三件事：发静态页面、存数据（`data/`）、直接调厂商 API。没有登录，**任何能访问端口的人就是这台机器的作者**，所以默认只监听 `127.0.0.1`。

### 1.1 启动

```bash
pnpm install

# 浏览器端产物（src/ 里浏览器可用的部分转译成原生 ESM + 写 import map + 模型目录）。
# 必须在部署机自己的终端里跑：产物写进 public/browser/，不进版本库。
pnpm build:browser

# 启动（.env 会被自动读取，见 1.2）
pnpm start
```

`pnpm start` 等价于 `node --experimental-strip-types src/server/main.ts`。漏了 `pnpm build:browser` 时页面能打开，但 `/api/*` 全 404 —— 启动日志会点名提醒。

### 1.2 配置

复制 `.env.example` 为 `.env` 再改；服务端启动时自动找**当前工作目录**下的 `.env`（可用 `NOVEL_STUDIO_ENV_FILE` 指定别的路径）。改完重启生效。

最小配置：

```ini
PORT=8787
HOST=127.0.0.1
DATA_DIR=./data
DEEPSEEK_API_KEY=sk-...
```

### 1.3 systemd

```ini
[Unit]
Description=Mo Geng novel studio (single machine)
After=network-online.target

[Service]
Type=simple
User=novel
WorkingDirectory=/srv/novel-studio
Environment=NODE_OPTIONS=--experimental-strip-types
EnvironmentFile=-/srv/novel-studio/.env
ExecStart=/usr/bin/node src/server/main.ts
Restart=on-failure
# 只允许写 data/，其余目录只读；数据目录写在 ReadWritePaths 里
ProtectSystem=strict
ReadWritePaths=/srv/novel-studio/data
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

### 1.4 备份与升级

- 数据全在 `DATA_DIR`，**备份整个目录**即可（含 `credentials.json`，里面是明文 Key，备份也要加密存放）。
- 升级：`git pull` → `pnpm install` → `pnpm build:browser` → 重启。
- 静态资源变更必须重新 `pnpm build:browser`，否则浏览器拿到的是旧产物。

### 1.5 暴露到局域网 / 公网

单机模式**没有鉴权**。`HOST=0.0.0.0` 之后请务必只让反向代理访问 8787，并在网关上限制来源；不要直接把端口开到公网。

---

## 2. 云端账号版（`STORAGE=users`）

### 2.1 它多了什么

- **账号**：邮箱（必填）或用户名登录；口令在服务端用 scrypt 散列；会话令牌库里只存 SHA-256，明文只出现在登录响应里一次。
- **隔离**：每个用户一个目录 `DATA_DIR/users/<用户 id>/`，结构与单机 `data/` 完全同构（作品、素材库、拆解库、记录、设置、凭据都在里面）。
- **会话**：浏览器用 `ns_session` Cookie（`HttpOnly` + `SameSite=Lax`，HTTPS 时加 `Secure`）；Tauri/安卓等原生客户端用 `Authorization: Bearer <token>`，并在登录时带 `x-novel-client: native` 让服务端把 token 放进响应体。
- **配额**：默认每人 1024 MB，按用户目录字节数算。写请求超限返回 `507 {code:"quota_exceeded"}`；`DELETE` 永远放行，留一条自救的路。
- **审计**：注册、登录、登录失败、改密、管理员操作都写 `audit` 表，可在管理页查看。
- **限流**：登录失败同 IP / 同账号各 10 次 / 15 分钟；注册同 IP 20 次 / 小时；改密同账号 5 次 / 15 分钟。超限返回 `429 {code:"rate_limited"}`。

### 2.2 最小启动

```bash
export STORAGE=users
export HOST=0.0.0.0
export DATA_DIR=/srv/novel-studio/data
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD='换成一个强口令'
node --experimental-strip-types src/server/main.ts
```

首管理员有两套办法，任选其一：

1. **环境变量播种**：启动时若库里没有 `ADMIN_EMAIL` 这个邮箱，就用它和 `ADMIN_PASSWORD` 建一个管理员（管理员默认不限配额）。已经存在同邮箱时**不会覆盖**你后来改过的密码，环境变量可以留着不动。
2. **首个注册用户成为管理员**：`FIRST_USER_ADMIN=1`（默认）且库里一个管理员都没有时，第一个注册的人拿到 admin 角色。适合"部署完自己去注册一下"的流程；部署给陌生人用就把它设成 `0` 并配合 `REGISTRATION=closed`。

`ADMIN_PASSWORD` 只在建号那一次用到，不会写日志。建号完成后建议把它从环境变量里删掉。

### 2.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `fs` 时 `127.0.0.1`，其它 `0.0.0.0` | 监听地址；显式设置优先 |
| `DATA_DIR` | `./data` | 数据目录：`cloud.db` + `users/` |
| `STORAGE` | `fs` | `fs` / `idb` / `users` |
| `APP_NAME` | `墨耕` | 登录页与标题展示名 |
| `REGISTRATION` | `open` | `open` 开放注册；`closed` 只允许管理员建号 |
| `DEFAULT_QUOTA_MB` | `1024` | 新用户默认配额（MB），`0` = 不限 |
| `MAX_USERS` | `0` | 账号总数上限，`0` = 不限 |
| `SESSION_DAYS` | `30` | 会话有效期（天），请求时滑动续期 |
| `PASSWORD_MIN_LENGTH` | `8` | 口令最短长度，代码里下限是 6 |
| `FIRST_USER_ADMIN` | `1` | 没有管理员时，第一个注册用户成为管理员 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 空 | 启动时播种的首个管理员，敏感值只写在 `.env` |
| `COOKIE_SECURE` | `auto` | `auto` 按请求协议；`always` 强制（HTTPS 反代）；`never` 纯 http 调试 |
| `TRUST_PROXY` | `0` | 在反代后面设 `1`，才信任 `X-Forwarded-For` / `X-Forwarded-Proto` |
| `CORS_ORIGINS` | 空 | 额外允许的跨源来源，逗号分隔（中继取第一个，账号接口全部认）。Tauri/手机外壳的 `tauri://localhost`、`http(s)://tauri.localhost` 与 `tauri dev` 的 `:1420` 默认放行，无需填写 |
| `RELAY_ALLOWED_HOSTS` | 空 | 中继允许的目标主机，逗号分隔；**云端版务必列白名单** |
| `RELAY_MAX_REQUEST_BYTES` | `8 MB` | 中继请求体上限 |
| `RELAY_REQUESTS_PER_MINUTE` | `60` | 中继按 IP 限流 |
| `RELAY_MAX_INFLIGHT` | `16` | 中继全局并发上限 |
| `RELAY_TIMEOUT_MS` | `180000` | 中继上游超时 |
| `RELAY_MAX_RESPONSE_BYTES` | `64 MB` | 中继响应上限 |
| `DEFAULT_MODEL` | 空 | 默认模型 `provider/modelId` |
| `DEFAULT_THINKING_LEVEL` | `off` | 默认思考强度 |
| `NOVEL_STUDIO_ENV_FILE` | `./.env` | 指定其它 env 文件 |

> `.env.example` 里的 `MAX_TOKENS` / `TEMPERATURE` 是历史配置，服务端当前不读取，保留只为不破坏旧部署。

### 2.4 TLS 与反向代理（必做）

云端版**必须**放在 HTTPS 后面，理由不只是"更安全"：

1. 口令是明文表单提交的，没有 TLS 就等于把口令交给路上的每一跳；
2. 会话 Cookie 不带 `Secure` 时容易被中间人截获；
3. 浏览器只在**安全上下文**里提供 `crypto.subtle` 与 `crypto.randomUUID`，纯 http 的局域网 IP 打开页面时部分功能会直接不可用（口令导出加密、ID 生成都会报错）。

nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name novel.example.com;

    ssl_certificate     /etc/letsencrypt/live/novel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/novel.example.com/privkey.pem;

    # 上传接口上限 32 MB，这里留点余量
    client_max_body_size 40m;

    # 注意：不要把 public/ 用 root 直接发出去。
    # 应用会往 index.html 里注入模式标记（idb/users 两种都要），
    # 绕过应用直接发静态文件，页面会认不出自己在哪种模式。
    gzip on;
    # 必须包含 text/javascript：Node 给 .js 发的就是它，
    # 只写 application/javascript 的话脚本一个都不会被压缩。
    gzip_types text/javascript application/javascript application/json application/manifest+json image/svg+xml text/css;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;      # 流式响应（写作台的 SSE）不能被攒着
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name novel.example.com;
    return 301 https://$host$request_uri;
}
```

对应的服务端配置：`TRUST_PROXY=1`。否则服务端看到的每个请求都来自 `127.0.0.1`，登录限流会把所有人算成同一个人。

> **`TRUST_PROXY=1` 只在确实有反代时打开。** 直接暴露在公网时打开它，任何客户端都能伪造 `X-Forwarded-For` 绕过限流。

Caddy 版本（自动申请证书，适合不想手写 nginx 的情况）：

```caddyfile
novel.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### 2.5 systemd

```ini
[Unit]
Description=Mo Geng novel studio (cloud accounts)
After=network-online.target

[Service]
Type=simple
User=novel
WorkingDirectory=/srv/novel-studio
EnvironmentFile=/srv/novel-studio/.env
ExecStart=/usr/bin/node --experimental-strip-types src/server/main.ts
Restart=on-failure
RestartSec=3
# 只允许写数据目录（cloud.db + users/ 都在里面）
ProtectSystem=strict
ReadWritePaths=/srv/novel-studio/data
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`.env` 里至少要有：

```ini
STORAGE=users
HOST=127.0.0.1
PORT=8787
DATA_DIR=/srv/novel-studio/data
TRUST_PROXY=1
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=...
REGISTRATION=closed
```

`HOST=127.0.0.1` 让服务只听反代，公网只能穿过 nginx 进来。

### 2.6 Docker Compose

仓库根目录已经带 `Dockerfile` / `docker-compose.yml` / `.dockerignore`。镜像基于 `node:24-bookworm-slim`，只装生产依赖，直接跑 TS（不需要 `pnpm build`）。

```bash
# 1) 先生成浏览器产物（public/browser 不进 git，必须在本机构建）
pnpm install
pnpm build:browser

# 2) 配置
cp .env.example .env
#    编辑 .env：至少填 ADMIN_EMAIL / ADMIN_PASSWORD，
#    RELAY_ALLOWED_HOSTS 建议列厂商域名

# 3) 起
docker compose up -d --build
docker compose logs -f
```

compose 里已经固定了三件事，避免照抄 `.env.example` 踩坑：

- `HOST=0.0.0.0`：容器内必须监听所有地址，否则端口映射进不来；
- `STORAGE=users`：这个镜像就是云端账号版；
- `DATA_DIR=/data`：与 `./data:/data` 挂载对齐，数据不会写在容器内部。

`environment` 的优先级高于 `env_file`，所以 `.env` 里的同名项会被上面三项覆盖。

其他说明：

- 数据卷 `./data` 里是 `cloud.db`（WAL 模式，还有 `cloud.db-wal`/`cloud.db-shm`）与 `users/`。**备份这个目录**；容器内进程以 root 运行，Linux 宿主机上所有者为 root，换用户运行时要先 `chown`。
- 健康检查请求 `/api/auth/config`，**任何 HTTP 响应都算存活**（只要进程还能接连接），不要求一定是 200。
- 升级：`git pull` → `pnpm build:browser`（产物变了）→ `docker compose up -d --build`。数据库表在启动时自动建，但**升级前先备份**。
- 镜像里没有 `git`、没有 devDependencies，`public/browser` 必须是构建上下文里已经存在的产物。

### 2.7 备份与恢复

云端版有两份东西必须一起备份，缺一不可：

- `DATA_DIR/cloud.db` —— 账号、会话、审计；
- `DATA_DIR/users/` —— 每个用户的作品、素材、设置、API Key（**明文**）。

**一致性优先**：`cloud.db` 开了 WAL，运行中直接 `cp cloud.db` 可能拿到不一致的副本（还漏掉 `-wal` 文件）。两种可行做法：

```bash
# 做法 A：停服 → 打包整个数据目录 → 起服（最简单，恢复也直接）
systemctl stop novel-studio
tar czf novel-backup-$(date +%F).tar.gz -C /srv/novel-studio data
systemctl start novel-studio

# 做法 B：用 sqlite3 在线备份（不影响服务），users/ 再 rsync
sqlite3 /srv/novel-studio/data/cloud.db ".backup '/backup/cloud.db'"
rsync -a --delete /srv/novel-studio/data/users/ /backup/users/
```

恢复：停服 → 用备份覆盖 `data/` → 起服。用户口令散列与盐都在 `cloud.db` 里，`users/` 只放业务数据，**两者版本要配套**（用同一天的备份）。

备份里有用户 API Key 与口令散列，**备份文件按密钥对待**：加密存放、限制权限，不要放进公开的网盘目录。

### 2.8 配额、注册与账号治理

- **注册开关**：`REGISTRATION=closed` 后注册接口返回 `403 {code:"registration_closed"}`，只能由管理员在管理页建号。
- **人数上限**：`MAX_USERS=N` 满了之后注册返回 `403 {code:"registration_full"}`。
- **默认配额**：`DEFAULT_QUOTA_MB`，只影响新用户；管理页可对单个用户改 `quotaBytes`（0 = 不限）。
- **超配额**：写接口返回 `507 {code:"quota_exceeded", quotaBytes, usedBytes}`，前端会提示去删东西或找管理员；`DELETE` 不受限。
- **管理员能力**：建号、改配额、重置密码（返回一次新口令）、停用/启用、删号（连带删除会话、审计关联与 `users/<id>/` 目录）、查看用量统计与审计日志。管理员不能删除自己。
- **会话管理**：用户可在设置里看自己的登录设备并踢掉其它设备；改密码会自动撤销其它会话。

### 2.9 Web / 桌面 / 安卓怎么连

**Web**：同源部署，打开站点即登录页。账号系统由同一个服务端提供，不需要额外配置；想连另一台服务器时，页面会读 `localStorage["novel-studio/cloud"]`（`{base, token?}`），有值就把它当云端地址。

**Tauri 桌面**：设置页的「连接云端账号」里填服务器地址（例如 `https://novel.example.com`），登录成功后 token 保存到本机 webview 的 localStorage，下次启动自动续用；断开连接后回到本地 SQLite 模式。`src-tauri/tauri.conf.json` 的 CSP 已允许 `connect-src https:` 与 `connect-src http:`，所以填内网 `http://10.0.0.2:8787` 也能连上（但请尽量用 HTTPS，见下）。

**Android**：

- 构建脚本 `scripts/android-patch.mjs` 会自动补 `INTERNET` 权限，并在 `<application>` 上写入 `android:usesCleartextTraffic="true"`，让客户端能连 http 的自建服务器；
- **明文 http 有被同网段窃听/篡改的风险**，口令和作品都会裸奔。正式使用请给服务器配可信证书（Let's Encrypt 即可），把地址写成 `https://`；
- 自签名证书 Android WebView 默认不信任，会直接连不上；要么用公共 CA 签发，要么把证书装进系统信任区；
- 模拟器里访问宿主机用 `http://10.0.2.2:8787`，真机用局域网/公网地址。

### 2.10 升级与监控

- 升级：备份 → `git pull` → `pnpm install` → `pnpm build:browser` → 重启。`cloud.db` 的表在启动时自动创建，结构变更向前兼容，但仍建议每次先备份。
- 监控：进程存活、`/api/auth/config` 的响应码、登录 5xx 率、`507`/`429` 数量、磁盘剩余空间（配额只限制单用户，磁盘满了所有人一起挂）。
- 日志：启动时会打印存储模式、数据目录、注册策略与默认配额；账号操作看审计表。

---

## 3. 安全清单（上线前逐条过）

- [ ] **不要把 8787 直接开到公网。** 单机模式没有鉴权；云端模式也建议只让反代访问（`HOST=127.0.0.1` + nginx/Caddy）。
- [ ] **必须 TLS。** 没有 HTTPS 就没有 `Secure` Cookie、没有安全上下文，口令明文过网。
- [ ] **`TRUST_PROXY` 只在反代后面打开**，并确保反代真的覆盖了 `X-Forwarded-For`（不要透传客户端自带的同名头）。
- [ ] **`RELAY_ALLOWED_HOSTS` 列成厂商域名白名单**（例如 `api.deepseek.com,api.openai.com,api.anthropic.com`）。留空等于把服务器变成任何人都能借用的公网跳板。
- [ ] **改掉示例里的 `ADMIN_PASSWORD`**，建号后从环境变量里删掉。
- [ ] 公开站点建议 `REGISTRATION=closed` 或设 `MAX_USERS`，避免被批量注册塞满磁盘。
- [ ] 用户 API Key 与口令散列都**明文/可离线爆破地存在服务器上**：`DATA_DIR/credentials.json`（单机）或 `DATA_DIR/users/<id>/`（云端）。服务器磁盘要加密，备份要加密，不要把这些目录同步到公共网盘。
- [ ] 中继能看到明文 prompt；隐私要求高的用户应让浏览器直连厂商，而不是走中继。
- [ ] 定期清理过期会话与审计表（`SESSION_DAYS` 自然过期；审计表目前只增不减，量大时手动归档）。

---

## 4. 浏览器本地模式（`STORAGE=idb`，保留说明）

服务端只发静态页 + 无状态中继，**不碰用户数据**：

- 打开站点即进入浏览器本地模式（服务端在 `/index.html` 注入 `window.__NOVEL_LOCAL_MODE__ = true`，`public/boot.js` 见到它就接管全部 `/api/*`）；
- 所有数据在 IndexedDB（库 `novel-studio`，设置/密钥/记录在 `novel-studio-meta`）；
- 出网默认走中继；对 CORS 实测通过的厂商可切成直连：控制台执行 `localStorage["novel-studio/transport"] = "direct"`；
- `data/` 应当保持为空。部署自检里发现里面有工程文件，说明存储模式配错了。

**用户要知道的数据丢失场景**：清站点数据 / 换浏览器 / 无痕模式 / 浏览器配额写满。备份方式是「备份」按钮导出 `.novel` 包（口令加密用 PBKDF2-SHA256 210000 次 + AES-GCM，默认不带密钥）。

单机模式（`fs`）想在同一台机器上试本地模式：地址后加 `?local=1`。

---

## 5. 中继：什么时候需要它

浏览器直连供应商最省事，但受 CORS 限制。实测结论（2026-10 复核）：

| 供应商 | 浏览器直连 | 备注 |
|---|---|---|
| Google Gemini | ✅ | |
| Groq / OpenRouter / Mistral / Cohere | ✅ | |
| DeepSeek | ✅ | |
| Together / xAI / HuggingFace router | ✅ | |
| **Anthropic** | ⚠️ | 必须加 `anthropic-dangerous-direct-browser-access: true`，否则预检 400 |
| **OpenAI / Cerebras** | ⚠️ | 预检能过，但错误响应不带 `Access-Control-Allow-Origin`，前端看到 "Failed to fetch" |
| Cloudflare Workers AI | ❌ | OPTIONS 返回 405 |
| Ollama | ⚠️ | 默认只放行 localhost 原点 |

中继的安全底线（`src/server/llm-relay.ts`）：

- 只允许 HTTPS；解析 DNS 后逐个校验 IP 不落在私有段 / 回环 / 链路本地 / 云元数据地址，校验通过后**钉住这个 IP** 发请求，防 DNS rebinding；
- 拒绝 `user:pass@` 形式 URL、拒绝非标准端口、**不跟随重定向**；
- 按客户端 IP 令牌桶限流 + 全局并发上限；云端模式下 `/api/llm` 也要求登录；
- **不落盘、不记 key、不记正文**；审计日志只记时间、目标主机、状态码、耗时、字节数；
- 密钥由客户端在请求头里临时带来，中继只转发不保存。

---

## 6. 启动自检清单

```bash
# 1. 模式与监听地址
curl -s http://127.0.0.1:8787/api/auth/config | head -c 400; echo
# 云端版期望 mode:"multi"；单机版 mode:"single"；idb 模式该请求走本地模式不走服务端

# 2. 云端版：未登录访问业务接口应为 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/projects
# 期望：401

# 3. 单机版：业务接口照旧可用
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/projects
# 期望：200

# 4. 中继 SSRF 防护：应当被拒绝而不是 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/llm \
     -H 'content-type: application/json' -d '{"target":"http://127.0.0.1/","apiKey":"x"}'

# 5. 数据目录
du -sh "${DATA_DIR:-./data}"; ls -la "${DATA_DIR:-./data}"
# 云端版应能看到 cloud.db 与 users/
```

Docker 部署再加一条：`docker compose ps` 里状态应为 `healthy`（健康检查能连上 `/api/auth/config` 即算存活）。

---

## 7. 附录：外部资料

- CORS 实测指南（含 14 个 LLM API 的浏览器可用性）：https://cors.dev/guides/free-ai-api
- Anthropic 浏览器直连所需的请求头：https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
