// 墨耕 · 前端。不使用框架，直接消费后端 NDJSON 事件流。
//
// 界面按「写小说」而非「聊天」来组织：
// 左卷选卷与章目，中稿台读稿或对议，右案随时查人物世观与待办。

import { bindSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

const state = {
	projects: [],
	projectId: null,
	project: null,
	stats: null,
	sessionId: null,
	streaming: false,
	view: "manuscript",
	chapterId: null,
	editing: false,
	bibleTab: "characters",
};

const CN = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1 → 一，12 → 十二 */
function toCn(n) {
	if (n < 10) return CN[n] ?? String(n);
	if (n < 20) return "十" + (CN[n - 10] ?? "");
	const tens = Math.floor(n / 10);
	const ones = n % 10;
	return (CN[tens] ?? "") + "十" + (ones ? CN[ones] : "");
}

/** 与服务端 countWords 同口径：CJK 按字，西文按词 */
function countWords(text) {
	if (!text) return 0;
	const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
	const latin = text
		.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ")
		.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)?.length ?? 0;
	return cjk + latin;
}

function fmt(n) {
	return n >= 10000 ? Math.round((n / 10000) * 10) / 10 + " 万" : n.toLocaleString("zh-CN");
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

async function api(path, options = {}) {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...options,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || "请求失败 (" + res.status + ")");
	return data;
}

// ═══════════════════════════════════════════════════ 启动

async function bootstrap() {
	const data = await api("/api/bootstrap");
	state.projects = data.projects;
	renderModels(data.models, data.defaultModel);
	$("thinking-select").value = data.defaultThinkingLevel || "off";
	renderProjects();

	if (state.projects.length > 0) await selectProject(state.projects[0].id);
	else renderEmptyStage();
}

function renderEmptyStage() {
	const box = $("view-manuscript");
	box.replaceChildren();
	const wrap = el("div", "void");
	wrap.append(el("h3", "", "案上尚无卷宗"));
	wrap.append(el("p", "", "点左栏「另起一卷」立一部新书，或先到设置里备好笔墨，再回来开工。"));
	box.append(wrap);
}

function renderModels(models, defaultModel) {
	const select = $("model-select");
	select.replaceChildren();
	if (models.length === 0) {
		const option = el("option", "", "无可用模型");
		option.value = "";
		select.append(option);
		select.disabled = true;
		select.title = "请到设置中配置供应商";
		return;
	}
	select.disabled = false;
	for (const model of models) {
		const option = el("option", "", model.providerLabel + " · " + model.name);
		option.value = model.id;
		select.append(option);
	}
	const preferred = models.find((model) => model.id === defaultModel);
	if (preferred) select.value = preferred.id;
}

// ═══════════════════════════════════════════════════ 左卷

function renderProjects() {
	const list = $("project-list");
	list.replaceChildren();
	for (const project of state.projects) {
		const item = el("li", "project-item" + (project.id === state.projectId ? " is-on" : ""));
		item.append(el("div", "name", project.title));
		item.append(
			el(
				"div",
				"meta",
				project.stats.chapters + " 章 · " + fmt(project.stats.words) + " 字" +
					(project.stats.openNotes ? " · " + project.stats.openNotes + " 待办" : ""),
			),
		);
		item.addEventListener("click", () => selectProject(project.id));
		list.append(item);
	}
}

function renderChapters() {
	const list = $("chapter-list");
	list.replaceChildren();
	const project = state.project;
	if (!project || project.outline.length === 0) {
		$("chapter-empty").classList.remove("hidden");
		return;
	}
	$("chapter-empty").classList.add("hidden");

	project.outline.forEach((chapter, index) => {
		const draft = project.drafts[chapter.id];
		const words = draft ? countWords(draft.content) : 0;
		const item = el("li", "chapter-item" + (chapter.id === state.chapterId ? " is-on" : ""));
		item.append(el("span", "ord", toCn(index + 1)));
		item.append(el("span", "ct", chapter.title));
		item.append(el("span", "cw", words ? fmt(words) : "—"));
		if (!words) item.append(el("span", "dotmark"));
		item.title = chapter.summary || "";
		item.addEventListener("click", () => openChapter(chapter.id));
		list.append(item);
	});
}

