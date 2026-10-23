# 千万字规模优化技术方案

> 落笔于 2026-10-23。目标：让一部**一千万字**的长篇在墨耕里不卡、不炸、不吞内存。
> 这不是「预测未来」，是**现在就能量出来的**问题：每加一章，整本书的正文就被搬一遍。

---

## 一、先量一量：瓶颈不在 JSON，在「整本操作」

现在一部书的数据长这样：

```
data/<projectId>.json                    骨架：卷 / 大纲 / 素材 / 备注
data/drafts/<projectId>/<enc>.json       每章：正文 + 小结 + 最多 10 版历史
```

实测（1000 章 × 9504 字，≈ 950 万字）：

| 动作 | 现状 | 实测 | 千万字时 |
| --- | --- | --- | --- |
| `GET /api/projects/:id` | 整个作品连正文带历史一起吐 | 响应 40.1 MB（UTF-8 119 MB）；序列化 84 ms、parse 47 ms；服务端常驻 178 MB | 响应 400 MB 量级，浏览器直接崩 |
| 每存一次稿 | `store.stats(saved)` → `projectStats` 遍历全书正文算字数 | **258 ms/次** | 每次自动存稿都白等 0.26 秒 |
| 写一次稿 | 重写整章 JSON（含 10 版历史） | 写放大 ~11 倍 | 每章文件越大，写得越慢 |
| `snapshot()` | 整本书连历史 pretty-print 成一份 JSON，最多存 20 份 | 20 份 × 全书 | 千万字 ≈ 2 GB 快照 |
| `list_chapters` 工具 | 一次吐出全书每章标题 / 状态 / 字数 / 要略 | 76,672 字 ≈ **76K token** | 一次调用就撑爆上下文窗，模型还没开始写就废了 |

**结论**：JSON 文件本身不是问题（1030 个文件、章节文件 30–330 KB、主文件 1 MB，任何现代编辑器都吃得下）。
要命的是**四处「整本操作」**：一次接口带出整本书、一次存稿扫一遍全书、一次快照存下整本书、一次工具调用列全书。

100 万字以内，这几处都还撑得住。
**一千万字，这四处会先炸。** 所以下面按「拆整本」这一条主线来做。

---

## 二、总思路：三层分离

把「一本书」拆成三层，各管各的：

```
骨架层   骨架（卷 / 大纲 / 素材 / 备注）—— 常驻内存，永远带着走，很小
元数据层 每章的标题 / 小结 / 字数 / 第几稿 —— 常驻内存，很小
正文层   每章的正文与历史 —— 放磁盘，用到才取，取完就走
```

关键观念变化：**字数是元数据，不是正文算出来的**。
现在字数靠 `countWords(draft.content)` 现算（两次正则，扫全书）。改完以后字数随正文一起记账，存一次写一次。

---

## 三、P0：接口分层 —— 正文按需取

### 3.1 目标

界面上永远只拿元数据；只有真的要显示 / 编辑某一章正文时，才去取那一章。

### 3.2 契约

```
GET  /api/projects/:id
  → { project: 骨架, chapters: ChapterMeta[], stats }
     ChapterMeta = { id, title, summary, words, revision, updatedAt, materialIds, hasDraft }
     project.drafts[chapterId] 现在是 ChapterMeta（没有 content，也没有 history）

GET  /api/projects/:id/chapters/:chapterId/draft
  → { chapter: { id, title, content, summary, revision, updatedAt, materialIds } }
     ?history=1 额外给 history: Array<{ revision, title, content, materialIds, updatedAt, mode }>
     章不存在 → 404 { error: "章节不存在" }

PATCH  /api/projects/:id/chapters/:chapterId
  → { chapter: ChapterMeta, stats }          （不再回传正文与历史）

POST   /api/projects/:id/chapters/:chapterId/write
  → { chapter: ChapterMeta, stats }          （同上）

GET    /api/projects/:id/export               行为不变，改为流式输出
```

### 3.3 前端怎么改

* 加一份正文缓存（`state.bodies`），只装正在看的那几章。
* 稿面正文、版本列表、恢复旧版这三处改成按需取；其余「多少字 / 有没有正文 / 第几稿」全走元数据。
* 取正文期间给「正在取稿…」占位，不让稿面突然空白；取失败要有提示。

### 3.4 收益

* 首屏载荷从 40 MB 降到几百 KB（骨架 + 元数据）。
* 前端每次重画章目不再 `countWords` 全书。
* 自动存稿（每 1.4 秒一次）不再触发全书扫描。

---

## 四、P1：存储拆分 —— 一章一个文件组

### 4.1 新布局

```
data/<projectId>.json                                     骨架
data/drafts/<projectId>/<enc>.meta.json                   ChapterMeta
data/drafts/<projectId>/<enc>.txt                         正文（纯文本，UTF-8，不转义）
data/drafts/<projectId>/<enc>.hist/<revision>.json        历史版本，每版一份
```

为什么正文单独用 `.txt`：
* 不用转义，读写都便宜；
* 万一某个 JSON 写坏了，正文那一份还在；
* 存稿只重写正文那一个文件，元数据与历史各写各的，写放大从 ~11 倍降到 ~1 倍。

### 4.2 老工程怎么办（**最重要的一节**）

**惰性迁移，不动原文件。**

1. 读到 `<enc>.json`（老格式，含正文与历史）时，先写 `.meta.json`、`.txt`、`.hist/`；
2. **三样都写成功之后**，才把老文件改名成 `<enc>.json.migrated`；
3. 任一步失败 → 老文件原样留着，下次再试；
4. `.migrated` 一律忽略，但**永远不删** —— 出问题还能手工捞回来。

