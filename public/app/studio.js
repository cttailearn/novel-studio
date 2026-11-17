/**
 * 章目栏：一条竖着的目录，和一颗圆形的进度。
 *
 * 这一栏只回答两个问题——还有哪几章没写、我上次停在哪。
 * 所以它按卷收拢、按写没写完筛、点子最多的那一行永远停在视线里。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, $$, el, icon, toast, openModal, confirmAction, wordLabel, num, excerpt } from "./core.js";

let mounted = false;
const RING = 116.24; // 2πr，r=18.5

export function initStudio() {
	if (mounted) return;
	mounted = true;

	$("#rail-search")?.addEventListener("input", (event) => {
		ctx.state.railQuery = event.target.value.trim();
		renderRail();
	});
	$("#btn-rail-filter")?.addEventListener("click", () => {
		const order = ["all", "todo", "drafted"];
		const next = order[(order.indexOf(ctx.state.railFilter) + 1) % order.length];
		ctx.state.railFilter = next;
		renderFilterButton();
		renderRail();
	});
	$("#btn-add-chapter")?.addEventListener("click", () => void openNewChapter());
	$("#btn-history")?.addEventListener("click", () => void openHistory());
	$("#drawer-close")?.addEventListener("click", () => closeDrawer());
	$("#btn-open-dock")?.addEventListener("click", () => toggleDock());
	$("#btn-open-rail")?.addEventListener("click", () => toggleRail());

	ctx.onChange((scope) => {
		if (scope === "project" || scope === "chapters" || scope === "active" || scope === "outline") renderRail();
		if (scope === "stats") renderHead();
	});
	renderFilterButton();
}

function openDock() {
	ctx.state.prefs.dockOpen = true;
	ctx.savePrefs({ dockOpen: true });
	// 交给副驾自己开：宽屏是让出右边一列，窄屏是一张带遮罩的抽屉。
	void import("./dock.js").then((mod) => mod.openDock());
}

/* 章目底下那颗「副驾」：开着就收起来，收着就拉开。宽屏才有「收起来」这回事。 */
function toggleDock() {
	const wide = window.matchMedia("(min-width: 1161px)").matches;
	if (wide && $("#app")?.classList.contains("dock-open")) {
		void import("./dock.js").then((mod) => mod.closeDock());
		return;
	}
	openDock();
}

/* 窄屏上章目是一张抽屉：点一下拉开，选完章就自己收回去。 */
export function toggleRail(force) {
	const app = $("#app");
	const rail = $("#rail");
	const scrim = $("#scrim");
	if (!app || !rail) return;
	const next = typeof force === "boolean" ? force : !app.classList.contains("rail-open");
	app.classList.toggle("rail-open", next);
	rail.classList.toggle("is-open", next);
	if (scrim) {
		scrim.hidden = !next;
		if (next) requestAnimationFrame(() => scrim.classList.add("is-on"));
		else scrim.classList.remove("is-on");
	}
}

export function closeRail() {
	toggleRail(false);
}

function renderFilterButton() {
	const btn = $("#btn-rail-filter");
	if (!btn) return;
	const labels = { all: "全部章", todo: "未成稿", drafted: "已成稿" };
	btn.title = `只看：${labels[ctx.state.railFilter] || "全部章"}`;
	btn.classList.toggle("is-on", ctx.state.railFilter !== "all");
	btn.dataset.filter = ctx.state.railFilter;
}

