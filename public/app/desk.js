/**
 * 案头：所有的书摊在这里。
 *
 * 立面分四块——书稿、通用素材库、原料库、废纸篓。写完一本书回来，
 * 眼睛第一个落到的应该是「接着写哪一章」，所以书卡上给的是进度条和那句「继续」。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, el, icon, toast, openModal, confirmAction, excerpt, timeAgo, wordLabel, pct, num } from "./core.js";
import { openMaterialEditor } from "./materials.js";

let mounted = false;
let trashOpen = false;
let libraryQuery = "";

export function initDesk() {
	if (mounted) return;
	mounted = true;
	$("#btn-new-project")?.addEventListener("click", () => void openNewProject());
	$("#btn-new-library")?.addEventListener("click", () => void openMaterialEditor({ scope: "library" }));
	$("#btn-ingest-source")?.addEventListener("click", () => pickSource());
	$("#library-search")?.addEventListener("input", (event) => {
		libraryQuery = event.target.value.trim();
		renderLibrary();
	});
	$("#desk-notice")?.addEventListener("click", (event) => {
		const btn = event.target.closest("[data-act]");
		if (!btn) return;
		const act = btn.dataset.act;
		if (act === "new-project") void openNewProject();
		if (act === "sample-project") void createSample();
	});
	document.addEventListener("click", (event) => {
		const btn = event.target.closest("[data-act]");
		if (!btn) return;
		const act = btn.dataset.act;
		if (act === "new-project") void openNewProject();
		if (act === "sample-project") void createSample();
		if (act === "toggle-trash") {
			trashOpen = !trashOpen;
			void renderTrash();
		}
	});
	ctx.onChange((scope) => {
		if (scope === "projects") {
			renderProjects();
			void renderTrash();
		}
		if (scope === "library") renderLibrary();
		if (scope === "sources") renderSources();
		if (scope === "boot") {
			void loadLibrary();
			void loadSources();
			void renderTrash();
		}
	});
	renderProjects();
	renderLibrary();
	renderSources();
	void loadLibrary();
	void loadSources();
	void renderTrash();
}

/* ---------------------------------------------------------------- 书稿 */

function renderProjects() {
	const grid = $("#project-grid");
	const empty = $("#desk-empty");
	const count = $("#desk-count");
	const title = $("#desk-title");
	const sub = $("#desk-sub");
	if (!grid || !empty) return;
	const projects = ctx.state.projects || [];
	if (count) count.textContent = projects.length ? `${projects.length} 部` : "";
	if (title) {
		const words = projects.reduce((sum, item) => sum + (item.stats?.words || 0), 0);
		title.textContent = projects.length ? `${projects.length} 部书，${wordLabel(words)}` : "铺开纸，写第一句";
	}
	if (sub) {
		sub.textContent = projects.length
			? "接着上一本写下去，或者另立一本。"
			: "本地优先的长篇小说创作台。书稿留在你自己的机器上。";
	}
	grid.replaceChildren();
	for (const project of projects) grid.append(projectCard(project));
	grid.hidden = projects.length === 0;
	empty.hidden = projects.length > 0;
	$("#trash-block").hidden = projects.length === 0 && !trashOpen;
}

