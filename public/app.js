/**
 * 入口。先把身份与数据要到手，再把各个视图接上，最后才允许用户看见界面。
 *
 * 界面骨架在 index.html 里，这里只做三件事：起手、接线、兜底。
 */

import { ensureAuth } from "./auth-gate.js";
import { bindAccount } from "./account.js";
import { initUpdatePanel } from "./update.js";
import * as api from "./app/api.js";
import { $, $$, el, icon, toast, modKey, onOutsideClick } from "./app/core.js";
import * as ctx from "./app/ctx.js";
import { initDesk } from "./app/desk.js";
import { initStudio, closeDrawer, closeRail } from "./app/studio.js";
import { initPaper } from "./app/paper.js";
import { initMaterials } from "./app/materials.js";
import { initOutline } from "./app/outline.js";
import { initDock } from "./app/dock.js";
import { initAdapt } from "./app/adapt.js";
import { initSettings, refreshSettings, applyReadPrefs } from "./app/settings-view.js";
import { initPalette, openPalette, closePalette } from "./app/palette.js";
import { initReader, handleReaderKey, isReaderOpen, openActiveReader } from "./app/reader.js";

const THEME_KEY = "novel-studio-theme";

function setTheme(theme) {
	const next = theme === "dark" ? "dark" : "light";
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem(THEME_KEY, next);
	} catch {
		/* 存储不可用时只是这台机器记不住 */
	}
	const meta = document.querySelector('meta[name="theme-color"]:not([media])');
	if (meta) meta.setAttribute("content", next === "dark" ? "#17150f" : "#efe8d9");
	renderThemeGlyph();
}

