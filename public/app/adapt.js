/**
 * 改编台：把一本别人的书，改成自己的一本。
 *
 * 左边是这一部要改的章，右边一次只摊开一张：方向、这一章的台账、改编者刚交来的稿。
 * 稿不落盘，除非你按下「采用这一版」——改错了，弃掉就是。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, confirmAction, excerpt, renderMarkdown, wordLabel, countWords, num, timeAgo } from "./core.js";
import { diffSegments, markedNodes, paragraphBlocks } from "./compare.js";

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
/**
 * 这一章的原书正文：还没改的章也要能读，改过的章要靠它标出改动。
 * 和改编稿一样按章缓存 —— 翻来翻去不该每翻一次就再取一遍。
 */
let originalText = "";
let originalFor = "";
/** 正文是摊着看的，还是就地改的：只有点「就地改」才换成输入框。 */
let paperEditing = false;
let signature = "";
/**
 * 上一轮改编的现场：状态、每一步工具、流下来的正文。
 * 放在模块里而不是 DOM 里 —— 重渲染（切章、台账刷新、别处触发的 render）会把节点整个换掉，
 * 状态跟着节点走的话，正在跑的那一轮就会凭空消失。
 */
let run = null;
/** 刚换过台账的那一版：只用来闪一下，下一次重画就熄。 */
let freshLedger = false;
/**
 * 手机上「改动区」默认折起来 —— 窄屏第一眼该看见的是正文，不是台账。
 * null = 还没动过手，跟着屏宽走；true / false = 作者自己开合过。
 */
let changesOpen = null;

const narrowAdapt = () => window.matchMedia("(max-width: 920px)").matches;

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
		// 换了台账就得重取提案：proposalFor 是缓存键，不清掉的话下一次 loadProposal
		// 会以为自己已经读过了，交上来的稿子就再也不显示。
		if (force) {
			proposal = null;
			proposalFor = "";
		}
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
		paperEditing,
		proposal?.id ?? "",
	].join("|");
	if (!force && next === signature && host.childElementCount) return;
	signature = next;
	host.replaceChildren(barNode(), bodyNode());
	if (selected) await loadProposal(selected);
	else renderPaper();
	if (freshLedger) scheduleFreshClear();
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
	// 「改编者」不在这儿了：它挂在左栏「改编方向」那条上，离作者交代的方向最近。
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


/**
 * 一屏三件：顶上一条横着滑的章条（手机上就是这个样子），
 * 下面左边是「改动区」，右边才是改编正文。
 * 章目不再独占一整列 —— 那一列除了把正文挤没，什么也没干。
 */
function bodyNode() {
	const chapters = ctx.state.project?.outline || [];
	return el("div", { class: "adapt-body" }, stripNode(chapters), mainNode());
}