function projectCard(project) {
	const stats = project.stats || {};
	const target = Number(project.targetWords || 0);
	const words = Number(stats.words || 0);
	const ratio = target > 0 ? pct(words, target) : 0;
	const card = el("article", {
		class: `project-card${project.adapted ? " is-adapt" : ""}`,
		tabindex: "0",
		role: "button",
		on: {
			click: (event) => {
				if (event.target.closest(".pc-kebab, .pc-menu")) return;
				void open(project.id);
			},
			keydown: (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void open(project.id);
				}
			},
		},
	});

	const top = el(
		"div",
		{ class: "pc-top" },
		el(
			"div",
			{ class: "pc-title-row" },
			el("h3", { class: "pc-title", text: project.title || "未命名" }),
			project.adapted ? el("span", { class: "tag tag-jade", text: "改编" }) : null,
		),
		el("button", {
			class: "pc-kebab",
			type: "button",
			title: "更多",
			on: {
				click: (event) => {
					event.stopPropagation();
					openCardMenu(event.currentTarget, project);
				},
			},
		}, icon("more")),
	);
	card.append(top);

	const tags = el("div", { class: "pc-tags" });
	if (project.genre) tags.append(el("span", { class: "tag", text: project.genre }));
	tags.append(el("span", { class: "tag tag-line", text: `${stats.draftedChapters || 0}/${stats.chapters || 0} 章` }));
	if (stats.empty) tags.append(el("span", { class: "tag tag-amber", text: "空书" }));
	card.append(tags);

	if (project.logline) card.append(el("p", { class: "pc-logline", text: excerpt(project.logline, 70) }));

	const bar = el(
		"div",
		{ class: "pc-bar" },
		el("div", { class: "pc-bar-track" }, el("span", { class: "pc-bar-fill", style: { width: `${target ? ratio : Math.min(100, words / 500)}%` } })),
		el("div", { class: "pc-bar-meta" }, el("span", { text: wordLabel(words) }), target ? el("span", { text: `目标 ${wordLabel(target)}` }) : null),
	);
	card.append(bar);

	const foot = el(
		"div",
		{ class: "pc-foot" },
		el("span", { class: "pc-when", text: words ? `上次动笔 ${timeAgo(project.updatedAt)}` : "还没落笔" }),
		el(
			"button",
			{
				class: "pc-del",
				type: "button",
				title: "把这本书删掉",
				"aria-label": `删除《${project.title || "未命名"}》`,
				on: {
					click: (event) => {
						// 卡片本身是「打开」，这颗按钮要自己吞掉冒泡。
						event.stopPropagation();
						void removeProject(project);
					},
				},
			},
			icon("trash"),
		),
		el("span", { class: "pc-go" }, words ? "继续" : "开写", icon("arrow-right")),
	);
	card.append(foot);
	return card;
}

function openCardMenu(anchor, project) {
	const host = document.querySelector(".pc-menu");
	host?.remove();
	const menu = el("div", { class: "pc-menu" });
	const add = (label, iconName, onClick, danger) =>
		menu.append(
			el(
				"button",
				{
					class: `pc-menu-item${danger ? " is-danger" : ""}`,
					type: "button",
					on: {
						click: (event) => {
							event.stopPropagation();
							menu.remove();
							onClick();
						},
					},
				},
				icon(iconName),
				label,
			),
		);
	add("打开", "book-open", () => void open(project.id));
	add("改书名与说明", "edit", () => void editProject(project));
	add("导出这份书稿", "download", () => void exportProject(project));
	add("丢进废纸篓", "trash", () => void removeProject(project), true);

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

async function open(id) {
	if (ctx.state.saving === "dirty") await ctx.flushSave().catch(() => {});
	await ctx.openProject(id);
}

async function editProject(project) {
	const titleInput = el("input", { class: "set-input", type: "text", value: project.title || "" });
	const genreInput = el("input", { class: "set-input", type: "text", value: project.genre || "", placeholder: "悬疑 / 年代 / 科幻…" });
	const loglineInput = el("textarea", { class: "set-area", rows: 3 });
	loglineInput.value = project.logline || "";
	const targetInput = el("input", { class: "set-input", type: "number", min: "0", step: "1000", value: String(project.targetWords || 0) });
	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "书名" }), titleInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "类型" }), genreInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "目标字数" }), targetInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "一句话" }), loglineInput),
	);
	const { close } = openModal({
		eyebrow: "这部书",
		title: "改书名与说明",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "存下",
				kind: "primary",
				onClick: async () => {
					try {
						await api.patchProject(project.id, {
							title: titleInput.value.trim(),
							genre: genreInput.value.trim(),
							logline: loglineInput.value.trim(),
							targetWords: Number(targetInput.value) || 0,
						});
						close();
						await ctx.refreshProjects();
						toast("改好了。", "ok");
					} catch (error) {
						toast(error.message || "没改上。", "error");
					}
				},
			},
		],
	});
}

