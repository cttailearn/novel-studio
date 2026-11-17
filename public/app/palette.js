/**
 * 命令面板：不用记快捷键，敲两个字就到。
 *
 * ⌘K 打开，列出所有去处与动作；章多的书可以直接敲章名跳过去。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, modKey, openModal, toast } from "./core.js";

let mounted = false;
let items = [];
let cursor = 0;
let inputEl = null;
let listEl = null;
let hintEl = null;

export function initPalette() {
	if (mounted) return;
	mounted = true;
	inputEl = $("#palette-input");
	listEl = $("#palette-list");
	hintEl = $("#palette-hint");
	const root = $("#palette");
	root?.addEventListener("pointerdown", (event) => {
		if (event.target === root) closePalette();
	});
	inputEl?.addEventListener("input", () => render());
	inputEl?.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(items[cursor]);
		} else if (event.key === "Escape") {
			event.preventDefault();
			closePalette();
		}
	});
}

export function openPalette(seed = "") {
	if (seed === "?") {
		showHelp();
		return;
	}
	const root = $("#palette");
	if (!root) return;
	items = build();
	cursor = 0;
	root.hidden = false;
	if (inputEl) {
		inputEl.value = typeof seed === "string" ? seed : "";
	}
	render();
	setTimeout(() => inputEl?.focus(), 30);
}

export function closePalette() {
	const root = $("#palette");
	if (root) root.hidden = true;
}

/* ---------------------------------------------------------------- 条目 */

function build() {
	const list = [];
	const go = (label, hint, iconName, run, key = "") => list.push({ label, hint, iconName, run, key });

	go("回案头", "所有书摊开的地方", "grid", () => ctx.setView("desk"), "d");
	go("写这一章", "稿纸", "quill", () => ctx.setView("studio"));
	go("素材", "这本书的料", "layers", () => {
		ctx.setView("studio");
		ctx.notify("tab");
	});
	go("大纲", "章与卷的账本", "list", () => {
		ctx.setView("studio");
		ctx.notify("tab");
	});
	go("通用素材库", "跨书共用的料", "folder", () => ctx.setView("desk"));
	go("原料库", "原书与资料", "book-open", () => ctx.setView("desk"));
	go("副驾", "跟执笔者说一句", "spark", async () => {
		const { openDock } = await import("./dock.js");
		openDock();
	}, "p");

	if (ctx.state.project) {
		go("全屏读这一章", "整屏读稿，手机上也能读长文", "book-open", async () => {
			const mod = await import("./reader.js");
			void mod.openReader({ chapterId: ctx.state.activeId, mode: "read" });
		}, "v");
		go("全屏改这一章", "整屏编辑，改完自动存", "edit", async () => {
			const mod = await import("./reader.js");
			void mod.openReader({ chapterId: ctx.state.activeId, mode: "edit" });
		});
		if (ctx.state.project.adaptation) {
			go("对照原书读改编稿", "改过的句子垫底色", "eye", async () => {
				const mod = await import("./reader.js");
				void mod.openReader({ chapterId: ctx.state.activeId, mode: "read", compare: true });
			});
		}
		go("存稿", "现在这一章", "save", async () => {
			await ctx.flushSave(true);
			toast("存下了。", "ok");
		}, "s");
		go("看这一章的版本与记录", "谁在哪一轮改的", "history", async () => {
			const mod = await import("./studio.js");
			mod.openHistory?.();
		});
		go("导出这一章", "markdown", "download", async () => {
			const { saveFile } = await import("./share.js");
			const cid = ctx.state.activeId;
			if (!cid) return toast("先挑一章。", "error");
			const title = ctx.outlineItem(cid)?.title || "这一章";
			await saveFile({ name: `${ctx.state.project.title} · ${title}.md`, url: api.exportUrl(ctx.state.project.id, cid, "md") });
		});
		go(ctx.state.focus ? "退出专注" : "进了专注", "只留纸和光标", "focus", () => {
			ctx.state.focus = !ctx.state.focus;
			$("#app").classList.toggle("is-focus", ctx.state.focus);
			ctx.notify("focus");
		});
		go("添一章", "接在最后", "plus", async () => {
			const mod = await import("./studio.js");
			mod.openNewChapter?.({});
		});
		go("改编台", ctx.state.project.adaptation ? "这本书的改编" : "这部不是改编工程", "split", () => ctx.setView("adapt"));
	}

	go("立一本新书", "案头上多摆一本", "plus", async () => {
		ctx.setView("desk");
		const mod = await import("./desk.js");
		mod.openNewProject?.();
	});
	go("设置", "模型、偏好、数据", "sliders", () => document.getElementById("settings")?.showModal());
	go("换主题", "明 / 暗", "sun", () => {
		const dark = document.documentElement.dataset.theme === "dark";
		applyTheme(dark ? "light" : "dark");
	});
	go("快捷键", "这一套怎么使", "command", () => showHelp());

	for (const chapter of ctx.state.outline || []) {
		const index = ctx.chapterIndex(chapter.id);
		go(chapter.title || `第 ${index + 1} 章`, `${ctx.statusLabel(chapter.status)} · ${chapter.summary || "还没纲"}`, "file", () => {
			ctx.setView("studio");
			void ctx.openChapter(chapter.id);
		}, `第 ${index + 1} 章`);
	}

	return list;
}

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]:not([media])');
	if (meta) meta.setAttribute("content", theme === "dark" ? "#17150f" : "#efe8d9");
	try {
		localStorage.setItem("novel-studio-theme", theme);
	} catch {
		/* 存不了也照用 */
	}
	ctx.notify("view");
}

