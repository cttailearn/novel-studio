# Novel Studio

AI 长章小说创作台。当前完成的是第一阶段：基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 与 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 的模型接入与小说写作智能体。

## 快速开始

```bash
pnpm install
cp .env.example .env      # 填至少一个厂商的 API Key
pnpm dev                  # 默认 http://127.0.0.1:8787
```

没有 API Key 时服务也能启动，前端会提示哪些厂商尚未配置。

## 架构

```
src/
  config/env.ts        .env 加载与应用配置
  ai/models.ts         厂商注册、可用模型枚举、模型引用解析
  ai/prompts.ts        系统提示词与工程快照
  ai/tools.ts          12 个小说写作工具（工程存储绑定）
  ai/novel-agent.ts    Agent 工厂，注入上下文快照与会话裁剪
  store/project.ts     工程数据模型与 JSON 持久化
  server/main.ts       HTTP 服务、会话管理、NDJSON 流式事件
public/                无框架前端
scripts/               冒烟测试与智能体循环测试
```

## 模型接入

注册了 14 个厂商，均从环境变量读取 API Key。在 `src/ai/models.ts` 的 `PROVIDER_SPECS` 中增删即可。

| 厂商 | 环境变量 |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Moonshot 国内 | `MOONSHOT_API_KEY` |
| Z.ai (GLM) | `ZAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Kimi Coding | `KIMI_API_KEY` |
| OpenCode Zen | `OPENCODE_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| Groq / Mistral / xAI / Fireworks | `GROQ_API_KEY` `MISTRAL_API_KEY` `XAI_API_KEY` `FIREWORKS_API_KEY` |

模型引用支持三种形式：`provider/modelId` 精确匹配，以及 `modelId` 或 显示名在已配置厂商中搜索。

只有鉴权完整的厂商才会出现在前端模型列表里（调用 `Models.getAvailable()`）。

## 智能体

智能体绑定到单个作品工程，具备 12 个工具：

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
- `transformContext` —— 每次请求前注入当前工程快照（进度、人物、世界观、大纲、待办），并丢弃过量的旧工具结果以控制上下文窗口。快照每次重新生成且不进入历史，因此不会慽积。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 模型列表、厂商状态、工程列表 |
| GET | `/api/models` | 已配置的可用模型 |
| GET/POST | `/api/projects` | 工程列表 / 新建 |
| GET | `/api/projects/:id` | 工程全量 + 统计 |
| POST | `/api/sessions` | 创建会话，绑定作品与模型 |
| POST | `/api/sessions/:id/model` | 切换模型，保留对话历史 |
| POST | `/api/sessions/:id/messages` | 发送消息，返回 NDJSON 事件流 |
| POST | `/api/sessions/:id/abort` | 中止当前生成 |

流式事件类型：`run_start` `turn_start` `thinking_start` `thinking` `thinking_end` `text` `tool_call` `tool_start` `tool_end` `message_end` `turn_end` `run_end` `error`。

## 测试

```bash
pnpm test          # tsc --noEmit + 工具链路 + 智能体循环
pnpm test:tools    # 存储与 12 个工具的断言
pnpm test:loop     # 用 pi-ai faux provider 走完真实的智能体循环
```

两个测试均不需要 API Key。循环测试用 pi-ai 自带的 `fauxProvider` 脚本化模型响应，真实验证“模型输出 → 工具调用 → 工具执行 → 结果回填 → 下一轮” 的完整链路。

## 数据

工程数据以单个 JSON 文件存放在 `DATA_DIR`（默认 `./data`），写入后异步落盘，同一工程的写入串行化以避免覆盖。目录已在 `.gitignore` 中排除。

## 后续计划

会话当前在内存中，服务重启后会丢失对话历史（工程数据不丢失）。后续可以做：会话持久化与分支、章节编辑器、版本历史与回滚、全文检索、导出。