async function removeProject(project) {
	const yes = await confirmAction({
		title: "把这本书丢进废纸篓？",
		message: `《${project.title}》会从案头挪开，正文与素材都还在，随时能捡回来。\n要彻底删掉，删完再到下面的废纸篓里点一次。`,
		confirmLabel: "丢进去",
		danger: true,
	});
	if (!yes) return;
	try {
		await api.deleteProject(project.id);
		if (ctx.state.project?.id === project.id) ctx.leaveProject();
		await ctx.refreshProjects();
		trashOpen = true;
		await renderTrash();
		toast("进废纸篓了。要彻底删掉，在下面废纸篓里再点一次。", "ok");
	} catch (error) {
		toast(error.message || "丢不掉。", "error");
	}
}

/** 彻底删掉：不可恢复，所以要把书名打一遍才放行。 */
async function purgeProject(project) {
	const input = el("input", { class: "set-input", type: "text", placeholder: project.title || "未命名", autocomplete: "off" });
	const body = el(
		"div",
		{ class: "confirm-text" },
		el("p", { text: `这会从磁盘上抹掉《${project.title}》的正文、历史版本与快照，捡不回来了。` }),
		el("label", { class: "field" }, el("span", { class: "field-label", text: `打一遍书名「${project.title || "未命名"}」确认` }), input),
	);
	let typed = false;
	const { close } = openModal({
		eyebrow: "彻底删掉",
		title: "这本书捡不回来了",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "彻底删掉",
				kind: "seal",
				onClick: async ({ close: shut }) => {
					if (!typed) {
						toast("书名还没打对。", "error");
						input.focus();
						return;
					}
					try {
						await api.purgeProject(project.id);
						if (ctx.state.project?.id === project.id) ctx.leaveProject();
						shut();
						await ctx.refreshProjects();
						await renderTrash();
						toast("彻底删了。", "ok");
					} catch (error) {
						toast(error.message || "删不掉。", "error");
					}
				},
			},
		],
	});
	input.addEventListener("input", () => {
		typed = input.value.trim() === (project.title || "未命名");
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && typed) {
			event.preventDefault();
			void api
				.purgeProject(project.id)
				.then(async () => {
					close();
					await ctx.refreshProjects();
					await renderTrash();
					toast("彻底删了。", "ok");
				})
				.catch((error) => toast(error.message || "删不掉。", "error"));
		}
	});
	input.focus();
}

async function exportProject(project) {
	const { exportNovel } = await import("./share.js");
	await exportNovel({ projectId: project.id, title: project.title });
}

/* ---------------------------------------------------------------- 新建 */

