// 前端静态契约测试：不启动服务，也不冒充真实浏览器行为验证。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const update = await readFile(new URL("../public/update.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));

function functionBody(name) {
	const start = app.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `缺少函数 ${name}`);
	const brace = app.indexOf("{", start);
	let depth = 0;
	for (let i = brace; i < app.length; i += 1) {
		if (app[i] === "{") depth += 1;
		if (app[i] === "}") depth -= 1;
		if (depth === 0) return app.slice(brace + 1, i);
	}
	throw new Error(`函数 ${name} 未闭合`);
}

// app.js 是浏览器 ES module；用 vm 编译可检查语法而不执行 DOM 启动代码。
const { SourceTextModule } = await import("node:vm");
if (typeof SourceTextModule === "function") {
	new SourceTextModule(app);
	new SourceTextModule(settings);
	new SourceTextModule(update);
}

const manuscript = functionBody("renderManuscriptView");
assert.match(manuscript, /state\.editing && liveEditor\?\.dataset\.chapterId === state\.chapterId/);
assert.match(manuscript, /return;/, "同章活编辑器必须在 replaceChildren 前早退");
assert.ok(manuscript.indexOf("liveEditor") < manuscript.indexOf("box.replaceChildren()"));
assert.match(app, /editor\.dataset\.chapterId = chapter\.id/);

const writeChapter = functionBody("setWriteChapter");
assert.match(app, /async function setWriteChapter\(chapterId\)/);
assert.ok(writeChapter.indexOf("await flushEditor()") < writeChapter.indexOf("state.chapterId = current.id"));
assert.match(writeChapter, /state\.projectId !== projectId \|\| state\.chapterId !== originalChapterId/);
assert.match(writeChapter, /if \(!next \|\| !projectId\) return false/);

assert.match(app, /node\.dataset\.action = action\.data\.kind/);
assert.match(app, /document\.addEventListener\("click",[\s\S]*?closest\("\[data-action\]"\)/);
assert.match(app, /retryData: \{ kind: "retry-round", pane, text, outgoing \}/);
assert.match(app, /retryData: \{ kind: "retry-write", mode, note, chapterId \}/);
assert.match(app, /chip\.dataset\.action = "ask-option"/);
assert.match(app, /send\.dataset\.action = "ask-send"/);
assert.match(app, /skip\.dataset\.action = "ask-skip"/);
assert.match(app, /!event\.shiftKey && !isImeComposing\(event\)/);
assert.match(app, /event\.isComposing \|\| event\.keyCode === 229/);

assert.match(app, /function trapDrawerTab\(event, container\)/);
assert.match(app, /if \(desk\) desk\.inert = true/);
assert.match(app, /if \(desk\) desk\.inert = false/);
assert.match(app, /function setMobileDrawerState\(kind, open\)/);
assert.match(html, /<link rel="icon" href="\/favicon-32\.png" type="image\/png" sizes="32x32"/);
assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
assert.match(html, /<link rel="manifest" href="\/manifest\.json"/);
for (const icon of ["/icon-192.png", "/icon-512.png"]) {
	assert.ok(manifest.icons.some((entry) => entry.src === icon && entry.sizes !== "any"), `manifest 缺少 ${icon}`);
}
assert.ok(manifest.icons.some((entry) => entry.src === "/icon-512.png" && entry.purpose === "maskable"));
assert.match(html, /id="mobile-nav"[^>]*aria-label="主导航"/);
for (const view of ["home", "manuscript", "materials", "writing"]) {
	assert.match(html, new RegExp(`data-mobile-view="${view}"`));
}
assert.match(html, /id="mobile-tools"[^>]*aria-haspopup="dialog"[^>]*aria-controls="mobile-tools-dialog"/);
assert.match(html, /id="mobile-tools-dialog"[^>]*tabindex="-1"/);
for (const tool of ["rail", "tools", "bible", "palette", "theme", "settings"]) {
	assert.match(html, new RegExp(`data-mobile-tool="${tool}"`));
}
assert.match(app, /function updateMobileNav\(\)/);
assert.match(app, /function showMobileView\(view\)/);
assert.match(app, /function openMobileTools\(\)/);
assert.match(app, /function runMobileTool\(tool\)/);
assert.match(app, /document\.querySelectorAll\("\[data-mobile-view\]"\)/);
assert.match(app, /document\.querySelectorAll\("\[data-mobile-tool\]"\)/);
assert.match(app, /function enhanceMobileSheets\(\)/);
assert.match(app, /mobile-form-submit/);
assert.match(app, /mobile-form-cancel/);
assert.match(app, /window\.visualViewport\?\.addEventListener\("resize", syncKeyboardInset\)/);
assert.ok(!html.includes("mobile-nav-glyph"));
assert.match(css, /\.bench-talk \.pane-note \{ display: none; \}/);
assert.match(css, /\.palette \{[^}]*opacity: 1 !important;[^}]*transform: none !important;/);
assert.match(app, /const compact = phoneQuery\?\.matches/);
assert.match(app, /project\.stats\.chapters \+ " 章 · " \+ fmt\(project\.stats\.words\)/);
assert.match(settings, /暂无可用模型/);
assert.match(settings, /先在下方配置供应商并填入 API Key/);
assert.match(app, /panel\.setAttribute\("aria-modal", "true"\)/);
assert.match(app, /restoreFocus\(railDrawerTrigger\)/);
assert.match(app, /restoreFocus\(bibleDrawerTrigger\)/);

