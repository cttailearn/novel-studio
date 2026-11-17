/**
 * 改编台：把一本别人的书，改成自己的一本。
 *
 * 左边是这一部要改的章，右边一次只摊开一张：方向、这一章的台账、改编者刚交来的稿。
 * 稿不落盘，除非你按下「采用这一版」——改错了，弃掉就是。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, confirmAction, excerpt, renderMarkdown, wordLabel, timeAgo, num } from "./core.js";

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
let signature = "";

const CHANGE_LABELS = {
	character: "人物",
	persona: "人设",
	plot: "情节",
	pov: "视角",
	addition: "增补",
	style: "语感",
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
		selected = ctx.state.activeId && chapters.some((item) => item.id === ctx.state.activeId)
			? ctx.state.activeId
			: chapters.find((item) => item.status !== "drafted")?.id || chapters[0]?.id || "";
	}
	const next = [project.id, selected, chapters.length, project.updatedAt, streaming, draftText.length].join("|");
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
	const title = el(
		"div",
		{ class: "adapt-bar-title" },
		el("h2", { text: project.title }),
		el("span", { class: "tag tag-jade", text: "改编" }),
		el("span", { class: "adapt-source", text: `原书：${sourceLabel}` }),
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
			"翻原书",
		),
	);
	actions.append(
		el(
			"button",
			{
				class: "btn btn-ghost btn-sm",
				type: "button",
				on: {
					click: () => void runSelected(),
				},
			},
			icon("quill"),
			"让改编者改这一章",
		),
	);
	bar.append(title, actions);
	return bar;
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
			el("span", { class: "adapt-count", text: `${chapters.filter((item) => item.status === "drafted").length} 章改完` }),
		),
	);
	const list = el("div", { class: "adapt-scroll" });
	for (const [index, chapter] of chapters.entries()) {
		const marks = (adaptation?.changes || []).filter((change) => change.chapterId === chapter.id).length;
		const row = el(
			"button",
			{
				class: `adapt-ch${chapter.id === selected ? " is-active" : ""}`,
				type: "button",
				on: {
					click: () => {
						selected = chapter.id;
						proposal = null;
						void render();
					},
				},
			},
			el("span", { class: "adapt-ch-ord", text: String(index + 1).padStart(2, "0") }),
			el(
				"span",
				{ class: "adapt-ch-main" },
				el("span", { class: "adapt-ch-title", text: chapter.title || `第 ${index + 1} 章` }),
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
	if (!proposal) {
		const empty = el("div", { class: "adapt-empty" });
		empty.append(icon("book-open"));
		empty.append(el("p", { text: "这一章还没交稿。" }));
		empty.append(el("p", { class: "set-note", text: "点上面「让改编者改这一章」，它会读原文与台账，交一版给你看。" }));
		wrap.append(empty);
		return wrap;
	}
	const head = el(
		"div",
		{ class: "adapt-paper-head" },
		el("span", { class: "eyebrow", text: "改编稿" }),
		el("span", { class: "adapt-paper-meta", text: `${wordLabel(draftText ? draftText.length : proposal.content.length)} · 基线第 ${proposal.baseRevision} 稿` }),
	);
	const area = el("textarea", { class: "adapt-paper-body", rows: 18, spellcheck: "false" });
	area.value = draftText || proposal.content;
	area.addEventListener("input", () => {
		draftText = area.value;
	});
	if (proposal.summary) wrap.append(el("p", { class: "adapt-summary", text: proposal.summary }));
	wrap.append(head, area);

	const changes = proposal.changes || [];
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
	actions.append(
		el(
			"button",
			{
				class: "btn btn-seal",
				type: "button",
				on: {
					click: async () => {
						const yes = await confirmAction({
							title: "采用这一版？",
							message: "它会成为这一章的正文（存一版历史），台账也一并记上。",
							confirmLabel: "采用",
						});
						if (!yes) return;
						try {
							await api.applyProposal(ctx.state.project.id, selected, {
								proposalId: proposal.id,
								content: area.value,
								summary: proposal.summary,
								changes: proposal.changes,
							});
							proposal = null;
							proposalFor = "";
							draftText = "";
							await ctx.reloadProjectStructure();
							if (ctx.state.activeId === selected) await ctx.loadDraft(selected, { silent: true });
							await ensureData(true);
							await render();
							toast("这一章算改完了。", "ok");
						} catch (error) {
							toast(error.message || "采用不了。", "error");
						}
					},
				},
			},
			icon("check"),
			"采用这一版",
		),
		el(
			"button",
			{
				class: "btn btn-ghost btn-sm",
				type: "button",
				on: {
					click: async () => {
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
					},
				},
			},
			"弃掉",
		),
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				on: { click: () => void runSelected(true) },
			},
			icon("refresh"),
			"按现稿重交一版",
		),
	);
	wrap.append(actions);
	return wrap;
}

function renderPaper() {
	const old = $("#adapt-paper");
	if (!old) return;
	const fresh = paperNode();
	old.replaceWith(fresh);
	const head = $("#adapt-paper-head");
	if (head) head.textContent = paperHeadLabel();
	const state = $("#adapt-paper-state");
	if (state) state.textContent = streaming ? "改编者在写…" : proposal ? "交了一版，等你定" : "";
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
	renderPaper();
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
		if (error?.name !== "AbortError") toast(error.message || "这一轮没跑完。", "error");
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
	void timeAgo;
}
