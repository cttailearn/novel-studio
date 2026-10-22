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

import { bindSettings, levelText, THINKING_LEVELS } from "./settings.js";

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

/** 三个面板的 DOM 坐标。渲染对话时按角色取，不必到处写 id。 */
const PANES = {
	material: { stream: "material-stream", input: "material-input", assistant: "设定官" },
	writing: { stream: "writing-stream", input: "writing-input", assistant: "执笔者" },
	// 案头上的设定官：不绑作品，直接往通用素材库里备料。
	library: { stream: "library-stream", input: "library-input", assistant: "设定官" },
};

const state = {
	projects: [],
	/** 可用模型目录，档位过滤靠它判断当前这支笔支持什么。 */
	models: [],
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
	streamKeys: { material: null, writing: null, library: null },
	/** 正在流式的面板：null | "material" | "writing" | "library"。 */
	streaming: null,
	/** 「另起一席」的二次确认：先记住哪个面板，再点一次才真弃。 */
	pendingNewChat: null,
	/**
	 * 正在流式生成的那一份内容挂在哪：node 就是收到 token 就往上写的那个节点。
	 * 作者中途切章时它被整体挪进一个游离容器（node 暂时不在文档里），token 照写不误，
	 * 切回来再原样搬回面板。拍成 HTML 快照只会留下一段永远冻住的半截。
	 */
	streamHolder: null,
	/** 流的代次。换项目时 +1，跑着的 pumpStream 发现自己过期就收手。 */
	streamEpoch: 0,
	/** 读操作的发号。号小的响应一律丢弃：它比已经落地的那次更旧。 */
	readSeq: { project: 0, library: 0, projects: 0 },
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
	/** 快照回滚的二次确认：先记住快照文件名，再点一次才真回滚。 */
	pendingSnapshotRestore: null,
	/** 素材工作台里点选、准备让设定官按需求修改的素材 id。 */
	pickedMaterials: new Set(),
	/** 顶层模式：home 是案头（管理），workspace 是写作台（创作）。 */
	mode: "home",
	/** 编辑器自动存稿。正文只活在 textarea 里时，切走一步就可能整段丢。 */
	editorDirty: false,
	editorSaving: false,
	editorSavedAt: 0,
	editorTimer: null,
	/** 流式面板是否自动贴底。作者往上翻在读时，别再把他拽回底部。 */
	autoScroll: { material: true, writing: true, library: true },
	/** 检索词：章目、素材库、通用库、右案。 */
	chapterQuery: "",
	materialQuery: "",
	libraryQuery: "",
	bibleQuery: "",
	/** 版本回滚的二次确认：`chapterId:revision`。 */
	pendingRestore: null,
	/** 导出对话框此刻针对哪一章。 */
	exportChapterId: null,
	/** 专注模式与排版偏好。 */
	focusMode: false,
	typography: { size: 17, line: 2.05, measure: 54 },
};

/** 素材表单的落点：新建（可能来自某条上传）还是改已有的。 */
let materialForm = { scope: "project", mode: "create", uploadId: null, materialId: null, libraryId: null };

/** 正在被拖的素材 id。dragover 时读不到 dataTransfer，落区提示只能靠它。 */
let draggingMaterialId = null;

/** 当前这一轮「正在落笔」的占位节点。止笔时要能立刻把它收掉。 */
let currentWaiting = null;

const kindLabel = (kind) => MATERIAL_KIND_LABELS[kind] || kind;

/** 章节状态与版本来源都要说人话，别把 planned / agent 这种内部值直接摆到稿纸上。 */
const CHAPTER_STATUS_LABELS = {
	planned: "待拟",
	outlined: "已列纲",
	drafting: "行文中",
	drafted: "已成稿",
	revising: "修订中",
	done: "定稿",
};
const statusLabel = (status) => CHAPTER_STATUS_LABELS[status] || status;
const REVISION_MODE_LABELS = {
	manual: "手动保存",
	agent: "执笔者写入",
	create: "首次成文",
	rewrite: "整章重写",
	continue: "续写",
	autosave: "自动存稿",
};
const revisionModeLabel = (mode) => REVISION_MODE_LABELS[mode] || mode || "自动存稿";
const fmtNum = (n) => n.toLocaleString("zh-CN");

const CN = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1 → 一，12 → 十二，105 → 一百零五。百章之后不能再退化成「十」。 */
function toCn(n) {
	if (!Number.isFinite(n) || n < 0) return String(n);
	if (n < 10) return CN[n] ?? String(n);
	if (n < 20) return "十" + (CN[n - 10] ?? "");
	if (n < 100) return (CN[Math.floor(n / 10)] ?? "") + "十" + (n % 10 ? CN[n % 10] : "");
	if (n >= 10000) return String(n);
	const units = ["千", "百", "十", ""];
	const digits = String(n).padStart(4, "0").split("").map(Number);
	let out = "";
	let zero = false;
	for (let i = 0; i < 4; i += 1) {
		const digit = digits[i];
		if (digit === 0) {
			zero = out !== "";
			continue;
		}
		if (zero) out += "零";
		zero = false;
		out += CN[digit] + units[i];
	}
	return out;
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

// ═══════════════════════════════════════════════════ 反馈

/**
 * 底部浮出的短提示。
 *
 * 写作最怕两件事：字丢了不知道，和一个小失败弹出系统 alert 打断思路。
 * 这里统一收口：不阻塞、可点掉、几秒自散，一次最多四条。
 *
 * 印章上落一个字表明性质：成功「成」、失败「误」、提醒「嘱」、其余「记」。
 * 手机上提示一闪而过，靠颜色认来不及（暗色里尤其难分），得有个字。
 */
const TOAST_MARKS = {
	ok: ["成", "成功"],
	error: ["误", "失败"],
	warn: ["嘱", "提醒"],
	info: ["记", "提示"],
};

function toast(message, tone = "info", timeout = 3600) {
	const stack = $("toast-stack");
	if (!stack) return;
	const [mark, word] = TOAST_MARKS[tone] ?? TOAST_MARKS.info;
	const node = el("div", "toast toast-" + tone);
	node.setAttribute("role", tone === "error" ? "alert" : "status");
	node.setAttribute("aria-label", word + "：" + message);
	node.tabIndex = 0;
	node.append(el("span", "toast-mark", mark));
	node.append(el("span", "toast-text", message));
	const close = () => {
		if (node.classList.contains("is-gone")) return;
		node.classList.add("is-gone");
		// 减少动态效果时不等过场：淡出那 220ms 在系统眼里也算动。
		setTimeout(() => node.remove(), prefersReducedMotion() ? 0 : 220);
	};
	// 关闭口：整条可点（原有手感），另加一个看得见的叉。
	// 手机上一条提示压住正文时，光靠「点整条」不显眼，人不知道能点。
	const dismiss = el("span", "toast-close", "✕");
	dismiss.setAttribute("role", "button");
	dismiss.setAttribute("aria-label", "关闭提示");
	dismiss.tabIndex = 0;
	dismiss.addEventListener("click", (event) => {
		event.stopPropagation();
		close();
	});
	dismiss.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	});
	node.append(dismiss);
	node.addEventListener("click", close);
	node.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") close();
	});
	setTimeout(close, timeout);
	stack.append(node);
	while (stack.children.length > 4) stack.firstElementChild.remove();
}

function fmtTime(timestamp) {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	const pad = (value) => String(value).padStart(2, "0");
	return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** 顶栏的进度行。两处渲染共用，免得改一处漏一处。 */
function statsLine() {
	const stats = state.stats;
	if (!stats) return "";
	const target = state.project?.targetWords ?? 0;
	const words = target > 0
		? fmt(stats.words) + " / " + fmt(target) + " 字（" + Math.round((stats.words / target) * 100) + "%）"
		: fmt(stats.words) + " 字";
	return (
		stats.chapters + " 章 · " + words + " · " + stats.materials + " 料 · " +
		stats.coveredChapters + "/" + stats.chapters + " 章已装料 · " + stats.openNotes + " 待办"
	);
}

// ═══════════════════════════════════════════════════ 窄屏：章目抽屉与顶栏浮层

/*
 * 手机上顶栏放不下一排控件，章目也占掉半屏首屏。
 * 这里给窄屏补两样东西：顶栏的「笔」浮层（模型与档位）与左边的「章目」抽屉。
 * 桌面端（>640px）这两样都不出现，行为与从前完全一样。
 */
const PHONE_QUERY = "(max-width: 640px)";
const phoneQuery = typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;

/** 现在是不是手机宽度。宽高都不问，只问宽 —— 竖屏手机的瓶颈是宽。 */
function isPhoneLayout() {
	return Boolean(phoneQuery?.matches);
}

/**
 * 收起 / 张开章目抽屉（只管界面）。
 * 与历史无关，所以单独一层：层管理那边关界面时调的也是它。
 */
function setRailDrawer(open) {
	const desk = document.querySelector(".desk");
	if (!desk) return;
	desk.classList.toggle("is-rail-open", open);
	$("rail-backdrop")?.classList.toggle("hidden", !open);
	$("toggle-rail")?.setAttribute("aria-expanded", open ? "true" : "false");
}

function openRailDrawer() {
	if (findLayer("rail")) return;
	// 两个抽屉不同时开：右案盖着，章目就进不去了。
	// 交接时接管右案那条历史（keepHistory），返回键才只需按一次 —— 见 openLayer。
	const inherited = closeBibleDrawer({ keepHistory: true });
	setRailDrawer(true);
	openLayer("rail", () => setRailDrawer(false), { replace: inherited });
}

/** 返回 true 表示「刚才确实有一层被关掉了」，给接手的那一方判断要不要 replace。 */
function closeRailDrawer(options = {}) {
	if (closeLayer("rail", options)) return true;
	setRailDrawer(false);
	return false;
}

function toggleRailDrawer() {
	if (document.querySelector(".desk")?.classList.contains("is-rail-open")) closeRailDrawer();
	else openRailDrawer();
}

/** 顶栏的模型与档位浮层（只管界面）。 */
function setToolsPanel(open) {
	const panel = $("beam-tools");
	if (!panel) return;
	panel.classList.toggle("is-open", open);
	$("toggle-tools")?.setAttribute("aria-expanded", open ? "true" : "false");
}

/** 手机上点「笔」落下，点外面收起。开着的时候也算一层，返回键要能关掉它。 */
function toggleToolsPanel(force) {
	const panel = $("beam-tools");
	if (!panel) return;
	const open = force === undefined ? !panel.classList.contains("is-open") : Boolean(force);
	if (!open) {
		closeToolsPanel();
		return;
	}
	if (findLayer("tools")) return;
	setToolsPanel(true);
	openLayer("tools", () => setToolsPanel(false));
}

function closeToolsPanel() {
	if (closeLayer("tools")) return;
	setToolsPanel(false);
}

/**
 * 横向一划就收起抽屉。
 * 竖着划是滚动，斜着划是乱划，只有几乎纯横向的一划才当作「走开」。
 */
function bindSwipeOut(element, onSwipeOut) {
	if (!element) return;
	let startX = 0;
	let startY = 0;
	let tracking = false;
	element.addEventListener(
		"touchstart",
		(event) => {
			if (event.touches.length !== 1) {
				tracking = false;
				return;
			}
			startX = event.touches[0].clientX;
			startY = event.touches[0].clientY;
			tracking = true;
		},
		{ passive: true },
	);
	element.addEventListener(
		"touchend",
		(event) => {
			if (!tracking) return;
			tracking = false;
			const touch = event.changedTouches[0];
			if (!touch) return;
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) onSwipeOut(dx);
		},
		{ passive: true },
	);
}

// ═══════════════════════════════════════════════════ 触控与视口

const COARSE_QUERY = "(pointer: coarse)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const coarseQuery = typeof window.matchMedia === "function" ? window.matchMedia(COARSE_QUERY) : null;
const motionQuery = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;

/** 手指点还是鼠标点。决定「点卡片算不算选中」与「要不要装拖拽」。 */
function isCoarsePointer() {
	return Boolean(coarseQuery?.matches);
}

/** 系统开了「减少动态效果」：能不动就不动，别抢人眼睛。 */
function prefersReducedMotion() {
	return Boolean(motionQuery?.matches);
}

/**
 * 给 CSS 留的两个钩子。
 *
 * 手机横过来时视口只剩三百来像素高，顶栏加操作条能吃掉小半屏；
 * 结构上给不出更多办法，至少要让人知道「现在是矮窗」，样式才好在矮窗里把两栏压成一行。
 * pointer: coarse 在部分安卓 WebView 上不报，所以触屏这件事同时落成 data-touch。
 */
function syncViewportHooks() {
	const root = document.documentElement;
	root.classList.toggle("is-short", window.innerHeight <= 480);
	root.dataset.orient = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
	root.dataset.touch = isCoarsePointer() ? "coarse" : "fine";
}

/**
 * 软键盘避让。
 *
 * 安卓上键盘一弹，下半屏就没了，正在写的那个框如果正好落在那儿，人是在盲打。
 * 只把「落在下半屏、且底边被遮住」的框带上来 —— 见框就滚，会让人还没开始打字屏幕先跳一下。
 */
function revealForKeyboard(node) {
	if (!isCoarsePointer() || !(node instanceof HTMLElement) || !node.isConnected) return;
	const viewport = window.visualViewport;
	const height = viewport ? viewport.height : window.innerHeight;
	const offset = viewport ? viewport.offsetTop : 0;
	const box = node.getBoundingClientRect();
	const covered = box.bottom > offset + height - 12;
	const lowerHalf = box.top > offset + height * 0.5;
	if (!covered || !lowerHalf) return;
	node.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

document.addEventListener("focusin", (event) => {
	const node = event.target;
	if (!(node instanceof HTMLElement) || !node.matches("input, textarea")) return;
	// 键盘是弹上来的：focus 那一刻可视区还没缩，得等它起完再量一次。
	const timer = setTimeout(() => revealForKeyboard(node), 320);
	const viewport = window.visualViewport;
	if (!viewport) return;
	const onResize = () => revealForKeyboard(node);
	viewport.addEventListener("resize", onResize);
	const stop = () => {
		clearTimeout(timer);
		viewport.removeEventListener("resize", onResize);
		node.removeEventListener("blur", stop);
	};
	node.addEventListener("blur", stop);
	// 键盘没弹起来（外接键盘、桌面、手指只是划过）：两秒后收摊，别把监听一直挂着。
	setTimeout(stop, 2000);
});

// ═══════════════════════════════════════════════════ 层管理：安卓返回键

/*
 * 手机上最恼人的一件事：正开着对话框或抽屉，一按返回键，整个应用没了。
 *
 * 做法是给每个「层」配一条历史记录：
 *   openLayer   压一条 { nsLayer: id } —— 返回键于是有东西可退
 *   popstate    退到某层之前，就把比它晚开的都收掉（只收界面，不再 back）
 *   closeLayer  从界面关闭时收界面，再 back() 吃掉自己压的那条
 *
 * 合起来：返回键一次只关一层；关到底再按，才轮到浏览器去退页或退出应用。
 * 两个坑写在对应分支里：抽屉换边时的 push/back 竞态，和一按返回关两层。
 */
const layerStack = [];
/** 我们自己发起的那次 back()。它回来时要认得出来，别顺手把新开的层也关掉。 */
let selfBack = null;

const findLayer = (id) => layerStack.find((layer) => layer.id === id) ?? null;

/**
 * 登记一层并压一条历史。
 *
 * replace 是给抽屉换边用的（章目 ↔ 右案）。那时不能「先 back 再 push」：
 * back 是异步的，它会在 push 之后才落地，把刚压的那条顶掉，
 * 于是返回键要按两次才关得掉新开的那一边。
 */
function openLayer(id, close, options = {}) {
	if (!id || findLayer(id)) return null;
	const layer = { id, close, hasHistory: false, closed: false };
	layerStack.push(layer);
	try {
		// 只有当前这条历史确实是自己人压的，才敢 replaceState：
		// 否则会把应用自己的那条顶掉，返回键一点就退出。
		if (options.replace && typeof history.state?.nsLayer === "string") history.replaceState({ nsLayer: id }, "");
		else history.pushState({ nsLayer: id }, "");
		layer.hasHistory = true;
	} catch {
		// 个别内嵌浏览器禁 pushState：退化成「返回键不管用」，界面照常关得掉。
	}
	return layer;
}

/** 摘掉登记，并（可选地）把这一层压的历史吃掉。 */
function dropLayer(layer, consumeHistory) {
	const index = layerStack.indexOf(layer);
	if (index >= 0) layerStack.splice(index, 1);
	layer.closed = true;
	// 只在「这条历史还挂在当前项上」时才 back。被返回键关掉的那些已经退过了，
	// 再退一次就会把下面那层一起带走 —— 「Esc 一下关两层」就是这么来的。
	if (consumeHistory && layer.hasHistory && history.state?.nsLayer === layer.id) {
		layer.hasHistory = false;
		selfBack = { id: layer.id, at: Date.now() };
		history.back();
	}
}

/**
 * 从界面关掉一层：先收界面，再收历史。
 *
 * close 回调里若又转回 closeLayer（dialog.close() 会同步触发 close 事件），
 * 由 closed 标记挡下第二次，不会递归。
 * keepHistory：把这条历史留给接手的抽屉（见 openRailDrawer）。
 */
function closeLayer(id, options = {}) {
	const layer = findLayer(id);
	if (!layer) return false;
	layer.close();
	if (!layer.closed) dropLayer(layer, options.keepHistory !== true);
	return true;
}

/** 返回键收层：历史已经由浏览器退过了，这里只管把界面收掉。 */
function closeTopFromHistory() {
	const layer = layerStack.pop();
	if (!layer) return;
	layer.closed = true;
	layer.hasHistory = false;
	layer.close();
}

/**
 * 兜底：返回键已经落到「层之前」，却还有弹层开着 ——
 * 那是别处直接 showModal 开的、我们没来得及认领的（设置对话框就是）。
 * 关掉它，并补一条历史，免得这一按就直接退出应用。
 */
function adoptStrayDialog() {
	const dialogs = [...document.querySelectorAll("dialog[open]")];
	const dialog = dialogs[dialogs.length - 1];
	if (!dialog) return;
	dialog.close();
	try {
		history.pushState({ nsLayer: null }, "");
	} catch {
		// 压不进去就算了，至少这一层关上了。
	}
}

window.addEventListener("popstate", (event) => {
	const stateId = typeof event.state?.nsLayer === "string" ? event.state.nsLayer : null;
	const index = stateId ? layerStack.findIndex((layer) => layer.id === stateId) : -1;
	// 自己刚吃掉的那条回来了：认个账就走。
	// 此时若还留着之后再开的层，说明那层的 push 落在本次 back 之前，
	// 一并收掉会让「关一个」变成「关两个」。
	if (selfBack && Date.now() - selfBack.at < 1000) {
		selfBack = null;
		if (index < 0) return;
	}
	// 退到某一层之前：这一层之上的都该收掉。一次只退一条历史，通常也就一层。
	const keep = index < 0 ? 0 : index + 1;
	while (layerStack.length > keep) closeTopFromHistory();
	if (index < 0) adoptStrayDialog();
});

/** 弹层的唯一入口：登记层级、记住触发者、把焦点放对。 */
function openDialog(dialog, options = {}) {
	if (!dialog || dialog.open) return;
	const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	openLayer("dialog:" + dialog.id, () => {
		if (dialog.open) dialog.close();
		restoreFocus(trigger);
	});
	dialog.showModal();
	focusFirstIn(dialog, options.focus);
}

/** 关掉一个弹层。没登记过的（settings.js 自己开的）也照样关得掉。 */
function closeDialog(dialog) {
	if (!dialog) return;
	if (!closeLayer("dialog:" + dialog.id) && dialog.open) dialog.close();
}

/**
 * 打开后把焦点放到该放的地方：调用方指定 → data-autofocus → 第一个可输入的 → 对话框本身。
 *
 * 原生 showModal 也会给个初始焦点，但它挑的常常是第一个可聚焦元素，
 * 表单里那往往是「作罢」按钮 —— 手机上一开表单，键盘没弹，光标也不知道在哪。
 */
function focusFirstIn(dialog, focus) {
	if (focus === "self") {
		focusDialogItself(dialog);
		return;
	}
	const direct = typeof focus === "string" ? dialog.querySelector(focus) : focus;
	const target =
		direct instanceof HTMLElement
			? direct
			: dialog.querySelector("[data-autofocus]") ??
				dialog.querySelector("input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])");
	if (target instanceof HTMLElement) {
		target.focus();
		return;
	}
	focusDialogItself(dialog);
}

/** 没有可输入的（只读面板、纯按钮清单）：焦点落在对话框上，读屏从头念一遍。 */
function focusDialogItself(dialog) {
	if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
	dialog.focus();
}

/** 关闭后把焦点还给当初把手放上去的那个元素。 */
function restoreFocus(node) {
	if (!(node instanceof HTMLElement) || !node.isConnected) return;
	// 上面还盖着别的弹层时别抢焦点：焦点该留在最上层里。
	const open = document.querySelector("dialog[open]");
	if (open && !open.contains(node)) return;
	try {
		node.focus();
	} catch {
		// 元素已经不吃焦点了，算了。
	}
}

/**
 * 认领别的模块自己打开的弹层。
 *
 * 设置对话框由 settings.js 自己 showModal，我们插不进手，只好点完补登记一次 ——
 * 没有这一条，安卓返回键会直接退出应用。
 */
function adoptOpenDialogs() {
	for (const dialog of document.querySelectorAll("dialog[open]")) {
		if (!dialog.id || findLayer("dialog:" + dialog.id)) continue;
		openLayer("dialog:" + dialog.id, () => {
			if (dialog.open) dialog.close();
		});
	}
}

/*
 * 每个 dialog 挂两件事：
 *   cancel —— Esc。拦掉原生「关掉最上层」的活，改由层管理器统一关，历史才收得干净。
 *   close  —— 不论是按钮、Esc 还是别的模块自己 close() 的，都在这里补收历史。
 */
for (const dialog of document.querySelectorAll("dialog")) {
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		closeDialog(dialog);
	});
	dialog.addEventListener("close", () => {
		const layer = findLayer("dialog:" + dialog.id);
		if (layer) dropLayer(layer, true);
	});
}

