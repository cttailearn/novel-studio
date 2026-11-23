/**
 * The adapter role: rewriting a finished novel, one chapter at a time.
 *
 * Ported from `src/ai/adapt.ts`. What separates this role from the drafter is
 * not "who writes better" but **how a change lands**:
 *
 *  - the drafter's tools write the chapter; one turn and the prose is live;
 *  - the adapter's only exit is `propose_adaptation` — it hands over a proposal,
 *    the author reads it, edits it, presses accept, and only then is anything
 *    written. Once a lead character or the narration has been switched
 *    automatically, the author can no longer see what the old version looked
 *    like.
 *
 * That is why the prompt carries the original text: this role is not generating
 * from materials, it is operating on prose that already exists.
 */

import {
  ADAPTATION_CHANGE_LABELS,
  adaptCursorChapterId,
  countWords,
  isTitleChangeSummary,
  nextAdaptChapterId,
  pruneAdaptationChanges,
  renamedTitleFromSummary,
  renameChapterTitle,
  titleCore,
} from './model.js';
import { DE_SLOP_RULES } from './prompts.js';
import { clamp, optionalNumber, requiredText, text, tool } from './tool-kit.js';

/** The题材 red line, kept in step with the drafter's wording. */
const ADAPT_STYLE_RULES = `正文可以是任何类型的文本。情色、暴力、灰色地带、伦理越界都是长篇里的常见题材：
作者要什么尺度就写什么尺度，不劝、不绕、不加免责声明，也不自行改成含蓄版本。
唯一硬线是**不写涉及未成年人的色情内容**，以及不写能指向现实中的具体真人的色情内容。`;

/** The original is clipped: a 60k-char chapter would crowd out everything else. */
const ORIGINAL_BLOCK_LIMIT = 60_000;

/**
 * Assemble one chapter's adaptation context.
 *
 * The original is not optional: if the book was deleted from the library or the
 * chapter ids no longer line up, that is a hard error — "adapting" without a
 * source is writing a different book.
 *
 * @param {{ read: (id: string) => Promise<object|undefined> }} store
 * @param {{ read: (id: string) => Promise<object|undefined>, readChapter: (id: string, chapterId: string) => Promise<object|undefined> }} sources
 * @param {object} project
 * @param {string} chapterId
 * @returns {Promise<object>}
 */
export async function adaptContextFor(store, sources, project, chapterId) {
  const adaptation = project.adaptation;
  if (!adaptation) throw new Error('这一部不是改编工程');
  const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) throw new Error(`章节 ${chapterId} 不在本章目里`);
  const chapter = project.outline[index];

  const source = await sources.read(adaptation.sourceId);
  if (!source) throw new Error('原书已经不在原料库里了；请重新导入原书，或另建一部改编工程。');
  const original = await sources.readChapter(adaptation.sourceId, chapterId);
  if (!original) {
    throw new Error(`原文里找不到这一章（${chapterId}）；改编工程的章目应与原书章节一一对应。`);
  }

  const meta = project.drafts[chapterId];
  const current = meta
    ? await (async () => {
        const body = await store.readChapter(project.id, chapterId);
        return { content: body?.content ?? '', summary: meta.summary, revision: meta.revision };
      })()
    : undefined;

  let previous;
  if (index > 0) {
    const prevChapter = project.outline[index - 1];
    const prevMeta = project.drafts[prevChapter.id];
    if (prevMeta) {
      const body = await store.readChapter(project.id, prevChapter.id);
      previous = {
        title: prevMeta.title,
        summary: prevMeta.summary,
        content: body?.content ?? '',
        adapted: true,
      };
    } else {
      const prevOriginal = await sources.readChapter(adaptation.sourceId, prevChapter.id);
      previous = {
        title: prevChapter.title,
        summary: '',
        content: prevOriginal?.content ?? '',
        adapted: false,
      };
    }
  }

  return {
    chapter,
    index,
    total: project.outline.length,
    sourceTitle: adaptation.sourceTitle || source.title,
    brief: adaptation.brief,
    original,
    current,
    previous,
    // The ledger shows the most recent 80: anything older the model can pull with
    // search_adaptation_changes.
    changes: (adaptation.changes ?? []).slice(-80),
  };
}

