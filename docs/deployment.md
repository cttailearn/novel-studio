# 部署指南：多用户版（数据全在浏览器）

> 配套文档：[多用户改造方案](./multi-user-browser-local-plan.md)
>
> 这份文档描述**把墨耕部署成一个公开服务、且用户数据完全不落服务器**的形态。

---

## 0. 一句话

服务端只做两件事：**把静态页面发给浏览器**、**在必要时做一次无状态的 LLM 转发**。
工程、正文、素材、素材库、生成记录、设置、API Key —— 全部只存在每个用户自己的浏览器里（IndexedDB）。

---

## 1. 两种运行形态

| | 单机自用（默认） | 多用户（`STORAGE=idb`） |
|---|---|---|
| 数据在哪 | 服务端 `data/` 目录 | **用户浏览器** |
| 谁能看到别人的稿子 | 不存在这个问题 | 谁也看不到谁的（服务端没有稿子） |
| API Key 放哪 | 服务端 `data/credentials.json`（明文） | **用户浏览器**（IndexedDB），服务端不落盘 |
| 出网方式 | 服务端直接调供应商 | 浏览器直连（CORS 通不过时走中继） |
| 适合 | 作者自己用、离线内网 | 公网开放给多个人用 |

`STORAGE` 环境变量切换：

```bash
STORAGE=fs    # 默认，单机自用，行为与改造前完全一致
STORAGE=idb   # 多用户模式
```

---

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。**对外服务必须改成 `0.0.0.0`**（或只让反向代理访问） |
| `DATA_DIR` | `./data` | 服务端数据目录。`STORAGE=idb` 时**不再写入用户数据**，可以指向一个空的、最好只读的目录 |
| `STORAGE` | `fs` | `fs` = 服务端落盘；`idb` = 数据只留浏览器 |
| `DEFAULT_MODEL` | 空 | 默认模型 `provider/modelId` |
| `DEFAULT_THINKING_LEVEL` | `off` | 默认思考强度 |
| `CORS_ORIGINS` | 空 | 中继允许的浏览器直连来源，逗号分隔。留空 = 只允许同源 |
| `DEEPSEEK_API_KEY` | 无 | 只在运营方自用联网搜索时需要；**多用户模式下不要设** |

> `.env.example` 里的 `MAX_TOKENS` / `TEMPERATURE` / `AI_GATEWAY_API_KEY` 是历史遗留的死配置，代码里没有读取点，可以删掉。

---

## 3. 多用户模式下服务端到底持有什么

**不持有**（这是本改造的全部意义）：

- ❌ 任何工程骨架、章节正文、草稿历史、快照
- ❌ 素材库、素材种类、生成记录
- ❌ 用户的应用设置
- ❌ **任何人的 API Key**

**只持有**：

- ✅ 静态资源（HTML / CSS / JS / 浏览器产物）
- ✅ 模型目录快照（构建期从 `pi-ai` 导出成静态 JSON）
- ✅ 一次转发请求的**瞬时内存**（转发完即丢，不写盘、不记正文）

**部署自检**：多用户模式下 `data/` 应当保持为空。启动时若发现 `data/` 里有工程文件，说明存储模式配错了 —— 要么改 `STORAGE=idb`，要么先在单机模式里导出 `.novel` 包再清空。

---

## 4. 进程形态

```bash
# 一次性：装依赖
pnpm install

# 构建浏览器端产物（把 src/ 里浏览器可用的那部分转译成原生 ESM + 写 import map + 模型目录）
# 这一步必须在部署机自己的终端里跑：产物要写进 public/browser/
pnpm build:browser

# 启动
HOST=0.0.0.0 PORT=8787 STORAGE=idb CORS_ORIGINS=https://novel.example.com node --experimental-strip-types src/server/main.ts
```

> **漏了 `pnpm build:browser` 会怎样**：页面能打开，但每个 `/api/*` 都失败 ——
> 浏览器里那套接口是构建产物，不是源码。启动日志会直接点名提醒。

systemd 示例 `/etc/systemd/system/novel-studio.service`：

```ini
[Unit]
Description=Mo Geng novel studio (multi-user)
After=network-online.target

[Service]
Type=simple
User=novel
WorkingDirectory=/srv/novel-studio
Environment=HOST=0.0.0.0
Environment=PORT=8787
Environment=STORAGE=idb
Environment=CORS_ORIGINS=https://novel.example.com
Environment=NODE_OPTIONS=--experimental-strip-types
ExecStart=/usr/bin/node src/server/main.ts
Restart=on-failure
# 多用户模式下服务端不写盘；把 data/ 挂成 tmpfs 更保险
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

---

## 5. 反向代理与 TLS

**TLS 不是可选项**：`crypto.subtle`（口令加密）与 `crypto.randomUUID()` 都**只在安全上下文可用**。
用 http:// 访问一个局域网 IP 时，`crypto.subtle` 是 `undefined`，`crypto.randomUUID()` 也是 `undefined` —— 口令加密功能会直接报「当前环境不是安全上下文」。

nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name novel.example.com;

    ssl_certificate     /etc/letsencrypt/live/novel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/novel.example.com/privkey.pem;

    # 注意：不要用 root 直接把 public/ 发出去。
    # 应用在 idb 模式下会往 index.html 里注入本地模式标记，绕过它页面就打不开数据，
    # 所以静态文件也统一反向代理给应用。
    gzip on;
    # 必须包含 text/javascript：Node 对 .js 发的就是它，
    # 只写 application/javascript 的话 app.js / settings.js 一个都不会被压缩。
    gzip_types text/javascript application/javascript application/json application/manifest+json image/svg+xml text/css;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name novel.example.com;
    return 301 https://$host$request_uri;
}
```

