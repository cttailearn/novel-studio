// 墨耕 · 前端。不使用框架，直接消费后端 NDJSON 事件流。
//
// 界面按「写小说」而非「聊天」来组织：
//   左卷  选卷与章目
//   稿    读稿、改稿、存稿
//   料    素材工作台：上传原料 + 与设定官对议 + 素材库
//   文    生文工作台：装配本章素材 + 与执笔者对议 + 装料成文
//   右案  随时查素材、大纲、待办
//
// 两个工作台是两个独立智能体：设定官产素材、执笔者产正文，工具集互不相交。
// 界面上的分工就是后端工具边界的投影 —— 设定官没有写正文的工具，
// 执笔者也没有改素材的工具，所以这里不需要靠提示词去防串岗。

import { bindSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

const MATERIAL_KIND_LABELS = {
	premise: "核心设定",
	character: "人物",
	world: "世界观",
	location: "场景地点",
	plot: "情节线",
	beat: "桥段",
	scene: "场景卡",
	dialogue: "对话",
	imagery: "意象",
	foreshadow: "伏笔",
	style: "文风",
	research: "考据",
	other: "其他",
};

/** 两个工作台的 DOM 坐标。渲染对话时按角色取，不必到处写 id。 */
const PANES = {
	material: { stream: "material-stream", input: "material-input", assistant: "设定官" },
	writing: { stream: "writing-stream", input: "writing-input", assistant: "执笔者" },
};

const state = {
	projects: [],
	projectId: null,
	project: null,
	stats: null,
	view: "manuscript",
	chapterId: null,
	editing: false,
	bibleTab: "materials",
	materialFilter: "",
	/** 会话 id，键为 "material" 或 "writing:<chapterId>"。 */
	sessions: new Map(),
	/** 每个会话的对话快照。切换章节时来回换，不丢上下文。 */
	transcripts: new Map(),
	/** 面板当前显示的会话键，用来判断该不该换内容。 */
	streamKeys: { material: null, writing: null },
	/** 正在流式的面板：null | "material" | "writing"。 */
	streaming: null,
	/** 一次性成文的 AbortController，让「止笔」对它也有效。 */
	writeAbort: null,
	/** 刚上传、还没处置的原料。 */
	uploads: [],
	/** 展开了全文的素材 id。 */
	openMaterials: new Set(),
	/** 等第二次点击确认删除的素材 id。 */
	pendingDelete: null,
	/** 生文工作台选定的作业性质，重渲染不该把它抖掉。 */
	writeMode: "create",
	/** 通用素材库。每条带 usedBy，由服务端从各作品现算，所以不会两边不一致。 */
	library: [],
	libraryFilter: "",
	/** 新建作品时勾选的库条目 id。 */
	libraryPick: new Set(),
	libraryPickQuery: "",
	/** 改作品时的 id；null 表示新建。 */
	editingProjectId: null,
	/** 等第二次点击确认删除的 id。作品与库各留一份，别和作品内素材的 pendingDelete 混用。 */
	pendingProjectDelete: null,
	pendingLibraryDelete: null,
	/** 素材工作台里点选、准备让设定官按需求修改的素材 id。 */
	pickedMaterials: new Set(),
	/** 顶层模式：home 是案头（管理），workspace 是写作台（创作）。 */
	mode: "home",
};

/** 素材表单的落点：新建（可能来自某条上传）还是改已有的。 */
let materialForm = { scope: "project", mode: "create", uploadId: null, materialId: null, libraryId: null };

const kindLabel = (kind) => MATERIAL_KIND_LABELS[kind] || kind;
const fmtNum = (n) => n.toLocaleString("zh-CN");

const CN = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1 → 一，12 → 十二 */
function toCn(n) {
	if (n < 10) return CN[n] ?? String(n);
	if (n < 20) return "十" + (CN[n - 10] ?? "");
	const tens = Math.floor(n / 10);
	const ones = n % 10;
	return (CN[tens] ?? "") + "十" + (ones ? CN[ones] : "");
}

/** 与服务端 countWords 同口径：CJK 按字，西文按词 */
function countWords(text) {
	if (!text) return 0;
	const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
	const latin = text
		.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ")
		.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)?.length ?? 0;
	return cjk + latin;
}

function fmt(n) {
	return n >= 10000 ? Math.round((n / 10000) * 10) / 10 + " 万" : n.toLocaleString("zh-CN");
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label, className, onClick) {
	const node = el("button", className, label);
	node.addEventListener("click", onClick);
	return node;
}

async function api(path, options = {}) {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...options,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || "请求失败 (" + res.status + ")");
	return data;
}

/**
 * 案头与写作台是两级，不是一排并列的页：选卷、管素材在案头，
 * 进卷之后才是稿 / 料 / 文。停在哪儿记在浏览器里，刷新不丢位置。
 */
const MODE_KEY = "novel-studio/mode";
const PROJECT_KEY = "novel-studio/project";

function readStored(key, fallback) {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		// 隐私模式下 localStorage 可能直接抛错，按没有处理。
		return fallback;
	}
}

function writeStored(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 存不下就算了，只是下次刷新回到案头。
	}
}

// ═══════════════════════════════════════════════════ 昼夜

const THEME_KEY = "novel-studio-theme";

/**
 * 切主题。暗色不是把亮色反相，而是把纸压成暖黑、把墨提成月白 ——
 * 浓淡关系照旧，所以正文在夜里读反而比白天更松。
 *
 * 首帧的主题由 index.html 里的内联脚本定（那里要在样式生效前跑完），
 * 这里只管切换与落盘。
 */
function currentTheme() {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	// 换主题时整块重绘：渐变、混入模式与合成层都要按新底色重来。
	document.body.style.transition = "none";
	void document.body.offsetHeight; // 强制回流，丢掉过渡的起点状态
	document.body.style.transition = "";
}

function toggleTheme() {
	const next = currentTheme() === "dark" ? "light" : "dark";
	applyTheme(next);
	writeStored(THEME_KEY, next);
}

// 存过主题的用户不听系统的；没存过的（含新访客）跟随系统实时变化。
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
	if (readStored(THEME_KEY, null) === null) applyTheme(event.matches ? "dark" : "light");
});

$("theme-toggle").addEventListener("click", () => toggleTheme());

// ═══════════════════════════════════════════════════ 启动

async function bootstrap() {
	const [data, library] = await Promise.all([api("/api/bootstrap"), api("/api/library")]);
	state.projects = data.projects;
	state.library = library.materials ?? [];
	renderModels(data.models, data.defaultModel);
	$("thinking-select").value = data.defaultThinkingLevel || "off";

	// 没有作品就没有写作台可言，直接落在案头。
	if (state.projects.length === 0) {
		state.mode = "home";
		applyMode();
		renderView();
		return;
	}

	// 记住上次在写哪一部、以及是停在案头还是写作台。
	const remembered = state.projects.find((project) => project.id === readStored(PROJECT_KEY, ""));
	await selectProject((remembered ?? state.projects[0]).id);
	if (readStored(MODE_KEY, "home") === "workspace") {
		state.mode = "workspace";
		applyMode();
		switchView("manuscript");
	} else {
		state.mode = "home";
		applyMode();
		renderView();
	}
}

function renderEmptyStage() {
	$("project-title").textContent = "未选择作品";
	$("project-stats").textContent = "";
	const box = $("view-manuscript");
	box.replaceChildren();
	const wrap = el("div", "void");
	wrap.append(el("h3", "", "案上尚无卷宗"));
	wrap.append(el("p", "", "回「案头」立一部新书，或先到设置里备好笔墨。"));
	box.append(wrap);
	$("stage-actions").replaceChildren();
}

function renderModels(models, defaultModel) {
	const select = $("model-select");
	select.replaceChildren();
	if (models.length === 0) {
		const option = el("option", "", "无可用模型");
		option.value = "";
		select.append(option);
		select.disabled = true;
		select.title = "请到设置中配置供应商";
		return;
	}
	select.disabled = false;
	for (const model of models) {
		const option = el("option", "", model.providerLabel + " · " + model.name);
		option.value = model.id;
		select.append(option);
	}
	const preferred = models.find((model) => model.id === defaultModel);
	if (preferred) select.value = preferred.id;
}

// ═══════════════════════════════════════════════════ 左卷