for (const view of ["manuscript", "materials", "writing"]) {
	assert.match(html, new RegExp(`id="tab-${view}"[^>]*role="tab"[^>]*aria-controls="view-${view}"`));
	assert.match(html, new RegExp(`id="view-${view}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${view}"`));
}
assert.match(html, /id="bible"[^>]*role="tabpanel"/);
// 改编台是写作台之外独立的一间：没有第四个页签，不能与稿 / 料 / 文共用版面。
assert.ok(!html.includes('id="tab-adapt"'));
assert.ok(!html.includes('data-view="adapt"'));
assert.match(html, /id="adapt-app"[^>]*role="region"/);
assert.match(html, /id="adapt-chapters"/);
assert.match(app, /function openAdaptApp\(/);
assert.match(app, /function enterAdaptMode\(/);
assert.match(app, /classList\.toggle\("adapt-open"/);
assert.match(css, /body\.adapt-open \.desk > \.beam/);
// 章名两处都能改：改编者调 rename_chapter 当场改，作者点章目行尾那一笔、或双击标题手改。
// 手动那扇门只改题目，正文与稿次一概不碰，所以走的是章目接口而不是存稿接口。
assert.match(html, /id="adapt-rename-dialog"[\s\S]*?id="adapt-rename-input"/);
assert.match(html, /id="adapt-chapter-title"[^>]*title="双击改章名"/);
assert.match(html, /id="adapt-rename"[^>]*>改名</);
assert.match(app, /function openAdaptRenameDialog\(/);
assert.match(app, /function saveAdaptRename\(/);
assert.match(functionBody("openAdaptRenameDialog"), /openDialog\(\$\("adapt-rename-dialog"\)/);
assert.match(functionBody("renderAdaptChapterList"), /el\("button", "adapt-chapter-rename"/);
assert.match(functionBody("renderAdaptChapterList"), /openAdaptRenameDialog\(item\.id\)/);
assert.match(app, /"adapt-chapter-title"\)\?\.addEventListener\("dblclick"/);
assert.match(app, /\/outline\/" \+ encodeURIComponent\(chapterId\)/);
assert.match(css, /\.adapt-chapter-rename\s*\{/);
assert.match(css, /\.adapt-chapter-item\.is-on \.adapt-chapter-rename/);
// 改编只能一章一章往下走：章目按游标记「轮到 / 只看」，没轮到的章动作栏先说明白、
// 再给一颗跳过去的按钮；服务端两头都拦，前端这层只是省一次往返。
assert.match(app, /function adaptCursorId\(/);
// 进改编台先落在「正轮到的那一章」：落在已确认的章上，满屏只读还得自己找路。
assert.match(app, /function adaptLandingChapterId\(/);
assert.match(functionBody("adaptLandingChapterId"), /adaptCursorId\(project\)/);
assert.match(functionBody("renderAdaptView"), /adaptLandingChapterId\(project\)/);
// 换卷复位时别把编辑器的口径丢了：marksOn 一丢，<mark> 就全平掉了（selectProject 里整块重设 state.adapt）。
const adaptReset = app.slice(app.indexOf('marksOn: state.adapt?.marksOn ?? true') - 400, app.indexOf('marksOn: state.adapt?.marksOn ?? true') + 200);
assert.match(adaptReset, /state\.adapt = \{/);
assert.match(adaptReset, /baseKey: ""/);
assert.match(functionBody("renderAdaptChapterList"), /adaptiveCursorId|adaptCursorId\(project\)/);
assert.match(functionBody("renderAdaptChapterList"), /" is-locked"/);
assert.match(functionBody("renderAdaptActions"), /adapt-lock-note/);
assert.match(functionBody("submitAdapt"), /adaptCursorId\(project\)/);
assert.match(app, /\/adaptation\/cursor/);
assert.match(css, /\.adapt-lock-note\s*\{/);
assert.match(css, /\.adapt-chapter-item\.is-locked \.adapt-chapter-name/);
// 改编稿不用再点「手改」：稿子落在 contenteditable 里，生成完直接就能改；
// 改过的句子用 <mark> 就地标出来，可以关掉。所以编辑器不能再是 textarea。
assert.match(html, /id="adapt-editor"[^>]*contenteditable="true"/);
assert.ok(!html.includes('<textarea id="adapt-editor"'));
assert.match(html, /id="adapt-mark"[^>]*aria-pressed="true"/);
assert.match(app, /function readAdaptEditor\(/);
assert.match(app, /function adaptDiffSegments\(/);
assert.match(app, /function paintAdaptEditor\(/);
assert.match(app, /function syncAdaptEditor\(/);
// 打字就落户：编辑器不必先按一个「手改」，敲下去的状态直接算草稿，按钮跟着亮。
assert.match(app, /state\.adapt\.draft = readAdaptEditor\(\)/);
assert.match(app, /state\.adapt\.draftDirty = state\.adapt\.draft !== \(state\.adapt\.adopted\?\.content \?\? ""\)/);
// 轮不到这一章的交代框是灰的：留着能打字，作者会白等一轮 409。
assert.match(app, /composer\.disabled = !editable/);
assert.match(app, /button\[type="submit"\]/);
assert.match(css, /\.adapt-dock \.composer textarea:disabled\s*\{/);
assert.match(app, /el\("mark", "adapt-mark"\)/);
assert.match(css, /\.adapt-editor mark\.adapt-mark/);
assert.match(css, /\.adapt-editor\.is-plain mark\.adapt-mark/);
// 智能体的动静收着：跑起来不自动张对话，出错才张；没有改动记录时那条横栏整块收起来。
// runAdapt 的入参里带默认对象（options = {}），按大括号配对取函数体会被那个 {} 截断，
// 这里改用「到下一个顶层 async function 之前」的切片。
const runAdaptStart = app.indexOf("async function runAdapt(");
assert.notEqual(runAdaptStart, -1, "缺少函数 runAdapt");
const runAdaptBody = app.slice(runAdaptStart, app.indexOf("\nasync function ", runAdaptStart + 24));
// 只有出错那一处才张对话：别的地方都不许碰。
assert.equal((runAdaptBody.match(/setAdaptTalk\(true\)/g) ?? []).length, 1, "runAdapt 只该在出错时张一次对话");
assert.ok(runAdaptBody.indexOf("setAdaptTalk(true)") > runAdaptBody.indexOf("catch (error)"), "张对话要落在 catch 里");

// 高亮靠这四个纯函数算：把它们原样捞进一个空上下文里真跑一遍，
// 免得「换个名字却整句发红」这种手感问题只能靠人眼发现。
function functionSource(name) {
	const start = app.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `缺少函数 ${name}`);
	const params = app.indexOf(")", start);
	const brace = app.indexOf("{", params);
	let depth = 0;
	for (let i = brace; i < app.length; i += 1) {
		if (app[i] === "{") depth += 1;
		if (app[i] === "}") depth -= 1;
		if (depth === 0) return app.slice(start, i + 1);
	}
	throw new Error(`函数 ${name} 未闭合`);
}

const vmModule = await import("node:vm");
const diffSandbox = vmModule.createContext({});
for (const name of ["adaptSentences", "adaptSentenceAnchors", "adaptSentencePieces", "adaptDiffSegments"]) {
	vmModule.runInContext(functionSource(name), diffSandbox);
}

const markedText = (source, target) =>
	diffSandbox
		.adaptDiffSegments(source, target)
		.filter((piece) => piece.changed)
		.map((piece) => piece.text)
		.join("");

// 只换个名字：亮的就是名字，前后那些字一个字都不许带上。
assert.equal(markedText("阿青走进渡口，看见船底有洞。", "青禾走进渡口，看见船底有洞。"), "青禾");
assert.equal(markedText("渡口很静。阿青坐下。", "渡口很静。青禾坐下。"), "青禾");
// 一字没动：整篇都不亮。
assert.equal(markedText("渡口很静。船停在岸边。", "渡口很静。船停在岸边。"), "");
// 多写一句：新添的那句整句亮，老句子不亮。
assert.equal(markedText("渡口很静。", "渡口很静。阿青坐下。"), "阿青坐下。");
// 原文空着（第一次写）：整篇都算新写的。
assert.equal(markedText("", "渡口很静。"), "渡口很静。");
// 改后的文字要一字不差地拼回新稿：高亮只是上色，不能改动正文。
for (const [source, target] of [
	["阿青走进渡口，看见船底有洞。", "青禾走进渡口，看见船底有洞，转身就走。"],
	["第一句。\n第二段。", "第一句。\n第二段改了。\n"],
	["甲。乙。丙。", "丙。乙。甲。"],
]) {
	assert.equal(
		diffSandbox
			.adaptDiffSegments(source, target)
			.map((piece) => piece.text)
			.join(""),
		target,
		"高亮分段拼回去必须还是新稿原文",
	);
}
assert.match(functionBody("renderAdaptChanges"), /"is-empty"/);
assert.match(css, /\.adapt-changes\.is-empty\s*\{\s*display:\s*none/);
assert.match(app, /function bindTabKeyboard\(tablist, selector\)/);
assert.match(app, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
assert.match(app, /tab\.tabIndex = on \? 0 : -1/g);

assert.match(html, /id="palette-input"[^>]*role="combobox"[^>]*aria-controls="palette-results"/);
assert.match(app, /row\.id = "palette-option-" \+ index/);
assert.match(app, /input\.setAttribute\("aria-activedescendant", rows\[index\]\.id\)/);
assert.match(app, /row\.addEventListener\("mousemove", \(\) => setPaletteIndex\(index\)\)/);

const search = functionBody("bindSearch");
assert.match(search, /timer = setTimeout\(apply, 180\)/);
assert.match(search, /clearTimeout\(timer\)/);
assert.match(search, /input\.focus\(\{ preventScroll: true \}\)/);

assert.match(html, /id="settings-tab-models"[^>]*role="tab"[^>]*aria-controls="settings-models-panel"/);
assert.match(html, /id="settings-tab-web"[^>]*role="tab"[^>]*aria-controls="settings-web-panel"/);
assert.match(html, /id="settings-web-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="settings-tab-web"/);
assert.match(html, /id="settings-tab-about"[^>]*role="tab"[^>]*aria-controls="settings-about-panel"/);
assert.match(html, /id="settings-about-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="settings-tab-about"/);
assert.match(settings, /from "\.\/update\.js"/);
assert.match(settings, /\["models", "web", "about"\]/);
assert.match(settings, /function isTauriShell\(\)/);
assert.ok(!settings.includes("数据与密钥保存在本机应用数据目录"));
assert.ok(!settings.includes("data/credentials.json"));
assert.ok(!html.includes("provider-key-storage-hint"));
assert.ok(!html.includes("覆盖环境变量"));
assert.ok(!html.includes("新对话使用"));
assert.match(settings, /function relayLink\(baseUrl\)/);
assert.match(settings, /查看cttai中转/);
assert.match(update, /const AUTO_CHECK_KEY = "mogeng\.update\.auto-check"/);
assert.match(update, /invoke\("update_check"\)/);
assert.match(update, /invoke\("update_install"\)/);
assert.match(update, /LATEST_RELEASE_API/);
assert.match(update, /aria-live/);
assert.ok(!update.includes("innerHTML"), "更新面板不应以 HTML 字符串拼接远端说明");
assert.match(settings, /function setSection\(section\)/);
assert.match(settings, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
assert.match(settings, /test\.disabled = !\(web\.enabled && web\.configured\)/);
assert.match(settings, /保存失败时控件已经先被用户改过/);
assert.match(settings, /const enable = document\.createElement\("input"\)/);
assert.match(html, /class="defaults-fields"[\s\S]*?id="settings-default-model"[\s\S]*?id="settings-default-thinking"/);
assert.match(settings, /querySelector\("\.settings-defaults \.defaults-fields"\)/);
assert.match(settings, /host\.append\(extra\)/);
assert.match(settings, /view\.returnFocus = document\.activeElement/);
assert.match(settings, /target\.focus\(\{ preventScroll: true \}\)/);
assert.match(settings, /const order = \["推荐", "国际通用", "国内厂商", "云平台与推理"\]/);
assert.match(settings, /保存 API Key 后，即可列出内置模型。/);
assert.ok(!settings.includes("innerHTML"), "设置页不应以 HTML 字符串拼接用户数据");

assert.match(html, /id="upload-pick"/);
assert.match(html, /id="novel-pick"/);
assert.match(html, /id="novel-input"/);
assert.match(html, /id="material-source-list"/);
assert.match(html, /id="material-source-count"/);
assert.match(html, /id="library-material-sources"/);
assert.match(app, /async function loadNovelSources\(/);
assert.match(app, /async function importMaterialFiles\(/);
assert.match(app, /fetch\("\/api\/material-sources" \+ query/);
assert.match(app, /kind=\$\{kind\}/);
assert.match(app, /function renderMaterialSources\(/);
assert.match(app, /function materialSourceGroup\(/);
assert.match(app, /el\("details", "material-source-group"\)/);
assert.match(app, /materialSourceGroup\(kind, grouped, pane\)/);
assert.match(app, /function materialSourceCard\(/);
assert.match(app, /source\.kind === "document" \? "资料" : "小说"/);
const useNovel = functionBody("useNovelSource");
assert.match(useNovel, /sourceId: \$\{source\.id\}/);
assert.ok(!useNovel.includes("entry.text") && !useNovel.includes("source.text"), "原料提炼只能传 sourceId，不能把全文塞进对话");

console.log("frontend contracts: OK（静态契约；真实浏览器交互未验证）");