// ═══════════════════════════════════════════════════ 首屏骨架

let bootSkeletonGone = false;

/**
 * 摘掉首屏骨架。
 *
 * 它盖着的是整个应用，所以启动成不成都得摘：接口慢甚至挂了的时候，
 * 留着它比让人看见一副空壳更糟 —— 空壳至少还能点开设置看一眼。
 */
function dismissBootSkeleton() {
	if (bootSkeletonGone) return;
	bootSkeletonGone = true;
	const node = $("boot-skeleton");
	if (!node) return;
	node.classList.add("is-gone");
	if (prefersReducedMotion()) {
		node.remove();
		return;
	}
	node.addEventListener("transitionend", () => node.remove(), { once: true });
	// 样式里万一没写过场，也保证它真被摘掉：最多再等 240ms。
	setTimeout(() => node.remove(), 240);
}

// ═══════════════════════════════════════════════════ 排版与专注

const TYPE_KEY = "novel-studio/typography";
const TYPE_DEFAULTS = { size: 17, line: 2.05, measure: 54 };
/* 版心三档：窄 45em / 中 54em / 宽 66em（17px 字号下约 765 / 918 / 1122 像素）。
   早先那套是 30/36/44，整体偏窄；存下来的旧值在读取时按 1.5 倍迁到新档，不让老偏好把人锁在窄版心里。 */
const TYPE_MEASURES = [45, 54, 66];
const TYPE_MEASURES_LEGACY = { 30: 45, 36: 54, 44: 66 };

/** 只落在浏览器里：这是阅读偏好，不该跟着作品走，也不该污染服务端的工程文件。 */
function loadTypography() {
	try {
		const saved = JSON.parse(readStored(TYPE_KEY, "null"));
		if (saved && typeof saved === "object") {
			const size = Number(saved.size);
			const line = Number(saved.line);
			const measure = Number(saved.measure);
			if ([15, 17, 19, 21].includes(size)) state.typography.size = size;
			if ([1.8, 2.05, 2.3].includes(line)) state.typography.line = line;
			if (TYPE_MEASURES.includes(measure)) state.typography.measure = measure;
			else if (TYPE_MEASURES_LEGACY[measure]) state.typography.measure = TYPE_MEASURES_LEGACY[measure];
		}
	} catch {
		// 存坏了就用默认值，别让排版偏好把页面拖死。
	}
	applyTypography();
}

function applyTypography() {
	const style = document.documentElement.style;
	// 手机上正文不小于 16px：再小，iOS 一点就自己放大，视线整个跑掉。
	const size = isPhoneLayout() ? Math.max(16, state.typography.size) : state.typography.size;
	style.setProperty("--ms-font-size", size + "px");
	style.setProperty("--ms-line-height", String(state.typography.line));
	style.setProperty("--ms-measure", state.typography.measure + "em");
}

function setTypography(patch) {
	state.typography = { ...state.typography, ...patch };
	applyTypography();
	writeStored(TYPE_KEY, JSON.stringify(state.typography));
	// 字号或行距一变，改稿框的整高就变了；不重新量一次，正文会被裁在框里。
	requestAnimationFrame(() => {
		const editor = document.querySelector("#view-manuscript .ms-edit");
		if (editor) fitEditor(editor);
	});
}

function setFocusMode(on) {
	state.focusMode = Boolean(on);
	document.querySelector(".desk")?.classList.toggle("is-focus", state.focusMode);
	document.body.classList.toggle("focus-mode", state.focusMode);
	if (state.focusMode) closeBibleDrawer();
	refreshFocusButton();
	syncTypeDialog();
}

/** 只改操作条上的那一枚按钮，不重绘稿台 —— 改稿时重绘会连光标一起换掉。 */
function refreshFocusButton() {
	for (const btn of document.querySelectorAll("#view-manuscript .actions-center .btn")) {
		if (btn.textContent !== "专注" && btn.textContent !== "退出专注") continue;
		btn.textContent = state.focusMode ? "退出专注" : "专注";
		btn.classList.toggle("is-on", state.focusMode);
	}
}

/**
 * 案头与写作台是两级，不是一排并列的页：选卷、管素材在案头，
 * 进卷之后才是稿 / 料 / 文。停在哪儿记在浏览器里，刷新不丢位置。
 */
const MODE_KEY = "novel-studio/mode";
const PROJECT_KEY = "novel-studio/project";
/** 每部作品各自记住上次翻到哪一章：回到案头再开卷，应当接着上次停笔的地方。 */
const chapterKey = (projectId) => "novel-studio/chapter/" + projectId;

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
	// 手机地址栏那条色也跟着昼夜走：暗色里留一条白边，太扎眼。
	const meta = document.querySelector('meta[name="theme-color"]:not([media])');
	if (meta) meta.setAttribute("content", theme === "dark" ? "#17150f" : "#efe8d9");
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

// ═══════════════════════════════════════════════════ 分栏

/**
 * 料 / 文两栏之间那条分界，改成能拖的提手。
 *
 * 宽度记在容器的 --bench-a 上，不直接写栅格尺寸：两栏本来就是 grid，
 * 一个百分比就能让它自己重算。窗口缩放时百分比天然跟着走，不必再听 resize。
 * 提手绝对定位、不占栅格轨道 —— 它要是占一格，两栏就成了三栏。
 */
const SPLIT_MIN = 26;
const SPLIT_MAX = 74;
const SPLIT_DEFAULT = 50;
const SPLIT_STEP = 2;
/** 栏宽（不是视口宽）小于这两个值就收留白、并单列：媒体查询量不到它。 */
const SPLIT_A_NARROW = 440;
const SPLIT_B_NARROW = 480;

/** 两个工作台各记各的：键由视图 id 派生，如 novel-studio/split/materials。 */
function splitKey(bench) {
	const view = bench.closest("section.view");
	return "novel-studio/split/" + (view ? view.id.replace(/^view-/, "") : "bench");
}

function readSplit(key) {
	const value = Number.parseFloat(readStored(key, ""));
	return Number.isFinite(value) && value >= SPLIT_MIN && value <= SPLIT_MAX ? value : SPLIT_DEFAULT;
}

/** 提手的结构与无障碍语义。role="separator" 让它有滑块语义，读屏会报当前百分比。 */
function buildSplitHandle() {
	const handle = el("div", "bench-split");
	handle.setAttribute("role", "separator");
	handle.tabIndex = 0;
	handle.setAttribute("aria-orientation", "vertical");
	handle.setAttribute("aria-label", "拖动调整两栏宽度");
	handle.setAttribute("aria-valuemin", String(SPLIT_MIN));
	handle.setAttribute("aria-valuemax", String(SPLIT_MAX));
	handle.append(el("span", "bench-split-grip"));
	return handle;
}

function bindSplit(bench, handle, key) {
	let ratio = readSplit(key);
	let dragging = false;

	const apply = (value) => {
		ratio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
		bench.style.setProperty("--bench-a", ratio + "%");
		handle.setAttribute("aria-valuenow", String(Math.round(ratio)));
		handle.setAttribute("aria-valuetext", Math.round(ratio) + "%");
	};
	// 百分比不必逐位存；留一位小数，刷新回来手不跳。
	const commit = () => writeStored(key, String(Math.round(ratio * 10) / 10));

	const ratioAt = (clientX) => {
		const rect = bench.getBoundingClientRect();
		return rect.width ? ((clientX - rect.left) / rect.width) * 100 : ratio;
	};

	handle.addEventListener("pointerdown", (event) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		// 视图还藏着时没有可拖的宽度，别把 capture 挂上去
		if (!bench.getBoundingClientRect().width) return;
		event.preventDefault();
		dragging = true;
		handle.focus({ preventScroll: true });
		handle.classList.add("is-dragging");
		document.body.classList.add("is-splitting");
		if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
	});

	handle.addEventListener("pointermove", (event) => {
		if (!dragging) return;
		apply(ratioAt(event.clientX));
	});

	// pointercancel / lostpointercapture 都会来：窗口失焦、系统手势把指针收走时
	// 收不到 pointerup，不收尾的话整页会一直停在「拖动中」。
	const finish = (event) => {
		if (!dragging) return;
		dragging = false;
		handle.classList.remove("is-dragging");
		document.body.classList.remove("is-splitting");
		if (
			handle.hasPointerCapture &&
			event.pointerId !== undefined &&
			handle.hasPointerCapture(event.pointerId)
		) {
			handle.releasePointerCapture(event.pointerId);
		}
		commit();
	};
	handle.addEventListener("pointerup", finish);
	handle.addEventListener("pointercancel", finish);
	handle.addEventListener("lostpointercapture", finish);

	// 键盘：← → 每次 2%，Home / End 回中。焦点就在提手上，方向键不该滚页面。
	handle.addEventListener("keydown", (event) => {
		let next;
		if (event.key === "ArrowLeft") next = ratio - SPLIT_STEP;
		else if (event.key === "ArrowRight") next = ratio + SPLIT_STEP;
		else if (event.key === "Home" || event.key === "End") next = SPLIT_DEFAULT;
		else return;
		event.preventDefault();
		apply(next);
		commit();
	});

	handle.addEventListener("dblclick", (event) => {
		event.preventDefault();
		apply(SPLIT_DEFAULT);
		commit();
	});

	apply(ratio);
}

/**
 * 按实测栏宽挂窄栏类。视图藏着时两栏都是 0 宽，直接返回：
 * 等它显示出来后再量，别把两栏都标成窄。
 */
function syncSplitNarrow(bench) {
	const panes = bench.querySelectorAll(":scope > .bench-pane");
	if (panes.length !== 2) return;
	const left = panes[0].getBoundingClientRect().width;
	const right = panes[1].getBoundingClientRect().width;
	if (!left || !right) return;
	bench.classList.toggle("is-a-narrow", left < SPLIT_A_NARROW);
	bench.classList.toggle("is-b-narrow", right < SPLIT_B_NARROW);
}

/** 视图切出来、窗口变宽窄之后补量一次。切页后等一帧：那一刻栏才拿到宽度。 */
function scheduleSplitNarrow() {
	requestAnimationFrame(() => {
		for (const bench of document.querySelectorAll(".bench.has-split")) syncSplitNarrow(bench);
	});
}

/**
 * 给每个两栏工作台插提手。
 *
 * 观察两栏而不是视口：栏宽既受窗口影响，也受拖动影响，ResizeObserver
 * 两种都报，比在 pointermove 里反复量便宜。
 */
function initBenchSplits() {
	const benches = [...document.querySelectorAll(".bench:not(.bench-three)")].filter(
		(bench) => bench.querySelectorAll(":scope > .bench-pane").length === 2,
	);
	if (!benches.length) return;

	const observer =
		typeof ResizeObserver === "function"
			? new ResizeObserver((entries) => {
					const touched = new Set();
					for (const entry of entries) {
						const bench = entry.target.closest(".bench.has-split");
						if (bench) touched.add(bench);
					}
					for (const bench of touched) syncSplitNarrow(bench);
				})
			: null;

	for (const bench of benches) {
		const panes = [...bench.querySelectorAll(":scope > .bench-pane")];
		const handle = buildSplitHandle();
		bench.insertBefore(handle, panes[1]);
		bench.classList.add("has-split");
		bindSplit(bench, handle, splitKey(bench));
		if (observer) for (const pane of panes) observer.observe(pane);
		syncSplitNarrow(bench);
	}

	// 没有 ResizeObserver 的老浏览器靠这一条；有的话它是第二道保险，不贵。
	window.addEventListener("resize", scheduleSplitNarrow, { passive: true });
}

// ═══════════════════════════════════════════════════ 启动

/**
 * 刷新落盘健康横幅。
 *
 * 存储层的写入失败会挂 dirty 标记，但接口照样返回 200 —— 不主动问一次，
 * 用户就会以为存上了，直到重启才发现那一稿没了。轻量轮询，失败才亮横幅。
 */
async function refreshStorageStatus() {
	const banner = $("storage-banner");
	if (!banner) return;
	try {
		const info = await api("/api/storage");
		if (info.ok) {
			banner.classList.add("hidden");
			return;
		}
		const count = info.pending?.length ?? 0;
		const chapters = Object.values(info.pendingChapters ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0);
		$("storage-text").textContent =
			count > 0
				? "有 " + count + " 部作品" + (chapters > 0 ? "、" + chapters + " 章正文" : "") +
					" 未能保存到磁盘，关闭程序会丢失这部分改动。"
				: info.message || "有改动未能保存到磁盘。";
		banner.classList.remove("hidden");
	} catch {
		// 探不到就当作没问题：横幅是提醒，不该在接口抖动时反过来打扰人。
		banner.classList.add("hidden");
	}
}