function currentTheme() {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function renderThemeGlyph() {
	const btn = $("#btn-theme");
	if (!btn) return;
	const dark = currentTheme() === "dark";
	btn.replaceChildren(icon(dark ? "sun" : "moon"));
	btn.title = dark ? "切成纸白 (T)" : "切成灯下 (T)";
}

/* ---------------------------------------------------------------- 顶栏 */

function renderCrumb() {
	const book = $("#crumb-book");
	const chapter = $("#crumb-chapter");
	const tag = $("#crumb-tag");
	const back = $("#btn-back");
	const project = ctx.state.project;
	if (!project) {
		book.textContent = "案头";
		chapter.textContent = "";
		chapter.hidden = true;
		tag.hidden = true;
		back.hidden = true;
		const sep = $("#crumb .crumb-sep");
		if (sep) sep.hidden = true;
		document.title = "墨耕 · 长篇小说创作台";
		return;
	}
	back.hidden = false;
	book.textContent = project.title || "未命名";
	book.title = project.title || "";
	const item = ctx.outlineItem(ctx.state.activeId);
	if (ctx.state.view === "studio" && item) {
		chapter.hidden = false;
		chapter.textContent = item.title || "（未命名章）";
	} else {
		chapter.hidden = true;
	}
	const sep = $("#crumb .crumb-sep");
	if (sep) sep.hidden = chapter.hidden;
	tag.hidden = ctx.state.view !== "adapt";
	document.title = `${project.title || "未命名"} · 墨耕`;
}

function renderWordBadge() {
	const badge = $("#word-badge");
	if (!badge) return;
	const stats = ctx.state.stats;
	if (!stats) {
		badge.hidden = true;
		return;
	}
	badge.hidden = false;
	const done = stats.draftedChapters || 0;
	badge.replaceChildren(
		el("span", { class: "word-total", text: `${Number(stats.words || 0).toLocaleString("zh-CN")} 字` }),
		el("span", { class: "word-sep", text: "·" }),
		el("span", { class: "word-chapters", text: `${done}/${stats.chapters || 0} 章` }),
	);
}

function renderSaveState() {
	const node = $("#save-state");
	if (!node) return;
	const saving = ctx.state.saving;
	node.className = "save-state";
	if (!ctx.state.project) {
		node.textContent = "";
		return;
	}
	if (saving === "dirty") {
		node.classList.add("is-dirty");
		node.textContent = "未存";
	} else if (saving === "saving") {
		node.classList.add("is-saving");
		node.textContent = "存稿中";
	} else if (saving === "error") {
		node.classList.add("is-dirty");
		node.textContent = "存稿失败";
	} else {
		node.classList.add("is-saved");
		node.textContent = "已存";
	}
}

const RUN_LABEL = {
	write: "执笔者在写",
	session: "副驾在想",
	polish: "在改这一段",
	adapt: "改编者在写",
};

function renderRunPill() {
	const pill = $("#run-pill");
	const text = $("#run-pill-text");
	if (!pill || !text) return;
	const run = ctx.state.run;
	if (!run) {
		pill.hidden = true;
		document.body.classList.remove("is-running");
		return;
	}
	pill.hidden = false;
	document.body.classList.add("is-running");
	text.textContent = run.label || RUN_LABEL[run.kind] || "在写";
	pill.dataset.kind = run.kind || "";
}

function applyViewChrome() {
	const app = $("#app");
	if (!app) return;
	const view = ctx.state.view;
	const adapted = Boolean(ctx.state.project?.adaptation);
	app.dataset.view = view;
	for (const node of $$(".view")) {
		node.classList.toggle("is-active", node.id === `view-${view}`);
	}
	// 改编台是改编工程才有的房间：别让普通工程看见一扇打不开的门。
	for (const btn of $$('[data-nav="adapt"]')) btn.hidden = !adapted;
	const tab = ctx.state.tab;
	for (const btn of $$(".spine-btn")) {
		const nav = btn.dataset.nav;
		const on =
			view === "adapt" ? nav === "adapt" : view === "studio" ? nav === tab : view === "desk" ? nav === "desk" : false;
		btn.classList.toggle("is-active", on);
	}
	for (const btn of $$(".mnav")) {
		const nav = btn.dataset.nav;
		const dockOn = nav === "dock" && app.classList.contains("dock-open") && window.matchMedia("(max-width: 1160px)").matches;
		const on =
			dockOn ||
			(view === "adapt" ? nav === "adapt" : view === "studio" ? nav === tab : view === "desk" ? nav === "desk" : false);
		btn.classList.toggle("is-active", on);
	}
	$("#spine-title").hidden = !ctx.state.project;
	$("#spine-title").textContent = ctx.state.project?.title || "";
	renderCrumb();
	renderWordBadge();
}

/* ---------------------------------------------------------------- 全局事件 */

function bindTopbar() {
	$("#btn-back")?.addEventListener("click", async () => {
		await ctx.flushSave();
		ctx.leaveProject();
		await ctx.refreshProjects().catch(() => {});
		ctx.setView("desk");
	});

	$("#btn-theme")?.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
	$("#btn-settings")?.addEventListener("click", () => {
		const dialog = $("#settings");
		if (!dialog || dialog.open) return;
		dialog.showModal();
		refreshSettings();
	});
	$("#btn-palette")?.addEventListener("click", () => openPalette());
	$("#spine-brand")?.addEventListener("click", async () => {
		if (ctx.state.view === "desk") return;
		await ctx.flushSave();
		ctx.setView("desk");
	});
	$("#run-pill-stop")?.addEventListener("click", async () => {
		const run = ctx.state.run;
		if (!run) return;
		if (typeof run.abort === "function") run.abort();
		else if (run.id) {
			try {
				await api.abortRun(run.id);
			} catch (error) {
				toast(error.message || "叫不停这一轮。", "error");
			}
		}
	});

	// 遮罩只有一层：把开着的浮层都收掉，别让人对着一片灰发呆。
	$("#scrim")?.addEventListener("click", async () => {
		const app = $("#app");
		if (app.classList.contains("rail-open")) closeRail();
		if (!$("#drawer")?.hidden) closeDrawer();
		// 宽屏上副驾是一列常驻的，不归遮罩管；窄屏才是抽屉。
		if (app.classList.contains("dock-open") && window.matchMedia("(max-width: 1160px)").matches) {
			const { closeDock } = await import("./app/dock.js");
			closeDock();
		}
	});
}

function bindSpine() {
	const goes = async (nav) => {
		// 窄屏上副驾是一张抽屉：换房间之前先把它收回去，别让它压在新页上。
		const drawerWide = window.matchMedia("(max-width: 1160px)").matches;
		const dockOpen = $("#app")?.classList.contains("dock-open");
		if (drawerWide && dockOpen && nav !== "dock") {
			void import("./app/dock.js").then((mod) => mod.closeDock());
		}
		if (nav === "desk") {
			await ctx.flushSave();
			ctx.setView("desk");
			return;
		}
		if (nav === "library" || nav === "sources") {
			await ctx.flushSave();
			ctx.setView("desk");
			requestAnimationFrame(() => {
				document.getElementById(nav === "library" ? "library-block" : "source-block")?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
			return;
		}
		if (!ctx.state.project) {
			toast("先立一本新书，或者翻一本样书。");
			ctx.setView("desk");
			return;
		}
		if (nav === "adapt") {
			await ctx.flushSave();
			if (!ctx.state.project.adaptation) {
				toast("这一本不是改编工程。去书库挑一本原书，立一部改编工程。", "info");
				return;
			}
			ctx.setView("adapt");
			return;
		}
		ctx.setView("studio");
		if (nav === "dock") {
			// 窄屏是带遮罩的抽屉、宽屏是让出一列，交给副驾自己处理；再点一下就收。
			if (drawerWide && dockOpen) {
				void import("./app/dock.js").then((mod) => mod.closeDock());
				return;
			}
			void import("./app/dock.js").then((mod) => mod.openDock());
			return;
		}
		if (["paper", "materials", "outline"].includes(nav)) {
			ctx.state.tab = nav;
			ctx.notify("tab");
			ctx.notify("view");
		}
	};
	for (const btn of $$(".spine-btn")) {
		btn.addEventListener("click", () => void goes(btn.dataset.nav));
	}
	for (const btn of $$(".mnav")) {
		btn.addEventListener("click", () => void goes(btn.dataset.nav));
	}
	$("#spine-title")?.addEventListener("click", () => void goes("desk"));
}

function bindKeys() {
	document.addEventListener("keydown", (event) => {
		const mod = event.metaKey || event.ctrlKey;
		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
		const paletteOpen = !$("#palette")?.hidden;
		const drawerOpen = !$("#drawer")?.hidden;

		// 读稿台是整屏的：散键、翻章都先交给它，Esc 也只收它这一层。
		if (isReaderOpen() && handleReaderKey(event)) return;

		if (event.key === "Escape") {
			// 原生对话框（模态框、设置）自己会关，别在这里抢。
			if (document.querySelector("dialog[open]")) return;
			if (paletteOpen) {
				closePalette();
				event.preventDefault();
				return;
			}
			if (drawerOpen) {
				closeDrawer();
				event.preventDefault();
				return;
			}
			if (ctx.state.focus) {
				ctx.state.focus = false;
				$("#app").classList.remove("is-focus");
				ctx.notify("focus");
				event.preventDefault();
			}
			const app = $("#app");
			if (app.classList.contains("dock-open") && window.matchMedia("(max-width: 1160px)").matches) {
				void import("./app/dock.js").then((mod) => mod.closeDock());
				event.preventDefault();
			}
			if (app.classList.contains("rail-open")) {
				closeRail();
				event.preventDefault();
			}
			return;
		}

		if (mod && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openPalette();
			return;
		}
		if (mod && event.key.toLowerCase() === "s") {
			event.preventDefault();
			if (ctx.state.draft) {
				void ctx.saveDraft({ force: true }).then(() => toast("存好了。", "ok"));
			}
			return;
		}
		if (mod && event.key.toLowerCase() === "p") {
			event.preventDefault();
			ctx.state.focus = !ctx.state.focus;
			$("#app").classList.toggle("is-focus", ctx.state.focus);
			ctx.notify("focus");
			return;
		}
		if (mod && event.key === "Enter") return;

		if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			const list = ctx.state.outline;
			const index = list.findIndex((item) => item.id === ctx.state.activeId);
			const next = event.key === "ArrowUp" ? index - 1 : index + 1;
			if (next >= 0 && next < list.length) void ctx.openChapter(list[next].id);
			return;
		}

		if (!typing && !mod && !event.altKey) {
			if (event.key === "?") {
				event.preventDefault();
				openPalette("?");
				return;
			}
			if (event.key === "1" || event.key === "2" || event.key === "3") {
				if (ctx.state.view !== "studio") return;
				ctx.state.tab = ["paper", "materials", "outline"][Number(event.key) - 1];
				ctx.notify("tab");
				ctx.notify("view");
				return;
			}
			if (event.key.toLowerCase() === "t") {
				setTheme(currentTheme() === "dark" ? "light" : "dark");
				return;
			}
			if (event.key.toLowerCase() === "v") {
				if (!ctx.state.project) toast("先翻开一本书。");
				else void openActiveReader({ mode: "read" });
				return;
			}
			if (event.key.toLowerCase() === "f") {
				ctx.state.focus = !ctx.state.focus;
				$("#app").classList.toggle("is-focus", ctx.state.focus);
				ctx.notify("focus");
				return;
			}
			if (event.key.toLowerCase() === "j") {
				const list = ctx.state.outline;
				const index = list.findIndex((item) => item.id === ctx.state.activeId);
				if (index + 1 < list.length) void ctx.openChapter(list[index + 1].id);
				return;
			}
			if (event.key.toLowerCase() === "k" && ctx.state.view === "studio") {
				const list = ctx.state.outline;
				const index = list.findIndex((item) => item.id === ctx.state.activeId);
				if (index > 0) void ctx.openChapter(list[index - 1].id);
				return;
			}
		}
	});
}

async function checkStorage() {
	try {
		const data = await api.getStorage();
		if (data && data.ok === false) {
			ctx.state.storageIssue = data;
			const host = $("#desk-notice");
			if (host) {
				host.replaceChildren(
					el(
						"div",
						{ class: "notice is-warn" },
						icon("alert"),
						el("div", { class: "notice-text" }, el("strong", { text: "有稿子没落盘。" }), ` ${data.message || ""}`),
						el("button", {
							class: "btn btn-ghost btn-sm",
							type: "button",
							on: {
								click: async () => {
									try {
										await api.retryStorage();
										toast("重试了一次。", "ok");
										await checkStorage();
									} catch (error) {
										toast(error.message || "还是没落盘。", "error");
									}
								},
							},
							text: "再试一次",
						}),
					),
				);
			}
		}
	} catch {
		/* 老版本没有这个接口，静默 */
	}
}

function renderAll(scope) {
	switch (scope) {
		case "run":
			renderRunPill();
			return;
		case "save":
			renderSaveState();
			return;
		case "words":
			renderWordBadge();
			return;
		case "view":
		case "tab":
		case "project":
			applyViewChrome();
			return;
		case "stats":
			renderWordBadge();
			return;
		default:
			return;
	}
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
	const app = $("#app");
	let auth = null;
	try {
		auth = await ensureAuth();
	} catch (error) {
		console.error("[auth]", error);
	}
	ctx.state.auth = auth;
	ctx.loadPrefs();
	applyReadPrefs();
	bindAccount();
	initUpdatePanel();

	let booted = false;
	try {
		await ctx.bootstrapApp();
		booted = true;
	} catch (error) {
		console.error("[boot]", error);
		toast(error?.message || "没能连上本地服务。", "error", 9000);
		const host = $("#desk-notice");
		if (host) {
			host.replaceChildren(
				el(
					"div",
					{ class: "notice is-error" },
					icon("alert"),
					el("div", { class: "notice-text" }, el("strong", { text: "没能连上本地服务。" }), ` ${error?.message || ""} 确认服务在跑，然后刷新。`),
					el("button", {
						class: "btn btn-ghost btn-sm",
						type: "button",
						on: { click: () => location.reload() },
						text: "刷新",
					}),
				),
			);
		}
	}

	ctx.onChange(renderAll);
	initDesk();
	initStudio();
	initPaper();
	initMaterials();
	initOutline();
	initDock();
	initAdapt();
	initSettings();
	initPalette();
	initReader();
	bindTopbar();
	bindSpine();
	bindKeys();
	renderThemeGlyph();
	applyViewChrome();
	renderSaveState();
	renderRunPill();

	// 副驾开合是记住的：宽屏照旧开；一窄就把地方让出来。
	const wide = window.matchMedia("(min-width: 1161px)");
	const applyDockRoom = () => $("#app")?.classList.toggle("dock-open", wide.matches && ctx.state.prefs.dockOpen !== false);
	applyDockRoom();
	wide.addEventListener?.("change", (event) => {
		if (event.matches) applyDockRoom();
		else {
			$("#app")?.classList.remove("dock-open");
			const scrim = $("#scrim");
			if (scrim) {
				scrim.classList.remove("is-on");
				scrim.hidden = true;
			}
		}
	});

	if (booted) {
		const last = ctx.lastProjectId();
		// 「回到上次那本书」是可以在设置里关掉的；关了就直接停在案头。
		if (last && ctx.state.prefs.restoreLast !== false && ctx.projectById(last)) {
			try {
				await ctx.openProject(last, { silent: true });
			} catch (error) {
				console.error("[resume]", error);
			}
		} else {
			ctx.setView("desk");
		}
		void checkStorage();
		// 一台新机器上最先撞到的墙：一个模型都没有。先说明白，别等它起稿才报错。
		if (!ctx.state.models?.length) {
			setTimeout(() => toast("还没接模型。样书可以先翻；要让它动笔，先在设置里接一个。", "info", 7000), 900);
		}
	}

	// 正文还在定时器里没落盘就关窗，浏览器会等这个提示。
	window.addEventListener("beforeunload", (event) => {
		if (ctx.state.saving === "dirty" || ctx.state.saving === "saving") {
			event.preventDefault();
			event.returnValue = "";
		}
	});

	document.body.classList.add("is-ready");
	if (app) app.dataset.mounted = "1";
	const skeleton = $("#boot-skeleton");
	if (skeleton) {
		skeleton.style.opacity = "0";
		setTimeout(() => skeleton.remove(), 320);
	}
	renderCrumb();
	renderWordBadge();
}

void boot();