export async function openNewProject() {
	const titleInput = el("input", { class: "set-input", type: "text", placeholder: "如：夜航船" });
	const genreInput = el("input", { class: "set-input", type: "text", placeholder: "悬疑 / 年代 / 言情…" });
	const loglineInput = el("textarea", { class: "set-area", rows: 2, placeholder: "一句话说清这本书要讲什么" });
	const targetInput = el("input", { class: "set-input", type: "number", min: "0", step: "10000", placeholder: "200000" });
	const styleInput = el("textarea", { class: "set-area", rows: 3, placeholder: "叙述人称、语感、忌讳——执笔者会照这个写" });

	const libraryBox = el("div", { class: "pick-list" });
	const selectedLib = new Set();
	let libraryLoaded = false;
	const loadLibrary = async () => {
		if (libraryLoaded) return;
		libraryLoaded = true;
		try {
			const data = await api.listLibrary();
			ctx.state.library = data.materials || [];
			libraryBox.replaceChildren();
			if (!ctx.state.library.length) {
				libraryBox.append(el("p", { class: "set-note", text: "通用库里还没有料。" }));
				return;
			}
			for (const entry of ctx.state.library.slice(0, 40)) {
				libraryBox.append(
					el(
						"label",
						{ class: "pick-row" },
						el("input", {
							type: "checkbox",
							on: {
								change: (event) => {
									if (event.target.checked) selectedLib.add(entry.id);
									else selectedLib.delete(entry.id);
								},
							},
						}),
						el(
							"div",
							{ class: "pick-main" },
							el("div", { class: "pick-title" }, el("span", { class: "tag", text: ctx.kindLabel(entry.kind) }), entry.title),
							el("div", { class: "pick-sub", text: excerpt(entry.content, 80) }),
						),
					),
				);
			}
		} catch {
			libraryBox.replaceChildren(el("p", { class: "set-note", text: "库没打开。" }));
		}
	};

	const sourceSelect = el("select", { class: "set-select" });
	sourceSelect.append(el("option", { value: "", text: "不，从零写起" }));
	void (async () => {
		try {
			const data = await api.listSources();
			const sources = data.sources || [];
			for (const source of sources) {
				sourceSelect.append(
					el("option", {
						value: source.id,
						text: `${source.title || source.filename}（${source.chapterCount || 0} 章）`,
					}),
				);
			}
			if (!sources.length) {
				sourceSelect.disabled = true;
				sourceSelect.replaceChildren(el("option", { value: "", text: "原料库里还没有原书" }));
			}
		} catch {
			sourceSelect.disabled = true;
		}
	})();

	const tabs = el("div", { class: "seg" });
	const paneNew = el("div", { class: "new-pane" });
	const paneAdapt = el("div", { class: "new-pane" });
	const modeBtns = [
		["new", "从零写起"],
		["adapt", "改编一本原书"],
	];
	let mode = "new";
	for (const [key, label] of modeBtns) {
		const btn = el("button", {
			class: `seg-btn${key === mode ? " is-active" : ""}`,
			type: "button",
			text: label,
			on: {
				click: () => {
					mode = key;
					for (const other of tabs.children) other.classList.toggle("is-active", other === btn);
					paneNew.hidden = key !== "new";
					paneAdapt.hidden = key !== "adapt";
				},
			},
		});
		tabs.append(btn);
	}

	paneNew.append(
		el("div", { class: "form-grid" },
			el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "书名" }), titleInput),
			el("label", { class: "field" }, el("span", { class: "field-label", text: "类型" }), genreInput),
			el("label", { class: "field" }, el("span", { class: "field-label", text: "目标字数" }), targetInput),
			el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "一句话" }), loglineInput),
			el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "文风" }), styleInput),
			el("div", { class: "field field-wide" },
				el("span", { class: "field-label", text: "顺手从通用库取几条款" }),
				libraryBox,
			),
		),
	);
	paneAdapt.append(
		el("div", { class: "form-grid" },
			el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "原书" }), sourceSelect),
			el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "改编方向" }), loglineInput),
			el("p", { class: "set-note field-wide", text: "改编工程会按原书章节铺好大纲，正文由改编者逐章重写，不动原书。" }, el("div", { class: "set-note" })),
		),
	);
	paneAdapt.hidden = true;

	const body = el("div", null, tabs, paneNew, paneAdapt);
	const { close } = openModal({
		eyebrow: "案头",
		title: "立一本新书",
		body,
		wide: true,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "立起来",
				kind: "primary",
				icon: "check",
				onClick: async () => {
					try {
						let payload;
						if (mode === "adapt") {
							const sourceId = sourceSelect.value;
							if (!sourceId) {
								toast("先导一本原书进原料库。", "error");
								return;
							}
							payload = { title: titleInput.value.trim(), adaptation: { sourceId, brief: loglineInput.value.trim() } };
						} else {
							if (!titleInput.value.trim()) {
								toast("书总得有个名字。", "error");
								titleInput.focus();
								return;
							}
							payload = {
								title: titleInput.value.trim(),
								genre: genreInput.value.trim() || undefined,
								logline: loglineInput.value.trim() || undefined,
								styleGuide: styleInput.value.trim() || undefined,
								targetWords: Number(targetInput.value) || undefined,
								libraryIds: selectedLib.size ? [...selectedLib] : undefined,
							};
						}
						const data = await api.createProject(payload);
						close();
						await ctx.refreshProjects();
						await ctx.openProject(data.project.id);
						toast(mode === "adapt" ? "改编工程立起来了。" : "立起来了，先列章。", "ok");
					} catch (error) {
						toast(error.message || "立不起来。", "error");
					}
				},
			},
		],
	});
	titleInput.focus();
	void loadLibrary();
}