/** 用户点「重试保存」：让后端补写，再刷新一次横幅。 */
async function retryStorage() {
	const btn = $("storage-retry");
	btn.disabled = true;
	try {
		await api("/api/storage/retry", { method: "POST" });
		await refreshStorageStatus();
		await reloadProjects();
	} catch (error) {
		toast("重试保存失败：" + error.message, "error");
	} finally {
		btn.disabled = false;
	}
}
async function bootstrap() {
	const [data, library] = await Promise.all([api("/api/bootstrap"), api("/api/library")]);
	state.projects = data.projects;
	state.library = library.materials ?? [];
	state.models = data.models;
	renderModels(data.models, data.defaultModel);
	renderThinkingLevels(data.defaultThinkingLevel);

	// 落盘状况：先问一次，再定期问。写稿是长时段的事，
	// 磁盘在中间出问题也要让作者当场知道，而不是等下次开机。
	await refreshStorageStatus();
	setInterval(() => void refreshStorageStatus(), 60_000);
	$("storage-retry")?.addEventListener("click", () => void retryStorage());

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
		// 这里必须强制重绘：默认视图就是文稿，switchView 会认为「没换页」而早退。
		switchViewNow("manuscript");
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

/**
 * 按当前所选模型重建推理档位下拉。
 *
 * 只列这支笔真支持的档位：模型不思考时只有「不思」，
 * 选一个上游不认的档位，请求会带着它白发出去。
 * 原来的选择若仍被支持就留着，否则退回第一个（必然是「不思」）。
 */
function renderThinkingLevels(preferred) {
	const select = $("thinking-select");
	const model = state.models.find((item) => item.id === $("model-select").value);
	const supported = new Set(model?.thinkingLevels ?? ["off"]);
	let next = preferred ?? select.value;
	select.replaceChildren();
	for (const [value, label] of THINKING_LEVELS) {
		if (!supported.has(value)) continue;
		const option = el("option", "", levelText(value, label));
		option.value = value;
		select.append(option);
	}
	select.disabled = select.options.length === 0;
	if (![...select.options].some((option) => option.value === next)) {
		next = select.options[0]?.value ?? "off";
	}
	select.value = next;
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

/** 输入框与 state 对齐，但不打断正在输入的光标。 */
function syncInput(id, value) {
	const node = $(id);
	if (node && node.value !== value) node.value = value;
}

/** 检索：任一字段包含关键词即命中；空串全中。中文不需要分词。 */
function matchesQuery(query, ...fields) {
	const keyword = String(query ?? "").trim().toLowerCase();
	if (!keyword) return true;
	return fields.some((field) => String(field ?? "").toLowerCase().includes(keyword));
}

function renderChapters() {
	const list = $("chapter-list");
	list.replaceChildren();
	syncInput("chapter-filter", state.chapterQuery);
	const project = state.project;
	if (!project || project.outline.length === 0) {
		$("chapter-empty").classList.remove("hidden");
		return;
	}
	$("chapter-empty").classList.add("hidden");

	let shown = 0;
	project.outline.forEach((chapter, index) => {
		if (!matchesQuery(state.chapterQuery, chapter.title, chapter.summary, statusLabel(chapter.status))) return;
		shown += 1;
		const draft = project.drafts[chapter.id];
		const words = draft ? countWords(draft.content) : 0;
		const item = el("li", "chapter-item" + (chapter.id === state.chapterId ? " is-on" : ""));
		item.tabIndex = 0;
		item.setAttribute("role", "button");
		if (chapter.id === state.chapterId) item.setAttribute("aria-current", "true");
		item.append(el("span", "ord", toCn(index + 1)));
		item.append(el("span", "ct", chapter.title));
		if (!draft) item.append(el("span", "dotmark"));
		item.append(el("span", "cw", words ? fmt(words) : "—"));
		item.title =
			(chapter.summary || "（未写要略）") +
			" · " + statusLabel(chapter.status) +
			"（装料 " + chapter.materialIds.length + " 条）";
		const open = () => openChapter(chapter.id);
		item.addEventListener("click", open);
		item.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				open();
			}
		});
		list.append(item);
	});
	if (shown === 0) {
		const empty = el("li", "chapter-search-empty", "没有匹配「" + state.chapterQuery.trim() + "」的章目");
		list.append(empty);
	}
}

// ═══════════════════════════════════════════════════ 视图调度

/** 视图调度。改稿未存时先存再走，绝不让一次切页吞掉半章字。 */
function switchView(view) {
	if (state.view === view) return;
	if (state.view === "manuscript" && state.editing && state.editorDirty) {
		void (async () => {
			if (!(await flushEditor())) return;
			switchViewNow(view);
		})();
		return;
	}
	switchViewNow(view);
}

function switchViewNow(view) {
	state.view = view;
	for (const tab of document.querySelectorAll(".tab")) {
		const on = tab.dataset.view === view;
		tab.classList.toggle("is-on", on);
		tab.setAttribute("aria-selected", String(on));
	}
	$("view-manuscript").classList.toggle("is-on", view === "manuscript");
	$("view-materials").classList.toggle("is-on", view === "materials");
	$("view-writing").classList.toggle("is-on", view === "writing");
	applyMode();
	renderView();
	// 新视图刚从 display:none 里出来，两栏这一帧才有宽度：补量一次窄栏类。
	scheduleSplitNarrow();
}

/** 只渲染当前视图。几个视图共用顶部工具条，一起渲染会互相覆盖。 */
function renderView() {
	mountStream("material");
	mountStream("writing");
	// 库面板挂在案头上，但它在 DOM 里始终存在，无条件挂载才能保住它的对话。
	mountStream("library");

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
	$("project-stats").textContent = statsLine();

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
	if (!(await flushEditor())) return;
	if (id !== state.projectId) await selectProject(id);
	state.mode = "workspace";
	writeStored(MODE_KEY, "workspace");
	applyMode();
	switchViewNow("manuscript");
}

/** 回案头：作品仍留在案上，只是不进写作台。 */
function leaveWorkspace() {
	if (state.editing && state.editorDirty) {
		void (async () => {
			if (!(await flushEditor())) return;
			leaveWorkspaceNow();
		})();
		return;
	}
	leaveWorkspaceNow();
}

function leaveWorkspaceNow() {
	clearEditorState();
	state.editing = false;
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
	if (state.editing && state.editorDirty) {
		void (async () => {
			if (!(await flushEditor())) return;
			openChapterNow(chapterId);
		})();
		return;
	}
	openChapterNow(chapterId);
}

function openChapterNow(chapterId) {
	clearEditorState();
	state.chapterId = chapterId;
	state.editing = false;
	state.writeMode = state.project?.drafts[chapterId] ? "rewrite" : "create";
	writeStored(chapterKey(state.projectId), chapterId);
	switchViewNow("manuscript");
	renderChapters();
	$("view-manuscript").scrollTop = 0;
	// 手机上章目与右案都是盖在稿子上的浮层，选完就该收起来。
	if (isPhoneLayout()) {
		closeRailDrawer();
		closeBibleDrawer();
	}
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
		// 最近写过的排前面：案头是落脚处，不是档案柜。
		for (const project of [...state.projects].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
			cards.append(projectCard(project));
		}
	}
	$("library-count").textContent = state.library.length ? state.library.length + " 条" : "";
	syncInput("library-search", state.libraryQuery);

	renderLibraryFilter();
	const list = $("library-list");
	list.replaceChildren();
	const filtered = state.library.filter((entry) => {
		if (state.libraryFilter && entry.kind !== state.libraryFilter) return false;
		return matchesQuery(
			state.libraryQuery,
			entry.title,
			entry.usage,
			entry.content,
			entry.tags.join(" "),
			kindLabel(entry.kind),
		);
	});
	if (state.libraryQuery.trim() && state.library.length > 0) {
		$("library-count").textContent = "匹配 " + filtered.length + " / " + state.library.length + " 条";
	}
	if (filtered.length === 0) {
		list.append(
			el(
				"div",
				"bench-empty",
				state.library.length === 0
					? "库里还没有料。\n在这里手写一条，或在作品里把改好的素材「存入素材库」。"
					: state.libraryQuery.trim()
						? "没有匹配「" + state.libraryQuery.trim() + "」的通用素材。"
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
		const group = el("div", "mat-group");
		const head = el("div", "mat-group-head");
		head.append(el("h3", "", kindLabel(kind)));
		head.append(el("span", "count", entries.length + " 条"));
		group.append(head);
		// 组内单独一个 grid：分组标题是整行的，卡片才两列并排。
		// 这一栏窄的时候卡片自己收成一列，宽度由 CSS 的容器查询按实测栏宽定。
		const grid = el("div", "mat-grid");
		for (const entry of entries) grid.append(libraryCard(entry));
		group.append(grid);
		list.append(group);
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
	const target = project.targetWords ?? 0;
	const progress = target > 0 ? "（" + Math.round((project.stats.words / target) * 100) + "%）" : "";
	card.append(
		el(
			"div",
			"tagline",
			project.stats.chapters + " 章 · " + fmt(project.stats.words) + progress + " 字 · " +
				project.stats.materials + " 料 · " + project.stats.draftedChapters + " 章成稿" +
				(project.stats.openNotes ? " · " + project.stats.openNotes + " 待办" : ""),
		),
	);
	if (project.updatedAt) card.append(el("div", "tagline", "最近动笔 " + fmtTime(project.updatedAt)));

	const actions = el("div", "mat-actions");
	actions.append(button(onDesk ? "继续写" : "开卷", "btn btn-ink btn-xs", () => void enterProject(project.id)));
	actions.append(button("改", "btn btn-quiet btn-xs", () => openProjectDialog(project)));
	// 快照是误删的退路，得有个找得到的地方；删之前系统会自动拍一份。
	actions.append(button("存照", "btn btn-quiet btn-xs", () => void openSnapshotDialog(project)));
	const pending = state.pendingProjectDelete === project.id;
	actions.append(
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger btn-danger" : ""), () =>
			void deleteProject(project),
		),
	);
	card.append(actions);
	return card;
}
/**
 * 打开快照对话框。
 *
 * 章节内的 history 只管"这一章被反复覆盖"，管不到误删素材、误改大纲。
 * 这里是工程级的退路：能看见有几份快照、什么时候的、多大，并能回滚。
 * 回滚本身也可逆 —— 后端会先给当前状态拍一份 before-restore。
 */
async function openSnapshotDialog(project) {
	const list = $("snapshot-list");
	const error = $("snapshot-error");
	error.textContent = "";
	list.replaceChildren(el("div", "bench-empty", "正在取…"));
	// 清单还没拿到时先开：焦点落在对话框上（里面暂时没有能输入的东西）。
	openDialog($("snapshot-dialog"), { focus: "self" });
	$("snapshot-title").textContent = "《" + project.title + "》";
	try {
		const info = await api("/api/projects/" + project.id + "/snapshots");
		list.replaceChildren();
		if (!info.snapshots || info.snapshots.length === 0) {
			list.append(
				el("div", "bench-empty", "还没有快照。\n删素材或删作品时系统会自动存一份，也可以现在手动存。"),
			);
			return;
		}
		for (const snap of info.snapshots) list.append(snapshotRow(project, snap));
	} catch (error_) {
		list.replaceChildren();
		error.textContent = "读取快照失败：" + error_.message;
	}
}

function snapshotRow(project, snap) {
	const row = el("div", "snap-row");
	const when = new Date(snap.at);
	const pad = (n) => String(n).padStart(2, "0");
	const main = el("div", "snap-main");
	main.append(el("div", "snap-when", when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate()) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes())));
	// 文件名形如 2026-10-16T23-56-55-301Z-before-material-delete_xxxx.json，
	// 中段是这份快照为什么而拍，让作者看得懂，而不是只给一串时间戳。
	const reason = snap.name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "").replace(/_[a-z0-9]+\.json$/, "");
	main.append(el("div", "snap-why", reason ? reasonLabel(reason) : "手动存照"));
	row.append(main);
	row.append(el("span", "snap-size", fmt(Math.max(1, Math.round(snap.size / 1024))) + " KB"));
	// 回滚是破坏性的，沿用别处"再点一次确认"的做法，而不是弹一个系统 confirm。
	const confirming = state.pendingSnapshotRestore === snap.name;
	row.append(
		button(confirming ? "再点一次确认回滚" : "回滚到此", "btn btn-quiet btn-xs" + (confirming ? " is-danger btn-danger" : ""), () =>
			void restoreSnapshot(project, snap.name),
		),
	);
	return row;
}

/** 把内部标签翻成人话。 */
function reasonLabel(reason) {
	if (reason === "before-material-delete") return "删除素材前自动存下";
	if (reason === "before-project-delete") return "删除作品前自动存下";
	if (reason === "before-restore") return "回滚前自动存下";
	if (reason === "manual") return "手动存下";
	return reason;
}

/** 回滚到指定快照。破坏性操作，仍走"两次确认"的既有做法。 */
async function restoreSnapshot(project, name) {
	if (state.pendingSnapshotRestore !== name) {
		state.pendingSnapshotRestore = name;
		openSnapshotDialog(project);
		return;
	}
	state.pendingSnapshotRestore = null;
	try {
		await api("/api/projects/" + project.id + "/snapshots/" + encodeURIComponent(name), { method: "POST" });
	} catch (error) {
		toast("回滚失败：" + error.message, "error");
		return;
	}
	closeDialog($("snapshot-dialog"));
	// 案上这部的稿子可能整本换了，必须重新拉一遍。
	if (state.projectId === project.id) await selectProject(project.id);
	await reloadProjects();
	await reloadLibrary();
	renderView();
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
		toast("删除失败：" + error.message, "error");
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
	// 手上那一轮同样作废：它的节点马上要被清掉，再往里写就是给下一部作品添字。
	state.streamEpoch += 1;
	endStream();
	dismissWaiting();
	clearEditorState();
	state.editing = false;
	state.projectId = null;
	state.project = null;
	state.stats = null;
	state.chapterId = null;
	resetProjectSessions();
	state.uploads = [];
	setStreaming(null);
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
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger btn-danger" : ""), () =>
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
		toast("删除失败：" + error.message, "error");
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
	openDialog($("project-dialog"));
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
	openDialog($("promote-dialog"));
}

// ═══════════════════════════════════════════════════ 稿

function renderManuscriptView() {
	const box = $("view-manuscript");
	const project = state.project;
	box.replaceChildren();
	$("stage-actions").replaceChildren();

	if (!state.chapterId) renderFrontMatter(box, project);
	else renderChapter(box, project);

	$("project-stats").textContent = statsLine();
}

function renderFrontMatter(box, project) {
	$("stage-actions").append(
		button("拟新章", "btn btn-quiet btn-sm", () => {
			switchViewNow("materials");
			$("material-input").value = "接着现有的情节往后拟一章，先用 update_outline 立下章目再落笔。";
			$("material-input").focus();
		}),
	);
	// 总目这一页是「整本」的地盘，成册的出口放这里最顺手。
	$("stage-actions").append(button("导出全书", "btn btn-quiet btn-sm", () => openExportDialog(null)));

	const page = el("div", "front-matter");
	const head = el("div", "front-head");
	head.append(el("h2", "", project.title));
	head.append(el("p", "", [project.genre, project.logline].filter(Boolean).join(" · ") || "尚未题写一句话骨相"));
	if (project.targetWords) {
		const done = project.outline.reduce((sum, chapter) => sum + (project.drafts[chapter.id] ? countWords(project.drafts[chapter.id].content) : 0), 0);
		head.append(
			el(
				"p",
				"front-progress",
				"已成 " + fmt(done) + " / " + fmt(project.targetWords) + " 字（" + Math.round((done / project.targetWords) * 100) + "%）",
			),
		);
	}
	page.append(head);

	if (project.outline.length === 0) {
		page.append(el("div", "empty-hint", "章目尚虚。切到「料」，让设定官先把骨节列出来。"));
	} else {
		const toc = el("ol", "toc");
		project.outline.forEach((chapter, index) => {
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const item = el("li", "toc-item");
			item.tabIndex = 0;
			item.setAttribute("role", "button");
			item.append(el("h3", "", chapter.title));
			item.append(el("p", "", chapter.summary || "（未写要略）"));
			const bits = ["第" + toCn(index + 1) + "章", statusLabel(chapter.status), chapter.pov];
			if (chapter.targetWords) bits.push("目标 " + fmt(chapter.targetWords) + " 字");
			if (words) bits.push("已成 " + fmt(words) + " 字");
			bits.push("装料 " + chapter.materialIds.length + " 条");
			item.append(el("div", "toc-meta", bits.filter(Boolean).join(" · ")));
			const open = () => openChapter(chapter.id);
			item.addEventListener("click", open);
			item.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			});
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
	$("stage-actions").append(
		button("总目", "btn btn-quiet btn-sm", () => {
			void (async () => {
				if (!(await flushEditor())) return;
				clearEditorState();
				state.editing = false;
				state.chapterId = null;
				writeStored(chapterKey(state.projectId), "");
				renderAll();
			})();
		}),
	);
	if (prev) $("stage-actions").append(navButton(prev.id, "前章"));
	$("stage-actions").append(el("span", "muted", toCn(index + 1) + " / " + toCn(project.outline.length)));
	if (next) $("stage-actions").append(navButton(next.id, "后章"));

	const page = el("div", "ms-page");
	const head = el("div", "ms-head");
	head.append(el("p", "ms-kicker", "第" + toCn(index + 1) + "章" + (chapter.pov ? " · " + chapter.pov : "")));
	head.append(el("h1", "ms-title", chapter.title));
	head.append(el("div", "ms-rule"));
	const meta = [];
	if (words) meta.push(fmt(words) + " 字");
	if (draft) meta.push("第 " + draft.revision + " 稿");
	if (draft?.updatedAt) meta.push("存于 " + fmtTime(draft.updatedAt));
	if (chapter.targetWords) meta.push("目标 " + fmt(chapter.targetWords) + " 字");
	meta.push("装料 " + chapter.materialIds.length + " 条");
	head.append(el("p", "ms-meta", meta.join(" · ")));
	page.append(head);

	if (state.editing) {
		const editor = document.createElement("textarea");
		editor.className = "ms-edit";
		editor.value = content;
		editor.placeholder = "此处落笔。空行分段。";
		// 高度跟着内容长：稿子多长就铺多长，别把作者关进一扇 420px 的小窗。
		// 外层稿台是滚动容器，所以这里长高不会把版式顶坏。
		editor.addEventListener("input", () => {
			fitEditor(editor);
			markEditorDirty();
		});
		editor.addEventListener("blur", () => {
			// 焦点离开稿台往往意味着要切走：先落盘，再让下一步行动。
			if (state.editorDirty) void autoSaveNow();
		});
		editor.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				void (async () => {
					if (!(await flushEditor())) return;
					clearEditorState();
					state.editing = false;
					renderAll();
				})();
			}
		});
		page.append(editor);
		// 这一刻元素还没进文档，scrollHeight 是 0，得等它挂上去再量。
		requestAnimationFrame(() => fitEditor(editor));
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

	// 操作条排在正文之前：写作时手要够得着「存稿」，
	// 不该被一整章的篇幅压在底下（条子自己吸顶，滚多远都在）。
	box.append(chapterToolbar(chapter, index, content));
	box.append(page);
}

