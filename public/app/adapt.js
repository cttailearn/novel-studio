/**
 * 改编台：把一本别人的书，改成自己的一本。
 *
 * 左边是这一部要改的章，右边一次只摊开一张：方向、这一章的台账、改编者刚交来的稿。
 * 稿不落盘，除非你按下「采用这一版」——改错了，弃掉就是。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, confirmAction, excerpt, renderMarkdown, wordLabel, countWords, num } from "./core.js";

let mounted = false;
let adaptation = null;
let adaptationFor = "";
let source = null;
let selected = "";
let proposal = null;
let proposalFor = "";
let streaming = false;
let abortCtl = null;
let draftText = "";
let chapterDraft = "";
let chapterDraftFor = "";
let signature = "";

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

export function initAdapt() {
	if (mounted) return;
	mounted = true;
	ctx.onChange((scope) => {
		if (scope === "project" || scope === "view" || scope === "chapters" || scope === "outline") {
			if (ctx.state.view === "adapt") void render();
		}
	});
	if (ctx.state.view === "adapt") void render();
}

async function ensureData(force = false) {
	const project = ctx.state.project;
	if (!project?.adaptation) return;
	if (adaptation && adaptationFor === project.id && !force) return;
	try {
		const data = await api.getAdaptation(project.id);
		adaptation = data.adaptation || project.adaptation;
		adaptationFor = project.id;
		source = data.source || null;
		if (force) proposal = null;
	} catch (error) {
		toast(error.message || "改编方案读不到。", "error");
	}
}

/** 现在是轮到哪一章（空串 = 已经改到底）。后端会用同一套算法兜底。 */
function cursorChapterId() {
	const chapters = ctx.state.project?.outline || [];
	const pinned = adaptation?.cursor;
	if (typeof pinned === "string") {
		if (!pinned) return "";
		if (chapters.some((item) => item.id === pinned)) return pinned;
	}
	const next = chapters.find((item) => !ctx.chapterMeta(item.id)?.hasDraft);
	return next?.id || "";
}

function cursorIndex() {
	const id = cursorChapterId();
	if (!id) return (ctx.state.project?.outline || []).length;
	return (ctx.state.project?.outline || []).findIndex((item) => item.id === id);
}

function isReopened(chapterId) {
	return Boolean(ctx.chapterMeta(chapterId)?.hasDraft);
}

async function render({ force = false } = {}) {
	const host = $("#adapt-root");
	if (!host || ctx.state.view !== "adapt") return;
	const project = ctx.state.project;
	if (!project) {
		signature = "";
		host.replaceChildren(emptyState("先打开一部书。"));
		return;
	}
	if (!project.adaptation) {
		signature = "";
		host.replaceChildren(notAdaptState());
		return;
	}
	await ensureData(force);
	const chapters = project.outline || [];
	if (!selected || !chapters.some((item) => item.id === selected)) {
		const cursor = cursorChapterId();
		selected =
			(ctx.state.activeId && chapters.some((item) => item.id === ctx.state.activeId) ? ctx.state.activeId : "") ||
			cursor ||
			chapters[0]?.id ||
			"";
	}
	const next = [
		project.id,
		selected,
		chapters.length,
		project.updatedAt,
		streaming,
		draftText.length,
		chapterDraft.length,
		adaptation?.cursor ?? "",
	].join("|");
	if (!force && next === signature && host.childElementCount) return;
	signature = next;
	host.replaceChildren(barNode(), bodyNode());
	if (selected) await loadProposal(selected);
	else renderPaper();
}

function emptyState(text) {
	return el("div", { class: "adapt-empty" }, icon("split"), el("p", { text }));
}

function notAdaptState() {
	const wrap = el("div", { class: "adapt-empty" });
	wrap.append(icon("book-open"));
	wrap.append(el("p", { text: "这一部是按自己的设定写的，没有原书可改。" }));
	wrap.append(
		el(
			"p",
			{ class: "set-note" },
			"想改编的话：去案头，把原书导进原料库，再「改编一本原书」立一部新的。这一本的正文和素材都不会动。",
		),
	);
	return wrap;
}

