# stop-slop 去 AI 味能力接入分析

> 结论先行：**能加入，但不能"安装"，只能"蒸馏"**。stop-slop 是一份英文提示词守则（SKILL.md），不是可 import 的库；
> 而且它面向说理散文，直接照搬到中文长篇小说会误伤文笔。可行做法是把它的检测清单改写成中文小说版，
> 注入现有提示词，并在已有的 polish 闭环里加确定性校验。

## 一、stop-slop 是什么

仓库 `hardikpandya/stop-slop`（19k stars，MIT），全部内容只有四个文件：

| 文件 | 内容 |
|:--|:--|
| `SKILL.md` | 8 条核心规则 + 11 条交付前自检 + 5 维评分表（Directness / Rhythm / Trust / Authenticity / Density，满分 50，低于 35 重写） |
| `references/phrases.md` | 清嗓开场（Here's the thing…）、强调拐杖（Let that sink in）、商业黑话、副词、元评论、performative emphasis、空泛断言的英文词条表 |
| `references/structures.md` | 二元对比、否定铺垫、戏剧性断句、修辞设问、假拟人（the decision emerges）、远距叙述、被动语态、Wh- 开头、三段式节奏等结构模板 |
| `references/examples.md` | 5 组 before/after 改写示例 |

它是给 AI agent 读的"编辑守则"——没有代码、没有 API、没有可执行检测，全部依赖模型自觉执行。
真正可复用的资产是**检测清单**和**评分体系**，不是实现。

## 二、为什么不能照搬

1. **语言不对**：命中的全是英文套路（"Here's the thing"、"let that sink in"、"navigate challenges"），中文小说里不会出现。
2. **文体不对**：它治的是博客/随笔/说理文的 AI 腔；本项目产出的是叙事小说正文，问题形态不同（镜头感、对白、心理描写、节奏）。
3. **部分规则对小说有害**：

| stop-slop 规则 | 对中文小说的风险 |
|:--|:--|
| 杀掉所有副词、-ly 词 | 中文的"慢慢地""忽然""轻轻"是正常叙事工具 |
| 不用破折号（em dash） | 中文破折号是标准标点，也是停顿/转折手段 |
| 每句都要有人做主语、全主动语态 | 景物与心理描写常是无主语句，强行补主语会破坏语感 |
| 两件事优于三件 | 小说三段式节奏很常见 |
| 删掉"金句感"（quotables） | 小说的可读性恰恰需要可摘录的句子 |
| 用 "you" 把读者放进场景 | 叙事文是第三人称/第一人称，不能对读者说话 |

4. **更合适的中文补充源**：`MrGeDiao/shuorenhua`（说人话，2.7k stars，MIT）。中文优先，原则是"保事实、条件、承诺、口气"，
   支持 `structural / bounded / in-place` 三档改动范围，修订稿模式逐条列改动供作者撤回；有 123 条用例与 11 篇长文评测。
   它自己就把 stop-slop 列为"英文冗余表达规则"的相关项目。中文版规则应主要蒸馏它，stop-slop 只取普适结构项。

**可普适保留的项**：删清嗓开场、删万能强调、删元评论、打破"不是 X 而是 Y"二元对比、避免假拟人（"决定浮现/局势转变"）、
少空泛断言（"意义重大"）、句式节奏有变化。

## 三、novel-studio 现有接入点（都已具备）

- `src/ai/prompts.ts:29-35`：`STYLE_RULES`，写作与素材智能体共用；`src/ai/prompts.ts:560` 注入写作系统提示词。
- `src/ai/adapt.ts:158`：`ADAPT_STYLE_RULES`，改编支线自己的文风块。
- `src/ai/polish.ts:33` `POLISH_SYSTEM_PROMPT`、`:48` `buildPolishPrompt`、`:130` `checkPolish`（现有 4 项：篇幅/段数/数字/人物，全部 `hard:false`）、`:46` `POLISH_WINDOW = 700`。
- `src/server/api-router.ts:3811` 局部改写 POST、`:3971` 采用 POST；写章路由在 `:2208`。
- `public/app/paper.js:624` `openPolish()`：`"润色这段"` 已有"选区 → 改 → 看校验 → 采用才落盘"完整闭环。
- `public/app/dock.js:15,627`：三身份（执笔者/设定官/润色）与 polish 快捷问句。
- `src/store/project.ts:434` `styleGuide`，`src/server/api-router.ts:1897` 已支持 PATCH 写入。
- 浏览器/Tauri 复用同一个 `createApiRouter()`（`src/browser/local-api.ts`），改一处三端生效。

**现成 bug**：`public/app/paper.js:770` 读 `check.note`，而 `checkPolish` 发的是 `check.detail` —— 校验明细从来没显示出来。接校验时必须一起修。

## 四、建议的三层接入方案

### 第 1 层：提示词蒸馏（成本最低，先做）

新建 `src/ai/de-slop.ts`，导出中文小说版规则文本与注入函数：