/**
 * 把改稿框撑到内容全高。
 *
 * 固定高度的 textarea 只在框内滚动：4691 字的一章被关进 420px，
 * 改一句话就要在里头翻半天。这里让它一次铺开，滚动交给外层稿台。
 */
function fitEditor(editor) {
	// 重渲染后旧节点会脱开文档，再量它只会白算一次。
	if (!editor.isConnected) return;
	editor.style.height = "auto";
	editor.style.height = editor.scrollHeight + "px";
}

function navButton(id, label) {
	return button(label, "btn btn-quiet btn-sm", () => openChapter(id));
}

function chapterToolbar(chapter, index, content) {
	const bar = el("div", "actions actions-center");
	const draft = state.project.drafts[chapter.id];

	if (state.editing) {
		const save = button("存稿", "btn btn-ink btn-sm", async () => {
			save.disabled = true;
			const ok = await autoSaveNow();
			save.disabled = false;
			if (!ok) return;
			state.editing = false;
			clearEditorState();
			renderAll();
			toast("已存稿 · 第 " + (state.project.drafts[chapter.id]?.revision ?? 1) + " 稿", "ok", 2200);
		});
		save.title = "存稿并退出改稿（Ctrl+S 只存不退）";
		bar.append(save);
		bar.append(
			button("作罢", "btn btn-quiet btn-sm", () => {
				if (state.editorDirty && !window.confirm("这一稿还没存，作罢会丢掉刚才的改动。继续？")) return;
				clearEditorState();
				state.editing = false;
				renderAll();
			}),
		);
		const state_ = el("span", "ms-save-state");
		state_.id = "ms-save-state";
		bar.append(state_);
		syncSaveState();
	} else {
		bar.append(
			button(content ? "改稿" : "起稿", "btn btn-sm", () => {
				state.editing = true;
				renderView();
			}),
		);
		if (draft) {
			const state_ = el("span", "ms-save-state");
			state_.textContent = "存于 " + fmtTime(draft.updatedAt);
			bar.append(state_);
		}
	}

	// 成文动作在生文工作台里做，这里只负责把作者送过去。
	bar.append(
		button(content ? "重写此章" : "装料成文", "btn btn-ink btn-sm", () => {
			void (async () => {
				if (!(await flushEditor())) return;
				switchViewNow("writing");
				$("writing-input").focus();
			})();
		}),
	);
	bar.append(
		button("让执笔者评此章", "btn btn-quiet btn-sm", () => {
			void (async () => {
				if (!(await flushEditor())) return;
				switchViewNow("writing");
				$("writing-input").value = "读一下第" + toCn(index + 1) + "章《" + chapter.title + "》，说说问题在哪，先别改。";
				$("writing-input").focus();
			})();
		}),
	);
	// 版本：服务端每次覆盖保存都留了档，这里只是把已有的东西摆出来。
	const historyCount = draft?.history.length ?? 0;
	bar.append(
		button("版本" + (historyCount ? " " + historyCount : ""), "btn btn-quiet btn-sm", () => openHistoryDialog(chapter.id)),
	);
	bar.append(button("导出", "btn btn-quiet btn-sm", () => openExportDialog(chapter.id)));
	bar.append(button("排版", "btn btn-quiet btn-sm", () => openTypeDialog()));
	const focusBtn = button(state.focusMode ? "退出专注" : "专注", "btn btn-quiet btn-sm" + (state.focusMode ? " is-on" : ""), () => {
		setFocusMode(!state.focusMode);
		// 只改这一枚按钮，不重绘稿台：改稿时重绘会把 textarea 里的字连同光标一起换掉。
		focusBtn.textContent = state.focusMode ? "退出专注" : "专注";
		focusBtn.classList.toggle("is-on", state.focusMode);
	});
	bar.append(focusBtn);
	return bar;
}

async function saveChapter(chapterId, content, autosave = false) {
	return api("/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(chapterId), {
		method: "PATCH",
		body: autosave ? { content, autosave: true } : { content },
	});
}

// ── 自动存稿

/**
 * 自动存稿只做「别丢字」这一件事：停顿约一秒半写一次盘，
 * 但带 autosave 标记，不占版本历史 —— 版本点是手动存稿与执笔者成文。
 */
function markEditorDirty() {
	state.editorDirty = true;
	state.editorSavedAt = 0;
	syncSaveState();
	scheduleAutosave();
}

function scheduleAutosave() {
	clearTimeout(state.editorTimer);
	state.editorTimer = setTimeout(() => {
		void autoSaveNow();
	}, 1400);
}

function clearEditorState() {
	clearTimeout(state.editorTimer);
	state.editorTimer = null;
	state.editorDirty = false;
	state.editorSaving = false;
	state.editorSavingPromise = null;
	state.editorSavedAt = 0;
}

/** 把一次成功的写入同步到内存与页面上，但不重绘稿台 —— 重绘会抢走光标。 */
function applySavedChapter(chapterId, data) {
	if (!state.project || !data?.chapter) return;
	state.project.drafts[chapterId] = data.chapter;
	if (data.stats) state.stats = data.stats;
	$("project-stats").textContent = statsLine();
	renderChapters();
}

async function autoSaveNow() {
	if (state.editorSavingPromise) await state.editorSavingPromise.catch(() => false);
	if (!state.editing || !state.editorDirty) return true;
	const editor = $("view-manuscript").querySelector(".ms-edit");
	if (!editor) return true;
	const chapterId = state.chapterId;
	const content = editor.value;
	state.editorSaving = true;
	syncSaveState();
	const task = (async () => {
		try {
			const data = await saveChapter(chapterId, content, true);
			if (state.chapterId !== chapterId) return true;
			applySavedChapter(chapterId, data);
			state.editorSavedAt = Date.now();
			// 保存期间又敲了字：仍算未存，再排一次。
			const latest = $("view-manuscript").querySelector(".ms-edit");
			state.editorDirty = Boolean(state.editing && latest && latest.value !== content);
			if (state.editorDirty) scheduleAutosave();
			return true;
		} catch (error) {
			toast("自动存稿失败：" + error.message + "。改动还在编辑框里，可再点「存稿」。", "error", 7000);
			return false;
		} finally {
			state.editorSaving = false;
			state.editorSavingPromise = null;
			syncSaveState();
		}
	})();
	state.editorSavingPromise = task;
	return task;
}

/** 离开稿台前把未存的改动落盘；落不下去就问一句，别替作者做决定。 */
async function flushEditor() {
	clearTimeout(state.editorTimer);
	if (!state.editing || !state.editorDirty) return true;
	const ok = await autoSaveNow();
	if (ok) return true;
	const discard = window.confirm("这一稿没能存到磁盘，仍要离开并丢弃刚才的改动吗？");
	if (discard) {
		// 既然选择丢弃，就把编辑态一并收掉：否则回到稿台时还是「未存」，下次离开又问一遍。
		clearEditorState();
		state.editing = false;
	}
	return discard;
}

function syncSaveState() {
	const node = $("ms-save-state");
	if (!node) return;
	if (state.editorSaving) {
		node.textContent = "存稿中…";
		node.classList.remove("is-dirty");
	} else if (state.editorDirty) {
		node.textContent = "未存";
		node.classList.add("is-dirty");
	} else if (state.editorSavedAt) {
		node.textContent = "已存 " + fmtTime(state.editorSavedAt);
		node.classList.remove("is-dirty");
	} else {
		node.textContent = "自动存稿已开";
		node.classList.remove("is-dirty");
	}
	node.title = "停顿约 1.4 秒自动写入磁盘；Ctrl+S 立即保存";
}

/**
 * 导出对话框。
 *
 * 范围与格式一次选清：操作条上不再摆四个按钮，作者也不用猜 Markdown 从哪来。
 * 打开前先把未存的改动落盘 —— 导的是磁盘上的稿，不该比屏幕上少一段。
 */
function openExportDialog(chapterId) {
	void (async () => {
		if (!(await flushEditor())) return;
		const form = $("export-form");
		form.reset();
		$("export-error").textContent = "";
		state.exportChapterId = chapterId ?? null;
		const index = chapterId ? state.project.outline.findIndex((chapter) => chapter.id === chapterId) : -1;
		const chapter = index >= 0 ? state.project.outline[index] : null;
		const chapterRadio = form.querySelector('input[name="scope"][value="chapter"]');
		chapterRadio.disabled = !chapter;
		chapterRadio.checked = Boolean(chapter);
		form.querySelector('input[name="scope"][value="book"]').checked = !chapter;
		$("export-hint").textContent = chapter
			? "当前：第" + toCn(index + 1) + "章《" + chapter.title + "》"
			: "整本成册；未落笔的章节会被跳过。";
		openDialog($("export-dialog"));
	})();
}

/**
 * 下载导出件。
 *
 * 不用 window.location 直接跳：那样一旦失败，用户只会看到浏览器里一页看不懂的 JSON。
 * 走 fetch 能把服务端的错误原话拿出来。文件名从 content-disposition 取回 ——
 * 服务端按 RFC 5987 编过，这里解回中文，否则下载下来会叫 novel.txt。
 */
async function exportProject(chapterId, format = "txt") {
	// 一章未落笔就导出，拿到的只是一个空文件。先拦住，比让用户对着空文件发愣好。
	const hasText = chapterId
		? Boolean(state.project?.drafts[chapterId]?.content.trim())
		: Object.values(state.project?.drafts ?? {}).some((draft) => draft.content.trim());
	if (!hasText) {
		toast(chapterId ? "这一章还没有正文可导出。" : "这部作品还没有正文可导出。", "warn");
		return false;
	}
	const params = new URLSearchParams();
	if (chapterId) params.set("chapter", chapterId);
	if (format === "md") params.set("format", "md");
	const query = params.size ? "?" + params.toString() : "";
	try {
		const res = await fetch("/api/projects/" + state.projectId + "/export" + query);
		if (!res.ok) {
			const detail = await res.json().catch(() => null);
			throw new Error(detail?.error || "导出失败（" + res.status + "）");
		}
		const text = await res.text();
		if (!text.trim()) throw new Error("这部作品还没有正文可导出");
		const type = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
		const url = URL.createObjectURL(new Blob([text], { type }));
		const link = document.createElement("a");
		const name = exportName(res) || ("novel." + (format === "md" ? "md" : "txt"));
		link.href = url;
		link.download = name;
		document.body.append(link);
		link.click();
		link.remove();
		// 立刻回收会让部分浏览器来不及取用这个 URL，延后一拍更稳。
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
		toast("已导出：" + name, "ok", 3200);
		return true;
	} catch (error) {
		toast("导出失败：" + error.message, "error", 6000);
		$("export-error").textContent = "导出失败：" + error.message;
		return false;
	}
}

/** 从 content-disposition 里取回文件名。优先 filename*，它才是中文名的载体。 */
function exportName(res) {
	const header = res.headers.get("content-disposition") ?? "";
	const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8) {
		try {
			return decodeURIComponent(utf8[1]);
		} catch {
			// 编码坏了就退到后面那个 ASCII 名，别让整次导出白费。
		}
	}
	return (header.match(/filename="?([^";]+)"?/i) ?? [])[1] ?? "";
}

// ── 版本

/**
 * 版本抽屉。
 *
 * 服务端每次覆盖保存都会把旧稿记进 draft.history（最近 10 版），
 * 但此前界面上没有入口 —— 数据在，人取不到。这里把它摆出来：
 * 看每一版的来源、时间、字数，可展开读全文，也可一键换回。
 */
function openHistoryDialog(chapterId) {
	void (async () => {
		if (!(await flushEditor())) return;
		state.pendingRestore = null;
		$("history-error").textContent = "";
		renderHistoryList(chapterId);
		openDialog($("history-dialog"), { focus: "self" });
	})();
}

function renderHistoryList(chapterId) {
	const project = state.project;
	const index = project.outline.findIndex((chapter) => chapter.id === chapterId);
	const chapter = project.outline[index];
	const draft = project.drafts[chapterId];
	const list = $("history-list");
	list.replaceChildren();
	$("history-subtitle").textContent = chapter
		? "第" + toCn(index + 1) + "章《" + chapter.title + "》 · 当前第 " + (draft?.revision ?? 0) + " 稿"
		: "";
	if (!draft) {
		list.append(el("div", "bench-empty", "这一章还没有正文，也就没有版本。"));
		return;
	}

	const wordCount = countWords(draft.content);
	const current = el("div", "history-row is-current");
	const currentHead = el("div", "history-head");
	currentHead.append(el("span", "history-version", "当前稿"));
	currentHead.append(el("span", "history-mode", "第 " + draft.revision + " 稿"));
	currentHead.append(el("span", "history-when", fmtTime(draft.updatedAt)));
	currentHead.append(el("span", "history-words", fmt(wordCount) + " 字 · 装料 " + draft.materialIds.length + " 条"));
	current.append(currentHead);
	const currentDetails = el("details", "history-preview");
	currentDetails.append(el("summary", "", "看当前全文"));
	currentDetails.append(el("pre", "history-text", draft.content || "（空）"));
	current.append(currentDetails);
	list.append(current);

	const history = [...draft.history].reverse();
	if (history.length === 0) {
		list.append(el("div", "history-empty", "还没有旧版本。手动存稿或执笔者写入时，被覆盖的那一版会记在这里。"));
		return;
	}
	for (const revision of history) {
		const key = chapterId + ":" + revision.revision;
		const row = el("div", "history-row");
		const head = el("div", "history-head");
		head.append(el("span", "history-version", "第 " + revision.revision + " 稿"));
		head.append(el("span", "history-mode", revisionModeLabel(revision.mode)));
		head.append(el("span", "history-when", fmtTime(revision.updatedAt)));
		head.append(el("span", "history-words", fmt(countWords(revision.content)) + " 字 · 装料 " + revision.materialIds.length + " 条"));
		row.append(head);

		const details = el("details", "history-preview");
		details.append(el("summary", "", "看这一版"));
		details.append(el("pre", "history-text", revision.content || "（空）"));
		row.append(details);

		const confirming = state.pendingRestore === key;
		row.append(
			button(confirming ? "再点一次确认恢复" : "恢复此版", "btn btn-quiet btn-xs" + (confirming ? " is-danger btn-danger" : ""), () =>
				void restoreRevision(chapterId, revision.revision),
			),
		);
		if (confirming) row.append(el("p", "history-hint", "当前稿会先被存档，恢复本身也可以再撤回来。"));
		list.append(row);
	}
}