老工程缺 `words` 时惰性算一次并回填 `.meta.json`。
作者第一次打开旧书时，会在后台慢慢把稿子搬到新格子；不打断任何操作。

### 4.3 写盘顺序

**先正文，后元数据。** 元数据落后一拍，只影响字数显示；反过来会出现「说有章、其实没正文」的幽灵。

---

## 五、P2：快照瘦身

现状：`snapshot()` 把整本书连历史 pretty-print 成一份 JSON，最多 20 份。千万字 ≈ 2 GB。

改法（**最终实现，与初稿有出入，见下面的说明**）：

* 快照存**骨架 + 各章正文与历史**，打包成 `{ project, bodies }` 后 **gzip**，写成 `<stamp>-<label>.json.gz`；
* 正文**进**快照 —— 快照仍然当得备份使，还原时能把正文一起还原；
* gzip 之后体积降一个数量级（实测 200 章 / 190 万字：原始 JSON 约 82 KB → 快照 25 KB）；
* 数量上限仍是 20 份（没降）：gzip 之后每份小了十几倍，20 份也占不了多少地方，没必要动作者已有的习惯；
* 旧的 `.json` 快照照样读得开（读时按需 `gunzip` 或直接读 JSON）。

> 取舍变更：初稿打算让快照「只存骨架、正文不进快照」，省事但**快照就不再是备份**了。
> 想到「存照」这个动作本身就是给人安心的，与其把它降级成「那天大纲长什么样」，
> 不如让 gzip 去扛体积 —— **瘦身靠压缩，不靠少存**。

---

## 六、P3：模型工具分页与截断

模型侧一次列全书会先炸：76K token 的 `list_chapters` 一次就把上下文窗塞满。

```
list_chapters
  + scope: "all" | "drafted" | "undrafted"   只看没写 / 写过（默认 all）
  + offset: number       从第几章开始（默认 0）
  + limit: number        一次给几章（默认 40，上限 200）
  + withSummary: boolean 要略要不要给（默认 false —— 要略最占地方，按需再要）

read_chapter
  + part: "full" | "head" | "tail"   默认 full
  + chars: number                     一次最多取多少字（默认 6000，上限 20000）
  + start: number                     从第几个字开始取
```

返回里注明「还有 N 章没列，用 offset 继续取」，让模型自己决定要不要再翻一页。
`list_chapters` 的字数直接读元数据里的 `words`，不再现算。

> 与初稿的出入：初稿写的是「按卷筛」（`scope` 指卷），实际做成了**按写没写筛**。
> 理由：模型问「后面还有什么」时，要的是「还没写的那些」，不是「第二卷的那些」；
> 卷的信息本来就在返回的卷清单里，模型看得见。
> `withSummary` 默认改成 `false`：要略是全书最占地方的部分，不主动要就不给。

---

## 七、验收口径

| 项 | 口径 |
| --- | --- |
| 存稿耗时 | 不再随全书字数增长（与当前章字数相关即可） |
| 首屏载荷 | 与章节数无关，只与骨架大小有关 |
| 服务端常驻内存 | 不再与正文总量成正比 |
| 老工程 | 打开不报错、稿子一字不丢、迁移后可回滚（`.migrated` 在） |
| 模型单次调用 | 不超过 8K token 的章节目录 |

---

## 八、做完了什么样

* 一千万字的书，打开照常快；
* 存稿不卡；
* 快照不再吃掉几个 G；
* 设定官问「后面还有什么」时，它自己会翻页，而不是一次把整本书塞进脑袋；
* 老书无损升级，`.migrated` 文件留着当后悔药。

---

## 九、落地情况（2026-10-23 实现后补记）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P0 接口分层 | 已做 | `GET /api/projects/:id` 回 `{ project, chapters, stats }`；新增 `GET .../chapters/:chapterId/draft`（`?history=1` 带历史）；存稿与成文只回元数据 |
| P1 存储拆分 | 已做 | `<enc>.meta.json` / `<enc>.txt` / `<enc>.hist/<rev>.json`；老格式惰性迁移成 `.migrated`（**不删**） |
| P2 快照瘦身 | 已做 | `{ project, bodies }` → gzip → `.json.gz`；数量上限仍 20 份；旧 `.json` 快照兼容读 |
| P3 工具分页 | 已做 | `list_chapters` 的 scope/offset/limit/withSummary；`read_chapter` 的 part/chars/start |
| 前端按需取正文 | 已做 | 正文缓存只留最近 4 章；取稿期间摆「正在取稿…」占位；取失败有提示 |
| 验收脚本 | 已做 | `scripts/storage-check.ts`（`pnpm test:storage`）：造 200 章 × 9504 字，逐项对口径 |

实测（200 章 × 9504 字 ≈ 190 万字）：

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 整本响应 | 随正文一起吐（百万字级） | 116 KB（骨架 + 元数据） |
| 每章骨架开销 | — | 573 字节 |
| 存一次稿的统计耗时 | 258 ms（扫全书） | 7–12 ms（读元数据） |
| 快照一份 | 82 KB（明文 JSON） | 25 KB（gzip） |
| 写 200 章 | — | 967–988 ms |

失败时不丢稿：正文写盘失败会记进 `pendingBodies` 并报「待重试」，`POST /api/storage/retry` 或下次启动
自动补写；元数据（字数、稿次）落后一拍只影响显示，不会出现「说有章、其实没正文」的幽灵。
