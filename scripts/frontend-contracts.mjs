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
assert.match(settings, /数据与密钥保存在本机应用数据目录/);
assert.match(settings, /仅保存在本机应用数据目录（SQLite）/);
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