function renderChapters() {
	const list = $("chapter-list");
	list.replaceChildren();
	const project = state.project;
	if (!project || project.outline.length === 0) {
		$("chapter-empty").classList.remove("hidden");
		return;
	}
	$("chapter-empty").classList.add("hidden");

	project.outline.forEach((chapter, index) => {
		const draft = project.drafts[chapter.id];
		const words = draft ? countWords(draft.content) : 0;
		const item = el("li", "chapter-item" + (chapter.id === state.chapterId ? " is-on" : ""));
		item.append(el("span", "ord", toCn(index + 1)));
		item.append(el("span", "ct", chapter.title));
		item.append(el("span", "cw", words ? fmt(words) : "—"));
		if (!draft) item.append(el("span", "dotmark"));
		item.title = (chapter.summary || "") + "（装料 " + chapter.materialIds.length + " 条）";
		item.addEventListener("click", () => openChapter(chapter.id));
		list.append(item);
	});
}

// ═══════════════════════════════════════════════════ 视图调度

function switchView(view) {
	state.view = view;
	for (const tab of document.querySelectorAll(".tab")) {
		tab.classList.toggle("is-on", tab.dataset.view === view);
	}
	$("view-manuscript").classList.toggle("is-on", view === "manuscript");
	$("view-materials").classList.toggle("is-on", view === "materials");
	$("view-writing").classList.toggle("is-on", view === "writing");
	applyMode();
	renderView();
}

/** 只渲染当前视图。几个视图共用顶部工具条，一起渲染会互相覆盖。 */
function renderView() {
	mountStream("material");
	mountStream("writing");

	// 案头不依赖某部作品，所以要在"没有作品"的早退之前处理。
	if (state.mode === "home") return renderHomeView();

	// 兜底：写作台没有作品可写，退回案头。
	if (!state.project) {
		state.mode = "home";
		writeStored(MODE_KEY, "home");
		applyMode();
		return renderHomeView();
	}

	$("project-title").textContent = state.project.title;
	$("project-stats").textContent = state.stats
		? state.stats.chapters + " 章 · " + fmt(state.stats.words) + " 字 · " +
		  state.stats.materials + " 料 · " +
		  state.stats.coveredChapters + "/" + state.stats.chapters + " 章已装料 · " +
		  state.stats.openNotes + " 待办"
		: "";

	if (state.view === "manuscript") renderManuscriptView();
	else if (state.view === "materials") renderMaterialsBench();
	else renderWritingBench();
}

/** 案头：只画卷宗与通用素材库，顶栏换成案头的口径。 */
function renderHomeView() {
	$("project-title").textContent = "案头";
	$("project-stats").textContent =
		state.projects.length + " 部作品 · " + state.library.length + " 条通用素材";
	renderHomeBench();
}

/** 把模式落到 DOM：案头收起左卷与右案；写作台只留中台加左卷。 */
function applyMode() {
	const home = state.mode === "home";
	const desk = document.querySelector(".desk");
	desk.classList.toggle("is-home", home);
	// 两个工作台自带列表，右案此时重复。
	desk.classList.toggle("is-bench", !home && state.view !== "manuscript");
	$("leave-workspace").classList.toggle("hidden", home);
	$("view-home").classList.toggle("is-on", home);
	if (home) {
		for (const id of ["view-manuscript", "view-materials", "view-writing"]) {
			$(id).classList.remove("is-on");
		}
	}
}

/** 进卷：加载这部作品，然后进写作台。 */
async function enterProject(id) {
	if (id !== state.projectId) await selectProject(id);
	state.mode = "workspace";
	writeStored(MODE_KEY, "workspace");
	applyMode();
	switchView("manuscript");
}

/** 回案头：作品仍留在案上，只是不进写作台。 */
function leaveWorkspace() {
	state.mode = "home";
	writeStored(MODE_KEY, "home");
	applyMode();
	renderView();
}

function renderAll() {
	renderChapters();
	renderBible();
	renderView();
}

function openChapter(chapterId) {
	state.chapterId = chapterId;
	state.editing = false;
	// 换章时把作业性质收回到与本章现状相符的默认值。
	state.writeMode = state.project?.drafts[chapterId] ? "rewrite" : "create";
	switchView("manuscript");
	$("view-manuscript").scrollTop = 0;
}

// ═══════════════════════════════════════════════════ 案 · 卷宗与素材库

/**
 * 跨作品的一层：左边管作品，右边管通用素材库。
 *
 * 库里的料不属于任何一部小说。新建作品时可以取用（取的是副本），
 * 作品里改好的料也可以存回来 —— 所以这一页是"进书之前"和"出书之后"的落脚处。
 */
/** 案头左栏：卷宗列表。 */
function renderHomeBench() {
	$("project-count").textContent = state.projects.length ? state.projects.length + " 部" : "";
	const cards = $("project-cards");
	cards.replaceChildren();
	if (state.projects.length === 0) {
		cards.append(el("div", "bench-empty", "案上尚无卷宗。\n点上方「另起一卷」立一部新书。"));
	} else {
		for (const project of state.projects) cards.append(projectCard(project));
	}
	$("library-count").textContent = state.library.length ? state.library.length + " 条" : "";

	renderLibraryFilter();
	const list = $("library-list");
	list.replaceChildren();
	const filtered = state.libraryFilter
		? state.library.filter((entry) => entry.kind === state.libraryFilter)
		: state.library;
	if (filtered.length === 0) {
		list.append(
			el(
				"div",
				"bench-empty",
				state.library.length === 0
					? "库里还没有料。\n在这里手写一条，或在作品里把改好的素材「存入素材库」。"
					: "此类尚无通用素材。",
			),
		);
		return;
	}
	const groups = new Map();
	for (const entry of filtered) {
		if (!groups.has(entry.kind)) groups.set(entry.kind, []);
		groups.get(entry.kind).push(entry);
	}
	for (const [kind, entries] of groups) {
		const head = el("div", "mat-group");
		head.append(el("h3", "", kindLabel(kind)));
		head.append(el("span", "count", entries.length + " 条"));
		list.append(head);
		for (const entry of entries) list.append(libraryCard(entry));
	}
}

function projectCard(project) {
	const onDesk = project.id === state.projectId;
	const card = el("div", "card record" + (onDesk ? " is-on" : ""));
	const head = el("div", "record-head");
	head.append(el("h4", "", project.title));
	if (onDesk) head.append(el("span", "ok", "案上"));
	card.append(head);

	const line = [project.genre, project.logline].filter(Boolean).join(" · ");
	card.append(el("div", "tagline", line || "尚未题写一句话骨相"));
	card.append(
		el(
			"div",
			"tagline",
			project.stats.chapters + " 章 · " + fmt(project.stats.words) + " 字 · " +
				project.stats.materials + " 料 · " + project.stats.draftedChapters + " 章成稿" +
				(project.stats.openNotes ? " · " + project.stats.openNotes + " 待办" : ""),
		),
	);

	const actions = el("div", "mat-actions");
	actions.append(button(onDesk ? "继续写" : "开卷", "btn btn-ink btn-xs", () => void enterProject(project.id)));
	actions.append(button("改", "btn btn-quiet btn-xs", () => openProjectDialog(project)));
	const pending = state.pendingProjectDelete === project.id;
	actions.append(
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger" : ""), () =>
			void deleteProject(project),
		),
	);
	card.append(actions);
	return card;
}

async function deleteProject(project) {
	if (state.pendingProjectDelete !== project.id) {
		state.pendingProjectDelete = project.id;
		renderView();
		return;
	}
	state.pendingProjectDelete = null;
	try {
		await api("/api/projects/" + project.id, { method: "DELETE" });
	} catch (error) {
		alert("删除失败：" + error.message);
		return;
	}
	await reloadProjects();
	if (state.projectId !== project.id) {
		// 删的是别的作品：库里记的取用情况要跟着更新。
		await reloadLibrary();
		renderView();
		return;
	}

	// 删的是当前这部：清空案头，退到另一部，没有就退回空稿台。
	state.projectId = null;
	state.project = null;
	state.stats = null;
	state.chapterId = null;
	state.sessions.clear();
	state.transcripts.clear();
	state.streamKeys = { material: null, writing: null };
	$(PANES.material.stream).replaceChildren();
	$(PANES.writing.stream).replaceChildren();
	await reloadLibrary();
	if (state.projects.length > 0) await selectProject(state.projects[0].id);
	else renderEmptyStage();
	// 删完回案头：写作台已经没有可写的卷了。
	state.mode = "home";
	writeStored(MODE_KEY, "home");
	applyMode();
	renderView();
}

