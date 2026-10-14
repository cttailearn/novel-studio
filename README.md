# 墨耕 · Novel Studio

AI 长章小说创作台。基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 与 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 构建，包含模型接入、小说写作智能体、供应商配置与水墨案头界面。

## 快速开始

```bash
pnpm install
pnpm dev                  # 默认 http://127.0.0.1:8787
```

打开页面后点右上角「设置」配置供应商与模型，无需手动编辑 `.env`。

## 界面：水墨案头

界面不是聊天工具的皮相，而是按「写小说」重新组织的案头。

**为什么是浅色。** 水墨是纸上的媒介，深色底做水墨本质上是伪滤镜。暖白宣纸面对长时间读长文本，也比纯白更省眼。所以配色是宣纸、墨、朱砂三色，其余一律不用。

| 区域 | 作用 |
| --- | --- |
| 顶栏 | 印章、书名、进度、模型与推理档位 |
| 左卷 | 案上作品 + 章目（带字数，未写的章点朱砂点） |
| 中稿台 | **稿**（读稿 / 改稿）与 **议**（与智能体对话）两个视图 |
| 右案 | 人物 / 世观 / 大纲 / 待办，随写随查 |

关键取舍：

- **智能体的话直接排成正文，不装进气泡。** 墨客的产出是稿子，不是消息。
- **工具调用收成「旁批」。** 一根细墨线加小字，不打断阅读。
- **文稿区有朱丝栏。** 稿纸的竖向界线，透明度压到 0.055，只作肌理不干扰阅读。
- **首行缩进两格、行高 2.05。** 中文小说的排版规矩。
- **改稿用等宽等行距的 textarea。** 阅读态与编辑态切换无跳变。
- **纸纹是 SVG 噪声，透明度 0.05。** 再高就成电视雪花。
- **选中态是墨晕不是色块。** `radial-gradient` 从左侧晕开，配朱砂细竖线。

字体：正文与文稿用宋体（Songti SC / SimSun / Noto Serif SC），标题与印章用楷体（Kaiti SC / KaiTi），控件用系统无衬线。全部为系统字体栈，不联网加载 CJK 字体。

## 模型配置

配置分为两类，均在设置界面完成。

### 默认供应商

内置 **41 个**，首次启动自动预置，按用途分三组显示。模型目录由 pi-ai 内置维护（共约 1500 个模型条目），不需要拉取。

| 分组 | 厂商 |
| --- | --- |
| 国内厂商（16） | DeepSeek、Moonshot 国内 / 国际、Kimi Coding、Z.ai / Z.ai Coding 国内、MiniMax 国内 / 国际、Qwen Token Plan 及其国内与个人版、小米 MiMo 及三档 Token Plan、蚂蚁灵光、Meta |
| 国际通用（18） | Anthropic、OpenAI、Google Gemini、Mistral、xAI、Groq、Cerebras、Together AI、Fireworks、NVIDIA NIM、Baseten、Hugging Face、OpenRouter、Vercel AI Gateway、TypeSafe、Radius、GitHub Copilot |
| 云平台与推理（7） | Azure OpenAI、Amazon Bedrock、Google Vertex AI、Cloudflare AI Gateway、Cloudflare Workers AI、OpenCode Zen、OpenCode Go |

`openai-codex` 只有 OAuth 流程（无 API Key 模式），因此未纳入 —— 它需要 `Models.login()` 走设备码授权，不是填 key 能配的。`faux` 是 pi-ai 的测试用 provider，同样排除。

设置页为每个厂商保存 API Key，**保存的 key 优先于环境变量**。若只想用环境变量，不保存即可，界面会标注来源。厂商较多，左列带搜索框，按名称、id 或环境变量名过滤。

部分厂商除 Key 外还需要别的凭据，界面会一并提示：

| 厂商 | 需要的凭据 |
| --- | --- |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` / `AWS_ACCESS_KEY_ID` / `AWS_PROFILE` |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_APPLICATION_CREDENTIALS` |
| Cloudflare | `CLOUDFLARE_API_KEY` + 账户 id |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Hugging Face | `HF_TOKEN`（注意不是 `HUGGINGFACE_API_KEY`） |

### 自定义供应商

需要基础 URL、接口格式与 Key：

| 接口格式 | 适用 |
| --- | --- |
| OpenAI Chat Completions | vLLM、Ollama 兼容层、中转服务、大部分国内厂商 |
| OpenAI Responses | 支持 `/v1/responses` 的服务 |
| Anthropic Messages | Anthropic 原生 `/v1/messages` |
| Google Generative AI | Google 原生 `/v1beta/models` |

填好 URL 和 Key 后点「拉取模型」，服务端会按格式自动补全路径并解析上游列表：

- 已存在的模型保留你手填的参数，不会被覆盖
- 上游已删除的模型**也会保留**，避免意外丢失配置
- Google 会自动带出 `inputTokenLimit` / `outputTokenLimit` 预填上下文限制

