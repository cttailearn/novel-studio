// 前端静态契约测试：不启动服务，也不冒充真实浏览器。
//
// 这套断言守的是「不能靠肉眼发现、坏了以后症状离现场很远」的几件事：
// 启动顺序、挂点 id、高度链与滚动容器、设计令牌纪律、以及几条产品行为。
// 交互本身不在这里验（scripts/workbench.ts 跑真服务，另用 jsdom 冒烟）。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const publicDir = path.join(root, "public");
const read = (name) => readFile(path.join(publicDir, name), "utf8");

const html = await read("index.html");
const app = await read("app.js");
const boot = await read("boot.js");
const themeInit = await read("theme-init.js");
const update = await read("update.js");
const manifest = JSON.parse(await read("manifest.json"));
const style = await read("style.css");
const views = await read("views.css");
const overlays = await read("overlays.css");
const accountJs = await read("account.js");

const moduleNames = (await readdir(path.join(publicDir, "app"))).filter((name) => name.endsWith(".js")).sort();
const modules = new Map();
for (const name of moduleNames) modules.set(name, await read(path.join("app", name)));
// 提问走的是服务端事件，前端认不认同一个名字只能对着源码比。
const askSource = await readFile(path.join(root, "src/server/ask.ts"), "utf8");

const allJs = [app, ...modules.values()].join("\n");
const allCss = [style, views, overlays].join("\n");

/* ---------------------------------------------------------------- 一张网 */

const checks = [];
function check(name, run) {
	checks.push({ name, run });
}
function expect(pattern, text, message) {
	assert.match(text, pattern, message);
}
function expectNot(pattern, text, message) {
	assert.doesNotMatch(text, pattern, message);
}

/* ------------------------------------------------------- 0. 语法与图 */

// 浏览器 ES module 用 vm 编译：只查语法，不执行任何 DOM 代码。
const { SourceTextModule } = await import("node:vm");
if (typeof SourceTextModule === "function") {
	check("所有前端模块语法正确", () => {
		for (const [name, source] of [["app.js", app], ...modules]) {
			assert.doesNotThrow(() => new SourceTextModule(source, { identifier: name }), `${name} 语法错误`);
		}
	});
}

check("入口模块都在", () => {
	for (const required of ["core.js", "api.js", "ctx.js", "desk.js", "studio.js", "paper.js", "materials.js", "outline.js", "dock.js", "adapt.js", "settings-view.js", "palette.js", "share.js"]) {
		assert.ok(modules.has(required), `缺少 public/app/${required}`);
	}
});

// 相对 import 必须都指向真实存在的模块：少一个，整页就停在白屏。
check("模块之间的相对导入都指得到", () => {
	const missing = [];
	for (const [name, source] of [["app.js", app], ...modules]) {
		const fromDir = name === "app.js" ? "public" : "public/app";
		for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const rel = match[1];
			const target = path.posix.normalize(path.posix.join(fromDir, rel));
			if (!existsSync(path.resolve(root, target))) missing.push(`${name} -> ${rel}`);
		}
	}
	assert.equal(missing.length, 0, missing.join(" "));
});

/* ------------------------------------------------------- 1. 启动顺序 */

// boot.js 负责在 Tauri / 本地单机模式下把 /api 换成浏览器内实现；
// 服务端会把模式标记插在它前面，所以这一行必须原样存在于首屏 HTML。
check("首屏带 boot 标签（服务端要往里插模式标记）", () => {
	expect(/<script src="\/boot\.js"><\/script>/, html);
});

check("先定主题再上样式，避免白闪", () => {
	const themeAt = html.indexOf('src="/theme-init.js"');
	const styleAt = html.indexOf('href="/style.css"');
	assert.ok(themeAt > 0, "缺少 theme-init.js");
	assert.ok(styleAt > themeAt, "theme-init.js 必须排在 style.css 之前");
	expect(/dataset\.theme/, themeInit, "theme-init 要直接写 dataset.theme");
	expect(/novel-studio-theme/, themeInit);
});

check("模块入口排在 boot 之后", () => {
	const bootAt = html.indexOf('src="/boot.js"');
	const appAt = html.indexOf('src="/app.js"');
	assert.ok(appAt > bootAt, "app.js 必须在 boot.js 之后加载");
	expect(/<script type="module" src="\/app\.js"><\/script>/, html);
});