function renderLibraryFilter() {
	const bar = $("library-filter");
	bar.replaceChildren();
	if (state.library.length === 0) return;
	bar.append(
		button("全部 " + state.library.length, "chip" + (state.libraryFilter ? "" : " is-on"), () => {
			state.libraryFilter = "";
			renderHomeBench();
		}),
	);
	const used = new Set(state.library.map((entry) => entry.kind));
	for (const kind of Object.keys(MATERIAL_KIND_LABELS)) {
		if (!used.has(kind)) continue;
		const count = state.library.filter((entry) => entry.kind === kind).length;
		bar.append(
			button(kindLabel(kind) + " " + count, "chip" + (state.libraryFilter === kind ? " is-on" : ""), () => {
				state.libraryFilter = state.libraryFilter === kind ? "" : kind;
			renderHomeBench();
			}),
		);
	}
}

function libraryCard(entry) {
	const card = el("div", "card mat");
	const head = el("div", "mat-head");
	head.append(el("h4", "", entry.title));
	head.append(el("span", "kind", kindLabel(entry.kind)));
	card.append(head);
	if (entry.usage) card.append(el("div", "usage", "用于：" + entry.usage));

	const open = state.openMaterials.has(entry.id);
	if (open && entry.content) card.append(el("div", "mat-body", entry.content));

	const meta = [];
	if (entry.tags.length) meta.push("标签：" + entry.tags.join("、"));
	const usedBy = entry.usedBy ?? [];
	meta.push(usedBy.length ? "已用于：" + usedBy.map((use) => use.title).join("、") : "尚未被作品取用");
	if (entry.content) meta.push(fmt(countWords(entry.content)) + " 字");
	card.append(el("div", "tagline", meta.join(" · ")));

	const actions = el("div", "mat-actions");
	actions.append(button(open ? "收起" : "看全文", "btn btn-quiet btn-xs", () => toggleMaterial(entry.id)));
	actions.append(
		button("改", "btn btn-quiet btn-xs", () => openMaterialDialog({ scope: "library", mode: "edit", entry })),
	);
	const pending = state.pendingLibraryDelete === entry.id;
	actions.append(
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger" : ""), () =>
			void deleteLibraryEntry(entry),
		),
	);
	card.append(actions);
	return card;
}

async function deleteLibraryEntry(entry) {
	if (state.pendingLibraryDelete !== entry.id) {
		state.pendingLibraryDelete = entry.id;
		renderView();
		return;
	}
	state.pendingLibraryDelete = null;
	try {
		const data = await api("/api/library/" + encodeURIComponent(entry.id), { method: "DELETE" });
		state.library = data.materials ?? [];
	} catch (error) {
		alert("删除失败：" + error.message);
	}
	renderView();
}

function openProjectDialog(project) {
	state.editingProjectId = project ? project.id : null;
	state.libraryPick = new Set();
	state.libraryPickQuery = "";

	const form = $("project-form");
	form.reset();
	$("project-form-error").textContent = "";
	$("library-pick-search").value = "";
	$("project-form-title").textContent = project ? "修改卷宗" : "另起一卷";
	$("project-form-hint").textContent = project
		? "改的是题名与规约，已有的章目、素材与正文都不动。"
		: "只填书名就能开卷。骨相、字数、规约都在「更多设置」里，可留空，之后在「案头 → 改」里补。";
	form.querySelector("button[type=submit]").textContent = project ? "存入" : "立卷";
	// 新建时收起「更多设置」；改已有的则展开 —— 那正是要改的东西。
	$("project-more").open = Boolean(project);
	// 取用只在新建时有意义。
	$("library-pick").closest(".field-grow").classList.toggle("hidden", Boolean(project));

	if (project) {
		form.elements.title.value = project.title;
		form.elements.genre.value = project.genre;
		form.elements.logline.value = project.logline;
		form.elements.styleGuide.value = project.styleGuide;
		form.elements.targetWords.value = project.targetWords || "";
	}

	renderLibraryPick();
	$("project-dialog").showModal();
}

/** 新建作品时的库勾选列表。 */
function renderLibraryPick() {
	const box = $("library-pick");
	box.replaceChildren();
	const count = $("library-pick-count");
	const syncCount = () => {
		count.textContent = state.libraryPick.size ? " · 已选 " + state.libraryPick.size + " 条" : "";
	};
	syncCount();

	if (state.library.length === 0) {
		box.append(el("div", "bench-empty", "素材库还是空的。\n先在「案」右侧收录几条，或稍后在作品里把料存进来。"));
		return;
	}
	const query = state.libraryPickQuery.trim().toLowerCase();
	const list = query
		? state.library.filter(
				(entry) =>
					entry.title.toLowerCase().includes(query) ||
					entry.usage.toLowerCase().includes(query) ||
					entry.tags.some((tag) => tag.toLowerCase().includes(query)),
			)
		: state.library;
	if (list.length === 0) {
		box.append(el("div", "bench-empty", "没有符合条件的通用素材。"));
		return;
	}

	for (const entry of list) {
		const picked = state.libraryPick.has(entry.id);
		const row = el("label", "pick-row" + (picked ? " is-on" : ""));
		const check = document.createElement("input");
		check.type = "checkbox";
		check.checked = picked;
		check.addEventListener("change", () => {
			if (check.checked) state.libraryPick.add(entry.id);
			else state.libraryPick.delete(entry.id);
			row.classList.toggle("is-on", check.checked);
			syncCount();
		});
		row.append(check);

		const body = el("div", "pick-body");
		const title = el("div", "pick-title");
		title.append(el("span", "kind", kindLabel(entry.kind)));
		title.append(el("span", "", entry.title));
		body.append(title);
		if (entry.usage) body.append(el("div", "pick-usage", entry.usage));
		row.append(body);
		box.append(row);
	}
}

$("library-pick-search").addEventListener("input", (event) => {
	state.libraryPickQuery = event.target.value;
	renderLibraryPick();
});

// ── 存入素材库

/** 待收进库的那条作品素材。 */
let promoteTarget = null;

function openPromoteDialog(material) {
	promoteTarget = material;
	const form = $("promote-form");
	form.reset();
	form.elements.title.value = material.title;
	$("promote-error").textContent = "";

	const origin = material.originId
		? state.library.find((entry) => entry.id === material.originId)
		: undefined;
	const modes = $("promote-modes");
	modes.replaceChildren();

	if (origin) {
		$("promote-desc").textContent =
			"这条素材取自素材库《" + origin.title + "》。更新会覆盖库里那一条；别的作品不受影响 —— 它们手里是副本。";
		const group = el("div", "promote-group");
		for (const [value, label, checked] of [
			["update", "更新《" + origin.title + "》这一条", true],
			["create", "另存为新条目", false],
		]) {
			const row = el("label", "promote-option");
			const radio = document.createElement("input");
			radio.type = "radio";
			radio.name = "mode";
			radio.value = value;
			radio.checked = checked;
			row.append(radio, el("span", "", label));
			group.append(row);
		}
		modes.append(group);
	} else {
		$("promote-desc").textContent =
			"这条素材会作为新的通用素材收进库里，之后新建作品时就能取用。";
	}
	$("promote-dialog").showModal();
}

// ═══════════════════════════════════════════════════ 稿

function renderManuscriptView() {
	const box = $("view-manuscript");
	const project = state.project;
	box.replaceChildren();
	$("stage-actions").replaceChildren();

	if (!state.chapterId) renderFrontMatter(box, project);
	else renderChapter(box, project);

	$("project-stats").textContent = state.stats
		? state.stats.chapters + " 章 · " + fmt(state.stats.words) + " 字 · " +
		  state.stats.materials + " 料 · " +
		  state.stats.coveredChapters + "/" + state.stats.chapters + " 章已装料 · " +
		  state.stats.openNotes + " 待办"
		: "";
}

function renderFrontMatter(box, project) {
	$("stage-actions").append(
		button("拟新章", "btn btn-quiet btn-sm", () => {
			switchView("materials");
			$("material-input").value = "接着现有的情节往后拟一章，先用 update_outline 立下章目再落笔。";
			$("material-input").focus();
		}),
	);

	const page = el("div", "front-matter");
	const head = el("div", "front-head");
	head.append(el("h2", "", project.title));
	head.append(el("p", "", [project.genre, project.logline].filter(Boolean).join(" · ") || "尚未题写一句话骨相"));
	page.append(head);

	if (project.outline.length === 0) {
		page.append(el("div", "empty-hint", "章目尚虚。切到「料」，让设定官先把骨节列出来。"));
	} else {
		const toc = el("ol", "toc");
		project.outline.forEach((chapter, index) => {
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const item = el("li", "toc-item");
			item.append(el("h3", "", chapter.title));
			item.append(el("p", "", chapter.summary || "（未写要略）"));
			const bits = ["第 " + toCn(index + 1) + " 章", chapter.status, chapter.pov];
			if (chapter.targetWords) bits.push("目标 " + fmt(chapter.targetWords) + " 字");
			if (words) bits.push("已成 " + fmt(words) + " 字");
			bits.push("装料 " + chapter.materialIds.length + " 条");
			item.append(el("div", "toc-meta", bits.filter(Boolean).join(" · ")));
			item.addEventListener("click", () => openChapter(chapter.id));
			toc.append(item);
		});
		page.append(toc);
	}
	box.append(page);
}

