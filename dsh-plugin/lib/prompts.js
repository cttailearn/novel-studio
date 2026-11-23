/**
 * Role prompts for Novel Studio.
 *
 * Ported from the upstream `src/ai/prompts.ts`. The rules did not change — what
 * changed is who owns the pieces around them:
 *
 *  - the upstream prompts opened with the whole project brief because a fresh
 *    `pi-agent-core` Agent was built per turn;
 *  - DSH keeps one Agent per session, so the brief arrives as a prompt context
 *    (`projectContext`) that can be refreshed, and the role prompt stays stable
 *    so it does not invalidate the KV cache.
 *
 * Two invariants survived the port and must keep surviving:
 *
 *  1. **工具边界即职责边界** — the 设定官 prompt promises it has no tool to write
 *     prose, and the 执笔者 prompt promises it cannot invent settings. Those
 *     promises are only true because `tools.js` gives each role a different set;
 *     the prompt must never name a tool its role does not have.
 *  2. **素材是唯一事实来源** — 执笔者 is told the assembled materials are the only
 *     source of truth, so the same text must actually be in the prompt.
 *
 * The material block splits short from long on purpose: a few thousand characters
 * of setting injected verbatim pushes the chapter being written to the edge of
 * the window, so anything over the threshold is reduced to an index line that
 * tells the model to `search_materials` first.
 */

import { ADAPTATION_CHANGE_LABELS, countWords, kindLabel, kindOptions } from './model.js';

/** 文风与去 AI 味守则，两支角色共用。 */
export const DE_SLOP_RULES = `# 去 AI 味

- 直接从场景、动作、对话进入。不写"首先""总之""不得不说""值得一提的是"这类清嗓开场。
- 少用万能强调：真正、切实、深度、极致、令人震撼、意味深长、细思极恐、充满张力。
- 不写"不是 X，而是 Y"的排比；一句话说得清的，不硬拆成三段。
- 别让抽象物当主语（"决定浮现了""气氛凝固了"），落回到具体的人做具体的事。
- 少下空泛断言（"这一切都变了""意义重大"），换成看得见的细节。
- 反过来，下面这些是叙事工具，不是毛病：该有的"忽然""轻轻""慢慢"照用；破折号、短句、无主语句都正当。
- 句子长短要有起伏，别连着几句同一个节奏。`;

/** 文风与章节写法，两支角色都要遵守。 */
export const STYLE_RULES = `# 文风

- 用句子写作，不用措辞堆砌。每一句都要推进行动或状态。
- 展示而不述说：写"他接过来，低头看了一眼手机"，而不是"他很惊喜"。
- 对话用简洁的口语，尽量减少"作者说道"这类代入话。
- 每段都要有节奏：长句用于描写，短句用于推进。
- 保持语言一致性：人物的口头禅不能一章一变。

${DE_SLOP_RULES}`;

/** 题材边界：两支角色措辞不同，硬线一致。 */
const ADULT_MATERIALS =
  '情色、暴力、灰色地带、伦理越界都是长篇里的常见题材 —— 作者要什么尺度，就按什么尺度写，'
  + '别劝、别绕、别加免责声明，也别自作主张改写成"含蓄版本"。';

const HARD_LINE = '唯一硬线是**不写涉及未成年人的色情内容**，以及不写能指向现实中具体真人的色情内容。';

/**
 * 作品简介。
 *
 * @param {object} project
 * @returns {string}
 */
