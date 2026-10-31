# 多用户 / 浏览器本地存储改造方案

> 目标：**一台服务器，多个访客；每个访客的小说、正文、素材、对话、设置、API Key 全部只存在他自己浏览器的 IndexedDB 里，服务器不落盘、不持有、不共享。**
>
> 本文是 2026-10-26 对代码库全量勘察后的落地方案。所有行号均为实测。

---

## 0. 一句话结论

把服务端从「**全栈单机应用**」拆成「**静态托管 + 无状态 LLM 中继**」：

| 层 | 现在 | 改造后 | 在哪 |
|---|---|---|---|
| 存储层 | `src/store/*` 写 `data/` | `src/store/*` 换成 IndexedDB 实现 | 浏览器 |
| 业务/路由层 | `handleApi()` 绑死 node http | 抽成与传输无关的路由层 | **同一份代码跑在浏览器里** |
| AI 层 | 服务端 agent + 服务端工具写盘 | agent 与工具搬进浏览器（或留服务端但改走浏览器数据） | 浏览器 |
| LLM 出网 | 服务端持全局密钥代理 | 用户自带 Key，无状态转发 | 浏览器 →（可选）中继 → 供应商 |

**关键洞察：这套代码的改造量比想象中小得多，因为耦合点极少。**

- 全部 AI 工具只通过一个接口碰数据：`deps.store: ProjectStore`（`src/ai/tools.ts:89-102`）。工具逻辑本身不碰文件系统。
- 全部 51 个 API 路由集中在一个函数 `handleApi()`（`src/server/main.ts:1051-2513`），与 node 的耦合只有 5 个点：`req.method`、`url.pathname`、`readJsonBody(req)`、`readRawBody(req)`、`json(res,...)`（`main.ts:196-235`）。
- `pi-agent-core@1.2.0` 的 dist **零 node 内建依赖**（grep `node:|require(|process.|Buffer` 全无），可直接在浏览器跑。
- `src/store/project.ts` 混了「纯模型」和「磁盘 IO」两半，拆开是整个任务里性价比最高的一刀。

---

## 1. 现状勘察结论（为什么必须改）

### 1.1 服务端今天就是一台「共享单例」

`src/server/main.ts:2550-2558` 在进程启动时创建**一组进程级单例**：
`kindStore` / `store`（ProjectStore）/ `libraryStore` / `settingsStore` / `credentialStore` / `recordStore`。

| 单例 | 落点 | 多用户下的破坏面 |
|---|---|---|
| `settingsStore` | `data/settings.json`（10.5 KB，全局一份） | A 改默认模型 → B 立刻跟着变（`main.ts:2182-2201`） |
| `credentialStore` | `data/credentials.json`（明文，全局一份） | A 改密钥 → B 的密钥被覆盖；`DELETE /api/providers/:id/key` 会删掉**运营方自己的**密钥 |
| `store` | `data/<pid>.json` + `data/drafts/**` | `GET /api/projects` 返回**全体用户**的工程 |
| `libraryStore` | `data/library.json` | 同上，跨用户共享 |
| `recordStore` | `data/records.json`（**713 KB**，含完整正文与对话） | `GET /api/records/:id` 可按 id 取回**任意用户**的完整对话 |
| `sessions` | `Map<string, Session>`（`main.ts:125`，TTL 6h，上限 64） | 会话 id 即凭据，无 owner 校验（`main.ts:1444` 生成的 UUID 后续只按 id 查） |

**零鉴权**：`public/` 里 grep `userId|currentUser|login|Authorization|cookie` 零命中；`main.ts` 里同样零命中。只要把 `HOST` 从 `127.0.0.1` 改成 `0.0.0.0`（`src/config/env.ts:37`），上面所有接口就是裸奔的。

还有两个现状就存在的洞，和多用户无关也该顺手堵：
- **SSRF + 烧钱**：`POST /api/providers/:id/models/fetch`（`main.ts:2294-2325`）拿**服务器保存的密钥**去请求**用户提供的任意 baseUrl**；同一路由无配额，可反复触发。
- **供应商目录可被他人改向**：自定义供应商 id = `slugify(label)`，同名 409；他人可 `PATCH /api/providers/:id` 改掉你的 baseUrl。

### 1.2 「数据不落服务器」的完整清单

`data/` 现状与目标归属（体量为实测值）：

| 路径 | 现状 | 目标 |
|---|---|---|
| `credentials.json` | 223 B，2 条明文密钥 | **删除**。用户 Key 进浏览器 IndexedDB |
| `settings.json` | 10.5 KB，40 builtin + 2 custom | **迁浏览器**。服务端只留一份只读公共目录 |
| `records.json` | **713 KB**，含整章正文与完整对话 | **迁浏览器** |
| `library.json` / `kinds.json` | 素材库 / 自定义分类法 | **迁浏览器** |
| `<pid>.json` | 135 KB + 14 KB，工程骨架 | **迁浏览器** |
| `drafts/<pid>/*.txt` | 17 KB + 10 KB，章节正文 | **迁浏览器** |
| `drafts/<pid>/*.meta.json` | 元数据 | **迁浏览器** |
| `drafts/<pid>/*.hist/<rev>.json` | 12 个历史版本 | **迁浏览器** |
| `snapshots/<pid>/*.json` | 53 + 217 + 215 KB 旧快照 | **迁浏览器** |
| `drafts/<pid>/*.json.migrated` | 110 KB 遗留物 | 删除 |
| `trash/` | 当前不存在，但代码会把删除项移进去（`project.ts:1371-1412`） | 浏览器端回收站 |
| `uploads/` | 不存在，且**现状就是对的**（`src/server/upload.ts` 全程不落盘，`extractText` 是纯函数 `upload.ts:219`） | 保持不落盘 |

> `records.json` 是最刺眼的一个：713 KB 里绝大部分是用户的小说正文与创作对话。
> 而 `GET /api/records/:id`（`main.ts:1801-1806`）能按 id 取回任意记录——直接违反目标。

### 1.3 密钥今天怎么流的

服务端持全局密钥 → 代理上游 → 浏览器只见 `•••••••`（`src/ai/models.ts:350-378` 的 `maskedKey`）。
**今天没有任何「用户自带 Key」通路。**

但好消息：**SDK 原生支持，改动量近乎为零**：
- `pi-agent-core` 有 `getApiKey?: (provider: string) => Promise<string|undefined>|string|undefined` 钩子（`dist/agent.d.ts:12,44`），在 `dist/agent-loop.js:269-275` 被调用，优先级高于凭据存储。
- `pi-ai` 里 `overrides.apiKey` 会**完全短路**凭据存储（`dist/auth/resolve.js:14-23`），`streamSimple` 也接受 `options.apiKey`（`dist/models.js:422-443`）。

⇒ 只要在构造 Agent 时注入 `getApiKey`，BYO Key 通路立刻成立，`data/credentials.json` 就不必存在。

