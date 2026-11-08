# 墨耕云端版：服务端 + 多端客户端 + 账号与容量

> 2026-11-08 新方向。旧的 `docs/multi-user-browser-local-plan.md` 里「不做云同步、服务端不持用户数据」的结论
> 已被本文件取代；`STORAGE=idb`（纯浏览器本地）仍保留，作为离线模式。
>
> 目标（用户原话）：服务端可部署到服务器；客户端覆盖 Web、桌面（Tauri）、移动（Tauri Android）；
> 多端数据同步；登录、注册；用户管理与云端容量管理。

## 1. 产品形态与边界

- **云端模式（推荐部署）**：`STORAGE=users`。所有作品、素材库、设置、密钥、生成记录都落在服务端
  各自的用户目录里；任何设备登录同一账号即看到同一份数据（即"同步"）。客户端在线使用，不做离线写入合并。
- **单机模式**：`STORAGE=fs`（既有行为，默认）。服务端不分账号，数据仍在 `DATA_DIR/` 根下，适合本机/单人自用。
- **浏览器本地模式**：`STORAGE=idb`（既有行为）。页面用 IndexedDB，服务端不持用户数据；本文件不改其语义。
- 云端模式下仍保留 `.novel` 导出/导入与快照，作为备份/迁移手段；不做逐条 CRDT 同步。
- 不做邮件验证、找回密码邮件、OAuth。管理员可重置密码；用户可自行改密码。所有说明写进部署文档。

## 2. 目录布局

```
DATA_DIR/
  cloud.db                  # 账号/会话/审计（node:sqlite）
  users/<userId>/           # 与既有 fs 数据目录完全同构
    projects/  ... library.json  kinds.json  settings.json  credentials.json
    records.json  material-sources/  snapshots/ ...
```

- 单机模式：`DATA_DIR/` 根下保持原布局，`cloud.db` 不创建、不读取。
- 用户目录按需创建；删除用户时连同目录一起删除。
- 配额 = 用户目录下所有文件字节数之和；数据库本身不计入。

## 3. 环境变量（新增）

| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `STORAGE` | `fs` | `fs` / `idb` / `users`；`users` 为云端多账号 |
| `REGISTRATION` | `open` | `open` 开放注册；`closed` 只允许管理员建号 |
| `DEFAULT_QUOTA_MB` | `1024` | 新用户默认配额，`0` = 不限 |
| `MAX_USERS` | `0` | 注册人数上限，`0` = 不限 |
| `SESSION_DAYS` | `30` | 登录会话有效期（滑动续期） |
| `COOKIE_SECURE` | `auto` | `auto`（按请求协议）/ `always` / `never` |
| `TRUST_PROXY` | `0` | `1` 时信任 `X-Forwarded-For` / `X-Forwarded-Proto` |
| `ADMIN_EMAIL` | 空 | 首次启动播种管理员邮箱 |
| `ADMIN_PASSWORD` | 空 | 配合 `ADMIN_EMAIL`；仅首次建号使用 |
| `FIRST_USER_ADMIN` | `1` | 无管理员时，第一个注册用户成为管理员 |
| `PASSWORD_MIN_LENGTH` | `8` | 密码最短长度 |
| `APP_NAME` | `墨耕` | 登录页/标题展示名 |

`STORAGE=users` 且未显式设置 `HOST` 时默认 `0.0.0.0`（与 idb 一致）。

## 4. HTTP 契约

所有业务接口仍在 `/api/*`。云端模式多加三类前缀；请求/响应均为 JSON（上传除外）。
未登录访问业务接口返回 `401 {error:"请先登录", code:"unauthorized"}`。
被停用账号返回 `403 {error:"账号已停用", code:"disabled"}`。
超过配额返回 `507 {error:"云端容量已满，请联系管理员扩容或删除一些作品。", code:"quota_exceeded", quotaBytes, usedBytes}`。
登录/注册限流返回 `429 {error:"尝试太频繁，请稍后再试", code:"rate_limited", retryAfter:秒}`。

认证方式二选一：
- Web：`Set-Cookie: ns_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=...`（HTTPS 加 `Secure`）。
- 原生客户端（Tauri）：请求头 `Authorization: Bearer <token>`，请求头 `x-novel-client: native` 时响应体额外带 `token`。

CSRF：带 cookie 的非 GET 请求，如果带 `Origin` 且既不等于本站源、也不在允许来源里 → 403。

跨源（Tauri / 手机外壳直连）：`src/server/app.ts` 统一处理 `/api/*` 的 CORS ——
`tauri://localhost`、`http(s)://tauri.localhost` 与 `tauri dev` 的 `:1420` 默认放行，
`CORS_ORIGINS` 可追加；预检 `OPTIONS` 回 204 并回显 `Access-Control-Allow-Origin` 与
`Access-Control-Allow-Credentials`，不在白名单的来源预检直接 403 `{code:"cors_blocked"}`。
`/api/llm` 的预检不要求登录，由中继自己回 CORS 头。

### 4.1 公开

