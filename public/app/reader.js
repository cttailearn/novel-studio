/**
 * 读稿台：把这一章从纸里抽出来，铺满整屏。
 *
 * 三个场面都用它：
 *  - 手机上读一稿到底（字号、行距、上一章下一章都在手边）；
 *  - 在路上改一句话（改完自动落盘，和稿纸是同一份稿）；
 *  - 改编稿逐句比对原书（改过的句子垫底色，原文收在下面）。
 *
 * 这里的正文和稿纸共用 ctx.state.draft —— 谁改都算改同一张纸。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, $$, el, icon, toast, renderMarkdown, wordLabel, countWords } from "./core.js";
import { diffSegments, paragraphBlocks, markedNodes } from "./compare.js";
import { mountDock, unmountDock } from "./dock.js";

const SCALE_KEY = "mogeng.reader-scale";
const CHANGE_LABELS = {
	character: "人物",
	persona: "人设",
	plot: "情节",
	pov: "视角",
	addition: "增补",
	style: "语感",
	title: "章名",
	other: "其他",
};

let mounted = false;
let root = null;
let scroller = null;
let page = null;
let input = null;
let titleEl = null;
let eyebrowEl = null;
let metaEl = null;
let saveEl = null;
let progressEl = null;
let prevBtn = null;
let nextBtn = null;
let modeBtn = null;
let compareBtn = null;
let closeBtn = null;

let agentEl = null;
let agentToggle = null;
let chatPane = null;
let adaptPane = null;
let agentOpen = false;
let agentTab = "chat";

let adaptBusy = false;
let adaptAbort = null;
let adaptText = "";
let adaptProposal = null;
let adaptNote = "";
let adaptSaveTimer = 0;

let opened = false;
let currentId = "";
let mode = "read";
let comparing = false;
let originalText = "";
let originCache = new Map();
let scale = 1;
let lastDraftContent = "";

export function initReader() {
	if (mounted) return;
	mounted = true;
	root = $("#reader");
	if (!root) return;
	scroller = $("#reader-scroll");
	page = $("#reader-page");
	input = $("#reader-input");
	titleEl = $("#reader-title");
	eyebrowEl = $("#reader-eyebrow");
	metaEl = $("#reader-meta");
	saveEl = $("#reader-save");
	progressEl = $("#reader-progress");
	prevBtn = $("#reader-prev");
	nextBtn = $("#reader-next");
	modeBtn = $("#reader-mode");
	compareBtn = $("#reader-compare");
	closeBtn = $("#reader-close");

	scale = Number(localStorage.getItem(SCALE_KEY)) || 1;
	applyScale();

	closeBtn?.addEventListener("click", () => closeReader());
	prevBtn?.addEventListener("click", () => step(-1));
	nextBtn?.addEventListener("click", () => step(1));
	modeBtn?.addEventListener("click", () => setMode(mode === "edit" ? "read" : "edit"));
	compareBtn?.addEventListener("click", () => toggleCompare());
	$("#reader-font-down")?.addEventListener("click", () => bumpScale(-0.08));
	$("#reader-font-up")?.addEventListener("click", () => bumpScale(0.08));

	agentEl = $("#reader-agent");
	agentToggle = $("#reader-agent-btn");
	chatPane = $("#reader-agent-chat");
	adaptPane = $("#reader-agent-adapt");
	agentToggle?.addEventListener("click", () => toggleAgent());
	$("#reader-agent-close")?.addEventListener("click", () => toggleAgent(false));
	for (const tab of $$(".reader-agent-tab")) {
		tab.addEventListener("click", () => setAgentTab(tab.dataset.agent || "chat"));
	}

	input?.addEventListener("input", () => {
		if (!ctx.state.draft || input.value === ctx.state.draft.content) return;
		lastDraftContent = input.value;
		ctx.markDirty(input.value);
		renderMeta();
		autosize();
	});
	input?.addEventListener("blur", () => {
		if (ctx.state.saving === "dirty") void ctx.saveDraft({ autosave: true });
	});
	scroller?.addEventListener("scroll", () => {
		const max = scroller.scrollHeight - scroller.clientHeight;
		const ratio = max > 0 ? scroller.scrollTop / max : 0;
		if (progressEl) progressEl.style.width = `${Math.round(ratio * 100)}%`;
	});

	ctx.onChange((scope) => {
		if (!opened) return;
		if (scope === "save") renderSave();
		if (scope === "words" || scope === "draft") {
			renderMeta();
			// 稿纸那边改了字（或 AI 写回来了），读稿台跟着换纸。
			syncFromDraft();
		}
		if (scope === "chapters") renderNav();
	});
}

/* ---------------------------------------------------------------- 开关 */

