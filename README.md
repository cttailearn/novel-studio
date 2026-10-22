# 墨耕 · Novel Studio

AI 长章小说创作台。基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 与 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 构建。

**一切以素材为主：通过组装素材为上下文生成正文。**

## 快速开始

```bash
pnpm install
pnpm dev                  # 默认 http://127.0.0.1:8787
```

打开页面后点右上角「设置」配置供应商与模型，无需手动编辑 `.env`。

## 两个智能体

写作被拆成两件事，由两个工具集与两套提示词完全隔离的智能体分别负责：

| 智能体 | 职责 | 产出 | 工具集 |
| --- | --- | --- | --- |
| **素材智能体**（设定官） | 把构想拆成可复用的素材条目 | `materials[]` | `createMaterialTools` |
| **组装智能体**（执笔者） | 读取某章装配的素材 + 上一章结尾，组装成正文 | `drafts[chapterId]` | `createWritingTools` |

关键约束：**素材智能体拿不到 `write_chapter`，组装智能体拿不到 `upsert_material`。**
工具边界就是职责边界 —— 没有写入正文的工具，模型就无法跳过素材直接交正文。
`scripts/smoke.ts` 对这个边界有显式断言，防止以后回退。

两个角色的 `transformContext` 都按 `scope` 注入工程快照，但内容刻意不同：

- `material` 给**全库索引**（id / kind / title / usage），不给全文 —— 否则素材一多就占满窗口。
- `writing` 给**本章素材全文**，不给全库 —— 执笔者只需要本章的料。

## 素材模型

素材是可复用的创作单位：它描述"这个世界是什么样、这场戏要发生什么、这个人说话什么调"，
正文是拿素材组装出来的产物。所以素材要自包含，脱离任何具体章节也能读懂。

| 字段 | 说明 |
| --- | --- |
| `kind` | 13 种：`premise` 核心设定、`character` 人物、`world` 世界观、`location` 场景地点、`plot` 情节线、`beat` 桥段、`scene` 场景卡、`dialogue` 对话、`imagery` 意象、`foreshadow` 伏笔、`style` 文风、`research` 考据、`other` 其他 |
| `usage` | **必填**。什么情况下该用这条素材。组装智能体靠它判断相关性；写"用于推进剧情"等于没写 |
| `chapterIds` | 显式装配到哪些章节。与章节的 `materialIds` 双向同步 |
| `status` | `draft` / `confirmed` |
| `source` | `human` / `agent` / `library`，用于区分书者所定、墨客所拟与取自素材库 |

章节（`OutlineChapter.materialIds`）与正文（`ChapterDraft.materialIds`）都记录素材 id：
前者是**计划**用什么料，后者是**实际**用了什么料，用于回溯"这段正文从什么料来"。

旧数据（`characters` / `worldFacts`）在读取时单向迁移成素材，迁移幂等，输出里不再有旧字段。


### 通用素材库：复制，不是引用

`Material` 多一个 `originId`：取自素材库时记下来源条目，用于回溯"这条料是从库里哪一条来的"，
也让作品里的改动可以推回库里那一条。`source` 因此多一个取值 `library`（取自素材库）。

取用刻意做成**复制**而不是引用：

- 作者会为这本书改动副本（人物年龄、地名口径），改动不该反噬别的作品；
- 删掉库里的条目不该让已有作品缺料；
- 作品文件因此始终自包含 —— 拷走一个 JSON 就是完整的一本书。

代价是两边不会自动同步。要同步就显式做：「更新素材库」把作品里的改动推回去，
但已经取用过这条料的别的作品手里仍是它们各自的副本 —— 这一点在确认框里写明了。

## 界面：水墨案头

界面分两级，不是一排并列的页：**案头**（选卷、管素材）与**写作台**（进卷之后才写）。

**为什么是浅色。** 水墨是纸上的媒介，深色底做水墨本质上是伪滤镜。暖白宣纸面对长时间读长文本，也比纯白更省眼。所以配色是宣纸、墨、朱砂三色，其余一律不用。

### 案头

进书之前、出书之后的落脚处。左栏管作品，右栏管**通用素材库**。

| 栏 | 内容 |
| --- | --- |
| 左 | **卷宗**：每部作品的题名、门类、骨相与统计；开卷 / 改 / 删（删要点两次） |
| 右 | **通用素材库**：跨作品的料，按 kind 分组与筛选，标注「已用于哪几部作品」；看全文 / 改 / 删 |

案头是独立的一屏：左卷与右案都收起，顶栏也不出现模型与推理档位 —— 那些是写作时的选择，
选卷之前没必要摆出来。没有作品时也落在这里，不会落在一个空稿台上。

新建只需填**书名**：门类标了「选填」，骨相、字数、行文规约都收在「更多设置」里，默认不展开。
它们之后在「案头 → 改」里随时能补 —— 起手时先把卷立起来，别让表单挡住开写。