async function restoreRevision(chapterId, revisionNumber) {
	const key = chapterId + ":" + revisionNumber;
	if (state.pendingRestore !== key) {
		state.pendingRestore = key;
		renderHistoryList(chapterId);
		return;
	}
	state.pendingRestore = null;
	const draft = state.project?.drafts[chapterId];
	const revision = draft?.history.find((item) => item.revision === revisionNumber);
	if (!revision) {
		$("history-error").textContent = "这一版已经不在存照里了，可能被更新的版本挤掉。";
		renderHistoryList(chapterId);
		return;
	}
	try {
		const data = await api("/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(chapterId), {
			method: "PATCH",
			body: { content: revision.content },
		});
		state.project.drafts[chapterId] = data.chapter;
		state.stats = data.stats;
		state.editing = false;
		clearEditorState();
		closeDialog($("history-dialog"));
		renderAll();
		toast("已恢复到第 " + revisionNumber + " 稿；恢复前的稿已存档。", "ok", 4200);
	} catch (error) {
		$("history-error").textContent = "恢复失败：" + error.message;
	}
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
	syncInput("material-search", state.materialQuery);

	renderPickedMaterials();

	const list = $("material-list");
	list.replaceChildren();
	const filtered = project.materials.filter((material) => {
		if (state.materialFilter && material.kind !== state.materialFilter) return false;
		return matchesQuery(
			state.materialQuery,
			material.title,
			material.usage,
			material.content,
			material.tags.join(" "),
			kindLabel(material.kind),
		);
	});
	if (state.materialQuery.trim() && project.materials.length > 0) {
		$("material-count").textContent = "匹配 " + filtered.length + " / " + project.materials.length + " 条";
	}
	if (filtered.length === 0) {
		list.append(
			el(
				"div",
				"bench-empty",
				project.materials.length === 0
					? "素材库还是空的。\n左边上传资料，或直接交代要立什么设定 —— 素材是一切之先。"
					: state.materialQuery.trim()
						? "没有匹配「" + state.materialQuery.trim() + "」的素材。\n换个词，或清空检索框。"
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
		const group = el("div", "mat-group");
		const head = el("div", "mat-group-head");
		head.append(el("h3", "", kindLabel(kind)));
		head.append(el("span", "count", materials.length + " 条"));
		group.append(head);
		// 组内单独一个 grid：分组标题是整行的，卡片才两列并排。
		const grid = el("div", "mat-grid");
		for (const material of materials) grid.append(materialCard(material));
		group.append(grid);
		list.append(group);
	}
}

/**
 * 素材卡的公共外壳：标题、种类、用法。
 *
 * 素材库与生文工作台的两处列表共用它。同一份素材在两处长得不一样，
 * 作者每换个工作台就得重新认一遍哪张卡是干什么的。
 * 元信息单独一个函数，因为右案的紧凑列表要把它排在行内展开的正文之后。
 */
function materialCardShell(material) {
	const card = el("div", "card mat");
	if (state.pickedMaterials.has(material.id)) card.classList.add("is-picked");
	const head = el("div", "mat-head");
	head.append(el("h4", "", material.title));
	head.append(el("span", "kind", kindLabel(material.kind)));
	if (material.status === "confirmed") head.append(el("span", "ok", "已确认"));
	card.append(head);
	if (material.usage) card.append(el("div", "usage", "用于：" + material.usage));
	return card;
}

/** 标签、装入情况、来源、字数 —— 一行小字。 */
function appendMaterialMeta(card, material) {
	const meta = [];
	if (material.tags.length) meta.push("标签：" + material.tags.join("、"));
	const names = material.chapterIds.map(chapterTitleOf).filter(Boolean);
	if (names.length) meta.push("已装入：" + names.join("、"));
	const sourceLabel =
		material.source === "agent" ? "墨客所拟" : material.source === "library" ? "取自素材库" : "书者所定";
	meta.push(material.originId ? sourceLabel + " · 已入素材库" : sourceLabel);
	if (material.content) meta.push(fmt(countWords(material.content)) + " 字");
	card.append(el("div", "tagline", meta.join(" · ")));
}

/**
 * 让一张素材卡可点、可拖。
 *
 * 动作条由调用方拼好传进来：两处列表能做的事不同（库里有六件，装配只有摘除与装入）。
 * 但「点开看全文」和「拖给智能体」是两处都该有的，所以收在这里，免得各写一遍走样。
 */
function makePeekable(card, material, actions, dropHint) {
	card.classList.add("is-peek");
	card.tabIndex = 0;
	card.setAttribute("role", "button");
	const picked = state.pickedMaterials.has(material.id);
	// 鼠标能拖，点一下留给「看全文」；手指拖不动（拖拽和滚动抢同一个手势），
	// 于是触屏上把「点一下」改成选中，真正的动作交给下面「已选中」条上的按钮。
	//
	// 但「选中」只在素材工作台里有下文（那儿才有一条「已选中」栏）；
	// 生文工作台的卡片上本就摆着「看全文 / 装入本章」，点一下该是看全文 ——
	// 否则点完什么都不显，人只会以为没点中。
	const coarse = isCoarsePointer();
	const picksOnTap = coarse && state.view === "materials" && state.mode === "workspace";
	if (picked) card.classList.add("is-picked");
	// 只有「点一下算选中」时才报 aria-pressed；别的时候这个属性会让人以为按钮卡住了。
	if (picksOnTap) card.setAttribute("aria-pressed", picked ? "true" : "false");
	else card.removeAttribute("aria-pressed");
	card.setAttribute("aria-label", (picksOnTap ? "选中素材：" : "查看素材：") + material.title);
	card.title = picksOnTap
		? "点一下选中／取消，再在下方「已选中」条上按「装进本章」"
		: "点开看全文；" + dropHint;
	const open = () => openMaterialView(material);
	const onTap = () => {
		if (picksOnTap) toggleMaterialPick(material.id);
		else open();
	};
	card.addEventListener("click", onTap);
	card.addEventListener("keydown", (event) => {
		if (event.target !== card) return;
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onTap();
		}
	});
	makeDraggable(card, material);
	// 动作在卡内，别让点按钮顺手把卡也点开了。
	actions.addEventListener("click", (event) => event.stopPropagation());
	card.append(actions);
	return card;
}

/** 素材卡。紧凑模式下收起动作，点一下即可修改。 */
function materialCard(material, options = {}) {
	const card = materialCardShell(material);
	const open = state.openMaterials.has(material.id);

	if (options.compact) {
		// 右案的窄栏仍是行内展开，正文排在元信息之前。
		if (open && material.content) card.append(el("div", "mat-body", material.content));
		appendMaterialMeta(card, material);
		card.classList.add("is-compact");
		card.tabIndex = 0;
		card.setAttribute("role", "button");
		card.title = "点开看全文";
		const openView = () => openMaterialView(material);
		card.addEventListener("click", openView);
		card.addEventListener("keydown", (event) => {
			if (event.target !== card) return;
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openView();
			}
		});
		return card;
	}

	appendMaterialMeta(card, material);

	const actions = el("div", "mat-actions");
	actions.append(button("看全文", "btn btn-quiet btn-xs", () => openMaterialView(material)));

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
		button(pending ? "再点一次确认删除" : "删", "btn btn-quiet btn-xs" + (pending ? " is-danger btn-danger" : ""), () =>
			void deleteMaterial(material),
		),
	);
	return makePeekable(card, material, actions, "拖到右侧「设定官」即算呈给它");
}

/**
 * 只读地看素材全文。
 *
 * 与编辑表单分开：看是看，改是改。作者在两列卡片里点开一条时只想读一遍，
 * 不该被扔进一张要填满标题、usage、正文的表单里。
 */
function openMaterialView(material) {
	$("material-view-title").textContent = material.title;
	$("material-view-meta").textContent =
		[kindLabel(material.kind), material.status === "confirmed" ? "已确认" : "草稿", fmt(countWords(material.content)) + " 字"]
			.filter(Boolean)
			.join(" · ");
	$("material-view-usage").textContent = material.usage ? "用于：" + material.usage : "";
	$("material-view-usage").classList.toggle("hidden", !material.usage);
	$("material-view-body").textContent = material.content || "（此条尚无正文）";
	// 读稿用的面板，没有输入框：焦点落在面板上，读屏从头念一遍。
	openDialog($("material-view"), { focus: "self" });
}

/**
 * 让素材卡可以拖给设定官。
 *
 * 走 HTML5 拖放，不引依赖。dragover 必须 preventDefault，否则不会触发 drop。
 * 自定义类型 "text/x-material" 优先于 text/plain：拖到别的编辑器上别把内部 id 当文本贴出去。
 */
function makeDraggable(card, material) {
	// 触屏上根本不装拖拽：手指一拖是滚动，dragstart 抢不到，抢到了反而把页面钉住。
	// 触屏那条路是「点卡片选中 → 已选中条上按按钮」，见 renderPickedMaterials。
	if (isCoarsePointer()) {
		card.draggable = false;
		return;
	}
	card.draggable = true;
	card.addEventListener("dragstart", (event) => {
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData("text/x-material", material.id);
		event.dataTransfer.setData("text/plain", material.title);
		card.classList.add("is-dragging");
		// dragover 读不到 dataTransfer 的内容（浏览器只在 drop 时才给），
		// 而落区的提示要说清「这条料会不会顺手装进本章」，所以自己记一笔。
		draggingMaterialId = material.id;
	});
	card.addEventListener("dragend", () => {
		card.classList.remove("is-dragging");
		draggingMaterialId = null;
	});
}

/** 把拖过来的素材收进「已选中」，与点「选中修改」同一条路。 */
function dropMaterial(id) {
	if (!materialById(id)) return;
	state.pickedMaterials.add(id);
	renderView();
}

/**
 * 拖到执笔者的输入框：先确保本章装上了这条料，再把书名号里的标题写进交代。
 *
 * 两步缺一不可 —— 执笔者只拿到本章装配的素材，光把标题写进交代，
 * 它是看不见这条料的内容的，那样「拖给模型」就是个空动作。
 */
async function dropMaterialToComposer(id) {
	const material = materialById(id);
	if (!material) return;
	const chapter = state.project?.outline.find((item) => item.id === state.chapterId);
	if (chapter && !chapter.materialIds.includes(id)) await assemble([id], []);
	const input = $("writing-input");
	const reference = "《" + material.title + "》";
	const start = input.selectionStart ?? input.value.length;
	const end = input.selectionEnd ?? start;
	input.value = input.value.slice(0, start) + reference + input.value.slice(end);
	const caret = start + reference.length;
	input.setSelectionRange(caret, caret);
	input.focus();
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
	// 拖拽在触屏上不可用（见 makeDraggable），所以原来「拖进本章」「拖给执笔者」这两件事
	// 在这里各落一个按钮：点一下即完成，桌面端也能用，不必记两条路。
	bar.append(button("装进本章", "btn btn-ink btn-xs", () => void assemblePicked()));
	bar.append(button("送执笔者", "btn btn-quiet btn-xs", () => void handPickedToWriting()));
	bar.append(
		button("清空", "btn btn-quiet btn-xs", () => {
			state.pickedMaterials = new Set();
			renderView();
		}),
	);
}

/**
 * 把「已选中」的料装进当前这一章。
 *
 * 与把卡拖进装配栏是同一件事（都走 assemble），只是触屏上拖不出 drop，
 * 于是给一个点得到的入口。已在章里的跳过，别重复提交。
 */
async function assemblePicked() {
	const picked = [...state.pickedMaterials].map(materialById).filter(Boolean);
	if (picked.length === 0) return;
	const chapter = state.project?.outline.find((item) => item.id === state.chapterId);
	if (!chapter) {
		toast("先在左栏点开一章，再装料。", "warn", 4200);
		return;
	}
	const add = picked.filter((material) => !chapter.materialIds.includes(material.id)).map((material) => material.id);
	if (add.length === 0) {
		toast("这几条都已在" + (chapterTitleOf(chapter.id) ?? "本章") + "里。", "info", 2800);
		return;
	}
	state.pickedMaterials = new Set();
	await assemble(add, []);
	toast("已装进" + (chapterTitleOf(chapter.id) ?? "本章") + "。", "ok", 2600);
}

/**
 * 把「已选中」的料交给执笔者：装进本章，再把书名号里的标题写进交代。
 *
 * 与拖到执笔者输入框同一条路（见 dropMaterialToComposer）——
 * 执笔者只看得见本章装配的料，光写标题它读不到内容，两步缺一不可。
 */
async function handPickedToWriting() {
	const picked = [...state.pickedMaterials].map(materialById).filter(Boolean);
	if (picked.length === 0) return;
	const chapter = state.project?.outline.find((item) => item.id === state.chapterId);
	const add = chapter
		? picked.filter((material) => !chapter.materialIds.includes(material.id)).map((material) => material.id)
		: [];
	state.pickedMaterials = new Set();
	if (add.length > 0) await assemble(add, []);
	const input = $("writing-input");
	const reference = picked.map((material) => "《" + material.title + "》").join("");
	input.value = input.value.trim() ? input.value.replace(/\s+$/, "") + "\n" + reference : reference;
	switchView("writing");
	input.focus();
	toast(chapter ? "已装进本章，并把标题写进交代。" : "还没开章，只把标题写进交代。", "ok", 3200);
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
		toast("先在左栏点开一章。", "warn");
		return;
	}
	try {
		await api(
			"/api/projects/" + state.projectId + "/chapters/" + encodeURIComponent(state.chapterId) + "/materials",
			{ method: "POST", body: { add, remove } },
		);
	} catch (error) {
		toast("装料失败：" + error.message, "error");
		return;
	}
	await reloadProjectCatching(() => toast("装料已提交，但列表没能刷新，请重试。", "error"));
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
		toast("删除失败：" + error.message, "error");
	}
	await reloadProjectCatching(() => toast("删除已提交，但列表没能刷新，请重试。", "error"));
}

/** 收尾重载的通用兜底：读失败出声，不静默。 */
async function reloadProjectCatching(onError) {
	try {
		await reloadProject();
	} catch (error) {
		onError(error);
	}
}

// ── 上传原料

/**
 * 收下文件并解析成文本。
 *
 * scope 决定两件事：往哪个接口传、传完显示在哪个列表里。
 * 库作用域不能拿 projectId 当门槛 —— 作者还没建书时也要能喂资料给设定官。
 */
async function handleFiles(files, scope = "material") {
	if (scope === "material" && !state.projectId) return;
	for (const file of files) {
		const entry = { id: crypto.randomUUID(), filename: file.name, status: "loading", scope };
		state.uploads.unshift(entry);
		renderUploads(scope);
		try {
			const query = "?filename=" + encodeURIComponent(file.name);
			const url = scope === "library" ? "/api/uploads" + query : "/api/projects/" + state.projectId + "/uploads" + query;
			const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "上传失败 (" + res.status + ")");
			Object.assign(entry, { status: "ready" }, data.upload);
		} catch (error) {
			Object.assign(entry, { status: "error", error: error.message });
		}
		renderUploads(scope);
	}
}

function renderUploads(scope = "material") {
	// 库作用域的原料列在自己的容器里：两边混在一起会让人分不清
	// 这份资料是给作品备的料，还是给通用素材库备的。
	const list = $(scope === "library" ? "library-uploads" : "upload-list");
	if (!list) return;
	list.replaceChildren();
	for (const entry of state.uploads.filter((item) => (item.scope ?? "material") === scope)) {
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
					el("div", "upload-note warn", "篇幅很长，交设定官会占掉大量上下文，可能要等很久或超出模型窗口"),
				);
			}
			row.append(el("div", "upload-preview", entry.text.slice(0, 140).replace(/\n+/g, " ") + "…"));

			const actions = el("div", "upload-actions");
			// 库作用域没有"作品内素材"这回事：它写的是通用素材库，
			// 所以只给"交提炼"，不给"存入素材库"（那个要选章节归属）。
			if (scope !== "library") {
				actions.append(button("存入素材库", "btn btn-quiet btn-xs", () => openMaterialDialog({ mode: "create", upload: entry })));
			}
			actions.append(button("交设定官提炼", "btn btn-quiet btn-xs", () => void refineUpload(entry)));
			actions.append(
				button("丢弃", "btn btn-quiet btn-xs", () => {
					state.uploads = state.uploads.filter((item) => item !== entry);
					renderUploads(scope);
				}),
			);
			row.append(actions);
		}
		list.append(row);
	}
}

/**
 * 把整篇资料丢给设定官，让它拆成素材条目。
 *
 * 两个作用域的指令不同：作品里提炼的是"这本书要用的料"，
 * 库里提炼的必须是脱离作品也成立的通用料 —— 同一份资料喂进去，
 * 前者会写成"本书的男主"，后者不能这么写。
 */
async function refineUpload(entry) {
	if (state.streaming) return;
	const pane = entry.scope === "library" ? "library" : "material";
	entry.status = "sent";
	renderUploads(pane);
	const tail =
		(entry.truncated ? "（原文过长，只有前 " + entry.text.length + " 字。）" : "") +
		"\n\n---- 资料开始 ----\n" + entry.text + "\n---- 资料结束 ----";
	const ask =
		pane === "library"
			? "以下是我上传的资料《" + entry.filename + "》。请从中提炼**通用素材**：世界观底色、可复用的角色骨架、典型场景、惯用桥段、伏笔套路各归其类。" +
				"逐条用 upsert_material 落盘，usage 写清什么情况下该用。" +
				"注意这些料将来会被多部作品取用，所以要写成脱离本书也成立的说法，不要出现具体书名、人名与只在这一部里成立的设定。"
			: "以下是我上传的资料《" + entry.filename + "》。请从中提炼素材：人物、世界观、场景地点、桥段、伏笔各归其类，" +
				"逐条用 upsert_material 落盘，usage 写清什么情况下该用。";
	await sendMessage(pane, ask + tail);
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
		form.elements.title.value = options.upload?.filename ?? "";
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
	openDialog($("material-dialog"), { focus: '#material-form [name="title"]' });
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
		closeDialog($("material-dialog"));
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

$("material-form-cancel").addEventListener("click", () => closeDialog($("material-dialog")));

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
			poolBox.append(materialGrid(allMaterials, "pool", true));
		}
		return;
	}

	const index = project.outline.findIndex((item) => item.id === chapter.id);
	const draft = project.drafts[chapter.id];
	const words = draft ? countWords(draft.content) : 0;
	$("assembly-chapter").textContent =
		"第" + toCn(index + 1) + "章《" + chapter.title + "》 · " + statusLabel(chapter.status) +
		(words ? " · 已成 " + fmt(words) + " 字" : " · 尚无正文");

	const assembled = chapter.materialIds.map(materialById).filter(Boolean);
	if (assembled.length === 0) {
		assemblyBox.append(el("div", "bench-empty", "本章还没装料。正文由素材组装而成 —— 先从下面挑几条。"));
	} else {
		assemblyBox.append(materialGrid(assembled, "assembled"));
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
		poolBox.append(materialGrid(pool, "pool"));
	}
}

/**
 * 生文工作台里的素材卡：与素材库同一套外壳，只是能做的事不同。
 *
 * assembled 是本章已装的，只能摘除；pool 是库中还没装的，可以装入。
 * locked 指还没有章节 —— 料看得见，但没地方装。
 */
function assemblyCard(material, variant, locked = false) {
	const card = materialCardShell(material);
	appendMaterialMeta(card, material);

	const actions = el("div", "mat-actions");
	actions.append(button("看全文", "btn btn-quiet btn-xs", () => openMaterialView(material)));
	if (variant === "assembled") {
		actions.append(button("摘除", "btn btn-quiet btn-xs", () => void assemble([], [material.id])));
	} else if (locked) {
		const btn = button("装入本章", "btn btn-quiet btn-xs", () => {});
		btn.disabled = true;
		btn.title = "先立一章，才有落点";
		actions.append(btn);
	} else {
		actions.append(button("装入本章", "btn btn-quiet btn-xs", () => void assemble([material.id], [])));
	}
	return makePeekable(card, material, actions, "拖到右侧「执笔者」的输入框即装入本章");
}

/** 一组装配卡，两列并排 —— 与素材库同一套网格。 */
function materialGrid(materials, variant, locked = false) {
	const grid = el("div", "mat-grid");
	for (const material of materials) grid.append(assemblyCard(material, variant, locked));
	return grid;
}

/** 立一章的对话框。 */
function openChapterDialog() {
	const form = $("chapter-form");
	form.reset();
	$("chapter-error").textContent = "";
	form.elements.title.value = "第" + toCn((state.project?.outline.length ?? 0) + 1) + "章";
	openDialog($("chapter-dialog"));
	form.elements.title.select();
}

$("add-chapter").addEventListener("click", () => openChapterDialog());
$("chapter-cancel").addEventListener("click", () => closeDialog($("chapter-dialog")));
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
		closeDialog($("chapter-dialog"));
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
/**
 * 装料成文 / 续写 / 重写。
 *
 * chapterOverride：重试时写回**原来那一章**。作者按的是「刚才那次」的按钮，
 *   不是「现在这一章」—— 中间切了章也不能改写去处。
 * options.repeat：这一轮是重试，对话里留一行「再写一遍」而不是重抄一遍。
 */