check("importmap 把 pi-ai 指到浏览器内实现", () => {
	expect(/type="importmap"/, html);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"]) {
		assert.ok(html.includes(name), `importmap 缺少 ${name}`);
	}
	expect(/"\/browser\/vendor\/pi-ai\/shim\.js"/, html);
});

check("PWA 清单与图标齐全", () => {
	expect(/<link rel="manifest" href="\/manifest\.json"/, html);
	expect(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/, html);
	for (const icon of ["/icon-192.png", "/icon-512.png"]) {
		assert.ok(manifest.icons.some((entry) => entry.src === icon), `manifest 缺少 ${icon}`);
	}
	assert.ok(manifest.icons.some((entry) => entry.src === "/icon-512.png" && entry.purpose === "maskable"));
});

check("首屏有靴子骨架，脚本跑起来会被撤掉", () => {
	expect(/id="boot-skeleton"/, html);
	expect(/boot-skeleton/, app, "入口要负责在挂载后移除骨架");
	expect(/data-mounted/, html);
});

/* --------------------------------------------------- 2. 结构与挂点 id */

check("三间屋都在：案头 / 写作台 / 改编台", () => {
	for (const view of ["desk", "studio", "adapt"]) {
		expect(new RegExp(`id="view-${view}"`), html, `缺少 #view-${view}`);
	}
	expect(/id="app"[^>]*data-view="desk"/, html);
});

check("书脊导航的五个去处", () => {
	for (const nav of ["desk", "paper", "materials", "outline", "library"]) {
		expect(new RegExp(`class="spine-btn[^"]*"[^>]*data-nav="${nav}"|data-nav="${nav}"[^>]*class="spine-btn`), html, `书脊缺 ${nav}`);
	}
});

check("写作台的四件：章目、纸面、素材、大纲", () => {
	for (const id of ["rail", "rail-list", "ring-value", "ms-page", "ms-body", "ms-title", "mat-scroll", "outline-scroll", "paper-actions"]) {
		assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
	}
	expect(/id="ms-body"[^>]*spellcheck="false"/, html, "正文输入框应关掉拼写检查");
});

check("副驾坞有三个身份与一条输入", () => {
	expect(/id="dock-roles"/, html);
	for (const role of ["writing", "material", "polish"]) {
		expect(new RegExp(`data-role="${role}"`), html, `副驾缺 ${role}`);
	}
	for (const id of ["dock-stream", "dock-input", "btn-dock-send", "dock-model-label"]) {
		assert.ok(html.includes(`id="${id}"`), `副驾缺 #${id}`);
	}
});

check("命令面板是可访问的 combobox", () => {
	expect(/id="palette-input"[^>]*role="combobox"[^>]*aria-controls="palette-list"/, html);
	expect(/id="palette-list"[^>]*role="listbox"/, html);
	expect(/aria-activedescendant/, modules.get("palette.js"), "选中项要写回输入框");
});

check("设置面板四页，并给更新面板留好位置", () => {
	for (const panel of ["model", "prefs", "data", "about"]) {
		assert.ok(html.includes(`id="settings-panel-${panel}"`), `缺少 #settings-panel-${panel}`);
		assert.ok(html.includes(`data-panel="${panel}"`), `设置导航缺 ${panel}`);
	}
	// update.js 把「检查更新」画进这个容器；容器没了，整块会静默消失。
	expect(/id="settings-about-panel"/, html);
	expect(/id="settings-update-nav-dot"/, html);
	expect(/id="settings-mode-line"/, html);
	expect(/<dialog[^>]*id="settings"/, html);
});

check("上传用的隐藏 file input 都在", () => {
	for (const id of ["material-file-input", "library-file-input", "source-file-input", "novel-file-input"]) {
		assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
	}
	expect(/id="source-file-input"[^>]*accept="[^"]*\.epub/, html, "原料库要能收 epub");
	expect(/id="novel-file-input"[^>]*accept="[^"]*\.novel/, html, "搬家要能收 .novel");
});