「另起一卷」时可以直接勾选库里的料打底 —— 取的是**副本**，所以之后为这本书改动它，不会反噬别的作品；
删掉库里的条目，也不会让已有作品缺料。反过来，在作品里把一条料改好了，卡片上有「存入素材库」：
没有来源的存成新条目，取自库里的则可以「更新那一条」或「另存为新条目」。

### 写作台

点「开卷」进卷，顶栏出现「← 案头」；左卷只剩章目 —— 选卷这件事已经交给案头了。

| 区域 | 作用 |
| --- | --- |
| 顶栏 | ← 案头、书名、进度（含装料覆盖率）、模型与推理档位、检索、快捷键、昼夜 |
| 左卷 | 章目（带字数与装料数，未写的章点朱砂点），可按标题 / 要略检索 |
| 中台 | **稿**（读稿 / 改稿）、**料**（素材工作台）、**文**（生文工作台） |
| 右案 | 素材 / 大纲 / 待办，随写随查；可检索；窄屏下收成可呼出的抽屉；进工作台时收起，把宽度让给正文 |

停在案头还是写作台、上次在写哪一部、上次翻到哪一章，都记在浏览器的 localStorage 里，刷新不丢位置。

#### 稿面：自动存稿与版本

改稿不再是「改完记得点存稿」：

- **停顿约 1.4 秒自动写盘**，操作条上显示「未存 / 存稿中… / 已存 20:31」，`Ctrl/Cmd+S` 立即存。
- 切章、切页、回案头、导出、开版本列表之前都会先把未存的改动落盘；写盘失败会明确问一句再走，关页时浏览器也会拦一下。
- 自动存稿带 `autosave` 标记，只更新正文，不占版本历史；手动「存稿」与执笔者成文才是版本点。
- **版本**抽屉列出这一章最近 10 版（来源、时间、字数、装料数），可展开读全文、一键恢复。恢复前会把当前稿另存一版，所以回滚本身也能再撤回。
- **导出**改成对话框：范围（这一章 / 全书）与格式（TXT / Markdown）一次选清，导出的稿子保持原样。
- **排版**可调字号、行距、版心，偏好只存本机浏览器；**专注**隐藏左右两栏与页签，`Esc` 退出。
- 工具栏还有「总目 / 前章 / 后章」与「让执笔者评此章」；`Alt+↑/↓` 直接翻章。