function stripNode(chapters) {
	const strip = el("section", { class: "adapt-strip" });
	const done = chapters.filter((item) => ctx.chapterMeta(item.id)?.hasDraft).length;
	const cursor = cursorChapterId();
	const cursorAt = cursorIndex();
	strip.append(
		el(
			"div",
			{ class: "adapt-strip-head" },
			el("span", { class: "adapt-strip-label", text: `章目 · ${chapters.length} 章` }),
			el("span", {
				class: `adapt-cursor${cursor ? "" : " is-done"}`,
				text: cursor ? `轮到第 ${cursorAt + 1} 章` : "已改到底",
			}),
			el("span", { class: "adapt-count", text: `${done}/${chapters.length} 已改` }),
			el("span", { class: "adapt-strip-hint", text: "左右滑" }),
		),
	);
	const list = el("div", { class: "adapt-strip-list", id: "adapt-strip-list" });
	for (const [index, chapter] of chapters.entries()) {
		const marks = (adaptation?.changes || []).filter((change) => change.chapterId === chapter.id).length;
		const done = isReopened(chapter.id);
		const current = chapter.id === cursor;
		const later = cursorAt < chapters.length && index > cursorAt && !done;
		const stateLabel = done ? "已改" : current ? "轮到" : later ? "待改" : "可改";
		list.append(
			el(
				"button",
				{
					class: `adapt-ch${chapter.id === selected ? " is-active" : ""}${done ? " is-done" : ""}${current ? " is-current" : ""}${later ? " is-later" : ""}`,
					type: "button",
					title: `${chapter.title || `第 ${index + 1} 章`} · ${stateLabel}`,
					on: {
						click: () => {
							if (chapter.id === selected) return;
							selected = chapter.id;
							proposal = null;
							proposalFor = "";
							draftText = "";
							// 换一章就重新按默认来：手机上先看正文。
							changesOpen = null;
							if (run?.status !== "running") run = null;
							void render({ force: true });
							scrollStripTo();
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
						el("span", { class: "adapt-ch-name", text: chapter.title || `第 ${index + 1} 章` }),
						el("span", { class: `adapt-ch-state is-${done ? "done" : current ? "current" : "later"}`, text: stateLabel }),
					),
					el("span", { class: "adapt-ch-sub", text: excerpt(chapter.summary || "还没有提要", 40) }),
				),
				marks ? el("span", { class: "adapt-ch-marks", text: `${marks} 改` }) : null,
			),
		);
	}
	if (!chapters.length) list.append(el("p", { class: "set-note", text: "还没有章。先去写作台或大纲里把章列出来。" }));
	strip.append(list);
	return strip;
}

/** 选中那一章留在视野里：章条再长，眼睛也不用自己找。 */
function scrollStripTo() {
	const list = $("#adapt-strip-list");
	if (!list) return;
	const active = list.querySelector(".adapt-ch.is-active");
	if (!active) return;
	const left = active.offsetLeft - list.clientWidth / 2 + active.offsetWidth / 2;
	list.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
}

function mainNode() {
	const narrow = narrowAdapt();
	// 宽屏两栏并排，改动区就该一直摊着；窄屏默认收起来，把高度让给正文。
	const open = narrow ? run?.status === "running" || changesOpen === true : true;
	const changeCol = el("section", { class: `adapt-col adapt-change-col${open ? "" : " is-collapsed"}` });
	const toggle = el(
		"button",
		{
			class: "adapt-col-toggle only-narrow",
			type: "button",
			"aria-expanded": open ? "true" : "false",
			title: open ? "收起改动区" : "展开改动区",
		},
		icon("chevron-down", "ico ico-sm"),
		el("span", { class: "adapt-col-toggle-text", text: open ? "收起" : "展开" }),
	);
	const changeHead = el(
		"div",
		{ class: "adapt-col-head adapt-change-head" },
		el("span", { class: "adapt-col-title", text: "改动区" }),
		el("span", { class: "adapt-count", id: "adapt-ledger-count", text: ledgerCountLabel() }),
		toggle,
	);
	// 整行都能点：手机上一个小小的箭头不好按。
	changeHead.addEventListener("click", () => {
		if (!narrowAdapt()) return;
		const next = changeCol.classList.contains("is-collapsed");
		changesOpen = next;
		changeCol.classList.toggle("is-collapsed", !next);
		toggle.setAttribute("aria-expanded", next ? "true" : "false");
		toggle.title = next ? "收起改动区" : "展开改动区";
		const label = toggle.querySelector(".adapt-col-toggle-text");
		if (label) label.textContent = next ? "收起" : "展开";
	});
	changeCol.append(changeHead);
	const changeScroll = el("div", { class: "adapt-scroll", id: "adapt-change-scroll" });
	changeScroll.append(briefNode(), runNode(), ledgerNode(freshLedger));
	changeCol.append(changeScroll);

	const paperCol = el("section", { class: "adapt-col adapt-paper-col" });
	paperCol.append(
		el(
			"div",
			{ class: "adapt-col-head" },
			el("span", { class: "adapt-col-title", id: "adapt-paper-head", text: paperHeadLabel() }),
			el("span", { class: "adapt-count", id: "adapt-paper-state", text: paperStateLabel() }),
		),
	);
	const scroll = el("div", { class: "adapt-scroll", id: "adapt-paper-scroll" });
	scroll.append(paperNode());
	paperCol.append(scroll);

	return el("div", { class: "adapt-main" }, changeCol, paperCol);
}

function paperHeadLabel() {
	const chapter = ctx.outlineItem(selected);
	const title = chapter?.title || "";
	if (!title) return "正文";
	// 还没改的章，这一栏摊的是原书：抬头就照实说原书，别把原书叫成改编正文。
	const adapted = Boolean(proposal) || isReopened(selected);
	return adapted ? `改编正文 · ${title}` : `原书 · ${title}`;
}

function paperStateLabel() {
	if (streaming) return "改编者在写…";
	if (proposal) return "交了一版，等你定";
	return isReopened(selected) ? "已改完，可直接改" : "";
}


/**
 * 改编方向是全书共用的，默认折起来：它一摊开就是半屏，把台账挤出视野。
 * 「改编者」这颗按钮就挂在这一条上 —— 它是照着这份方向去改的那一方，
 * 摆在顶栏隔着整块正文去按，等于让作者先跨半屏再回来。
 */
function briefNode() {
	const text = adaptation?.brief || "";
	const box = el("details", { class: "adapt-brief-wrap", id: "adapt-brief-fold" });
	if (!text) box.setAttribute("open", "");
	const peek = el("span", { class: "adapt-brief-peek", text: text ? excerpt(text, 60) : "还没写：先说清这一部改成什么样" });
	const runBtn = el(
		"button",
		{
			class: "btn btn-seal btn-sm adapt-run-brief",
			type: "button",
			title: "让改编者按这份方向改这一章",
			on: {
				click: (event) => {
					// summary 里点一下会顺手开合 details，这颗按钮不该带这个副作用。
					event.preventDefault();
					event.stopPropagation();
					void runSelected();
				},
			},
		},
		icon("quill", "ico ico-sm"),
		el("span", { class: "btn-label", text: streaming ? "在改" : "改编者" }),
	);
	if (streaming) runBtn.setAttribute("disabled", "");
	const head = el(
		"summary",
		{ class: "adapt-brief-head" },
		icon("quill", "ico ico-sm"),
		el("span", { class: "adapt-brief-label", text: "改编方向" }),
		peek,
		runBtn,
	);
	const brief = el("textarea", { class: "adapt-brief", rows: 3, placeholder: "这一部改成什么样：什么留下、什么拆掉，换成谁的眼睛看。" });
	brief.value = text;
	brief.addEventListener("blur", async () => {
		const next = brief.value.trim();
		if (next === (adaptation?.brief || "")) return;
		try {
			const data = await api.patchAdaptation(ctx.state.project.id, { brief: next });
			adaptation = data.adaptation || { ...adaptation, brief: next };
			peek.textContent = next ? excerpt(next, 60) : "还没写：先说清这一部改成什么样";
			toast("方向记下了。");
		} catch (error) {
			toast(error.message || "方向没存上。", "error");
		}
	});
	box.append(head, brief);
	return box;
}


/* ---------------------------------------------------------------- 改动区 */

const CHANGE_ORDER = ["character", "persona", "plot", "pov", "addition", "style", "title", "other"];

function chapterChanges() {
	return (adaptation?.changes || []).filter((change) => change.chapterId === selected);
}

function ledgerCountLabel() {
	const changes = chapterChanges();
	if (!changes.length) return "还没有改动";
	const stamp = Math.max(...changes.map((change) => Number(change.createdAt) || 0));
	return stamp ? `${changes.length} 条 · ${timeAgo(stamp)}` : `${changes.length} 条`;
}

/**
 * 改动区就是要能变：采用新一版之后，服务端把这一章的条目整批换掉（只留改名史），
 * 这里照着新数据重画，刚换上的那几条闪一下，让作者看见「换了」。
 */
function ledgerNode(fresh = false) {
	const box = el("div", { class: "adapt-ledger", id: "adapt-ledger" });
	const changes = chapterChanges();
	if (!changes.length) {
		box.append(
			el("p", {
				class: "set-note",
				text: "这一章还没有改动记录。改编者交稿时会写清改了什么；采用之后，这一章的条目整批换成最新那一版说的，不会叠成两套。",
			}),
		);
		return box;
	}
	const groups = new Map();
	for (const change of changes) {
		const kind = CHANGE_LABELS[change.kind] ? change.kind : "other";
		if (!groups.has(kind)) groups.set(kind, []);
		groups.get(kind).push(change);
	}
	const order = [
		...CHANGE_ORDER.filter((kind) => groups.has(kind)),
		...[...groups.keys()].filter((kind) => !CHANGE_ORDER.includes(kind)),
	];
	for (const kind of order) {
		const rows = groups.get(kind);
		const group = el(
			"div",
			{ class: "adapt-ledger-group" },
			el(
				"div",
				{ class: "adapt-ledger-group-head" },
				el("span", { class: `change-kind kind-${kind}`, text: CHANGE_LABELS[kind] || "其他" }),
				el("span", { class: "adapt-ledger-group-count", text: `${rows.length} 条` }),
			),
		);
		const list = el("div", { class: "changes-list" });
		for (const change of rows) {
			list.append(
				el(
					"div",
					{ class: `change-row${fresh ? " is-fresh" : ""}` },
					el(
						"div",
						{ class: "change-text" },
						el("b", { text: change.summary }),
						change.detail ? el("span", { class: "change-detail", text: change.detail }) : null,
						change.createdAt ? el("span", { class: "change-stamp", text: timeAgo(change.createdAt) }) : null,
					),
				),
			);
		}
		group.append(list);
		box.append(group);
	}
	return box;
}

function renderLedger() {
	const old = $("#adapt-ledger");
	if (old) old.replaceWith(ledgerNode(freshLedger));
	const count = $("#adapt-ledger-count");
	if (count) count.textContent = ledgerCountLabel();
	if (freshLedger) scheduleFreshClear();
}

/** 高亮只闪一次：闪完把状态清掉，免得每次重画都从头再闪一遍。 */
function scheduleFreshClear() {
	setTimeout(() => {
		freshLedger = false;
		for (const row of document.querySelectorAll(".change-row.is-fresh")) row.classList.remove("is-fresh");
	}, 2400);
}


/* ---------------------------------------------------------------- 运行详情 */

function elapsedOf(entry) {
	return Math.max(0, (entry.endedAt || Date.now()) - entry.startedAt);
}

function seconds(ms) {
	return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

function runTitle() {
	if (!run) return "改编者";
	return run.model ? `改编者 · ${run.model}` : "改编者";
}

function runStatusText() {
	if (!run) return "";
	if (run.status === "running") return `在写 · ${seconds(elapsedOf(run))}`;
	if (run.status === "aborted") return `停下了 · ${seconds(elapsedOf(run))}`;
	if (run.status === "failed") return `没跑完 · ${seconds(elapsedOf(run))}`;
	return `跑完了 · ${seconds(elapsedOf(run))}`;
}

function runMetaText() {
	if (!run) return "";
	const steps = run.steps.filter((step) => step.name).length;
	return `${runStatusText()}${steps ? ` · ${steps} 步` : ""}`;
}

/**
 * 运行卡片：跑着的时候在左栏顶上慢慢转一个点、走计时、一步步亮出来；
 * 跑完折成一行，点一下才摊开每一段读了什么、交了什么 —— 详情不是一直摊在脸上的。
 */
function runNode() {
	const wrap = el("section", {
		class: `adapt-run is-${run?.status || "idle"}${run?.open ? " is-open" : ""}`,
		id: "adapt-run",
	});
	if (!run) {
		wrap.hidden = true;
		return wrap;
	}
	const toggle = el(
		"button",
		{
			class: "adapt-run-toggle",
			type: "button",
			"aria-expanded": run.open ? "true" : "false",
			on: {
				click: () => {
					if (!run) return;
					run.open = !run.open;
					renderRun();
				},
			},
		},
		el("span", { class: "adapt-run-dot" }),
		el("span", { class: "adapt-run-title", text: runTitle() }),
		el("span", { class: "adapt-run-meta", id: "adapt-run-meta", text: runMetaText() }),
		icon("chevron-down", "ico ico-sm adapt-run-arrow"),
	);
	const head = el("div", { class: "adapt-run-head" }, toggle);
	if (run.status === "running") {
		head.append(
			el(
				"button",
				{
					class: "btn btn-quiet btn-sm adapt-run-stop",
					type: "button",
					title: "停下这一轮",
					on: { click: () => abortCtl?.abort() },
				},
				icon("stop"),
			),
		);
	}
	wrap.append(head);
	if (!run.open) return wrap;

	const body = el("div", { class: "adapt-run-body" });
	if (run.error) body.append(el("p", { class: "adapt-run-error", text: run.error }));
	if (run.thought) {
		body.append(el("p", { class: "eyebrow", text: "琢磨" }));
		body.append(el("p", { class: "adapt-run-thinking", text: excerpt(run.thought, 400) }));
	}
	const steps = el("div", { class: "adapt-run-steps" });
	for (const step of run.steps) steps.append(stepNode(step));
	if (!run.steps.length) {
		steps.append(el("p", { class: "set-note", text: run.status === "running" ? "还没动手。" : "这一轮没调用工具。" }));
	}
	body.append(steps);
	if (run.text) {
		body.append(el("p", { class: "eyebrow", text: "流下来的字" }));
		body.append(el("div", { class: "adapt-run-text", id: "adapt-run-text", html: renderMarkdown(run.text) }));
	}
	wrap.append(body);
	return wrap;
}

function stepNode(step) {
	const row = el(
		"div",
		{ class: `adapt-step is-${step.phase}${step.isError ? " is-error" : ""}${step.kind ? ` is-${step.kind}` : ""}` },
		el("span", { class: "adapt-step-dot" }),
		el("span", { class: "adapt-step-label", text: step.label || toolName(step.name) }),
	);
	if (step.phase === "done" && step.name) {
		row.append(el("span", { class: "adapt-step-time", text: seconds(step.durationMs) }));
	}
	if (step.name) {
		row.append(el("span", { class: "adapt-step-tool", text: step.args ? `${step.name}(${step.args})` : step.name }));
	}
	if (step.preview) row.append(el("p", { class: "adapt-step-preview", text: excerpt(step.preview, 200) }));
	return row;
}

/** 只换卡片本身，不整页重画：整页重画会吞掉滚动位置与展开状态。 */
function renderRun() {
	const old = $("#adapt-run");
	if (old) {
		old.replaceWith(runNode());
		return;
	}
	const holder = $("#adapt-change-scroll");
	if (holder) holder.prepend(runNode());
}

/** 计时半秒一跳，只改那一行字，不动整张卡。 */
function startRunClock() {
	stopRunClock();
	if (!run) return;
	run.timer = setInterval(() => {
		const meta = $("#adapt-run-meta");
		if (!meta || !run || run.status !== "running") return;
		meta.textContent = runMetaText();
	}, 500);
}

function stopRunClock() {
	if (run?.timer) {
		clearInterval(run.timer);
		run.timer = null;
	}
}

function argsText(args) {
	if (!args || typeof args !== "object") return "";
	const parts = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === null || value === undefined || value === "") continue;
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		parts.push(`${key}: ${excerpt(String(raw), 28)}`);
		if (parts.length >= 2) break;
	}
	return parts.join(" · ");
}

