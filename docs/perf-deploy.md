# 服务器加载慢：量了什么、慢在哪、怎么修

对 `https://novel.cttai.art`（腾讯云新加坡，`root@43.153.226.239`）与本地开发服务做了分项测量。
结论：**服务端本身很快（每个资源 ~1ms），慢的每一毫秒都花在网络上。**

---

## 一、实测数据

### 1. 链路本身

| 项 | 数值 |
| --- | --- |
| 服务器位置 | 腾讯云**新加坡**（AS132203），`ping` 205ms（204–205ms，0 丢包） |
| TLS 握手 | 0.16–0.45s（单独一次连接） |
| nginx → node | 本机回环，可忽略 |

一个来回就是 205ms。**这是所有公式里的那个常数。**

### 2. 服务器自己有多快（直连 127.0.0.1:8790，不经网络）

- 10 个静态资源逐个取：每个 ~1ms
- 16 个资源并发取：**0.066s**
- 16 个资源经 nginx + gzip 并发取：0.432s

→ 服务器处理不是瓶颈，`serveStatic` 的 `readFile` 也不是。

### 3. 首屏到底拉了什么

清缓存首次访问（Chrome CDP，直连不走代理）：

| 项 | 数值 |
| --- | --- |
| 请求数 | 30（**21 个 JS + 4 个 CSS** + 图标/manifest） |
| transfer | 197 KB（gzip 后），decoded 636 KB |
| 墙钟 | **1973ms**（首次）/ 1341ms（第二次） |
| TTFB | 272–313ms（含 TLS） |
| DCL / load | 746ms / 747ms（近端量）；跨境时按 RTT 折算到 1.3–2.0s |

gzip 是生效的（`/views.css` 90939→17176，`/app/adapt.js` 43240→13847，`/app.js` 17508→5921）。

### 4. 两个真问题（都量到了）

**问题 A：每次打开页面都要挨个回源验 304 —— 25 条 304，每条一个 205ms 往返**

原策略（`src/server/app.ts:367-368`）：

```ts
const cacheable = deploy && !relative.endsWith(".html") && /\.(?:js|css|mjs|svg|json|webmanifest|woff2?)$/i.test(relative);
const cacheControl = cacheable ? "private, max-age=0, must-revalidate" : "no-store";
```

`max-age=0, must-revalidate` 的语义是：**手里有副本也不许直接用，必须先问服务器。**
线上实测第二次、第三次访问都是 `30 请求 / 25 个 304 / 0 个本地缓存命中`，墙钟 1341ms。

浏览器对同一主机的并发有上限，25 个 304 不可能一次发完；它们与 6 个连接的上限、TLS 连接复用交织在一起，实测首屏资源**分 5 波**才到齐（见问题 B 的测量）。这就是「点一下转半天」的手感来源。

**问题 B：ES module 瀑布 —— 4 层 import，浏览器一层层问**

`public/app.js` 静态 import 了 16 个模块，它们又各自 import，最深 4 层（`app.js → adapt.js → dock.js → ctx.js → api.js/core.js`）。共 20 个模块、441 KB 源码。

在 `index.html` 里**没有任何 preload**的情况下实测（205ms RTT，清缓存）：

```
资源 26 个；首个 +232ms，全部到齐 +1614ms
发现波次 5：+240ms×7  +720ms×16  +960ms×1  +1200ms×1  +1380ms×1
```

注意 `+240ms×7` 和 `+720ms×16` 之间的 **480ms 空档**：浏览器拿到第一批（app.js + 它直接 import 的 7 个）之后，才知道还有下一层，于是干等一个往返。之后每层还要再等。

加上 `modulepreload` 之后（同一条件）：

```
资源 26 个；首个 +236ms，全部到齐 +1365ms
发现波次 1：+240ms×26
```

**5 波变 1 波，全部到齐从 1614ms 降到 1365ms（省 249ms）。** 在更慢的移动网络（RTT 300–500ms）上这一项能省半秒以上。

### 5. 顺带排除的嫌疑

- **字体**：`public/style.css:51-53` 全是系统字体栈，无 `@font-face`、无外部字体请求。不是它。
- **服务器负载**：load average 0.00/0.02/0.07，MemoryMax=768M / CPUQuota=150% 都没触顶。
- **本地代理**：走 Clash（127.0.0.1:7897）与直连差异 <2%（`/views.css` ttfb 0.252 vs 0.227）。不是它。
- **接口本身**：`/api/projects` 13.9ms、`/api/projects/:id/adaptation` 2.1ms、`/api/bootstrap` 单趟。点一本书只发 **1 个** 接口（218ms，就是一个 RTT），进改编台/切章**一个都不发**（数据已在内存）。接口不是瓶颈。
- **gzip**：nginx 已开，`gzip_comp_level 5`，`gzip_types` 含 `text/css`、`application/javascript`。已生效。

---

## 二、已经改了的（本次提交）

### 1. 静态资源改成「先用旧的、后台悄悄验」

`src/server/app.ts:359-374`：