/* ---------------------------------------------------------------- 样书 */

async function createSample() {
	const btn = $("#desk-empty")?.querySelector('[data-act="sample-project"]');
	if (btn) btn.disabled = true;
	try {
		const project = await api.createProject({
			title: "夜航船",
			genre: "悬疑 · 年代",
			logline: "民国二十六年，一艘只在雨夜靠岸的渡船，载走了镇上第九个名字。",
			targetWords: 200000,
			styleGuide: "第三人称限知，短句，白描。少形容词，多动作与声音。对白不加解释。",
		});
		const pid = project.project.id;
		const materials = [
			{
				kind: "premise",
				title: "只收名字的摆渡人",
				usage: "全书的钩子：谁被写了名字，谁就开始忘事。",
				content: "渡口的老摆渡人不载人，只载名字。上船的人要把自己的名写在船帮上，船一开，岸上就再没人记得他。",
				tags: ["核心", "悬念"],
			},
			{
				kind: "character",
				title: "周砚 · 账房先生",
				usage: "主角。谨慎，记性极好，正因为记得太清楚才被盯上。",
				content: "三十四岁，镇上当铺的账房。左手小指缺一节。随身带一支秃笔和一本记满名字的册子。妻子三年前在雨夜失踪。",
				tags: ["主角", "POV"],
			},
			{
				kind: "world",
				title: "蒲塘镇 · 雨夜",
				usage: "全书反复出现的场景：雨、水声、船帮上的墨迹。",
				content: "江南水乡小镇，一条主河穿镇而过。每逢连雨，河面起白雾，渡船会在子时靠岸。镇上人不说「渡船」，只说「它来了」。",
				tags: ["氛围"],
			},
			{
				kind: "foreshadow",
				title: "第九个名字",
				usage: "悬念主线：前八个去哪儿了。",
				content: "册子上一共八个名字，都划了横线。第九个空着，笔迹是周砚自己的。",
				tags: ["主线"],
			},
		];
		const created = [];
		for (const material of materials) {
			const data = await api.createMaterial(pid, material);
			created.push(data.material.id);
		}
		const outline = [
			["雨夜靠岸", "渡船第一次在子时靠岸，周砚在船帮上看见了自己没写过的名字。", "close", "drafting"],
			["账房里的第八个", "册子上的旧名字指向三年前的一桩沉船。", "close", "outlined"],
			["缺一节的小指", "镇上老人说，摆渡人拿走的是名字，留下的是记忆。", "close", "planned"],
			["她也在船上", "周砚在雾里认出妻子的背影。", "close", "planned"],
		];
		let firstChapterId = "";
		for (const [index, [title, summary, pov, status]] of outline.entries()) {
			const data = await api.addChapter(pid, { title, summary, pov, targetWords: 4000 });
			if (index === 0) firstChapterId = data.chapter.id;
			if (status !== "planned") await api.patchOutline(pid, data.chapter.id, { status });
		}
		if (firstChapterId) {
			await api.assembleMaterials(pid, firstChapterId, { add: created });
			await api.saveChapter(pid, firstChapterId, {
				title: "雨夜靠岸",
				content: SAMPLE_BODY,
			});
		}
		await ctx.refreshProjects();
		await ctx.openProject(pid);
		toast("样书摊开了。第一章已经有一段，接着写就行。", "ok", 5200);
	} catch (error) {
		toast(error.message || "样书没铺成。", "error");
	} finally {
		if (btn) btn.disabled = false;
	}
}