/** tool_start 给的是工具真名，tool_call 可能先到一步：同名的待跑条目就并成一条，不刷两行。 */
function startStep(name, args) {
	if (!run) return;
	for (let index = run.steps.length - 1; index >= 0; index -= 1) {
		const step = run.steps[index];
		if (step.name === name && step.phase !== "done") {
			step.phase = "running";
			step.startedAt = Date.now();
			step.args = argsText(args) || step.args;
			return;
		}
	}
	run.steps.push({ name, args: argsText(args), phase: "running", startedAt: Date.now(), durationMs: 0, isError: false, preview: "" });
}

function finishStep(event) {
	if (!run) return;
	for (let index = run.steps.length - 1; index >= 0; index -= 1) {
		const step = run.steps[index];
		if (step.name !== event.name || step.phase === "done") continue;
		step.phase = "done";
		step.durationMs = Number(event.durationMs) || Date.now() - step.startedAt;
		step.isError = Boolean(event.isError);
		step.preview = event.preview || "";
		return;
	}
}

function pushNote(label, kind = "") {
	if (!run) return;
	run.steps.push({ name: "", label, kind, phase: "done", startedAt: Date.now(), durationMs: 0, isError: kind === "warn", preview: "" });
}

/**
 * 右栏那一张稿：改编过的章摊改编稿（改过的句子垫底色），还没改的章就摊原书这一章。
 * 章条上点哪一章，这里就显示哪一章的正文 —— 正在改的、待改的、改过的都一样。
 */