// ═══════════════════════════════════════════════════ 稿台

function renderStage() {
	if (!state.project) return;

	if (!state.chapterId) renderFrontMatter();
	else renderChapter();

	$("project-stats").textContent = state.stats
		? state.stats.chapters + " 章 · " + fmt(state.stats.words) + " 字 · " +
		  state.stats.characters + " 人 · " + state.stats.openNotes + " 待办"
		: "";
}

function renderFrontMatter() {
	const box = $("view-manuscript");
	const project = state.project;
	box.replaceChildren();

	$("stage-actions").replaceChildren();
	const jump = el("button", "btn btn-quiet btn-sm", "拟新章");
	jump.addEventListener("click", () => {
		switchView("chat");
		$("input").value = "接着现有的情节往后拟一章，先用 update_outline 立下章目再落笔。";
		$("input").focus();
	});
	$("stage-actions").append(jump);

	const page = el("div", "front-matter");
	const head = el("div", "front-head");
	head.append(el("h2", "", project.title));
	head.append(el("p", "", [project.genre, project.logline].filter(Boolean).join(" · ") || "尚未题写一句话骨相"));
	page.append(head);

	if (project.outline.length === 0) {
		page.append(el("div", "empty-hint", "章目尚虚。切到「议」，让墨客先把骨节列出来。"));
	} else {
		const toc = el("ol", "toc");
		project.outline.forEach((chapter, index) => {
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const item = el("li", "toc-item");
			item.append(el("h3", "", chapter.title));
			item.append(el("p", "", chapter.summary || "（未写要略）"));
			const bits = ["第 " + toCn(index + 1) + " 章", chapter.status, chapter.pov];
			if (chapter.targetWords) bits.push("目标 " + fmt(chapter.targetWords) + " 字");
			if (words) bits.push("已成 " + fmt(words) + " 字");
			item.append(el("div", "toc-meta", bits.filter(Boolean).join(" · ")));
			item.addEventListener("click", () => openChapter(chapter.id));
			toc.append(item);
		});
		page.append(toc);
	}

	box.append(page);
}

function renderChapter() {
	const box = $("view-manuscript");
	const project = state.project;
	const index = project.outline.findIndex((chapter) => chapter.id === state.chapterId);
	const chapter = project.outline[index];
	const draft = project.drafts[state.chapterId];
	const content = draft ? draft.content : "";
	const words = countWords(content);

	box.replaceChildren();
	$("stage-actions").replaceChildren();

	const prev = project.outline[index - 1];
	const next = project.outline[index + 1];
	if (prev) $("stage-actions").append(navButton(prev.id, "前章"));
	$("stage-actions").append(el("span", "muted", toCn(index + 1) + " / " + toCn(project.outline.length)));
	if (next) $("stage-actions").append(navButton(next.id, "后章"));

	const page = el("div", "ms-page");
	const head = el("div", "ms-head");
	head.append(el("p", "ms-kicker", "第 " + toCn(index + 1) + " 章" + (chapter.pov ? " · " + chapter.pov : "")));
	head.append(el("h1", "ms-title", chapter.title));
	head.append(el("div", "ms-rule"));
	const meta = [];
	if (words) meta.push(fmt(words) + " 字");
	if (draft) meta.push("第 " + draft.revision + " 稿");
	if (chapter.targetWords) meta.push("目标 " + fmt(chapter.targetWords) + " 字");
	head.append(el("p", "ms-meta", meta.join(" · ") || "尚无正文"));
	page.append(head);

	if (state.editing) {
		const editor = document.createElement("textarea");
		editor.className = "ms-edit";
		editor.value = content;
		editor.placeholder = "此处落笔。空行分段。";
		page.append(editor);
	} else if (content) {
		const text = el("article", "ms-text");
		for (const para of content.split(/\n+/)) {
			const trimmed = para.trim();
			if (trimmed) text.append(el("p", "", trimmed));
		}
		page.append(text);
	} else {
		page.append(el("div", "ms-blank", "此章尚无正文。切到「议」，令墨客落笔。"));
	}

	box.append(page);
	box.append(chapterToolbar(content));
}