function barNode() {
	const project = ctx.state.project;
	const bar = el("header", { class: "adapt-bar" });
	const sourceLabel = source?.title || adaptation?.sourceTitle || "原书";
	const chapters = project.outline || [];
	const cursor = cursorChapterId();
	const cursorAt = cursor ? chapters.findIndex((item) => item.id === cursor) + 1 : chapters.length;
	const done = chapters.filter((item) => ctx.chapterMeta(item.id)?.hasDraft).length;
	const title = el(
		"div",
		{ class: "adapt-bar-title" },
		el("h2", { text: project.title }),
		el("span", { class: "tag tag-jade", text: "改编" }),
		el("span", { class: "adapt-source", text: `原书：${sourceLabel}` }),
		el("span", {
			class: `adapt-cursor${cursor ? "" : " is-done"}`,
			text: cursor ? `轮到第 ${cursorAt} 章 · 已改 ${done}/${chapters.length}` : `已改到底（${done}/${chapters.length}）· 可以回头再改`,
		}),
	);
	const actions = el("div", { class: "adapt-bar-actions" });
	actions.append(
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				on: {
					click: () => void openSourceReader(),
				},
			},
			icon("book-open"),
			el("span", { class: "btn-label", text: "翻原书" }),
		),
	);
	actions.append(
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				title: "整屏读这一章；改编稿可对照原文 (v)",
				on: {
					click: () => void readSelected(),
				},
			},
			icon("eye"),
			el("span", { class: "btn-label", text: "读全篇" }),
		),
	);
	actions.append(
		el(
			"button",
			{
				class: "btn btn-ghost btn-sm is-primary",
				type: "button",
				on: {
					click: () => void runSelected(),
				},
			},
			icon("quill"),
			el("span", { class: "btn-label", text: "让改编者改这一章" }),
		),
	);
	bar.append(title, actions);
	return bar;
}

/** 读稿台：改编稿 + 原书对照。读完可以直接在里面改，改的是同一份正文。 */
async function readSelected({ edit = false } = {}) {
	if (!selected) return;
	await ctx.flushSave().catch(() => {});
	const mod = await import("./reader.js");
	void mod.openReader({ chapterId: selected, mode: edit ? "edit" : "read", compare: true });
}


function bodyNode() {
	const project = ctx.state.project;
	const chapters = project.outline || [];
	const rail = el("section", { class: "adapt-col" });
	rail.append(
		el(
			"div",
			{ class: "adapt-col-head" },
			el("span", { text: `章目 · ${chapters.length} 章` }),
			el("span", {
				class: "adapt-rail-note",
				text: cursorChapterId()
					? `轮到第 ${cursorIndex() + 1} 章 · 已改 ${chapters.filter((item) => ctx.chapterMeta(item.id)?.hasDraft).length}/${chapters.length}`
					: `已改到底（${chapters.filter((item) => ctx.chapterMeta(item.id)?.hasDraft).length}/${chapters.length}）`,
			}),
			el("span", { class: "adapt-count", text: `${chapters.filter((item) => item.status === "drafted").length} 章改完` }),
		),
	);
	const list = el("div", { class: "adapt-scroll" });
	const cursorAt = cursorIndex();
	for (const [index, chapter] of chapters.entries()) {
		const marks = (adaptation?.changes || []).filter((change) => change.chapterId === chapter.id).length;
		const done = isReopened(chapter.id);
		const current = chapter.id === cursorChapterId();
		const later = cursorAt < chapters.length && index > cursorAt && !done;
		const stateLabel = done ? "已改" : current ? "轮到" : later ? "待改" : "可改";
		const row = el(
			"button",
			{
				class: `adapt-ch${chapter.id === selected ? " is-active" : ""}${done ? " is-done" : ""}${current ? " is-current" : ""}${later ? " is-later" : ""}`,
				type: "button",
				title: `${chapter.title || `第 ${index + 1} 章`} · ${stateLabel}`,
				on: {
					click: () => {
						selected = chapter.id;
						proposal = null;
						draftText = "";
						void render();
					},
				},
			},
			el("span", { class: "adapt-ch-ord", text: String(index + 1).padStart(2, "0") }),
			el(
				"span",
				{ class: "adapt-ch-main" },
				el(
					"span",
					{ class: "adapt-ch-title" },
					el("span", { text: chapter.title || `第 ${index + 1} 章` }),
					el("span", { class: `adapt-ch-state is-${done ? "done" : current ? "current" : "later"}`, text: stateLabel }),
				),
				el("span", { class: "adapt-ch-sub", text: excerpt(chapter.summary || "还没纲", 40) }),
			),
			marks ? el("span", { class: "adapt-ch-marks", text: `${marks} 改` }) : null,
		);
		list.append(row);
	}
	if (!chapters.length) list.append(el("p", { class: "set-note", text: "还没有章。先去写作台或大纲里把章列出来。" }));
	rail.append(list);

	const paperCol = el("section", { class: "adapt-col" });
	paperCol.append(el("div", { class: "adapt-col-head" }, el("span", { id: "adapt-paper-head", text: paperHeadLabel() }), el("span", { class: "adapt-count", id: "adapt-paper-state", text: streaming ? "改编者在写…" : proposal ? "交了一版，等你定" : "" })));
	const scroll = el("div", { class: "adapt-scroll", id: "adapt-paper-scroll" });
	scroll.append(briefNode(), changesNode(), paperNode());
	paperCol.append(scroll);
	return el("div", { class: "adapt-body" }, rail, paperCol);
}

