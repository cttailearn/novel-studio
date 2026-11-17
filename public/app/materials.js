/**
 * 素材台：一部书里所有的料。
 *
 * 素材的三种动作在这里闭环：写（新建/编辑）、装（挂到某一章上）、存（收进通用库）。
 * 素材是执笔者唯一的依据，所以每张卡都把「给了谁看」写得明明白白。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, excerpt, timeAgo, confirmAction, pack } from "./core.js";

const STATUS = { draft: "草稿", confirmed: "已定" };

let filterKind = "all";
let query = "";
let mounted = false;

export function initMaterials() {
	if (mounted) return;
	mounted = true;
	ctx.onChange((scope) => {
		if (["project", "materials", "chapters", "active", "kinds", "tab"].includes(scope)) render();
	});
	render();
}

function render() {
	const host = $("#mat-scroll");
	if (!host) return;
	const project = ctx.state.project;
	if (!project) {
		host.replaceChildren(
			el(
				"div",
				{ class: "mat-empty" },
				el("div", { class: "empty-seal" }, "料"),
				el("p", { class: "empty-title", text: "还没有开书" }),
				el("p", { class: "empty-note", text: "先立一本新书，再往里备料。" }),
			),
		);
		return;
	}

	const materials = ctx.state.materials || [];
	const kinds = ctx.state.kinds || [];
	const counts = new Map();
	for (const material of materials) counts.set(material.kind, (counts.get(material.kind) || 0) + 1);

	const list = materials
		.filter((material) => (filterKind === "all" ? true : material.kind === filterKind))
		.filter((material) => {
			if (!query) return true;
			const q = query.toLowerCase();
			return (
				(material.title || "").toLowerCase().includes(q) ||
				(material.content || "").toLowerCase().includes(q) ||
				(material.usage || "").toLowerCase().includes(q) ||
				(material.tags || []).some((tag) => String(tag).toLowerCase().includes(q))
			);
		})
		.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

	const frag = document.createDocumentFragment();
	frag.append(
		el(
			"div",
			{ class: "mat-head" },
			el(
				"div",
				null,
				el("p", { class: "eyebrow", text: "素材台" }),
				el("h2", { class: "mat-title", text: `${materials.length} 条料` }),
				el("p", {
					class: "mat-sub",
					text: "设定官往这里备料，执笔者只认挂在这一章上的那些。",
				}),
			),
		),
	);

	const pickedBar = renderPickedBar();
	if (pickedBar) frag.append(pickedBar);

	const chips = el("div", { class: "chips" });
	chips.append(
		el("button", {
			class: `chip${filterKind === "all" ? " is-active" : ""}`,
			type: "button",
			on: { click: () => ((filterKind = "all"), render()) },
			text: `全部 ${materials.length}`,
		}),
	);
	for (const kind of kinds) {
		const count = counts.get(kind.kind) || 0;
		if (!count && filterKind !== kind.kind) continue;
		chips.append(
			el("button", {
				class: `chip${filterKind === kind.kind ? " is-active" : ""}`,
				type: "button",
				on: { click: () => ((filterKind = kind.kind), render()) },
				text: `${kind.label} ${count}`,
			}),
		);
	}
	chips.append(
		el(
			"button",
			{ class: "chip chip-quiet", type: "button", title: "添一种、改个名、删掉一种", on: { click: () => void openKindManager() } },
			icon("sliders", "ico ico-sm"),
			"种类",
		),
	);

	const search = el("label", { class: "mat-search" });
	const input = el("input", {
		type: "search",
		placeholder: "搜标题、正文、用法",
		value: query,
		on: {
			input: (event) => {
				query = event.target.value;
				renderList();
			},
		},
	});
	search.append(icon("search"), input);
	frag.append(el("div", { class: "mat-filterbar" }, search, chips));

	if (!list.length) {
		frag.append(
			el(
				"div",
				{ class: "mat-empty" },
				el("p", { class: "empty-title", text: materials.length ? "这个条件下没有料" : "还没有一条料" }),
				el("p", {
					class: "empty-note",
					text: materials.length ? "换个种类或清掉搜索。" : "先把人物、世界观这些写成素材，执笔者才有的可依。",
				}),
			),
		);
	} else {
		const grid = el("div", { class: "mat-grid" });
		for (const material of list) grid.append(renderCard(material));
		frag.append(grid);
	}

	host.replaceChildren(frag);
	const focusSearch = host.dataset.focusSearch === "1";
	if (focusSearch) {
		host.dataset.focusSearch = "";
		input.focus();
	}
}

function renderList() {
	const host = $("#mat-scroll");
	if (!host) return;
	const grid = host.querySelector(".mat-grid");
	if (!grid) return render();
	const materials = (ctx.state.materials || [])
		.filter((material) => (filterKind === "all" ? true : material.kind === filterKind))
		.filter((material) => {
			if (!query) return true;
			const q = query.toLowerCase();
			return (
				(material.title || "").toLowerCase().includes(q) ||
				(material.content || "").toLowerCase().includes(q) ||
				(material.usage || "").toLowerCase().includes(q)
			);
		})
		.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	grid.replaceChildren(...materials.map(renderCard));
}

async function openKindManager() {
	const body = el("div", { class: "kind-manager" });
	const paint = () => {
		const rows = el("div", { class: "kind-rows" });
		for (const kind of ctx.state.kinds || []) {
			const input = el("input", { class: "set-input", value: kind.label, maxlength: "24", "aria-label": "种类名称" });
			const rename = el("button", {
				class: "btn btn-ghost btn-sm",
				type: "button",
				text: "改名",
				on: {
					click: async () => {
						const label = input.value.trim();
						if (!label || label === kind.label) return;
						try {
							await api.patchKind(kind.kind, label);
							await refresh();
							toast("改好了。", "ok");
						} catch (error) {
							toast(error.message || "改不了这个种类。", "error");
						}
					},
				},
			});
			const drop = el("button", {
				class: "btn btn-ghost btn-sm btn-danger",
				type: "button",
				text: "删掉",
				on: {
					click: async () => {
						const ok = await confirmAction({
							title: `删掉「${kind.label}」？`,
							message: "用它写的料会归到「其他」，不会丢。",
							confirmLabel: "删掉",
							danger: true,
						});
						if (!ok) return;
						try {
							await api.deleteKind(kind.kind);
							await refresh();
							toast("删掉了。", "ok");
						} catch (error) {
							toast(error.message || "这个种类删不掉。", "error");
						}
					},
				},
			});
			rows.append(
				el(
					"div",
					{ class: "kind-row" },
					el("div", { class: "kind-main" }, input, el("span", { class: "kind-key", text: kind.kind })),
					el("div", { class: "kind-ops" }, rename, drop),
				),
			);
		}
		const input = el("input", { class: "set-input", placeholder: "新种类的名字，比如「势力」", maxlength: "24" });
		const add = el("button", {
			class: "btn btn-primary btn-sm",
			type: "button",
			text: "添一个",
			on: {
				click: async () => {
					const label = input.value.trim();
					if (!label) return;
					try {
						await api.createKind(label);
						await refresh();
						toast("添上了。", "ok");
					} catch (error) {
						toast(error.message || "添不了这个种类。", "error");
					}
				},
			},
		});
		body.replaceChildren(
			rows,
			el("div", { class: "kind-add" }, input, add),
			el("p", { class: "set-note", text: "内置的种类改不了名，也删不掉。自建的种类会出现在筛选条与素材表单里。" }),
		);
	};
	const refresh = async () => {
		const data = await api.listKinds();
		ctx.state.kinds = data.kinds || [];
		ctx.notify("kinds");
		paint();
	};
	paint();
	openModal({ eyebrow: "素材", title: "种类", body, footNote: "按种类筛料；一种料只能归一类。" });
}

function renderPickedBar() {
	const item = ctx.outlineItem(ctx.state.activeId);
	if (!item) return null;
	const materials = ctx.state.materials || [];
	const picked = (item.materialIds || [])
		.map((id) => materials.find((material) => material.id === id))
		.filter(Boolean);
	const bar = el("div", { class: "picked-bar" });
	bar.append(
		el(
			"div",
			{ class: "picked-bar-head" },
			el("strong", { text: `挂在这一章上的料 · ${picked.length}` }),
			el(
				"span",
				{ class: "bench-hint", text: item.title || "" },
			),
		),
	);
	if (!picked.length) {
		bar.append(
			el("p", {
				class: "mat-sub",
				text: "这一章还没有料。执笔者会拒写空手章 —— 从下面挑几条，或者让设定官替你备。",
			}),
		);
		return bar;
	}
	const row = el("div", { class: "picked-row" });
	for (const material of picked) {
		row.append(
			el(
				"span",
				{ class: "picked-chip" },
				el("span", { text: material.title }),
				el(
					"button",
					{
						type: "button",
						title: "卸下",
						on: { click: () => void detach(material) },
					},
					icon("x"),
				),
			),
		);
	}
	bar.append(row);
	return bar;
}

function renderCard(material) {
	const item = ctx.outlineItem(ctx.state.activeId);
	const picked = item ? (item.materialIds || []).includes(material.id) : false;
	const chapters = (material.chapterIds || []).length;
	const card = el("article", { class: `mat-card${picked ? " is-picked" : ""}${material.status === "draft" ? " is-draft" : ""}` });

	const top = el("div", { class: "mat-top" });
	top.append(
		...pack(
			el("span", { class: `mat-kind kind-${material.kind}`, text: ctx.kindLabel(material.kind) }),
			el("h3", { class: "mat-name", text: material.title || "（未命名）" }),
			material.source === "library" ? el("span", { class: "tag tag-line", text: "来自库" }) : null,
		),
	);
	card.append(top);
	if (material.usage) card.append(el("p", { class: "mat-use", text: material.usage }));
	card.append(el("p", { class: "mat-body", text: excerpt(material.content, 150) }));

	const tags = el("div", { class: "mat-tags" });
	for (const tag of (material.tags || []).slice(0, 6)) tags.append(el("span", { class: "tag", text: tag }));
	if (chapters) tags.append(el("span", { class: "tag tag-seal", text: `挂 ${chapters} 章` }));
	if (material.status === "draft") tags.append(el("span", { class: "tag tag-amber", text: "草稿" }));
	card.append(tags);

	const actions = el("div", { class: "mat-actions" });
	actions.append(
		el(
			"button",
			{
				class: `btn btn-quiet btn-sm${picked ? " is-on" : ""}`,
				type: "button",
				title: picked ? "从本章卸下" : "挂到本章",
				on: { click: () => void (picked ? detach(material) : attach(material)) },
			},
			icon(picked ? "check" : "pin"),
			picked ? "已挂" : "挂到本章",
		),
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				title: "编辑",
				on: { click: () => void openMaterialEditor({ material }) },
			},
			icon("edit"),
		),
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				title: "存进通用素材库",
				on: { click: () => void saveToLibrary(material) },
			},
			icon("layers"),
		),
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm btn-danger",
				type: "button",
				title: "删除",
				on: { click: () => void removeMaterial(material) },
			},
			icon("trash"),
		),
	);
	card.append(el("div", { class: "mat-foot" }, el("span", { class: "mat-sub", text: timeAgo(material.updatedAt) }), actions));
	return card;
}

/* ---------------------------------------------------------------- 动作 */