function chapterLabel(ctx) {
  return `第 ${ctx.index + 1} 章《${ctx.chapter.title}》`;
}

/**
 * One ledger line. The chapter number is computed from the outline so the author
 * and the model read the same number.
 *
 * `detail` travels with it: the next chapters have to carry forward what changed
 * *and* what the original said, otherwise the model can only guess.
 */
export function changeLine(project, change) {
  const at = project.outline.findIndex((chapter) => chapter.id === change.chapterId);
  const where = at >= 0 ? `第 ${at + 1} 章` : '全书';
  const label = ADAPTATION_CHANGE_LABELS[change.kind] ?? '其他';
  const detail = (change.detail ?? '').replace(/\s+/g, ' ').trim();
  const tail = detail ? ` —— ${detail.length > 90 ? `${detail.slice(0, 90)}…` : detail}` : '';
  return `- ${where} · [${label}] ${change.summary}${tail}`;
}

/** Ledger text shared by the prompt and the search tool. */
export function changesBlock(project, changes) {
  if (changes.length === 0) return '（还没有已采用的改动）';
  return changes.map((change) => changeLine(project, change)).join('\n');
}

/**
 * The adapter's system prompt.
 *
 * @param {object} project
 * @param {object} ctx
 * @returns {string}
 */
export function adaptSystemPrompt(project, ctx) {
  const original = ctx.original.content;
  const clipped =
    original.length > ORIGINAL_BLOCK_LIMIT
      ? `${original.slice(0, ORIGINAL_BLOCK_LIMIT)}\n……（原文过长，此处只到一半；完整原文用 read_original_chapter 分段读）`
      : original;
  const target = ctx.chapter.targetWords > 0 ? `${ctx.chapter.targetWords} 字左右` : '与原文相当';
  const currentBlock = ctx.current
    ? `# 本章现有的改编稿

这是已经存下的第 ${ctx.current.revision} 版改编稿；作者可能只是在它上面再改几处。
${ctx.current.summary ? `现用小结：${ctx.current.summary}` : '（还没有小结）'}

${ctx.current.content}

`
    : '';
  const previousBlock = ctx.previous
    ? `# 上一章（接续用）

上一章《${ctx.previous.title}》${ctx.previous.adapted ? '已改编' : '尚未改编，以下是原文'}：
${ctx.previous.summary ? `实际小结：${ctx.previous.summary}` : ''}
结尾（最后 600 字）：

${ctx.previous.content.slice(-600)}

`
    : '';

  return `# 角色

你是这部小说的**改编者**。底本是一部已经写成的长篇，你一章一章地改，
不是在空白处另写一本。每一章都基于原文改写，改完把完整的一章交上来，
由作者看过、改过、点「采用」之后才算落地。

# 原书

- 原书：《${ctx.sourceTitle}》，共 ${ctx.total} 章
- 本章：${chapterLabel(ctx)}（id: ${ctx.chapter.id}），原文 ${ctx.original.chars || countWords(original)} 字，目标 ${target}
- 本章原文要点：${ctx.chapter.summary || '（未写要略，以原文为准）'}

# 改编总要求

${ctx.brief || '（作者还没写总要求；按他在对话里的具体交代改。）'}

# 已采用的改动台账

以下是前面各章已经采用的改动。**写任何一章之前先看一遍**：
人名、关系、人称、时间线、伏笔、世界观以台账为准，不得与它冲突；
台账里没写的，回到原文去找，不要自行发明。

${changesBlock(project, ctx.changes)}

# 本章原文

<<<原文 开始>>>
${clipped}
<<<原文 结束>>>

# 改编原则

**这一节的第一条压过其余：以原文为主。** 作者的改编需求之外，一个字都不该多动；
改动量越少越好，除非是他点名要改的地方。

1. **底本意识 —— 默认照抄**：原文就是这一章的成稿。作者没有点名的段落，
   逐句保留原样：同样的句子、同样的口气、同样的段落顺序、同样的场景调度、
   同样的对话推进方式。**改动是例外，不是义务** —— 不是「尽量少改」，
   而是「能不动就不动」；只有总要求、本轮交代、或台账牵动的地方才动手。
   判断标准只有一条：读者对照原书，应当认得出这还是原来那一章，
   而不是「同一个故事的另一版」。
2. **不许缩写，也不许顺手扩写**：交付稿的篇幅应与原文相当（默认上下浮动不超过三成）。
   除非作者明确要求精简或扩写，否则不得把三五千字的场景写成一段提要，
   也不得为了"更完整"而自行补写原文没有的段落。改动只发生在被要求的地方。
3. **一致**：人物、关系、时间线、伏笔、世界观必须与台账一致；台账与原文冲突时以台账为准
   （那是作者已经拍过的板），并在 changes 里记一条"对前章改动的呼应"。
4. **人称**：原文的第一/第三人称、叙述视角，作者没要求时不得改。
   作者要求改人称时，全章统一改，不要半章"我"半章"她"。
   改人称只动人称与随之必须变的代词，句子本身不要借机重写一遍。
5. **加料**：作者要加人物、加情节、加尺度时，加在原文的骨架上：
   新内容要能接住原段落前后的动作与情绪，不能突然另起一段与上下文无关的戏。
   加料是在原段落之间插入，不是把原段落改写一遍再顺带加料。
6. **只改这一章**：不要替下一章交稿，也不要在正文里解释你改了什么。
7. **章名可以改**：改完这一章，若原来的题目不再贴切（换了主角、换了视角、加了新戏），
   先调用 rename_chapter 换成贴题的短句，再交稿。只给题目本身，不要带「第 N 章」；
   题目本来就叫得准，就别为了好看而换 —— 读者认的是原来那个名字。
8. ${ADAPT_STYLE_RULES}

# 改编不是重写

原文是作者已经写成的书，它在语言上可能有它的毛病。**只改作者点名要改的**：
总要求没提语言，就保住原来的句子、原来的口气，不要顺手把它改得更"顺"。
哪怕看到病句、重复的形容词、啰嗦的描写，只要作者没点名，也**原样留着** ——
那是这本书原来就有的样子，改成"更好"的版本，就是另一本书了。

尤其不要往原文里加套话：清嗓开场、万能强调、空泛断言、假拟人，一条都不要新添 ——
原文里本来就有、而作者没让动的，照旧留着。

**交稿前的自检（逐条做，做完再调 propose_adaptation）**：

1. 把这一版与原文逐段对齐：**每一处与原文不同的地方，能不能指回一条改编需求**
   （总要求里的某句、本轮交代里的某句、或台账里某条），指不回去的，就是你自作主张的改动。
2. 那些指不回去的地方，**一律还原成原句** —— 不要停留在"意思差不多"，
   要还原到字面。同义词替换、语序调整、把短句连成长句、把对话改成叙述，都算改动。
3. 只属于"改得更顺、更漂亮、更有文采"的润色，一条都不留。
4. 再数一遍篇幅：与原文相差超过三成，说明你在缩写或扩写，回去补回原段落。

${DE_SLOP_RULES}

# 前后章的联动

这是一本一条线写下来的书：前面定下的东西，后面得接住。

- 台账每条都带所在章号，以及"原文怎么写、现在怎么改"。**改到某一章时，前面各章动过的
  名字、身份、关系、时间线、伏笔，在这一章必须跟着走**：前章把阿青改成青禾，
  这一章的"阿青"就得改成"青禾"，不能一处新、一处旧。
- 台账只有一句话。要看那一章实际怎么写的，用 read_adapted_chapter 读它的改编稿，
  或用 read_original_chapter 拿原文对照；隔了两章以上的联动，动笔前先
  search_adaptation_changes 按人名、地名、类别检索一遍。
- 确认过的章不能回头改（改编是一章一章往下的）。真发现前章改得有问题，别在这一章
  擅自"纠回来"：照台账写，并在 changes 里记一条 detail 写明"上一章某处与本章冲突，
  建议作者回到那一章再改一版"。
- 凡属"接住前章改动"的地方，在 changes 里记一条呼应（kind 与被呼应那条同类），
  后面几章照着它继续走。

# 输出与交付

- 正文用中文，不用 Markdown 标题，不在正文前写"第 N 章"，不写改编说明。
- 章名要换就先调 rename_chapter：它当场生效，作者在章目里立刻看到新题目；
  换完再交稿，免得提案里说的名字与章目上印的对不上。
  章名没变（还是原来那个题目）就**不要**在 changes 里记 title —— 台账只记真改过的事。
- **改完必须调用 propose_adaptation**，一轮只交一版：
  - content：完整本章改编稿（不是片段、不是 diff）。
  - summary：2-4 句 —— 这一章现在讲了什么、留下了什么钩子。
  - changes：3-8 条结构化改动，一条只记一件事。kind 取 character（人物）、persona（人设）、
    plot（剧情）、pov（人称）、addition（加料）、style（文风）、title（章名）、other（其他）；
    summary 一句话说清"改了什么"（40 字内，后面章节靠它检索）；
    detail 说清"原文怎么写的、现在怎么改的"，可留空。
    记 title 的那条要写成「《旧名》改为《新名》」，作者采用时会按它核对章名。
- 交稿后用一两句话说清这版动了哪几处，**等作者采用或再改**，不要重复呈上同一稿。

${currentBlock}${previousBlock}# 改动台账的用法

写下一章之前，先看上面的台账：每条是「第 N 章 · [类别] 一句话 —— 原文怎么写、现在怎么改」。
若需要查更早的改动，调用 search_adaptation_changes 按关键词检索（例如人物名、地点、
某个改动类别）。查不到的，就回原文（read_original_chapter）去找，不要凭印象补。
台账里若有「作者手改了本章正文」，说明那一版是作者亲手写的、没有提案：以它为准，
要看细节就 read_adapted_chapter 读那一章。`;
}

