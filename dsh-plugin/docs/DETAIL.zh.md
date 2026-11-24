# 小说工坊

DSH 的一个主面板工作台：点侧栏图标，中央面板就变成一张三栏书桌 ——
左边作品与章节，中间写正文，右边素材与连续性提醒。
新建作品时可以挑一个电脑上的目录，之后这本书生成的东西全落在那个目录里。

## 留下来的东西

上游项目是个独立的 Tauri + Node 应用，三层结构。这里只留值得留的领域内核：

- **作品、章节、素材、连续性备注** —— 一部作品就是一个纯 JSON 文件目录，
  脱离本插件也能读、能 diff、能拷走。
- **素材模型** —— 内置十三种素材种类外加作者自建种，`usage` 字段说明
  「什么情况下该用这条料」，`chapterIds` 显式声明装配到哪些章。
- **骨架与正文分离** —— 列章节永远不用读几兆正文，
  写一章也只重写那一章的正文文件。
- **版本守卫** —— 每次写正文都带上它期望的版本号。
  过期写入直接失败，而不是悄悄覆盖掉另一处写的字；旧正文进有上限的历史。

## 换掉的东西

| 上游 | 这里 |
| --- | --- |
| `llm-client.ts` + `llm-relay.ts`（2 600 行） | `llm` 服务 |
| 42 个供应商、1 500 条模型 | `llm.listProviders()` / `listModels()` |
| 密钥存储与 Tauri keyring | `credentials` 服务 |
| 设置页与设置存储 | `settings` 服务及其 section 插槽 |
| Node HTTP 服务和路由（4 100 行） | `webServer.register()` 加一条前缀路由 |
| 账号体系（`cloud/*`） | —— |
| 内存里的会话表 | `agents` / `sessions` |
| 22 700 行 SPA 外壳 | 插槽里的 React 组件 |

## 存储

```
$DSH_HOME/novel-studio/            （可用 DSH_NOVEL_HOME 改位置）
  index.json                       左栏的作品列表
  projects/<id>/project.json       要略、素材、卷、备注
  projects/<id>/chapters/<k>.json  一章正文与它的历史
```

作品也可以写进作者自己挑的目录里，那样这两个文件就落在那儿，
`projects/<id>` 下一个字都不会写：

```
D:\小说\雨夜\project.json
D:\小说\雨夜\chapters\<k>.json
```

`index.json` 为这类行多一个 `dir` 字段，并且**始终是「这本书住在哪儿」的唯一权威**，
不是作品文件自己说了算 —— 所以文件夹挪走之后重新指回来，书里的内容一个字都不用改。
由此有三条规矩：

- 这样的作品「删除」只是移出列表（`keptFiles: true`）。文件夹是作者的，
  工作台从不删自己没写过的文件。
- 挑到一个已经有 `project.json` 的目录会被 `409` 拒掉，
  因为拿我们的骨架盖上去，等于毁掉一份我们从未拥有的正文。
- 只接受绝对路径；相对路径回 `400`，它从 Host 的工作目录出发没有意义。

目录是用 `uiWorkspace.pickDirectory()` 挑的，也就是宿主自己的对话框。
浏览器读不出 `<input type="file">` 里的真实路径，建目录也只有 Host 半能做，
所以这是面板唯一向 shell 要东西的地方。

`<k>` 是 `encodeFileName()` 编码过的章节 id：只留 `[A-Za-z0-9_-]`，
其余转义成 `_<hex>_`，截到 120 字符再拼 djb2 后缀。
模型生成的中文章节 id 因此不越 Windows 255 字节文件名上限，
两个共享长前缀的 id 也仍然落在不同文件上。

每次写入都先写临时文件再改名，写到一半崩掉也不会留下半个工程。

## 路由

Client 半碰不到文件系统，所以由 Host 半用一条同源前缀路由把存储端出来，
harness 里没有第二处读它。

```
GET    /novel-studio/api/projects
POST   /novel-studio/api/projects
GET    /novel-studio/api/projects/:id
PATCH  /novel-studio/api/projects/:id
DELETE /novel-studio/api/projects/:id
GET    /novel-studio/api/projects/:id/chapters
GET    /novel-studio/api/projects/:id/chapters/:chapterId
PUT    /novel-studio/api/projects/:id/chapters/:chapterId
POST   /novel-studio/api/projects/:id/outline
DELETE /novel-studio/api/projects/:id/outline/:chapterId
POST   /novel-studio/api/projects/:id/materials
DELETE /novel-studio/api/projects/:id/materials/:materialId
POST   /novel-studio/api/projects/:id/notes
GET    /novel-studio/api/active
PUT    /novel-studio/api/active
GET    /novel-studio/api/sources
POST   /novel-studio/api/sources/upload?filename=…&kind=…
GET    /novel-studio/api/sources/:id
DELETE /novel-studio/api/sources/:id
GET    /novel-studio/api/sources/:id/chapters/:chapterId
GET    /novel-studio/api/sources/:id/search?q=…&limit=…
GET    /novel-studio/api/projects/:id/adaptation
PATCH  /novel-studio/api/projects/:id/adaptation
POST   /novel-studio/api/projects/:id/adaptation/cursor
GET    /novel-studio/api/projects/:id/chapters/:chapterId/adapt
POST   /novel-studio/api/projects/:id/chapters/:chapterId/adapt/accept
POST   /novel-studio/api/projects/:id/chapters/:chapterId/adapt/rename
```

带 `expectedRevision` 的正文写入若发现盘上版本不同，回 `409`，并把两个版本号都写在消息里。

`/active` 是「作者现在开着什么」的指针。工作台每次改选择就写它，角色提示词读它，
于是面板两边说的「这一章」是同一章。它只是提示不是事实源 —— 指针过期只让开场白
含糊一句，每一次写入仍然由版本守卫把关。