function navButton(id, label) {
	const button = el("button", "btn btn-quiet btn-sm", label);
	button.addEventListener("click", () => openChapter(id));
	return button;
}

function chapterToolbar(content) {
	const bar = el("div", "actions");
	bar.style.justifyContent = "center";
	bar.style.padding = "18px 0 0";

	if (state.editing) {
		const save = el("button", "btn btn-ink btn-sm", "存稿");
		save.addEventListener("click", async () => {
			const editor = $("view-manuscript").querySelector(".ms-edit");
			if (!editor) return;
			save.disabled = true;
			try {
				await saveChapter(state.chapterId, editor.value);
				state.editing = false;
			} catch (error) {
				alert("存稿失败：" + error.message);
			} finally {
				save.disabled = false;
			}
		});
		const cancel = el("button", "btn btn-quiet btn-sm", "作罢");
		cancel.addEventListener("click", () => {
			state.editing = false;
			renderChapter();
		});
		bar.append(save, cancel);
	} else {
		const edit = el("button", "btn btn-sm", content ? "改稿" : "起稿");
		edit.addEventListener("click", () => {
			state.editing = true;
			renderChapter();
		});
		bar.append(edit);
	}

	const ask = el("button", "btn btn-quiet btn-sm", "唤墨客评此章");
	ask.addEventListener("click", () => {
		const chapter = state.project.outline.find((item) => item.id === state.chapterId);
		const index = state.project.outline.findIndex((item) => item.id === state.chapterId);
		switchView("chat");
		$("input").value = "读一下第" + toCn(index + 1) + "章《" + (chapter ? chapter.title : "") + "》，说说问题在哪。";
		$("input").focus();
	});
	bar.append(ask);
	return bar;
}

async function saveChapter(chapterId, content) {
	return api("/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(chapterId), {
		method: "PATCH",
		body: { content },
	});
}

function openChapter(chapterId) {
	state.chapterId = chapterId;
	state.editing = false;
	switchView("manuscript");
	renderChapters();
	renderStage();
	$("view-manuscript").scrollTop = 0;
}

// ═══════════════════════════════════════════════════ 右案

function renderBible() {
	const box = $("bible");
	box.replaceChildren();
	const project = state.project;
	if (!project) return;

	if (state.bibleTab === "characters") {
		if (project.characters.length === 0) {
			box.append(el("div", "bible-empty", "尚无人物\n唤墨客写几个出来"));
			return;
		}
		for (const person of project.characters) box.append(personCard(person));
		return;
	}

	if (state.bibleTab === "world") {
		if (project.worldFacts.length === 0) {
			box.append(el("div", "bible-empty", "尚无世观设定"));
			return;
		}
		const byCategory = new Map();
		for (const fact of project.worldFacts) {
			if (!byCategory.has(fact.category)) byCategory.set(fact.category, []);
			byCategory.get(fact.category).push(fact);
		}
		for (const [category, facts] of byCategory) {
			const card = el("div", "card");
			card.append(el("h4", "", category));
			const dl = el("dl");
			for (const fact of facts) {
				dl.append(el("dt", "", fact.title));
				dl.append(el("dd", "", fact.content));
			}
			card.append(dl);
			box.append(card);
		}
		return;
	}

	if (state.bibleTab === "outline") {
		if (project.outline.length === 0) {
			box.append(el("div", "bible-empty", "章目尚虚"));
			return;
		}
		project.outline.forEach((chapter, index) => {
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const card = el("div", "card");
			card.append(el("h4", "", toCn(index + 1) + " · " + chapter.title));
			card.append(el("div", "tagline", chapter.summary || "（未写要略）"));
			const meta = [chapter.status, chapter.pov];
			if (words) meta.push(fmt(words) + " 字");
			card.append(el("div", "tagline", meta.filter(Boolean).join(" · ")));
			card.style.cursor = "pointer";
			card.addEventListener("click", () => openChapter(chapter.id));
			box.append(card);
		});
		return;
	}

	const open = project.notes.filter((note) => note.status === "open");
	if (open.length === 0) {
		box.append(el("div", "bible-empty", "无待办事项"));
		return;
	}
	for (const note of open) {
		const row = el("div", "note " + note.severity);
		row.append(el("span", "note-mark"));
		const body = el("div", "note-body");
		body.append(el("div", "note-where", note.category + " · " + note.subject));
		body.append(el("div", "note-text", note.description));
		row.append(body);
		box.append(row);
	}
}