/**
 * The adapter's tools: read the original, read the adapted draft, look up the
 * ledger, submit a proposal. Notably absent: anything that writes a chapter.
 *
 * @param {{
 *   store: object,
 *   sources: object,
 *   proposals: object,
 *   resolveProject: (explicitId?: string) => Promise<string>,
 *   resolveChapter: () => Promise<string>,
 * }} deps
 */
export function createAdaptTools(deps) {
  async function projectOf(explicitId) {
    const id = await deps.resolveProject(explicitId);
    if (!id) throw new Error('还没有作品。先在小说工坊里新建或打开一部改编工程。');
    const project = await deps.store.read(id);
    if (!project.adaptation) throw new Error('这一部不是改编工程，没有底本可改。');
    return project;
  }

  async function contextOf(explicitId, chapterId) {
    const project = await projectOf(explicitId);
    const wanted = chapterId || (await deps.resolveChapter()) || adaptCursorChapterId(project);
    if (!wanted) throw new Error('这本书已经改到底了，没有待改的章。');
    const ctx = await adaptContextFor(deps.store, deps.sources, project, wanted);
    return { project, ctx };
  }

  const readOriginal = tool({
    name: 'read_original_chapter',
    card: '读原文',
    kind: 'read',
    description:
      '读原书某一章的完整原文。默认读当前这一章；要核对前文设定、人物原名或伏笔时，传 chapterId 读别的章。',
    parameters: {
      projectId: text('作品 id；不传就用工作台当前打开的那一部'),
      chapterId: text('原书章节 id；不传就是当前这一章'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const chapterId = (args.chapterId ?? '').trim() || (await deps.resolveChapter()) || project.adaptation.cursor || '';
      if (!chapterId) throw new Error('没有指定章节，工作台上也没有打开任何一章。');
      const planned = project.outline.find((chapter) => chapter.id === chapterId);
      const chapter = await deps.sources.readChapter(project.adaptation.sourceId, chapterId);
      if (!chapter) throw new Error(`原文里没有章节 ${chapterId}；先用 list_chapters 确认章号。`);
      return {
        text: `《${planned?.title ?? chapter.title}》（${chapterId}），${chapter.chars} 字：\n\n${chapter.content}`,
        details: { chapterId, chars: chapter.chars },
      };
    },
  });

  const readAdapted = tool({
    name: 'read_adapted_chapter',
    card: '读改编稿',
    kind: 'read',
    description: '读某一章已经存下的改编稿（不是原文）。默认读当前这一章；没改过就明说没有。',
    parameters: {
      projectId: text('作品 id；不传就用工作台当前打开的那一部'),
      chapterId: text('章节 id；不传就是当前这一章'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const chapterId = (args.chapterId ?? '').trim() || (await deps.resolveChapter()) || adaptCursorChapterId(project);
      if (!chapterId) throw new Error('没有指定章节，工作台上也没有打开任何一章。');
      const planned = project.outline.find((chapter) => chapter.id === chapterId);
      if (!planned) throw new Error(`章节 ${chapterId} 不在本章目里。`);
      const meta = project.drafts[chapterId];
      if (!meta || !meta.hasDraft) {
        return { text: `《${planned.title}》还没有改编稿（这一章尚未改编）。`, details: { chapterId } };
      }
      const body = await deps.store.readChapter(project.id, chapterId);
      return {
        text:
          `《${meta.title}》第 ${meta.revision} 版改编稿，${meta.words} 字`
          + (meta.summary ? `。小结：${meta.summary}` : '')
          + `\n\n${body?.content ?? ''}`,
        details: { chapterId, revision: meta.revision },
      };
    },
  });

  const searchChanges = tool({
    name: 'search_adaptation_changes',
    card: '检索改编台账',
    kind: 'search',
    description:
      '按关键词检索已经采用的改编变动（人物名、地点、设定、剧情点都可以）。写新一章前核对前文改动时用。',
    parameters: {
      projectId: text('作品 id；不传就用工作台当前打开的那一部'),
      query: requiredText('关键词，例如人物名、地名、改动类别'),
      chapterId: text('只看某一章的改动'),
      limit: optionalNumber('最多几条，默认 8，上限 20'),
    },
    run: async (args) => {
      const project = await projectOf(args.projectId);
      const changes = project.adaptation.changes ?? [];
      const needle = (args.query ?? '').trim().toLowerCase();
      const limit = clamp(args.limit, 1, 20, 8);
      const hits = changes
        .filter((change) => (args.chapterId ? change.chapterId === args.chapterId : true))
        .filter((change) => {
          const hay = [change.summary, change.detail ?? '', ADAPTATION_CHANGE_LABELS[change.kind] ?? '']
            .join(' ')
            .toLowerCase();
          return needle === '' || hay.includes(needle);
        })
        .slice(-limit);
      if (hits.length === 0) {
        return { text: `台账里没有匹配「${args.query}」的改动。`, details: { count: 0 } };
      }
      return { text: `匹配 ${hits.length} 条：\n${changesBlock(project, hits)}`, details: { count: hits.length } };
    },
  });

  const renameChapter = tool({
    name: 'rename_chapter',
    card: '改章名',
    kind: 'edit',
    description:
      '改当前这一章的章名：大纲与已成稿的标题一起换，正文一个字不动，作者立刻能在章目里看到。'
      + '改完这一章发现原来的题目不再贴切时用；题目本来就叫得准时不必调用。',
    parameters: {
      projectId: text('作品 id；不传就用工作台当前打开的那一部'),
      title: requiredText('新章名，只写题目本身，不要带「第 N 章」'),
      reason: text('为什么换名字，一句话'),
    },
    run: async (args) => {
      const title = cleanChapterTitle(args.title ?? '');
      if (!title) throw new Error('章名不能空着。');
      const project = await projectOf(args.projectId);
      const chapterId = (await deps.resolveChapter()) || adaptCursorChapterId(project);
      if (!chapterId) throw new Error('工作台上没有打开任何一章，改不了名。');
      const planned = project.outline.find((chapter) => chapter.id === chapterId);
      if (!planned) throw new Error('这一章不在章目里，改不了名。');
      const before = planned.title;
      if (before === title) {
        return { text: `这一章本来就叫《${before}》，没有改。`, details: { chapterId, title } };
      }
      const reason = (args.reason ?? '').trim();
      await deps.store.update(project.id, (draft) => {
        if (renameChapterTitle(draft, chapterId, title) === undefined) return;
        if (!draft.adaptation) return;
        const now = Date.now();
        draft.adaptation.changes.push({
          id: `${chapterId}-title-${now}`,
          chapterId,
          kind: 'title',
          summary: `《${before}》改为《${title}》`,
          ...(reason ? { detail: reason } : {}),
          createdAt: now,
        });
        draft.adaptation.updatedAt = now;
      });
      return {
        text: `已把第 ${project.outline.findIndex((c) => c.id === chapterId) + 1} 章《${before}》改名为《${title}》。`
          + '正文没动；作者在章目里能看到新名字。',
        details: { chapterId, title, before },
      };
    },
  });

  const propose = tool({
    name: 'propose_adaptation',
    card: '呈上改编稿',
    kind: 'edit',
    description:
      '把这一章的完整改编稿与结构化改动呈给作者。一轮只调用一次；作者看过、改过、点「采用」之后才落盘。',
    parameters: {
      projectId: text('作品 id；不传就用工作台当前打开的那一部'),
      content: requiredText('完整本章改编稿（不是片段、不是 diff）'),
      summary: requiredText('2-4 句：这一章现在讲了什么、留下了什么钩子'),
      changes: {
        type: 'array',
        description:
          '3-8 条结构化改动，一条只记一件事。kind 取 '
          + Object.entries(ADAPTATION_CHANGE_LABELS).map(([kind, label]) => `${kind}（${label}）`).join('、'),
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: Object.keys(ADAPTATION_CHANGE_LABELS), description: '改动类别' },
            summary: { type: 'string', description: '一句话说清改了什么，40 字内，后续章节靠它检索' },
            detail: { type: 'string', description: '原文怎么写的、现在怎么改的；可留空' },
          },
          required: ['kind', 'summary'],
          additionalProperties: false,
        },
      },
    },
    run: async (args) => {
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (!content) throw new Error('改编稿是空的，交不了。');
      const project = await projectOf(args.projectId);
      const chapterId = (await deps.resolveChapter()) || adaptCursorChapterId(project);
      if (!chapterId) throw new Error('工作台上没有打开任何一章，交了也不知道落在哪一章。');
      const planned = project.outline.find((chapter) => chapter.id === chapterId);
      if (!planned) throw new Error(`章节 ${chapterId} 不在本章目里。`);
      const raw = Array.isArray(args.changes) ? args.changes : [];
      const changes = raw
        .filter((change) => change && typeof change.summary === 'string' && change.summary.trim())
        .map((change) => ({
          kind: Object.hasOwn(ADAPTATION_CHANGE_LABELS, change.kind) ? change.kind : 'other',
          summary: change.summary.trim(),
          ...(typeof change.detail === 'string' && change.detail.trim() ? { detail: change.detail.trim() } : {}),
        }));
      const proposal = await deps.proposals.submit({
        projectId: project.id,
        chapterId,
        baseRevision: project.drafts[chapterId]?.revision ?? 0,
        content,
        summary: (args.summary ?? '').trim(),
        changes,
      });
      const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
      return {
        text:
          `已把第 ${index + 1} 章《${planned.title}》的改编稿呈上（${countWords(content)} 字，`
          + `${changes.length} 条改动），等作者采用。若作者还要改，按他的新交代再交一版。`,
        details: { chapterId, proposalId: proposal.id, changes: changes.length },
      };
    },
  });

  return [readOriginal, readAdapted, searchChanges, renameChapter, propose];
}