---

## 6. 中继：什么时候需要它

浏览器直连供应商是最省事的方式，但受 CORS 限制。实测结论（2026-10 复核）：

| 供应商 | 浏览器直连 | 备注 |
|---|---|---|
| Google Gemini | ✅ | |
| Groq / OpenRouter / Mistral / Cohere | ✅ | |
| DeepSeek | ✅ | |
| Together / xAI / HuggingFace router | ✅ | |
| **Anthropic** | ⚠️ | 必须加请求头 `anthropic-dangerous-direct-browser-access: true`，否则预检 400 |
| **OpenAI / Cerebras** | ⚠️ | 预检能过，但错误响应不带 `Access-Control-Allow-Origin`，前端会看到 "Failed to fetch" |
| Cloudflare Workers AI | ❌ | OPTIONS 返回 405 |
| Ollama | ⚠️ | 默认只放行 localhost 原点 |

**需要中继的场景**：
1. 供应商不允许浏览器直连（OpenAI、Anthropic 之外的部分场景）；
2. 想统一出网、只放行少量主机（出网白名单）。

**中继的安全底线**（`src/server/llm-relay.ts`）：

- **必须是 HTTPS**，且**解析 DNS 后逐个校验 IP** 不落在私有段 / 回环 / 链路本地 / 云元数据地址；校验通过后**钉住这个 IP** 发请求，防止 DNS rebinding。
- 拒绝 `user:pass@` 形式的 URL、拒绝非标准端口、**不跟随重定向**。
- 按客户端 IP 做令牌桶限流，另加全局并发上限。
- **不落盘、不记 key、不记正文**；审计日志只记元数据（时间、目标主机、状态码、耗时、字节数）。
- 密钥由浏览器在请求头里临时带来，中继**只转发不保存**。

> ⚠️ **中继看得到明文 prompt。** 这是"用户自带 Key + 服务端转发"模式的固有代价：服务端经手了请求体。
> 对隐私要求最高的人，请让浏览器直连供应商（不需要中继）。

---

## 7. 用户怎么用

`STORAGE=idb` 部署下，**打开站点即进入浏览器本地模式**（服务端会在 `/index.html` 里注入
`window.__NOVEL_LOCAL_MODE__ = true`，`public/boot.js` 见到它就接管全部 `/api/*`）。

- 所有数据存在浏览器 IndexedDB（库名 `novel-studio`；设置/密钥/记录在 `novel-studio-meta`）；
- 在「设置」里填自己的 API Key —— Key 只写进浏览器，不上传；
- 出网方式默认「走中继」；只对 CORS 实测通过的厂商（Gemini / Groq / OpenRouter / DeepSeek …）可改成直连，
  在浏览器控制台设 `localStorage["novel-studio/transport"] = "direct"`。

> 单机自用（`STORAGE=fs`）时页面默认仍走服务端；想在同一台机器上试本地模式，地址后加 `?local=1`。

**换设备 / 备份**：打开「备份与恢复」对话框（总目页右上「备份」按钮，或命令面板搜"备份"），
导出 `.novel` 包，拿到另一台设备上导入。
口令加密导出用 PBKDF2(SHA-256, 210000 次) + AES-GCM；**密钥默认不进包**，要带密钥必须给口令且只能整库导出。

**数据会丢的情况**（必须提醒用户，建议写在站点页脚）：

- 清除浏览器站点数据 / 换浏览器 / 无痕模式 → 数据没了；
- 浏览器存储配额被占满 → 写入失败；
- 只做导出/导入备份，不做云同步。

---

## 8. 运维要点

- **服务端不需要备份用户数据**（数据不在那儿）。要备份的是代码 + `public/browser/**` 构建产物。
- **服务端不需要数据库迁移**（没有数据库）。
- 静态产物变更后需要 `pnpm build:browser` 并重启（浏览器端产物带内容哈希，可以长缓存）。
- 监控：进程存活、中继 5xx 率、中继上游 4xx 率、静态资源 404。
- 升级前端时注意：浏览器里可能缓存着旧版产物；`index.html` 已设为 `no-store`，改动会随下次刷新下发。**但用户 IndexedDB 里的数据不会因为前端升级而丢失**，只要不改变 IndexedDB 的库版本与表结构；改结构时必须提供 `onupgradeneeded` 里的迁移逻辑。

---

## 9. 启动自检清单

```bash
# 1. 多用户模式下 data/ 是空的
ls -la data/ | grep -v '^total' | grep -v '^d' && echo "❌ data/ 里还有东西" || echo "✅ data/ 是空的"

# 2. 环境变量
echo "STORAGE=$STORAGE HOST=$HOST"

# 3. 中继健康检查
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/llm \
     -H 'content-type: application/json' -d '{"target":"http://127.0.0.1/","apiKey":"x"}'
# 期望：拒绝（说明 SSRF 防护生效），而不是 200
```

---

## 10. 附录：外部资料

- CORS 实测指南（含 14 个 LLM API 的浏览器可用性）：https://cors.dev/guides/free-ai-api
- Anthropic 浏览器直连所需的请求头：https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