async function attach(material) {
	const project = ctx.state.project;
	const chapterId = ctx.state.activeId;
	if (!project || !chapterId) {
		toast("先选一章。");
		return;
	}
	try {
		const data = await api.assembleMaterials(project.id, chapterId, { add: [material.id] });
		applyAssembly(chapterId, data.assembled);
		toast(`《${material.title}》挂到这一章了。`, "ok");
	} catch (error) {
		toast(error.message || "挂不上。", "error");
	}
}

async function detach(material) {
	const project = ctx.state.project;
	const chapterId = ctx.state.activeId;
	if (!project || !chapterId) return;
	try {
		const data = await api.assembleMaterials(project.id, chapterId, { remove: [material.id] });
		applyAssembly(chapterId, data.assembled);
	} catch (error) {
		toast(error.message || "卸不下来。", "error");
	}
}

function applyAssembly(chapterId, assembled) {
	const item = ctx.outlineItem(chapterId);
	if (item) item.materialIds = assembled || [];
	ctx.notify("materials");
	ctx.notify("outline");
}

async function saveToLibrary(material) {
	const project = ctx.state.project;
	if (!project) return;
	try {
		const data = await api.saveMaterialToLibrary(project.id, material.id, { mode: "create" });
		ctx.state.library = data.materials || ctx.state.library;
		ctx.notify("library");
		toast("收进通用素材库了。", "ok");
	} catch (error) {
		toast(error.message || "存不进库。", "error");
	}
}