function renderChapter(box, project) {
	const index = project.outline.findIndex((chapter) => chapter.id === state.chapterId);
	const chapter = project.outline[index];
	if (!chapter) {
		state.chapterId = null;
		renderFrontMatter(box, project);
		return;
	}
	const draft = project.drafts[state.chapterId];
	const content = draft ? draft.content : "";
	const words = countWords(content);

	const prev = project.outline[index - 1];
	const next = project.outline[index + 1];
	if (prev) $("stage-actions").append(navButton(prev.id, "前章"));
	$("stage-actions").append(el("span", "muted", toCn(index + 1) + " / " + toCn(project.outline.length)));
	if (next) $("stage-actions").append(navButton(next.id, "后章"));

	const page = el("div", "ms-page");
	const head = el("div", "ms-head");
	head.append(el("p", "ms-kicker", "第 " + toCn(index + 1) + " 章" + (chapter.pov ? " · " + chapter.pov : "")));
	head.append(el("h1", "ms-title", chapter.title));
	head.append(el("div", "ms-rule"));
	const meta = [];
	if (words) meta.push(fmt(words) + " 字");
	if (draft) meta.push("第 " + draft.revision + " 稿");
	if (chapter.targetWords) meta.push("目标 " + fmt(chapter.targetWords) + " 字");
	meta.push("装料 " + chapter.materialIds.length + " 条");
	head.append(el("p", "ms-meta", meta.join(" · ")));
	page.append(head);

	if (state.editing) {
		const editor = document.createElement("textarea");
		editor.className = "ms-edit";
		editor.value = content;
		editor.placeholder = "此处落笔。空行分段。";
		page.append(editor);
	} else if (content) {
		const text = el("article", "ms-text");
		for (const para of content.split(/\n+/)) {
			const trimmed = para.trim();
			if (trimmed) text.append(el("p", "", trimmed));
		}
		page.append(text);
	} else {
		page.append(el("div", "ms-blank", "此章尚无正文。切到「文」，装配素材后让执笔者落笔。"));
	}

	box.append(page);
	box.append(chapterToolbar(chapter, index, content));
}

function navButton(id, label) {
	return button(label, "btn btn-quiet btn-sm", () => openChapter(id));
}

function chapterToolbar(chapter, index, content) {
	const bar = el("div", "actions actions-center");

	if (state.editing) {
		const save = button("存稿", "btn btn-ink btn-sm", async () => {
			const editor = $("view-manuscript").querySelector(".ms-edit");
			if (!editor) return;
			save.disabled = true;
			try {
				await saveChapter(state.chapterId, editor.value);
				state.editing = false;
			} catch (error) {
				alert("存稿失败：" + error.message);
			} finally {
				save.disabled = false;
			}
		});
		bar.append(save);
		bar.append(
			button("作罢", "btn btn-quiet btn-sm", () => {
				state.editing = false;
				renderView();
			}),
		);
	} else {
		bar.append(
			button(content ? "改稿" : "起稿", "btn btn-sm", () => {
				state.editing = true;
				renderView();
			}),
		);
	}

	// 成文动作在生文工作台里做，这里只负责把作者送过去。
	bar.append(
		button(content ? "重写此章" : "装料成文", "btn btn-ink btn-sm", () => {
			switchView("writing");
			$("writing-input").focus();
		}),
	);
	bar.append(
		button("让执笔者评此章", "btn btn-quiet btn-sm", () => {
			switchView("writing");
			$("writing-input").value = "读一下第" + toCn(index + 1) + "章《" + chapter.title + "》，说说问题在哪，先别改。";
			$("writing-input").focus();
		}),
	);
	return bar;
}

async function saveChapter(chapterId, content) {
	return api("/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(chapterId), {
		method: "PATCH",
		body: { content },
	});
}

// ═══════════════════════════════════════════════════ 料 · 素材工作台

function renderMaterialsBench() {
	const project = state.project;
	if (!project) return;
	$("stage-actions").replaceChildren();
	$("stage-actions").append(
		button("让设定官查缺", "btn btn-quiet btn-sm", () => {
			$("material-input").value = "先 list_notes 看现有待办，再看素材库里缺什么，把缺的补上。";
			$("material-input").focus();
		}),
	);

	renderUploads();

	const filterBar = $("material-filter");
	filterBar.replaceChildren();
	filterBar.append(
		button("全部 " + project.materials.length, "chip" + (state.materialFilter ? "" : " is-on"), () => {
			state.materialFilter = "";
			renderMaterialsBench();
		}),
	);
	const used = new Set(project.materials.map((material) => material.kind));
	for (const kind of Object.keys(MATERIAL_KIND_LABELS)) {
		if (!used.has(kind)) continue;
		const count = project.materials.filter((material) => material.kind === kind).length;
		filterBar.append(
			button(kindLabel(kind) + " " + count, "chip" + (state.materialFilter === kind ? " is-on" : ""), () => {
				state.materialFilter = state.materialFilter === kind ? "" : kind;
				renderMaterialsBench();
			}),
		);
	}
	$("material-count").textContent = project.materials.length ? project.materials.length + " 条" : "";

	renderPickedMaterials();

	const list = $("material-list");
	list.replaceChildren();
	const filtered = state.materialFilter
		? project.materials.filter((material) => material.kind === state.materialFilter)
		: project.materials;
	if (filtered.length === 0) {
		list.append(
			el(
				"div",
				"bench-empty",
				project.materials.length === 0
					? "素材库还是空的。\n左边上传资料，或直接交代要立什么设定 —— 素材是一切之先。"
					: "此类尚无素材。",
			),
		);
		return;
	}
	const groups = new Map();
	for (const material of filtered) {
		if (!groups.has(material.kind)) groups.set(material.kind, []);
		groups.get(material.kind).push(material);
	}
	for (const [kind, materials] of groups) {
		const head = el("div", "mat-group");
		head.append(el("h3", "", kindLabel(kind)));
		head.append(el("span", "count", materials.length + " 条"));
		list.append(head);
		for (const material of materials) list.append(materialCard(material));
	}
}

/** 素材卡。紧凑模式下收起动作，点一下即可修改。 */
function materialCard(material, options = {}) {
	const card = el("div", "card mat");
	if (state.pickedMaterials.has(material.id)) card.classList.add("is-picked");
	const head = el("div", "mat-head");
	head.append(el("h4", "", material.title));
	head.append(el("span", "kind", kindLabel(material.kind)));
	if (material.status === "confirmed") head.append(el("span", "ok", "已确认"));
	card.append(head);

	if (material.usage) card.append(el("div", "usage", "用于：" + material.usage));

	const open = state.openMaterials.has(material.id);
	if (open && material.content) card.append(el("div", "mat-body", material.content));

	const meta = [];
	if (material.tags.length) meta.push("标签：" + material.tags.join("、"));
	const names = material.chapterIds.map(chapterTitleOf).filter(Boolean);
	if (names.length) meta.push("已装入：" + names.join("、"));
	const sourceLabel =
		material.source === "agent" ? "墨客所拟" : material.source === "library" ? "取自素材库" : "书者所定";
	meta.push(material.originId ? sourceLabel + " · 已入素材库" : sourceLabel);
	if (material.content) meta.push(fmt(countWords(material.content)) + " 字");
	card.append(el("div", "tagline", meta.join(" · ")));

	if (options.compact) {
		card.classList.add("is-compact");
		card.addEventListener("click", () => openMaterialDialog({ mode: "edit", material }));
		return card;
	}

	const actions = el("div", "mat-actions");
	actions.append(button(open ? "收起" : "看全文", "btn btn-quiet btn-xs", () => toggleMaterial(material.id)));

	if (state.chapterId) {
		const chapter = state.project.outline.find((item) => item.id === state.chapterId);
		const inChapter = chapter ? chapter.materialIds.includes(material.id) : false;
		actions.append(
			button(inChapter ? "从本章摘除" : "装入本章", "btn btn-quiet btn-xs", () =>
				void assemble(inChapter ? [] : [material.id], inChapter ? [material.id] : []),
			),
		);
	}

	const picked = state.pickedMaterials.has(material.id);
	actions.append(
		button(picked ? "已选中" : "选中修改", "btn btn-quiet btn-xs" + (picked ? " is-on" : ""), () =>
			toggleMaterialPick(material.id),
		),
	);
	actions.append(button("改", "btn btn-quiet btn-xs", () => openMaterialDialog({ mode: "edit", material })));
	actions.append(
		button(material.originId ? "更新素材库" : "存入素材库", "btn btn-quiet btn-xs", () =>
			openPromoteDialog(material),
		),
	);
	const pending = state.pendingDelete === material.id;
	actions.append(
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger" : ""), () =>
			void deleteMaterial(material),
		),
	);
	card.append(actions);
	return card;
}

