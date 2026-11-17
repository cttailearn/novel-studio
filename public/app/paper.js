/**
 * 稿纸：一张白纸，一支笔，和一句话的余地。
 *
 * 正文永远只有一个输入框。AI 写的时候它不是被「替换」，而是被摆在旁边跑，
 * 跑完再从服务端把存下来的那一版取回来 —— 谁写的、写没写进去，都看得见。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, $$, el, icon, toast, openModal, wordLabel, num, countWords, renderMarkdown, excerpt, debounce, sleep, pack } from "./core.js";

let mounted = false;
let textarea = null;
let titleInput = null;
let rendering = false;
let writeAbort = null;

export function initPaper() {
	if (mounted) return;
	mounted = true;
	textarea = $("#ms-body");
	titleInput = $("#ms-title");

	textarea?.addEventListener("input", () => {
		if (rendering) return;
		ctx.markDirty(textarea.value);
		renderMeta();
		fit();
		keepCaretCentered();
	});
	textarea?.addEventListener("keydown", (event) => {
		// Tab 在稿纸里不该跳出正文；缩进两个全角空格。
		if (event.key === "Tab" && !event.shiftKey) {
			event.preventDefault();
			insertText("　　");
		}
	});
	textarea?.addEventListener("select", () => renderActions());
	textarea?.addEventListener("mouseup", () => renderActions());
	textarea?.addEventListener("keyup", () => {
		renderActions();
		keepCaretCentered();
	});
	titleInput?.addEventListener("input", () => {
		if (!ctx.state.draft) return;
		ctx.state.draft.title = titleInput.value;
		ctx.state.saving = "dirty";
		ctx.notify("save");
	});
	titleInput?.addEventListener("blur", () => {
		if (ctx.state.saving === "dirty") void ctx.saveDraft({ autosave: true });
	});

	for (const tab of $$(".paper-tabs .tab")) {
		tab.addEventListener("click", () => setTab(tab.dataset.tab));
	}
	$("#btn-focus")?.addEventListener("click", () => toggleFocus());

	ctx.onChange((scope) => {
		if (scope === "draft" || scope === "active" || scope === "project") {
			renderPage();
			renderActions();
		}
		if (scope === "tab" || scope === "view") {
			syncTab();
			renderActions();
		}
		if (scope === "save" || scope === "words") renderMeta();
		if (scope === "prefs") {
			// 设置里刚改过字号、行距或打字机模式：纸面立刻照新样子排。
			$("#ms-page")?.classList.toggle("is-typewriter", ctx.state.prefs?.typewriter === true);
			fit();
			keepCaretCentered();
		}
	});
	syncTab();
	renderPage();
	renderActions();
}

function toggleFocus() {
	ctx.state.focus = !ctx.state.focus;
	$("#app").classList.toggle("is-focus", ctx.state.focus);
	ctx.notify("focus");
}

function setTab(tab) {
	if (!["paper", "materials", "outline"].includes(tab)) return;
	ctx.state.tab = tab;
	ctx.notify("tab");
	ctx.notify("view");
}

const PANE_OF_TAB = { paper: "view-manuscript", materials: "view-materials", outline: "view-outline" };

function syncTab() {
	for (const tab of $$(".paper-tabs .tab")) tab.classList.toggle("is-active", tab.dataset.tab === ctx.state.tab);
	const activePane = PANE_OF_TAB[ctx.state.tab] ?? "view-manuscript";
	for (const pane of $$(".paper-body .pane")) pane.classList.toggle("is-active", pane.id === activePane);
	$("#btn-focus").classList.toggle("is-on", Boolean(ctx.state.focus));
}

/* ---------------------------------------------------------------- 纸面 */