function paperNode() {
	const wrap = el("div", { class: "adapt-paper-wrap", id: "adapt-paper" });
	const chapters = ctx.state.project?.outline || [];
	const index = chapters.findIndex((item) => item.id === selected);
	const done = isReopened(selected);
	const current = selected === cursorChapterId();
	const cursorAt = cursorIndex();
	const later = cursorAt < chapters.length && index > cursorAt;

	const mode = proposal ? "proposal" : done ? "author" : "original";
	const content = proposal ? proposal.content : done ? chapterDraft : "";
	const shown = draftText || content;
	const hasSomething = Boolean(shown || originalText);

	if (!hasSomething) {
		// 原书也没取到、稿子也没有：只剩一句「还没交稿」，原因写到点了。
		const empty = el("div", { class: "adapt-empty" });
		empty.append(icon(streaming ? "quill" : "book-open"));
		empty.append(
			el("p", {
				text: streaming
					? "改编者在写这一章。"
					: current
						? "轮到这一章了，还没交稿。"
						: later
							? `还没轮到这一章：先改完第 ${cursorAt + 1} 章。`
							: "这一章还没交稿。",
			}),
		);
		empty.append(
			el("p", {
				class: "set-note",
				text: streaming
					? "读原书、翻台账、一步步想，都摆在左栏那张运行卡里；跑完它会自己收起来，点一下还能翻。"
					: later
						? "改编是一章一章往下走的：后面的章要接住前面的改动，跳着改会把设定搅乱。"
						: "让改编者读原书这一章与前面的台账，交一版给你过目；也可以自己先把这一章写出来。",
			}),
		);
		if (!streaming) wrap.append(paperButtons(mode, later, cursorAt, null));
		wrap.append(empty);
		return wrap;
	}

	// 抬头这一行只说「这是第几稿」，章名与状态在栏头上已经有了，不重复说一遍。
	const revisionLabel = proposal
		? `基线第 ${proposal.baseRevision} 稿`
		: done
			? `第 ${ctx.chapterMeta(selected)?.revision || 1} 稿`
			: "原书原文";
	const head = el(
		"div",
		{ class: "adapt-paper-head" },
		el("span", {
			class: "eyebrow",
			text: streaming && mode === "original" ? "改编者在写…" : revisionLabel,
		}),
		el("span", {
			class: "adapt-paper-meta",
			text: mode === "original" ? `${wordLabel(countWords(shown || originalText))} · 还没改` : wordLabel(countWords(shown || originalText)),
		}),
	);
	wrap.append(head);
	// 摘要留着：那是改编者一句话说清这一版干了什么；改动条目只归左栏，
	// 右栏再列一遍等于把正文挤到屏幕外面去。
	if (proposal?.summary) wrap.append(el("p", { class: "adapt-summary", text: proposal.summary }));
	wrap.append(paperBody(mode, shown));
	wrap.append(paperButtons(mode, later, cursorAt));
	return wrap;
}