function toggleMaterial(id) {
	if (state.openMaterials.has(id)) state.openMaterials.delete(id);
	else state.openMaterials.add(id);
	renderView();
	renderBible();
}

/** 点选素材：选中若干条再交代怎么改，设定官就照着改这几条。 */
function toggleMaterialPick(id) {
	if (state.pickedMaterials.has(id)) state.pickedMaterials.delete(id);
	else state.pickedMaterials.add(id);
	renderView();
}

/** 素材工作台输入框上方的「已选中」条。 */
function renderPickedMaterials() {
	const bar = $("material-picked");
	if (!bar) return;
	const picked = [...state.pickedMaterials].map(materialById).filter(Boolean);
	if (picked.length === 0) {
		bar.replaceChildren();
		bar.classList.add("hidden");
		return;
	}
	bar.classList.remove("hidden");
	bar.replaceChildren(el("span", "picked-label", "已选 " + picked.length + " 条，交代怎么改："));
	for (const material of picked) bar.append(el("span", "picked-chip", "《" + material.title + "》"));
	bar.append(
		button("清空", "btn btn-quiet btn-xs", () => {
			state.pickedMaterials = new Set();
			renderView();
		}),
	);
}

/**
 * 把选中的素材拼成指令前缀。
 *
 * 只把需求发过去，设定官不知道要改哪一条，很可能又新建一条。这里把 id 明确写进指令，
 * 并要求只改点名的字段。发完即清空选择：同一批料不该被反复改。
 */
function withPickedMaterials(text) {
	const picked = [...state.pickedMaterials].map(materialById).filter(Boolean);
	state.pickedMaterials = new Set();
	if (picked.length === 0) return text;
	const list = picked.map((material) => "- 《" + material.title + "》（id: " + material.id + "）").join("\n");
	return (
		"【本次只改这几条已有素材】\n" + list + "\n" +
		"请用 upsert_material 带上对应 id，只传要改的字段，其余字段保持原样；不要新建素材。\n\n" +
		"要求：" + text
	);
}

function chapterTitleOf(id) {
	const project = state.project;
	const index = project ? project.outline.findIndex((chapter) => chapter.id === id) : -1;
	const chapter = index >= 0 ? project.outline[index] : undefined;
	return chapter ? "第" + toCn(index + 1) + "章《" + chapter.title + "》" : null;
}
function materialById(id) {
	return state.project ? state.project.materials.find((material) => material.id === id) : undefined;
}

/** 直接装料 / 摘料。与智能体的 attach_materials 写的是同一份数据。 */
async function assemble(add, remove) {
	if (!state.chapterId) {
		alert("先在左栏点开一章。");
		return;
	}
	try {
		await api(
			"/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(state.chapterId) + "/materials",
			{ method: "POST", body: { add, remove } },
		);
	} catch (error) {
		alert("装料失败：" + error.message);
		return;
	}
	await reloadProject();
}

async function deleteMaterial(material) {
	if (state.pendingDelete !== material.id) {
		state.pendingDelete = material.id;
		renderView();
		renderBible();
		return;
	}
	state.pendingDelete = null;
	try {
		await api("/api/projects/" + state.projectId + "/materials/" + encodeURIComponent(material.id), {
			method: "DELETE",
		});
	} catch (error) {
		alert("删除失败：" + error.message);
	}
	await reloadProject();
}

// ── 上传原料

async function handleFiles(files) {
	if (!state.projectId) return;
	for (const file of files) {
		const entry = { id: crypto.randomUUID(), filename: file.name, status: "loading" };
		state.uploads.unshift(entry);
		renderUploads();
		try {
			const res = await fetch(
				"/api/projects/" + state.projectId + "/uploads?filename=" + encodeURIComponent(file.name),
				{ method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
			);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "上传失败 (" + res.status + ")");
			Object.assign(entry, { status: "ready" }, data.upload);
		} catch (error) {
			Object.assign(entry, { status: "error", error: error.message });
		}
		renderUploads();
	}
}

function renderUploads() {
	const list = $("upload-list");
	if (!list) return;
	list.replaceChildren();
	for (const entry of state.uploads) {
		const row = el("li", "upload-item" + (entry.status === "error" ? " is-error" : ""));
		const head = el("div", "upload-head");
		head.append(el("span", "upload-name", entry.filename));
		if (entry.status === "loading") head.append(el("span", "upload-state", "解析中…"));
		else if (entry.status === "error") head.append(el("span", "upload-state", "✕ 未取到文字"));
		else if (entry.status === "stored") head.append(el("span", "upload-state", "已入库"));
		else if (entry.status === "sent") head.append(el("span", "upload-state", "已交提炼"));
		else head.append(el("span", "upload-state", fmtNum(entry.text.length) + " 字"));
		row.append(head);

		if (entry.status === "error") {
			row.append(el("div", "upload-note", entry.error));
		} else if (entry.status === "ready") {
			if (entry.truncated) {
				row.append(
					el("div", "upload-note", "原文 " + fmtNum(entry.originalChars) + " 字，只取到前 " + fmtNum(entry.text.length) + " 字"),
				);
			}
			if (entry.text.length > 60000) {
				row.append(
					el("div", "upload-note warn", "篇幅很长，交墨客会占掉大量上下文，可能要等很久或超出模型窗口"),
				);
			}
			row.append(el("div", "upload-preview", entry.text.slice(0, 140).replace(/\n+/g, " ") + "…"));

			const actions = el("div", "upload-actions");
			actions.append(button("存入素材库", "btn btn-quiet btn-xs", () => openMaterialDialog({ mode: "create", upload: entry })));
			actions.append(button("交墨客提炼", "btn btn-quiet btn-xs", () => void refineUpload(entry)));
			actions.append(
				button("丢弃", "btn btn-quiet btn-xs", () => {
					state.uploads = state.uploads.filter((item) => item !== entry);
					renderUploads();
				}),
			);
			row.append(actions);
		}
		list.append(row);
	}
}

/** 把整篇资料丢给设定官，让它拆成素材条目。 */
async function refineUpload(entry) {
	if (state.streaming) return;
	entry.status = "sent";
	renderUploads();
	await sendMessage(
		"material",
		"以下是我上传的资料《" + entry.title + "》。请从中提炼素材：人物、世界观、场景地点、桥段、伏笔各归其类，" +
			"逐条用 upsert_material 落盘，usage 写清什么情况下该用。" +
			(entry.truncated ? "（原文过长，只有前 " + entry.text.length + " 字。）" : "") +
			"\n\n---- 资料开始 ----\n" + entry.text + "\n---- 资料结束 ----",
	);
}

// ── 素材表单

function openMaterialDialog(options) {
	const scope = options.scope ?? "project";
	materialForm = {
		scope,
		mode: options.mode,
		uploadId: options.upload?.id ?? null,
		materialId: options.material?.id ?? null,
		libraryId: options.entry?.id ?? null,
	};
	const form = $("material-form");
	form.reset();
	$("material-form-error").textContent = "";

	const select = $("material-form-kind");
	select.replaceChildren();
	for (const [kind, label] of Object.entries(MATERIAL_KIND_LABELS)) {
		const option = el("option", "", label);
		option.value = kind;
		select.append(option);
	}

	const hint = $("material-form-hint");
	const source = options.entry ?? options.material;
	if (source) {
		$("material-form-title").textContent = scope === "library" ? "修改通用素材" : "修改素材";
		select.value = source.kind;
		form.elements.title.value = source.title;
		form.elements.usage.value = source.usage;
		form.elements.tags.value = source.tags.join("、");
		form.elements.content.value = source.content;
		hint.textContent =
			scope === "library"
				? "这是通用素材。改它只影响库里这一条 —— 已经取用过的作品手里是各自的副本。"
				: "改完点「存入」，改动直接落到这部作品的素材库。";
	} else {
		$("material-form-title").textContent =
			scope === "library" ? "收录一条通用素材" : options.upload ? "存入素材库" : "新建素材";
		select.value = "research";
		form.elements.title.value = options.upload?.title ?? "";
		form.elements.usage.value = "";
		form.elements.tags.value = "";
		form.elements.content.value = options.upload?.text ?? "";
		hint.textContent =
			scope === "library"
				? "收录进通用素材库，之后新建任何一部作品都可以取用。"
				: options.upload
					? "整篇资料会成为这一条素材的内容。想按人物、场景拆成多条，改用「交墨客提炼」。"
					: "";
	}
	$("material-dialog").showModal();
}