function personCard(person) {
	const card = el("div", "card");
	const title = el("h4", "", person.name);
	if (person.role) title.append(el("span", "role", person.role));
	card.append(title);

	const dl = el("dl");
	const add = (label, value) => {
		if (!value) return;
		dl.append(el("dt", "", label));
		dl.append(el("dd", "", value));
	};
	add("别名", person.aliases.join("、"));
	add("外貌", person.appearance);
	add("性情", person.personality);
	add("身世", person.background);
	add("关系", person.relations.join("、"));
	add("弧光", person.arc);
	add("附注", person.notes);
	card.append(dl);
	return card;
}

// ═══════════════════════════════════════════════════ 视图切换

function switchView(view) {
	state.view = view;
	for (const tab of document.querySelectorAll(".tab")) {
		tab.classList.toggle("is-on", tab.dataset.view === view);
	}
	$("view-manuscript").classList.toggle("is-on", view === "manuscript");
	$("view-chat").classList.toggle("is-on", view === "chat");
	if (view === "chat") $("input").focus();
}

for (const tab of document.querySelectorAll(".tab")) {
	tab.addEventListener("click", () => switchView(tab.dataset.view));
}

for (const tab of document.querySelectorAll(".bible-tab")) {
	tab.addEventListener("click", () => {
		state.bibleTab = tab.dataset.tab;
		for (const item of document.querySelectorAll(".bible-tab")) {
			item.classList.toggle("is-on", item === tab);
		}
		renderBible();
	});
}

// ═══════════════════════════════════════════════════ 工程

async function selectProject(id) {
	state.projectId = id;
	state.sessionId = null;
	state.chapterId = null;
	state.editing = false;
	await reloadProject();

	$("messages").replaceChildren();
	appendMessage("assistant", "《" + state.project.title + "》已展上案头。");
	renderProjects();
	renderChapters();
	renderStage();
	renderBible();
	switchView("manuscript");
}

async function reloadProject() {
	const data = await api("/api/projects/" + state.projectId);
	state.project = data.project;
	state.stats = data.stats;
	if (state.chapterId && !state.project.outline.some((chapter) => chapter.id === state.chapterId)) {
		state.chapterId = null;
	}
	renderProjects();
	renderChapters();
	if (!state.editing) renderStage();
	renderBible();
}

$("new-project").addEventListener("click", () => $("project-dialog").showModal());

$("project-form").addEventListener("submit", async (event) => {
	if (event.submitter && event.submitter.value !== "create") return;
	const body = Object.fromEntries(new FormData(event.target).entries());
	if (!body.targetWords) delete body.targetWords;
	try {
		const result = await api("/api/projects", { method: "POST", body });
		state.projects = [result.project, ...state.projects];
		await selectProject(result.project.id);
		event.target.reset();
	} catch (error) {
		appendMessage("error", error.message);
	}
});

// ═══════════════════════════════════════════════════ 对议

function appendMessage(role, text) {
	const wrap = el("div", "msg " + role);
	wrap.append(el("div", "msg-role", role === "user" ? "书者" : role === "error" ? "讹误" : "墨客"));
	const body = el("div", "msg-body", text);
	wrap.append(body);
	$("messages").append(wrap);
	scrollToBottom();
	return { wrap, body };
}

function appendTool(name, preview, failed) {
	const wrap = el("div", "tool" + (failed ? " is-failed" : ""));
	wrap.append(el("span", "tool-mark", failed ? "✕" : "◦"));
	const main = el("div");
	main.append(el("div", "tool-name", name));
	if (preview) main.append(el("div", "tool-preview", preview));
	wrap.append(main);
	$("messages").append(wrap);
	scrollToBottom();
	return wrap;
}

function scrollToBottom() {
	const box = $("messages");
	box.scrollTop = box.scrollHeight;
}