function paperHeadLabel() {
	const chapter = ctx.outlineItem(selected);
	return chapter ? `这一章 · ${chapter.title || ""}` : "这一章";
}

function briefNode() {
	const brief = el("textarea", { class: "adapt-brief", rows: 3, placeholder: "这一部改成什么样：什么留下、什么拆掉、换成谁的眼睛看。" });
	brief.value = adaptation?.brief || "";
	brief.addEventListener("blur", async () => {
		const next = brief.value.trim();
		if (next === (adaptation?.brief || "")) return;
		try {
			const data = await api.patchAdaptation(ctx.state.project.id, { brief: next });
			adaptation = data.adaptation || { ...adaptation, brief: next };
			toast("方向记下了。");
		} catch (error) {
			toast(error.message || "方向没存上。", "error");
		}
	});
	return el(
		"div",
		{ class: "adapt-brief-wrap" },
		el("p", { class: "eyebrow", text: "改编方向" }),
		brief,
	);
}

function changesNode() {
	const list = el("div", { class: "changes-list" });
	const changes = (adaptation?.changes || []).filter((change) => change.chapterId === selected);
	if (!changes.length) {
		list.append(el("p", { class: "set-note", text: "这一章还没有台账。改编者交稿时会写清改了什么。" }));
		return list;
	}
	for (const change of changes) {
		list.append(
			el(
				"div",
				{ class: "change-row" },
				el("span", { class: `change-kind kind-${change.kind}`, text: CHANGE_LABELS[change.kind] || "其他" }),
				el(
					"div",
					{ class: "change-text" },
					el("b", { text: change.summary }),
					change.detail ? el("span", { class: "change-detail", text: change.detail }) : null,
				),
			),
		);
	}
	return list;
}