$("material-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const error = $("material-form-error");
	const values = Object.fromEntries(new FormData(form).entries());
	const tags = String(values.tags ?? "")
		.split(/[,，、]/)
		.map((tag) => tag.trim())
		.filter(Boolean);
	const body = {
		kind: values.kind,
		title: values.title,
		usage: values.usage,
		content: values.content,
		tags,
	};
	error.textContent = "";
	const submit = form.querySelector("button[type=submit]");
	submit.disabled = true;
	try {
		const scope = materialForm.scope;
		if (scope === "library") {
			// 通用素材库：新建或改。服务端每次回整份库视图，直接接住即可。
			const path = materialForm.libraryId
				? "/api/library/" + encodeURIComponent(materialForm.libraryId)
				: "/api/library";
			const data = await api(path, { method: materialForm.libraryId ? "PATCH" : "POST", body });
			state.library = data.materials ?? state.library;
		} else if (materialForm.mode === "edit") {
			await api("/api/projects/" + state.projectId + "/materials/" + encodeURIComponent(materialForm.materialId), {
				method: "PATCH",
				body,
			});
		} else {
			await api("/api/projects/" + state.projectId + "/materials", { method: "POST", body });
			const entry = state.uploads.find((item) => item.id === materialForm.uploadId);
			if (entry) entry.status = "stored";
		}
		$("material-dialog").close();
		renderUploads();
		// 库里改名会影响作品卡上的"已入素材库"标注，所以两边都刷。
		if (state.projectId) await reloadProject();
		renderView();
	} catch (err) {
		error.textContent = err.message;
	} finally {
		submit.disabled = false;
	}
});

$("material-form-cancel").addEventListener("click", () => $("material-dialog").close());

// ═══════════════════════════════════════════════════ 文 · 生文工作台

function renderWritingBench() {
	const project = state.project;
	if (!project) return;
	$("stage-actions").replaceChildren();
	$("stage-actions").append(
		button("让设定官补料", "btn btn-quiet btn-sm", () => {
			switchView("materials");
			$("material-input").value = "看看第一章还缺什么料，补齐。";
			$("material-input").focus();
		}),
	);

	const assemblyBox = $("assembly-list");
	const poolBox = $("pool-list");
	const actions = $("write-actions");
	assemblyBox.replaceChildren();
	poolBox.replaceChildren();
	actions.replaceChildren();

	const chapter = project.outline.find((item) => item.id === state.chapterId);
	if (!chapter) {
		const hasChapters = project.outline.length > 0;
		$("assembly-chapter").textContent = hasChapters ? "未选章节" : "尚无章目";
		// 没有章节就没有装配落点，但库里的料仍然要看得见 ——
		// 否则「刚生成完素材，到生文工作台却什么都没有」。
		assemblyBox.append(
			el(
				"div",
				"bench-empty",
				hasChapters ? "先在左栏点开一章，再装料。" : "这部作品还没有章节。先立一章，再把料装进去。",
			),
		);
		assemblyBox.append(button("＋ 立一章", "btn btn-ink btn-sm", () => openChapterDialog()));
		const allMaterials = project.materials;
		$("pool-count").textContent = allMaterials.length ? allMaterials.length + " 条" : "";
		if (allMaterials.length === 0) {
			poolBox.append(el("div", "bench-empty", "素材库是空的。到「料」上传资料或让设定官备料。"));
		} else {
			poolBox.append(el("div", "bench-hint", "先立一章，才能把料装进去。"));
			for (const material of allMaterials) poolBox.append(assemblyRow(material, "pool", true));
		}
		return;
	}

	const index = project.outline.findIndex((item) => item.id === chapter.id);
	const draft = project.drafts[chapter.id];
	const words = draft ? countWords(draft.content) : 0;
	$("assembly-chapter").textContent =
		"第" + toCn(index + 1) + "章《" + chapter.title + "》 · " + chapter.status +
		(words ? " · 已成 " + fmt(words) + " 字" : " · 尚无正文");

	const assembled = chapter.materialIds.map(materialById).filter(Boolean);
	if (assembled.length === 0) {
		assemblyBox.append(el("div", "bench-empty", "本章还没装料。正文由素材组装而成 —— 先从下面挑几条。"));
	} else {
		for (const material of assembled) assemblyBox.append(assemblyRow(material, "assembled"));
	}

	const modeSelect = document.createElement("select");
	modeSelect.className = "mode-select";
	for (const [value, label] of [["create", "从零写起"], ["rewrite", "整章重写"], ["continue", "续写下去"]]) {
		const option = el("option", "", label);
		option.value = value;
		modeSelect.append(option);
	}
	modeSelect.value = state.writeMode;
	modeSelect.addEventListener("change", () => {
		state.writeMode = modeSelect.value;
	});
	actions.append(modeSelect);
	// 「交代」在点按钮时才读：渲染一次就取值的话，作者打了一半的字会丢。
	actions.append(
		button("装料成文", "btn btn-ink btn-sm", () => void runWrite(modeSelect.value, $("writing-input").value.trim())),
	);
	actions.append(
		el(
			"span",
			"actions-note",
			assembled.length === 0
				? "没有素材，写不出正文"
				: "带 " + assembled.length + " 条料交给执笔者；下方输入框里的交代会一并附上",
		),
	);

	const pool = project.materials.filter((material) => !chapter.materialIds.includes(material.id));
	$("pool-count").textContent = pool.length ? pool.length + " 条" : "";
	if (pool.length === 0) {
		poolBox.append(
			el(
				"div",
				"bench-empty",
				project.materials.length === 0
					? "素材库是空的。到「料」上传资料或让设定官备料。"
					: "库里的料都装上了。",
			),
		);
	} else {
		for (const material of pool) poolBox.append(assemblyRow(material, "pool"));
	}
}

function assemblyRow(material, variant, locked = false) {
	const row = el("div", "as-row" + (variant === "pool" ? " is-pool" : ""));
	const head = el("div", "as-head");
	head.append(el("span", "kind", kindLabel(material.kind)));
	head.append(el("span", "as-title", material.title));
	row.append(head);
	if (material.usage) row.append(el("div", "as-usage", material.usage));

	const open = state.openMaterials.has(material.id);
	const actions = el("div", "as-actions");
	actions.append(button(open ? "收起" : "看全文", "btn btn-quiet btn-xs", () => toggleMaterial(material.id)));
	if (variant === "assembled") {
		actions.append(button("摘除", "btn btn-quiet btn-xs", () => void assemble([], [material.id])));
	} else if (locked) {
		// 还没有章节：料看得见，但没地方装。按钮停用，指向「立一章」。
		const btn = button("装入本章", "btn btn-quiet btn-xs", () => {});
		btn.disabled = true;
		btn.title = "先立一章，才有落点";
		actions.append(btn);
	} else {
		actions.append(button("装入本章", "btn btn-quiet btn-xs", () => void assemble([material.id], [])));
	}
	row.append(actions);
	if (open) row.append(el("div", "as-body", material.content));
	return row;
}

/** 立一章的对话框。 */
function openChapterDialog() {
	const form = $("chapter-form");
	form.reset();
	$("chapter-error").textContent = "";
	form.elements.title.value = "第" + toCn((state.project?.outline.length ?? 0) + 1) + "章";
	$("chapter-dialog").showModal();
	form.elements.title.select();
}