- `DE_SLOP_RULES`：只保留适合叙事的子集（见第二节末），明确"不删副词、不删破折号、不强行补主语"。
- `deSlopSection(enabled)`：可开关的提示词块，约 200–400 字，避免撑爆已经很长的写作提示词。
- 注入点：`src/ai/prompts.ts` 的 `STYLE_RULES` 之后、`src/ai/polish.ts` 的 `POLISH_SYSTEM_PROMPT`、`src/ai/adapt.ts` 的 `buildAdaptSystemPrompt`。
- 作者可用 `Project.styleGuide` 写"忌讳"（例如"不要'仿佛'开头、不要'他不禁'、少用四字格"），现有 PATCH 已支持，无需新字段。

### 第 2 层：确定性校验（真正的护栏）

扩展 `src/ai/polish.ts` 的 `PolishCheck`：

- 新增 `id: "deSlop"` 一类检查：中文套话/AI 腔字面扫描（清嗓开场、万能强调、空泛断言、二元对比模板、假拟人、AI 万能副词如"真正/切实/深度/赋能"）。
- 默认 `hard:false`（只提示、不拦落盘），避免误伤好文笔；可在设置里做成可选硬校验。
- 顺手修 `public/app/paper.js:770`：`check.detail ?? check.note`，让明细真正显示。
- 可选：让 polish 重试（api-router.ts:3908 的两轮循环）把 `verdict.feedback` 里的命中词条回灌给模型重写。

### 第 3 层：生成后评分（可选）

借用 stop-slop 的 5 维评分，中文化后用于一次性成文后的"AI 味体检"。小说正文动辄数千字，
建议只抽样段落或只报分不拦截，别把整章塞进评分提示词。

## 五、UI 接法（顺着现有三身份）

- 润色对话框 `public/app/paper.js:638`：把 `instruction` 预设按钮加一条"去 AI 味"（预填"删套话、保事实、保我的口气，只改这一段的表达"）。
- `public/app/dock.js:627` 的 polish 快捷问句加一条"这段有没有 AI 腔"。
- 可选：设置页加一个"写作默认去 AI 味"开关，关联到 `deSlopSection(enabled)`。

## 六、实施顺序与验证

1. `src/ai/de-slop.ts` 规则文本 + 三处注入 + 单元测试（新增 `scripts/de-slop-check.ts`，加入 `pnpm test`）。
2. `checkPolish` 扩展 + `paper.js` 明细 bug 修复 + 测试。
3. UI 预设 + 更新 `scripts/frontend-contracts.mjs` 与 `scripts/workbench.ts` 的契约断言。
4. 全量 `pnpm test`（含 browser/Tauri 契约）必须全绿；改动保持纯 TS、不碰 Node 专有 API，确保浏览器端 local-api 也能跑。

## 七、风险与边界

- **误伤**：字面规则对好文笔也会命中 → 只提示、不硬拦，决定权交作者。
- **提示词膨胀**：写作提示词已很长，规则块控制在 400 字内。
- **模型差异**：小模型执行规则弱，主要靠第 2 层的确定性校验兜底。
- **不是检测器**：这套东西只改"写得像 AI"的表达，不判断文章是否由 AI 生成，也不承诺过任何 AI 检测。

## 八、落地记录（第 1、2 层已实现）

按上表的前两步做完，第 3 层（五维评分体检）仍是可选、暂未做。

| 位置 | 改动 |
|:--|:--|
| `src/ai/de-slop.ts`（新增） | `DE_SLOP_RULES` 提示词守则（约 330 字，末尾一条明确"忽然/轻轻/破折号/短句"是叙事工具）、`DE_SLOP_RULES_SCAN` 六条字面规则、`scanDeSlop`、`newDeSlopHits`、`deSlopSummary` |
| `src/ai/prompts.ts:29` | `STYLE_RULES` 末尾接 `${DE_SLOP_RULES}`，执笔者与工作台会话都吃到 |
| `src/ai/adapt.ts:269` | 新增「# 改编不是重写」+ 守则：改编只改点名要改的，不往原文里加套话 |
| `src/ai/polish.ts:42` | `POLISH_SYSTEM_PROMPT` 补第 9 条：不顺手加套话，原文本来有的照留 |
| `src/ai/polish.ts:187` | `checkPolish(original, next, characters, options?)` 新增 `deSlop` 检查项，默认开、`hard:false` |
| `public/app/paper.js:643` | 润色对话框加「去 AI 味 / 更紧一点 / 白描」三颗预设，只填进输入框，不直接开跑 |
| `public/app/paper.js:785` | **修 bug**：`renderChecks` 读的是 `check.note`，而后端产出的字段是 `check.detail`，校验明细此前从未显示过 |
| `scripts/de-slop-check.ts`（新增） | 35 项断言，含"好句子一条都不该命中"的不误伤用例；已挂进 `pnpm test`（`test:slop`） |
| `scripts/frontend-contracts.mjs:412` | 钉住两件事：校验行必须读 `detail`、润色必须有去 AI 味预设 |

两个关键取舍：

1. **只比"新添的"**。`checkPolish` 用的是 `newDeSlopHits(原文, 改后)`，逐条比命中次数，多出来的才报。
   原文里本来就有的"不得不说""真正"是作者的写法，改写不该被算成回归 —— 否则每次润色都会报警，
   作者很快就会无视这一行。
2. **不设开关，只有代码级 `{ deSlop: false }`**。守则块自带"这些是叙事工具"的反向条款，
   误伤风险已经压住；再加一个设置项，作者得先知道它存在才有意义。真需要关，从调用处传参即可。