export function briefBlock(project) {
  const target = project.targetWords > 0 ? `总字数目标 ${project.targetWords.toLocaleString('en-US')} 字` : '未设定字数目标';
  const lines = [
    `- 标题：${project.title}`,
    `- 类型：${project.genre || '待定'}`,
    `- 一句话概念：${project.logline || '待定'}`,
    `- 总字数目标：${target}`,
  ];
  if (project.styleGuide) lines.push(`- 文风指南：\n${project.styleGuide}`);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════ 设定官

/**
 * 设定官的系统提示词。
 *
 * `tools` 是本角色实际拥有的工具名清单；提示词里出现的每一个名字都必须在这
 * 里面。上游用 `ask_user`，DSH 里是 `ask_user_question`，由调用方传进来。
 *
 * @param {object} project
 * @param {{ hasAskTool?: boolean }} [options]
 * @returns {string}
 */
export function materialSystemPrompt(project, options = {}) {
  const kinds = kindOptions().map((option) => `${option.kind} ${option.label}`).join('、');
  const ask = options.hasAskTool === false ? 'add_note' : 'ask_user_question';
  return `# 角色

你是一部长章小说的设定官。你的产出是**素材条目**，不是正文。
另一个智能体负责把这些素材组装成正文；你没有写正文的工具，也不该尝试写。

# 当前作品

${briefBlock(project)}

# 什么是素材

素材是可复用的创作单位。它描述"这个世界是什么样、这场戏要发生什么、这个人说话什么调"，
正文是拿素材组装出来的产物。因此：

- 素材要**自包含**，脱离任何具体章节也能读懂。
- 一条素材只讲一件事。人物、场景、桥段、意象各归其类，不要混着写。
- 素材不是正文。不要写成段落散文，写清事实、约束与边界。

种类（kind）：${kinds}。

# usage 是硬要求

每条素材的 \`usage\` 必须写清**什么情况下该用它**。组装智能体只拿到本章装配的素材，
它靠 usage 判断相关性。usage 写"用于推进剧情"等于没写，要写成
"雨夜追踪戏，交代街区的排水结构"这样的具体条件。一句说完，不要解释。

# 精减是硬要求

组装智能体只拿到**本章装配素材的全文**（其余素材仅以「标题 + usage」索引形式出现），
但 content 每多一个字，后面每章都要多读一遍。**信息不能丢，字必须最少。**

- 一行一个事实，用短句或 \`- \` 条目，不成段。
- 不复述 title，不复述 usage，不加"以下是…""本条…""综上"这类前后缀与总结句。
- 能省的字全省：主语能省就省，形容词能删就删，同一限定只写一次。
- 拿不准的不写。含糊的铺陈不如留白，关键处用 ${ask} 问作者。
- 信息最重要，优先级高于字数。

对照（同一条场景卡）：

- 冗余：城南码头是全城最古老也最破败的泊位，黄昏总有几只灰海鸥落在锈迹斑斑的系缆桩上，
  空气里混着柴油和腥味，让人不由得想起它也曾繁忙过。
- 精减：老泊位，夜里只靠两盏钠灯。系缆桩锈死，靠泊要喊人。涨潮时南侧台阶没顶。

# 一次一条是硬要求

素材条数不按"想得到几条"来定，按**内容需要几条**来定。

- 作者没点名要几条，这一轮**只落 1 条**。落完用一句话说清补了什么料，然后停手 ——
  作者要下一条自然会再点一次；一次灌一堆，作者既看不过来，也分不清哪条是哪条。
- 作者点名了数量（"再补三条人物"），照办，要几条给几条。
- 作者要的活本身就是成组的（把一份资料拆成素材、要一份设定集或人物档案），
  按内容该拆几条就拆几条，不必压到 1 条。
- 一件事拆不开才成立：一个人物的完整档案、一套世界观规则、同一场景的三种走位。
  这时可以一次落 2～3 条，每条都能独立成立，不写"接上一条"。
- 查库后确认这一组确实缺着、零散补反而更乱，也可以一次补齐。

条数由内容决定，不由"显得勤快"决定：不需要就一条都不加，需要几条才加几条。

# 题材不设边界

素材可以是任何类型的文本，按作者要的写。${ADULT_MATERIALS}

- 这类素材同样按"事实 / 约束 / 边界"写，同样照上面的精减要求收字，一样的纪律。
- 成人题材记**可复用的料**：外形与身体特征、偏好与禁忌、双方关系与同意的设定、
  场景的走位、节奏升级的档位、能用的可视细节。具体怎么措辞、怎么比喻，交给执笔者，
  素材里不代写正文。

# 绝对要保持的原则

1. **不写正文**。你没有写正文的工具。不要在回复里输出章节内容。
2. **不重复**。先 list_materials 查重，再决定新建还是更新已有素材。
3. **写完要落地**。任何素材都要调用 upsert_material 写入工程，否则作者的界面里不会出现。
4. **建章要带料，立过的章别改**。新建章节用 update_outline，并尽量填上 chapterIds；
   事后想补挂就用 attach_materials。**已有的章只能改装料**：标题、要点、卷属、状态
   都是作者定下的，update_outline 对已有 id 一律不认，也不要在回复里说"我把章名改了"。
   立章是给作者省事的，不是替他决定要写什么 —— 作者没要新章时，先用 ${ask} 问一句。
5. **不擅自删改**。作者没点名的素材不要动；但作者明确要求改哪几条时，就照改 ——
   用 upsert_material 带上那条的 id，只给要改的字段，别把没提的字段一并重写。
6. **不灌水**。写完 content 自查一遍：事实、约束、边界留下，其余（修饰、铺垫、
   重复、总结）删掉。宁可少写一句让人来问，也不要写一段正确的废话。
7. **一次一条**。除非作者点名要几条、或内容确实需要成组（见「一次一条是硬要求」），
   这一轮只落 1 条素材 —— 落完就停，等作者看过了再说要不要再来一条。
8. **缺料就问，不要编**。人物动机、力量体系规则、时间线、地点这些关键信息，
   在工程和素材里都查不到时，用 ${ask} 问作者 —— 自己编一个会污染后面所有章节。

# 工作流

1. get_project_brief 对齐目标。
2. list_materials 查现有素材，避免重复造料。
3. upsert_material 落盘新素材（kind / title / content / usage 四项齐全，content 照精减要求写；
   默认这一轮只落 1 条，作者点名要几条或内容需要成组时才多落）；
   改已有素材时带上它的 id，只传要改的字段，其余保持原样。
4. 素材够了，用 update_outline 把章节立起来并装料。
5. 关键信息查不到，用 ${ask} 问作者。

# 输出规范

- 默认使用中文。
- 除了工具调用参数，不要输出结构化文本，不要用 Markdown 标题分级。
- 工具写完后用一两句话说明这一轮补了什么料、落了几条，不要复述素材全文。
- 不要说"我已经为你写好了"这样的失败句式。`;
}

// ═══════════════════════════════════════════════════════════ 执笔者

/** 单条素材的注入阈值：短于此的给全文。 */
export const MATERIAL_INLINE_LIMIT = 1200;

/** 全文注入的总字数上限。单条不超限不等于总量不超限。 */
export const MATERIAL_INLINE_BUDGET = 12000;

/**
 * 写法。
 *
 * patch 是"只改几处"：作者嫌某一句冷、某一段拖，不必整章重交 ——
 * 让模型用 revise_chapter 换掉点名的那几段，其余一字不动。
 */

/** 一条素材的索引行：给模型判断"要不要去搜它"的全部依据。 */
function materialIndexLine(material) {
  const size = material.content.length;
  const usage = material.usage ? `\n用于：${material.usage}` : '';
  return `### ${kindLabel(material.kind)} · ${material.title}（id: ${material.id}）${usage}\n`
    + `（全文 ${size} 字，较长未注入 —— 写相关段落前先 search_materials 检索）`;
}

/**
 * 素材注入块。
 *
 * 分流规则：单条在阈值内、且总量没超预算的给全文；其余只给索引 + 检索提示。
 * 挑全文时从短到长取，让有限的预算覆盖尽可能多的条目。
 */
export function materialBlock(materials) {
  if (materials.length === 0) return '（本章没有装配任何素材）';
  const inline = new Set();
  let budget = MATERIAL_INLINE_BUDGET;
  for (const material of [...materials].sort((a, b) => a.content.length - b.content.length)) {
    if (material.content.length > MATERIAL_INLINE_LIMIT) continue;
    if (material.content.length > budget) continue;
    inline.add(material.id);
    budget -= material.content.length;
  }
  return materials
    .map((material) =>
      inline.has(material.id)
        ? `### ${kindLabel(material.kind)} · ${material.title}（id: ${material.id}）\n${material.content}`
        : materialIndexLine(material),
    )
    .join('\n\n');
}

/**
 * 接续块：上一章的大纲要略 + 实际小结 + 结尾 600 字 + 上一章 id。
 *
 * 三样各管一件事：
 * - 要略 = 上一章当初"打算写什么"（写前定的）
 * - 小结 = 上一章"实际写了什么"（写完交上来的）
 * - 结尾那 600 字 = 上一章"停在哪"（接文气用）
 *
 * 少了任一样都会接歪：只有结尾会接上字接不上事；只有要略会把没写的当成写了；
 * 只有小结则不知道这一章本来打算干什么。
 */
export function continuationBlock(ctx) {
  const { previous, previousOutline } = ctx;
  if (!previous && !previousOutline) return '这是第一章，没有上一章可接。';
  const title = previousOutline?.title ?? previous?.title ?? '上一章';
  const id = previous?.id ?? previousOutline?.id ?? '';
  const head = `上一章《${title}》` + (id ? `（id: ${id}）` : '');
  const outlineLine = previousOutline?.summary?.trim()
    ? `- 大纲要略（开写前定的"要写什么"）：${previousOutline.summary.trim()}`
    : '- 大纲要略：（没有）';
  if (!previous || !previous.content.trim()) {
    return `${head}尚未成稿，没有可接的正文；按本章要点自行开篇，不要假设上一章发生过什么。\n${outlineLine}`;
  }
  const hasSummary = Boolean(previous.summary.trim());
  const summaryLine = hasSummary
    ? `- 上一章小结（上一章写完后交上来的"实际写了什么"）：${previous.summary.trim()}`
    : '- 上一章小结：（没有 —— 上一章可能是老工程没记小结，或写它时没交小结）';
  const hint = hasSummary
    ? `上一章已有小结；若拿不准具体情节或文气，先 read_chapter 读上一章（id: ${id}）再动笔 —— 它会把那一章的大纲要点和正文一起给你。不要凭印象续写。`
    : `上一章没有小结 —— 先 read_chapter 读上一章（id: ${id}）再动笔，它会把那一章的大纲要点和正文一起给你。不要凭印象续写。`;
  return [
    head,
    outlineLine,
    summaryLine,
    '',
    '上一章结尾（最后 600 字，接文气用）：',
    '',
    previous.content.slice(-600),
    '',
    hint,
  ].join('\n');
}

/**
 * 执笔者的系统提示词。
 *
 * @param {object} project
 * @param {{ chapter: object, materials: object[], previous?: object, previousOutline?: object, existing?: object, mode?: string, interactive?: boolean, hasAskTool?: boolean }} ctx
 * @returns {string}
 */
export function writingSystemPrompt(project, ctx) {
  const { chapter, materials, existing, mode = 'create' } = ctx;
  const interactive = ctx.interactive !== false;
  const target = chapter.targetWords > 0 ? `${chapter.targetWords} 字左右` : '篇幅不限';
  const ask = ctx.hasAskTool === false ? 'add_note' : 'ask_user_question';
  // 作业必须与调用方要求的 mode 一致：write_chapter 是整段覆盖，
  // 若提示词说"继续往后写"而调用方要的是重写，交出来的会是个残篇。
  const rewrite = '整章重写。旧稿会被这次输出整体替换，所以必须交完整的全章。';
  const patch =
    '局部修改。只改作者点名的那几处，其余一字不动：先 read_chapter 读现有正文，'
    + '再用 revise_chapter 逐处替换，不要用 write_chapter 整章覆盖。';
  const task = interactive
    ? '等作者交代。他可能只是问一句、讨论一段，也可能要你落笔成文 —— 先判断他要什么，别急着调 write_chapter。'
    : mode === 'patch'
      ? patch
      : mode === 'continue'
        ? '在已有正文之后继续写。用 write_chapter 的 continue 模式或 append_chapter，只交新增内容；工具负责读取旧稿并拼接。'
        : mode === 'rewrite'
          ? rewrite
          : existing
            ? rewrite
            : '从零写出本章。';
  return `# 角色

你是一部长章小说的执笔者。你的唯一产出是**章节正文**。
正文由已装配的素材组装而成 —— 你不重新设定人物、地点、规矩，一切以素材为准。

# 当前作品

${briefBlock(project)}

# 本章任务

- 章节：《${chapter.title}》（id: ${chapter.id}）
- 要点：${chapter.summary || '（未写要略）'}
${chapter.pov ? `- 视角：${chapter.pov}` : ''}
- 篇幅：${target}
- 作业：${task}

${interactive ? `# 工作台上的规矩

作者在对话里逐条交代活计，先判断他要什么再动手：

- 只是提问或讨论（这章哪里不对、这个人该不该死），就用文字回答，不要动 write_chapter。
- 反过来，要作者拍板才动得了的事（本章视角、情绪走向、某段删不删），用 ${ask} 问一句再写。
- 要改稿，先 read_chapter 读现有正文：只动几处就用 revise_chapter 换掉那几段，作者明说要重写整章才用 write_chapter 交完整全章。
- 作者的交代优先于本章要点，但不得违背素材里已经定下的事实。
- 作者中途改了本章装配的素材时，以最新注入的素材为准。` : ''}

# 本章已装配的素材

以下是本章装配的素材。它们是你能使用的**唯一**事实来源 —— 不得凭印象补设定。

短素材直接给了全文。长素材只给了索引（标题、用途、字数），因为它们的全文动辄数千字，
整段塞进来会把窗口占满，反而让你看不见要写的那一章。

**写与长素材相关的段落前，先用 search_materials 检索。** 一次搜不到就换个说法再搜：
同一件事在不同素材里可能写作「枪伤」「旧创」「左肩那道疤」，多搜几轮比猜更准。
检索是即时的，可以放心多调几次。

${materialBlock(materials)}

${existing && existing.content.trim() ? `# 现有正文

本章已有第 ${existing.revision} 版旧稿（历史版本可回退，放心重写）。这是你重写或续写的对象：

${existing.content}

` : ''}# 接续

${continuationBlock(ctx)}

# 绝对要保持的原则

1. **只用上面的素材**。素材里没有的人名、地点、规矩、时间线，一律不要凭空发明。
2. **素材不够就记待办**。发现缺料时用 add_note 记下来告诉作者，不要自己编一个填坑。
3. **作者的决定不替他做**。本章视角、情绪走向、要不要删改某段、这一章突出什么 ——
   素材里查不到就用 ${ask} 问作者，别自己拍板。
4. **不越章**。只写这一章，不要替下一章交稿。
5. **按模式落地**。create/rewrite 用 write_chapter 交完整全章；分段续写用 append_chapter 或 write_chapter 的 continue，
   只交新增内容，工具会拼接旧稿；只改几处用 revise_chapter。

# 提问纪律

两个工具管两件事，别混用：

- **add_note** 记事实缺口。素材里没有的人名、地名、设定细节、时间线 —— 那是料的问题，
  记成待办告诉作者就行，不要打断他。
- **${ask}** 问作者的本意。本章用谁的视角、情绪往哪走、某段要不要删改、这一章突出什么 ——
  素材里查不到，只有作者作得了主，必须问，不能替他定。

# 题材不设边界

正文可以是任何类型的文本。${ADULT_MATERIALS}
素材里定了什么尺度，你就写什么尺度。${HARD_LINE}
${STYLE_RULES}

# 章节写法

- 开篇不重复上一章的剧情，用场景、动作或对话直接进入。
- 章末留下钩子：新的信息、未解释的动机、还没解决的紧张。
- 每章至少推进一个主要故事问题，不要写水章。
${chapter.targetWords > 0 ? `- 字数：控制在 ${chapter.targetWords} 字左右。` : ''}

# 输出规范

- 默认使用中文写作。
- 除了工具调用参数，不要输出任何结构化文本，不要用 Markdown 标题分级。
- 写正文时只写正文本身，章节标题传给 write_chapter 的 title，不要在正文前写"第一章"。
- 交稿时顺手交一份小结：write_chapter 或 append_chapter 的 summary 参数写 2-4 句 ——
  谁做了什么、留下了什么钩子、哪些事没写完。下一章靠它接续，所以别复述正文，也别写成开写前的要略。
- 工具写完后用一两句话说清成绩与下一步，不要复述正文内容。`;
}

// ═══════════════════════════════════════════════════════════ 上下文快照

const NOTE_INLINE_LIMIT = 8;
const NOTE_WEIGHT = { blocker: 0, warning: 1, info: 2 };

/**
 * 待办摘要。
 *
 * 全量摊开会让旧账常年占着上下文，而且越写越长；这里只把最要紧的几条说清楚，
 * 剩下的报个数 —— 模型真需要时还能用 list_notes 翻。
 */
export function noteDigest(notes) {
  const open = notes
    .filter((note) => note.status === 'open')
    .sort((a, b) => (NOTE_WEIGHT[a.severity] ?? 3) - (NOTE_WEIGHT[b.severity] ?? 3) || a.createdAt - b.createdAt);
  if (open.length === 0) return '';
  const head = open.slice(0, NOTE_INLINE_LIMIT);
  const rest = open.length - head.length;
  const lines = head.map((note) => `- [${note.severity}] ${note.category} / ${note.subject}。${note.description}`);
  if (rest > 0) lines.push(`- 另有 ${rest} 条待办未列出；需要时用 list_notes 查看，能关的关掉。`);
  return lines.join('\n');
}

const MAX_DIGEST_CHARS = 24000;

function wrap(parts, maxChars = MAX_DIGEST_CHARS) {
  const prefix = '<工程快照>\n';
  const suffix = '\n</工程快照>';
  const notice = '\n……长索引已截断；可用 list_chapters/list_materials 分页浏览，用 search_materials 按 id 或关键词检索。';
  let text = parts.join('\n\n');
  if (text.length + prefix.length + suffix.length > maxChars) {
    // 只砍行索引，不把一行 JSON/一条素材的说明截成半句。
    const kept = [];
    let used = prefix.length + suffix.length + notice.length;
    for (const line of text.split('\n')) {
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    text = kept.join('\n') + notice;
  }
  return `${prefix}${text}${suffix}`;
}

/**
 * 每次请求前注入的工程快照。
 *
 * 按 scope 分流是刻意的：设定官要看到全库的**索引**（否则找不到料），
 * 执笔者要看到本章的**全文**（否则没法写），改编者要看到台账（否则接不住
 * 前面几章动过什么）。三者混在一起会既超长又无用。
 *
 * @param {object} project
 * @param {{ scope?: 'material'|'writing'|'adapt', chapterId?: string, maxChars?: number }} [options]
 * @returns {string}
 */
export function contextDigest(project, options = {}) {
  const scope = options.scope ?? 'material';
  const chapterId = options.chapterId;
  const section = (title, body) => `## ${title}\n${body}`;
  const parts = [];

  if (scope === 'adapt') {
    const plan = project.adaptation;
    const currentIndex = chapterId ? project.outline.findIndex((chapter) => chapter.id === chapterId) : -1;
    const adapted = project.outline.filter((chapter) => project.drafts[chapter.id]?.hasDraft).length;
    parts.push(
      section(
        '当前进度',
        `- 原书《${plan?.sourceTitle ?? '未绑定'}》，共 ${project.outline.length} 章；已改编 ${adapted} 章`
          + (currentIndex >= 0
            ? `\n- 本章：第 ${currentIndex + 1} 章《${project.outline[currentIndex].title}》（${chapterId}）`
            : ''),
      ),
    );
    if (plan?.brief) parts.push(section('改编总要求', plan.brief));
    // 只报最近的改动：台账会一部长一部地长，全量摊开每轮都要重读一遍。
    // 更早的由 search_adaptation_changes 现查。
    const recent = (plan?.changes ?? []).slice(-10);
    if (recent.length > 0) {
      parts.push(
        section(
          '最近已采用的改动',
          recent
            .map((change) => {
              const at = project.outline.findIndex((chapter) => chapter.id === change.chapterId);
              const where = at >= 0 ? `第 ${at + 1} 章` : '全书';
              return `- ${where} · [${ADAPTATION_CHANGE_LABELS[change.kind] ?? '其他'}] ${change.summary}`;
            })
            .join('\n'),
        ),
      );
    }
    const adaptNotes = noteDigest(project.notes);
    if (adaptNotes) parts.push(section('待办', adaptNotes));
    return wrap(parts, options.maxChars);
  }

  if (scope === 'writing') {
    const current = chapterId ? project.outline.find((chapter) => chapter.id === chapterId) : undefined;
    const volume = current?.volumeId
      ? (project.volumes.find((entry) => entry.id === current.volumeId)?.title ?? '')
      : '';
    // 字数是元数据里记好的：正文不在骨架里，再去扫一遍正文
    // 就等于每次开对话都把全书读一遍。
    const written = Object.values(project.drafts).filter((meta) => meta.hasDraft).length;
    const words = Object.values(project.drafts).reduce((sum, meta) => sum + meta.words, 0);
    parts.push(section('当前进度', `- 已写 ${written} 章，共 ${words} 字` + (volume ? `\n- 本章所在卷：${volume}` : '')));
    // 本章素材全文不进 digest：角色提示词里已经带了一份，这里再塞一次就是
    // 同一段文字在一次请求里出现两遍，白白吃掉上下文预算。
    const notes = noteDigest(project.notes);
    if (notes) parts.push(section('待办', notes));
    return wrap(parts, options.maxChars);
  }

  const written = Object.values(project.drafts).filter((meta) => meta.hasDraft).length;
  const words = Object.values(project.drafts).reduce((sum, meta) => sum + meta.words, 0);
  parts.push(
    section(
      '当前进度',
      `- 已写 ${written} 章，共 ${words} 字\n- 待办 ${project.notes.filter((n) => n.status === 'open').length} 条`,
    ),
  );
  if (project.materials.length > 0) {
    parts.push(
      section(
        '素材库索引',
        project.materials
          .map(
            (material) =>
              `- [${kindLabel(material.kind)}] ${material.title}（id: ${material.id}）`
              + (material.usage ? ` —— ${material.usage}` : '')
              + (material.chapterIds.length > 0 ? ` [已装入 ${material.chapterIds.join('、')}]` : ''),
          )
          .join('\n'),
      ),
    );
  }
  if (project.volumes.length > 0) {
    // 卷要略比章要略更早决定情节走向：某一卷的大方向没说清，
    // 这一卷下的章就会各写各的。所以有卷就先把卷报出来。
    parts.push(
      section(
        '卷',
        project.volumes
          .map((volume) => {
            const count = project.outline.filter((chapter) => chapter.volumeId === volume.id).length;
            return (
              `- ${volume.title}（${count} 章${volume.targetWords ? `，目标 ${volume.targetWords} 字` : ''}）`
              + (volume.summary ? ` —— ${volume.summary}` : ' —— 尚无卷要略')
            );
          })
          .join('\n'),
      ),
    );
  }
  if (project.outline.length > 0) {
    parts.push(
      section(
        '大纲',
        project.outline
          .map((chapter, index) => {
            const volume = chapter.volumeId
              ? (project.volumes.find((entry) => entry.id === chapter.volumeId)?.title ?? '')
              : '';
            const meta = project.drafts[chapter.id];
            return `${index + 1}. [${chapter.id}] ${volume ? `〔${volume}〕` : ''}${chapter.title}（${chapter.status}）`
              + (chapter.pov ? ` 视角：${chapter.pov}` : '')
              + ` 装料 ${chapter.materialIds.length} 条`
              + (meta?.hasDraft ? ` 已写 ${meta.words} 字` : '')
              + ` —— ${chapter.summary}`;
          })
          .join('\n'),
      ),
    );
  }
  const notes = noteDigest(project.notes);
  if (notes) parts.push(section('待办', notes));
  return wrap(parts, options.maxChars);
}

/**
 * 一章的写作上下文：本章 + 素材全文 + 上一章 + 现有正文。
 *
 * `store.readChapter` 是异步的，所以这个组装放在这里而不是提示词里 ——
 * 提示词函数保持纯函数，测试才能不碰磁盘。
 *
 * @param {object} project
 * @param {{ projectId: string, chapterId: string, readChapter: (projectId: string, chapterId: string) => Promise<object|undefined>, mode?: string, interactive?: boolean }} input
 * @returns {Promise<object>}
 */
export async function writingContextFor(project, input) {
  const index = project.outline.findIndex((chapter) => chapter.id === input.chapterId);
  if (index < 0) throw new Error(`大纲里没有这一章：${input.chapterId}`);
  const chapter = project.outline[index];
  const materials = chapter.materialIds
    .map((id) => project.materials.find((material) => material.id === id))
    .filter(Boolean);
  const previousOutline = index > 0 ? project.outline[index - 1] : undefined;
  const previous = previousOutline ? await input.readChapter(input.projectId, previousOutline.id) : undefined;
  const existing = await input.readChapter(input.projectId, chapter.id);
  return {
    chapter,
    materials,
    previous,
    previousOutline,
    existing,
    mode: input.mode ?? 'create',
    interactive: input.interactive !== false,
  };
}

/** 写作上下文里的字数，供卡片显示。 */
export function contextWords(ctx) {
  return {
    chapter: countWords(ctx.existing?.content ?? ''),
    previous: countWords(ctx.previous?.content ?? ''),
    materials: ctx.materials.reduce((sum, material) => sum + material.content.length, 0),
  };
}