#### 检索与键盘

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/Cmd+K` | 检索面板：搜章目、素材、通用素材，或直接执行动作（切页、立章、导出、排版、存照、回案头…） |
| `Ctrl/Cmd+S` | 立即存稿（改稿时） |
| `Ctrl/Cmd+1/2/3` | 切到 稿 / 料 / 文 |
| `Alt+↑/↓` | 上一章 / 下一章 |
| `Esc` | 退出专注 / 退出改稿 / 关闭弹窗 |
| `?` | 键盘说明 |

素材、通用素材库、章目与右案都有就地检索框；检索只影响当前视图，换卷自动复位。

#### 反馈与流式

- 底部浮出短提示统一承接成功与错误，不再用系统 alert 打断写作。
- 上游首字到来前显示「正在落笔… N 秒」，可随时「止笔」；作者向上翻读时流式输出不再强行贴底。
- 服务重启或会话过期后，下一次发话会自动重开一席，不必手动点两次「另起一席」。
- 文件拖到非上传区会被拦下并提示去处，避免浏览器直接打开文件、连带丢掉未保存的稿件。

**上游断流怎么报**：一轮最多只出现一条红字，报文里带「等了多久」与上游的原话。

| 情形 | 界面上看到 |
| --- | --- |
| 上游一个字符也没回就断了 | 「上游没有返回任何内容就断流了（等了 3 分 12 秒，最后报错：Request timed out.）。常见原因：额度用尽、Key 失效、中转服务限流，或模型名不被上游接受。可到设置里换一个模型或供应商再试。」 |
| 写了一半才断 | 「本轮已经产出一部分正文，随后上游报错断流（…）。已写出的内容不会自动回退，可先核对正文；反复失败时换一个模型或供应商再试。」 |
| 作者自己「止笔」 | 不算错误：不报红字，`run_end.aborted` 为真 |

取舍：

- **单次上游请求等 3 分钟（`timeoutMs = 180_000`），断了再试 2 次（`maxRetries = 2`）。** SDK 的默认是「等满 10 分钟、一次都不重试」——那是最坏的体验：对着一个已经死掉的连接干等十分钟，然后只得到一句 `Request timed out.`。三分钟能分清「偶发挂起」和「Key 真的废了」。
- **这个 3 分钟是每次尝试的等待上限，不是整轮的总预算。** 上游彻底挂死时，三次各等满 3 分钟，最坏约 9 分钟才吐最终错误。要「整轮最多 3 分钟」得另做总预算，本轮没做。
- **失败时把话还回输入框。** 提交那一刻就清了输入框（按下去立刻有反应），但这一轮要是断在上游，那句话就没着落了。失败时它会回到原框里 —— 只在框还空着时回，别盖掉作者新写的话。止笔不算失败，不还。
- **pi-ai 的 google-generative-ai 适配器不读 `timeoutMs` / `maxRetries`。** 走 Google 协议的自定义供应商暂时拿不到这层兜底。

### 料 · 素材工作台

| 栏 | 内容 |
| --- | --- |
| 左 | **上传原料**（点选或拖放）+ **素材库**（按 kind 分组、筛选 chip、检索标题 / 用法 / 正文 / 标签，看全文 / 装料 / 改 / 删） |
| 右 | **设定官**对话：立章目、补人物、查前后矛盾、把资料拆成素材 |

上传的原料有两条去路：

- **存入素材库**：弹出表单，作者选定 kind、标题、`usage`，整篇成为一条素材（`source: human`、`status: confirmed`）。
- **交墨客提炼**：整篇丢给设定官，让它按人物 / 世界观 / 场景 / 桥段各归其类，逐条 `upsert_material` 落盘。

### 文 · 生文工作台

| 栏 | 内容 |
| --- | --- |
| 左 | **装配**（本章已装的料，可摘除）+ 作业性质 + **装料成文** + **库中可装**（可装入） |
| 右 | **执笔者**对话：写出这一章、把第二段改冷一点、让结尾再狠一些 |

装料是作者可以直接做的事，不必绕道智能体 —— 它和 `attach_materials` 写的是同一份数据。
点「装料成文」时，下方输入框里的**交代会一并附上**（例如「写得冷一点」），
所以既能纯装料成文，也能带着要求成文。

关键取舍：

- **智能体的话直接排成正文，不装进气泡。** 墨客的产出是稿子，不是消息。
- **工具调用收成「旁批」。** 一根细墨线加小字，不打断阅读。
- **文稿区有朱丝栏。** 稿纸的竖向界线，透明度压到 0.055，只作肌理不干扰阅读。
- **首行缩进两格、行高 2.05。** 中文小说的排版规矩。
- **版心三档 45 / 54 / 66em，默认 54em。** `em` 的基准是 `body` 的 `--fs-md`（14px），所以默认约 756px、一屏四十来字；旧偏好里的 30/36/44 读进来时按 1.5 倍迁移，不然老用户永远停在窄版心上。
- **操作条吸顶且不透明，正文滚到条子下缘就化掉。** 滚动容器 `#view-manuscript` 的**上留白必须是零**——容器一旦有 `padding-top`，吸顶条就被垫下去，台口永远留一道缝（`--ms-pad-t` 因此改挂在稿纸 `.ms-page` / 总目 `.front-matter` 上）。条子还要显式 `z-index`——稿纸带淡入动画，动画期的 `opacity` 让它自成一个层叠上下文，只给定位不给层级的话正文会画到按钮上面去。下缘用同色纸投影渐隐，是淡出不是刀切。
- **改稿用等宽等行距的 textarea。** 阅读态与编辑态切换无跳变。
- **纸纹是 SVG 噪声，透明度 0.05。** 再高就成电视雪花。
- **选中态是墨晕不是色块。** `radial-gradient` 从左侧晕开，配朱砂细竖线。
- **删素材要点两次。** 第二次才真删，且会连带清掉各章装配清单里的引用。

字体：正文与文稿用宋体（Songti SC / SimSun / Noto Serif SC），标题与印章用楷体（Kaiti SC / KaiTi），控件用系统无衬线。全部为系统字体栈，不联网加载 CJK 字体。

### 两栏之间的提手

「料」与「文」两个工作台都是两栏，中间那条界格能拖。

| 处 | 做法 |
| --- | --- |
| 拖动 | 捏住界格左右拖；左栏占比记在 `--bench-a`（百分比），栅格自己重算 |
| 落点 | 夹在 26%–74% 之间，默认 50%；比例记在 `localStorage`（`novel-studio/split/materials` / `.../writing`），下次打开还在原处 |
| 键盘 | 提手可以聚焦：`←` `→` 每次 2%，`Home` / `End` 回中 |
| 鼠标 | 双击界格复位到 50% |
| 窄窗 | ≤1180px 两栏叠起来，提手消失（叠着的时候没有「两栏的比例」可言） |

取舍：

- **提手绝对定位，不占栅格轨道。** 插成一个栅格项就变成三栏，右栏还会被挤掉一缝。
- **案头三栏（`.bench-three`）不动。** 案头是「卷宗 / 素材 / 待办」的并置，没有主次之分，拖它只会让人以为某一栏更主要。
- **两栏的内容随宽度变。** 窄栏自动收边距、素材栅格并成单列、长串（URL、用法、标签）一律 `overflow-wrap: anywhere`；输入框补 `min-width: 0`（textarea 默认按 20 列算固有宽度，不补会被侧边按钮顶出行外）；对话气泡宽度改 `min(46em, 100%)`。

### 书斋的几处讲究

界面不是「把水墨贴上去」，而是按一册书的装帧来排：