check("移动端底部导航与抽屉", () => {
	expect(/id="mobile-nav"/, html);
	for (const nav of ["desk", "paper", "materials", "outline", "dock"]) {
		expect(new RegExp(`data-nav="${nav}"`), html, `移动导航缺 ${nav}`);
	}
	for (const id of ["drawer", "scrim", "toasts", "modal"]) {
		assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
	}
});

check("页内 id 不重复", () => {
	const counts = new Map();
	for (const match of html.matchAll(/\sid="([^"]+)"/g)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
	assert.equal(duplicated.length, 0, `重复的 id：${duplicated.join(" ")}`);
});

// $() 取的是文档里第一个同名元素：取不到就静默变成 null，点下去毫无反应。
check("脚本取的每个 id 都解析得到", () => {
	const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
	// 模块既会直接赋值 .id，也会在 el() 的属性对象里写 id: "…"，两种都算自建节点。
	const dynamic = new Set([
		...[...allJs.matchAll(/\.id\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
		...[...allJs.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
		...[...allJs.matchAll(/setAttribute\(\s*"id"\s*,\s*"([^"]+)"/g)].map((m) => m[1]),
	]);
	const referenced = new Set([...allJs.matchAll(/\$\(\s*"#([a-z0-9-]+)"\s*\)/gi)].map((m) => m[1]));
	const missing = [...referenced].filter((id) => !htmlIds.has(id) && !dynamic.has(id));
	assert.equal(missing.length, 0, `找不到：${missing.join(" ")}`);
});

/* ------------------------------------------------- 3. 高度链与滚动 */

// 整页不滚动：每一层都要让步给下一层，最后只有稿纸和对话流自己滚。
check("高度链逐级归零 min-height", () => {
	const chain = [".app-main", ".stage", ".view", ".view-studio.is-active", ".rail", ".paper-shell", ".paper-body", ".pane", ".dock"];
	const flat = allCss.replace(/\s+/g, " ");
	const broken = chain.filter((selector) => {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return !new RegExp(`${escaped} \\{[^}]*min-height: 0`).test(flat);
	});
	assert.equal(broken.length, 0, broken.join(" "));
});

check("稿纸自己是滚动容器", () => {
	const flat = views.replace(/\s+/g, " ");
	expect(/\.ms-scroll \{[^}]*overflow-y: auto/, flat);
	expect(/\.ms-body \{[^}]*resize: none/, flat, "正文框不该出现拖拽把手");
});

check("稿纸有死宽度，不被 fit-content 收窄", () => {
	const flat = views.replace(/\s+/g, " ");
	expect(/\.ms-page \{[^}]*width: min\(100%/, flat);
	expect(/\.dock-stream \{[^}]*overflow-y: auto/, flat);
});

check("正文框会跟着内容长高", () => {
	expect(/function fit\(\)/, modules.get("paper.js"));
	expect(/textarea\.style\.height = `\$\{Math\.max\(textarea\.scrollHeight, 320\)\}px`/, modules.get("paper.js"));
	expect(/textarea\?\.addEventListener\("input"[\s\S]{0,120}?fit\(\)/, modules.get("paper.js"));
});

/* --------------------------------------------------------- 4. 令牌纪律 */

const styleNoComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
const tokenBlock = (pattern) => [...styleNoComments.matchAll(pattern)].map((m) => m[0]);
const lightBlocks = tokenBlock(/^:root \{[\s\S]*?^\}/gm);
const darkBlocks = tokenBlock(/^:root\[data-theme="dark"\] \{[\s\S]*?^\}/gm);

check("亮/暗两套令牌都在", () => {
	assert.ok(lightBlocks.length >= 1, "缺少 :root 令牌块");
	assert.ok(darkBlocks.length >= 1, "缺少暗色令牌块");
	expect(/color-scheme: light;/, style);
	expect(/color-scheme: dark;/, style, "暗色块要声明 color-scheme，原生控件才跟着变");
});

check("令牌块之外没有硬编码颜色", () => {
	let outside = styleNoComments;
	for (const block of [...lightBlocks, ...darkBlocks].sort((a, b) => b.length - a.length)) outside = outside.split(block).join("");
	const hardcoded = outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
	assert.equal(hardcoded.length, 0, `漏了：${hardcoded.slice(0, 6).join(" ")}`);
});

check("按 var() 取的令牌都有定义", () => {
	const css = allCss.replace(/\/\*[\s\S]*?\*\//g, "");
	const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
	const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
	const undefined = [...used].filter((name) => !declared.has(name));
	assert.equal(undefined.length, 0, undefined.join(" "));
});

check("会变色的令牌暗色都覆盖了", () => {
	// 尺度类令牌（字号/间距/圆角/栏宽/字体）与昼夜无关，不要求重复定义。
	const scale = /^--(ui|song|mono|serif|kai|sans|fs-|sp-|r-|spine-w|rail-w|dock-w|top-h|nav-h|tap|paper-fs|paper-lh|reader-fs|reader-lh|measure|ease|fast|base|slow|lh-|i-|brush|cinnabar|rule|moss|elev|hover)/;
	const names = (blocks) => new Set(blocks.flatMap((block) => [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
	const light = names(lightBlocks);
	const dark = names(darkBlocks);
	const missing = [...light].filter((name) => !dark.has(name) && !scale.test(name) && !name.startsWith("--safe-"));
	assert.equal(missing.length, 0, missing.join(" "));
});

check("尊重系统的减少动态效果", () => {
	expect(/@media \(prefers-reduced-motion: reduce\)/, allCss);
});

check("专注模式真的把三栏收起来", () => {
	const flat = allCss.replace(/\s+/g, " ");
	expect(/\.app\.is-focus/, flat);
	expect(/\.app\.is-focus[^{]*\{[^}]*\.spine|\.app\.is-focus \.spine/, flat, "专注模式应藏起书脊");
	expect(/\.app\.dock-open/, flat);
	expect(/\.app\.rail-open/, flat);
});

check("有窄屏断点，且三栏会变成抽屉", () => {
	const breaks = [...allCss.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
	assert.ok(breaks.some((width) => width <= 900), `缺少窄屏断点：${breaks.join(",")}`);
	assert.ok(breaks.some((width) => width >= 1100), `缺少收窄断点：${breaks.join(",")}`);
});

/* --------------------------------------------------- 5. 产品行为（代码级） */

check("正文自动存稿，切章前先落盘", () => {
	const ctx = modules.get("ctx.js");
	expect(/1100/, ctx, "自动存稿的节流窗口");
	expect(/autosave: true/, ctx);
	// 切章顺序错了就会把上一章的改动写进下一章。
	const openAt = ctx.indexOf("export async function openChapter");
	const flushAt = ctx.indexOf("await flushSave()", openAt);
	const setAt = ctx.indexOf("state.activeId = id", openAt);
	assert.ok(flushAt > openAt && setAt > flushAt, "openChapter 必须先 flushSave 再换 activeId");
});

check("换章换纸，但同一章里不抢正文", () => {
	const paper = modules.get("paper.js");
	expect(/textarea\?\.dataset\.chapter !== draft\.id/, paper);
	expect(/document\.activeElement !== textarea/, paper);
});

check("el() 认得 on: { … } 写法", () => {
	// 曾经只认 onclick，全站按钮因此一个都没挂上事件。
	const core = modules.get("core.js");
	expect(/key === "on" && typeof value === "object"/, core);
	expect(/addEventListener\(event, handler\)/, core);
	expect(/export function pack\(/, core, "可选子节点要能摊平，别把 null 变成文本");
});

check("流式协议按 NDJSON 逐行读", () => {
	const api = modules.get("api.js");
	expect(/streamNdjson/, api);
	expect(/indexOf\("\\n"\)/, api, "要按换行切行，不能把整段当一条");
	expect(/x-run/, api, "要能接住断线重连的运行号");
	expect(/x-write-replay/, api, "重放标记要能看见");
});

check("写作流把思考、工具、结果分开", () => {
	const paper = modules.get("paper.js");
	expect(/thinking/, paper);
	expect(/tool_start/, paper);
	expect(/run_end/, paper);
	expect(/savedRevision/, paper);
});

check("断线后能接回同一条流", () => {
	const api = modules.get("api.js");
	expect(/\/api\/runs\/\$\{encodeURIComponent\(id\)\}\/stream/, api);
	expect(/since/, api);
});

check("改编一章一章往下走", () => {
	const adapt = modules.get("adapt.js");
	expect(/adaptation\.cursor|cursorChapterId/, adapt, "顺序读 adaptation.cursor");
	expect(/reportSequenceError|adaptSequenceError|一章一章往下走/, adapt, "顺序错误要翻译成人话");
	expect(/saveAuthorVersion/, adapt, "作者手写的稿也要能存");
	expect(/openReader/, adapt, "改编稿要能整屏读");
	expect(/kind-title|章名/, adapt, "章名改动要进台账");
});

check("读稿台整屏读、整屏改、能对照", () => {
	const reader = modules.get("reader.js");
	expect(/openReader/, reader);
	expect(/reader-input|markDirty/, reader, "整屏也能改正文，改的是同一份稿");
	expect(/applyPolish|diffSegments|lcs|reader-mark/, reader, "对照原书要高亮改动");
	expect(/ArrowRight/, reader, "整屏也要能翻章");
	const css = allCss;
	expect(/\.reader \{[^}]*position: fixed/, css, "读稿台铺满整屏");
	expect(/body\.is-reading/, css, "读稿时锁住背后的滚动");
	expect(/@media \(max-width: 620px\)[\s\S]*\.reader-bar \{[^}]*flex-wrap/, css, "手机上工具条要折行");
});

check("读稿台里能叫副驾，改编工程还能直接让改编者改", () => {
	const reader = modules.get("reader.js");
	const dock = modules.get("dock.js");
	const readerHtml = html;
	expect(/id="reader-agent-btn"/, readerHtml);
	expect(/id="reader-agent"/, readerHtml);
	expect(/data-agent="chat"/, readerHtml);
	expect(/data-agent="adapt"/, readerHtml);
	expect(/mountDock\(/, reader, "读稿台把副驾搬进来，不是另开一层");
	expect(/unmountDock\(/, reader, "收起时还回原位");
	expect(/runAdaptInReader/, reader);
	expect(/adaptChapter/, reader, "改编者就在读稿台里动笔");
	expect(/applyProposal/, reader, "看中了就地采用");
	expect(/一章一章往下走|还没轮到/, reader, "顺序规矩要说人话");
	expect(/export function mountDock/, dock);
	expect(/export function unmountDock/, dock);
	expect(/\.reader-agent \{[^}]*border-left/, allCss, "副驾占读稿台右侧一栏");
});

check("副驾能答模型提问", () => {
	const dock = modules.get("dock.js");
	expect(/answerQuestion/, dock);
	expect(/ask-opt/, dock);
});

check("改编稿不落盘，采用才写", () => {
	const adapt = modules.get("adapt.js");
	expect(/applyProposal/, adapt);
	expect(/proposalId/, adapt);
	expect(/baseRevision|又改过一版/, adapt, "旧提案要被后端挡下并说清楚");
	expectNot(/saveChapter\(/, adapt, "改编台不该直接存正文");
});

check("润色走选区，替换要带预期值", () => {
	const paper = modules.get("paper.js");
	expect(/polishChapter/, paper);
	expect(/expectedRevision/, paper);
	expect(/stale/, paper);
});

// 校验行必须把 detail 显示出来。字段名对不上时页面上什么都不显示，
// 而检查本身照常通过 —— 这种错靠肉眼看不出来，所以在这里钉住。
check("润色校验行显示明细", () => {
	const paper = modules.get("paper.js");
	expect(/check\.detail/, paper, "renderChecks 要读 detail");
	expect(/check-note/, paper);
});

check("润色有去 AI 味的起手话", () => {
	const paper = modules.get("paper.js");
	expect(/去 AI 味/, paper);
	expect(/instruction\.value\s*=/, paper, "预设只填输入框，不直接开跑");
});

// 三处智能体调用共用同一张运行卡：跑着有动效、跑完点开仍能看到读过什么。
// 各屏各写一套的话，改一处就会漏一处 —— 上一版就是这样退化成静默流式的。
check("执笔者、设定官、润色的运行卡是同一张", () => {
	const card = modules.get("run-card.js");
	assert.ok(card, "要有一个共用的 run-card.js");
	expect(/export function createRunCard/, card);
	expect(/export function chapterRefs/, card, "卡里要能摊出这一章的正文与料");
	expect(/run-ref-use/, card, "正文与料要能一键抄进输入框");
	expect(/run-card-dot/, card);
	expect(/run-card-toggle/, card, "跑完折起来还得点得开");
	for (const name of ["paper.js", "dock.js"]) {
		const source = modules.get(name);
		expect(/createRunCard/, source, `${name} 要走共用的运行卡`);
	}
	const paper = modules.get("paper.js");
	// 执笔与润色都在 paper.js 里，各接一次。
	assert.ok(paper.match(/createRunCard\(/g).length >= 2, "稿纸与润色弹窗都要挂卡");
	const dock = modules.get("dock.js");
	expect(/chapterRefs/, dock, "副驾的运行卡也要摊出正文与料");
});

check("案头上的书能删，删了还能彻底删", () => {
	const desk = modules.get("desk.js");
	// 卡片上要有一个直接看得见的删除键：藏在 kebab 菜单里的删法，触屏上根本找不到。
	expect(/pc-del/, desk, "卡片右下角要有删除键");
	expect(/removeProject/, desk);
	expect(/purgeProject/, desk, "废纸篓里要能彻底删掉");
	expect(/api\.deleteProject/, desk, "先丢进废纸篓");
	expect(/api\.purgeProject/, desk, "再从废纸篓里抹掉");
	expect(/event\.stopPropagation\(\)/, desk, "删除键不能顺带把书打开");
	// 彻底删要作者把书名打一遍，误触一次不该烧掉一本书。
	expect(/typed/, desk, "打书名确认");
	const apiSource = modules.get("api.js");
	expect(/purgeProject/, apiSource);
	expect(/trash\/\$\{encodeURIComponent\(pid\)\}`\)/, apiSource);
});

check("导出与搬家都有出口", () => {
	const share = modules.get("share.js");
	expect(/saveFileNatively/, share, "Tauri 契约要求保留这个名字");
	expect(/exportNovel/, share);
	expect(/importNovel/, share);
	expect(/__mogengSaveFile/, share, "桌面端用原生保存对话框");
});

check("主题开关与首帧脚本用同一个键", () => {
	expect(/novel-studio-theme/, app);
	expect(/novel-studio-theme/, themeInit);
	expect(/#efe8d9|#17150f/, app, "切换时同步 meta theme-color");
});

check("设置面板接得上服务端", () => {
	const settings = modules.get("settings-view.js");
	expect(/getSettings|putSettings/, settings);
	expect(/createProvider/, settings);
	expect(/fetchProviderModels/, settings);
	expect(/retryStorage/, settings);
	expect(/restoreSnapshot/, settings);
	expect(/prefers-color-scheme|auto/, settings);
});

check("更新面板没被改坏", () => {
	expect(/AUTO_CHECK_KEY/, update);
	expect(/invoke\("update_check"\)/, update);
	expectNot(/innerHTML/, update, "远端说明不能拼 HTML");
});

check("本地模式与云端登录仍由 boot/auth-gate 接管", async () => {
	expect(/ensureAuth/, app, "入口要先过登录闸门");
	expect(/__NOVEL_AUTH_STATE__|ensureAuth/, await read("auth-gate.js"));
	expect(/__NOVEL_LOCAL_MODE__/, boot);
	expect(/\/browser\/local-api\.js/, boot);
	expect(/installNativeSave|__mogengSaveFile/, boot, "Tauri 原生保存仍要装上");
});

check("手机上正文优先：副驾先收成一条，改编台的改动区默认折起来", () => {
	// 副驾：手机上默认只露抬头与输入框，要聊再拉满；抽屉别压在底栏上。
	expect(/btn-dock-expand/, html, "副驾抬头要有展开对话的开关");
	expect(/setSheetExpanded/, modules.get("dock.js"), "副驾要能收放");
	expect(/is-expanded/, modules.get("dock.js"));
	expect(/sheetDock/, modules.get("dock.js"), "只在小屏上收放");
	expect(/dock-expand/, overlays, "开关只在窄屏出现");
	expect(/\.dock\s*\{[^}]*bottom:\s*calc\(var\(--nav-h\)/, overlays, "抽屉要停在底栏上方");
	expect(/\.dock \.dock-stream\s*\{\s*display:\s*none/, overlays, "收起来时不显示会话流");
	expect(/\.dock\.is-expanded \.dock-stream\s*\{\s*display:\s*flex/, overlays);
	// 改编台：窄屏正文在上，改动区折在下面且默认收起，点抬头才展开。
	expect(/\.adapt-paper-col\s*\{\s*grid-row:\s*1/, views, "正文排在上面");
	expect(/\.adapt-change-col\s*\{\s*grid-row:\s*2/, views);
	expect(/\.adapt-change-col\.is-collapsed \.adapt-scroll\s*\{\s*display:\s*none/, views, "折起来只剩一行抬头");
	const adapt = modules.get("adapt.js");
	expect(/changesOpen/, adapt, "记住作者自己开合过没有");
	expect(/is-collapsed/, adapt);
	expect(/adapt-col-toggle/, adapt);
	expect(/window\.matchMedia\("\(max-width: 920px\)"\)\.matches/, adapt, "只在小屏上折叠");
	// 稿纸工具条在手机上挤成一行，把竖着的地方让给正文。
	expect(/\.paper-bar\s*\{[^}]*flex-wrap:\s*nowrap/, views, "手机稿纸工具条一行就够");
});

check("动态 import 之后调的每个函数，目标模块都真的导出了", () => {
	// 「从库里取」曾经点了没反应：paper.js 把 materials 模块 import 进来调
	// openLibraryPicker()/pickFile()，而 materials.js 里这两个函数没写 export。
	// 这类坏法在控制台只留一条 TypeError，界面上就是一颗死按钮，所以静态守一道。
	const exportsOf = new Map();
	for (const [name, text] of modules) {
		exportsOf.set(
			name,
			new Set(
				[...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)|export\s+let\s+(\w+)/g)].map(
					(match) => match[1] || match[2] || match[3],
				),
			),
		);
	}
	const missing = [];
	// 从块首的 "{" 起按花括号配对，取出这一块自己，别让窗口漏到下一块去。
	const blockBody = (text, braceAt) => {
		let depth = 0;
		for (let i = braceAt; i < text.length; i += 1) {
			if (text[i] === "{") depth += 1;
			else if (text[i] === "}") {
				depth -= 1;
				if (depth === 0) return text.slice(braceAt, i + 1);
			}
		}
		return text.slice(braceAt, braceAt + 900);
	};
	for (const [name, text] of modules) {
		for (const block of text.matchAll(/import\("\.\/(\w+)\.js"\)\.then\(\s*\((mod|m)\)\s*=>\s*\{/g)) {
			const target = `${block[1]}.js`;
			const braceAt = block.index + block[0].length - 1;
			const body = blockBody(text, braceAt);
			for (const call of body.matchAll(new RegExp(`(?:mod|m)\\.(\\w+)\\(`, "g"))) {
				if (!exportsOf.get(target)?.has(call[1])) missing.push(`${name} → ${target}.${call[1]}()`);
			}
		}
		for (const assign of text.matchAll(/const\s+(?:mod|m)\s*=\s*await\s+import\("\.\/(\w+)\.js"\)/g)) {
			const target = `${assign[1]}.js`;
			const start = assign.index + assign[0].length;
			for (const call of text.slice(start, start + 1200).matchAll(/(?:mod|m)\.(\w+)\(/g)) {
				if (!exportsOf.get(target)?.has(call[1])) missing.push(`${name} → ${target}.${call[1]}()`);
			}
		}
	}
	assert.deepEqual(missing, [], `这些调用目标模块没导出：${missing.join("、")}`);
});

check("素材页那两颗按钮真的接上了", () => {
	const paper = modules.get("paper.js");
	const materials = modules.get("materials.js");
	expect(/export async function openLibraryPicker/, materials, "「从库里取」要导出");
	expect(/export function pickFile/, materials, "「导个文件」要导出");
	expect(/mod\.openLibraryPicker\(\)/, paper);
	expect(/mod\.pickFile\(\)/, paper);
});

check("智能体发问：服务端与副驾认的是同一个事件名", () => {
	// 服务端 AskQuestionEvent 发的是 type:"question"，副驾若只等 "ask"，
	// 问题就不出现，那一轮会一路吊到十分钟超时才自己往下走。
	const dock = modules.get("dock.js");
	expect(/type:\s*"question"/, askSource, "服务端台头事件名");
	expect(/"question_closed"/, askSource, "服务端收尾事件名");
	expect(/"question"/, dock, "副驾要认 question");
	expect(/"question_closed"/, dock, "副驾要认收尾事件");
	expect(/answerQuestion\(/, dock, "答话要真的送到 /api/questions/:id/answer");
	expect(/closedQuestion\(/, dock, "超时或这一轮收尾时要把卡片收掉");
});

check("副驾的提问卡有选项也有自由作答", () => {
	const dock = modules.get("dock.js");
	expect(/class:\s*"ask-card"/, dock);
	expect(/class:\s*"ask-opt"/, dock, "选项按钮");
	expect(/class:\s*"ask-custom"/, dock, "自由作答");
	expect(/class:\s*"ask-done"/, dock, "答过之后留一句交代");
});

check("起稿/续写想交代一句时，从「更多」里走", () => {
	// 工具条上的「起稿」「续写」是快路：一点就交给执笔者。
	// 想先交代一句的，走「更多」里的那条——两处最终都得调 runWrite(mode, note)。
	const paper = modules.get("paper.js");
	expect(/runWrite\("continue"\)/, paper, "续写快路还在");
	expect(/runWrite\("create"\)/, paper, "起稿快路还在");
	expect(/带一句交代再续写/, paper, "有稿时给带交代的续写");
	expect(/带一句交代再起稿/, paper, "空章时给带交代的起稿");
	expect(/confirmWrite\("continue"\)/, paper, "要开交代框");
	expect(/confirmWrite\("create"\)/, paper, "要开交代框");
	expect(/note:\s*note \|\| undefined/, paper, "交代要交给 /write 的 note");
});

check("设置里能配服务器、能连能断，本机模式不逼人登录", () => {
	// 手机装上先看到的是本机模式：账号面板只说明「本机也能写」，
	// 想连云端得自己点开表单；服务器地址与登录都在 设置 → 服务器 里。
	const settings = modules.get("settings-view.js");
	const account = accountJs;
	expect(/data-panel="server"/, html, "设置里要有「服务器」这一页");
	expect(/id="settings-panel-server"/, html, "要留一个容器给服务器面板");
	expect(/renderServerPanel\(\)/, settings, "面板要有人画");
	expect(/openCloudConnect\(/, settings, "「连上并登录」交给账号面板");
	expect(/openAccountPanel\(/, settings, "云端模式要能打开账号与用量");
	expect(/clearCloudConfig\(\)/, settings, "断开云端要真的清配置");
	expect(/localModeView\(\)/, account, "没有云端配置时先给本机说明页");
	expect(/state\.connectOpen \? connectView\(\) : localModeView\(\)/, account, "默认收起连接表单");
	expect(/先不连，用本机/, account, "展开后能退回本机");
	expect(/pendingBase/, account, "地址只在内存里等到登录成功");
});

check("Android 包给系统栏让位，顶栏按钮点得到", () => {
	// Android 15 起强制 edge-to-edge，WebView 里 env(safe-area-inset-*) 是 0：
	// 顶栏那排按钮会正落在状态栏底下，手指按不到。必须在生成的 MainActivity
	// 里按系统栏尺寸补 padding——而 gen/android 不入库，只能写进构建前补丁。
	return (async () => {
		const patch = await readFile(path.join(root, "scripts/android-patch.mjs"), "utf8");
		expect(/MOGENG_INSETS/, patch, "补丁要自带标记，重复执行不重复插");
		expect(/setOnApplyWindowInsetsListener/, patch, "要按 insets 让位");
		expect(/android\.R\.id\.content/, patch, "补在外壳根视图上，WebView 才跟着缩");
		expect(/enableEdgeToEdge/, patch, "保留 edge-to-edge，靠 padding 让位");
		expect(/MainActivity\.kt/, patch, "补的就是生成出来的 MainActivity");
	})();
});

/* ------------------------------------------------------------- 收尾 */

let failed = 0;
for (const item of checks) {
	try {
		await item.run();
		console.log(`  ok  ${item.name}`);
	} catch (error) {
		failed += 1;
		console.log(`  --  ${item.name}`);
		console.log(`      ${error.message}`);
	}
}
console.log(failed === 0 ? `\nfrontend contracts: ${checks.length} 项全通过` : `\nfrontend contracts: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