/**
 * 正文：默认是「读」，改过的句子垫底色。
 * 只想就地动两笔的时候才换成输入框 —— 改编台的正文首先是给人读的。
 */
function paperBody(mode, shown) {
	// 改过的句子拿原书做底子对照；还没改的章原书就是正文本身，走段落摊开。
	const base = originalText || "";
	const text = shown || originalText || "";
	if (paperEditing) {
		const area = el("textarea", { class: "adapt-paper-body", rows: 22, spellcheck: "false" });
		area.value = text;
		area.addEventListener("input", () => {
			draftText = area.value;
			const meta = $("#adapt-paper")?.querySelector(".adapt-paper-meta");
			if (meta && mode !== "original") meta.textContent = wordLabel(countWords(area.value));
		});
		return area;
	}
	const box = el("div", { class: "adapt-paper-body adapt-paper-read" });
	if (!text.trim()) {
		box.append(el("p", { class: "set-note", text: "这一章还没有字。" }));
		return box;
	}
	// 原书这一章取到了才能标改动；取不到就老实按段落摊开，不假装对照过。
	if (base && base.trim() && text !== base) {
		const segments = diffSegments(base, text);
		const changed = segments.filter((segment) => segment.changed).length;
		if (changed) {
			box.append(
				el(
					"p",
					{ class: "adapt-legend" },
					icon("wand", "ico ico-sm"),
					el("span", { text: `对照原书：${changed} 处不同，垫底色的就是改过的地方。` }),
				),
			);
		}
		box.append(...markedNodes(segments, { paragraphClass: "adapt-p", markClass: "adapt-mark" }));
	} else {
		box.append(...paragraphBlocks(text, "adapt-p"));
	}
	return box;
}