| 处 | 做法 | 为什么 |
| --- | --- | --- |
| 面板 | 双线框（外细线 + 内高光）全部走 `box-shadow`，不用 `border` | `border` 会改盒模型，窄屏一改就是整页位移；`box-shadow` 不占位，≥900px 零位移 |
| 栏头 | 楷体标题 + 字距 + 左侧 3px 朱砂小印，L 形赭金角花用 4 层渐变拼 | 题签是书页的入口，不是普通 `h3` |
| 章目 | 整卷画一条朱丝栏（画在列表容器上，不画在条目上） | 条目换行或 hover 时竖线不能断 |
| 状态 | 印章式方印：`.stamp` 朱砂 / `--moss` / `--tea` / 实心 | 一个字的方印比色点好认，暗色下也分得清 |
| 分隔 | 回纹带（`.fret`，透明度压到 0.5 以下） | 是纹样不是边界，看得清纹路、看不清线 |
| 空态 | 远山压底（`--mountains`） | 空白处也要像一张纸，不像没加载完 |
| 首屏 | 「研墨中…」骨架（`.sk-line` 流光） | 开机要先问过 bootstrap 与 library 才画得出界面，这段不能是白屏 |

显示侧的取舍：字号与间距是一套阶梯（`--fs-xs..xl` / `--sp-1..6`），最小 11.5px，不再有更小的字；滚动条收到 8px 并改用 `--rule-strong`（`--ink-4` 在暗色下几乎看不见）；焦点环统一朱砂 3px；系统开了「减少动态效果」时墨晕、骨架流光、稿纸淡入一律收掉。


## 移动端

同一套界面在手机上可用，桌面端零回退。断点分三档：≤1240px 右案改抽屉，≤900px 触屏通例（触控目标 ≥44px），≤640px 手机专用布局。

| 位置 | 手机上的样子 |
| --- | --- |
| 顶栏 | 换行成两排；模型与档位收进「笔」浮层，浮层自带标题与「×」，点浮层外、按 Esc 或安卓返回键都能收起 |
| 章目 | 左侧抽屉，默认收起，顶栏「目」打开，划一下左边缘或点遮罩关闭 |
| 稿面 | 留白收到 18/16/88px，正文最小 16px（iOS 聚焦不再自动放大） |
| 弹层 | 全部 dialog 变 `100vw × 100dvh` 全屏，圆角归零，内部自己滚 |
| 表单 | 移动端字号统一 ≥16px（低于 16px iOS 会自动放大页面） |
| 素材 | 手指点卡片 = 选中，底部「装进本章 / 送执笔者」，不必拖拽 |
| 设置 | 供应商列表与详情是两页，详情首行是钉住的「← 返回供应商列表」 |

几处硬规矩：

- **不禁止缩放。** 正文放大是读长章的人自己的权利，viewport 里没有 `user-scalable=no`。
- **用 `dvh` 而不是 `vh`。** iOS 地址栏收缩时 `100vh` 会留一段空白，桌面端保留 `100vh` 回退。
- **安全区用 `env(safe-area-inset-*)`。** 刘海与 Home Indicator 之下不留内容，也不压住顶栏与 toast。
- **触屏不做 hover 依赖。** `@media(hover:none)` 下卡片不再因 hover 抬起，常驻动作条始终可见，焦点环加粗到 3px。
- **返回键先关弹层，不退出应用。** 每个弹层与抽屉在 `history` 里占一格（`openLayer` / `closeLayer`），返回键只关最上面一层；自己按 Esc 关掉时用 `history.back()` 退回那一格，并留 1 秒「认账窗口」，所以不会出现「Esc 一下关两层」或「第一次 back 就退出」。
- **软键盘让位。** viewport 带 `interactive-widget=resizes-content`，聚焦的输入框只有落在下半屏且底边被遮住时才滚上来 —— 见框就滚，会让人还没开始打字屏幕先跳一下。
- **触控目标 ≥48px。** 顶栏的「目 / 笔 / 案」在手机上只留一个楷体单字，全名在 `aria-label` 与长按 `title` 里。
- **可装到主屏。** 有 `manifest.json` 与 `icon.svg`（朱砂方章），`display: standalone`。注意它要求同源 + HTTPS 或 `localhost`：用局域网 IP 打开时 Chrome 不显示「添加到主屏幕」，这是浏览器策略，不是配置问题。
- 桌面端（≥900px）布局与行为与从前完全一致：新增元素都带 `only-phone`，顶栏的模型与档位用 `display:contents` 还原成原来那一行。

取舍：手机上「料」「文」两页沿用桌面 ≤1180px 的降级 —— 章目栏不出现（案头与料/文页都没有章目入口），要跳章回稿面页。

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
- 上游报出了限制而你**还没核对过**（还是占位值）时，那一项会被回填；手填过的值不动。回填了哪几个模型会写在响应的 `backfilled` 里