const SAMPLE_BODY = `雨是子时起的。

周砚合上账本，听见河面上有橹声。不是镇上那几条船——那些船收工早，船家怕夜里的雾。他把油灯往窗前一挪，光落在水面，雾里慢慢浮出一截乌篷。

船没有靠埠头，停在河心。船帮上密密麻麻写着字，墨迹被雨水泡开，像一片黑色的苔。

他数了数，一共八行。第一行是「陈阿四」，第二行是「李婶」，往后几行他不认得，笔画都像是同一个人的手。

第九行空着。

周砚把手伸出窗外。雨点砸在手背上，凉得很真。他想，也许该下去看看；又想，三年前那个雨夜，自己也是这样站在窗前，看着一条船把妻子载走。

船帮上的第九行，这时自己浮出墨来。

写的是他的名字。`;

/* ---------------------------------------------------------------- 废纸篓 */

async function renderTrash() {
	const block = $("#trash-block");
	const list = $("#trash-list");
	if (!block || !list) return;
	let projects = [];
	try {
		const data = await api.listTrash();
		projects = data.projects || [];
	} catch {
		projects = [];
	}
	block.hidden = projects.length === 0;
	const head = block.querySelector("[data-act='toggle-trash']");
	if (head) head.textContent = trashOpen ? "收起" : "摊开";
	list.hidden = !trashOpen;
	list.replaceChildren();
	for (const project of projects) {
		list.append(
			el(
				"div",
				{ class: "trash-row" },
				el("div", { class: "trash-main" }, el("span", { class: "trash-title", text: project.title || "未命名" }), el("span", { class: "trash-when", text: `丢于 ${timeAgo(project.deletedAt)}` })),
				el(
					"div",
					{ class: "trash-actions" },
					el(
						"button",
						{
							class: "btn btn-ghost btn-sm",
							type: "button",
							on: {
								click: async () => {
									try {
										await api.restoreProject(project.id);
										await ctx.refreshProjects();
										await renderTrash();
										toast("捡回来了。", "ok");
									} catch (error) {
										toast(error.message || "捡不回来。", "error");
									}
								},
							},
						},
						icon("refresh"),
						"捡回来",
					),
					el(
						"button",
						{
							class: "btn btn-ghost btn-sm btn-danger",
							type: "button",
							title: "彻底删掉，捡不回来",
							on: { click: () => void purgeProject(project) },
						},
						icon("trash"),
						"彻底删掉",
					),
				),
			),
		);
	}
}

/* ---------------------------------------------------------------- 通用素材库 */

async function loadLibrary() {
	try {
		const data = await api.listLibrary();
		ctx.state.library = data.materials || [];
		ctx.notify("library");
	} catch {
		/* 老版本没有库 */
	}
}

function renderLibrary() {
	const grid = $("#library-grid");
	const empty = $("#library-empty");
	const count = $("#library-count");
	if (!grid || !empty) return;
	const entries = (ctx.state.library || []).filter((entry) => {
		if (!libraryQuery) return true;
		const q = libraryQuery.toLowerCase();
		return (entry.title || "").toLowerCase().includes(q) || (entry.content || "").toLowerCase().includes(q);
	});
	if (count) count.textContent = ctx.state.library?.length ? `${ctx.state.library.length} 条` : "";
	grid.replaceChildren();
	for (const entry of entries.slice(0, 60)) {
		grid.append(
			el(
				"article",
				{ class: "lib-card" },
				el("div", { class: "lib-top" }, el("span", { class: `mat-kind kind-${entry.kind}`, text: ctx.kindLabel(entry.kind) }), el("h4", { class: "lib-name", text: entry.title })),
				el("p", { class: "lib-body", text: excerpt(entry.content, 90) }),
				el(
					"div",
					{ class: "lib-foot" },
					el("span", { class: "lib-used", text: entry.usedBy?.length ? `被 ${entry.usedBy.length} 部借用` : "未被借用" }),
					el(
						"div",
						{ class: "lib-actions" },
						el("button", { class: "btn btn-quiet btn-sm", type: "button", title: "编辑", on: { click: () => void openMaterialEditor({ scope: "library", material: entry }) } }, icon("edit")),
						el("button", { class: "btn btn-quiet btn-sm btn-danger", type: "button", title: "删除", on: { click: () => void removeLibrary(entry) } }, icon("trash")),
					),
				),
			),
		);
	}
	empty.hidden = entries.length > 0;
}