### 1.4 直连供应商的 CORS 实测（决定 LLM 出网方案）

2026-10-26 经 cors.dev 实测 14 个 LLM API 的浏览器 CORS：

| 结论 | 供应商 |
|---|---|
| ✅ 浏览器直连可用 | Google Gemini、Groq、OpenRouter、Mistral、Cohere、DeepSeek、HuggingFace router、Together、xAI |
| ✅ 加请求头可用 | Anthropic（必须带 `anthropic-dangerous-direct-browser-access: true`，否则 preflight 400 "Disallowed CORS origin"） |
| ⚠️ 预检过但错误响应无 ACAO | OpenAI、Cerebras（401/400 浏览器读不到，表现为 "Failed to fetch"；成功路径未实测） |
| ❌ 无 CORS | Cloudflare Workers AI（OPTIONS → 405）；Ollama 默认只放行 localhost 原点 |
| ❓ 未列 | Qwen/DashScope、Kimi/Moonshot、GLM、MiniMax、火山方舟 —— **按"很可能被拦"处理** |
| — | GitHub Models 已于 2026-07-30 停服 |

**关键限制**：前端发出的任何东西，访客在 DevTools 里都能读到。把运营方自己的 Key 放前端不安全；CORS 代理也藏不住——**生产应用若用自己的 Key，必须有后端持有**。

---

## 2. 目标架构

### 2.1 三个独立命题

用户的诉求其实包含三件必须分开决策的事：

1. **数据存哪** → IndexedDB。（不可回避，无论选哪条路都要做）
2. **多用户隔离** → 服务端不再存在任何"全局单例的用户数据"。每人一份在浏览器。
3. **LLM 出网与密钥** → 谁持 Key、请求怎么出、谁付钱。

### 2.2 推荐形态：R1「浏览器即应用」+ R2「无状态中继」

```
┌─ 浏览器 ─────────────────────────┐        ┌─ 服务器（无状态）────────┐
│  public/app.js（现有 UI 不改）      │        │  GET /            → 静态  │
│    ↓ api() 改为本地路由            │        │  POST /api/llm    → 转发  │
│  LocalRouter（= 抽出的 handleApi）  │───────▶│     不落盘 / 不记正文  │
│    ↓                              │  SSE   │     / 限流 / 白名单     │
│  IndexedDB  ←── 全部数据           │        │                       │
│    ↑                              │        └───────────────────────┘
│  Agent（pi-agent-core）            │
│    ↓ tools.ts（deps.store 换成     │
│      IdbProjectStore，一行逻辑不改）│
│  用户自己的 API Key（浏览器持有）    │
└───────────────────────────────────┘
```

服务端剩下的东西：静态文件 + 一个字节转发器。**没有 `data/` 目录，没有任何用户状态。**

### 2.3 三个候选方案的取舍

| | **R1-a 浏览器内跑 Agent**（推荐） | **R1-b 服务端跑 Agent + 浏览器当存储** | **R1-c 服务端上下文推送** |
|---|---|---|---|
| 服务端持用户数据 | 否 | 否 | 否 |
| 工具执行位置 | 浏览器 | 服务端（但数据在浏览器，走 WS RPC） | 浏览器执行，服务端转发 |
| `src/ai/tools.ts` 改动 | **无**（只换 `deps.store`） | **无** | 大（写工具要改成"返回意图"） |
| `scripts/agent-loop.ts` | 传 `IdbProjectStore`（fake-indexeddb）即可通过 | 传 `RemoteProjectStore` 即可通过 | 需重写 |
| 需要打包器 | **是**（esbuild） | 否 | 否 |
| 需要 WebSocket | 否 | **是** | 否 |
| 服务端能否看到明文 prompt | **不能**（除转发那一刻） | 能（不落盘） | 能（不落盘） |
| 隐私强度 | **最高** | 中 | 中 |
| 标签页关闭 | 生成中断 | 生成中断 | 生成中断 |
| 工作量 | 中高 | 中 | 中（但改 tool 语义） |

**推荐 R1-a**，理由：
- 隐私承诺最强，符合"数据全部保存在用户的浏览器"的字面要求；
- 工具层零改动，改动集中在"换实现"而非"改逻辑"；
- 服务端最终只剩 150 行，可放到任何静态托管 + 一个转发函数上，横向扩容无状态。

**若不愿引入打包器**（本项目 `public/` 是纯原生 JS、零构建步骤），选 **R1-b**：保留服务端 agent，新增 WebSocket 通道 + `RemoteProjectStore`（实现与 `ProjectStore` 完全相同的 20 个方法）。`tools.ts` / `novel-agent.ts` / `scripts/agent-loop.ts` 一行不改。代价是服务端会看到明文 prompt（仍然**不落盘**），以及多一套 WS/RPC 协议。

> 注：`pi-agent-core` 自带一个反向的传输层 `dist/proxy.js`（`streamProxy`，"Proxy stream function for apps that route LLM calls through a server"），R1-b 之后若想再把 agent 搬回浏览器，可以直接复用。

### 2.4 LLM 出网：三种密钥模式

| 模式 | 密钥在哪 | 服务端看得到 prompt？ | 运营方付钱？ | 必备防护 |
|---|---|---|---|---|
| **B（推荐默认）BYO + 无状态中继** | 浏览器 IndexedDB，请求时随行 | 中继转发那一刻看得到（不落盘） | 否，用户自己付 | 中继不写盘、日志过滤 Authorization、baseUrl 白名单、体积/超时上限 |
| **A 浏览器直连** | 浏览器 | **看不到** | 否 | 只对 §1.4 实测通过的供应商开放；Anthropic 加专用头 |
| **C 运营方共享 Key** | 服务端环境变量 | 看得到 | 是 | **8 件套**：身份 cookie、限流、token/费用配额、出网白名单（自定义 baseUrl 必须禁用）、审计只记元数据、强制 maxTokens、密钥从 `credentials.json` 移到密钥管理服务、熔断 |

**建议**：默认 B；对 §1.4 白名单内的供应商提供 A 开关（零延迟、零服务器数据通路）；C 作为"赞助额度"可选，且必须 8 件套齐了才开。

---

## 3. 改造清单（按依赖顺序）

### R0 · 无悔改动（无论选哪条路都要做）