async function removeMaterial(material) {
	const project = ctx.state.project;
	if (!project) return;
	const yes = await confirmAction({
		title: "删掉这条料？",
		message: `《${material.title}》会从这部书和所有挂着它的章节里消失。删之前会自动拍一份快照，能回滚。`,
		confirmLabel: "删掉",
		danger: true,
	});
	if (!yes) return;
	try {
		await api.deleteMaterial(project.id, material.id);
		await ctx.reloadProjectStructure();
		toast("删了。");
	} catch (error) {
		toast(error.message || "删不掉。", "error");
	}
}

/* ---------------------------------------------------------------- 编辑器 */

/**
 * 新建或改一条素材。scope = "project"（这部书的料）| "library"（通用库）。
 */
export async function openMaterialEditor({ material = null, scope = "project", preset = null } = {}) {
	const project = ctx.state.project;
	if (scope === "project" && !project) {
		toast("先开一部书。");
		return;
	}
	const kinds = ctx.state.kinds?.length ? ctx.state.kinds : [{ kind: "other", label: "其他" }];
	const value = { ...(material || {}), ...(preset || {}) };

	const titleInput = el("input", { class: "set-input", type: "text", value: value.title || "", placeholder: "如：渡口的老船夫" });
	const kindSelect = el("select", { class: "set-select" });
	for (const kind of kinds) {
		kindSelect.append(el("option", { value: kind.kind, text: kind.label, selected: kind.kind === (value.kind || "other") }));
	}
	const usageInput = el("input", {
		class: "set-input",
		type: "text",
		value: value.usage || "",
		placeholder: "这条料为什么有用：能撑起什么、避免什么",
	});
	const contentArea = el("textarea", { class: "set-area", rows: 10, placeholder: "写具体。执笔者只读这里。" });
	contentArea.value = value.content || "";
	const tagsInput = el("input", { class: "set-input", type: "text", value: (value.tags || []).join("、"), placeholder: "用顿号或逗号分开" });
	const statusSelect = el("select", { class: "set-select" });
	statusSelect.append(
		el("option", { value: "confirmed", text: "已定稿", selected: (value.status || "confirmed") === "confirmed" }),
		el("option", { value: "draft", text: "草稿", selected: value.status === "draft" }),
	);

	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "标题" }), titleInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "种类" }), kindSelect),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "状态" }), statusSelect),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "用法" }), usageInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "内容" }), contentArea),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "标签" }), tagsInput),
	);

	const submit = async () => {
		const title = titleInput.value.trim();
		const content = contentArea.value.trim();
		if (!title) {
			toast("给这条料取个名。", "error");
			titleInput.focus();
			return;
		}
		if (!content) {
			toast("内容是空的，执笔者读不到东西。", "error");
			contentArea.focus();
			return;
		}
		const tags = tagsInput.value
			.split(/[、,，\s]+/)
			.map((item) => item.trim())
			.filter(Boolean);
		const payload = {
			title,
			content,
			kind: kindSelect.value,
			usage: usageInput.value.trim(),
			tags,
			status: statusSelect.value,
		};
		try {
			if (scope === "library") {
				if (material) await api.patchLibraryMaterial(material.id, payload);
				else await api.createLibraryMaterial(payload);
				const data = await api.listLibrary();
				ctx.state.library = data.materials || [];
				ctx.notify("library");
			} else {
				if (material) await api.patchMaterial(project.id, material.id, payload);
				else {
					const data = await api.createMaterial(project.id, payload);
					if (data?.stats) ctx.setStats(data.stats);
				}
				await ctx.reloadProjectStructure();
			}
			close();
			toast("存好了。", "ok");
		} catch (error) {
			toast(error.message || "没存上。", "error");
		}
	};

	contentArea.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			void submit();
		}
	});

	const { close } = openModal({
		eyebrow: scope === "library" ? "通用素材库" : "这部书",
		title: material ? "改一条料" : "备一条料",
		body,
		wide: true,
		actions: [
			{ label: "算了", onClick: () => close() },
			{ label: "存下", kind: "primary", icon: "check", onClick: () => void submit() },
		],
		footNote: `${modKeyNow()}+Enter 直接存`,
	});
	titleInput.focus();
	titleInput.select?.();
}