export async function openReader({ chapterId = "", mode: wanted = "read", compare = false } = {}) {
	if (!initMounted()) return;
	if (!ctx.state.project) {
		toast("先翻开一本书。", "warn");
		return;
	}
	const target = resolveChapter(chapterId, wanted);
	if (!target) {
		toast("这本书还没有章。先去大纲里立一章。", "warn");
		return;
	}
	currentId = target;
	if (ctx.state.activeId !== target || !ctx.state.draft) {
		try {
			await ctx.openChapter(target);
		} catch (error) {
			toast(error.message || "这一章打不开。", "error");
			return;
		}
	}
	mode = wanted === "edit" ? "edit" : "read";
	comparing = Boolean(compare) && Boolean(ctx.state.project?.adaptation);
	lastDraftContent = ctx.state.draft?.content || "";
	originalText = "";
	originCache = new Map();

	if (!opened) {
		opened = true;
		root.hidden = false;
		document.body.classList.add("is-reading");
		requestAnimationFrame(() => root.classList.add("is-open"));
	}
	renderAll();
	if (comparing) void loadOriginal();
	if (mode === "edit") focusInput();
	renderAgentTabs();
	if (agentOpen) {
		if (agentTab === "chat") mountDock(chatPane);
		else void renderAdaptPane();
	}
}

export function closeReader() {
	if (!opened) return;
	if (agentOpen) toggleAgent(false);
	const flush = ctx.state.saving === "dirty" || ctx.state.saving === "saving";
	opened = false;
	comparing = false;
	root?.classList.remove("is-open");
	document.body.classList.remove("is-reading");
	if (modeBtn) modeBtn.classList.remove("is-on");
	const hide = () => {
		if (!opened && root) root.hidden = true;
	};
	if (flush) {
		void ctx.flushSave().finally(() => {
			hide();
			ctx.notify("draft");
		});
		window.setTimeout(hide, 200);
	} else {
		hide();
	}
	ctx.notify("draft");
}

export function isReaderOpen() {
	return opened;
}

/** 在稿纸、改编台上按「读稿」都走这里。 */
export function openActiveReader(options = {}) {
	const id = ctx.state.activeId || ctx.state.outline[0]?.id || "";
	return openReader({ chapterId: id, ...options });
}

function initMounted() {
	if (!mounted) initReader();
	return Boolean(root);
}

export function readerMode() {
	return mode;
}

/**
 * 全屏之后按 Esc 先退回纸面；再按才收别的浮层。app.js 的按键表会先问这里。
 */
export function handleReaderKey(event) {
	if (!opened) return false;
	if (event.key === "Escape") {
		if (agentOpen) {
			toggleAgent(false);
			return true;
		}
		closeReader();
		return true;
	}
	if (event.key === "a" || event.key === "A") {
		if (mode === "edit") return false;
		toggleAgent();
		return true;
	}
	if (mode === "edit") return false;
	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		event.preventDefault();
		step(event.key === "ArrowLeft" ? -1 : 1);
		return true;
	}
	if (event.key === "e" || event.key === "E") {
		setMode("edit");
		return true;
	}
	if (event.key === "c" || event.key === "C") {
		toggleCompare();
		return true;
	}
	return false;
}

/* ---------------------------------------------------------------- 渲染 */

function resolveChapter(chapterId, wanted = "read") {
	const outline = ctx.state.outline || [];
	if (!outline.length) return "";
	const withDraft = (id) => Boolean(ctx.chapterMeta(id)?.hasDraft);
	if (chapterId) return chapterId;
	const active = ctx.state.activeId;
	// 「读稿」是来读的：手上这一章还空着，就退到最近一章有字的，
	// 免得翻开一屏白纸（想写的话按钮上写着「改稿」）。
	if (active && outline.some((item) => item.id === active)) {
		if (withDraft(active) || wanted === "edit") return active;
		const index = outline.findIndex((item) => item.id === active);
		for (let step = 1; step < outline.length; step += 1) {
			const back = outline[index - step];
			if (back && withDraft(back.id)) return back.id;
			const forward = outline[index + step];
			if (forward && withDraft(forward.id)) return forward.id;
		}
		return active;
	}
	const first = outline.find((item) => withDraft(item.id));
	return first?.id || outline[0].id;
}