旁边还有一个「测试连接」：它打的是同一套上游探测，只验**连通与鉴权**，不产生 token 消耗。
结果提示条贴在详情栏顶部，点一下可以收起。注意它只探模型列表 —— 列表能拉通不等于能生成，
额度用尽这类问题要真发一次请求才看得出来。

自建或本地服务（Ollama、vLLM 等）可勾选「该服务不需要鉴权」，此时不因缺少 Key 而判定为未配置。

### 模型参数

| 参数 | 说明 |
| --- | --- |
| 输入上下文 | 模型能处理的最大输入 token，用于上下文窗口判断 |
| 输出上限 | 单次回复的 token 上限 |
| 支持思考 | 开启后可以逐档定义思考强度 |
| 档位 | off / minimal / low / medium / high / xhigh / max，未勾选的档位会被显式屏蔽 |
| 成本 | 输入 / 输出每百万 token 的价格，用来粗估一章要花多少 |

> 关于 `off`：它不会被写入 pi-ai 的 `thinkingLevelMap`。若映射成字符串 `"off"`，适配器会当作 effort 参数发给上游，而 Anthropic 的 effort 枚举里没有 `off`，会直接报错。留空让 pi-ai 使用厂商默认值，对 `off` 而言就是「不开启思考」。

### 模型区怎么用

模型区不是一张宽表格了：三十个模型的供应商在窄屏上根本读不完，一行六个思考档位复选框更是把表格撑到要横向滚动。现在是**检索 + 卡片行 + 批量**。

- **检索**：顶部搜索框按模型 id 或名称过滤，只重画列表不重画输入框，打字不丢焦点。旁边一行统计：共 N 个 / 显示 N 个 / 待核对 N 个 / 不可用 N 个。
- **待核对**：`contextWindow` / `maxTokens` 仍是占位默认值（1M / 128K）的模型会挂上徽标。占位值**不是探测结果**，只是「还没从上游取到真实限制」的兜底，所以标成待核对而不是猜一个数填上。
- **批量**：勾选若干模型（或直接用「应用到待核对（N）」）一次改上下文窗口、输出上限、思考开关与档位，走 `PATCH /api/providers/:id/models`。
- **按上游回填**：拉一次上游模型，服务端把上游报出来的上限**写回仍是占位值的那些模型**。上游没报（例如 OpenAI 兼容的 `/models` 只回 id）就保持不动，界面如实说「上游没有报出可回填的限制，仍需人工核对」，不假装成功。手填过的值永远不会被覆盖。
- **档位 chip**：六个档位排成可勾的 chip。关闭思考时档位锁在「不思(off)」且全部禁用；打开后如果一个非 off 档位都没选，会自动回到全选 —— 不会出现「支持思考但没有档位」的半截状态。
- **成本**：每个模型可填输入 / 输出的每百万 token 价格。默认笔那一栏给出粗估（一章 3000 字 ≈ ¥x.xx，按 1 字 ≈ 0.7 token 换算）；没填成本显示「未填成本」而不是 ¥0。
- **默认笔**：下拉按供应商分组（`optgroup`），带搜索框；不可用的模型在选项里标出原因（供应商已停用 / 未配置密钥 / 未注册）。选了不支持思考的模型会提示「当前档位不会生效」。

### 书斋里的框

设置页原先是「标签在上、输入框铺满整栏」，Base URL 那种长地址一格拉出去三行，右侧空出一大片纸，看着像没排完。现在按一册书的装帧收：

| 处 | 做法 | 为什么 |
| --- | --- | --- |
| 字段 | 标签占 92px 固定一列，控件另起一列，宽到 520 就收住（Base URL 640） | 铺满的输入框看不出栏宽；定宽一列才像一册账页 |
| 细则 | 长说明收进 `<details>`（`.fold`），标题只留「有几处要留意」 | 「待核对」什么意思得说，但不必一直杵在列表上方 |
| 提示 | 一句话能说完的留在框下，长话挪进 `title`（悬停/长按可见） | 灰色长段把说明变成噪音 |
| 字号 | 输入框一律 16px 起 | 安卓/iOS 上小于 16px 一聚焦就放大整页，视线全跑掉 |
| 手机 | 标签在上、控件在下，控件最小 48px | 一列塞不下「标签 + 控件 + 提示」 |

## 安全

- API Key 存在 `data/credentials.json`，与可共享的 `data/settings.json` 分开。
- 两者都位于被 git 忽略的 `data/` 下，不会进仓。
- 界面只显示脱敏后的 key，不回传明文。
- 落盘用「随机名临时文件 + rename + 重试」：临时名唯一，避免多实例并发写互相覆盖；重试是因为 Windows 上 rename 覆盖已存在文件会偶发 `EPERM`。

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
  ai/prompts.ts              两套系统提示词 + 按 scope 的工程快照
  ai/tools.ts                素材工具集与写作工具集
  ai/novel-agent.ts          Agent 工厂（按 role 分派工具与提示词）
  store/project.ts           工程数据、素材模型、装配双向同步与 JSON 持久化
  store/library.ts           通用素材库（跨作品的一层）与取用 / 回推
  server/upload.ts           上传原料的文本提取（纯文本 + docx 解包）
  server/main.ts             HTTP、会话管理、NDJSON 流式事件
