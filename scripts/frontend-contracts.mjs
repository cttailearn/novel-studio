// 前端静态契约测试：不启动服务，也不冒充真实浏览器行为验证。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const settings = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

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

console.log("frontend contracts: OK（静态契约；真实浏览器交互未验证）");