function renderAll() {
	renderHeader();
	renderNav();
	renderBody();
	renderMeta();
	renderSave();
	if (progressEl) progressEl.style.width = "0%";
	if (scroller) scroller.scrollTop = 0;
	updateChrome();
}

function chapterIndexNow() {
	return (ctx.state.outline || []).findIndex((item) => item.id === currentId);
}

function renderHeader() {
	const index = chapterIndexNow();
	const total = (ctx.state.outline || []).length;
	const item = ctx.outlineItem(currentId);
	if (eyebrowEl) {
		eyebrowEl.textContent = total
			? `第 ${index >= 0 ? index + 1 : "?"} 章 / 共 ${total} 章`
			: "这一章";
	}
	if (titleEl) {
		const title = ctx.state.draft?.title || item?.title || "无题";
		titleEl.textContent = title;
	}
	if (compareBtn) compareBtn.hidden = !ctx.state.project?.adaptation;
	renderNav();
}

function renderNav() {
	const index = chapterIndexNow();
	const total = (ctx.state.outline || []).length;
	const prev = (ctx.state.outline || [])[index - 1];
	const next = (ctx.state.outline || [])[index + 1];
	if (prevBtn) {
		prevBtn.disabled = !prev;
		prevBtn.title = prev ? `上一章：${prev.title}` : "";
	}
	if (nextBtn) {
		nextBtn.disabled = !next;
		nextBtn.title = next ? `下一章：${next.title}` : "";
	}
	if (nextBtn && index >= 0 && total) {
		const label = nextBtn.querySelector("span");
		if (label) label.textContent = next ? "下一章" : "读完了";
	}
}

function renderBody() {
	const content = ctx.state.draft?.content || "";
	const hasDraft = Boolean(ctx.chapterMeta(currentId)?.hasDraft) || Boolean(content.trim());
	if (mode === "edit") {
		renderEdit(content);
		return;
	}
	if (input) input.hidden = true;
	if (!page) return;
	page.hidden = false;
	if (!hasDraft) {
		page.replaceChildren(emptyNode());
		return;
	}
	if (comparing) {
		page.replaceChildren(...compareNodes(content));
		return;
	}
	page.replaceChildren(...paragraphNodes(content));
}

function renderEdit(content) {
	if (!page || !input) return;
	page.hidden = true;
	input.hidden = false;
	if (input.value !== content) input.value = content;
	lastDraftContent = content;
	autosize();
}

function emptyNode() {
	const item = ctx.outlineItem(currentId);
	return el(
		"div",
		{ class: "reader-empty" },
		icon("feather", "ico ico-lg"),
		el("p", { class: "reader-empty-title", text: "这一章还空着。" }),
		el("p", {
			class: "reader-empty-note",
			text: item?.summary || "落第一句就行，不必等想清楚。",
		}),
		el(
			"div",
			{ class: "reader-empty-actions" },
			el(
				"button",
				{
					class: "btn btn-seal",
					type: "button",
					on: {
						click: () => {
							setMode("edit");
							focusInput();
						},
					},
				},
				icon("quill"),
				el("span", { text: "写下第一句" }),
			),
			el(
				"button",
				{
					class: "btn btn-ghost",
					type: "button",
					on: {
						click: () => {
							closeReader();
							ctx.setView("studio");
						},
					},
				},
				el("span", { text: "回稿纸" }),
			),
		),
	);
}

function paragraphNodes(text) {
	return paragraphBlocks(text, "reader-p");
}

/* ---------------------------------------------------------------- 对照原文 */