/* ---------------------------------------------------------------- 渲染 */

function render() {
	if (!listEl) return;
	const query = (inputEl?.value || "").trim().toLowerCase();
	const matched = query
		? items.filter((item) => `${item.label} ${item.hint} ${item.key}`.toLowerCase().includes(query))
		: items;
	const shown = matched.slice(0, 40);
	if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);
	listEl.replaceChildren();
	if (!shown.length) {
		listEl.append(el("p", { class: "pal-empty", text: "没有这一条。换个说法？" }));
	}
	for (const [index, item] of shown.entries()) {
		const row = el(
			"button",
			{
				class: `pal-item${index === cursor ? " is-active" : ""}`,
				type: "button",
				role: "option",
				id: `palette-option-${index}`,
				"aria-selected": index === cursor ? "true" : "false",
				on: {
					pointerenter: () => {
						cursor = index;
						paintCursor(shown);
					},
					click: () => run(item),
				},
			},
			el("span", { class: "pal-icon" }, icon(item.iconName || "chevron-right")),
			el("span", { class: "pal-main" }, el("span", { class: "pal-title", text: item.label }), el("span", { class: "pal-sub", text: item.hint || "" })),
			item.key ? el("kbd", { class: "kbd", text: item.key }) : null,
		);
		listEl.append(row);
	}
	if (hintEl) {
		hintEl.textContent = shown.length
			? `${shown.length} 条 · ↑↓ 选 · Enter 定 · Esc 收`
			: "换个说法试试";
	}
}

function paintCursor(shown) {
	const rows = [...listEl.querySelectorAll(".pal-item")];
	for (const [index, row] of rows.entries()) {
		row.classList.toggle("is-active", index === cursor);
		row.setAttribute("aria-selected", index === cursor ? "true" : "false");
	}
	const active = rows[cursor];
	if (active && inputEl) inputEl.setAttribute("aria-activedescendant", active.id || "");
	active?.scrollIntoView({ block: "nearest" });
	void shown;
}

function move(step) {
	const count = listEl?.children.length || 0;
	if (!count) return;
	cursor = (cursor + step + count) % count;
	paintCursor(items);
}

function run(item) {
	if (!item) return;
	closePalette();
	setTimeout(() => {
		try {
			const result = item.run();
			if (result && typeof result.catch === "function") result.catch((error) => toast(error.message || "没办成。", "error"));
		} catch (error) {
			toast(error.message || "没办成。", "error");
		}
	}, 10);
}

/* ---------------------------------------------------------------- 快捷键 */

export function showHelp() {
	const mod = modKey();
	const rows = [
		[`${mod} K`, "命令面板"],
		[`${mod} S`, "存稿"],
		[`${mod} P`, "专注模式"],
		["1 / 2 / 3", "稿纸 · 素材 · 大纲"],
		["Alt ↑ / Alt ↓", "上/下一章"],
		["j / k", "上/下一章"],
		["t", "换主题"],
		["f", "专注"],
		["?", "这张表"],
		["Esc", "收起当前面板"],
	];
	const grid = el("div", { class: "help-grid" });
	for (const [key, label] of rows) {
		grid.append(el("span", { class: "help-key" }, el("kbd", { class: "kbd", text: key })), el("span", { class: "help-what", text: label }));
	}
	const body = el(
		"div",
		null,
		grid,
		el(
			"p",
			{ class: "set-note" },
			"稿子每停 1 秒自动存一次；切章、关窗之前还会再存一次。执笔者写到一半，可以按顶栏那颗停止键叫停——已经写下的字会留下。",
		),
	);
	const { close } = openModal({
		eyebrow: "怎么使",
		title: "快捷键与手势",
		body,
		actions: [
			{ label: "知道了", kind: "primary", onClick: () => close() },
			{
				label: "看一遍全书骨架",
				onClick: () => {
					close();
					ctx.setView("studio");
					ctx.notify("tab");
				},
			},
		],
	});
}