function modKeyNow() {
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

/* ---------------------------------------------------------------- 从库取料 / 导文件 */

async function openLibraryPicker() {
	const project = ctx.state.project;
	if (!project) return;
	let data;
	try {
		data = await api.listLibrary();
	} catch (error) {
		toast(error.message || "打不开库。", "error");
		return;
	}
	ctx.state.library = data.materials || [];
	const entries = data.materials || [];
	if (!entries.length) {
		toast("通用素材库还是空的。");
		return;
	}
	const selected = new Set();
	const list = el("div", { class: "pick-list" });
	for (const entry of entries) {
		const row = el(
			"label",
			{ class: "pick-row" },
			el("input", {
				type: "checkbox",
				on: {
					change: (event) => {
						if (event.target.checked) selected.add(entry.id);
						else selected.delete(entry.id);
					},
				},
			}),
			el(
				"div",
				{ class: "pick-main" },
				el("div", { class: "pick-title" }, el("span", { class: "tag", text: ctx.kindLabel(entry.kind) }), entry.title),
				el("div", { class: "pick-sub", text: excerpt(entry.content, 110) }),
			),
		);
		list.append(row);
	}
	const { close } = openModal({
		eyebrow: "通用素材库",
		title: "取哪几条进这部书",
		body: list,
		wide: true,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "取进来",
				kind: "primary",
				onClick: async () => {
					if (!selected.size) {
						toast("一条也没选。");
						return;
					}
					try {
						for (const id of selected) {
							const entry = entries.find((item) => item.id === id);
							if (!entry) continue;
							await api.createMaterial(project.id, {
								title: entry.title,
								content: entry.content,
								kind: entry.kind,
								usage: entry.usage,
								tags: entry.tags || [],
							});
						}
						close();
						await ctx.reloadProjectStructure();
						toast(`取进来 ${selected.size} 条。`, "ok");
					} catch (error) {
						toast(error.message || "取不进来。", "error");
					}
				},
			},
		],
	});
}

function pickFile() {
	const input = $("#material-file-input");
	if (!input) return;
	input.value = "";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		const project = ctx.state.project;
		if (!project) return;
		toast("在读文件…");
		try {
			const data = await api.uploadFile(file, { projectId: project.id });
			const upload = data?.upload;
			if (!upload?.text) {
				toast("这份文件没读出文字。", "error");
				return;
			}
			await openMaterialEditor({
				preset: { title: upload.title || file.name, content: upload.text, kind: "research" },
			});
			if (upload.truncated) toast(`原文 ${upload.originalChars} 字，只取了一部分。`);
		} catch (error) {
			toast(error.message || "读不了这个文件。", "error");
		}
	};
	input.click();
}