async function loadOriginal() {
	const plan = ctx.state.project?.adaptation;
	if (!plan?.sourceId) return;
	const index = chapterIndexNow();
	const key = `${plan.sourceId}:${index}`;
	if (originCache.has(key)) {
		originalText = originCache.get(key);
		renderBody();
		return;
	}
	try {
		const data = await api.getAdaptation(ctx.state.project.id);
		const chapters = data?.source?.chapters || [];
		const sourceChapter = chapters[index];
		if (!sourceChapter) {
			originalText = "";
			renderBody();
			return;
		}
		const one = await api.readSourceChapter(plan.sourceId, sourceChapter.id);
		const found = one?.chapter || {};
		originalText = found.content || found.text || "";
		originCache.set(key, originalText);
		renderBody();
	} catch (error) {
		originalText = "";
		toast(error.message || "原书这一章没取到。", "warn");
		renderBody();
	}
}

function compareNodes(content) {
	const nodes = [];
	if (!originalText) {
		nodes.push(
			el("p", { class: "reader-legend is-wait", text: "正在取原书这一章——取不到就先按改编稿读。" }),
			...paragraphNodes(content),
		);
		return nodes;
	}
	const segments = diffSegments(originalText, content);
	const changed = segments.filter((segment) => segment.changed).length;
	nodes.push(
		el(
			"div",
			{ class: "reader-legend" },
			icon("wand", "ico ico-sm"),
			el("span", {
				text: changed ? `对照原书：${changed} 处不同，垫底色的就是改过的地方。` : "对照原书：这一章还没动过。",
			}),
		),
	);
	for (const node of markedNodes(segments, { paragraphClass: "reader-p", markClass: "reader-mark" })) nodes.push(node);
	nodes.push(
		el(
			"details",
			{ class: "reader-origin" },
			el("summary", {}, el("span", { text: "摊开原书这一章" })),
			...paragraphNodes(originalText),
		),
	);
	return nodes;
}

/* ---------------------------------------------------------------- 页眉页脚状态 */

function renderMeta() {
	const content = ctx.state.draft?.content || input?.value || "";
	const words = countWords(content);
	const meta = ctx.chapterMeta(currentId);
	const bits = [wordLabel(words)];
	if (meta?.revision) bits.push(`第 ${meta.revision} 稿`);
	if (ctx.state.project?.adaptation) bits.push("改编稿");
	if (meta?.materialIds?.length) bits.push(`挂了 ${meta.materialIds.length} 条料`);
	if (metaEl) metaEl.textContent = bits.join(" · ");
	if (input && mode === "read") input.value = content;
}

function renderSave() {
	if (!saveEl) return;
	const saving = ctx.state.saving;
	const map = { dirty: "还没存", saving: "存稿中…", saved: "已存", error: "没存上", idle: "" };
	saveEl.textContent = map[saving] || (mode === "edit" ? "边改边存" : "");
	saveEl.dataset.state = saving;
	saveEl.classList.toggle("is-error", saving === "error");
}

function updateChrome() {
	if (modeBtn) {
		modeBtn.classList.toggle("is-on", mode === "edit");
		modeBtn.title = mode === "edit" ? "放下笔，只读 (e)" : "拿起笔改这一章 (e)";
		const label = modeBtn.querySelector("span");
		if (label) label.textContent = mode === "edit" ? "只读" : "改稿";
	}
	if (compareBtn) {
		compareBtn.classList.toggle("is-on", comparing);
		compareBtn.setAttribute("aria-pressed", comparing ? "true" : "false");
	}
	root?.classList.toggle("is-editing", mode === "edit");
	root?.classList.toggle("is-comparing", comparing);
	renderSave();
}

function setMode(next) {
	if (next === mode) return;
	mode = next;
	updateChrome();
	renderBody();
	if (mode === "edit") {
		focusInput();
		toast("改完随手退出就存下了。", "info", 1600);
	} else {
		void ctx.flushSave();
	}
}

function toggleCompare() {
	if (!ctx.state.project?.adaptation) {
		toast("这本书不是改编工程，没有原书可比。", "info");
		return;
	}
	if (mode === "edit") setMode("read");
	comparing = !comparing;
	updateChrome();
	renderBody();
	if (comparing && !originalText) void loadOriginal();
}

function focusInput() {
	window.setTimeout(() => {
		input?.focus({ preventScroll: true });
		const end = input?.value.length || 0;
		try {
			input?.setSelectionRange(end, end);
		} catch {
			/* 有些浏览器在隐藏时不支持选区 */
		}
	}, 30);
}