## 原料库

整本参考小说、设定集或资料堆一次传进来，回来时是可检索的分章：

```
$DSH_HOME/novel-studio/sources/<id>/meta.json
$DSH_HOME/novel-studio/sources/<id>/chapters/<k>.txt
```

正文存 `.txt` 而不是 JSON，有两个理由：四千章的书不能被当成一个 blob 读，
而且人应该能直接打开文件夹读。库扫自己的目录而不是另存一份索引 ——
原料很少新增、经常被读，第二份事实源只会多一份开销。

怎么拆章看文本本身，不看设置：有两个以上 `第…章` / `第…节` / `第…回` /
`Chapter N` 标题就按标题拆，否则退回到按段落边界切的约一万五千字定长块。
`document` 类型的上传永远是一整块 —— 把一份笔记拆成「章节」等于凭空造出它没声明的结构。

`POST /sources/upload` 的请求体就是文件本身，不是 JSON：七百万字的书当成
转义 JSON 字符串要多花一倍以上，而浏览器本来就握着那些字节。上限 64 MiB。

检索只给片段，从不给整章：它给每一章打分（标题命中算正文命中的八倍），
把命中位置前后最多 8 行引出来，读整章交给显式调用。

## 三支角色

智能体只能看见**自己的作用域**给它的工具，所以三支角色是挂成预设的插件行，
而不是事后过滤：

| 预设 | 行模块 | 工具 |
| --- | --- | --- |
| `novel-material` | `@local/dsh-novel-studio/role/material` | 8 个只读工具 + `update_outline`、`upsert_material`、`attach_materials` + 4 个原料库工具 |
| `novel-writing` | `@local/dsh-novel-studio/role/writing` | 8 个只读工具 + `write_chapter`、`append_chapter`、`revise_chapter` |
| `novel-adapt` | `@local/dsh-novel-studio/role/adapt` | 5 个「读原文、交提案」的工具，一个写正文的工具都没有 |

设定官因此根本不持有写正文的工具，执笔者也改不了设定。
这就是上游「工具边界即职责边界」的做法，只是改由 harness 来保证，而非靠提示词自觉。
执笔者也没有原料库工具：它写的是设定官已经装好的料，不必在写一章的中途回头去翻参考小说。

四个原料工具只在原料库存在时才出现，所以空的上传目录不会摆出四个只会回「原料库是空的」的工具。

三支角色都用 `complete: true` 注册系统提示词，是整段替换而不是接在 harness 人设后面。
提示词每次请求都从「当前打开什么」的缓存快照现渲染，
所以稳定的那部分照样吃得上缓存，变的只有那一小段工程摘要。

三个预设都是**新增**在出厂预设旁边，不会成为默认。

## 三步流程的入口

工作台编辑器工具栏下面有一排按钮，产品的主线就写在那一排上：

1. **AI 补素材** —— 开一个跑 `novel-material` 的会话，让它读章目与现有素材，补上缺的。
2. **AI 装配** —— 同一个预设，让它挑出这一章真正用得上的几条素材并装上去。
3. **AI 落笔** —— 开一个跑 `novel-writing` 的会话，照刚装配的素材把这一章写出来。
   在改编工程上这个按钮换成 **AI 改编**，开的是 `novel-adapt`：执笔者和改编者的工具集不相交。

按钮走的是 Client 侧的 `uiWorkspace.startSession()`：开一个真会话、把书名与章名写进草稿框，
**但不替你发送**——点错了不会花掉 token。发送之后工作就移到对话里，
因为逐条工具卡片、停止按钮、取消都在那儿，工作台不是聊天窗口。

点按钮之前如果编辑器里还有没保存的正文，会先存一次：
角色提示词是从**已存**的章节装配的，没落盘的正文对 agent 是不可见的。
没有改动时这次保存什么也不做。

没选中章节时这一排照样在，因为「补素材」是整本书的活；
「装配」和「落笔」会置灰——对一章还不存在的书谈装配和落笔是没有意义的。
如果这个界面根本没有工作区可放会话，那一排会直说，而不是按下之后什么也不发生：
`startSession` 遇到这种情况只会弹一个系统提示，插件不自己判断就会谎报"会话已开"。

## 改编台账

改编工程是绑定了原料库里某本书的作品：章目由原书章节铸出来，
所以这里的「第一章」就是原书的「第一章」，任何一章都能对上它的原文。

改编者没有写正文的工具。它唯一的出口是 `propose_adaptation`，
交完提案就停，提案落在磁盘上：

```
$DSH_HOME/novel-studio/proposals/<project>__<chapter>.json
```

一章一份，重交就覆盖，超过 24 小时自动清掉。作者在双栏里读、随手改，
点「采用这一版」之后正文才真正落地。这就是它与执笔者的分界：
改错的稿子悄悄盖掉原文，等于抹掉作者唯一没法还原的东西 —— 这一章原来长什么样。

采用时按顺序守这几条：

- 提案的 `baseRevision` 必须还是当前版本，否则 `409`
- 这一章必须轮到了，除非它已经有稿子 —— 回头修自己确认过的章正是该做的事，抢跑不是
- 台账落一条；改过章名的补 `title` 条目，作者自己动手写的补 `other` 条目
- 只有「采用的就是轮到的那一章」时 cursor 才往前走，
  所以回头修第一章永远不会把后面几章的确认退回去

`restore` 把一章退回原书：正文清空、小结清空、状态回到 `planned`、
cursor 拉回这一章、该章的改动条目（标题条目除外）一并丢掉。

## 还没有的

`.novel` 打包格式与通用素材库（不属于任何单部作品的素材）。
这两个会长在这份存储之上，而不是另起一套。