/** 正文底下那一排动作：按「这一版是提案 / 已改 / 还没改」给不同的下一步。 */
function paperButtons(mode, later, cursorAt, area) {
	const actions = el("div", { class: "adapt-actions" });
	const editToggle = (label) =>
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				on: {
					click: () => {
						paperEditing = !paperEditing;
						renderPaper();
					},
				},
			},
			icon("edit"),
			label,
		);
	if (mode === "proposal") {
		actions.append(
			el(
				"button",
				{ class: "btn btn-seal", type: "button", on: { click: () => void applyVersion() } },
				icon("check"),
				"采用这一版",
			),
		);
		actions.append(editToggle(paperEditing ? "收起笔" : "就地改"));
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
		return actions;
	}
	if (mode === "author") {
		if (paperEditing) {
			actions.append(
				el(
					"button",
					{ class: "btn btn-seal", type: "button", on: { click: () => void saveAuthorVersion() } },
					icon("save"),
					"存下这一版",
				),
			);
		}
		actions.append(editToggle(paperEditing ? "收起笔" : "就地改"));
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
				{ class: "btn btn-quiet btn-sm", type: "button", on: { click: () => void runSelected(true) } },
				icon("refresh"),
				"让改编者再改一版",
			),
		);
		return actions;
	}
	// 还没改的章：这里只有原书，能做的只有「自己写」或「先回去改轮到的章」。
	if (!streaming) {
		if (later) {
			actions.append(
				el(
					"button",
					{ class: "btn btn-primary", type: "button", on: { click: () => void jumpToCursor() } },
					icon("arrow-right"),
					`先改第 ${cursorAt + 1} 章`,
				),
			);
		}
		actions.append(
			el(
				"button",
				{ class: "btn btn-ghost", type: "button", on: { click: () => void readSelected({ edit: true }) } },
				icon("edit"),
				"自己写这一章",
			),
		);
	}
	return actions;
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