/**
 * Strip a numbering prefix a model likes to put in front of a chapter title.
 *
 * Models hand back 「第 3 章 雨夜换船」 while the outline is already numbered by
 * position, so storing it would read "第3章 · 第3章 雨夜换船". Only a real
 * separator counts as a prefix: 「第二章的雨」 is the title itself, and removing
 * 「第二章」 would leave 「的雨」 — that is not a rename, that is destroying it.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanChapterTitle(raw) {
  const title = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const marked = title.match(/^第[0-9０-９零〇一二三四五六七八九十百千两]+[章节回]([\s\S]*)$/);
  if (!marked) return title.slice(0, 60);
  const head = marked[1] ?? '';
  const rest = head.replace(/^[\s·、:：.,，。\-—_]+/, '').trim();
  if (rest && rest !== head) return rest.slice(0, 60);
  return title.slice(0, 60);
}

/**
 * Accept one proposal: write it into the chapter and fold its changes into the
 * ledger.
 *
 * Four invariants, all of them from the original app because each one fixes a
 * bug that actually happened:
 *
 *  - a stale `baseRevision` is a 409, not a silent overwrite;
 *  - only the chapter the cursor points at may be accepted, unless it already
 *    has a draft — the author going back to fix a chapter they accepted is
 *    normal, jumping ahead is not;
 *  - one chapter's ledger entry is *replaced*, not appended, because it records
 *    "what this chapter changed relative to the original", and title entries
 *    survive so the rename history stays searchable;
 *  - a rename described in `changes` but never applied through rename_chapter
 *    gets applied here, but only when the recorded old name still matches.
 *
 * @param {{
 *   store: object,
 *   proposals: object,
 *   projectId: string,
 *   chapterId: string,
 *   proposalId?: string,
 *   content?: string,
 *   summary?: string,
 *   changes?: Array<object>,
 *   restore?: boolean,
 * }} input
 * @returns {Promise<{ chapter: object, adaptation: object }>}
 */