- `GET /api/auth/config` → `{mode:"multi"|"single"|"local", registration:"open"|"closed", minPasswordLength, defaultQuotaBytes, appName}`
- `GET /api/auth/me`
  - 云端已登录 → `200 {mode:"multi", user: PublicUser, usage: Usage}`
  - 云端未登录 → `401`
  - 单机模式 → `200 {mode:"single"}`

`PublicUser`：`{id, email, username, displayName, role:"admin"|"user", status:"active"|"disabled", quotaBytes, createdAt, lastLoginAt}`
`Usage`：`{usedBytes, quotaBytes, breakdown: {projects, library, sources, records, settings, other}, updatedAt}`

### 4.2 登录 / 注册 / 账号

- `POST /api/auth/register` `{email, password, username?, displayName?}`
  → `201 {user, token?}` + Set-Cookie；开放注册关闭/满员/邮箱重复 → 400/403
- `POST /api/auth/login` `{account, password}` → `200 {user, token?}` + Set-Cookie
- `POST /api/auth/logout` → `204`（撤销当前会话并清 cookie）
- `POST /api/auth/password` `{currentPassword, newPassword}` → `204`（撤销其它会话）
- `PATCH /api/auth/profile` `{displayName?, username?}` → `200 {user}`
- `GET /api/auth/sessions` → `{sessions:[{id, current, device, client, ip, createdAt, lastSeenAt, expiresAt}]}`
- `DELETE /api/auth/sessions/:id` → `204`
- `POST /api/auth/sessions/revoke-others` → `204`
- `GET /api/account/usage` → `Usage`

### 4.3 管理员（role=admin）

- `GET /api/admin/users?query=&offset=0&limit=50` → `{users:[AdminUser], total}`
  `AdminUser` = `PublicUser` + `{usedBytes, status, lastSeenAt, sessionCount}`
- `POST /api/admin/users` `{email, password?, username?, displayName?, role?, quotaBytes?}`
  → `201 {user, password?}`（未给密码则生成一次性临时密码并在响应里返回）
- `PATCH /api/admin/users/:id` `{role?, status?, quotaBytes?, displayName?}` → `200 {user}`
- `POST /api/admin/users/:id/password` `{password?}` → `200 {password}`
- `DELETE /api/admin/users/:id` → `204`（删账号、会话、审计关联与用户目录）
- `GET /api/admin/stats` → `{users, activeUsers, disabledUsers, totalUsedBytes, totalQuotaBytes, dataDir}`
- `GET /api/admin/audit?limit=100&offset=0` → `{entries:[{id, at, action, detail, ip, userId, userEmail}]}`

护栏：不能删除/停用/降级最后一个可用管理员；管理员不能删除自己；`quotaBytes=0` 表示不限。

## 5. 服务端实现要点

- `src/server/cloud/db.ts`：`node:sqlite` `DatabaseSync`；表：
  ```sql
  users(id TEXT PK, email TEXT UNIQUE COLLATE NOCASE, username TEXT UNIQUE COLLATE NOCASE,
        display_name TEXT, password_hash TEXT, role TEXT, status TEXT,
        quota_bytes INTEGER, created_at INTEGER, updated_at INTEGER,
        last_login_at INTEGER, last_seen_at INTEGER)
  sessions(id TEXT PK, user_id TEXT, token_hash TEXT UNIQUE, device TEXT, client TEXT,
           ip TEXT, user_agent TEXT, created_at INTEGER, last_seen_at INTEGER,
           expires_at INTEGER, revoked_at INTEGER)
  audit(id INTEGER PK AUTOINCREMENT, at INTEGER, actor_id TEXT, user_id TEXT,
        action TEXT, detail TEXT, ip TEXT)
  meta(key TEXT PK, value TEXT)
  ```
  `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000;`
- 密码：`scrypt`（N=32768,r=8,p=1，64 字节），存储 `scrypt$N$r$p$<saltB64>$<hashB64>`；校验用 `timingSafeEqual`。
- 令牌：32 随机字节 base64url；库里只存 `sha256(token)` 十六进制。
- 会话滑动续期：`last_seen_at` 每 5 分钟最多更新一次；过期即视为无效。
- 限流（内存即可）：登录按 IP 与账号各 10 次/15 分钟，注册 20 次/小时/IP，改密 5 次/15 分钟。
- 审计：注册、登录失败/成功、改密、管理员增删改、配额变更、删除用户。
- 单机模式（fs）下 `/api/auth/me` 返回 `{mode:"single"}`，其余账号接口 400/404；不创建 cloud.db。
- idb 模式保持现状：所有 `/api/*`（除 `/api/llm`）503，静态页注入本地模式标记。

## 6. 多用户工作区