function paperNode() {
	const wrap = el("div", { class: "adapt-paper-wrap", id: "adapt-paper" });
	if (streaming) {
		wrap.append(el("div", { class: "adapt-stream", id: "adapt-stream" }));
		return wrap;
	}
	const chapters = ctx.state.project?.outline || [];
	const index = chapters.findIndex((item) => item.id === selected);
	const done = isReopened(selected);
	const current = selected === cursorChapterId();
	const cursorAt = cursorIndex();
	const later = cursorAt < chapters.length && index > cursorAt;

	if (!proposal && !done) {
		const empty = el("div", { class: "adapt-empty" });
		empty.append(icon("book-open"));
		empty.append(
			el("p", {
				text: current
					? "轮到这一章了，还没交稿。"
					: later
						? `还没轮到这一章：先改完第 ${cursorAt + 1} 章。`
						: "这一章还没交稿。",
			}),
		);
		empty.append(
			el("p", {
				class: "set-note",
				text: later
					? "改编是一章一章往下走的：后面的章要接住前面的改动，跳着改会把设定搅乱。"
					: "让改编者读原书这一章与前面的台账，交一版给你过目；也可以自己先把这一章写出来。",
			}),
		);
		const buttons = el("div", { class: "adapt-actions" });
		if (!later) {
			buttons.append(
				el(
					"button",
					{ class: "btn btn-seal", type: "button", on: { click: () => void runSelected() } },
					icon("quill"),
					"让改编者改这一章",
				),
			);
		} else {
			buttons.append(
				el(
					"button",
					{
						class: "btn btn-primary",
						type: "button",
						on: { click: () => void jumpToCursor() },
					},
					icon("arrow-right"),
					`先改第 ${cursorAt + 1} 章`,
				),
			);
		}
		buttons.append(
			el(
				"button",
				{ class: "btn btn-ghost", type: "button", on: { click: () => void readSelected({ edit: true }) } },
				icon("edit"),
				"自己写这一章",
			),
		);
		wrap.append(empty, buttons);
		return wrap;
	}

	const mode = proposal ? "proposal" : "author";
	const value = draftText || (proposal ? proposal.content : chapterDraft);
	const revisionLabel = proposal
		? `基线第 ${proposal.baseRevision} 稿`
		: `第 ${ctx.chapterMeta(selected)?.revision || 1} 稿`;
	const head = el(
		"div",
		{ class: "adapt-paper-head" },
		el("span", { class: "eyebrow", text: mode === "proposal" ? "改编稿 · 等你定" : "这一章已改完" }),
		el("span", { class: "adapt-paper-meta", text: `${wordLabel(value.length)} · ${revisionLabel}` }),
	);
	const area = el("textarea", { class: "adapt-paper-body", rows: 22, spellcheck: "false" });
	area.value = value;
	area.addEventListener("input", () => {
		draftText = area.value;
		const meta = wrap.querySelector(".adapt-paper-meta");
		if (meta) meta.textContent = `${wordLabel(countWords(area.value))} · ${revisionLabel}`;
	});
	if (proposal?.summary) wrap.append(el("p", { class: "adapt-summary", text: proposal.summary }));
	wrap.append(head, area);

	const changes = proposal?.changes || [];
	if (changes.length) {
		const list = el("div", { class: "changes-list" });
		for (const change of changes) {
			list.append(
				el(
					"div",
					{ class: "change-row" },
					el("span", { class: `change-kind kind-${change.kind}`, text: CHANGE_LABELS[change.kind] || "其他" }),
					el("div", { class: "change-text" }, el("b", { text: change.summary }), change.detail ? el("span", { class: "change-detail", text: change.detail }) : null),
				),
			);
		}
		wrap.append(el("p", { class: "eyebrow", text: "这一版改了什么" }), list);
	}

	const actions = el("div", { class: "adapt-actions" });
	if (mode === "proposal") {
		actions.append(
			el(
				"button",
				{ class: "btn btn-seal", type: "button", on: { click: () => void applyVersion(area) } },
				icon("check"),
				"采用这一版",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-ghost btn-sm", type: "button", on: { click: () => void readSelected() } },
				icon("eye"),
				"读全篇对照",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-quiet btn-sm", type: "button", on: { click: () => void dropProposal() } },
				icon("x"),
				"弃掉",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-quiet btn-sm", type: "button", on: { click: () => void runSelected(true) } },
				icon("refresh"),
				"按现稿重交一版",
			),
		);
	} else {
		actions.append(
			el(
				"button",
				{ class: "btn btn-seal", type: "button", on: { click: () => void saveAuthorVersion(area) } },
				icon("save"),
				"存下这一版",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-ghost btn-sm", type: "button", on: { click: () => void readSelected() } },
				icon("eye"),
				"读全篇对照",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-quiet btn-sm", type: "button", on: { click: () => void readSelected({ edit: true }) } },
				icon("edit"),
				"整屏改",
			),
		);
		actions.append(
			el(
				"button",
				{ class: "btn btn-quiet btn-sm", type: "button", on: { click: () => void runSelected(true) } },
				icon("refresh"),
				"让改编者再改一版",
			),
		);
	}
	wrap.append(actions);
	return wrap;
}