/**
 * Accept one proposal: write it into the chapter and fold its changes into the
 * ledger.
 *
 * Four invariants, each of them from the original app because each one fixes a
 * bug that actually happened:
 *
 *  - a stale baseline is a 409, not a silent overwrite;
 *  - only the chapter the cursor points at may be accepted, unless it already
 *    has a draft — the author going back to fix a chapter they accepted is
 *    normal, jumping ahead is not;
 *  - one chapter's ledger entry is *replaced* rather than appended, because it
 *    records "what this version changed relative to the original", while title
 *    entries survive so the rename history stays searchable;
 *  - a rename described in `changes` but never applied through rename_chapter
 *    gets applied here, but only when the recorded old name still matches.
 *
 * The body write goes through `store.writeChapter`, so the accept inherits the
 * same optimistic lock every other write has; the ledger update follows in a
 * second short transaction. If that second step fails the prose is still
 * correct and the ledger is simply one version behind, which is far better than
 * the reverse.
 *
 * @param {{
 *   store: object,
 *   proposals: object,
 *   projectId: string,
 *   chapterId: string,
 *   proposalId?: string,
 *   content?: string,
 *   summary?: string,
 *   changes?: Array<object>,
 *   restore?: boolean,
 * }} input
 * @returns {Promise<{ chapter: object, adaptation: object }>}
 */