async function runWrite(mode, note, chapterOverride, options = {}) {
	if (state.streaming) return;
	const chapterId = chapterOverride ?? state.chapterId;
	if (!chapterId || !state.project) return;

	if (state.project.materials.length === 0) {
		appendMessage("writing", "error", "素材库还是空的。先到「料」上传资料或让设定官备料。");
		return;
	}
	const chapter = state.project.outline.find((item) => item.id === chapterId);
	const label = mode === "rewrite" ? "重写" : mode === "continue" ? "续写" : "成文";
	if (note) $("writing-input").value = "";
	state.writeAbort = new AbortController();
	// 与对议同一条路：这一轮先钉在自己的会话上，作者中途切章也不会把半截丢在错的面板里。
	beginStream("writing");
	appendMessage(
		"writing",
		"user",
		(options.repeat ? "再写一遍" : label) + "《" + (chapter ? chapter.title : chapterId) + "》" + (note ? "：" + note : ""),
	);
	const waiting = showWaiting("writing");
	setStreaming("writing");
	const epoch = state.streamEpoch;
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
		await pumpStream(res, "writing", epoch, waiting, {
			retry: () => retryWrite(mode, note, chapterId),
		});
	} catch (error) {
		dismissWaiting(waiting);
		if (error.name === "AbortError") {
			if (!streamStale(epoch)) appendMessage("writing", "assistant", "已止笔。", epoch);
		} else if (!streamStale(epoch)) {
			appendMessage("writing", "error", error.message, epoch, {
				actions: retryActions(() => retryWrite(mode, note, chapterId)),
			});
			// 这一笔没落成，把交代还给作者；止笔是他自己要停，不还。
			restoreComposer("writing", note);
		}
	} finally {
		dismissWaiting(waiting);
		state.writeAbort = null;
		if (!streamStale(epoch)) {
			endStream();
			setStreaming(null);
			await reloadProjectSafely("writing", "落笔已毕，但右案与章目没能同步刷新");
		}
	}
}

/**
 * 再写一遍：同一章、同一句交代，原样重来。
 *
 * 返回值：发出去没有。按钮据此决定自己是「已重发」还是留在原处。
 */
function retryWrite(mode, note, chapterId) {
	if (state.streaming) {
		toast("这一轮还没收完，稍等片刻再试。", "warn");
		return false;
	}
	void runWrite(mode, note, chapterId, { repeat: true });
	return true;
}

// ═══════════════════════════════════════════════════ 右案

function renderBible() {
	const box = $("bible");
	box.replaceChildren();
	const project = state.project;
	if (!project) return;
	syncInput("bible-search", state.bibleQuery);

	if (state.bibleTab === "materials") {
		if (project.materials.length === 0) {
			box.append(el("div", "bible-empty", "素材库是空的"));
			return;
		}
		const list = project.materials.filter((material) =>
			matchesQuery(state.bibleQuery, material.title, material.usage, material.content, material.tags.join(" "), kindLabel(material.kind)),
		);
		if (list.length === 0) {
			box.append(el("div", "bible-empty", "没有匹配的素材"));
			return;
		}
		for (const material of list) box.append(materialCard(material, { compact: true }));
		return;
	}

	if (state.bibleTab === "outline") {
		if (project.outline.length === 0) {
			box.append(el("div", "bible-empty", "章目尚虚"));
			return;
		}
		let shown = 0;
		project.outline.forEach((chapter, index) => {
			if (!matchesQuery(state.bibleQuery, chapter.title, chapter.summary, statusLabel(chapter.status), chapter.pov)) return;
			shown += 1;
			const draft = project.drafts[chapter.id];
			const words = draft ? countWords(draft.content) : 0;
			const card = el("div", "card");
			card.tabIndex = 0;
			card.setAttribute("role", "button");
			card.append(el("h4", "", toCn(index + 1) + " · " + chapter.title));
			card.append(el("div", "tagline", chapter.summary || "（未写要略）"));
			const meta = [statusLabel(chapter.status), chapter.pov];
			if (words) meta.push(fmt(words) + " 字");
			meta.push("装料 " + chapter.materialIds.length + " 条");
			card.append(el("div", "tagline", meta.filter(Boolean).join(" · ")));
			card.style.cursor = "pointer";
			const open = () => openChapter(chapter.id);
			card.addEventListener("click", open);
			card.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			});
			box.append(card);
		});
		if (shown === 0) box.append(el("div", "bible-empty", "没有匹配的章目"));
		return;
	}

	const openNotes = project.notes.filter((note) => note.status === "open");
	const notes = openNotes.filter((note) =>
		matchesQuery(state.bibleQuery, note.subject, note.category, note.description),
	);
	if (openNotes.length === 0) {
		box.append(el("div", "bible-empty", "无待办事项"));
		return;
	}
	if (notes.length === 0) {
		box.append(el("div", "bible-empty", "没有匹配的待办"));
		return;
	}
	for (const note of notes) {
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
	// 换卷即换会话：手上那一轮作废，它剩下的 token 不许写进新卷的面板。
	// 案头的「设定官」不绑作品，它那一席要留着 —— 作者换本书接着备料是常事。
	state.streamEpoch += 1;
	endStream();
	dismissWaiting();
	resetProjectSessions();
	state.chapterId = null;
	state.editing = false;
	clearEditorState();
	state.uploads = [];
	state.openMaterials.clear();
	state.pendingDelete = null;
	state.pendingProjectDelete = null;
	state.pendingRestore = null;
	state.exportChapterId = null;
	state.pickedMaterials = new Set();
	// 检索与筛选是「这一卷」的视图状态，换卷必须复位，否则会看见一片空列表还找不到原因。
	state.chapterQuery = "";
	state.materialQuery = "";
	state.libraryQuery = "";
	state.bibleQuery = "";
	state.materialFilter = "";
	state.libraryFilter = "";
	state.bibleTab = "materials";
	syncInput("chapter-filter", "");
	syncInput("material-search", "");
	syncInput("library-search", "");
	syncInput("bible-search", "");
	syncBibleTabs();
	// 用 setStreaming 而不是直接改 state：按钮与下拉的禁用态得一起放开，
	// 不然换卷之后输入框还杵在「落笔中」，人也点不动。
	setStreaming(null);
	$(PANES.material.stream).replaceChildren();
	$(PANES.writing.stream).replaceChildren();

	await reloadProject();
	// 期间又切了别的卷：这一轮的招呼话就不说了，说了也是对着别人案头说。
	if (state.projectId !== id) return;
	// 接回上次翻到的那一章。章目已经不存在就停在总目。
	const rememberedChapter = readStored(chapterKey(id), "");
	state.chapterId = state.project.outline.some((chapter) => chapter.id === rememberedChapter)
		? rememberedChapter
		: null;
	renderChapters();
	appendMessage("material", "assistant", "《" + state.project.title + "》已展上案头。左边上传资料，或直接交代要立什么设定。");
	appendMessage("writing", "assistant", "执笔者在此。左栏装配本章素材，或直接交代要写什么。");
}

/**
 * 换卷时清掉与作品绑定的会话与对话快照。
 *
 * 「库」那席不绑作品：作者在案头备的通用料，不该因为翻了一本书就消失。
 */
function resetProjectSessions() {
	for (const key of [...state.sessions.keys()]) {
		if (key !== "library") state.sessions.delete(key);
	}
	for (const key of [...state.transcripts.keys()]) {
		if (key !== "library") state.transcripts.delete(key);
	}
	state.streamKeys = { ...state.streamKeys, material: null, writing: null };
}

function syncBibleTabs() {
	for (const tab of document.querySelectorAll(".bible-tab")) {
		const on = tab.dataset.tab === state.bibleTab;
		tab.classList.toggle("is-on", on);
		tab.setAttribute("aria-selected", String(on));
	}
	$("bible-search").placeholder =
		state.bibleTab === "materials" ? "搜素材…" : state.bibleTab === "outline" ? "搜章目…" : "搜待办…";
}

/**
 * 读请求发号。
 *
 * enterProject 与 bootstrap 都会调 selectProject，两个请求可能同时在路上；
 * 谁后到谁说了算就等于没有说了算 —— 先发的响应会把 state.project 覆盖成
 * 作者早已离开的那部作品。所以每次读都领一个号，回来时不是最新的那个直接丢掉。
 */
function beginRead(scope) {
	state.readSeq[scope] += 1;
	return state.readSeq[scope];
}

/** 这份响应还是最新一次读的结果吗？不是就别往 state 上落。 */
function isCurrentRead(scope, seq) {
	return state.readSeq[scope] === seq;
}

async function reloadProjects() {
	const seq = beginRead("projects");
	const data = await api("/api/projects");
	if (!isCurrentRead("projects", seq)) return;
	state.projects = data.projects;
}

async function reloadLibrary() {
	const seq = beginRead("library");
	const data = await api("/api/library");
	if (!isCurrentRead("library", seq)) return;
	state.library = data.materials ?? [];
}

async function reloadProject() {
	// id 要在这一刻钉住：它读的是调用时刻的 state.projectId，
	// 途中换卷的话这条响应属于旧卷，回来时会被号与 id 双重挡掉。
	const id = state.projectId;
	if (!id) return;
	const seq = beginRead("project");
	const data = await api("/api/projects/" + id);
	if (!isCurrentRead("project", seq) || state.projectId !== id) return;
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


$("project-form-cancel").addEventListener("click", () => closeDialog($("project-dialog")));

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
			closeDialog($("project-dialog"));
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
			closeDialog($("project-dialog"));
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

$("promote-cancel").addEventListener("click", () => closeDialog($("promote-dialog")));

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
		closeDialog($("promote-dialog"));
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
	// 库面板只有一份对话：它不绑作品，切作品也不该换掉它。
	if (pane === "library") return "library";
	return pane === "writing" ? "writing:" + (state.chapterId ?? "") : "material";
}
/**
 * 把面板切到当前会话的内容上。键没变就什么都不做。
 *
 * 快照按「谁在生成」而不是「面板此刻挂着谁」来存：正在生成的那一份此刻
 * 可能已经不在面板上了，硬拍 box.innerHTML 存的是旧章的对话，
 * 而生成中的节点被换出文档，就此冻成一段半截。
 */
function mountStream(pane) {
	const box = $(PANES[pane].stream);
	const key = activeKey(pane);
	const previous = state.streamKeys[pane];
	if (previous === key) return key;
	const holder = state.streamHolder && state.streamHolder.pane === pane ? state.streamHolder : null;
	if (previous) {
		if (holder && holder.key === previous) {
			// 切走的正是生成中的那一章：把节点整体摘下来寄放到游离容器，
			// 后续 token 继续往同一批节点里写，回来时再原样搬回面板。
			if (holder.node === box) {
				const parked = document.createElement("div");
				parked.append(...box.childNodes);
				holder.node = parked;
			}
		} else {
			state.transcripts.set(previous, box.innerHTML);
		}
	}
	if (holder && holder.key === key) {
		// 切回生成中的那一章：搬回活的节点。快照是半截的，不能拿它盖。
		if (holder.node !== box) {
			box.replaceChildren(...holder.node.childNodes);
			holder.node = box;
		}
	} else {
		box.innerHTML = state.transcripts.get(key) ?? "";
	}
	state.streamKeys[pane] = key;
	// 切回一席时默认贴底；作者随后往上翻，他是在读，不是在等新字。
	state.autoScroll[pane] = true;
	scrollToBottom(pane);
	return key;
}

/**
 * 这一轮内容当前挂在哪个节点上。生成中被切走时是那个游离容器。
 *
 * epoch 是发起这一轮时的代次。代次不对说明这一轮已经作废（换卷、被新的一轮顶掉），
 * 那它就写进一个一次性丢弃的容器：宁可这段字丢掉，也不能落进别人的面板。
 */
function streamNode(pane, epoch = state.streamEpoch) {
	const holder = state.streamHolder;
	if (holder && holder.pane === pane && holder.epoch === epoch) return holder.node;
	if (streamStale(epoch)) return document.createDocumentFragment();
	return $(PANES[pane].stream);
}

/**
 * 开一轮生成：先把这一轮钉在它自己的会话键上。
 * 之后作者爱切章切面板，token 都知道该写回哪一份。
 * 代次也顺手往前拨一格：万一上一轮还在读流，它会发现自己过期而收手。
 */
function beginStream(pane) {
	mountStream(pane);
	endStream();
	state.streamEpoch += 1;
	state.autoScroll[pane] = true;
	// 发话了就不再等着确认"另起一席"：确认态该跟着这一轮一起收掉。
	state.pendingNewChat = null;
	renderNewChatButtons();
	state.streamHolder = {
		pane,
		key: activeKey(pane),
		epoch: state.streamEpoch,
		node: $(PANES[pane].stream),
	};
}

/**
 * 收尾：把生成中的内容按它自己的键落成快照。
 * 无论它此刻挂在面板上还是寄放在游离容器里，都归它自己的会话，不归面板此刻的键。
 */
function endStream() {
	const holder = state.streamHolder;
	if (!holder) return;
	state.streamHolder = null;
	state.transcripts.set(holder.key, holder.node.innerHTML);
}

/** 这一轮是否已经作废（换卷、重新起一轮）。作废了就不能再往界面上写。 */
function streamStale(epoch) {
	return epoch !== state.streamEpoch;
}
/**
 * 往面板里放一条消息。
 *
 * options.actions：消息下头挂一排小动作（失败时的「再试一次」就是它）。
 * options.writing：这条消息还在写 —— 名字后头点一枚呼吸的墨点，
 *   从 assistant 消息建起来到第一个字到达之间，作者得看见它还在忙。
 */
function appendMessage(pane, role, text, epoch, options = {}) {
	const wrap = el("div", "msg " + role);
	wrap.append(
		el("div", "msg-role", role === "user" ? "书者" : role === "error" ? "讹误" : PANES[pane].assistant),
	);
	const body = el("div", "msg-body", text);
	wrap.append(body);
	if (options.writing) wrap.classList.add("is-writing");
	if (options.actions && options.actions.length) {
		const actions = el("div", "msg-actions");
		for (const action of options.actions) {
			// 动作回调要拿到按钮自己（按下之后要把它按成「已重发」），
			// 所以这里包一层，把按钮递进去；事件仍旧给作者。
			const node = button(
				action.label,
				"btn btn-sm btn-quiet" + (action.className ? " " + action.className : ""),
				(event) => action.run(node, event),
			);
			node.type = "button";
			actions.append(node);
		}
		wrap.append(actions);
	}
	streamNode(pane, epoch).append(wrap);
	scrollToBottom(pane, epoch);
	return { wrap, body };
}

function appendTool(pane, name, preview, failed, epoch) {
	const wrap = el("div", "tool" + (failed ? " is-failed" : ""));
	wrap.append(el("span", "tool-mark", failed ? "✕" : "◦"));
	const main = el("div");
	main.append(el("div", "tool-name", name));
	if (preview) main.append(el("div", "tool-preview", preview));
	wrap.append(main);
	streamNode(pane, epoch).append(wrap);
	scrollToBottom(pane, epoch);
	return wrap;
}

function scrollToBottom(pane, epoch) {
	const box = $(PANES[pane].stream);
	// 内容寄放在游离容器里时，滚的是作者看不见的东西，别去触发布局。
	if (streamNode(pane, epoch) !== box) return;
	// 作者往上翻着读，就别每来一个字把他拽回底部。
	if (!state.autoScroll[pane]) return;
	box.scrollTop = box.scrollHeight;
}

// ═══════════════════════════════════════════════════ 等待占位

/**
 * 上游思考与首 token 之间可能空好几十秒。没有占位，界面看起来就是死了。
 * 这里放一条会走秒的「正在落笔」，首字到达即撤。
 *
 * 三点墨依次晕开 —— 转圈的齿轮太像工具了，蘸墨点纸才对味。
 */
function showWaiting(pane) {
	const node = el("div", "msg waiting");
	const dots = el("span", "waiting-dots");
	dots.append(el("i"), el("i"), el("i"));
	node.append(dots, el("span", "waiting-text", "正在落笔…"));
	streamNode(pane).append(node);
	const started = Date.now();
	node.waitingStarted = started;
	node.waitingPhase = "正在落笔…";
	node.waitingTimer = setInterval(() => {
		const text = node.querySelector(".waiting-text");
		if (text) text.textContent = node.waitingPhase + " " + Math.floor((Date.now() - started) / 1000) + " 秒";
	}, 1000);
	scrollToBottom(pane);
	currentWaiting = node;
	return node;
}

/**
 * 等待占位换个说法。
 *
 * 模型在想、在调工具、在等首字，是三件事：界面上都该说清它卡在哪一步，
 * 否则作者只看见"没反应"，以为死了。
 */
function setWaitingPhase(node, phase) {
	if (!node) return;
	node.waitingPhase = phase;
	const text = node.querySelector(".waiting-text");
	if (text) text.textContent = phase + " " + Math.floor((Date.now() - node.waitingStarted) / 1000) + " 秒";
}

function dismissWaiting(node = currentWaiting) {
	if (!node) return;
	clearInterval(node.waitingTimer);
	node.remove();
	if (currentWaiting === node) currentWaiting = null;
}