$("add-chapter").addEventListener("click", () => openChapterDialog());
$("chapter-cancel").addEventListener("click", () => $("chapter-dialog").close());
$("chapter-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const error = $("chapter-error");
	const values = Object.fromEntries(new FormData(form).entries());
	const title = String(values.title ?? "").trim();
	if (!title) {
		error.textContent = "请填写标题";
		return;
	}
	error.textContent = "";
	const submit = form.querySelector("button[type=submit]");
	submit.disabled = true;
	try {
		const data = await api("/api/projects/" + state.projectId + "/chapters", {
			method: "POST",
			body: {
				title,
				summary: String(values.summary ?? "").trim(),
				targetWords: values.targetWords ? Number(values.targetWords) : 0,
			},
		});
		$("chapter-dialog").close();
		// 立完就选中它并切到生文工作台：立章的目的就是接着装料。
		state.chapterId = data.chapter?.id ?? null;
		state.writeMode = "create";
		await reloadProject();
		switchView("writing");
	} catch (err) {
		error.textContent = err.message;
	} finally {
		submit.disabled = false;
	}
});

/** 一次性成文：服务端算好组装上下文，交给写作智能体流式落盘。 */
async function runWrite(mode, note) {
	if (state.streaming) return;
	const chapterId = state.chapterId;
	if (!chapterId || !state.project) return;

	if (state.project.materials.length === 0) {
		appendMessage("writing", "error", "素材库还是空的。先到「料」上传资料或让设定官备料。");
		return;
	}
	const chapter = state.project.outline.find((item) => item.id === chapterId);
	const label = mode === "rewrite" ? "重写" : mode === "continue" ? "续写" : "成文";
	appendMessage("writing", "user", label + "《" + (chapter ? chapter.title : chapterId) + "》" + (note ? "：" + note : ""));
	if (note) $("writing-input").value = "";

	state.writeAbort = new AbortController();
	setStreaming("writing");
	try {
		const res = await fetch(
			"/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(chapterId) + "/write",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: state.writeAbort.signal,
				body: JSON.stringify({
					modelRef: $("model-select").value,
					thinkingLevel: $("thinking-select").value,
					mode,
					...(note ? { note } : {}),
				}),
			},
		);
		if (!res.ok || !res.body) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "请求失败 (" + res.status + ")");
		}
		await pumpStream(res, "writing");
	} catch (error) {
		if (error.name !== "AbortError") appendMessage("writing", "error", error.message);
	} finally {
		state.writeAbort = null;
		setStreaming(null);
		await reloadProject();
	}
}

// ═══════════════════════════════════════════════════ 右案

function renderBible() {
	const box = $("bible");
	box.replaceChildren();
	const project = state.project;
	if (!project) return;

	if (state.bibleTab === "materials") {
		if (project.materials.length === 0) {
			box.append(el("div", "bible-empty", "素材库是空的"));
			return;
		}
		for (const material of project.materials) box.append(materialCard(material, { compact: true }));
		return;
	}

	if (state.bibleTab === "outline") {
		if (project.outline.length === 0) {
			box.append(el("div", "bible-empty", "章目尚虚"));
			return;
		}
		project.outline.forEach((chapter, index) => {
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const card = el("div", "card");
			card.append(el("h4", "", toCn(index + 1) + " · " + chapter.title));
			card.append(el("div", "tagline", chapter.summary || "（未写要略）"));
			const meta = [chapter.status, chapter.pov];
			if (words) meta.push(fmt(words) + " 字");
			meta.push("装料 " + chapter.materialIds.length + " 条");
			card.append(el("div", "tagline", meta.filter(Boolean).join(" · ")));
			card.style.cursor = "pointer";
			card.addEventListener("click", () => openChapter(chapter.id));
			box.append(card);
		});
		return;
	}

	const open = project.notes.filter((note) => note.status === "open");
	if (open.length === 0) {
		box.append(el("div", "bible-empty", "无待办事项"));
		return;
	}
	for (const note of open) {
		const row = el("div", "note " + note.severity);
		row.append(el("span", "note-mark"));
		const body = el("div", "note-body");
		body.append(el("div", "note-where", note.category + " · " + note.subject));
		body.append(el("div", "note-text", note.description));
		row.append(body);
		box.append(row);
	}
}

// ═══════════════════════════════════════════════════ 工程

async function selectProject(id) {
	state.projectId = id;
	writeStored(PROJECT_KEY, id);
	state.sessions.clear();
	state.transcripts.clear();
	state.streamKeys = { material: null, writing: null };
	state.chapterId = null;
	state.editing = false;
	state.uploads = [];
	state.openMaterials.clear();
	state.pendingDelete = null;
	state.pendingProjectDelete = null;
	state.streaming = null;
	$(PANES.material.stream).replaceChildren();
	$(PANES.writing.stream).replaceChildren();

	await reloadProject();
	appendMessage("material", "assistant", "《" + state.project.title + "》已展上案头。左边上传资料，或直接交代要立什么设定。");
	appendMessage("writing", "assistant", "执笔者在此。左栏装配本章素材，或直接交代要写什么。");
}

async function reloadProjects() {
	const data = await api("/api/projects");
	state.projects = data.projects;
}

async function reloadLibrary() {
	const data = await api("/api/library");
	state.library = data.materials ?? [];
}

async function reloadProject() {
	const data = await api("/api/projects/" + state.projectId);
	state.project = data.project;
	state.stats = data.stats;
	if (state.chapterId && !state.project.outline.some((chapter) => chapter.id === state.chapterId)) {
		state.chapterId = null;
	}
	renderAll();
}

$("leave-workspace").addEventListener("click", () => leaveWorkspace());

// 「另起一卷」在案头左栏的卷宗头上。
for (const node of document.querySelectorAll('[data-action="new-project"]')) {
	node.addEventListener("click", () => openProjectDialog(null));
}
for (const node of document.querySelectorAll('[data-action="new-library"]')) {
	node.addEventListener("click", () => openMaterialDialog({ scope: "library", mode: "create" }));
}


$("project-form-cancel").addEventListener("click", () => $("project-dialog").close());

$("project-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const error = $("project-form-error");
	const values = Object.fromEntries(new FormData(form).entries());
	const body = {
		title: values.title,
		genre: values.genre,
		logline: values.logline,
		styleGuide: values.styleGuide,
		targetWords: values.targetWords ? Number(values.targetWords) : 0,
	};
	error.textContent = "";
	const submit = form.querySelector("button[type=submit]");
	submit.disabled = true;
	try {
		if (state.editingProjectId) {
			const editing = state.editingProjectId;
			await api("/api/projects/" + editing, { method: "PATCH", body });
			$("project-dialog").close();
			await reloadProjects();
			if (editing === state.projectId) await reloadProject();
			renderView();
		} else {
			const taken = state.libraryPick.size;
			const result = await api("/api/projects", {
				method: "POST",
				body: { ...body, libraryIds: [...state.libraryPick] },
			});
			state.libraryPick = new Set();
			$("project-dialog").close();
			await reloadProjects();
			await selectProject(result.project.id);
			if (taken > 0) {
				appendMessage("material", "assistant", "已从通用素材库取用 " + taken + " 条料，副本在这部作品的素材库里。");
			}
		}
	} catch (err) {
		error.textContent = err.message;
	} finally {
		submit.disabled = false;
	}
});

$("promote-cancel").addEventListener("click", () => $("promote-dialog").close());

$("promote-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const error = $("promote-error");
	const title = form.elements.title.value.trim();
	if (!title) {
		error.textContent = "请填写标题";
		return;
	}
	if (!promoteTarget) return;
	const mode = form.querySelector('input[name="mode"]:checked')?.value ?? "create";
	error.textContent = "";
	const submit = form.querySelector("button[type=submit]");
	submit.disabled = true;
	try {
		await api(
			"/api/projects/" + state.projectId + "/materials/" + encodeURIComponent(promoteTarget.id) + "/library",
			{ method: "POST", body: { mode, title } },
		);
		$("promote-dialog").close();
		promoteTarget = null;
		await reloadLibrary();
		await reloadProject();
	} catch (err) {
		error.textContent = err.message;
	} finally {
		submit.disabled = false;
	}
});

// ═══════════════════════════════════════════════════ 对议

/** 面板当前对应的会话键。写作面板按章各留一份对话。 */
function activeKey(pane) {
	return pane === "writing" ? "writing:" + (state.chapterId ?? "") : "material";
}

/** 把面板切到当前会话的内容上。键没变就什么都不做。 */
function mountStream(pane) {
	const box = $(PANES[pane].stream);
	const key = activeKey(pane);
	const previous = state.streamKeys[pane];
	if (previous === key) return key;
	if (previous) state.transcripts.set(previous, box.innerHTML);
	box.innerHTML = state.transcripts.get(key) ?? "";
	state.streamKeys[pane] = key;
	scrollToBottom(pane);
	return key;
}