/** 正文现在这一版是什么：就地改过就是改后的，否则是提案或已存下的稿。 */
function currentPaperText() {
	if (draftText) return draftText;
	return proposal ? proposal.content || "" : chapterDraft || "";
}

async function applyVersion() {
	const content = currentPaperText().trim();
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
			content,
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
async function saveAuthorVersion() {
	const content = currentPaperText().trim();
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
		await api.applyProposal(ctx.state.project.id, selected, { content });
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
	paperEditing = false;
	await ctx.reloadProjectStructure();
	if (ctx.state.activeId === selected) await ctx.loadDraft(selected, { silent: true });
	await ensureData(true);
	// 这一章台账整批换过了：先就地重画让它闪一下，再走整页重画把章条与顶部一行也刷新。
	freshLedger = true;
	renderLedger();
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
	await loadOriginal(chapterId);
	renderPaper();
}

/**
 * 这一章的原书正文：章序与原书章节一一对齐（建工程时就是这么立的章目）。
 * 待改的章靠它给作者看东西，改过的章靠它标出改动。
 */
async function loadOriginal(chapterId) {
	const key = `${ctx.state.project.id}:${chapterId}`;
	if (originalFor === key) return;
	originalFor = key;
	originalText = "";
	const plan = ctx.state.project?.adaptation;
	const sourceId = plan?.sourceId || source?.id || "";
	if (!sourceId) return;
	const chapters = ctx.state.project?.outline || [];
	const index = chapters.findIndex((item) => item.id === chapterId);
	if (index < 0) return;
	try {
		// source.chapters 是 getAdaptation 一并带回来的目录，省一次目录请求。
		const catalog = source?.chapters || [];
		if (!catalog.length) source = await api.getAdaptation(ctx.state.project.id).then((data) => data.source || source);
		const list = source?.chapters || [];
		const one = list[index];
		if (!one) return;
		const data = await api.readSourceChapter(sourceId, one.id);
		const found = data?.chapter || {};
		originalText = found.content || found.text || "";
	} catch {
		originalText = "";
	}
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
	run = {
		status: "running",
		open: true,
		model: ctx.aimModel() || "",
		startedAt: Date.now(),
		endedAt: 0,
		steps: [],
		text: "",
		thought: "",
		error: "",
		chapterId: selected,
		timer: null,
	};
	renderPaper();
	renderRun();
	startRunClock();

	abortCtl = new AbortController();
	ctx.beginRun({ kind: "adapt", label: "改编者在改", abort: () => abortCtl.abort() });
	let text = "";

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
						if (run) run.model = event.model || run.model;
						renderRun();
						return;
					}
					if (event.type === "thinking" && event.delta) {
						if (!run) return;
						run.thought += event.delta;
						return;
					}
					if (event.type === "tool_call") {
						// tool_call 只有名字（参数在 tool_start 里），先占个位；同名再到时并成一条。
						startStep(event.name, event.args);
						renderRun();
						return;
					}
					if (event.type === "tool_start") {
						startStep(event.name, event.args);
						renderRun();
						return;
					}
					if (event.type === "tool_end") {
						finishStep(event);
						renderRun();
						return;
					}
					if (event.type === "text" && event.delta) {
						text += event.delta;
						if (run) run.text = text;
						const node = $("#adapt-run-text");
						if (node) {
							node.innerHTML = renderMarkdown(text);
							const holder = $("#adapt-change-scroll");
							if (holder) holder.scrollTop = holder.scrollHeight;
						} else if (run?.status === "running") {
							// 卡片还没摊开就别硬塞：只在折着的时候提示字数在长。
							const meta = $("#adapt-run-meta");
							if (meta) meta.textContent = runMetaText();
						}
						return;
					}
					if (event.type === "proposal") {
						pushNote("交稿了，正在取回…", "ok");
						renderRun();
						return;
					}
					if (event.type === "error") {
						if (run) run.error = event.message || "这一轮出错了。";
						pushNote(event.message || "这一轮出错了。", "warn");
						renderRun();
						return;
					}
					if (event.type === "run_end") {
						if (run) {
							run.status = event.aborted ? "aborted" : run.error ? "failed" : "done";
							run.endedAt = Date.now();
							if (event.aborted) pushNote("停下了。");
						}
						stopRunClock();
						renderRun();
					}
				},
			},
		);
	} catch (error) {
		if (error?.name !== "AbortError") {
			if (run) {
				run.status = "failed";
				run.error = error?.message || "这一轮没跑完。";
				run.endedAt = Date.now();
			}
			if (!(await reportSequenceError(error))) toast(error.message || "这一轮没跑完。", "error");
		} else if (run) {
			run.status = "aborted";
			run.endedAt = Date.now();
		}
	} finally {
		streaming = false;
		abortCtl = null;
		stopRunClock();
		if (run) {
			if (run.status === "running") {
				run.status = "done";
				run.endedAt = Date.now();
			}
			// 跑完就折起来：详情留着，但别一直摊在左栏最上面。
			run.open = false;
			run.timer = null;
		}
		ctx.endRun();
		// 跑这一轮的时候作者可能翻到别章去了：稿子落在跑的那一章上，就把人带回那一章，
		// 免得交稿提示和正文摆在两个不同的地方。
		if (run?.chapterId && run.chapterId !== selected && run.status === "done") {
			selected = run.chapterId;
			proposal = null;
			proposalFor = "";
			draftText = "";
		}
		// 台账与章目都可能被这一轮改过（改名会当场记一条），整页重画时先 ensureData(true)
		// 把新的取回来再建 DOM。顺序不能反 —— 先 loadProposal 再清提案缓存，会把刚交上来的稿子抹掉。
		// 不置 freshLedger：这一轮只是交稿，台账真正换掉是在「采用」那一刻。
		await render({ force: true });
	}
}

/** 工具真名照 src/ai/adapt.ts 里那五个，外加写作侧会顺手用到的几个。 */
function toolName(name) {
	const map = {
		read_original_chapter: "读原书这一章",
		read_adapted_chapter: "读改编稿这一章",
		search_adaptation_changes: "翻台账",
		rename_chapter: "改章名",
		propose_adaptation: "交稿",
		read_source_chapter: "读原书这一章",
		list_source_chapters: "翻原书目录",
		get_outline: "看章目",
		read_chapter: "读现稿",
		read_previous_chapter: "读上一章",
		list_materials: "看料",
		upsert_material: "记一条料",
		attach_materials: "挂料",
		ask: "问了一句",
		ask_user: "问了一句",
	};
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