这些改动把"存储"从"磁盘"抽象成"接口"，是后面所有工作的地基。

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| R0-1 | **拆 `src/store/project.ts` 为纯模型层 + 磁盘层** | `project.ts`（1696 行） | 纯模型半：`countWords:344`、`kindLabel:162`、`kindOptions:151`、`assembledMaterials:702`、`linkMaterials:720`、`projectStats:640`、`normalizeProject:504`、全部 types。磁盘半：`ProjectStore` 类本体。**这是整个任务性价比最高的一刀**：`prompts.ts` 和 `tools.ts` 目前因为 `import { kindLabel } from "../store/project.ts"` 而被 `node:fs` 拖住（`project.ts:1-4`），拆开即解。 |
| R0-2 | **定义存储端口接口** | 新建 `src/store/store-port.ts` | `ProjectStorePort`（20 个方法，与 `ProjectStore` 现有公开面一一对应）、`MaterialLibraryPort`、`KindStorePort`、`RecordStorePort`、`SettingsPort`、`CredentialPort`。`tools.ts:89-102` 的 `deps.store` 改依赖接口而非具体类。 |
| R0-3 | **抽出与传输无关的路由层** | 新建 `src/api/router.ts`，`main.ts:1051-2513` 迁入 | 定义 `ApiRequest { method; pathname; searchParams; json<T>(); raw(); }` / `ApiResponse { status; body?; stream?; }`，把 `handleApi` 改成 `createApiRouter(deps): (req: ApiRequest) => Promise<ApiResponse>`。node 侧写一个 adapter 把 `IncomingMessage/ServerResponse` 翻译进去；浏览器侧写一个 adapter 直连 IndexedDB。**前端 71 个调用点一个都不用改。** |
| R0-4 | `node:crypto` → 全局 `crypto` | `tools.ts:4`、`server/ask.ts:1`、`store/library.ts`、`store/kinds.ts`、`config/credential-store.ts` | 浏览器原生 `crypto.randomUUID()`。 |
| R0-5 | `node:zlib` gzip 快照 → `CompressionStream` | `project.ts:1507-1536`（`snapshot`） | 浏览器 `CompressionStream("gzip")` 全线可用；如需解压回读用 `DecompressionStream`。 |
| R0-6 | 修 `public/app.js:1965` 的 `loadProjects` 未定义 | `app.js:1965` | 回收站"恢复到案头"成功后调了不存在的函数，真实函数是 `reloadProjects()`（`app.js:5271`）。顺手修掉。 |

> **注意 R0 的一个陷阱**：本项目用 `node --experimental-strip-types` 直接跑 TS（`package.json:11-12`），**参数属性（`constructor(private x)`）是 SyntaxError**。移植到浏览器构建时类不能写参数属性。

### R1 · 浏览器本地数据层

| # | 改动 | 说明 |
|---|---|---|
| R1-1 | `IdbProjectStore implements ProjectStorePort` | 20 个方法全部落地。关键：`mutate(id, fn)` 是同步回调 + 读改写语义 → 用「每工程串行队列 + 事务内读出后同步应用 fn 再写回」实现；`withChapterLock` 用 `projectId::chapterId` 键的 promise 链互斥（与服务端 `project.ts:1353` 同语义）。 |
| R1-2 | 其余 5 个 IndexedDB store | `IdbMaterialLibrary`、`IdbKindStore`、`IdbRecordStore`、`IdbSettingsStore`、`IdbCredentialStore`。 |
| R1-3 | **写序升级** | 服务端写序是「正文 .txt → 历史 → meta」（`project.ts:945-1023`），靠 rename 原子性保证，崩溃仍可能只写一半。浏览器版用**同一个 IndexedDB 事务**写三者 → 真正的原子性。**这是迁移带来的净收益，值得写进发布说明。** |
| R1-4 | 快照 | 服务端快照 = gzip 的 `{project, bodies}`（`project.ts:1507`）。浏览器版存结构化克隆（可直接读）或 gzip Blob；上限仍是 `MAX_SNAPSHOTS=20`（`project.ts:37`）。 |
| R1-5 | 回收站 | 服务端 `remove` 会把工程移进 `data/trash/<id>/`（`project.ts:1371-1412`）。浏览器版用一张 `trash` 表存骨架 + 指向 drafts 的引用（正文不复制，直接留原记录 + 打标记）。 |
| R1-6 | 上传解析搬到浏览器 | `extractText`（`src/server/upload.ts:219`）是纯函数、不落盘 ✅。但它用 `node:zlib` 解 zip（`readZipEntries:120-152`）→ 浏览器用 `DecompressionStream("deflate-raw")` + 自己写 ~80 行 ZIP 中央目录解析，或引 `fflate`（3 KB）。**不要为了省这点代码把文件传给服务端。** |
| R1-7 | 前端 `api()` 换目标 | `public/app.js:345-363` 与 `public/settings.js:104-118` 是**两份独立副本**，都要改：路径以 `/api/projects`、`/api/library`、`/api/kinds`、`/api/records`、`/api/settings`、`/api/uploads`、`/api/storage` 开头 → 走本地路由；其余（`/api/sessions*`、`/api/questions/*`、`/api/projects/:id/chapters/:cid/write`）→ 走远端（或 R1-a 后也走本地）。 |
| R1-8 | 删掉服务端落盘重试 UI | `pendingBodies` / `POST /api/storage/retry` / `#storage-banner`（`app.js:1418/1442`、`index.html:271`）在纯本地存储下**整个失去意义**，随 R1 一起删。 |
| R1-9 | 迁移现有 localStorage | 6 个键（`novel-studio-theme`、`/mode`、`/project`、`/chapter/<pid>`、`/typography`、`/split/<viewId>`，`app.js:1169-1251`）保留原样，不要清空——它们是纯 UI 偏好，天然 per-user。 |

**前端渲染层零改动**：约 45 个 `render*` / `update*` 函数只读 `state`，只要 adapter 保持"填 state 的形状"就不用动。几个需要小心的点：
- `state.project.drafts[chapterId]` 现在装的是 `ChapterMeta`（不含正文），正文在 `state.bodies`（`app.js:42-171`）——adapter 要同时维护这两处，`adoptChapterMeta`（`app.js:438-448`）是天然的写入点。
- `syncBodies()`（`app.js:527-537`）靠 `meta.revision !== body.revision` 判失效——IndexedDB 版要自己维护 `revision` 计数。
- `MAX_BODIES = 4`（`app.js:451`）在 IndexedDB 下不再是内存约束，可以放宽（迁移的收益）。
- 自动存稿 1.4 s debounce（`app.js:2680-2685`）里 `autosave:true` 原本表示"服务端先写正文再写元数据"的顺序保障——浏览器版由 R1-3 的事务承担，前端只需保留节流语义。

### R2 · 无状态 LLM 中继 + 多用户隔离