function autosize() {
	if (!input) return;
	input.style.height = "auto";
	input.style.height = `${Math.max(input.scrollHeight, 320)}px`;
}

function step(delta) {
	const index = chapterIndexNow();
	const item = (ctx.state.outline || [])[index + delta];
	if (!item) return;
	void openReader({ chapterId: item.id, mode, compare: comparing });
}

function syncFromDraft() {
	if (!ctx.state.draft || ctx.state.draft.id !== currentId) return;
	const content = ctx.state.draft.content || "";
	if (mode === "edit") {
		if (input && input.value !== content && document.activeElement !== input) {
			input.value = content;
			autosize();
		}
		return;
	}
	if (content !== lastDraftContent) {
		lastDraftContent = content;
		renderBody();
	}
}

/* ---------------------------------------------------------------- 字号 */

function bumpScale(delta) {
	scale = Math.max(0.82, Math.min(1.5, Math.round((scale + delta) * 100) / 100));
	applyScale();
	localStorage.setItem(SCALE_KEY, String(scale));
}

function applyScale() {
	if (!root) return;
	root.style.setProperty("--reader-fs", `${(18.5 * scale).toFixed(2)}px`);
	root.style.setProperty("--reader-lh", `${(1.05 + 0.9 * scale).toFixed(2)}`);
}

/* ---------------------------------------------------------------- 副驾 */