function appendMessage(pane, role, text) {
	const wrap = el("div", "msg " + role);
	wrap.append(
		el("div", "msg-role", role === "user" ? "书者" : role === "error" ? "讹误" : PANES[pane].assistant),
	);
	const body = el("div", "msg-body", text);
	wrap.append(body);
	$(PANES[pane].stream).append(wrap);
	scrollToBottom(pane);
	return { wrap, body };
}

function appendTool(pane, name, preview, failed) {
	const wrap = el("div", "tool" + (failed ? " is-failed" : ""));
	wrap.append(el("span", "tool-mark", failed ? "✕" : "◦"));
	const main = el("div");
	main.append(el("div", "tool-name", name));
	if (preview) main.append(el("div", "tool-preview", preview));
	wrap.append(main);
	$(PANES[pane].stream).append(wrap);
	scrollToBottom(pane);
	return wrap;
}

function scrollToBottom(pane) {
	const box = $(PANES[pane].stream);
	box.scrollTop = box.scrollHeight;
}

function setStreaming(pane) {
	state.streaming = pane;
	for (const role of ["material", "writing"]) {
		const talk = $(PANES[role].stream).closest(".bench-talk");
		if (!talk) continue;
		const submit = talk.querySelector("button[type=submit]");
		submit.disabled = Boolean(pane);
		submit.textContent = pane === role ? "落笔中" : "呈上";
		talk.querySelector("[data-abort]").classList.toggle("hidden", pane !== role);
	}
	$("model-select").disabled = Boolean(pane);
	$("thinking-select").disabled = Boolean(pane);
}

async function ensureSession(role) {
	const key = role === "writing" ? "writing:" + state.chapterId : "material";
	const cached = state.sessions.get(key);
	if (cached) return cached;
	const modelRef = $("model-select").value;
	if (!modelRef) throw new Error("请先到设置里备好笔墨");
	const body = { projectId: state.projectId, role, modelRef, thinkingLevel: $("thinking-select").value };
	if (role === "writing") body.chapterId = state.chapterId;
	const data = await api("/api/sessions", { method: "POST", body });
	state.sessions.set(key, data.sessionId);
	return data.sessionId;
}

async function sendMessage(pane, text) {
	if (state.streaming) return;
	if (pane === "writing" && !state.chapterId) {
		appendMessage("writing", "error", "先在左栏点开一章。");
		return;
	}
	// 素材工作台：选中了素材就把「改哪几条」拼进指令；作者看到的仍是他自己的原话。
	const outgoing = pane === "material" ? withPickedMaterials(text) : text;
	appendMessage(pane, "user", text);
	setStreaming(pane);
	try {
		const sessionId = await ensureSession(pane);
		const res = await fetch("/api/sessions/" + sessionId + "/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: outgoing }),
		});
		if (!res.ok || !res.body) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "请求失败 (" + res.status + ")");
		}
		await pumpStream(res, pane);
	} catch (error) {
		appendMessage(pane, "error", error.message);
	} finally {
		setStreaming(null);
		// 设定官这一轮可能新建或改了素材：重载让素材库与生文工作台同步跟上。
		await reloadProject();
	}
}

/** 消费 NDJSON 事件流。两个工作台与一次性成文共用同一条渲染路径。 */
async function pumpStream(res, pane) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let message = null;
	let thinkingBox = null;
	let usage = null;

	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			switch (event.type) {
				case "text":
					if (!message) {
						message = appendMessage(pane, "assistant", "");
						message.body.classList.add("cursor");
					}
					thinkingBox = null;
					message.body.textContent += event.delta;
					scrollToBottom(pane);
					break;
				case "thinking_start":
					if (!message) message = appendMessage(pane, "assistant", "");
					// 思考默认收起：想看再点开，免得把正文挤下去。
					thinkingBox = el("details", "thinking");
					thinkingBox.append(el("summary", "thinking-head", "思考过程"));
					thinkingBox.append(el("div", "thinking-body"));
					thinkingBox.dataset.chars = "0";
					message.wrap.insertBefore(thinkingBox, message.body);
					break;
				case "thinking": {
					if (!thinkingBox) break;
					const body = thinkingBox.querySelector(".thinking-body");
					if (body) body.textContent += event.delta;
					const chars = Number(thinkingBox.dataset.chars || "0") + event.delta.length;
					thinkingBox.dataset.chars = String(chars);
					const head = thinkingBox.querySelector(".thinking-head");
					if (head) head.textContent = "思考过程（" + chars + " 字）";
					break;
				}
				case "tool_start": {
					const wrap = appendTool(pane, event.name, "行笔中…", false);
					wrap.dataset.pending = "1";
					break;
				}
				case "tool_end": {
					const pending = [...$(PANES[pane].stream).querySelectorAll(".tool")].pop();
					if (pending && pending.dataset.pending === "1") {
						delete pending.dataset.pending;
						pending.className = event.isError ? "tool is-failed" : "tool";
						pending.replaceChildren();
						pending.append(el("span", "tool-mark", event.isError ? "✕" : "✓"));
						const main = el("div");
						main.append(el("div", "tool-name", event.name));
						if (event.preview) main.append(el("div", "tool-preview", event.preview));
						pending.append(main);
					} else {
						appendTool(pane, event.name, event.preview, event.isError);
					}
					scrollToBottom(pane);
					break;
				}
				case "run_end":
					usage = event.usage;
					if (message) message.body.classList.remove("cursor");
					if (event.error) appendMessage(pane, "error", event.error);
					break;
				case "error":
					appendMessage(pane, "error", event.message);
					break;
				default:
					break;
			}
		}
	}

	if (message) message.body.classList.remove("cursor");
	if (usage) {
		$(PANES[pane].stream).append(
			el("div", "msg-foot", "入 " + usage.input + " · 出 " + usage.output + " · " + usage.turns + " 轮"),
		);
		scrollToBottom(pane);
	}
}

// ═══════════════════════════════════════════════════ 事件绑定

for (const tab of document.querySelectorAll(".tab")) {
	tab.addEventListener("click", () => {
		switchView(tab.dataset.view);
		if (tab.dataset.view === "materials") $("material-input").focus();
		if (tab.dataset.view === "writing") $("writing-input").focus();
	});
}

for (const tab of document.querySelectorAll(".bible-tab")) {
	tab.addEventListener("click", () => {
		state.bibleTab = tab.dataset.tab;
		for (const item of document.querySelectorAll(".bible-tab")) {
			item.classList.toggle("is-on", item === tab);
		}
		renderBible();
	});
}

for (const [pane, ids] of Object.entries(PANES)) {
	const form = $(ids.input).closest("form");
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = $(ids.input).value.trim();
		if (!text || state.streaming || !state.projectId) return;
		$(ids.input).value = "";
		void sendMessage(pane, text);
	});
	$(ids.input).addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			form.requestSubmit();
		}
	});
	form.querySelector("[data-abort]").addEventListener("click", () => {
		// 一次性成文没有会话，直接掐断 fetch。
		if (state.writeAbort) {
			state.writeAbort.abort();
			return;
		}
		const sessionId = state.sessions.get(activeKey(pane));
		if (sessionId) fetch("/api/sessions/" + sessionId + "/abort", { method: "POST" }).catch(() => {});
	});
}

// 上传：点选 + 拖放
$("upload-pick").addEventListener("click", () => $("upload-input").click());
$("upload-input").addEventListener("change", (event) => {
	void handleFiles([...event.target.files]);
	event.target.value = "";
});
const zone = $("upload-zone");
zone.addEventListener("click", () => $("upload-input").click());
zone.addEventListener("dragover", (event) => {
	event.preventDefault();
	zone.classList.add("is-over");
});
zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
zone.addEventListener("drop", (event) => {
	event.preventDefault();
	zone.classList.remove("is-over");
	void handleFiles([...event.dataTransfer.files]);
});

$("model-select").addEventListener("change", () => {
	// 已建的会话同步换笔，历史留着。
	for (const sessionId of state.sessions.values()) {
		fetch("/api/sessions/" + sessionId + "/model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelRef: $("model-select").value, thinkingLevel: $("thinking-select").value }),
		}).catch(() => {});
	}
});

window.addEventListener("settings-changed", async () => {
	const data = await api("/api/bootstrap").catch(() => null);
	if (!data) return;
	const previous = $("model-select").value;
	renderModels(data.models, data.defaultModel);
	if (data.models.some((model) => model.id === previous)) $("model-select").value = previous;
});

bindSettings();
bootstrap().catch((error) => {
	const box = $("view-manuscript");
	box.replaceChildren(el("div", "void", "起手不成：" + error.message));
});