async function jumpToCursor() {
	const cursor = cursorChapterId();
	if (!cursor) {
		toast("这一本已经改到底了，可以点任意一章回头再改。");
		return;
	}
	selected = cursor;
	proposal = null;
	draftText = "";
	await render({ force: true });
}

async function applyVersion(area) {
	const content = area.value.trim();
	if (!content) {
		toast("改编稿是空的，采用不了。", "warn");
		return;
	}
	const yes = await confirmAction({
		title: "采用这一版？",
		message: "它会成为这一章的正文（存一版历史），台账也一并记上。",
		confirmLabel: "采用",
	});
	if (!yes) return;
	try {
		await api.applyProposal(ctx.state.project.id, selected, {
			proposalId: proposal?.id,
			content: area.value,
			summary: proposal?.summary,
			changes: proposal?.changes,
		});
		toast("这一章算改完了。", "ok");
		await afterSave();
	} catch (error) {
		if (await reportSequenceError(error)) return;
		toast(error.message || "采用不了。", "error");
	}
}

/** 作者自己在改编稿上手改的那一版：不带 proposalId，服务端照样落盘、记台账。 */
async function saveAuthorVersion(area) {
	const content = area.value.trim();
	if (!content) {
		toast("这一版还是空的。", "warn");
		return;
	}
	if (content === chapterDraft.trim()) {
		toast("这一版没有改动。");
		return;
	}
	const yes = await confirmAction({
		title: "存下这一版？",
		message: "它会成为这一章的正文，并记进改编台账（存一版历史）。",
		confirmLabel: "存下",
	});
	if (!yes) return;
	try {
		await api.applyProposal(ctx.state.project.id, selected, { content: area.value });
		toast("存下了。", "ok");
		await afterSave();
	} catch (error) {
		if (await reportSequenceError(error)) return;
		toast(error.message || "没存上。", "error");
	}
}

async function dropProposal() {
	const yes = await confirmAction({ title: "弃掉这一版？", message: "正文一个字不动，只把这份提案撤下来。", confirmLabel: "弃掉", danger: true });
	if (!yes) return;
	try {
		await api.http.del(`/api/projects/${encodeURIComponent(ctx.state.project.id)}/chapters/${encodeURIComponent(selected)}/adapt`);
		proposal = null;
		proposalFor = "";
		draftText = "";
		renderPaper();
		toast("弃掉了。");
	} catch (error) {
		toast(error.message || "弃不掉。", "error");
	}
}

async function afterSave() {
	proposal = null;
	proposalFor = "";
	draftText = "";
	chapterDraft = "";
	chapterDraftFor = "";
	await ctx.reloadProjectStructure();
	if (ctx.state.activeId === selected) await ctx.loadDraft(selected, { silent: true });
	await ensureData(true);
	await render({ force: true });
}

/** 409 里最常见的是「还没轮到这一章」和「你看稿期间又被改过」：都给出下一步，而不是只报个错。 */
async function reportSequenceError(error) {
	const message = error?.message || "";
	if (/一章一章往下走/.test(message) || /已经改到底/.test(message)) {
		const cursor = cursorChapterId();
		const body = el("div", null, el("p", { class: "set-note", text: message }));
		const actions = [{ label: "知道了", onClick: () => close() }];
		if (cursor) {
			actions.push({
				label: "去改轮到的那一章",
				kind: "primary",
				onClick: () => {
					close();
					selected = cursor;
					proposal = null;
					draftText = "";
					void render({ force: true });
				},
			});
		}
		const { close } = openModal({ eyebrow: "改编顺序", title: "还没轮到这一章", body, actions });
		return true;
	}
	if (/又改过一版/.test(message)) {
		toast(message, "warn", 6000);
		await ensureData(true);
		await render({ force: true });
		return true;
	}
	return false;
}