function renderHead() {
	const stats = ctx.state.stats;
	const total = Number(stats?.words || 0);
	const chapters = Number(stats?.chapters || 0);
	const drafted = Number(stats?.draftedChapters || 0);
	const stat = $("#rail-stat");
	if (stat) stat.textContent = `${wordLabel(total)} · ${drafted}/${chapters} 章`;
	const pctNode = $("#ring-pct");
	const value = $("#ring-value");
	const target = Number(ctx.state.project?.targetWords || 0);
	let ratio = 0;
	if (target > 0) ratio = Math.min(1, total / target);
	else ratio = chapters > 0 ? drafted / chapters : 0;
	if (value) {
		const visual = ratio > 0 ? Math.max(ratio, 0.02) : 0;
		value.setAttribute("stroke-dasharray", String(RING));
		value.setAttribute("stroke-dashoffset", String(RING * (1 - visual)));
	}
	if (pctNode) {
		const shown = ratio > 0 && ratio < 0.01 ? (Math.round(ratio * 1000) / 10).toFixed(1) : String(Math.round(ratio * 100));
		pctNode.textContent = `${shown}%`;
	}
	const wrap = $("#ring-wrap");
	if (wrap) wrap.title = target > 0 ? `目标 ${wordLabel(target)}，已写 ${wordLabel(total)}` : "按成稿章数算";
}

export function renderRail() {
	const list = $("#rail-list");
	if (!list) return;
	renderHead();
	const outline = ctx.state.outline || [];
	const metaById = new Map((ctx.state.chapters || []).map((item) => [item.id, item]));
	const filter = ctx.state.railFilter;
	const query = ctx.state.railQuery.toLowerCase();

	const visible = outline.filter((item) => {
		const meta = metaById.get(item.id);
		const words = meta?.words || 0;
		if (filter === "todo" && (item.status === "drafted" || item.status === "done")) return false;
		if (filter === "drafted" && item.status !== "drafted" && item.status !== "done" && words === 0) return false;
		if (query) {
			const hay = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
			if (!hay.includes(query)) return false;
		}
		return true;
	});

	list.replaceChildren();
	if (!outline.length) {
		list.append(
			el(
				"div",
				{ class: "rail-empty" },
				el("p", { text: "还没有章。" }),
				el("button", { class: "btn btn-ghost btn-sm", type: "button", on: { click: () => void openNewChapter() } }, icon("plus"), "添第一章"),
			),
		);
		return;
	}
	if (!visible.length) {
		list.append(el("div", { class: "rail-empty" }, el("p", { text: "这一档里没有章。" })));
		return;
	}

	// 按卷分组；未分卷的排在最前，组内保持大纲顺序。
	const groups = new Map();
	const order = [];
	for (const item of visible) {
		const key = item.volumeId || "";
		if (!groups.has(key)) {
			groups.set(key, []);
			order.push(key);
		}
		groups.get(key).push(item);
	}
	const volumeById = new Map((ctx.state.volumes || []).map((item) => [item.id, item]));
	for (const key of order) {
		const volume = volumeById.get(key);
		if (key && volume) {
			const vols = groups.get(key);
			const words = vols.reduce((sum, item) => sum + (metaById.get(item.id)?.words || 0), 0);
			list.append(
				el(
					"div",
					{ class: "rail-vol" },
					el("span", { class: "rail-vol-title", text: volume.title || "未命名卷" }),
					el("span", { class: "rail-vol-words", text: wordLabel(words) }),
				),
			);
		} else if ((ctx.state.volumes || []).length && !key) {
			list.append(el("div", { class: "rail-vol" }, el("span", { class: "rail-vol-title", text: "未分卷" })));
		}
		for (const item of groups.get(key)) list.append(chapterRow(item, metaById.get(item.id), outline.indexOf(item)));
	}
	scrollActiveIntoView();
}