function setStreaming(on) {
	state.streaming = on;
	$("send").disabled = on;
	$("send").textContent = on ? "落笔中" : "呈上";
	$("abort").classList.toggle("hidden", !on);
	$("model-select").disabled = on;
	$("thinking-select").disabled = on;
}

async function ensureSession() {
	if (state.sessionId) return state.sessionId;
	const modelRef = $("model-select").value;
	if (!modelRef) throw new Error("请先到设置中备好笔墨");
	const data = await api("/api/sessions", {
		method: "POST",
		body: { projectId: state.projectId, modelRef, thinkingLevel: $("thinking-select").value },
	});
	state.sessionId = data.sessionId;
	return state.sessionId;
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const input = $("input");
	const text = input.value.trim();
	if (!text || state.streaming || !state.projectId) return;

	appendMessage("user", text);
	input.value = "";
	setStreaming(true);
	try {
		const sessionId = await ensureSession();
		await streamRun(sessionId, text);
	} catch (error) {
		appendMessage("error", error.message);
	} finally {
		setStreaming(false);
		await reloadProject();
	}
});

$("abort").addEventListener("click", () => {
	if (state.sessionId) fetch("/api/sessions/" + state.sessionId + "/abort", { method: "POST" }).catch(() => {});
});

async function streamRun(sessionId, text) {
	const res = await fetch("/api/sessions/" + sessionId + "/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: text }),
	});
	if (!res.ok || !res.body) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.error || "请求失败 (" + res.status + ")");
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let message = null;
	let thinkingBox = null;
	let usage = null;

	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			const event = JSON.parse(line);
			switch (event.type) {
				case "text":
					if (!message) {
						message = appendMessage("assistant", "");
						message.body.classList.add("cursor");
					}
					thinkingBox = null;
					message.body.textContent += event.delta;
					scrollToBottom();
					break;
				case "thinking_start":
					if (!message) message = appendMessage("assistant", "");
					thinkingBox = el("div", "thinking");
					message.wrap.insertBefore(thinkingBox, message.body);
					break;
				case "thinking":
					if (thinkingBox) thinkingBox.textContent += event.delta;
					break;
				case "tool_start": {
					const wrap = appendTool(event.name, "行笔中…", false);
					wrap.dataset.pending = "1";
					break;
				}
				case "tool_end": {
					const pending = [...$("messages").querySelectorAll(".tool")].pop();
					if (pending && pending.dataset.pending === "1") {
						delete pending.dataset.pending;
						pending.className = event.isError ? "tool is-failed" : "tool";
						pending.replaceChildren();
						pending.append(el("span", "tool-mark", event.isError ? "✕" : "✓"));
						const main = el("div");
						main.append(el("div", "tool-name", event.name));
						if (event.preview) main.append(el("div", "tool-preview", event.preview));
						pending.append(main);
					} else {
						appendTool(event.name, event.preview, event.isError);
					}
					scrollToBottom();
					break;
				}
				case "run_end":
					usage = event.usage;
					if (message) message.body.classList.remove("cursor");
					if (event.error) appendMessage("error", event.error);
					break;
				case "error":
					appendMessage("error", event.message);
					break;
			}
		}
	}

	if (message) message.body.classList.remove("cursor");
	if (usage) {
		$("messages").append(
			el("div", "msg-foot", "入 " + usage.input + " · 出 " + usage.output + " · " + usage.turns + " 轮"),
		);
		scrollToBottom();
	}
}

$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});

window.addEventListener("settings-changed", async () => {
	const data = await api("/api/bootstrap").catch(() => null);
	if (!data) return;
	const previous = $("model-select").value;
	renderModels(data.models, data.defaultModel);
	if (data.models.some((model) => model.id === previous)) $("model-select").value = previous;
});

$("model-select").addEventListener("change", () => {
	if (!state.sessionId) return;
	fetch("/api/sessions/" + state.sessionId + "/model", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ modelRef: $("model-select").value, thinkingLevel: $("thinking-select").value }),
	}).catch(() => {});
});

bindSettings();
bootstrap().catch((error) => {
	$("messages").replaceChildren(el("div", "msg error", "起手不成：" + error.message));
	switchView("chat");
});