public/                      index.html / app.js / settings.js / style.css
scripts/                     测试
```

### 注册表为何能动态重建

任何设置变更都会重新执行 `createModels()` 并重新注册 provider。会话保存的是 `providerId/modelId` 字符串而不是 `Model` 对象，因此换模型时无需重建会话。

### 会话与并发

- **素材会话**常驻（`POST /api/sessions`，`role: "material"`），保留多轮对话 —— 备料是一个来回商量的过程。
- **写作会话**同样常驻（`role: "writing"` + `chapterId`），是生文工作台的问答通道：作者可以追问、局部改稿。
  前端按 `writing:<chapterId>` 分桶保存会话与对话快照，换章不丢上下文。
- **一次性成文**（`POST /api/projects/:id/chapters/:chapterId/write`）不建会话、不留历史，用完即弃。
  两条路都能写正文，区别只在「要不要接着聊」。
- `toolExecution: "sequential"` —— 工具会写数据，并行执行可能丢失更新。
- 同一章节的写入共用一把按章的锁（`ProjectStore.withChapterLock`）：智能体的 `write_chapter` 与作者在稿面直接保存（`PATCH /chapters/:id`）都是整段覆盖，不加锁会让先写的内容无声消失。

## 智能体工具

素材工具集（10 个）：

| 分组 | 工具 |
| --- | --- |
| 作品 | `get_project_brief` |
| 章节 | `list_chapters` `read_chapter` `update_outline` |
| 素材 | `list_materials` `upsert_material` `attach_materials` |
| 一致性 | `add_note` `list_notes` `resolve_note` |

写作工具集（8 个）：`get_project_brief` `list_chapters` `read_chapter` `list_materials` `write_chapter` `add_note` `list_notes` `resolve_note`。

两套工具共用的只读部分实现于同一处，但**可写工具互不重叠**。系统提示词各自约束工作流、工具纪律与输出规范。

执笔者的提示词有两种作业：

- **一次性成文**（`/write`）：作业由调用方指定，`mode` 与提示词严格一致。`write_chapter` 是整段覆盖，
  若提示词说「继续往后写」而调用方要的是重写，交出来的会是个残篇。
- **工作台会话**（`role: "writing"`）：不预设作业，作者在对话里逐条交代，模型先判断他要什么再动手。
  系统提示词里写着本章装了哪些料，而它是建会话时一次性拼好的 —— 所以**每轮消息前重建智能体**，
  只换开头那条系统消息、保留对话。否则作者中途装料或摘料后，模型看到的依据就是旧的：
  新装的料这一轮用不上，已摘掉的料还会被当成已经定下的事实。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 模型、厂商、设置、工程汇总 |
| GET/PUT | `/api/settings` | 读取 / 保存默认模型与思考档位 |
| GET/POST | `/api/providers` | 供应商列表 / 新增自定义供应商 |
| PATCH/DELETE | `/api/providers/:id` | 修改 / 删除供应商 |
| DELETE | `/api/providers/:id/key` | 清除已保存的 Key |
| POST | `/api/providers/:id/models/fetch` | 从上游拉取模型（响应含 `backfilled`：本次从上游回填了限制的模型 id） |
| POST | `/api/providers/:id/models` | 新增 / 更新单个模型参数（只提交改动的字段，其余保留原值） |
| PATCH | `/api/providers/:id/models` | **批量**改模型参数：`{ ids?, contextWindow?, maxTokens?, reasoning?, thinkingLevels? }`，`ids` 缺省=全部模型，响应 `{ updated }` |
| DELETE | `/api/providers/:id/models/:modelId` | 删除模型 |
| GET/POST | `/api/library` | 通用素材库：列表（含取用情况）/ 收录一条 |
| PATCH/DELETE | `/api/library/:libraryId` | 改 / 删库条目 |
| GET/POST | `/api/projects` | 作品列表（摘要 + 统计）/ 新建（可带 `libraryIds`） |
| GET/PATCH/DELETE | `/api/projects/:id` | 作品全量 / 改题名与规约 / 删作品 |
| POST | `/api/projects/:id/chapters` | **立一章**：`{ title, summary?, pov?, targetWords? }` |
| GET | `/api/projects/:id/export` | 导出全书或单章：`?chapter=`、`?format=md` |
| GET | `/api/projects/:id/snapshots` | 工程快照列表 |
| POST | `/api/projects/:id/snapshots/:name` | 回滚到某份快照（回滚前再自动存一份） |
| POST | `/api/projects/:id/uploads` | **上传原料**：`?filename=` + 原始字节，只提取文本不落盘 |
| POST | `/api/uploads` | 库作用域的上传（不绑作品，供案头的设定官用） |
| GET/POST | `/api/projects/:id/materials` | 素材列表（`?kind=` 过滤）/ 新建素材 |
| PATCH/DELETE | `/api/projects/:id/materials/:materialId` | 改 / 删单条素材 |
| POST | `/api/projects/:id/materials/:materialId/library` | **存回素材库**：`{ mode, title? }` |
| POST | `/api/projects/:id/chapters/:chapterId/materials` | **装配**：`{ add, remove }`，双向同步 |
| PATCH | `/api/projects/:id/chapters/:chapterId` | 保存章节正文（稿面直接编辑；`autosave` 见下） |
| POST | `/api/projects/:id/chapters/:chapterId/write` | **一次性成文**：组装素材生成正文，返回 NDJSON 事件流 |
| POST | `/api/sessions` | 创建会话（`role: material` / `writing`） |
| POST | `/api/sessions/:id/model` | 切换模型，保留对话历史（生成中返回 409） |
| POST | `/api/sessions/:id/messages` | 发送消息，返回 NDJSON 事件流 |
| POST | `/api/sessions/:id/abort` | 中止当前生成 |
| DELETE | `/api/sessions/:id` | 弃掉一席会话 |
| GET | `/api/storage` | 落盘健康：待重试的作品与具体章节 |
| POST | `/api/storage/retry` | 立即重试未落盘的写入 |

`GET /api/models` 的每一项带两个新字段：`placeholder`（上下文与输出上限是否还是占位默认值，即「待核对」）与 `cost`（每百万 token 的输入 / 输出 / 缓存读 / 缓存写价格）。设置页据此打「待核对」徽标、显示成本编辑区；字段缺失时前端会自己按占位默认值比较，不至于整页报错。

`PATCH /api/providers/:id/models` 的 body：`{ ids?, contextWindow?, maxTokens?, reasoning?, thinkingLevels? }`。
`ids` 缺省或为空数组 = 该供应商**全部**模型；每个字段独立可选，没出现的字段一律不修改。
`contextWindow` / `maxTokens` 必须是正整数（否则 **400**），`thinkingLevels` 必须是合法档位的子集（否则 **400**）。
`reasoning: false` 会把档位强制成 `["off"]`；`reasoning: true` 而档位全是 `off` 时，退回该模型原有的非 off 档位。
响应 `{ updated }` 只列**真的被改动**的模型 id —— 值与原来一样就不算改动。

`PATCH /chapters/:id` 的 body 是 `{ content, autosave? }`。带 `autosave: true` 时只更新正文与修订号，
不追加版本历史（前端每 1.4 秒的自动存稿走这条）；显式存稿与智能体成文才归档旧稿。新旧内容按
trim 后比较，完全相同也不重复归档。该章不存在时返回 **404**。客户端断开连接会中止正在进行的
生成；请求体与上传都有大小上限（超限 **413**）。

`/write` 的 body：`{ modelRef, thinkingLevel, mode: "create" | "rewrite" | "continue", note }`。
该章没有装配任何素材时返回 **409** 并说明原因 —— 不给执笔者一个空清单去硬编。

`/uploads` 的 body 是原始字节（`application/octet-stream`），文件名走 query。支持 `.txt / .md / .csv /
.json / .yaml / .html / .xml / .docx`，其中 `.docx` 由服务端自己解 zip 再剥 XML（不引依赖）。
其余格式返回 **415** 并说明该转成什么。提取结果只回给前端预览，服务端不留档。

`/chapters/:id/materials` 与智能体的 `attach_materials` 共用 `linkMaterials`，
所以「人装的料」和「墨客装的料」不会把双向索引写歪。未知 id 会跳过，并在 `skipped` 里如实回报。

`/api/library` 是**跨作品**的一层：库里的料不属于任何一部小说。`GET` 返回条目 + 取用情况 + 种类表，
其中 `usedBy` 由服务端扫描各作品现算，不落盘 —— 所以不会出现"库里说用过、作品里查不到"。

`POST /api/projects` 的 body 可以带 `libraryIds`：新建时从库里取料，取的是**副本** ——
新 id、`chapterIds` 清空、`source: "library"`，并记下 `originId`。之后的改动不回写库。

`POST /api/projects/:id/materials/:materialId/library` 是反向动作：把作品里改好的料存回库。
body `{ mode: "create" | "update", title? }`。`update` 覆盖 `originId` 指向的那一条；
这条料没有来源条目时返回 **409**，改用 `create` 另存为新条目。

## 测试

```bash
pnpm test          # tsc + 配置层 + 工具链路 + 接口契约 + 智能体循环
pnpm test:config   # 归一化、凭据存储、provider 构造、档位屏蔽、拉取合并
pnpm test:tools    # 存储、素材模型、两套工具集与提示词、上传解析、通用素材库
pnpm test:server   # 真起一个服务进程，走真实 HTTP 验接口契约
pnpm test:loop     # 用 pi-ai faux provider 走真实的智能体循环
```

五个套件均不需要 API Key。`test:loop` 用 pi-ai 自带的 `fauxProvider` 脚本化模型响应，
分别走完**素材智能体**（立章 → 造料并装料 → 收尾）与**组装智能体**（装料成文）的完整链路。

`test:tools` 断言了几件容易被后续改动破坏的事：

- 素材工具集不含 `write_chapter`，写作工具集不含 `upsert_material` / `attach_materials` / `update_outline`
- `write_chapter` 拒绝章目里不存在的 `chapterId`，不会造出幽灵正文
- `usage` 落盘、`chapterIds` 与 `materialIds` 双向同步、移除装料时反向关联也清掉
- 首次写入正文时继承本章的装配清单；只改标题时装配清单保持原样
- 挂不存在的素材会被忽略；`chapterIds` 传空表等于从所有章节摘除
- `update_outline` 装料时反向同步素材的 `chapterIds`
- 素材快照含索引与 `usage` 但不含全文；写作快照含本章全文但不含全库索引
- 章节写锁下并发写入都生效
- 工作台会话的提示词不预设「整章重写」，一次性成文仍要求「一次写完」
- `linkMaterials` / `assembledMaterials` / `removeMaterial` 的边界：幽灵 id、悬空 id、重复装料、删素材后的连带清理
- 上传解析：BOM、空行折叠、HTML 剥标签、docx 段落与行内换行、未压缩条目、实体解码、坏 zip 报错、超长截断
- 通用素材库：取用是复制（新 id、清空装配、记 `originId`、来源标为 `library`、不共享标签数组），回推不带 id 与时间戳
- `library.json` 不被 `ProjectStore` 当成一部作品；库文件损坏时按空库处理
- 自动存稿（`autosave`）只递增修订号、不占版本历史；同内容不重复归档；超长中文章号可落盘；单章写失败不会被别的成功写入清掉
- 设置文件损坏时隔离为 `.corrupt-<时间戳>`，不静默覆盖用户配置

`test:server` 在临时目录里起一个真实服务进程（先探测空闲端口再传 `PORT`），
断言上传 / 素材增删改 / 章节装料 / 成文前置校验 / 会话校验 / 静态资源与路径遍历这些 HTTP 契约，
以及通用素材库的收录、取用、回推，和卷宗的改 / 删。另用本地假上游验证「生成中换模型 409」
与「客户端断开即中止上游」，用原始 TCP 请求验证畸形请求行回 400、超大请求体回 413；
`PATCH` 不存在的章节回 404 且不产生幽灵草稿。

## 当前限制

- 会话在内存中，服务重启后会丢失对话历史（工程与供应商配置都会保留）。前端会在会话过期后自动重开一席。
- 自动存稿依赖服务可达：服务断开时改动仍留在编辑框里，界面会提示；关页前的浏览器拦截只在有未存改动时出现。
- 版本历史每章保留最近 10 版；恢复某版会新增一版，不做逐字 diff。
- 导出只有 TXT 与 Markdown，尚无 docx / epub。
- 章节暂时只能「立」与改正文，改名、删除、排序还没有专门界面；改名可走设定官 `update_outline`。
- 检索只在已加载的当前作品与通用素材库内进行，不跨作品扫正文。
- 上传只认 UTF-8 与 `.docx`：`.pdf` / `.epub` / `.doc` 会被明确拒绝，而不是塞乱码给模型。GBK 编码的文本会解成乱码，需先转存为 UTF-8。
- 上传的原料不落盘：提取结果只在前端内存里，刷新页面就没了（已入库的素材不受影响）。
- 工作台会话注入的是**本章**素材全文。一章装料过多时，上下文会被素材本身占满；单次上传超过 20 万字会截断，超过 6 万字时界面会提示。
- 素材质量取决于 `usage` 写得够不够具体。schema 里它是必填，但模型仍可能敷衍。
- 自定义供应商的模型参数需人工确认，上游 `/models` 接口通常不返回 token 限制 —— 设置页的批量与「按上游回填」能少改几遍，但改不了的还是得自己填。
- 执笔者偶尔会重复调用 `write_chapter`（同一轮里写两遍）。提示词里的「整章落地」约束力有限，好在第二次通常更好。
- 上游把错误塞在 HTTP 200 的响应体里时（额度用尽、限流都会这样），本地只看得到「没有 finish_reason」。
  服务端在「一个字都没收到」的情况下会额外给一句提示，但真因仍需到上游控制台核对 ——
  这条是在真实环境里踩出来的：中转服务返回 `status_code: 2067`（Token Plan 用量上限），
  而 HTTP 状态是 200，`choices` 为 `null`。
- 通用素材库的取用是复制：作品里改了副本，别的作品与库里都不会跟着变，要同步得显式「更新素材库」。
- 库与作品之间没有引用关系，所以删库条目不影响已有作品，反过来也一样 —— 这是刻意的，不是没做。

## 后续计划

会话持久化、上传原料留档以便重跑提炼、章节改名 / 删除 / 排序、版本逐字对比、跨作品全文检索、docx / epub 导出、字数统计报表。