function chapterRow(item, meta, index) {
	const active = item.id === ctx.state.activeId;
	const words = meta?.words || 0;
	const row = el("div", {
		class: `ch-row${active ? " is-active" : ""}`,
		role: "button",
		tabindex: "0",
		dataset: { chapter: item.id },
		on: {
			click: (event) => {
				if (event.target.closest(".ch-more")) return;
				if (window.matchMedia("(max-width: 920px)").matches) closeRail();
				void ctx.openChapter(item.id);
			},
			keydown: (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					if (window.matchMedia("(max-width: 920px)").matches) closeRail();
					void ctx.openChapter(item.id);
				}
			},
		},
	});
	row.append(el("span", { class: `dot is-${item.status || "planned"}` }));
	const main = el(
		"div",
		{ class: "ch-main" },
		el("div", { class: "ch-title", text: item.title || `第 ${index + 1} 章` }),
		el("div", { class: "ch-sub" }, el("span", { text: words ? `${num(words)} 字` : "空" }), el("span", { class: "ch-sep", text: "·" }), el("span", { text: ctx.statusLabel(item.status) })),
	);
	row.append(main);
	row.append(
		el("button", {
			class: "ch-more",
			type: "button",
			title: "这一章",
			on: {
				click: (event) => {
					event.stopPropagation();
					rowMenu(event.currentTarget, item);
				},
			},
		}, icon("more")),
	);
	return row;
}

function scrollActiveIntoView() {
	const active = document.querySelector(".ch-row.is-active");
	if (!active) return;
	const box = $("#rail-list");
	if (!box) return;
	const top = active.offsetTop - box.offsetTop;
	if (top < box.scrollTop || top + active.offsetHeight > box.scrollTop + box.clientHeight) {
		box.scrollTop = top - box.clientHeight / 3;
	}
}

function rowMenu(anchor, item) {
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
	add("打开", "book-open", () => void ctx.openChapter(item.id));
	add("改这一章的纲", "edit", () => void editChapter(item));
	add("导出 markdown", "download", () => void exportChapter(item));
	add("删掉", "trash", () => void removeChapter(item), true);
	const rect = anchor.getBoundingClientRect();
	menu.style.top = `${rect.bottom + 6}px`;
	menu.style.left = `${Math.max(12, rect.right - 168)}px`;
	document.body.append(menu);
	const off = (event) => {
		if (!menu.contains(event.target)) {
			menu.remove();
			window.removeEventListener("pointerdown", off, true);
		}
	};
	setTimeout(() => window.addEventListener("pointerdown", off, true), 0);
}

/* ---------------------------------------------------------------- 添章 / 改章 */

const volumeOptions = () => {
	const select = el("select", { class: "set-select" });
	select.append(el("option", { value: "", text: "不归卷" }));
	for (const volume of ctx.state.volumes || []) select.append(el("option", { value: volume.id, text: volume.title || "未命名卷" }));
	return select;
};

export async function openNewChapter({ volumeId = "", after = "" } = {}) {
	if (!ctx.state.project) return;
	const titleInput = el("input", { class: "set-input", type: "text", placeholder: "第一章 叫什么" });
	const summaryInput = el("textarea", { class: "set-area", rows: 3, placeholder: "这一章发生什么。一句话也行，执笔者会顺着写。" });
	const targetInput = el("input", { class: "set-input", type: "number", min: "0", step: "500", placeholder: "4000" });
	const volumeSelect = volumeOptions();
	volumeSelect.value = volumeId || "";
	if (!volumeSelect.value && ctx.state.volumes?.length) volumeSelect.value = ctx.state.volumes[0].id;

	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "章名" }), titleInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "这一章的纲" }), summaryInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "目标字数" }), targetInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "归入" }), volumeSelect),
	);
	const { close } = openModal({
		eyebrow: "章目",
		title: after ? "在后面插一章" : "添一章",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "添上",
				kind: "primary",
				icon: "check",
				onClick: async () => {
					const title = titleInput.value.trim();
					if (!title) {
						toast("章总得有个名字。", "error");
						titleInput.focus();
						return;
					}
					try {
						const data = await api.addChapter(ctx.state.project.id, {
							title,
							summary: summaryInput.value.trim() || undefined,
							targetWords: Number(targetInput.value) || undefined,
							volumeId: volumeSelect.value || undefined,
						});
						close();
						await ctx.reloadProjectStructure();
						await ctx.openChapter(data.chapter.id);
						toast("添上了。", "ok");
					} catch (error) {
						toast(error.message || "没添上。", "error");
					}
				},
			},
		],
	});
	titleInput.focus();
}