function toggleAgent(force) {
	if (!opened) return;
	const next = typeof force === "boolean" ? force : !agentOpen;
	if (next === agentOpen) return;
	// 打开/收起时纸面高度会变，先把读到哪记住，别让正文被顶走。
	const scroll = document.getElementById("reader-scroll");
	const keep = scroll?.scrollTop ?? 0;
	agentOpen = next;
	root?.classList.toggle("agent-open", next);
	if (agentEl) agentEl.hidden = !next;
	agentToggle?.classList.toggle("is-on", next);
	agentToggle?.setAttribute("aria-pressed", next ? "true" : "false");
	if (scroll) {
		const restore = () => {
			scroll.scrollTop = Math.min(keep, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
		else restore();
	}
	if (!next) {
		unmountDock();
		return;
	}
	const adapted = Boolean(ctx.state.project?.adaptation);
	if (!adapted) agentTab = "chat";
	renderAgentTabs();
	if (agentTab === "chat") mountDock(chatPane);
	else void renderAdaptPane();
}

function setAgentTab(tab) {
	agentTab = tab === "adapt" ? "adapt" : "chat";
	renderAgentTabs();
	if (agentTab === "chat") {
		if (chatPane) mountDock(chatPane);
		if (adaptPane) adaptPane.hidden = true;
	} else {
		unmountDock();
		if (chatPane) chatPane.replaceChildren();
		void renderAdaptPane();
	}
}

function renderAgentTabs() {
	if (!agentEl) return;
	const adaptTab = $('.reader-agent-tab[data-agent="adapt"]');
	const adapted = Boolean(ctx.state.project?.adaptation);
	if (adaptTab) {
		adaptTab.hidden = !adapted;
		adaptTab.classList.toggle("is-active", agentTab === "adapt");
		adaptTab.setAttribute("aria-selected", agentTab === "adapt" ? "true" : "false");
	}
	const chatTab = $('.reader-agent-tab[data-agent="chat"]');
	if (chatTab) {
		chatTab.classList.toggle("is-active", agentTab === "chat");
		chatTab.setAttribute("aria-selected", agentTab === "chat" ? "true" : "false");
	}
	if (chatPane) chatPane.hidden = agentTab !== "chat";
	if (adaptPane) adaptPane.hidden = agentTab !== "adapt";
	if (agentToggle && adapted) {
		const label = agentToggle.querySelector("span");
		if (label) label.textContent = "副驾";
	}
}

function cursorChapterId(adaptation) {
	if (!adaptation) return "";
	if (typeof adaptation.cursor === "string") return adaptation.cursor;
	const draft = (ctx.state.outline || []).find((item) => ctx.chapterMeta(item.id)?.hasDraft);
	return draft?.id || ctx.state.outline?.[0]?.id || "";
}

function chapterIsDone(id) {
	return Boolean(ctx.chapterMeta(id)?.hasDraft);
}

async function renderAdaptPane() {
	if (!adaptPane) return;
	const project = ctx.state.project;
	if (!project) return;
	const adaptation = project?.adaptation;
	if (!adaptation) {
		adaptPane.replaceChildren(
			el(
				"div",
				{ class: "reader-agent-empty" },
				el("p", { class: "reader-agent-note", text: "这一本不是改编工程。" }),
				el("p", { class: "reader-agent-note", text: "去原料库挑一本原书，立一部改编工程，就能一章一章往下改。" }),
			),
		);
		return;
	}

	const total = (ctx.state.outline || []).length;
	const edited = (ctx.state.outline || []).filter((item) => chapterIsDone(item.id)).length;
	const cursor = cursorChapterId(adaptation);
	const isCursor = cursor === currentId;
	const done = chapterIsDone(currentId);
	const index = chapterIndexNow();
	const status = !cursor
		? `已改到底 · ${edited}/${total} 章`
		: isCursor
			? `轮到第 ${chapterIndexNow() + 1} 章 · 已改 ${edited}/${total}`
			: `现在轮到第 ${cursorIndex(cursor) + 1} 章 · 已改 ${edited}/${total}`;

	const briefArea = el("textarea", {
		class: "set-area reader-adapt-brief",
		rows: "4",
		spellcheck: "false",
		placeholder: "要改成什么样…",
		on: {
			input: () => {
				adaptNote = briefArea.value;
				window.clearTimeout(adaptSaveTimer);
				adaptSaveTimer = window.setTimeout(() => void saveBrief(adaptation), 900);
			},
		},
	});
	briefArea.value = adaptation.brief || "";

	const streamBox = el("div", { class: "reader-adapt-stream" });
	if (adaptBusy) {
		streamBox.append(el("p", { class: "reader-agent-note", text: "改编者正在读这一章…" }));
	}
	if (adaptText) {
		const body = el("div", { class: "reader-adapt-text" });
		body.innerHTML = renderMarkdown(adaptText);
		streamBox.append(body);
	}

	const proposalId = adaptProposal?.id || "";
	const summary = adaptProposal?.summary || "";
	const changes = adaptProposal?.changes || [];
	const ledger = (adaptation.changes || []).filter((change) => change.chapterId === currentId);
	const ledgerBox =
		!proposalId && ledger.length
			? el(
					"div",
					{ class: "change-list" },
					el("p", { class: "eyebrow", text: "这一章改了什么" }),
					...ledger
						.slice(-6)
						.map((change) =>
							el(
								"div",
								{ class: "change-row" },
								el("span", { class: `change-kind kind-${change.kind || "other"}`, text: CHANGE_LABELS[change.kind] || "其他" }),
								el("span", { class: "change-text", text: change.summary || "" }),
							),
						),
				)
			: null;
	const proposalBox = proposalId
		? el(
				"div",
				{ class: "reader-adapt-proposal" },
				el("p", { class: "eyebrow", text: "改编稿 · 等你定" }),
				summary ? el("p", { class: "reader-adapt-summary", text: summary }) : null,
				changes.length
					? el(
							"div",
							{ class: "change-list" },
							...changes.map((change) =>
								el(
									"div",
									{ class: "change-row" },
									el("span", { class: `change-kind kind-${change.kind || "other"}`, text: CHANGE_LABELS[change.kind] || "其他" }),
									el("span", { class: "change-text", text: change.summary || "" }),
								),
							),
						)
					: null,
				el(
					"div",
					{ class: "reader-adapt-actions" },
					el("button", { class: "btn btn-seal btn-sm", type: "button", on: { click: () => void adoptProposal() } }, icon("check", "ico ico-sm"), el("span", { text: "采用这一版" })),
					el("button", { class: "btn btn-ghost btn-sm", type: "button", on: { click: () => void dropProposal() } }, el("span", { text: "弃掉" })),
				),
			)
		: null;

	const primary = adaptBusy
		? el(
				"button",
				{ class: "btn btn-ghost btn-sm", type: "button", on: { click: () => adaptAbort?.abort() } },
				el("span", { text: "停下" }),
			)
		: el(
				"button",
				{ class: "btn btn-primary btn-sm", type: "button", on: { click: () => void runAdaptInReader(done) } },
				icon("wand", "ico ico-sm"),
				el("span", { text: done ? "让改编者再改一遍" : "让改编者改这一章" }),
			);

	adaptPane.replaceChildren(
		el(
			"div",
			{ class: "reader-adapt" },
			el("p", { class: "reader-adapt-status", text: status }),
			el("div", { class: "reader-adapt-brief-wrap" }, el("p", { class: "reader-agent-note", text: "改编方向（这一本共用）" }), briefArea),
			el("div", { class: "reader-adapt-run" }, primary),
			ledgerBox,
			streamBox,
			proposalBox,
			el("p", { class: "reader-agent-note reader-adapt-tip", text: `这一章是第 ${index + 1} 章。采用之后，这一章就归到改编稿里，可以接着往下走。` }),
		),
	);
}

function cursorIndex(cursor) {
	const list = ctx.state.outline || [];
	const at = list.findIndex((item) => item.id === cursor);
	return at >= 0 ? at : 0;
}

async function saveBrief(adaptation) {
	const project = ctx.state.project;
	if (!project) return;
	try {
		await api.patchAdaptation(project.id, { brief: adaptNote });
		if (project.adaptation) project.adaptation.brief = adaptNote;
		void adaptation;
	} catch (error) {
		toast(error.message || "方向没存上。", "error");
	}
}

async function runAdaptInReader(rework = false) {
	if (adaptBusy) return;
	const project = ctx.state.project;
	if (!project?.adaptation) return;
	const pid = project.id;
	const cursor = cursorChapterId(project.adaptation);
	if (cursor && cursor !== currentId && !chapterIsDone(currentId) && !rework) {
		toast(`改编是一章一章往下走的：现在轮到第 ${cursorIndex(cursor) + 1} 章。`, "warn");
		return;
	}
	adaptBusy = true;
	adaptText = "";
	adaptProposal = null;
	adaptAbort = new AbortController();
	void renderAdaptPane();
	try {
		await api.adaptChapter(
			pid,
			currentId,
			{ modelRef: undefined, note: "" },
			{
				signal: adaptAbort.signal,
				onEvent: (event) => {
					if (event.type === "text") {
						adaptText += event.delta || "";
						const box = adaptPane?.querySelector(".reader-adapt-stream");
						if (box) {
							let body = box.querySelector(".reader-adapt-text");
							if (!body) {
								body = el("div", { class: "reader-adapt-text" });
								box.append(body);
							}
							body.innerHTML = renderMarkdown(adaptText);
							root && (scroller.scrollTop = scroller.scrollTop);
						}
					}
					if (event.type === "proposal") {
						void loadReaderProposal();
					}
					if (event.type === "error") toast(event.message || "改编没跑完。", "error");
				},
			},
		);
	} catch (error) {
		if (error?.name !== "AbortError") toast(error.message || "改编没跑完。", "error");
	} finally {
		adaptBusy = false;
		adaptAbort = null;
		await loadReaderProposal();
		void renderAdaptPane();
	}
}

async function loadReaderProposal() {
	const project = ctx.state.project;
	if (!project) return;
	try {
		const data = await api.getProposal(project.id, currentId);
		adaptProposal = data.proposal || null;
	} catch {
		adaptProposal = null;
	}
}

async function adoptProposal() {
	const project = ctx.state.project;
	if (!project || !adaptProposal) return;
	try {
		await api.applyProposal(project.id, currentId, {
			proposalId: adaptProposal.id,
			content: adaptProposal.content,
			summary: adaptProposal.summary,
			changes: adaptProposal.changes,
		});
		adaptProposal = null;
		adaptText = "";
		toast("采用这一版，已经归到改编稿里。", "ok");
		await ctx.reloadProjectStructure().catch(() => {});
		await ctx.loadDraft(currentId, { silent: true }).catch(() => {});
		lastDraftContent = ctx.state.draft?.content || "";
		renderAll();
		void renderAdaptPane();
	} catch (error) {
		toast(error.message || "采用不了这一版。", "error");
	}
}

async function dropProposal() {
	const project = ctx.state.project;
	if (!project) return;
	try {
		await api.http.del(`/api/projects/${project.id}/chapters/${currentId}/adapt`);
		adaptProposal = null;
		adaptText = "";
		void renderAdaptPane();
		toast("提案撤掉了，正文没动。", "info");
	} catch (error) {
		toast(error.message || "撤不掉这一版。", "error");
	}
}