export async function acceptProposal(input) {
  const { store, proposals, projectId, chapterId } = input;
  const restoring = input.restore === true;
  const proposal = input.proposalId ? await proposals.read(projectId, chapterId) : undefined;
  if (input.proposalId && (!proposal || proposal.id !== input.proposalId)) {
    throw httpFailure(404, '这一版的提案不在了（可能已过期）；让改编者重新交一版再采用。');
  }
  const content = restoring
    ? ''
    : (typeof input.content === 'string' ? input.content : proposal?.content ?? '').trim();
  if (!restoring && !content) throw httpFailure(400, '改编稿是空的，采用不了');
  const summary = (typeof input.summary === 'string' ? input.summary : proposal?.summary ?? '').trim();
  const changes = (Array.isArray(input.changes) ? input.changes : proposal?.changes ?? [])
    .filter((change) => change && typeof change.summary === 'string' && change.summary.trim())
    .map((change) => ({
      kind: Object.hasOwn(ADAPTATION_CHANGE_LABELS, change.kind) ? change.kind : 'other',
      summary: change.summary.trim(),
      ...(typeof change.detail === 'string' && change.detail.trim() ? { detail: change.detail.trim() } : {}),
    }));

  const project = await store.read(projectId);
  if (!project.adaptation) throw httpFailure(409, '这一部不是改编工程');
  const planned = project.outline.find((chapter) => chapter.id === chapterId);
  if (!planned) throw httpFailure(404, '章节不存在');

  const baseRevision = project.drafts[chapterId]?.revision ?? 0;
  if (proposal && baseRevision !== proposal.baseRevision) {
    throw httpFailure(
      409,
      '这一章在你看稿之后又改过一版。请刷新再看，或让改编者按现稿重交一版；这一次没有采用。'
    );
  }

  // Accepting is what confirms a chapter: nothing may jump the queue, because a
  // chapter written out of order scrambles the settings of every chapter after
  // it. A chapter that already has a draft is the exception — the author going
  // back to fix one they accepted is exactly what should happen.
  const cursorId = adaptCursorChapterId(project);
  const reopened = Boolean(project.drafts[chapterId]?.hasDraft);
  if (cursorId !== chapterId && !reopened) {
    const at = project.outline.findIndex((chapter) => chapter.id === cursorId);
    throw httpFailure(
      409,
      cursorId
        ? `改编是一章一章往下的：现在轮到第 ${at + 1} 章《${project.outline[at]?.title ?? ''}》，不能先交这一章。`
        : '全书已经改到底了；要改哪一章，先把它退回原书。'
    );
  }

  // A hand-edit arrives without a summary; keep the previous one, because later
  // chapters rely on it to recognise this one. Restoring is the exception — the
  // chapter is the original text again, and an old summary would be a lie.
  const keptSummary = restoring ? '' : summary || project.drafts[chapterId]?.summary || '';

  // A model sometimes states the rename in `changes` without calling
  // rename_chapter. Patch it here, but only while the recorded old name still
  // matches — a name the author has since changed by hand must survive.
  let title = planned.title;
  const titlePair = changes
    .filter((change) => change.kind === 'title' && isTitleChangeSummary(change.summary))
    .map((change) => renamedTitleFromSummary(change.summary))
    .find(Boolean);
  if (!restoring && titlePair && titlePair.after !== titlePair.before) {
    if (titleCore(planned.title) === titleCore(titlePair.before)) title = titlePair.after;
  }

  const before = await store.readChapter(projectId, chapterId);
  const beforeContent = before?.content ?? '';

  // The optimistic lock is the store's own: a body edited while the author was
  // reading makes this throw the same 409 every other writer gets.
  const written = await store.writeChapter(projectId, chapterId, {
    title,
    content,
    summary: keptSummary,
    materialIds: project.drafts[chapterId]?.materialIds ?? planned.materialIds,
    mode: 'adapt',
    expectedRevision: baseRevision,
  });

  const now = Date.now();
  await store.update(projectId, (draft) => {
    if (!draft.adaptation) return;
    // One chapter's ledger is "what this version changed relative to the
    // original": a new version replaces it instead of stacking a second story.
    // Title entries stay — a fresh draft does not undo a rename.
    draft.adaptation.changes = draft.adaptation.changes.filter(
      (change) => change.chapterId !== chapterId || (!restoring && change.kind === 'title')
    );
    for (const change of changes) {
      draft.adaptation.changes.push({
        id: `${chapterId}-${change.kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
        chapterId,
        kind: change.kind,
        summary: change.summary,
        ...(change.detail ? { detail: change.detail } : {}),
        createdAt: now,
      });
    }
    // A version the author wrote by hand belongs in the ledger too: the ledger is
    // the only thing later chapters read, and prose alone is invisible to an
    // adapter two chapters on.
    if (!restoring && !proposal && beforeContent !== content) {
      draft.adaptation.changes.push({
        id: `${chapterId}-hand-${now}`,
        chapterId,
        kind: 'other',
        summary: `作者手改了本章正文（第 ${written.revision} 版）`,
        detail: '作者直接在改编台落笔，没有走提案；后文以此版为准。',
        createdAt: now,
      });
    }
    draft.adaptation.changes = pruneAdaptationChanges(draft.adaptation.changes);
    draft.adaptation.updatedAt = now;
    const target = draft.outline.find((chapter) => chapter.id === chapterId);
    // Restoring puts the chapter back to "not adapted yet", so the outline must
    // stop claiming it is done.
    if (target) target.status = restoring ? 'planned' : 'drafted';
    // Confirming one chapter moves the pen to the next one. Going back to fix an
    // older chapter must not rewind that, or one edit to chapter one would
    // un-confirm everything after it. Restoring is the exception: the chapter
    // becomes "not adapted" again, so the pen belongs back on it.
    if (restoring) draft.adaptation.cursor = chapterId;
    else if (cursorId === chapterId) draft.adaptation.cursor = nextAdaptChapterId(draft, chapterId);
  });

  // Once accepted a proposal is spent: the same draft must not be applied twice,
  // and the second attempt would fail the revision check anyway.
  if (proposal) await proposals.remove(projectId, chapterId);
  const latest = await store.read(projectId);
  return { chapter: latest.drafts[chapterId], adaptation: latest.adaptation };
}

/** An error carrying the HTTP status the route should answer with. */
function httpFailure(status, message) {
  const failure = new Error(message);
  failure.status = status;
  return failure;
}