async function editChapter(item) {
	const titleInput = el("input", { class: "set-input", type: "text", value: item.title || "" });
	const summaryInput = el("textarea", { class: "set-area", rows: 4 });
	summaryInput.value = item.summary || "";
	const povInput = el("input", { class: "set-input", type: "text", value: item.pov || "", placeholder: "周砚 / 第一人称…" });
	const statusSelect = el("select", { class: "set-select" });
	for (const option of ctx.STATUS_OPTIONS) statusSelect.append(el("option", { value: option.value, text: option.label }));
	statusSelect.value = item.status || "planned";
	const volumeSelect = volumeOptions();
	volumeSelect.value = item.volumeId || "";

	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "章名" }), titleInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "这一章的纲" }), summaryInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "视角" }), povInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "状态" }), statusSelect),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "归入" }), volumeSelect),
	);
	const { close } = openModal({
		eyebrow: "章目",
		title: "改这一章的纲",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "存下",
				kind: "primary",
				icon: "check",
				onClick: async () => {
					try {
						await api.patchOutline(ctx.state.project.id, item.id, {
							title: titleInput.value.trim() || undefined,
							summary: summaryInput.value,
							pov: povInput.value.trim(),
							status: statusSelect.value,
							volumeId: volumeSelect.value,
						});
						close();
						await ctx.reloadProjectStructure();
						if (ctx.state.draft?.id === item.id) {
							ctx.state.draft.title = titleInput.value.trim() || ctx.state.draft.title;
							ctx.notify("draft");
						}
						toast("改好了。", "ok");
					} catch (error) {
						toast(error.message || "没改上。", "error");
					}
				},
			},
		],
	});
}

async function removeChapter(item) {
	const yes = await confirmAction({
		title: "删掉这一章？",
		message: `《${item.title}》会从大纲里拿掉。已经写过正文的章删不动——先把正文清空。`,
		confirmLabel: "删掉",
		danger: true,
	});
	if (!yes) return;
	try {
		await api.deleteOutline(ctx.state.project.id, item.id);
		if (ctx.state.activeId === item.id) {
			const next = ctx.state.outline.find((row) => row.id !== item.id);
			ctx.state.activeId = next?.id || "";
			ctx.state.draft = null;
			ctx.notify("draft");
		}
		await ctx.reloadProjectStructure();
		toast("删了。");
	} catch (error) {
		toast(error.message || "删不掉，可能是这一章已经有正文了。", "error");
	}
}

async function exportChapter(item) {
	const { saveFile } = await import("./share.js");
	// 导出走的是服务端那一份稿，正在改的字得先落盘，否则导出的还是上一版。
	await ctx.flushSave().catch(() => {});
	await saveFile({
		name: `${ctx.state.project?.title || "书稿"} · ${item.title || item.id}.md`,
		url: api.exportUrl(ctx.state.project.id, item.id, "md"),
	});
}

/* ---------------------------------------------------------------- 履历 */