```ts
const cacheControl = cacheable ? "public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400" : "no-store";
```

- `max-age=60`：一分钟内直接用本地副本，**零往返**。
- `stale-while-revalidate=86400`：过期后仍然先用副本渲染，后台去验；验到新版下一次刷新就是新的。用户永远不等 304。
- `stale-if-error=86400`：服务器抽风时用副本顶上，不给白屏。
- 没上文件名指纹，所以不敢标 `immutable` —— 部署后最多一分钟（或一个后台重验周期）内所有人都拿到新文件。**这是有意的取舍。**

实测（本地 users 模式）：第二次、第三次访问 `js/css 26 个：缓存 26，304 0`，墙钟 690ms（原 1341ms）。

### 2. 首屏把整棵模块树一次交代清楚

`public/index.html:116-138` 加了 20 条 `<link rel="modulepreload">`，覆盖 `app.js` 全部静态 import。实测发现波次 5→1。

`scripts/frontend-contracts.mjs` 新增第 62 条契约守着它：清单里每条都必须真实存在（否则白跑 404），且 `app.js` 静态 import 的每个模块都必须在清单里（漏一个就退化成瀑布）。

---

## 三、还能再快（按性价比排序，尚未做）

### ① 静态资源交给 nginx 直接发，别过 node（省 5–15ms/请求，且能上 sendfile）

现在所有静态请求都要 `proxy_pass` 到 node 再 `readFile`。当前配置（`/etc/nginx/sites-enabled/novel.cttai.art`）：

```nginx
location / {
	proxy_pass http://127.0.0.1:8790;
	proxy_http_version 1.1;
	proxy_buffering off;          # ← 为 SSE 关的，静态资源也跟着受罪
	proxy_request_buffering off;
	proxy_cache off;
	add_header X-Accel-Buffering no always;
}
```

建议给静态路径单独开一条 location，把 SSE 的关缓冲只留在 `/api/`：

```nginx
# 静态资源：nginx 直接发，开缓冲、开 sendfile、给长缓存
location ~* ^/(app/.*\.js|.*\.css|.*\.js|.*\.svg|.*\.png|.*\.woff2|manifest\.json)$ {
	root /opt/novel-studio/public;
	expires 7d;
	add_header Cache-Control "public, max-age=604800, stale-while-revalidate=86400" always;
	access_log off;
	gzip_static on;      # 需 ngx_http_gzip_static_module
	open_file_cache max=200 inactive=60s;
	open_file_cache_valid 30s;
}

# 其余（页面与 API）保持原样，SSE 才需要关缓冲
location / {
	proxy_pass http://127.0.0.1:8790;
	proxy_http_version 1.1;
	proxy_set_header Connection "";
	proxy_buffering off;
	add_header X-Accel-Buffering no always;
}
```

配 `expires 7d` 之后浏览器连 304 都不发。**代价**：部署后要等 7 天或改文件名才更新 —— 所以要么给 `app.js?v=<版本>` 这种查询串（`index.html` 里由服务端注入 `package.json` 的版本号），要么把 `expires` 压到 1h。

`nginx -V` 里只有 `--with-http_v2_module`，**没有 brotli**；要上 brotli 得装 `ngx_brotli`（可再省 15–20%）。

### ② 把 21 个 JS 打成 1 个（省 20 个往返）

`scripts/build-web.ts` 现在只做拷贝（给 Tauri 用）。加一个「生产打包」步骤，用 esbuild 把这 20 个模块打成单文件（约 200KB gzip 后 ~60KB），首屏请求数从 30 降到 10 左右。**这是收益最大的一步**：跨境链路上省 20 个请求的排队与握手。

### ③ 页面也给 ETag（或短缓存）

`/` 与 `/index.html` 现在是 `no-store`（无 ETag）。它们只有 34KB，但每次都要完整下一次。给个 ETag + `max-age=0, stale-while-revalidate=60` 即可，代价是部署后最多 60s 才见新版。

### ④ 上 CDN

腾讯云同区域 CDN / COS 静态托管，回源 `novel.cttai.art`。境外用户拿到的是边缘节点，RTT 从 205ms 掉到 20–40ms。静态资源是最适合 CDN 的负载，而本项目全部前端都是静态文件。

### ⑤ 服务端给 `serveStatic` 加内存缓存

`src/server/app.ts:340` 每次 `await readFile(target)` 全量读盘（`/views.css` 90KB × 每次刷新）。加个 `Map<path, {mtime, body}>`，命中且 mtime 未变就直接吐 Buffer。服务器现在很空（load 0.0），这一项收益不大，但能省掉每次几十 KB 的 syscall。

---

## 四、一句话总结

慢的不是服务器，是**跨境 205ms 的往返 × 首屏 30 个请求 × 5 层模块瀑布 × 每次刷新 25 个 304**。
本次已把「5 波」压成「1 波」、把「每次 25 个 304」压成「一分钟内 0 个」；要再快就得动 nginx（静态直发 + 长缓存）和打包（21 个 JS 合成 1 个），或者直接上 CDN。
