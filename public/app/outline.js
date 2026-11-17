/**
 * 大纲：把一本书摊成一张表。
 *
 * 章、卷、状态、字数、挂了几条料——都在一行里。这里改完，执笔者下一次动笔
 * 拿到的就是新的骨架，所以这一页更该像账本而不是表单。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, confirmAction, wordLabel, num } from "./core.js";

let mounted = false;

export function initOutline() {
	if (mounted) return;
	mounted = true;
	ctx.onChange((scope) => {
		if (scope === "outline" || scope === "chapters" || scope === "project" || scope === "stats") render();
	});
	render();
}

export function openNewChapterFromOutline() {
	void import("./studio.js").then((mod) => mod.openNewChapter());
}

export function render() {
	const host = $("#outline-scroll");
	if (!host) return;
	const project = ctx.state.project;
	if (!project) {
		host.replaceChildren(el("div", { class: "empty-inline", text: "先打开一部书。" }));
		return;
	}
	const outline = ctx.state.outline || [];
	const volumes = ctx.state.volumes || [];
	const metaById = new Map((ctx.state.chapters || []).map((item) => [item.id, item]));
	host.replaceChildren();

	const inner = el("div", { class: "outline-inner" });
	const stats = ctx.state.stats;
	inner.append(
		el(
			"div",
			{ class: "ol-head" },
			el(
				"div",
				{ class: "ol-head-text" },
				el("p", { class: "eyebrow", text: "骨架" }),
				el("p", { class: "ol-stat", text: `${outline.length} 章 · ${wordLabel(stats?.words || 0)} · ${stats?.draftedChapters || 0} 章成稿` }),
			),
		),
	);

	if (!outline.length) {
		inner.append(
			el(
				"div",
				{ class: "ol-empty" },
				el("p", { class: "empty-title", text: "骨架还空着" }),
				el("p", { class: "empty-note", text: "添几章，每章写一句纲。执笔者按这个写，改起来也快。" }),
				el("button", { class: "btn btn-ink", type: "button", text: "添第一章", on: { click: () => openNewChapterFromOutline() } }),
			),
		);
		host.append(inner);
		return;
	}

	const groups = new Map();
	const order = [];
	for (const item of outline) {
		const key = item.volumeId || "";
		if (!groups.has(key)) {
			groups.set(key, []);
			order.push(key);
		}
		groups.get(key).push(item);
	}
	const volumeById = new Map(volumes.map((item) => [item.id, item]));
	for (const key of order) {
		const volume = volumeById.get(key);
		if (key && volume) {
			const rows = groups.get(key);
			const words = rows.reduce((sum, item) => sum + (metaById.get(item.id)?.words || 0), 0);
			inner.append(
				el(
					"div",
					{ class: "ol-vol" },
					el("span", { class: "ol-vol-title", text: volume.title || "未命名卷" }),
					el("span", { class: "ol-vol-words", text: `${rows.length} 章 · ${wordLabel(words)}` }),
					el(
						"div",
						{ class: "ol-vol-tools" },
						el("button", { class: "btn btn-quiet btn-sm", type: "button", text: "改", on: { click: () => void openVolumeEditor(volume) } }),
						el("button", {
							class: "btn btn-quiet btn-sm btn-danger",
							type: "button",
							text: "删",
							on: { click: () => void removeVolume(volume) },
						}),
					),
				),
			);
		}
		for (const item of groups.get(key)) inner.append(chapterRow(item, metaById.get(item.id), outline.indexOf(item)));
	}
	host.append(inner);
}

function chapterRow(item, meta, index) {
	const words = meta?.words || 0;
	const row = el("div", {
		class: `ol-row${item.id === ctx.state.activeId ? " is-active" : ""}`,
		dataset: { chapter: item.id },
	});
	row.append(el("span", { class: "ol-ord", text: String(index + 1).padStart(2, "0") }));

	const main = el(
		"div",
		{ class: "ol-main" },
		el(
			"div",
			{ class: "ol-line" },
			el("button", {
				class: "ol-title",
				type: "button",
				title: "打开这一章",
				on: { click: () => void ctx.openChapter(item.id) },
				text: item.title || `第 ${index + 1} 章`,
			}),
			item.pov ? el("span", { class: "tag", text: `视角 ${item.pov}` }) : null,
			meta?.materialIds?.length ? el("span", { class: "tag tag-line", text: `${meta.materialIds.length} 条料` }) : null,
		),
		el("p", { class: "ol-summary", text: item.summary || "（还没有纲）" }),
	);
	row.append(main);

	const statusSelect = el("select", { class: "ol-status-select", title: "状态" });
	for (const option of ctx.STATUS_OPTIONS) statusSelect.append(el("option", { value: option.value, text: option.label }));
	statusSelect.value = item.status || "planned";
	statusSelect.addEventListener("change", async () => {
		try {
			await api.patchOutline(ctx.state.project.id, item.id, { status: statusSelect.value });
			const found = ctx.state.outline.find((node) => node.id === item.id);
			if (found) found.status = statusSelect.value;
			ctx.notify("chapters");
			ctx.notify("outline");
			toast("状态改了。", "ok");
		} catch (error) {
			toast(error.message || "改不了。", "error");
			statusSelect.value = item.status || "planned";
		}
	});
	row.append(statusSelect);
	row.append(el("span", { class: "ol-words", text: words ? num(words) : "—" }));

	row.append(
		el(
			"div",
			{ class: "ol-actions" },
			el("button", { class: "btn btn-quiet btn-sm", type: "button", title: "改纲", on: { click: () => void editChapter(item) } }, icon("edit")),
			el("button", { class: "btn btn-quiet btn-sm", type: "button", title: "在这一章后面插一章", on: { click: () => void addAfter(item) } }, icon("plus")),
		),
	);
	return row;
}

async function editChapter(item) {
	const projectId = ctx.state.project.id;
	const titleInput = el("input", { class: "set-input", type: "text", value: item.title || "" });
	const summaryInput = el("textarea", { class: "set-area", rows: 5 });
	summaryInput.value = item.summary || "";
	const volumeSelect = el("select", { class: "set-select" });
	volumeSelect.append(el("option", { value: "", text: "不归卷" }));
	for (const volume of ctx.state.volumes || []) volumeSelect.append(el("option", { value: volume.id, text: volume.title || "未命名卷" }));
	volumeSelect.value = item.volumeId || "";
	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "章名" }), titleInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "纲" }), summaryInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "归入" }), volumeSelect),
	);
	const { close } = openModal({
		eyebrow: "大纲",
		title: "改这一章的纲",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "存下",
				kind: "primary",
				onClick: async () => {
					try {
						await api.patchOutline(projectId, item.id, {
							title: titleInput.value.trim() || undefined,
							summary: summaryInput.value,
							volumeId: volumeSelect.value,
						});
						close();
						await ctx.reloadProjectStructure();
						toast("改好了。", "ok");
					} catch (error) {
						toast(error.message || "没改上。", "error");
					}
				},
			},
		],
	});
}

function addAfter(item) {
	void import("./studio.js").then((mod) => mod.openNewChapter({ volumeId: item.volumeId || "", after: item.id }));
}

export async function openVolumeEditor(volume = null) {
	const titleInput = el("input", { class: "set-input", type: "text", value: volume?.title || "", placeholder: "第一卷 起雾" });
	const summaryInput = el("textarea", { class: "set-area", rows: 3, placeholder: "这一卷要推到哪儿" });
	summaryInput.value = volume?.summary || "";
	const targetInput = el("input", { class: "set-input", type: "number", min: "0", step: "10000", value: String(volume?.targetWords || "") });
	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "卷名" }), titleInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "这一卷的纲" }), summaryInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "目标字数" }), targetInput),
	);
	const { close } = openModal({
		eyebrow: "大纲",
		title: volume ? "改这一卷" : "加一卷",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "存下",
				kind: "primary",
				onClick: async () => {
					const title = titleInput.value.trim();
					if (!title) {
						toast("卷总得有个名字。", "error");
						return;
					}
					try {
						if (volume) {
							await api.patchVolume(ctx.state.project.id, volume.id, {
								title,
								summary: summaryInput.value,
								targetWords: Number(targetInput.value) || 0,
							});
						} else {
							await api.addVolume(ctx.state.project.id, {
								title,
								summary: summaryInput.value || undefined,
								targetWords: Number(targetInput.value) || undefined,
							});
						}
						close();
						await ctx.reloadProjectStructure();
						toast("存下了。", "ok");
					} catch (error) {
						toast(error.message || "没存上。", "error");
					}
				},
			},
		],
	});
	titleInput.focus();
}

async function removeVolume(volume) {
	const yes = await confirmAction({
		title: "删掉这一卷？",
		message: `「${volume.title}」会消失，里面的章会挪到「未分卷」，正文不动。`,
		confirmLabel: "删掉",
		danger: true,
	});
	if (!yes) return;
	try {
		const data = await api.deleteVolume(ctx.state.project.id, volume.id);
		await ctx.reloadProjectStructure();
		toast(data?.moved ? `删了，${data.moved} 章挪出来了。` : "删了。");
	} catch (error) {
		toast(error.message || "删不掉。", "error");
	}
}