function renderPaper() {
	const old = $("#adapt-paper");
	if (!old) return;
	const fresh = paperNode();
	old.replaceWith(fresh);
	const head = $("#adapt-paper-head");
	if (head) head.textContent = paperHeadLabel();
	const state = $("#adapt-paper-state");
	if (state) {
		state.textContent = streaming
			? "改编者在写…"
			: proposal
				? "交了一版，等你定"
				: isReopened(selected)
					? "已改完，可直接改"
					: "";
	}
}

async function loadProposal(chapterId) {
	const key = `${ctx.state.project.id}:${chapterId}`;
	if (proposalFor !== key) {
		proposalFor = key;
		try {
			const data = await api.getProposal(ctx.state.project.id, chapterId);
			proposal = data.proposal || null;
			draftText = "";
		} catch {
			proposal = null;
		}
	}
	await loadChapterDraft(chapterId);
	renderPaper();
}

/** 已经改过的章：把现在这一版正文取来，作者可以直接在上面改。 */
async function loadChapterDraft(chapterId) {
	const key = `${ctx.state.project.id}:${chapterId}`;
	if (chapterDraftFor === key) return;
	chapterDraftFor = key;
	chapterDraft = "";
	if (!isReopened(chapterId)) return;
	try {
		const data = await api.getDraft(ctx.state.project.id, chapterId);
		chapterDraft = data.chapter?.content || "";
	} catch {
		chapterDraft = "";
	}
}

/* ---------------------------------------------------------------- 跑一轮 */

async function runSelected(rework = false) {
	if (streaming) {
		toast("改编者还在写。");
		return;
	}
	if (!selected) {
		toast("先挑一章。", "error");
		return;
	}
	// 一章一章往下走：没轮到的章先别抢跑（已经改过的章可以回头再改）。
	const cursor = cursorChapterId();
	if (cursor && selected !== cursor && !isReopened(selected)) {
		toast(`改编是一章一章往下走的：现在轮到第 ${cursorIndex() + 1} 章。`, "warn", 6000);
		await jumpToCursor();
		return;
	}
	if (!ctx.aimModel()) {
		toast("还没有能用的模型。先去设置里接一个，改编者才写得动。");
		$("#btn-settings")?.click();
		return;
	}
	const note = rework ? "按现在的正文重交一版" : "";
	if (!adaptation?.brief && !note) {
		const brief = await askBrief();
		if (brief === null) return;
		adaptation = { ...(adaptation || {}), brief };
	}
	proposal = null;
	draftText = "";
	streaming = true;
	renderPaper();
	const scroll = $("#adapt-paper-scroll");
	const streamBox = $("#adapt-stream") || el("div", { class: "adapt-stream", id: "adapt-stream" });
	streamBox.replaceChildren(el("p", { class: "set-note", text: "在读原文与台账…" }));
	if (!streamBox.parentElement && scroll) scroll.append(el("div", { class: "adapt-paper-wrap", id: "adapt-paper" }, streamBox));

	abortCtl = new AbortController();
	ctx.beginRun({ kind: "adapt", label: "改编者在改", abort: () => abortCtl.abort() });
	let text = "";
	const paperText = () => {
		const node = streamBox.querySelector(".adapt-text");
		if (node) node.innerHTML = renderMarkdown(text);
	};

	try {
		await api.adaptChapter(
			ctx.state.project.id,
			selected,
			{
				modelRef: ctx.aimModel() || undefined,
				thinkingLevel: ctx.state.defaultThinkingLevel || undefined,
				note: note || undefined,
			},
			{
				signal: abortCtl.signal,
				onEvent(event) {
					if (event.type === "run_start") {
						streamBox.replaceChildren(el("p", { class: "set-note", text: `改编者上手（${event.model || "模型"}）` }));
						return;
					}
					if (event.type === "tool_start" || event.type === "tool_call") {
						streamBox.append(el("p", { class: "run-note", text: `· ${toolName(event.name)}` }));
						return;
					}
					if (event.type === "text" && event.delta) {
						text += event.delta;
						let node = streamBox.querySelector(".adapt-text");
						if (!node) {
							node = el("div", { class: "adapt-text" });
							streamBox.append(node);
						}
						node.innerHTML = renderMarkdown(text);
						const holder = $("#adapt-paper-scroll");
						if (holder) holder.scrollTop = holder.scrollHeight;
						return;
					}
					if (event.type === "proposal") {
						streamBox.append(el("p", { class: "run-note is-ok", text: "交稿了，正在取回…" }));
						return;
					}
					if (event.type === "error") {
						streamBox.append(el("p", { class: "run-note is-warn", text: event.message || "这一轮出错了。" }));
						return;
					}
					if (event.type === "run_end") {
						if (event.aborted) streamBox.append(el("p", { class: "run-note", text: "停下了。" }));
					}
				},
			},
		);
	} catch (error) {
		if (error?.name !== "AbortError") {
			if (!(await reportSequenceError(error))) toast(error.message || "这一轮没跑完。", "error");
		}
	} finally {
		streaming = false;
		abortCtl = null;
		ctx.endRun();
		proposalFor = "";
		await loadProposal(selected);
		await ensureData(true);
		void render();
	}
}