export async function openHistory() {
	const drawer = $("#drawer");
	if (!drawer || !ctx.state.project) return;
	const body = $("#drawer-body");
	const foot = $("#drawer-foot");
	$("#drawer-eyebrow").textContent = ctx.state.project.title || "这部书";
	$("#drawer-title").textContent = "履历";
	body.replaceChildren(el("p", { class: "drawer-note sk-line", text: "正在翻…" }));
	foot.replaceChildren();
	drawer.hidden = false;
	$("#scrim").hidden = false;
	requestAnimationFrame(() => $("#scrim").classList.add("is-on"));

	let records = [];
	try {
		const data = await api.listRecords({ projectId: ctx.state.project.id, limit: 30 });
		records = data.records || [];
	} catch {
		records = [];
	}

	body.replaceChildren();
	const chapter = ctx.outlineItem(ctx.state.activeId);
	if (chapter) {
		const sec = el("section", { class: "drawer-sec" });
		sec.append(el("h3", { class: "drawer-sec-title", text: `这一章 · ${chapter.title}` }));
		const box = el("div", { class: "hist-list" });
		if (ctx.chapterMeta(chapter.id)?.hasDraft) {
			box.append(el("p", { class: "drawer-note sk-line", text: "正在读版本…" }));
			void fillChapterVersions(box, chapter.id);
		} else {
			box.append(el("p", { class: "drawer-note", text: "这一章还没落过笔，存过一次稿才会有版本。" }));
		}
		sec.append(box);
		body.append(sec);
	}

	const recSec = el("section", { class: "drawer-sec" });
	recSec.append(el("h3", { class: "drawer-sec-title", text: "写过的几席" }));
	recSec.append(el("p", { class: "drawer-note", text: "每一席都留着完整的对话。点开可以接着那一席说。" }));
	if (!records.length) {
		recSec.append(el("p", { class: "drawer-note", text: "还没有记录。" }));
	}
	for (const record of records) {
		recSec.append(
			el(
				"button",
				{
					class: "hist-row",
					type: "button",
					on: {
						click: async () => {
							const { resumeFromRecord } = await import("./dock.js");
							closeDrawer();
							resumeFromRecord(record);
						},
					},
				},
				el("div", { class: "hist-main" },
					el("div", { class: "hist-title", text: record.title || "未命名一席" }),
					el("div", { class: "hist-sub", text: excerpt(record.preview || "", 72) }),
				),
				el("div", { class: "hist-side" },
					el("span", { class: "hist-rev", text: `${record.messageCount || 0} 句` }),
					el("span", { class: "hist-when", text: new Date(record.updatedAt).toLocaleDateString("zh-CN") }),
				),
			),
		);
	}
	body.append(recSec);
	requestAnimationFrame(() => $("#rail-list")?.classList.add("is-dim"));
}

async function fillChapterVersions(box, chapterId) {
	try {
		const data = await api.getDraft(ctx.state.project.id, chapterId, { history: true });
		const history = data?.chapter?.history || [];
		box.replaceChildren();
		if (!history.length) {
			box.append(el("p", { class: "drawer-note", text: "这一章还没有存过稿。" }));
			return;
		}
		for (const entry of history.slice(0, 12)) {
			const row = el(
				"div",
				{ class: "hist-row" },
				el("div", { class: "hist-main" },
					el("div", { class: "hist-title", text: `第 ${entry.revision} 版` }),
					el("div", { class: "hist-sub", text: `${num(entry.words || 0)} 字 · ${new Date(entry.updatedAt).toLocaleString("zh-CN")} · ${entry.mode || "手写"}` }),
				),
				el("button", {
					class: "btn btn-ghost btn-sm",
					type: "button",
					text: "看",
					on: {
						click: () => {
							openModal({
								eyebrow: `第 ${entry.revision} 版`,
								title: ctx.outlineItem(chapterId)?.title || "旧稿",
								body: el("div", { class: "hist-preview", text: entry.content || "（空）" }),
								actions: [
									{ label: "只看看", onClick: () => document.querySelector("#modal")?.close() },
									{
										label: "恢复这一版",
										kind: "primary",
										onClick: async () => {
											try {
												await api.saveChapter(ctx.state.project.id, chapterId, { content: entry.content || "" });
												document.querySelector("#modal")?.close();
												await ctx.loadDraft(chapterId);
												toast("回到这一版了。", "ok");
											} catch (error) {
												toast(error.message || "恢复不了。", "error");
											}
										},
									},
								],
							});
						},
					},
				}),
			);
			box.append(row);
		}
	} catch {
		box.replaceChildren(el("p", { class: "drawer-note", text: "版本读不出来。" }));
	}
}

export function closeDrawer() {
	const drawer = $("#drawer");
	const scrim = $("#scrim");
	if (drawer) drawer.hidden = true;
	if (scrim) {
		scrim.classList.remove("is-on");
		scrim.hidden = true;
	}
	$("#rail-list")?.classList.remove("is-dim");
}