```ts
// src/server/workspaces.ts（Lead 负责）
interface Workspace {
  userId: string;
  dir: string;
  stores: { store, libraryStore, novelStore, kindStore, settingsStore, credentialStore, recordStore };
  runtime: ModelRuntime;                 // 每用户一套模型注册表
  sessions: Map<string, Session>;
  router: ApiRouter;                     // 每用户一个实例
  activeRequests: number;
  lastUsed: number;
}
class WorkspaceManager {
  constructor(config: AppConfig);
  get(user): Promise<Workspace>;         // 懒加载，LRU 上限 50，空闲 30 分钟且无活跃请求才卸载
  usageOf(userId): Promise<Usage>;       // 目录扫描，缓存 5 秒
  invalidate(userId): void;              // 写请求结束后调用
  dispose(userId): Promise<void>;        // 删号前关闭并 flush
  close(): Promise<void>;
}
```

- 每个 workspace 的 `deps.models`：
  - `list: () => listAvailableModels(runtime)`
  - `status: () => listProviderStatus(runtime, {})`（**不要**用服务端 env 的共享密钥）
  - `resolve: (ref) => resolveModel(ref, runtime)`
  - `rebuild: () => { runtime = rebuildModelRuntime(runtime) }`
  - `current: () => runtime.models`
- 每个 workspace 的 `env` 传 `{}`，保证用户只能用自己配置的 API Key。
- `createAskChannel: (sid) => new AskChannel(sid, userId)`；`answerQuestion: (id, a) => answerQuestionFor(userId, id, a)`。
- 自定义素材种类：全局注册表取所有活跃用户的并集；`kindsView` 只展示「内置 + 本用户 kindStore 里的」。
  为此 `api-router.ts` 增加可选依赖 `refreshKinds?: () => void`，三处 `registerCustomKinds(kindStore.list())` 改调它。
- 配额：非 GET/HEAD/DELETE 的业务写请求前检查 `usedBytes >= quotaBytes`（quota>0）→ 507；
  `content-length` 已知时用 `usedBytes + contentLength` 预判。DELETE 永远放行，便于用户自救。
- 云端模式下 `/api/llm` 也必须登录（防止匿名白嫖中继）。

## 7. 客户端契约

- 新增 `public/auth-gate.js`：导出 `ensureAuth()`；`app.js` 顶部 `await ensureAuth()` 后才继续初始化。
  - `window.__DSH_LOCAL_MODE__` 为真 → 直接放行（浏览器本地模式）。
  - 请求 `${base}/api/auth/me`：`mode:"single"` 放行；`mode:"multi"` 且已登录放行；401 显示登录/注册浮层，成功后 resolve。
  - 原生（Tauri）云端：`boot.js` 从 `localStorage["novel-studio/cloud"]` 读到 `{base, token}` 时设置
    `window.__NOVEL_CLOUD_BASE__`、关闭本地模式；`auth-gate` 安装 fetch 改写（`/api/*` → `${base}/api/*`，
    带 `Authorization: Bearer` 与 `x-novel-client: native`）。登录成功后写回该 localStorage 并继续。
  - 网络不通：浮层显示重试；Tauri 可「先用本地版」。
- 新增 `public/account.js` + `public/account.css`：顶栏「账户」入口。
  - 云端：配额进度条（used/quota）、明细、设备会话（可撤销）、改密码、改昵称、退出登录。
  - 管理员：用户列表（搜索/分页）、新建用户、改配额/角色/启停、重置密码、删除、总览统计、审计日志。
  - 本机 Tauri 本地模式：显示「连接云端账号」，填服务器地址后保存并 `location.reload()`；云端模式可「断开云端」。
- `public/index.html`：加账户按钮、账户对话框、`account.css` 引用；`app.js` 加 `bindAccount()`。
- 服务端在 `index.html` 注入 `window.__NOVEL_MULTIUSER__ = true`（云端模式），便于首屏决定是否显示骨架等待。

## 8. 部署与客户端

- Dockerfile（多阶段）：构建 `pnpm build:browser` 后运行 `node --experimental-strip-types src/server/main.ts`；
  数据卷挂载 `/app/data`；示例 `docker-compose.yml`；`.env.example` 补新变量。
- `docs/deployment.md` 增加：云端模式、TLS、反向代理、首次管理员、配额、备份（`cloud.db` + `users/`）、
  systemd 单元、CORS（原生客户端来源白名单）。
- Tauri：`connect-src` 允许 `https:` 与 `http:`（自建服务器）；Android 清单允许 cleartext（自建 http 场景，
  文档注明风险）；`public/boot.js` 优先识别云端配置；`scripts/android-patch.mjs` 补 INTERNET / cleartext。
- 客户端不使用新 npm 依赖。

## 9. 验收

- `pnpm typecheck`、既有 13 套测试全绿；新增 `scripts/auth-check.ts` 并接入 `pnpm test`。
- `auth-check.ts` 至少覆盖：注册/登录/me/令牌；密码错与限流；会话列表/撤销；两个用户数据隔离；
  配额 507 与 DELETE 放行；管理员建号/改配额/重置密码/停用即 401/删号清目录；单机模式 `mode:"single"`。
- 手工冒烟：`STORAGE=users ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm start`，浏览器注册、登录、建项目、
  第二浏览器登录同账号看到同一作品、配额调到 1MB 后导入大文件被 507。