function toolName(name) {
	const map = { read_source_chapter: "读原书这一章", list_source_chapters: "翻原书目录", get_outline: "看章目", read_chapter: "读现稿", list_materials: "看料", propose_adaptation: "交稿", ask: "问了一句" };
	return map[name] || name;
}

async function askBrief() {
	return new Promise((resolve) => {
		const input = el("textarea", { class: "set-area", rows: 4, placeholder: "如：把民国背景挪到现在，主线保留，视角从账房换成警察。" });
		const body = el("div", null, el("p", { class: "set-note", text: "先说清方向，改编者才知道往哪儿改。" }), input);
		let settled = false;
		const { close } = openModal({
			eyebrow: "改编",
			title: "这一部改成什么样",
			body,
			actions: [
				{ label: "算了", onClick: () => { settled = true; resolve(null); close(); } },
				{
					label: "记下并开写",
					kind: "primary",
					onClick: async () => {
						const brief = input.value.trim();
						settled = true;
						try {
							const data = await api.patchAdaptation(ctx.state.project.id, { brief });
							adaptation = data.adaptation || { ...(adaptation || {}), brief };
						} catch {
							/* 写不上也先跑 */
						}
						resolve(brief);
						close();
					},
				},
			],
		});
		close;
		input.focus();
		void settled;
	});
}

/* ---------------------------------------------------------------- 原书 */

async function openSourceReader() {
	const sourceId = source?.id || adaptation?.sourceId;
	if (!sourceId) {
		toast("这本的原书没挂在原料库里了。", "error");
		return;
	}
	const chapters = source?.chapters || [];
	if (!chapters.length) {
		toast("原书还没拆章，去原料库看看。");
		return;
	}
	const list = el("div", { class: "pick-list" });
	const paper = el("div", { class: "adapt-paper", html: "<p class='set-note'>挑一章读。</p>" });
	for (const chapter of chapters) {
		list.append(
			el(
				"button",
				{
					class: "pick-row",
					type: "button",
					on: {
						click: async () => {
							paper.innerHTML = "<p class='set-note'>在读…</p>";
							try {
								const data = await api.readSourceChapter(sourceId, chapter.id);
								paper.innerHTML = renderMarkdown(data.chapter?.text || "这章是空的。");
								paper.scrollTop = 0;
							} catch (error) {
								paper.textContent = error.message || "读不到。";
							}
						},
					},
				},
				el("span", { class: "pick-main" }, el("span", { class: "pick-title", text: chapter.title || "未命名" }), el("span", { class: "pick-sub", text: `${num(chapter.words || chapter.chars || 0)} 字` })),
			),
		);
	}
	const body = el("div", { class: "adapt-reader" }, el("div", { class: "adapt-reader-list" }, list), paper);
	const { close } = openModal({
		eyebrow: "原书",
		title: source?.title || adaptation?.sourceTitle || "原书",
		body,
		wide: true,
		actions: [{ label: "合上", onClick: () => close() }],
	});
	void chapters.length;
}