function setStreaming(pane) {
	state.streaming = pane;
	// 三个面板都要跟着禁用：库面板也能提交，漏掉它会出现"这边还在写、那边能再发一轮"。
	for (const role of ["material", "writing", "library"]) {
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

/**
 * 另起一席：弃掉这个面板当前的对话，下一次发话会开一席干净的。
 *
 * 会话是常驻的，同一个面板反复追问，历史会一直攒下去 ——
 * 既占掉上下文预算，又让模型被前面的旧话牵着走。
 * 弃对话不影响任何已落盘的东西：素材在库里，正文在稿上。
 */
async function startNewChat(pane) {
	// 破坏性动作沿用别处"再点一次确认"的做法，不弹系统 confirm。
	if (state.pendingNewChat !== pane) {
		state.pendingNewChat = pane;
		renderNewChatButtons();
		return;
	}
	state.pendingNewChat = null;

	// 正在跑的那一轮挂在这个会话上，会话没了就该收手 ——
	// 先作废代次再收尾，否则它会把半截内容写回快照。
	if (state.streamHolder && state.streamHolder.pane === pane) {
		state.streamEpoch += 1;
		endStream();
		dismissWaiting();
		setStreaming(null);
	}

	const key = activeKey(pane);
	const sessionId = state.sessions.get(key);
	state.sessions.delete(key);
	state.transcripts.delete(key);
	// 面板此刻若正挂着这一席，得直接把屏上的清掉：
	// mountStream 见到键没变会早退，不会替我们重画。
	if (state.streamKeys[pane] === key) $(PANES[pane].stream).replaceChildren();

	renderNewChatButtons();
	// 服务端那份也要删：不删它会一直挂在内存里，直到 TTL 到期才被回收。
	if (sessionId) fetch("/api/sessions/" + sessionId, { method: "DELETE" }).catch(() => {});
}

/** 二次确认时把按钮改成警示态。 */
function renderNewChatButtons() {
	for (const btn of document.querySelectorAll("[data-newchat]")) {
		const confirming = state.pendingNewChat === btn.dataset.newchat;
		btn.textContent = confirming ? "再点一次：弃掉这席" : "另起一席";
		btn.classList.toggle("is-danger", confirming);
		// 样式层统一认 .btn-danger：只切 is-danger 的话，别人改配色时这一处会掉队。
		btn.classList.toggle("btn-danger", confirming);
	}
}

async function ensureSession(role) {
	const key = activeKey(role);
	const cached = state.sessions.get(key);
	if (cached) return cached;
	const modelRef = $("model-select").value;
	if (!modelRef) throw new Error("请先到设置里备好笔墨");
	// 库作用域不传 projectId：那时作者可能一部书都还没建，
	// 强迫他先随便开一卷才能备料是本末倒置。
	const body =
		role === "library"
			? { scope: "library", role: "material", modelRef, thinkingLevel: $("thinking-select").value }
			: { projectId: state.projectId, role, modelRef, thinkingLevel: $("thinking-select").value };
	if (role === "writing") body.chapterId = state.chapterId;
	const data = await api("/api/sessions", { method: "POST", body });
	state.sessions.set(key, data.sessionId);
	return data.sessionId;
}

/**
 * 把没送出去的话还回输入框。
 *
 * 提交那一刻就清了输入框（按下去立刻有反应，作者才敢确认已经发出），
 * 可这一轮要是断在上游，那句话就没着落了 —— 报错已经够糟，不该再让人
 * 照着自己刚写过的东西重打一遍。只在输入框还空着时还：他已经另写了新话，
 * 就别拿旧话盖掉。
 */
function restoreComposer(pane, text) {
	const node = $(PANES[pane].input);
	if (!node || !text || node.value.trim()) return;
	node.value = text;
	// 走一遍 input 事件，把「输入中」那档按钮态一起点亮。
	node.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 失败之后给一排小动作，目前只有「再试一次」。
 *
 * 上游抽风是常事，让作者把长指令重敲一遍既费事又容易走样。
 * 原样重发才是他要的 —— 这条按钮就是那一下。
 *
 * retry 返回真才把按钮按成「已重发」：返回假说明这一轮还没收完，
 * 按钮得留在原处等人再按。
 */
function retryActions(retry) {
	if (!retry) return [];
	return [
		{
			label: "再试一次",
			run: (node) => {
				if (!retry()) return;
				node.disabled = true;
				node.textContent = "已重发";
			},
		},
	];
}

/**
 * 往某个面板发一句话。
 *
 * options.repeat：这是重试，别再把作者那句话重抄一遍（原文还在上面那条里）。
 * options.outgoing：真正发出去的内容。素材工作台那句会带上装料说明，
 *   重试时必须发**当时**那一份，不能拿现在的装料重新拼 —— 作者按的
 *   是刚才那个「再试一次」，不是「按现在的装料再写一遍」。
 */
async function sendMessage(pane, text, options = {}) {
	if (state.streaming) return;
	if (pane === "writing" && !state.chapterId) {
		appendMessage("writing", "error", "先在左栏点开一章。");
		return;
	}
	// 素材工作台：选中了素材就把「改哪几条」拼进指令；作者看到的仍是他自己的原话。
	const outgoing = options.outgoing ?? (pane === "material" ? withPickedMaterials(text) : text);
	// 先把这一轮钉在它自己的会话上，再落笔：此后作者切章切面板都不影响 token 往哪写。
	beginStream(pane);
	// 重试不重抄那句话 —— 原文就在上面那条里。
	// 但要在对话里留一行「再试一次」，否则作者看见的是自己没说过的话凭空有了回答。
	if (options.repeat) appendMessage(pane, "user", "再试一次");
	else appendMessage(pane, "user", text);
	const waiting = showWaiting(pane);
	setStreaming(pane);
	const epoch = state.streamEpoch;
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
		await pumpStream(res, pane, epoch, waiting, {
			text,
			outgoing,
			retry: () => retryRound(pane, text, outgoing),
		});
	} catch (error) {
		dismissWaiting(waiting);
		if (!streamStale(epoch)) {
			// 服务重启或会话 TTL 到点后，缓存里的会话 id 已经作废。
			// 自动丢掉它，下一次「呈上」就会开一席新的 —— 而不是让作者先去点两次“另起一席”。
			if (/会话/.test(error.message) && /(不存在|过期)/.test(error.message)) {
				state.sessions.delete(activeKey(pane));
				toast("会话已过期，已自动重开一席，请再发一次。", "warn", 5200);
			} else {
				appendMessage(pane, "error", error.message, epoch, {
					actions: retryActions(() => retryRound(pane, text, outgoing)),
				});
			}
			restoreComposer(pane, text);
		}
	} finally {
		dismissWaiting(waiting);
		if (!streamStale(epoch)) {
			endStream();
			setStreaming(null);
			// 设定官这一轮可能新建或改了素材：重载让素材库与生文工作台同步跟上。
			// 库面板尤其要紧 —— 它写的正是库本身，不重载就看不见刚备好的料。
			if (pane === "library") await reloadLibrarySafely(pane, "这一轮已完成，但通用素材库没能刷新");
			else await reloadProjectSafely(pane, "这一轮已完成，但右案与素材库没能同步刷新");
		}
	}
}

/**
 * 重来一遍：把刚才那句话原样再发一次。
 *
 * 作者不该为了上游一次抽风就把整句话重敲一遍 —— 尤其长指令，
 * 重敲一遍十有八九要走样。原样重发才是他要的。
 *
 * 返回值：发出去没有。按钮据此决定自己是"已重发"还是留在原处。
 */
function retryRound(pane, text, outgoing) {
	if (state.streaming) {
		toast("这一轮还没收完，稍等片刻再试。", "warn");
		return false;
	}
	void sendMessage(pane, text, { repeat: true, outgoing });
	return true;
}

/**
 * 收尾重载。裸 await 在 finally 里抛出去就是一条没人接的 rejection：
 * 右案、素材库、章目全停在旧状态，界面看着正常其实已经过期。
 * 至少要让作者看见一句话。
 */
async function reloadProjectSafely(pane, note) {
	try {
		await reloadProject();
	} catch (error) {
		appendMessage(pane, "error", note + "：" + error.message);
	}
}

/** 库面板的收尾重载。与作品那支同理：失败要让作者看见，不能静默过期。 */
async function reloadLibrarySafely(pane, note) {
	try {
		await reloadLibrary();
		// 库面板写的就是库本身，重载完必须重绘，否则刚备好的料不在屏上。
		renderView();
	} catch (error) {
		appendMessage(pane, "error", note + "：" + error.message);
	}
}

/**
 * 消费 NDJSON 事件流。两个工作台与一次性成文共用同一条渲染路径。
 *
 * epoch 是发起这一轮时的流代次：中途换了卷，这一轮就作废了，
 * 剩下的 token 不许再往界面上写 —— 那是另一部作品的面板了。
 */
async function pumpStream(res, pane, epoch = state.streamEpoch, waiting = null, context = {}) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let message = null;
	let thinkingBox = null;
	let thinkingText = null;
	let usage = null;
	let cursor = null;

	/**
	 * 占位让位。
	 *
	 * 只在"真的开始出活"时撤：出了字、开始想了。
	 * 只调工具还没出字时，占位留着，只是换个说法（见 setWaitingPhase）——
	 * 那是作者唯一能看见的"还在动"。
	 */
	const handOver = () => {
		if (!waiting) return;
		dismissWaiting(waiting);
		waiting = null;
	};

	/**
	 * 助手的消息框。没有就建一个，建的时候标上"还在写"。
	 * 那枚呼吸的墨点从建框起挂到第一个字到达为止 —— 中间可能几十秒，
	 * 作者得看见它还在忙，而不是以为卡死了。
	 */
	const ensureMessage = () => {
		if (!message) {
			message = appendMessage(pane, "assistant", "", epoch, { writing: true });
			message.body.classList.add("cursor");
			// 单独挂一个文本节点：逐 token 往它尾巴上追加，
			// 比每个 token 重写整段 textContent 少一次全文重排。
			cursor = document.createTextNode("");
			message.body.append(cursor);
		}
		return message;
	};

	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		if (streamStale(epoch)) {
			await reader.cancel().catch(() => {});
			dismissWaiting(waiting);
			return;
		}
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
				case "text": {
					ensureMessage();
					// 第一个字到了：墨点收工，往后由光标表示"正在写"。
					message.wrap.classList.remove("is-writing");
					handOver();
					thinkingBox = null;
					thinkingText = null;
					cursor.appendData(event.delta);
					scrollToBottom(pane, epoch);
					break;
				}
				case "thinking_start":
					ensureMessage();
					handOver();
					// 思考默认收起：想看再点开，免得把正文挤下去。
					thinkingBox = el("details", "thinking");
					thinkingBox.append(el("summary", "thinking-head", "思考过程"));
					thinkingBox.append(el("div", "thinking-body"));
					thinkingBox.dataset.chars = "0";
					thinkingText = document.createTextNode("");
					thinkingBox.querySelector(".thinking-body").append(thinkingText);
					message.wrap.insertBefore(thinkingBox, message.body);
					break;
				case "thinking": {
					if (!thinkingBox) break;
					if (thinkingText) thinkingText.appendData(event.delta);
					const chars = Number(thinkingBox.dataset.chars || "0") + event.delta.length;
					thinkingBox.dataset.chars = String(chars);
					const head = thinkingBox.querySelector(".thinking-head");
					if (head) head.textContent = "思考过程（" + chars + " 字）";
					break;
				}
				case "tool_start": {
					// 只调工具、还没出字：助手那一栏还是空的，占位接着报进度。
					// 这时候不撤占位 —— 它是作者唯一看得见的"还在动"。
					setWaitingPhase(waiting, "正在行笔…");
					const wrap = appendTool(pane, event.name, "行笔中…", false, epoch);
					wrap.dataset.pending = "1";
					break;
				}
				case "tool_end": {
					const pending = [...streamNode(pane, epoch).querySelectorAll(".tool")].pop();
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
						appendTool(pane, event.name, event.preview, event.isError, epoch);
					}
					scrollToBottom(pane, epoch);
					break;
				}
				case "run_end":
					usage = event.usage;
					if (message) {
						message.body.classList.remove("cursor");
						message.wrap.classList.remove("is-writing");
					}
					if (event.error) appendMessage(pane, "error", event.error, epoch, { actions: retryActions(context.retry) });
					break;
				case "error":
					appendMessage(pane, "error", event.message, epoch, { actions: retryActions(context.retry) });
					break;
				default:
					break;
			}
		}
	}

	if (message) {
		message.body.classList.remove("cursor");
		message.wrap.classList.remove("is-writing");
		// 一轮失败在开口之前：这个框只剩个名字、里头是空的 ——
		// 摆在报错前面像出了故障。想过东西就留着（那也是内容），否则撤掉。
		const thought = message.wrap.querySelector(".thinking-body");
		if (!message.body.textContent.trim() && !(thought && thought.textContent.trim())) {
			message.wrap.remove();
		}
	}
	if (waiting) dismissWaiting(waiting);
	if (usage) {
		streamNode(pane, epoch).append(
			el("div", "msg-foot", "入 " + usage.input + " · 出 " + usage.output + " · " + usage.turns + " 轮"),
		);
		scrollToBottom(pane, epoch);
	}
}

// ═══════════════════════════════════════════════════ 排版、专注与右案抽屉

function syncTypeDialog() {
	const dialog = $("type-dialog");
	if (!dialog) return;
	const groups = [
		["type-size", state.typography.size],
		["type-line", state.typography.line],
		["type-measure", state.typography.measure],
	];
	for (const [id, value] of groups) {
		for (const input of $(id).querySelectorAll("input")) input.checked = Number(input.value) === value;
	}
	$("type-focus").checked = state.focusMode;
}

function openTypeDialog() {
	syncTypeDialog();
	// 一组单选钮，没有要打字的地方：焦点落在「字号」那组的第一枚上。
	openDialog($("type-dialog"), { focus: "#type-size input" });
}

function openShortcutsDialog() {
	openDialog($("shortcuts-dialog"), { focus: "self" });
}

/** 收起 / 张开右案抽屉（只管界面）。 */
function setBibleDrawer(open) {
	document.querySelector(".desk")?.classList.toggle("is-bible-open", open);
	$("bible-backdrop")?.classList.toggle("hidden", !open);
	$("toggle-bible")?.setAttribute("aria-expanded", open ? "true" : "false");
}

function openBibleDrawer() {
	if (findLayer("bible")) return;
	// 章目与右案不同时开：手机上两层盖在一起，谁也点不着。
	// 与 openRailDrawer 对称：接管章目那条历史，返回键只按一次。
	const inherited = closeRailDrawer({ keepHistory: true });
	setBibleDrawer(true);
	openLayer("bible", () => setBibleDrawer(false), { replace: inherited });
}

function closeBibleDrawer(options = {}) {
	if (closeLayer("bible", options)) return true;
	setBibleDrawer(false);
	return false;
}

// ═══════════════════════════════════════════════════ 检索面板

const PALETTE_MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
let paletteItems = [];
let paletteIndex = 0;

/** 面板里的动作。当前没有作品时，与作品相关的动作自动隐藏。 */
function paletteActions() {
	const actions = [
		{ group: "动作", label: "切到文稿", hint: "稿", run: () => switchView("manuscript") },
		{ group: "动作", label: "切到素材工作台", hint: "料", run: () => switchView("materials") },
		{ group: "动作", label: "切到生文工作台", hint: "文", run: () => switchView("writing") },
		{ group: "动作", label: "打开设置", hint: "模型与供应商", run: () => $("open-settings").click() },
		{ group: "动作", label: "键盘快捷键", hint: "?", run: openShortcutsDialog },
		{ group: "动作", label: "切换昼夜", hint: "主题", run: () => toggleTheme() },
	];
	if (state.project) {
		actions.push(
			{ group: "动作", label: "立一章", hint: "新建章目", run: () => openChapterDialog() },
			{ group: "动作", label: "导出", hint: "TXT / Markdown", run: () => openExportDialog(state.chapterId) },
			{ group: "动作", label: "排版", hint: "字号、行距、版心", run: openTypeDialog },
			{ group: "动作", label: state.focusMode ? "退出专注模式" : "进入专注模式", hint: "Esc 退出", run: () => setFocusMode(!state.focusMode) },
			{ group: "动作", label: "存照与回滚", hint: "工程级快照", run: () => void openSnapshotDialog(state.project) },
			{ group: "动作", label: "回案头", hint: "卷宗与通用素材库", run: () => leaveWorkspace() },
		);
	} else {
		actions.push({ group: "动作", label: "另起一卷", hint: "新建作品", run: () => openProjectDialog(null) });
	}
	return actions;
}

function buildPaletteItems() {
	const items = [...paletteActions()];
	const project = state.project;
	if (project) {
		project.outline.forEach((chapter, index) => {
			items.push({
				group: "章目",
				label: "第" + toCn(index + 1) + "章 · " + chapter.title,
				hint: statusLabel(chapter.status) + (chapter.summary ? " · " + chapter.summary : ""),
				run: () => openChapter(chapter.id),
			});
		});
		for (const material of project.materials) {
			items.push({
				group: "素材",
				label: kindLabel(material.kind) + " · " + material.title,
				hint: material.usage || "",
				run: () => openMaterialView(material),
			});
		}
	}
	for (const entry of state.library) {
		items.push({
			group: "通用素材",
			label: kindLabel(entry.kind) + " · " + entry.title,
			hint: entry.usage || "",
			run: () => openMaterialDialog({ scope: "library", mode: "edit", entry }),
		});
	}
	return items;
}