自建或本地服务（oLlama、vLLM 等）可勾选「该服务不需要鉴权」，此时不因缺少 Key 而判定为未配置。

### 模型参数

| 参数 | 说明 |
| --- | --- |
| 输入上下文 | 模型能处理的最大输入 token，用于上下文窗口判断 |
| 输出上限 | 单次回复的 token 上限 |
| 支持思考 | 开启后可以逐档定义思考强度 |
| 档位 | off / minimal / low / medium / high / xhigh / max，未勾选的档位会被显式屏蔽 |

> 关于 `off`：它不会被写入 pi-ai 的 `thinkingLevelMap`。若映射成字符串 `"off"`，适配器会当作 effort 参数发给上游，而 Anthropic 的 effort 枚举里没有 `off`，会直接报错。留空让 pi-ai 使用厂商默认值，对 `off` 而言就是「不开启思考」。

## 安全

- API Key 存在 `data/credentials.json`，与可共享的 `data/settings.json` 分开。
- 两者都位于被 git 忽略的 `data/` 下，不会进仓。
- 界面只显示脱敏后的 key，不回传明文。

## 架构

```
src/
  config/env.ts              .env 加载与应用配置
  config/settings.ts         配置类型与归一化
  config/settings-store.ts   设置持久化
  config/credential-store.ts 实现 pi-ai 的 CredentialStore
  ai/models.ts               注册表构建、模型列举与解析
  ai/custom-provider.ts      自定义 provider 与 Model 构造
  ai/fetch-models.ts         上游模型拉取与合并
  ai/prompts.ts              系统提示词与工程快照
  ai/tools.ts                12 个小说写作工具
  ai/novel-agent.ts          Agent 工厂
  store/project.ts           工程数据与 JSON 持久化
  server/main.ts             HTTP、会话管理、NDJSON 流式事件
public/                      index.html / app.js / settings.js / style.css
scripts/                     测试
```

### 注册表为何能动态重建

任何设置变更都会重新执行 `createModels()` 并重新注册 provider。会话保存的是 `providerId/modelId` 字符串而不是 `Model` 对象，因此换模型时无需重建会话。

## 智能体

12 个工具绑定到单个作品工程：

| 分组 | 工具 |
| --- | --- |
| 作品 | `get_project_brief` |
| 章节 | `list_chapters` `read_chapter` `write_chapter` `update_outline` |
| 人物 | `list_characters` `upsert_character` |
| 世界观 | `list_world_facts` `set_world_fact` |
| 一致性 | `add_note` `list_notes` `resolve_note` |

系统提示词约束了工作流（写前必读、写完必落盘、不擅自修改已有内容）、文风规则和输出规范。

两个关键的工程决策：

- `toolExecution: "sequential"` —— 工具会写数据，并行执行可能丢失更新。
- `transformContext` —— 每次请求前注入当前工程快照，并丢弃过量的旧工具结果。快照每次重新生成且不进入历史，因此不会累积。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 模型、厂商、设置、工程汇总 |
| GET/PUT | `/api/settings` | 读取 / 保存默认模型与思考档位 |
| GET/POST | `/api/providers` | 供应商列表 / 新增自定义供应商 |
| PATCH/DELETE | `/api/providers/:id` | 修改 / 删除供应商 |
| DELETE | `/api/providers/:id/key` | 清除已保存的 Key |
| POST | `/api/providers/:id/models/fetch` | 从上游拉取模型 |
| POST | `/api/providers/:id/models` | 新增 / 更新单个模型参数 |
| DELETE | `/api/providers/:id/models/:modelId` | 删除模型 |
| GET/POST | `/api/projects` | 工程列表 / 新建 |
| GET | `/api/projects/:id` | 工程全量 + 统计 |
| PATCH | `/api/projects/:id/chapters/:chapterId` | 保存章节正文（稿面直接编辑） |
| POST | `/api/sessions` | 创建会话 |
| POST | `/api/sessions/:id/model` | 切换模型，保留对话历史 |
| POST | `/api/sessions/:id/messages` | 发送消息，返回 NDJSON 事件流 |
| POST | `/api/sessions/:id/abort` | 中止当前生成 |

## 测试

```bash
pnpm test          # tsc + 配置层 + 工具链路 + 智能体循环
pnpm test:config   # 归一化、凭据存储、provider 构造、档位屏蔽、拉取合并
pnpm test:tools    # 存储与 12 个工具的断言
pnpm test:loop     # 用 pi-ai faux provider 走真实的智能体循环
```

四个套件均不需要 API Key。循环测试用 pi-ai 自带的 `fauxProvider` 脚本化模型响应，真实验证「模型输出 → 工具调用 → 工具执行 → 结果回填 → 下一轮」。

## 当前限制

- 会话在内存中，服务重启后会丢失对话历史（工程与供应商配置都会保留）。
- 自定义供应商的模型参数需人工确认，上游 `/models` 接口通常不返回 token 限制。
- 没有任何模型用真实 key 跑通过一次真实 API 往返。

## 后续计划

版本历史与回滚、全文检索、导出、字数统计报表。
