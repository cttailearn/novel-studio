# 墨耕 · Novel Studio

> 本地优先的中文 AI 长篇小说创作台：设定官备料，执笔者成文 —— 写进正文的每个事实，都先落在素材里。

![Node](https://img.shields.io/badge/Node-22.6%2B-3c873a) ![pnpm](https://img.shields.io/badge/pnpm-10-f69220) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6) ![License](https://img.shields.io/badge/License-MIT-2f6f4e) ![Local-first](https://img.shields.io/badge/Local--first-data%2F-6b6b6b)

单机运行，工程、正文、素材与记录都在本机 `data/`；只有生成时发给模型的那部分上下文会离开本机。

## 目录

| 开始 | 使用 | 参考 |
|:--|:--|:--|
| [为什么是素材](#为什么是素材) | [两个智能体](#两个智能体) | [界面](#界面) |
| [快速开始](#快速开始) | [三块面板](#三块面板) | [存稿与容错](#存稿与容错) |
| [测试](#测试) | [四种写法](#四种写法) | [模型配置](#模型配置) |
| [项目结构](#项目结构) | [生成记录](#生成记录) | [安全](#安全) |
| [License](#license) | [智能体也会提问](#智能体也会提问) | [HTTP API](#http-api) |
| [Contributing](#contributing) | | [当前限制](#当前限制) |

## 为什么是素材

长篇写崩，多半不是句子不好，而是上下文漂了：第三章定的规矩，第十七章忘了；人物改过设定，后面还在按旧的回声写。墨耕把「写什么」和「怎么写」拆开：

- **设定官**（`role: material`）把设定、人物、地点、伏笔整理成结构化素材。
- **执笔者**（`role: writing`）每一章只拿到本章装配的素材，加上上一章的要略、小结与结尾。

三条硬规矩：**素材自包含**（每条料带种类、用法与关联章节）；**工具边界即职责边界**（设定官没有写正文的工具，执笔者不能改素材）；**不越章**（素材里没有的，记待办或问作者，不凭空发明）。

## 两个智能体

| 智能体 | role | 产出 | 专属工具 |
|:--|:--|:--|:--|
| 设定官 | `material` | `materials[]` | `update_outline`、`upsert_material`、`attach_materials` |
| 执笔者 | `writing` | `drafts[chapterId]` | `write_chapter`、`revise_chapter` |

两边共享 8 件只读与辅助工具：`get_project_brief`、`list_chapters`、`read_chapter`、`list_materials`、`search_materials`、`add_note`、`list_notes`、`resolve_note`。有提问通道时再加 `ask_user`。

注入的上下文不同：设定官拿到全库索引（id、种类、标题、用法），执笔者拿到本章素材全文与上一章三样（要略、小结、最后 600 字）。差异在快照里，不在提示词里 —— 模型看不到自己不该看的东西。

`scripts/smoke.ts` 与 `scripts/agent-loop.ts` 有工具边界断言：设定官拿不到 `write_chapter`，执笔者拿不到 `upsert_material` / `attach_materials` / `update_outline`。改坏了，`pnpm test` 会红。

## 快速开始

需要 Node.js ≥ 22.6（用 `--experimental-strip-types` 直接跑 TS）与 pnpm 10。

```bash
pnpm install
pnpm dev        # http://127.0.0.1:8787
```

首次打开：右上角「设置」→ 选供应商 → 填 API Key → 选模型；回案头「＋ 另起一卷」即可开写。密钥只存本机 `data/credentials.json`，界面只显示脱敏值。

可选环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1）、`DATA_DIR`（默认 `./data`）、`DEFAULT_MODEL`、`DEFAULT_THINKING_LEVEL`。

| 命令 | 作用 |
|:--|:--|
| `pnpm dev` | 启动并监听文件变化 |
| `pnpm start` | 启动，不监听 |
| `pnpm typecheck` | 只跑 `tsc --noEmit` |
| `pnpm test` | `typecheck` + 五个测试套件，全部离线，不需要 API Key |

## 三块面板

三块面板各有各的一席，可以同时生成，互不打断：

| 面板 | 智能体 | 干什么 |
|:--|:--|:--|
| 案头 · 通用素材库 | 设定官 | 跨作品备料；不写正文 |
| 素材工作台 | 设定官 | 上传原料、拆料、装料 |
| 生文工作台 | 执笔者 | 把本章素材组装成正文 |

每块面板有自己的生成状态：代次、占位、忙闲。一块在写，另一块照样能发话；「止笔」只停自己那块。生成中换模型会被服务端拒（409）—— 界面先记下，等这一轮收笔后补发。换卷或删作品才会作废所有轮次。

## 四种写法

在执笔者栏选章节、选写法，把交代写进输入框，点「呈上」落笔。写法决定这一轮怎么动笔：

| 写法 | 何时用 | 执笔者怎么做 |
|:--|:--|:--|
| 从零写起 `create` | 空白章 | 按本章素材写完整一章 |
| 整章重写 `rewrite` | 有旧稿，要换写法 | 先读旧稿，再整章重写（整段覆盖） |
| 续写下去 `continue` | 已有开头 | 读旧稿，从末尾接着写 |
| 局部修改 `patch` | 只想改几处 | 先读旧稿，只用 `revise_chapter` 换点名段落 |

作业条上不再有单独的「装料成文 / 重写此章 / 改这几处」按钮；章节、写法、输入框里的交代，一起由「呈上」提交。

`patch` 按「逐字原文定位 + 唯一性校验」找位置：点名的那几处必须与旧稿逐字一致（含标点、空格、换行）且全文唯一；0 处或多处命中就报错重来，绝不猜位置。不按行号，也不做模糊匹配 —— 行号会被前后的编辑挪走，模糊匹配可能落在「看起来像」的另一段。它也不走整章重写：只嫌一句话写得冷，不必让模型重交全章。每次修改留版本历史。

换章时写法自动跟着章走：**有旧稿 = 整章重写，空白章 = 从零写起**。没装料时落笔会被挡住（`patch` 除外 —— 它需要的是已有正文），服务端同样回 409。装料是作者可以直接做的事，和 `attach_materials` 写的是同一份数据。

## 生成记录

设定官与执笔者的每一席生成都会留档，每跑完一轮更新一次；存在 `data/records.json`。面板头部有「记录」按钮，列出最近 10 条：设定官按作品计，执笔者按章计（同一章留 10 条）。记录带当轮对话与产出摘要，可以从某条记录接着写，也可以删除。

- 续写时带上 `recordId`；记录已被删掉，服务端回 404「这条记录不在了（可能已被删除）」。
- 会话在内存里：进程重启会丢对话，但记录留在磁盘上，可以从这里接回。
- 记录只在本机，不上传。单条超过 512 KB 时从最老的消息开始丢，至少保留 4 条。

## 智能体也会提问

素材里查不到、又只有作者能定的事（这一章用谁的视角、情绪往哪走、某段要不要删），智能体会调用 `ask_user`。面板里出现提问卡：可以点候选，也可以直接作答；回答后同一轮继续，不用另起一席。

- 10 分钟没有回答，按「没回答」处理：模型按自己的判断继续，不替作者编答案。
- 一次只问一个最关键的问题；能自己查到的不问。
- 一次性成文（`/write`）不接提问通道 —— 那里作者不在场，缺口记成待办（`add_note`）。

## 界面

两级：**案头**管卷宗与通用素材库；**写作台**进卷才写。写作台左栏章目（字数、装料数、未写章的朱砂点、搜索），中栏「稿 / 料 / 文」，右案「素材 / 大纲 / 待办」；窄屏时右案变抽屉。

| 稿面 | 行为 |
|:--|:--|
| 自动存稿 | 停顿约 1.4 秒写盘；显示「未存 / 存稿中… / 已存 HH:MM」；`Ctrl/Cmd+S` 立即存 |
| 切走之前 | 切章、切页、回案头、导出、开版本前先落盘；失败会明确问 |
| 版本 | 最近 10 版，含来源、时间、字数、装料数；可展开全文，恢复前另存一版 |
| 导出 | 本章 / 全书 × TXT / Markdown |
| 排版 | 字号、行距、版心只存本机浏览器；专注模式 `Esc` 退出 |

| 快捷键 | 动作 |
|:--|:--|
| `Ctrl/Cmd+K` | 检索章目、素材与动作 |
| `Ctrl/Cmd+S` | 存稿 |
| `Ctrl/Cmd+1 / 2 / 3` | 稿 / 料 / 文 |
| `Alt+↑ / ↓` | 上一章 / 下一章 |
| `?` | 键盘说明 |
| `Esc` | 关弹层 / 退出专注 |

<details>
<summary><b>视觉与响应式</b></summary>

- 纸色、墨色、朱砂三组变量；朱丝栏透明度 0.055；纸纹是 SVG 噪声，透明度 0.05。
- 正文宋体，标题与印章楷体，控件用系统无衬线；全部系统字体栈，不联网加载 CJK。
- 正文首行缩进两格，行高 2.05；版心 45 / 54 / 66em，默认 54。
- 料、文两栏可拖，左栏 26%–74%，默认 50%，双击复位，键盘可微调；≤1180px 叠起。
- 素材卡按栏宽重排：≥300px 两列，≥560px 三列；案头通用素材库按种类分组。
- ≤1240px 右案变抽屉；≤640px 顶栏两排、章目左抽屉、模型收进「笔」浮层。
- 触控目标 ≥48px；表单字号 ≥16px；用 `dvh` 与 `safe-area-inset`；返回键先关弹层。
- PWA `standalone`，可加到主屏幕；局域网 IP 下浏览器通常不给「添加到主屏幕」，是浏览器策略。

</details>

## 存稿与容错

写操作的回话在落盘之后：服务端先写盘，再回成功。落盘失败有横幅提示，可以重试；状态查 `GET /api/storage`，重试走 `POST /api/storage/retry`。

正文不整本进内存，分三层：

| 层 | 位置 | 何时取 |
|:--|:--|:--|
| 工程骨架 | `data/<projectId>.json` | 打开工程；卷、大纲、素材、备注 |
| 章元数据 | `data/drafts/<projectId>/<chapterId>.meta.json` | 章目字数、装料数 |
| 正文 | `data/drafts/<projectId>/<chapterId>.txt` | 打开该章、执笔者读稿 |
| 版本 | `data/drafts/<projectId>/<chapterId>.hist/` | 打开版本抽屉 |

`GET /api/projects/:id` 只回骨架与章元数据，正文单独取；导出流式读整本。快照 gzip（`.json.gz`），旧的 `.json` 仍可读。老工程首次打开时后台惰性拆分，旧文件改名 `.migrated` 留着，不删。给智能体读长文也分页：`list_chapters` 默认 40 章一页（上限 200），`read_chapter` 只取全文、头或尾（默认 6000 字，上限 2 万字）。

浏览器断网或服务重启时，统一显示：

> 服务没接上（可能刚重启，或网络断了）。

同一场故障只报一条，不刷屏。收尾重载按 0.4 / 0.9 / 1.8 / 2.6 秒退避重试，服务回来自动补齐右案与素材库。失败的那句话会还回输入框（框还空着时），点「再试一次」原样重发。

<details>
<summary><b>上游错误分类</b></summary>

一轮最多一条红字，写清等了多久、上游原话、该怎么办；显示前剥掉 SDK 错误壳，分类看原始错误。

| 类别 | 典型信号 | 建议 |
|:--|:--|:--|
| `overload` | 503、overloaded、capacity | 过几分钟再试，或换模型 |
| `quota` | 429、quota、余额 | 查额度与账单 |
| `auth` | 401、403、invalid key | 重新填 Key |
| `model` | 404、model not found | 换模型或核对模型名 |
| `timeout` | 超时 | 缩交代，或换快一点的模型 |
| `other` | 其它上游错误 | 看上游原话 |
| `silent` | 流断了，没有错误 | 再试一次 |

`timeoutMs=180_000`，`maxRetries=2`（最坏约 9 分钟）；个别适配器（如 pi-ai 的 Google 适配器）不读这两个值。主动「止笔」不算错误。上游偶尔把错误塞进 HTTP 200（例如 `status_code: 2067`、`choices: null`），服务端会识别并报出来。

</details>

## 模型配置

设置里配供应商与模型。内置 41 个供应商（国内 16、国际 18、云 7），模型目录来自 `pi-ai`，约 1500 个；也可以自建兼容端点。

| 方式 | 怎么配 |
|:--|:--|
| 内置供应商 | 选供应商 → 填 Key。保存的 Key 优先于环境变量 |
| 自定义供应商 | Base URL + 接口格式 + Key；格式支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Generative AI（Gemini） |
| 本地服务 | 不需要鉴权的可勾选（如 Ollama） |

「拉取模型」只证明接口通、鉴权过，不代表该网关原生支持生成；能力以实际调用为准。

<details>
<summary><b>额外凭据</b></summary>

| 供应商 | 额外需要 |
|:--|:--|
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` 或 `AWS_ACCESS_KEY_ID` / `AWS_PROFILE` |
| Google Vertex | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_APPLICATION_CREDENTIALS` |
| Cloudflare | `CLOUDFLARE_API_KEY` + 账户 ID |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN`（仅 OAuth） |
| Hugging Face | `HF_TOKEN` |

</details>

<details>
<summary><b>模型参数</b></summary>

每个模型可配 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevels`、`cost`（每百万 token）。批量修改：

```http
PATCH /api/providers/:id/models
{ "ids": ["..."], "contextWindow": 200000, "reasoning": true }
```

`ids` 缺省表示全部；字段各自独立，非法值回 400；`reasoning:false` 强制 `["off"]`，`true` 而全为 off 时退回原来的非 off 档；响应 `{updated}` 只列真改过的模型。`off` 不写 `thinkingLevelMap`（Anthropic 的 effort 没有 off，写了会报错）。占位的 1M / 128K 标「待核对」，生成前请核对上游文档。

</details>

## 安全

- API Key 只存 `data/credentials.json`，与可共享的 `data/settings.json` 分开；界面只显示脱敏值。
- `data/` 整个被 git 忽略：工程、正文、素材、记录、快照都在里面。
- 落盘用随机临时名 + rename + 重试，避开 Windows 的 `EPERM`。
- 生成时，本章素材、上一章内容与你的交代会发给所配置的模型服务；除此之外不出本机。

## HTTP API

本地 HTTP 服务，前端是同源单页应用。主要端点：

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| `GET` | `/api/bootstrap` | 启动数据：设置、供应商、模型 |
| `GET/PUT` | `/api/settings` | 界面与服务设置 |
| `GET/POST` | `/api/providers` | 供应商列表 / 新建 |
| `POST` | `/api/sessions` | 开一席（`role`: `material` / `writing`） |
| `POST` | `/api/sessions/:id/messages` | 发一轮，NDJSON 流 |
| `POST` | `/api/sessions/:id/abort` | 止笔 |
| `POST` | `/api/projects/:id/chapters/:chapterId/write` | 一次性成文 |
| `POST` | `/api/questions/:id/answer` | 回答提问 |
| `GET` | `/api/projects/:id` | 工程骨架 + 章元数据 |
| `GET` | `/api/projects/:id/chapters/:chapterId/draft` | 取正文（`?history=1` 连版本） |
| `GET` | `/api/records` | 生成记录摘要（按 role / projectId / chapterId / scope 过滤） |
| `DELETE` | `/api/records/:id` | 删除一条生成记录 |

```http
POST /api/projects/:id/chapters/:chapterId/write
{ "modelRef": "provider/model", "thinkingLevel": "off",
  "mode": "create", "note": "写得冷一点" }
```

- `mode` 为 `create` / `rewrite` / `continue` / `patch`。除 `patch` 外，本章没有装配素材回 409；`patch` 不需要素材，但没有正文回 409。
- `PATCH /api/projects/:id/chapters/:chapterId` 的 body 是 `{ content, autosave?, summary? }`；`autosave: true` 只递增修订号、不占版本历史；`summary` 非空才覆盖。
- 会话的 `/messages` 返回 NDJSON：文本增量、工具调用、提问、收尾各是一行；会话过期由前端自动重开。

其余数据端点主要有 `/api/library`、`/api/kinds`、`/api/uploads`、`/api/projects/:id/volumes`、`/api/projects/:id/materials`、`/api/projects/:id/snapshots`、`/api/projects/:id/export`、`/api/storage`；完整路由见 `src/server/main.ts`。

## 项目结构

```
src/
  ai/          模型注册、提示词、工具、智能体、提问接口
  config/      环境、设置、凭据
  server/      HTTP 路由、会话、生成记录、上传解析
  store/       工程、素材库、素材种类
public/        原生 JS 单页应用；无构建步骤
scripts/       冒烟、配置、存储、服务、循环测试
docs/          规模方案（scaling-plan.md）
data/          运行时数据（git 忽略）：工程、正文、密钥、记录
```

## 测试

五套件加类型检查，全部离线：`test:config`（供应商与设置）、`test:tools`（工具契约与素材逻辑）、`test:storage`（分层存储与迁移）、`test:server`（真进程 HTTP 契约）、`test:loop`（用 `pi-ai` 的 `fauxProvider` 跑完整素材链与组装链）。

<details>
<summary><b>一些值得留意的断言</b></summary>

- `write_chapter` 拒绝不存在的 `chapterId`，不会留下幽灵草稿。
- `chapterIds` 与章节的 `materialIds` 双向同步；首次写入继承已有装配。
- 素材快照包含全库索引但不含全文；写作快照相反。
- 同一章的并发写入走 `withChapterLock`，后到的整段覆盖不会交错。
- 库取用是复制：新 id、`source: library`、`originId`，不反噬原作品。
- 坏掉的设置或记录文件隔离为 `.corrupt-<时间戳>`，从空开始，不覆盖原文件。
- `test:server` 用临时目录与假上游，验路径遍历、畸形请求、生成中换模型 409、客户端断开中止。

</details>

## 当前限制

- 会话在内存里：进程重启会丢对话历史（工程、设置与生成记录保留）。
- 自动存稿依赖服务可达；离线编辑不会自动落盘。
- 版本保留 10 个，没有逐字 diff；恢复前会另存一版。
- 导出只有 TXT / Markdown；没有 docx / epub。
- 不能删章、拖拽排序；卷也不能拖拽重排。
- 检索只在当前作品与通用素材库内，不跨作品全文检索。
- 上传只收 UTF-8 文本与 `.docx`；`pdf` / `epub` / `doc` 明确拒绝（415），GBK 文本会乱码。上传的原料不落盘。
- 一章装料过多会占满上下文；单次上传超过 20 万字截断，超过 6 万字会提示。
- 自定义模型的参数要人工核对；`usage` 写得好不好，仍取决于作者。
- 通用素材库取用是复制，不自动同步；库与作品之间没有引用关系（刻意如此）。
- 上游可能把错误塞进 HTTP 200；服务端会尽量识别，但不保证覆盖所有中转格式。

## License

[MIT](LICENSE) © 2026 cttailearn

## Contributing

这是个人项目，Issue 与 PR 都欢迎。比较大的改动（新工具、新存储层、界面重构）请先开 Issue 对齐方向，避免白做。

提交前跑：

```bash
pnpm typecheck && pnpm test
```

Issue 和 PR 用中文或英文都行。涉及智能体工具的改动，请一并更新 `scripts/smoke.ts` 或 `scripts/agent-loop.ts` 里的边界断言。