| # | 改动 | 说明 |
|---|---|---|
| R2-1 | 新建 `POST /api/llm`（或 `POST /api/llm/:provider`） | **只转发，不落盘、不记正文**。请求体带 `{ provider, model, apiFormat, baseUrl, apiKey, messages, stream }`；服务端 `apiKey` 只在内存里取用，转发后丢弃。 |
| R2-2 | BYO Key 通路 | 在构造 Agent 时注入 `getApiKey`（`dist/agent.d.ts:12`），浏览器把 Key 存在 IndexedDB、请求时随行。`src/ai/custom-provider.ts:60-87` 的 custom provider 也要支持（目前只认"已存密钥"）。 |
| R2-3 | 中继安全 | ① `baseUrl` 白名单（禁自定义，或必须规范化后匹配允许域）——否则就是今天 `models/fetch` 的 SSRF；② 请求体上限沿用 `MAX_JSON_BYTES = 8 MB`（`main.ts:69`）；③ 超时沿用 `STREAM_TIMEOUT_MS = 180 s`（`novel-agent.ts:138`）；④ 日志/错误栈过滤 `Authorization`、`apiKey`、正文；⑤ 不缓存响应。 |
| R2-4 | 限流 | 按 IP + 匿名 cookie 双维度限流；`/api/llm` 是唯一花钱的出口，必须限。这是当前**完全缺失**的能力。 |
| R2-5 | 匿名身份 cookie | HttpOnly + Secure + SameSite=Lax。仅用于限流归属与（可选）运维方共享 Key 的配额，**不作为数据隔离手段**（数据隔离靠浏览器本地）。 |
| R2-6 | 服务端 `data/` 目录停用 | 启动时断言目录为空/只读；`DATA_DIR`（`env.ts:38`）指向 tmpfs 或空目录。**加一条 CI 检查：禁止新增写 `data/` 的代码路径。** |
| R2-7 | 静态资源缓存头 | 现在 `serveStatic` 一律 `cache-control: no-store`（`main.ts:2515-2530`）——本地开发取向。多用户部署应改成带内容哈希 + `immutable`。 |
| R2-8 | TLS 与反向代理 | 现在无 TLS、无 CORS 配置（同源即可）。公网部署必须上 TLS；仓库里没有 Dockerfile / nginx / systemd 配置，需要补。 |

### R3 · Agent 进浏览器（仅 R1-a 路线）