async function removeLibrary(entry) {
	const yes = await confirmAction({
		title: "从通用库删掉？",
		message: `《${entry.title}》会从库里消失，已经取进各作品的副本不受影响。`,
		confirmLabel: "删掉",
		danger: true,
	});
	if (!yes) return;
	try {
		await api.deleteLibraryMaterial(entry.id);
		await loadLibrary();
		toast("删了。");
	} catch (error) {
		toast(error.message || "删不掉。", "error");
	}
}

/* ---------------------------------------------------------------- 原料库 */

async function loadSources() {
	try {
		const data = await api.listSources();
		ctx.state.sources = data.sources || [];
		ctx.notify("sources");
	} catch {
		ctx.state.sources = [];
		ctx.notify("sources");
	}
}

function renderSources() {
	const list = $("#source-list");
	const empty = $("#source-empty");
	const count = $("#source-count");
	if (!list || !empty) return;
	const sources = ctx.state.sources || [];
	if (count) count.textContent = sources.length ? `${sources.length} 本` : "";
	list.replaceChildren();
	for (const source of sources) {
		const chapters = source.chapterCount || source.chapters?.length || 0;
		list.append(
			el(
				"div",
				{ class: "source-row" },
				el("div", { class: "source-mark" }, icon(source.kind === "novel" ? "book" : "file")),
				el(
					"div",
					{ class: "source-main" },
					el("div", { class: "source-title", text: source.title || source.filename }),
					el("div", {
						class: "source-sub",
						text: `${source.kind === "novel" ? "原书" : "资料"} · ${chapters} 段 · ${num(source.totalChars || 0)} 字 · ${timeAgo(source.createdAt)}`,
					}),
				),
				el(
					"div",
					{ class: "source-actions" },
					el(
						"button",
						{
							class: "btn btn-ghost btn-sm",
							type: "button",
							on: { click: () => void createAdaptFrom(source) },
						},
						icon("split"),
						"改这本",
					),
					el(
						"button",
						{
							class: "btn btn-quiet btn-sm btn-danger",
							type: "button",
							title: "删除",
							on: {
								click: async () => {
									const yes = await confirmAction({
										title: "删掉这本原料？",
										message: `《${source.title}》以及它的分段都会消失，已经立起来的改编工程不受影响。`,
										confirmLabel: "删掉",
										danger: true,
									});
									if (!yes) return;
									try {
										await api.deleteSource(source.id);
										await loadSources();
										toast("删了。");
									} catch (error) {
										toast(error.message || "删不掉。", "error");
									}
								},
							},
						},
						icon("trash"),
					),
				),
			),
		);
	}
	empty.hidden = sources.length > 0;
}

async function createAdaptFrom(source) {
	try {
		const data = await api.createProject({
			title: `${source.title || source.filename}`,
			adaptation: { sourceId: source.id, brief: "" },
		});
		await ctx.refreshProjects();
		await ctx.openProject(data.project.id);
		ctx.setView("adapt");
		toast("改编台开了。先读原书，再定方向。", "ok");
	} catch (error) {
		toast(error.message || "立不起这个改编工程。", "error");
	}
}

function pickSource() {
	const input = $("#source-file-input");
	if (!input) return;
	input.value = "";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		toast("在读原书，长文要等一会儿…", "info", 6000);
		try {
			const data = await api.ingestSource(file, { kind: "novel" });
			await loadSources();
			const source = data?.source;
			toast(`收进原料库了：${source?.chapterCount || 0} 段。`, "ok");
		} catch (error) {
			toast(error.message || "读不进来。", "error");
		}
	};
	input.click();
}