function fit() {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${Math.max(textarea.scrollHeight, 320)}px`;
}

/* 打字机模式：让正在写的那一行停在纸中间。文本框会长高，所以不能靠浏览器自己滚，
   得拿一个同样宽度、同样字体的隐身盒子量出光标落在第几行，再滚到那个位置。 */
let mirror = null;
let caretFrame = 0;

function caretOffset() {
	if (!textarea) return 0;
	const style = getComputedStyle(textarea);
	if (!mirror) {
		mirror = document.createElement("div");
		mirror.setAttribute("aria-hidden", "true");
		document.body.append(mirror);
	}
	mirror.style.cssText = [
		"position:absolute",
		"top:-9999px",
		"left:-9999px",
		"visibility:hidden",
		"pointer-events:none",
		"white-space:pre-wrap",
		"overflow-wrap:break-word",
		"word-break:break-word",
		"box-sizing:border-box",
		`width:${textarea.clientWidth}px`,
		`font:${style.font}`,
		`letter-spacing:${style.letterSpacing}`,
		`line-height:${style.lineHeight}`,
		`padding:${style.padding}`,
	].join(";");
	mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
	const marker = document.createElement("span");
	marker.textContent = "\u200b";
	mirror.append(marker);
	return marker.offsetTop;
}

function keepCaretCentered() {
	if (!textarea || ctx.state.prefs?.typewriter !== true) return;
	const scroller = $("#ms-scroll");
	if (!scroller) return;
	cancelAnimationFrame(caretFrame);
	caretFrame = requestAnimationFrame(() => {
		const line = caretOffset();
		const box = textarea.getBoundingClientRect();
		const view = scroller.getBoundingClientRect();
		const top = box.top - view.top + scroller.scrollTop + line;
		scroller.scrollTop = Math.max(0, top - scroller.clientHeight * 0.42);
	});
}

let renderToken = 0;

function renderPage() {
	const draft = ctx.state.draft;
	const project = ctx.state.project;
	const empty = $("#ms-empty");
	const placeholder = $("#ms-placeholder");
	const line = document.querySelector(".ms-chapter-line");
	const meta = $("#ms-meta");
	const foot = $("#ms-foot");
	const token = ++renderToken;

	if (!project) {
		if (empty) empty.hidden = true;
		line.hidden = true;
		meta.replaceChildren();
		foot.replaceChildren();
		return;
	}
	if (!draft) {
		if (line) line.hidden = true;
		meta.replaceChildren();
		foot.replaceChildren();
		placeholder.hidden = true;
		if (empty) {
			empty.hidden = false;
			empty.replaceChildren(
				el("div", { class: "empty-seal" }, icon("quill")),
				el("p", { class: "empty-title", text: "这一部还没有章" }),
				el("p", { class: "empty-note", text: "先把章目列出来——哪怕只有一句话的纲。" }),
				el("button", {
					class: "btn btn-ink",
					type: "button",
					text: "添第一章",
					on: {
						click: async () => {
							const mod = await import("./studio.js");
							void mod.openNewChapter();
						},
					},
				}),
			);
		}
		return;
	}

	if (empty) empty.hidden = true;
	if (line) line.hidden = false;
	const item = ctx.outlineItem(draft.id) || {};
	const index = ctx.chapterIndex(draft.id);
	$("#ms-ordinal").textContent = index >= 0 ? `第 ${index + 1} 章` : "";
	if (titleInput && document.activeElement !== titleInput) titleInput.value = draft.title || "";
	// 换章一定要换纸；只有在同一章里、且人还在这个框里按住笔时才让着他。
	const swapped = textarea?.dataset.chapter !== draft.id;
	if (textarea && (swapped || document.activeElement !== textarea)) {
		textarea.dataset.chapter = draft.id;
		rendering = true;
		textarea.value = draft.content || "";
		rendering = false;
		fit();
	}

	const hasText = Boolean((draft.content || "").trim());
	if (placeholder) {
		placeholder.hidden = hasText;
		placeholder.replaceChildren(
			el("p", { class: "ms-placeholder-eyebrow", text: "这一章还没有正文" }),
			item.summary ? el("p", { class: "ms-placeholder-summary", text: item.summary }) : el("p", { class: "ms-placeholder-summary", text: "还没有算得上「纲」的东西。可以先写一句，也可以让执笔者起个头。" }),
			el(
				"div",
				{ class: "ms-placeholder-actions" },
				actionButton("让执笔者起稿", "quill", () => void runWrite("create")),
				el("button", { class: "btn btn-ghost", type: "button", text: "我自己写", on: { click: () => textarea?.focus() } }),
			),
		);
	}
	meta && renderMeta();
	foot && renderFoot(item);
	// 刚切过来时把光标放到纸上，但别抢正在输入的人。
	if (token === renderToken && hasText && document.activeElement === document.body) {
		requestAnimationFrame(() => {
			if (document.activeElement === document.body) textarea?.focus();
		});
	}
}

function renderMeta() {
	const meta = $("#ms-meta");
	if (!meta || !ctx.state.draft) return;
	const draft = ctx.state.draft;
	const words = countWords(draft.content || "");
	meta.replaceChildren(
		...pack(
			el("span", { class: "ms-meta-words", text: `${num(words)} 字` }),
			el("span", { class: "ms-meta-sep", text: "·" }),
			el("span", { class: "ms-meta-rev", text: draft.exists ? `第 ${draft.revision || 1} 稿` : "未存过" }),
			draft.materialIds?.length ? el("span", { class: "ms-meta-mat", text: `· 挂了 ${draft.materialIds.length} 条料` }) : null,
			draft.updatedAt ? el("span", { class: "ms-meta-when", text: `· ${new Date(draft.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` }) : null,
		),
	);
}

function renderFoot(item) {
	const foot = $("#ms-foot");
	if (!foot) return;
	foot.replaceChildren();
	const next = nextChapter();
	const pieces = [
		el("span", { class: "foot-hint", text: "⌘S 存稿 · ⌘P 专注 · Alt+↑↓ 换个章" }),
	];
	if (next) {
		pieces.push(
			el("button", {
				class: "foot-next",
				type: "button",
				text: `下一章：${next.title}`,
				on: { click: () => void ctx.openChapter(next.id) },
			}),
		);
	}
	foot.append(...pieces);
}

function nextChapter() {
	const list = ctx.state.outline || [];
	const index = ctx.chapterIndex(ctx.state.activeId);
	return index >= 0 && index + 1 < list.length ? list[index + 1] : null;
}

function insertText(text) {
	if (!textarea) return;
	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	textarea.setRangeText(text, start, end, "end");
	ctx.markDirty(textarea.value);
	renderMeta();
	fit();
}

/* ---------------------------------------------------------------- 动作条 */

function actionButton(label, iconName, onClick, { kind = "ghost", title = "" } = {}) {
	return el(
		"button",
		{ class: `btn btn-${kind} btn-sm`, type: "button", title: title || label, on: { click: onClick } },
		iconName ? icon(iconName) : null,
		label,
	);
}

function renderActions() {
	const box = $("#paper-actions");
	if (!box) return;
	box.replaceChildren();
	if (!ctx.state.project) return;
	const tab = ctx.state.tab;
	if (tab === "materials") {
		void import("./materials.js").then((mod) => {
			box.replaceChildren(
				actionButton("新素材", "plus", () => void mod.openMaterialEditor({ scope: "project" })),
				actionButton("从库里取", "folder", () => void mod.openLibraryPicker()),
				actionButton("导个文件", "upload", () => mod.pickFile()),
			);
		});
		return;
	}
	if (tab === "outline") {
		void import("./outline.js").then((mod) => {
			box.replaceChildren(
				actionButton("添章", "plus", () => void mod.openNewChapterFromOutline()),
				actionButton("加一卷", "layers", () => void mod.openVolumeEditor()),
			);
		});
		return;
	}

	const draft = ctx.state.draft;
	const hasText = Boolean((draft?.content || "").trim());
	const selection = selectedText();
	const busy = Boolean(ctx.state.run);

	if (hasText) {
		box.append(actionButton(busy ? "在写…" : "续写", "quill", () => void runWrite("continue"), { kind: "seal" }));
		box.append(actionButton(selection ? "润色这段" : "润色", "wand", () => void openPolish()));
		box.append(actionButton("重写", "refresh", () => void confirmWrite("rewrite")));
	} else {
		box.append(actionButton(busy ? "在写…" : "起稿", "quill", () => void runWrite("create"), { kind: "seal" }));
	}
	box.append(
		el("div", { class: "actions-more" },
			el("button", {
				class: "btn btn-quiet btn-icon",
				type: "button",
				title: "更多",
				on: {
					click: (event) => paperMenu(event.currentTarget),
				},
			}, icon("more")),
		),
	);
}

function selectedText() {
	if (!textarea) return null;
	const start = textarea.selectionStart ?? 0;
	const end = textarea.selectionEnd ?? 0;
	if (end - start < 2) return null;
	return { start, end, text: textarea.value.slice(start, end) };
}

function paperMenu(anchor) {
	document.querySelector(".row-menu")?.remove();
	const menu = el("div", { class: "row-menu" });
	const add = (label, iconName, onClick, danger) =>
		menu.append(
			el("button", {
				class: `pc-menu-item${danger ? " is-danger" : ""}`,
				type: "button",
				on: {
					click: (event) => {
						event.stopPropagation();
						menu.remove();
						onClick();
					},
				},
			}, icon(iconName), label),
		);
	add("存稿", "save", () => void ctx.saveDraft({ force: true }).then(() => toast("存好了。", "ok")));
	add("导出这一章", "download", () => void exportCurrent());
	add("看版本与记录", "history", async () => {
		const mod = await import("./studio.js");
		void mod.openHistory();
	});
	add("让执笔者改这一段", "wand", () => void confirmWrite("patch"));
	const rect = anchor.getBoundingClientRect();
	menu.style.top = `${rect.bottom + 6}px`;
	menu.style.left = `${Math.max(12, rect.right - 196)}px`;
	document.body.append(menu);
	const off = (event) => {
		if (!menu.contains(event.target)) {
			menu.remove();
			window.removeEventListener("pointerdown", off, true);
		}
	};
	setTimeout(() => window.addEventListener("pointerdown", off, true), 0);
}

async function exportCurrent() {
	const draft = ctx.state.draft;
	if (!draft) return;
	const { saveFile } = await import("./share.js");
	const title = ctx.outlineItem(draft.id)?.title || draft.title || "这一章";
	await saveFile({
		name: `${ctx.state.project?.title || "书稿"} · ${title}.md`,
		url: api.exportUrl(ctx.state.project.id, draft.id, "md"),
	});
}

/* ---------------------------------------------------------------- 写作 */

function ensureTextareaVisible() {
	if (ctx.state.tab !== "paper") setTab("paper");
}

async function confirmWrite(mode) {
	const draft = ctx.state.draft;
	if (!draft) return;
	const labels = { rewrite: "整章重写", patch: "按你说的改", continue: "接着写下去" };
	const noteInput = el("textarea", { class: "set-area", rows: 3, placeholder: mode === "patch" ? "要改哪儿、改成什么样" : "这一章想往哪儿走（可留空）" });
	let picked = "";
	if (mode === "patch") {
		const sel = selectedText();
		if (sel) {
			picked = sel.text;
			noteInput.value = "把选中的这段改得更紧凑。";
		}
	}
	const body = el(
		"div",
		{ class: "form-grid" },
		picked ? el("div", { class: "field field-wide" }, el("span", { class: "field-label", text: "选中的一段" }), el("div", { class: "hist-preview", text: excerpt(picked, 240) })) : null,
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: mode === "patch" ? "改成什么样" : "交代" }), noteInput),
		el("p", { class: "set-note field-wide", text: "会先存一下现在的稿，再让执笔者动笔。" }),
	);
	const { close } = openModal({
		eyebrow: "执笔者",
		title: labels[mode] || "动笔",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "动笔",
				kind: "primary",
				icon: "quill",
				onClick: () => {
					close();
					void runWrite(mode, noteInput.value.trim());
				},
			},
		],
	});
	noteInput.focus();
}

/* 手上没有一个模型时，别让服务端回一句「请指定模型」了事——把人带去设置。 */
function requireModel() {
	if (ctx.aimModel()) return true;
	toast("还没有能用的模型。先去设置里接一个，执笔者才动得了笔。");
	$("#btn-settings")?.click();
	return false;
}

async function runWrite(mode, note = "") {
	if (!ctx.state.project || !ctx.state.draft) return;
	if (!requireModel()) return;
	if (!ctx.canRun()) {
		toast("还有一轮在跑，等它落笔。");
		return;
	}
	ensureTextareaVisible();
	await ctx.flushSave().catch(() => {});
	const pid = ctx.state.project.id;
	const cid = ctx.state.draft.id;
	const requestId = `w_${cid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

	const block = el("div", { class: "write-run" });
	const head = el("div", { class: "write-head" });
	const status = el("span", { class: "write-status", text: "执笔者正在起笔…" });
	const stop = el("button", { class: "btn btn-quiet btn-sm", type: "button" }, icon("stop"), "停");
	head.append(status, stop);
	const body = el("div", { class: "write-body" });
	const tools = el("div", { class: "write-tools" });
	block.append(head, tools, body);
	$("#ms-page").append(block);
	requestAnimationFrame(() => block.classList.add("is-on"));

	let acc = "";
	let saved = false;
	let savedRevision = 0;
	writeAbort = new AbortController();
	stop.addEventListener("click", () => {
		writeAbort?.abort();
		status.textContent = "停下了。";
	});
	ctx.beginRun({ kind: "write", label: `执笔者在写 · ${ctx.outlineItem(cid)?.title || "这一章"}`, abort: () => writeAbort?.abort() });

	const cleanup = () => {
		ctx.endRun();
		writeAbort = null;
		block.classList.remove("is-on");
		setTimeout(() => block.remove(), 320);
	};

	try {
		await api.writeChapter(
			pid,
			cid,
			{ mode, note: note || undefined, requestId },
			{
				signal: writeAbort.signal,
				onEvent(event) {
					if (event.type === "run_start") {
						status.textContent = `执笔者上手（${event.model}）`;
						return;
					}
					if (event.type === "thinking") {
						status.textContent = "在琢磨…";
						return;
					}
					if (event.type === "text" && event.delta) {
						status.textContent = "在写";
						acc += event.delta;
						body.replaceChildren(el("div", { class: "write-text" }, renderMarkdown(acc)));
						body.scrollTop = body.scrollHeight;
						return;
					}
					if (event.type === "tool_start" || event.type === "tool_call") {
						const name = event.name || "";
						const line = el("div", { class: "write-tool is-running" }, icon("spark"), `${toolLabel(name)}…`);
						tools.append(line);
						return;
					}
					if (event.type === "tool_end") {
						const last = tools.lastElementChild;
						if (last) {
							last.classList.remove("is-running");
							last.classList.toggle("is-error", Boolean(event.isError));
							last.append(el("span", { class: "write-tool-time", text: `${Math.round((event.durationMs || 0) / 100) / 10}s` }));
						}
						if (!event.isError && /chapter/.test(event.name || "")) saved = true;
						return;
					}
					if (event.type === "error") {
						status.textContent = event.message || "出错了。";
						block.classList.add("is-error");
						return;
					}
					if (event.type === "run_end") {
						saved = event.saved !== false;
						savedRevision = event.savedRevision || 0;
						status.textContent = event.aborted
							? "停在这儿，已存下前文。"
							: saved
								? `落笔了 · 第 ${savedRevision || "?"} 稿`
								: "这一轮没落进正文。";
					}
				},
			},
		);
	} catch (error) {
		if (error?.name === "AbortError") status.textContent = "停下了。";
		else {
			status.textContent = error?.message || "没写成。";
			block.classList.add("is-error");
			toast(error?.message || "这一轮没写成。", "error");
		}
	} finally {
		cleanup();
		if (saved || savedRevision) {
			await ctx.loadDraft(cid, { silent: true });
			await ctx.reloadProjectStructure().catch(() => {});
			ctx.notify("draft");
			toast("正文更新了。", "ok");
		}
	}
}

function toolLabel(name) {
	const map = {
		read_chapter: "读这一章",
		write_chapter: "写整章",
		append_chapter: "续上一段",
		revise_chapter: "改一段",
		get_outline: "翻大纲",
		list_materials: "看料",
		upsert_material: "记一条料",
		attach_materials: "挂料",
		read_previous_chapter: "读上一章",
		ask: "问你一句",
	};
	return map[name] || name || "动手";
}

/* ---------------------------------------------------------------- 润色 */

async function openPolish() {
	const draft = ctx.state.draft;
	if (!draft) return;
	const sel = selectedText();
	if (!sel) {
		toast("先在正文里选一段；只想改开头，可以选前几句。");
		textarea?.focus();
		return;
	}
	if (!ctx.canRun()) {
		toast("还有一轮在跑，等它收笔。");
		return;
	}
	if (!requireModel()) return;
	const instruction = el("input", { class: "set-input", type: "text", placeholder: "更紧一点 / 白描 / 别用形容词 / 保留节奏…" });
	const keep = el("input", { class: "set-input", type: "text", placeholder: "必须保留的东西（人名、物件、口头禅）" });
	const out = el("div", { class: "polish-out" }, el("p", { class: "set-note", text: "还没开始。" }));
	const checks = el("div", { class: "polish-checks" });
	const actions = el("div", { class: "modal-foot-actions" });
	const body = el(
		"div",
		{ class: "polish-body" },
		el("div", { class: "form-grid" },
			el("label", { class: "field" }, el("span", { class: "field-label", text: "往哪儿改" }), instruction),
			el("label", { class: "field" }, el("span", { class: "field-label", text: "别动的东西" }), keep),
		),
		el("div", { class: "field field-wide" }, el("span", { class: "field-label", text: "原文" }), el("div", { class: "polish-src", text: excerpt(sel.text, 400) })),
		el("div", { class: "field field-wide" }, el("span", { class: "field-label", text: "改后" }), out),
		checks,
		actions,
	);
	const modal = openModal({
		eyebrow: `${selectedRangeLabel(sel)} · 润色`,
		title: "只改这一段",
		body,
		wide: true,
		actions: [{ label: "收起", onClick: () => modal.close() }],
	});
	modal.element?.classList.add("is-polish");
	let acc = "";
	let latest = null;
	let revision = draft.revision || 0;
	let busy = false;

	const run = async () => {
		if (busy) return;
		busy = true;
		acc = "";
		latest = null;
		out.replaceChildren(el("p", { class: "sk-line", text: "正在改…" }));
		checks.replaceChildren();
		actions.replaceChildren(el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "再改一遍", disabled: "" }));
		ctx.beginRun({ kind: "polish", label: "在改这一段", abort: () => {} });
		try {
			await api.polishChapter(
				ctx.state.project.id,
				draft.id,
				{
					start: sel.start,
					end: sel.end,
					text: sel.text,
					instruction: instruction.value.trim() || undefined,
					keep: keep.value.trim() || undefined,
					revision,
				},
				{
					onEvent(event) {
						if (event.type === "text" && event.delta) {
							acc += event.delta;
							out.replaceChildren(el("div", { class: "polish-text" }, acc));
							return;
						}
						if (event.type === "retry") {
							out.append(el("p", { class: "set-note", text: `没过校验，再试一次（${event.reason || "不合规"}）` }));
							return;
						}
						if (event.type === "checks") {
							renderChecks(checks, event.checks);
							return;
						}
						if (event.type === "done") {
							latest = event;
							renderChecks(checks, event.checks);
							actions.replaceChildren(
								el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "再改一遍", on: { click: () => void run() } }),
								el("button", { class: "btn btn-ink btn-sm", type: "button", text: "采用这一段", on: { click: () => void apply() } }),
							);
							if (event.hard) out.append(el("p", { class: "set-note is-warn", text: "还有一条硬伤没过，采用前自己看一眼。" }));
							return;
						}
						if (event.type === "error") {
							out.replaceChildren(el("p", { class: "set-note is-warn", text: event.message || "没改成。" }));
						}
					},
				},
			);
		} catch (error) {
			out.replaceChildren(el("p", { class: "set-note is-warn", text: error?.message || "没改成。" }));
		} finally {
			busy = false;
			ctx.endRun();
		}
	};

	const apply = async () => {
		if (!latest) return;
		try {
			await api.applyPolish(ctx.state.project.id, draft.id, {
				start: sel.start,
				end: sel.end,
				expectedText: sel.text,
				expectedRevision: revision,
				replacement: latest.text || acc,
			});
			modal.close();
			await ctx.loadDraft(draft.id);
			await ctx.reloadProjectStructure().catch(() => {});
			toast("换上了。", "ok");
		} catch (error) {
			if (error?.payload?.code === "stale") toast("正文已经变了，重新选一次再改。", "error");
			else toast(error?.message || "没换上。", "error");
		}
	};

	void run();
}

function selectedRangeLabel(sel) {
	return `第 ${sel.start}–${sel.end} 字`;
}

function renderChecks(host, list) {
	if (!Array.isArray(list) || !list.length) {
		host.replaceChildren();
		return;
	}
	host.replaceChildren();
	const box = el("div", { class: "check-list" });
	for (const check of list) {
		const ok = check.ok !== false && !check.hard;
		box.append(
			el(
				"div",
				{ class: `check-row${ok ? "" : " is-warn"}` },
				icon(ok ? "check" : "alert"),
				el("span", { class: "check-label", text: check.label || check.name || "查过" }),
				check.note ? el("span", { class: "check-note", text: check.note }) : null,
			),
		);
	}
	host.append(box);
}

export { setTab as switchTab };