| # | 改动 | 说明 |
|---|---|---|
| R3-1 | **浏览器构建流水线（不改判：不用打包器）** | 实施中改判为**原生 ESM + import map**：用 Node 24 自带的 `module.stripTypeScriptTypes` 把自家 TS 转成 JS（`.ts` 说明符改写成 `.js`），`pi-agent-core/dist` 与 `pi-ai/dist/utils/*` 复制到 `public/browser/vendor/`，`partial-json`（CJS）在构建期机械转 ESM，`typebox` 改为自写 JSON Schema 子集；`public/index.html` 加一段 `<script type="importmap">` 把 `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core` / `typebox/*` / `partial-json` 指向 vendor 目录。**不引入任何 npm 依赖**，保住项目「零构建」风格（详见进度日志「R3-1 打包方案改判」）。 |
| R3-2 | 打包 `src/ai/*` | 浏览器版**绕开 pi-ai 根入口与 api 适配器**（它们会拖进 42 个 provider 与 4 个 SDK）。做法：① 模型目录改成构建期导出的 `catalog.json` 纯数据；② `src/ai/models.ts:3-43` 的 42 个静态 provider import 在浏览器侧不加载（`amazon-bedrock` 尤其必须剔除，它带 `@aws-sdk/client-bedrock-runtime`）；③ `src/ai/custom-provider.ts:3-6` 静态 import 的四个适配器同理绕开，改由自写的浏览器 LLM 客户端按 `API_FORMATS` 直连（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`）；④ `src/ai/tools.ts:1` 与 `web-search.ts:2` 的 `import { Type } from "@earendil-works/pi-ai"` 由 shim 顶上。 |
| R3-3 | `deps.store` 换实现 | `tools.ts` 的 17 个工具**一行逻辑都不用改**，只把 `deps.store` 从 `ProjectStore` 换成 `IdbProjectStore`（R0-2 的接口保证两者可互换）。 |
| R3-4 | 上下文构建搬浏览器 | `buildWritingContext`（`main.ts:281-312`）读两章正文；`buildWritingSystemPrompt`（`prompts.ts:388-517`）把**本章全文 + 素材全文（≤12 KB）+ 摘要（≤24 KB）**内联进 system message。搬浏览器后这些数据本来就在本地，连读取都不需要。 |
| R3-5 | `transformContext` | `novel-agent.ts:238-247` 每轮重读 `store.get(projectId)` 注入 `<工程状态更新>` 摘要——浏览器版变成读本地内存/IndexedDB，反而更快。 |
| R3-6 | 提问（ask_user） | 服务端 `AskBroker`（`src/server/ask.ts`，10 分钟超时）在浏览器版变成本地模态框 + Promise。NDJSON 协议里 `question` / `question_closed` 两个事件（`ask.ts:16-28`）形状不变。 |
| R3-7 | 验收口径 | `main.ts:661-667` 的 `requiredTools` + `main.ts:722-729` 的 `revision` 比对（判断"这一稿真的存上了"）本来是服务端读用户数据——必须搬到浏览器侧。 |

### R4 · 可选增强

| # | 改动 | 说明 |
|---|---|---|
| R4-1 | **导出 / 导入**（`.novel` zip） | 浏览器数据会因清缓存/换设备丢失。必须给一条明确的带走路径：工程 + 正文 + 历史 + 快照 + 素材库 + 设置（**不含 Key**）。 |
| R4-2 | **访客口令加密** | 共享电脑场景。用 WebCrypto PBKDF2 → AES-GCM 加密 `credentials` 表（至少 Key 表）。这是 R4-1 的自然延伸。 |
| R4-3 | **零知识同步**（可选） | 若要跨设备：服务端只存客户端加密后的密文，密钥永不离开浏览器（"零知识"）。**注意这与"数据不保存到服务器"有张力**——服务器存的是密文而非用户数据，但仍是"服务器上有东西"。做成显式可选项，默认关。 |
| R4-4 | 配额与持久化 | `navigator.storage.persist()` 申请持久化配额，避免浏览器在磁盘紧张时清掉 IndexedDB；`navigator.storage.estimate()` 给用户看占用。 |

---

## 4. IndexedDB 表结构

DB：`novel-studio`，version 1。

| object store | keyPath | 索引 | 对应现在的落点 |
|---|---|---|---|
| `projects` | `id` | `updatedAt` | `data/<pid>.json` |
| `draftMetas` | `[projectId, chapterId]` | `projectId` | `data/drafts/<pid>/<enc>.meta.json` |
| `draftBodies` | `[projectId, chapterId]` | `projectId` | `data/drafts/<pid>/<enc>.txt` |
| `draftHistory` | `[projectId, chapterId, revision]` | `[projectId, chapterId]` | `data/drafts/<pid>/<enc>.hist/<rev>.json` |
| `snapshots` | `[projectId, id]` | `projectId` | `data/snapshots/<pid>/*.json.gz` |
| `trash` | `projectId` | — | `data/trash/<pid>/` |
| `materials` | `id` | `kind` | `data/library.json` |
| `kinds` | `id` | — | `data/kinds.json` |
| `records` | `id` | `scopeKey`、`createdAt` | `data/records.json` |
| `settings` | `key`（单行 `'settings'`） | — | `data/settings.json` |
| `credentials` | `providerId` | — | `data/credentials.json` |
| `uploads` | `id` | `projectId` | 解析后的纯文本（原文件不留） |

要点：
- **`draftMetas` / `draftBodies` 分表**——与服务端"一章一文件组、正文与元数据分开"（`project.ts:821-843`）的意图一致，也让"按需取正文"（`app.js:2503` `ensureChapterBody`）变成一次索引读，不拖整本书。
- `records.scopeKey` 沿用服务端口径 `role:library|projectId:chapterId`（`records.ts:123-125`），`RECORDS_KEEP=10` 的分桶清理（`records.ts:282-300`）在浏览器照搬即可。
- `settings` / `credentials` / `kinds` 是**每浏览器一份**——这就是"多用户隔离"的全部实现。服务端不再有对应文件。
- 正文列族（chapter 正文）单独一表后，百万字工程只占索引，内存压力小。

---

## 5. 迁移与兼容

| 场景 | 处理 |
|---|---|
| 现有单用户 `data/` 想搬到浏览器 | 提供一次性导入：浏览器读一份导出的 `.novel` 包（或后端临时开一个 `/api/import` 只跑一次）。**导入完必须关掉该端点。** |
| 老的 `data/drafts/<pid>/*.json.migrated` 遗留物 | 导入时忽略并删除 |
| 旧的非 gzip 快照 | 导入时用 `DecompressionStream` 兼容读或直接跳过（它们是"删素材前快照"这类一次性产物） |
| 前端 localStorage 6 键 | 保留原样，不迁移、不清空（纯 UI 偏好） |
| 单机自用模式 | **保留**：服务端继续支持 `data/` 模式，通过环境变量 `STORAGE=fs\|idb` 切换。这样 R1 的改动不会让原有用法报废，也能作为 A/B 对照。 |

---

## 6. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **浏览器数据会丢**（清缓存、换设备、无痕模式） | R4-1 导出/导入必做；`navigator.storage.persist()`；首屏提示用户定期导出 |
| 2 | 引入打包器，偏离项目"零构建"风格 | **已改判规避**：R3-1 改用原生 ESM + import map，零 npm 依赖（见进度日志「R3-1 打包方案改判」） |
| 3 | 直连供应商的 CORS 不稳定 | §1.4 白名单只放实测通过的；其余走 R2 中继 |
| 4 | 密钥在浏览器里（XSS 可窃取） | 只存**用户自己的** Key（用户知情）；共享 Key 绝不进浏览器（R2-C 模式）；CSP 收紧 |
| 5 | 中继仍能看到明文 prompt | 这是"中继模式"的固有性质，如实告知用户；提供直连模式（A）作为更强选项 |
| 6 | 长任务绑标签页 | 现状生成本来就在标签页里；不要为了"后台跑"引入服务端持久化——那会破坏"数据不上服务器" |
| 7 | IndexedDB 容量上限 | 快照是最大的（单章书可达 200 KB+）；沿用 `MAX_SNAPSHOTS=20` 上限；正文/历史不做全量缓存 |
| 8 | 运营方共享 Key 被刷 | R2-C 的 8 件套；在 8 件套齐备前，**关闭共享 Key 模式** |
| 9 | 回归写入 `data/` | R2-6 的 CI 断言 + 启动断言 |

---

## 7. 工作量估算（单人）

| 阶段 | 内容 | 人日 |
|---|---|---|
| R0 | 拆 store、抽接口、抽路由层、crypto 替换 | 2–3 |
| R1 | 6 个 IndexedDB store + 浏览器路由 adapter + 前端切换 + 上传解析 | 5–7 |
| R2 | 无状态中继、BYO Key、限流、白名单、部署面 | 2–3 |
| R3 | 浏览器构建（原生 ESM + import map）+ agent 进浏览器 + 上下文/ask 搬运 | 3–5 |
| R4 | 导出/导入、加密、持久化配额 | 2–3 |
| | **合计（不含 R4）** | **12–18** |
| | **合计（全量）** | **14–21** |

测试脚本基本可复用：`test:storage`（换成 fake-indexeddb 跑 `IdbProjectStore`）、`test:tools`、`test:loop`（传 `IdbProjectStore`）、`test:frontend`（契约测试）。

---

## 8. 已拍板的四项决策（2026-10-31 用户确认）

| # | 议题 | **决定** | 影响 |
|---|---|---|---|
| 1 | **密钥模式** | **B — 用户自带 Key** | 服务端**不落盘、不持共享 Key**。用户 Key 存浏览器 IndexedDB，请求时随行发给无状态中继；运营方不付 token 费。**仍需做 R2-3 白名单与 R2-4 限流**（否则中继成为开放代理）。R2-C 的 8 件套**不需要**做，共享 Key 模式不开。 |
| 2 | **Agent 位置** | **R1-a — 浏览器内跑** | 隐私最强：服务端看不到明文 prompt。引入**浏览器构建流水线**（R3-1，原生 ESM + import map，不引打包器），产出 `public/browser/**`。`tools.ts` 17 个工具**零改动**，只换 `deps.store` 实现（R3-3）。服务端最终只剩「静态托管 + `POST /api/llm` 转发」约 150 行。 |
| 3 | **跨设备** | **不要云同步，只要导出/导入** | **R4-3 零知识同步不做**（它与「服务器上什么都没有」有张力）。只做 R4-1 `.novel` 导出/导入包 + R4-2 访客口令加密（WebCrypto PBKDF2 + AES-GCM，保护共用电脑场景下的 Key 表）。 |
| 4 | **单机自用模式** | **保留**（默认） | 用环境变量 `STORAGE=fs\|idb` 切换。默认 `fs` 保持现有单机体验；多用户部署时 `STORAGE=idb`。原有用法不报废，也能作为 A/B 对照。 |

### 由决策确定的落地顺序

```
R0（无悔）──► R1（IndexedDB + 浏览器路由）──► R3（agent 进浏览器，浏览器构建流水线）
                    └──► R2（无状态中继 + BYO Key + 限流）
                                        └──► R4-1/4-2（导出/导入 + 口令加密）
```

关键依赖：
- **R1 必须先于 R3**——`IdbProjectStore` 是 agent 进浏览器的前提。
- **R2 可以与 R1/R3 并行**——中继是独立的小模块，且 R2-2（BYO Key 的 `getApiKey` 注入）在 R1 之后立刻可用。
- **R0-2（存储端口接口）是 R1 和 R3 的共同前提**——必须第一步做，否则 R1 与 R3 都要返工。
- **R3-1（浏览器构建流水线）建议与 R1 同批引入**——避免"先手写一遍原生 JS，再改成构建产物"的双重返工。

> 部署形态与运维细节见 **`docs/deployment.md`**（两种形态对比、环境变量、systemd/nginx、中继安全底线、用户使用说明）。

### 实施进度日志

#### R0-1 拆分存储层（已完成 ✅）

理由：这是整个任务里**投入产出比最高的一刀**，且是 R1/R3 的共同地基。

现状问题：`src/store/project.ts`（原 1696 行）把「纯数据模型」和「磁盘 IO」混在一起，顶部 `import { randomUUID } from "node:crypto"` / `node:fs/promises` / `node:path` / `node:zlib` 污染整个模块，导致：
- `src/ai/prompts.ts` 因为 `import { kindLabel } from "../store/project.ts"` 而间接依赖 `node:fs`；
- `src/ai/novel-agent.ts` 因为 `import { assembledMaterials } / { linkMaterials } / { MAX_DRAFT_HISTORY }` 而同样被污染；
- `src/store/kinds.ts:4` 从 `project.ts` 引 `MATERIAL_KINDS`；
- ⇒ 浏览器 bundle 会把 `node:fs` 拖进去，打包直接失败。

**实际采用的拆分方向与初稿不同**：没有新建 `project-model.ts`，而是**让 `project.ts` 保留原路径当纯模型层**，磁盘层另起 `project-disk.ts`。理由：① `prompts.ts` / `tools.ts` / `library.ts` / `kinds.ts` 的 import 行**一行都不用改**；② 只有 `type ProjectStore` 的引用需要改成 `import type`（类型导入会被完全擦除，不产生运行时依赖）；③ 输出更小、回归风险更低。

| 文件 | 内容 | 依赖 |
|---|---|---|
| `src/store/project.ts`（瘦身后） | 全部 types（`ChapterStatus`…`ProjectStats`）+ 纯函数（`encodeFileName`、`MATERIAL_KINDS`、`kindOptions`、`kindLabel`、`countWords`、`emptyProject`、`normalizeProject`、`assembledMaterials`、`linkMaterials`、`projectStats`、`draftMeta`、`migrateLegacy`、`extractLegacyDrafts`、`registerCustomKinds`）+ 新增 `newId()` | **零 node 内建** |
| `src/store/project-disk.ts`（新） | `ProjectStore` 类 + 磁盘读写 + `writeAtomic` + 快照 + 回收站 | node:fs / node:path / node:zlib |
| `src/store/store-port.ts`（新） | `ProjectStorePort` 接口——「浏览器必须重写的一切」的单一清单 | 纯类型 |

> **`newId()` 的必要性**：`crypto.randomUUID()` **只在安全上下文可用**，纯 HTTP 部署（无 TLS 的内网试用）会是 `undefined`。`newId()` 先试 `globalThis.crypto.randomUUID()`，不可用时退回 `getRandomValues` 拼 UUIDv4。所有生成 id 的地方（工程/章节/素材/记录/临时文件名）统一走它。

**R0-4 / R0-5 配置与存储拆分（已完成 ✅）**：同一手法扩展到其余五个模块，各自拆成「纯层（原路径，浏览器安全）+ 磁盘层（`*-disk.ts`，保留原类名）」：

| 模块 | 纯层 | 磁盘层 | 端口 |
|---|---|---|---|
| 素材库 | `src/store/library.ts` | `library-disk.ts` → `MaterialLibrary` | `LibraryStorePort` |
| 素材种类 | `src/store/kinds.ts` | `kinds-disk.ts` → `KindStore` | `KindsStorePort` |
| 应用设置 | `src/config/settings-store.ts` | `settings-disk.ts` → `SettingsStore` | `SettingsStorePort` |
| 厂商密钥 | `src/config/credential-store.ts` | `credential-disk.ts` → `FileCredentialStore` | `CredentialStorePort` |
| 生成记录 | `src/server/records.ts` | `records-disk.ts` → `RecordStore` | `RecordStorePort` |

纯层末尾保留同名 type alias（`export type MaterialLibrary = LibraryStorePort;` 等），使 `src/ai/**` **一行未改**即编译通过。静态 `open(dataDir)` 不入端口（浏览器实现自行定义打开方式），与 `ProjectStorePort` 一致。

**R0-6 修复回收站恢复的既有 bug（已完成 ✅）**：`public/app.js` 的「恢复到案头」按钮调用了**不存在的** `loadProjects()`（真函数是 `reloadProjects()`），恢复成功后立刻 ReferenceError 并被 `catch` 吞掉，案头列表不刷新。已改为 `await reloadProjects(); await reloadLibrary(); renderView();`。

**验证**：`pnpm typecheck` + `test:config` / `test:storage` / `test:tools` / `test:loop` / `test:server` / `test:context` / `test:frontend` 全部 EXIT=0；grep 确认五个纯层文件 `node:` 命中数为 0。

#### R0-2 抽出路由层（已完成 ✅）

**目标**：让同一批 handler 既能跑在 Node `http` 上，也能跑在浏览器的 `fetch` 上——这是「同一份 AI 编排代码两个地方都能用」的前提。

`src/server/api-router.ts`（新）把 `handleApi()` 里的 51 个路由原样搬过来，依赖全部从外面递进来：

```ts
export interface ApiRequest {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  json<T>(): Promise<T>;
  raw(limitBytes?: number): Promise<Uint8Array>;
}
export interface ApiSink {
  writeHead(status: number, headers?: Record<string, string | string[] | undefined>): void;
  setHeader(name: string, value: string | string[]): void;
  write(chunk: string | Uint8Array): void;
  end(chunk?: string | Uint8Array): void;
  readonly headersSent: boolean;
  readonly ended: boolean;
  readonly destroyed: boolean;
  onClose(handler: () => void): () => void;
  onError(handler: () => void): () => void;
}
export type ApiRouter = (req: ApiRequest, sink: ApiSink) => Promise<void>;
export interface ApiRouterDeps { /* 六个存储端口 + sessions + config + env + recordsKeep + newId + ask 通道 + models 门面 */ }
```

关键设计：**依赖全部走 `ApiRouterDeps` 递进来，一个字段都不留在模块里**。磁盘版与浏览器版递进来的东西形状一样，只是底下换成 IndexedDB 而已。会话表 `sessions` 与写作轮次登记表 `WriteRunRegistry` 都是**路由器实例自带**（不是模块级单例），浏览器端那个实例与 Node 端那个互不相干，各自记着自己那一侧正在写哪一章。

node 侧的适配器把 `IncomingMessage` / `ServerResponse` 包成 `ApiRequest` / `ApiSink`；浏览器侧把 `Request` / `Response` 包成同样的两个东西（流式用 `ReadableStream`，`writeHead` 先于 `write`，所以可以先拿 header 再构造 `Response`）。

**验收口径**：51 个路由的语义、状态码、响应体**必须字节级不变**——`test:server` 全绿即达标。

#### R2 无状态 LLM 中继（已完成 ✅）

`src/server/llm-relay.ts`（新）。**为什么需要**：运营方不能把自己的 key 放前端（前端发的东西访客在 DevTools 都看得到）；但很多厂商的浏览器直连（CORS）并不成立，见 §1.4 实测表。中继是「用户自带 key + 服务器只当一跳」——key 只在转发那一瞬间存在于内存，不落盘、不进日志。

**SSRF 五道关**（中继拿着用户给的 `baseUrl` 去发请求，等于把服务器变成跳板，必须堵死）：
1. URL 里带 `user:pass` 直接拒；
2. 协议必须 https（http 只放行名单内主机）；
3. `allowedHosts` 非空时主机必须在名单里（**部署时建议写具体厂商主机名清单**，留空等于允许任意公网主机）；
4. 端口只放 443/8443（名单内可另开）；
5. `dns.lookup(host,{all:true,verbatim:true})` 解析后，**每一个**返回地址都必须是公网地址——任一个是内网就整体拒；解析不出按不安全处理。

解析通过后用 `lookup` 覆写把连接**钉死**在刚校验过的那个 IP 上（保留 servername），杜绝 **DNS rebinding**。**3xx 不跟随**（透传但剥掉 `location`）。

**拒绝的地址段**：IPv4 `0/8 10/8 127/8 169.254/16`（含云厂商元数据 `169.254.169.254`）`172.16/12 192.168/16 100.64/10 224/4 240/4` + 文档段 `192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24`；IPv6 `:: ::1 fc00::/7 fe80::/10 fec0::/10 ff00::/8 100::/64 2001:db8::/32 ::ffff:0:0/96 64:ff9b::/96 2002::/16 2001:0::/32`。

**其余**：按来源 IP 的令牌桶限流（默认 60 次/分）+ 全局并发上限（默认 16）；状态码 400/413/429/503/502/504；上游响应头剥掉 `set-cookie`/`location`/`authorization`/`cookie`/`content-length`/`date`/`server` 及任何匹配 `/authorization/i`、`/api[-_]?key/i`、`/secret/i` 的头；审计行只有 `时间 client=<哈希> host=<上游主机> path=<仅 pathname> status=<码> ms=<耗时> bytes=<字节数>`，**key / 请求头 / 请求体 / 响应体一概不入日志**；模块内无 `node:fs`；OPTIONS 预检直接 204，不碰上游、不耗额度。

**测试**：`scripts/relay-check.ts` 71 项全过（正常转发 / SSRF 22 项 / 上限与错误码 / 限流并发 / 流式 / CORS / 不留痕），含「`data/` 目录一个字节没变」断言。

#### R3-1 打包方案改判：不用打包器（已定案 ✅）

初稿写的是引入 esbuild。实施中改判为**原生 ESM + import map**，理由：

1. **本机装不了新依赖**——`pnpm install` 在无 TTY 的沙箱里直接失败（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），esbuild / fake-indexeddb 都装不上；
2. **保住项目「零构建」风格**——`public/` 至今是原生 JS、无打包步骤，引入 bundler 会改变整个项目的工程习惯；
3. **技术上完全可行**——`pi-agent-core@1.2.0` 的 dist 里**零 node 内建依赖**，只有一个裸说明符 `"@earendil-works/pi-ai"`，而 pi-ai 恰好导出了 `./utils/*` 深路径，正好能用 import map 指过去。

具体做法：

| 步骤 | 做法 |
|---|---|
| 转译 | Node 24 自带 `module.stripTypeScriptTypes()`，零依赖把自家 TS 转 JS，import 说明符 `.ts` → `.js` |
| vendor | 复制 `pi-agent-core/dist/*.js` 与 `pi-ai/dist/utils/{event-stream,transcript,text,json-parse,validation}.js` 到 `public/browser/vendor/` |
| pi-ai shim | 自写 `src/browser/shim/pi-ai.ts`：re-export 上面那些 utils helper + 自写 `Type`（`Object/String/Number/Boolean/Array/Union/Literal/Optional`，`Optional` 用 `Symbol.for("TypeBox.Optional")` 标记，`Type.Object` 必须输出 `required:[...]`）+ `Compile`/`Value`（JSON Schema 子集：type/properties/required/items/anyOf/oneOf/allOf/const/enum/minimum/maximum/minLength/maxLength/minItems/maxItems） |
| typebox | **不发布**（整个包 691 个 .mjs / 865KB），改用上面自写的子集；`validation.js` 原样复用不重写 |
| partial-json | CJS，在构建期机械转 ESM |
| 模型目录 | 构建期在 Node 侧跑 `models.ts`，导出 `public/browser/vendor/catalog.json`（纯数据，浏览器直接读） |
| import map | `@earendil-works/pi-ai` → `/browser/vendor/pi-ai/shim.js`；`@earendil-works/pi-agent-core` → `/browser/vendor/pi-agent-core/index.js`；`typebox/compile`、`typebox/value`、`partial-json` 各自落到 vendor 目录 |

**为什么 shim 只需 12 个名字**：`pi-agent-core` 从 pi-ai 实际用到的只有 `EventStream`、`getCurrentTools`、`getToolStateChanges`、`normalizeContext`、`toToolDeclaration`、`validateToolArguments`、`createInitialSystemMessage`、`getCurrentSystemMessage`、`getCurrentSystemPrompt`、`createAssistantMessageEventStream`、`parseStreamingJson`，全部住在 `pi-ai/dist/utils/` 里且不碰 node 内建。

**为什么浏览器不碰 pi-ai 根入口**（**此处初稿的判断是错的，已更正**）：初稿以为 `pi-ai` 的根入口会带出全部 42 个 provider 与 `openai` / `@anthropic-ai/sdk` / `@google/genai` / `@aws-sdk/client-bedrock-runtime` 四个 SDK。逐文件核实后的实情是：

- `pi-ai/dist/index.js` 只有 23 行，导出 `typebox` 的 `Type`、若干 `utils/*` 与 `models.js`，**不含任何 provider、不含任何 SDK**；整条闭包里的裸说明符只有 `typebox`、`typebox/compile`、`typebox/value`、`partial-json`，**零 node 内建**。
- `pi-ai/dist/models.js`（`createModels` / `createProvider` / `MutableModels`）的 import 全是相对路径，递归下去同样零 node 内建、零 SDK。
- 那 42 个 provider 的静态 import **在我们自己的 `src/ai/models.ts:3-43`**，不在 pi-ai 里。

⇒ 结论反转：**pi-ai 的根入口与 models 入口在浏览器里原样可用**，只要浏览器侧不引 `src/ai/models.ts`。于是 `src/ai/novel-agent.ts`（只对 models.ts 有 `import type`）在浏览器里可以直接用真的 `createModels`，不必自造 provider 门面。真正需要绕开的只有 `src/ai/custom-provider.ts`（它 static import 四个 pi-ai api 适配器，那四个适配器才拖出四个 SDK）——浏览器侧改用自带的 `llm-client.ts` 按 `API_FORMATS` 直连。

> **连带的设计调整**：既然根入口可用，shim 只需 re-export `Type` 与 `utils/*` 那几个 helper，不必自写 `Type`；但 `typebox` 仍然**不发布**（整个包 691 个 .mjs / 865KB），只把 `Type` 与 `Compile`/`Value` 的 JSON Schema 子集自写一份。

**前端几乎不用改**：`public/boot.js`（经典脚本，必须早于 `app.js` 执行）在检测到 `indexedDB` 存在且 URL 带 `?local=1`（或 `localStorage` 的 `novel-studio/mode === "local"`，或页面里已被注入 `window.__NOVEL_LOCAL_MODE__ = true`）时，用 `window.fetch` 拦截 `/api/*`（`/api/llm` 除外）转给本地路由 ⇒ `public/app.js` 与 `public/settings.js` **一行不改**。

#### R1/R3 接线完成：同一份路由跑在 IndexedDB 上（已完成 ✅）

到这一步，"浏览器即应用"不再是设计图，而是可运行的代码：

| 文件 | 角色 |
|---|---|
| `src/server/api-router.ts` | 那 51 个接口本身，与传输/存储完全无关 |
| `src/server/node-http.ts` | 把 Node 的 `IncomingMessage`/`ServerResponse` 翻成 `ApiRequest`/`ApiSink` |
| `src/server/fetch-api.ts` | 把浏览器的 `Request`/`Response` 翻成同一对接口 |
| `src/browser/local-api.ts` | **浏览器侧的装配处**：`IdbProjectStore` + `openIdbStores()` + `createBrowserModels()` + `createApiRouter()`，导出 `handle(input, init)` |
| `src/browser/models.ts` | 浏览器侧模型门面：读构建期的 `catalog.json`，按设置与凭据算出可用模型、解析 `provider/modelId`、提供 `streamSimple` |
| `src/ai/llm-client.ts` | 浏览器原生 LLM 客户端（四种接口格式），可直连、也可经 `/api/llm` 中继 |

验收方式是一条**不需要浏览器的端到端脚本** `scripts/local-api-check.ts`（`pnpm test:local`，49 项）：
在 Node 里用假的 IndexedDB + 假的 `fetch`（只认 `catalog.json`，其它出网一律抛错）跑真实路由，
依次验证启动、工程与正文、设置与密钥、上传解析、回收站、**换一个模块实例后数据仍在**、
以及 `.novel` 备份包的导出→导入往返。它能证明"除了读一次模型目录，页面不发任何网络请求"。

#### 备份通道：`.novel` 导出/导入（已完成 ✅）

"数据只在你浏览器里"如果没有出口，就等于数据丢失陷阱 —— 换机器、换浏览器、清一次站点数据就没了。
所以本轮补上了两个接口与一个界面：

| 位置 | 说明 |
|---|---|
| `GET /api/novel/export` | 查询串 `project` / `passphrase` / `credentials=1` / `compress=0`；返回 `application/octet-stream`，默认 gzip（头两字节 `1f 8b`） |
| `POST /api/novel/import` | 请求体就是文件字节（不走 multipart），查询串 `passphrase` / `onConflict=skip\|replace\|rename`；导完立刻 `flush()` |
| 界面 | 「备份与恢复」对话框：总目页的「备份」按钮、命令面板的「备份与恢复 / 导入备份」 |

加密用 PBKDF2-HMAC-SHA-256（210000 轮）+ AES-GCM-256；**密钥默认不进包**，要连密钥一起带走必须给口令，
且只能整库导出。单部作品导出永远不含设置与密钥。

> 已知偏差：方案初稿写的是 `.novel` 用 zip 容器。实施时改为 **gzip 信封 + JSON**（`compress:false` 时就是人眼可读的 JSON）——
> 写 zip 需要一个压缩库或手写中央目录，而这里既不想加依赖，也不需要随机读取单个条目。

#### 还剩什么

| 事项 | 状态 |
|---|---|
| `public/browser/**` 构建产物 | 代码侧全部就绪（`pnpm build:browser` 输出 40 个文件 / 约 1.16 MB）。**必须在部署机自己的终端里跑一次**生成；本会话的沙箱不允许子进程往 `public/` 写文件 |
| `STORAGE=idb` 时自动进入本地模式 | ✅ 服务端在 `/index.html` 里注入 `window.__NOVEL_LOCAL_MODE__ = true`，用户不必自己拼 `?local=1` |
| 真实浏览器 E2E | 未跑。本会话的沙箱起不了 Chrome（mojo 命名管道被禁），以 `scripts/local-api-check.ts` 代替 |
| `src/store/novel-crypto.ts` | 保留但边缘化：正式入口是 `novel-package.ts` 的 `exportNovel({ passphrase })`，`novel-crypto.ts` 只服务于旧的兼容层 |
| 单机自用模式 | ✅ `STORAGE=fs`（默认）行为与改造前完全一致，`pnpm test:*` 覆盖 |
| 构建产物已生成（2026-10-31 用户要求改内置中转与加链接之后复跑） | ✅ `pnpm build:browser` 通过，输出落 `.dsh-tmp/browser`；拷进 `public/browser/` 仍需在沙箱外做一次 |

#### 内置推荐中转与源码入口（已完成 ✅）

两件事，都不是本方案引入的问题，但顺手做了：

1. **CTTAI 中转本来就内置**（`src/ai/models.ts:155`，`BUILTIN_PROVIDERS[0]`，`group: "推荐"`，9 个模型，接入点 `https://llmapi.cttai.art/v1`）。原文里出现在「自定义供应商」分组下，是因为 `syncBuiltinProviders()` 只补"缺失的 id"——早先手工配过同 id 自定义条目的人，内置那条根本补不进来，界面看着就不像推荐项。
   现在 `syncBuiltinProviders()` 先跑一遍 `promoteMatchingCustoms()`：**id 与接入点都对得上**内置条目的自定义项就地改回 `kind: "builtin"`，`label` 只在还是 id 原文时才换成内置展示名（改过名的不动），已存密钥（按 provider id）与模型参数覆盖（按 model id）都不受影响。浏览器侧 `syncBuiltinProvidersFromCatalog()` 同一套规矩。
   幂等：收编后 `promoteMatchingCustoms()` 返回原数组，`syncBuiltinProviders()` 因此仍能走"没变化就直接返回"的短路。`scripts/config.ts` 新增 7 项断言（`自定义条目收编为内置`）。
2. **GitHub 入口**：案头页脚常驻一行（`public/index.html` 的 `.bench-foot`，样式在 `public/style.css` 的 `.bench.bench-three` 之后），命令面板加「GitHub 仓库」一项（`public/app.js` 的 `openRepository()`，用 `window.open` 而不是整页导航）。地址 `https://github.com/cttailearn/novel-studio`，同时补进 `package.json` 的 `repository/homepage/bugs/license` 与 README。

---

## 附：相关外部资料

- CORS 实测指南（含 14 个 LLM API 的浏览器可用性）：https://cors.dev/guides/free-ai-api
- Anthropic 浏览器直连所需的请求头：https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