function renderPalette() {
	const query = $("palette-input").value.trim();
	const box = $("palette-results");
	box.replaceChildren();
	const all = buildPaletteItems();
	const matched = query
		? all.filter((item) => matchesQuery(query, item.label, item.hint, item.group))
		: all.filter((item) => item.group === "动作");
	// 每类最多摆 6 条，动作已经在前面，不要把结果堆成一张表。
	const groups = new Map();
	for (const item of matched) {
		const list = groups.get(item.group) ?? [];
		if (list.length < 6) list.push(item);
		groups.set(item.group, list);
	}
	paletteItems = [...groups.values()].flat();
	paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
	if (paletteItems.length === 0) {
		box.append(el("div", "palette-empty", query ? "没有匹配「" + query + "」的章目、素材或动作" : "输入关键词开始检索"));
		return;
	}
	paletteItems.forEach((item, index) => {
		const row = el("div", "palette-row" + (index === paletteIndex ? " is-on" : ""));
		row.setAttribute("role", "option");
		row.setAttribute("aria-selected", String(index === paletteIndex));
		row.append(el("span", "palette-group", item.group));
		const main = el("div", "palette-main");
		main.append(el("div", "palette-label", item.label));
		if (item.hint) main.append(el("div", "palette-hint", item.hint));
		row.append(main);
		row.addEventListener("click", () => runPaletteItem(index));
		row.addEventListener("mousemove", () => {
			if (paletteIndex === index) return;
			paletteIndex = index;
			for (const [i, node] of [...box.querySelectorAll(".palette-row")].entries()) {
				node.classList.toggle("is-on", i === index);
				node.setAttribute("aria-selected", String(i === index));
			}
		});
		box.append(row);
	});
	box.querySelector(".palette-row.is-on")?.scrollIntoView({ block: "nearest" });
}

function runPaletteItem(index) {
	const item = paletteItems[index];
	if (!item) return;
	closeDialog($("palette-dialog"));
	// 关掉弹窗再执行：有些动作会自己开另一个 dialog。
	setTimeout(() => item.run(), 0);
}

function openPalette() {
	const dialog = $("palette-dialog");
	if (dialog.open) return;
	// 别的弹窗正开着时不叠加，免得 Esc 只关掉其中一层。
	if (document.querySelector("dialog[open]")) return;
	$("palette-input").value = "";
	paletteIndex = 0;
	renderPalette();
	openDialog(dialog, { focus: "#palette-input" });
}

// ═══════════════════════════════════════════════════ 键盘

/** 上下切章。目录为空时什么都不做。 */
function jumpChapter(delta) {
	const project = state.project;
	if (!project || project.outline.length === 0) return;
	const current = project.outline.findIndex((chapter) => chapter.id === state.chapterId);
	const next = current < 0 ? 0 : Math.min(project.outline.length - 1, Math.max(0, current + delta));
	const chapter = project.outline[next];
	if (chapter) openChapter(chapter.id);
}

function isTypingTarget(target) {
	return Boolean(
		target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable),
	);
}

document.addEventListener("keydown", (event) => {
	const mod = event.ctrlKey || event.metaKey;
	const typing = isTypingTarget(event.target);
	if (mod && event.key.toLowerCase() === "k") {
		event.preventDefault();
		openPalette();
		return;
	}
	if (mod && event.key.toLowerCase() === "s") {
		event.preventDefault();
		if (state.editing) {
			void (async () => {
				if (await autoSaveNow()) toast("已存稿", "ok", 1800);
			})();
		}
		return;
	}
	if (mod && ["1", "2", "3"].includes(event.key) && !event.shiftKey) {
		if (typing) return;
		event.preventDefault();
		switchView(["manuscript", "materials", "writing"][Number(event.key) - 1]);
		return;
	}
	if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !typing) {
		if (!state.project || state.mode !== "workspace") return;
		event.preventDefault();
		jumpChapter(event.key === "ArrowUp" ? -1 : 1);
		return;
	}
	if (event.key === "?" && !typing && !document.querySelector("dialog[open]")) {
		event.preventDefault();
		openShortcutsDialog();
	}
	if (event.key === "Escape") {
		// 有弹层在，Esc 的活归 dialog 的 cancel 事件（见「层管理」）——
		// 那里同样走一遍层管理器，历史才收得干净，也不会一次关两层。
		if (document.querySelector("dialog[open]")) return;
		if (document.querySelector(".desk.is-rail-open")) {
			closeRailDrawer();
			return;
		}
		if (document.querySelector(".desk.is-bible-open")) {
			closeBibleDrawer();
			return;
		}
		if ($("beam-tools")?.classList.contains("is-open")) {
			closeToolsPanel();
			return;
		}
		if (state.focusMode) setFocusMode(false);
	}
});

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
		state.bibleQuery = "";
		syncInput("bible-search", "");
		syncBibleTabs();
		renderBible();
	});
}
for (const [pane, ids] of Object.entries(PANES)) {
	const form = $(ids.input).closest("form");
	// 「输入中」：有字才把「呈上」点亮（类名切换，样式在 style.css）。
	// 手机上一屏只剩这一条输入框，按钮亮没亮是「按下去有没有反应」的唯一信号。
	const syncComposer = () => {
		form.classList.toggle("is-typing", $(ids.input).value.trim().length > 0);
	};
	$(ids.input).addEventListener("input", syncComposer);
	syncComposer();
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const text = $(ids.input).value.trim();
		// 库面板不绑作品，不能拿 projectId 当门槛 —— 那会让它在案头上永远发不出去。
		const needsProject = pane !== "library";
		if (!text || state.streaming || (needsProject && !state.projectId)) return;
		$(ids.input).value = "";
		syncComposer();
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
			dismissWaiting();
			toast("已止笔。", "info", 1800);
			return;
		}
		// 要掐的是正在跑的那一轮，不是面板此刻挂着的那一轮：
		// 作者中途切了章，activeKey 已经指到别处去了。
		const holder = state.streamHolder;
		const key = holder && holder.pane === pane ? holder.key : activeKey(pane);
		const sessionId = state.sessions.get(key);
		if (sessionId) fetch("/api/sessions/" + sessionId + "/abort", { method: "POST" }).catch(() => {});
		dismissWaiting();
		toast("已止笔。", "info", 1800);
	});
}

// 另起一席：三个面板共用一套接线，靠 data-newchat 区分。
for (const btn of document.querySelectorAll("[data-newchat]")) {
	btn.addEventListener("click", () => void startNewChat(btn.dataset.newchat));
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

// 库作用域的原料：与作品那条同一套逻辑，只是不绑工程、走 /api/uploads。
$("library-upload-pick").addEventListener("click", () => $("library-upload-input").click());
$("library-upload-input").addEventListener("change", (event) => {
	void handleFiles([...event.target.files], "library");
	event.target.value = "";
});
// 拖放直接落在设定官面板上：资料是给它看的，落点就该是它。
const libraryPane = $("library-stream").closest(".bench-pane");
libraryPane.addEventListener("dragover", (event) => {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	libraryPane.classList.add("is-over");
});
libraryPane.addEventListener("dragleave", (event) => {
	if (libraryPane.contains(event.relatedTarget)) return;
	libraryPane.classList.remove("is-over");
});
libraryPane.addEventListener("drop", (event) => {
	if (!event.dataTransfer?.files?.length) return;
	event.preventDefault();
	libraryPane.classList.remove("is-over");
	void handleFiles([...event.dataTransfer.files], "library");
});

$("model-select").addEventListener("change", () => {
	// 换笔即换档位范围：先按新模型收窄，再把收窄后的值发给会话。
	renderThinkingLevels();
	// 手机上这块在浮层里，选完就收，别挡住稿子。
	closeToolsPanel();
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
	const level = $("thinking-select").value;
	state.models = data.models;
	renderModels(data.models, data.defaultModel);
	if (data.models.some((model) => model.id === previous)) $("model-select").value = previous;
	// 档位能力可能刚被改过（比如给模型勾上了思考），按新能力重列。
	renderThinkingLevels(level);
});

$("material-view-close").addEventListener("click", () => closeDialog($("material-view")));

/**
 * 设定官那一栏是拖放落区。
 *
 * dragover 必须 preventDefault —— 不阻止默认行为，浏览器不会派发 drop。
 * dragleave 要判 relatedTarget：指针从卡片移到栏内子元素时也会触发 leave，
 * 不判就会让高亮闪烁。
 */
const dropZone = $("material-drop");
dropZone.addEventListener("dragover", (event) => {
	if (!event.dataTransfer.types.includes("text/x-material")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	dropZone.classList.add("is-over");
	dropZone.querySelector(".drop-hint").classList.remove("hidden");
});
dropZone.addEventListener("dragleave", (event) => {
	if (dropZone.contains(event.relatedTarget)) return;
	dropZone.classList.remove("is-over");
	dropZone.querySelector(".drop-hint").classList.add("hidden");
});
dropZone.addEventListener("drop", (event) => {
	event.preventDefault();
	dropZone.classList.remove("is-over");
	dropZone.querySelector(".drop-hint").classList.add("hidden");
	const id = event.dataTransfer.getData("text/x-material");
	if (id) dropMaterial(id);
});


/**
 * 执笔者的输入框也是落区：拖过来的料先装入本章，再把标题写进交代。
 *
 * 与设定官那栏的区别在于落点：那边落在整栏上，只做「选中」；
 * 这边落在输入框上，所以要连带把料装进本章，否则执笔者看不见它。
 */
const composerZone = $("writing-composer");
const composerHint = composerZone.querySelector(".drop-hint");
composerZone.addEventListener("dragover", (event) => {
	if (!event.dataTransfer.types.includes("text/x-material")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	composerZone.classList.add("is-over");
	// 三种后果各说各的：没有章节时装不成，别让提示许一个做不到的承诺。
	const chapter = state.project?.outline.find((item) => item.id === state.chapterId);
	const already = chapter && draggingMaterialId ? chapter.materialIds.includes(draggingMaterialId) : false;
	composerHint.textContent = !chapter
		? "松手即写进交代；先立一章才装得进料"
		: already
			? "松手即写进交代"
			: "松手即装入本章，并写进交代";
	composerHint.classList.remove("hidden");
});
composerZone.addEventListener("dragleave", (event) => {
	if (composerZone.contains(event.relatedTarget)) return;
	composerZone.classList.remove("is-over");
	composerHint.classList.add("hidden");
});
composerZone.addEventListener("drop", (event) => {
	event.preventDefault();
	composerZone.classList.remove("is-over");
	composerHint.classList.add("hidden");
	const id = event.dataTransfer.getData("text/x-material");
	if (id) void dropMaterialToComposer(id);
});
// ── 检索框

function bindSearch(id, key, render) {
	const input = $(id);
	if (!input) return;
	input.addEventListener("input", (event) => {
		state[key] = event.target.value;
		render();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			event.target.value = "";
			state[key] = "";
			render();
		}
	});
}

bindSearch("chapter-filter", "chapterQuery", renderChapters);
bindSearch("material-search", "materialQuery", () => {
	if (state.view === "materials") renderMaterialsBench();
	else renderView();
});
bindSearch("library-search", "libraryQuery", () => {
	if (state.mode === "home") renderHomeBench();
});
bindSearch("bible-search", "bibleQuery", renderBible);

// ── 检索面板

$("open-palette").addEventListener("click", openPalette);
$("open-shortcuts").addEventListener("click", openShortcutsDialog);
$("palette-input").addEventListener("input", () => {
	paletteIndex = 0;
	renderPalette();
});
$("palette-input").addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown") {
		event.preventDefault();
		if (paletteItems.length) {
			paletteIndex = (paletteIndex + 1) % paletteItems.length;
			renderPalette();
		}
	} else if (event.key === "ArrowUp") {
		event.preventDefault();
		if (paletteItems.length) {
			paletteIndex = (paletteIndex - 1 + paletteItems.length) % paletteItems.length;
			renderPalette();
		}
	} else if (event.key === "Enter") {
		event.preventDefault();
		runPaletteItem(paletteIndex);
	}
});
$("palette-dialog").addEventListener("click", (event) => {
	if (event.target === $("palette-dialog")) closeDialog($("palette-dialog"));
});

// ── 版本、导出、排版、快捷键

$("history-close").addEventListener("click", () => closeDialog($("history-dialog")));
// 快照面板的「合上」一直没人接：Esc 与返回键能关，但这个看得见的按钮点了没反应。
$("snapshot-close")?.addEventListener("click", () => closeDialog($("snapshot-dialog")));
$("export-cancel").addEventListener("click", () => closeDialog($("export-dialog")));
$("export-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const scope = form.querySelector('input[name="scope"]:checked')?.value ?? "book";
	const format = form.querySelector('input[name="format"]:checked')?.value ?? "txt";
	const chapterId = scope === "chapter" ? state.exportChapterId : null;
	const submit = form.querySelector("button[type=submit]");
	$("export-error").textContent = "";
	submit.disabled = true;
	try {
		if (await exportProject(chapterId, format)) closeDialog($("export-dialog"));
	} finally {
		submit.disabled = false;
	}
});
$("type-size").addEventListener("change", (event) => setTypography({ size: Number(event.target.value) }));
$("type-line").addEventListener("change", (event) => setTypography({ line: Number(event.target.value) }));
$("type-measure").addEventListener("change", (event) => setTypography({ measure: Number(event.target.value) }));
$("type-focus").addEventListener("change", (event) => setFocusMode(event.target.checked));
$("type-reset").addEventListener("click", () => {
	state.typography = { ...TYPE_DEFAULTS };
	applyTypography();
	writeStored(TYPE_KEY, JSON.stringify(state.typography));
	syncTypeDialog();
});
$("type-close").addEventListener("click", () => closeDialog($("type-dialog")));
$("shortcuts-close").addEventListener("click", () => closeDialog($("shortcuts-dialog")));

// ── 窄屏右案抽屉

$("toggle-bible").addEventListener("click", () => {
	if (document.querySelector(".desk").classList.contains("is-bible-open")) closeBibleDrawer();
	else {
		openBibleDrawer();
		renderBible();
	}
});
$("close-bible").addEventListener("click", () => closeBibleDrawer());
$("bible-backdrop").addEventListener("click", () => closeBibleDrawer());

// ── 窄屏：章目抽屉与顶栏浮层

$("toggle-rail")?.addEventListener("click", toggleRailDrawer);
$("close-rail")?.addEventListener("click", closeRailDrawer);
$("rail-backdrop")?.addEventListener("click", closeRailDrawer);
$("toggle-tools")?.addEventListener("click", () => toggleToolsPanel());
// 浮层里那个看得见的叉：点外面能收，但手机上一眼看不出「点哪儿算外面」。
$("close-tools")?.addEventListener("click", () => closeToolsPanel());

// 点浮层外面就收起 —— 手机上没有 hover，点别处就是「不看了」。
document.addEventListener("click", (event) => {
	const panel = $("beam-tools");
	if (!panel || !panel.classList.contains("is-open")) return;
	if (event.target instanceof Element && event.target.closest("#beam-tools, #toggle-tools")) return;
	closeToolsPanel();
});

// 一划就走：右案往右划，章目往左划。
bindSwipeOut($("desk-right"), (dx) => {
	if (dx > 0) closeBibleDrawer();
});
bindSwipeOut($("rail"), (dx) => {
	if (dx < 0) closeRailDrawer();
});

// 宽窄一变，手机上那套浮层就该收起来：桌面端没有抽屉，敞着会留一层遮罩。
if (phoneQuery) {
	const onWidthChange = () => {
		if (!isPhoneLayout()) {
			closeRailDrawer();
			closeToolsPanel();
		}
		// 手机上正文不小于 16px，宽窄变了要重算一次。
		applyTypography();
		syncViewportHooks();
	};
	if (typeof phoneQuery.addEventListener === "function") phoneQuery.addEventListener("change", onWidthChange);
	else phoneQuery.addListener(onWidthChange);
}

// ── 触屏与矮窗的钩子
// 横竖屏、矮窗、是不是手指点：样式读 <html> 上的类与 data-*，JS 这边只管报数。
syncViewportHooks();
window.addEventListener("resize", syncViewportHooks, { passive: true });
// 转屏之后 innerWidth/innerHeight 要等动画落地才准，晚一步再报一次。
window.addEventListener("orientationchange", () => setTimeout(syncViewportHooks, 260));
if (typeof coarseQuery?.addEventListener === "function") coarseQuery.addEventListener("change", syncViewportHooks);

// 别处（设置、供应商表单）自己 showModal 开的弹层，点完补登记一次：
// 没有这一条，安卓返回键会把它当成「退出应用」。
// 用冒泡阶段：要等按钮自己的处理器把弹层打开之后才轮到这里。
document.addEventListener("click", () => adoptOpenDialogs());

// ── 文件拖放兜底
// 文件落到聊天栏或页面空白处，浏览器会直接打开它，未存的稿子一起没。
// 只允许上传区与案头的设定官栏接文件，其余地方一律拦下并说明该往哪拖。

window.addEventListener("dragover", (event) => {
	if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});
window.addEventListener("drop", (event) => {
	if (!event.dataTransfer?.files?.length) return;
	event.preventDefault();
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest("#upload-zone, #library-pane")) return;
	toast("文件请拖到「料」页的上传区，或案头右侧的「设定官」栏。", "info", 4600);
});

// ── 兜底与离开保护

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const message = reason instanceof Error ? reason.message : String(reason ?? "");
	if (!message) return;
	console.error(reason);
	toast("出了点问题：" + message, "error", 6000);
});

window.addEventListener("beforeunload", (event) => {
	if (state.editing && state.editorDirty) {
		event.preventDefault();
		event.returnValue = "这一稿还没存到磁盘。";
	}
});

bindSettings();
loadTypography();
// 提手要先于 bootstrap：起手失败时工作台也该能拖，不该等接口回来才装配。
initBenchSplits();
const beamKbd = document.querySelector(".beam-kbd");
if (beamKbd) beamKbd.textContent = PALETTE_MOD + " K";
bootstrap()
	.catch((error) => {
		toast("起手不成：" + error.message, "error", 8000);
		state.mode = "home";
		applyMode();
		const box = $("view-home");
		box.classList.add("is-on");
		const wrap = el("div", "void");
		wrap.append(el("h3", "", "起手不成"));
		wrap.append(el("p", "", error.message));
		wrap.append(
			button("重试", "btn btn-ink btn-sm", () => window.location.reload()),
		);
		box.replaceChildren(wrap);
	})
	// 起手成不成都要把骨架摘掉：它盖着的是整个应用。
	.finally(dismissBootSkeleton);

// 接口既没回也没错（服务端卡住）时，别让骨架一直盖着 —— 空壳至少还能点开设置看一眼。
setTimeout(dismissBootSkeleton, 12000);
