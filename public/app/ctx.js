/**
 * 会话状态：谁被打开着、正文有没有改动、接下来该谁来重画。
 *
 * 一个极小的发布订阅就够了 —— 各视图自己负责局部更新（比如正文输入框里的
 * 字不会因为切了一下页签就被重建），只有结构变了才喊一嗓子。
 */

import * as api from "./api.js";
import { countWords, sleep, toast } from "./core.js";

const LAST_PROJECT_KEY = "mogeng.last-project";
const PREFS_KEY = "mogeng.prefs";

export const state = {
	ready: false,
	boot: null,
	projects: [],
	view: "desk",
	project: null,
	chapters: [],
	stats: null,
	activeId: "",
	draft: null,
	tab: "paper",
	railFilter: "all",
	railQuery: "",
	materials: [],
	volumes: [],
	outline: [],
	kinds: [],
	library: [],
	sources: [],
	session: null,
	run: null,
	focus: false,
	saving: "idle",
	lastSavedAt: 0,
	models: [],
	defaultModel: "",
	defaultThinkingLevel: "",
	prefs: {
		dockOpen: true,
		fontScale: 1,
		adapted: false,
	},
	auth: null,
};

const listeners = new Set();

export function onChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function notify(scope) {
	for (const fn of listeners) {
		try {
			fn(scope);
		} catch (error) {
			console.error("[ui]", error);
		}
	}
}

/* ---------- 偏好与记忆 ---------- */

export function loadPrefs() {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (raw) {
			const data = JSON.parse(raw);
			if (data && typeof data === "object") Object.assign(state.prefs, data);
		}
	} catch {
		/* 坏掉的偏好不值得报错 */
	}
	if (typeof state.prefs.fontScale !== "number" || !Number.isFinite(state.prefs.fontScale)) state.prefs.fontScale = 1;
	return state.prefs;
}

export function savePrefs(patch) {
	if (patch) Object.assign(state.prefs, patch);
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
	} catch {
		/* 隐私模式下写不进去也无所谓 */
	}
	notify("prefs");
}

export function lastProjectId() {
	try {
		return localStorage.getItem(LAST_PROJECT_KEY) || "";
	} catch {
		return "";
	}
}

function rememberProject(id) {
	try {
		if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
		else localStorage.removeItem(LAST_PROJECT_KEY);
	} catch {
		/* 同上 */
	}
}

/* ---------- 启动 ---------- */

export async function bootstrapApp() {
	const data = await api.bootstrap();
	state.boot = data;
	state.projects = data.projects || [];
	state.models = data.models || [];
	state.defaultModel = data.defaultModel || "";
	state.defaultThinkingLevel = data.defaultThinkingLevel || "off";
	state.kinds = data.kinds || [];
	state.ready = true;
	notify("boot");
	notify("projects");
	return data;
}

export async function refreshProjects() {
	const data = await api.listProjects();
	state.projects = data.projects || [];
	notify("projects");
	return state.projects;
}

export function projectById(id) {
	return state.projects.find((item) => item.id === id) || null;
}

/* ---------- 进出一部作品 ---------- */

export async function openProject(id, { silent = false } = {}) {
	if (!id) return;
	let data;
	try {
		data = await api.getProject(id);
	} catch (error) {
		if (error?.status === 404) {
			toast("这部作品不在了。", "error");
			rememberProject("");
			await refreshProjects().catch(() => {});
			return;
		}
		throw error;
	}
	state.project = data.project;
	state.chapters = data.chapters || [];
	state.stats = data.stats || null;
	state.outline = data.project?.outline || [];
	state.volumes = data.project?.volumes || [];
	state.materials = data.project?.materials || [];
	state.draft = null;
	state.saving = "idle";
	state.prefs.adapted = Boolean(data.project?.adaptation);
	rememberProject(id);

	// 回到这部作品上次写到的地方；没有就挑第一个能接着写的。
	const target = pickResumeChapter() || state.chapters[0]?.id || state.outline[0]?.id || "";
	state.activeId = target;
	setView(state.prefs.adapted ? "adapt" : "studio", { silent: true });
	notify("project");
	notify("chapters");
	notify("materials");
	notify("outline");
	if (target) await loadDraft(target, { silent: true });
	notify("draft");
	if (!silent) notify("view");
	return state.project;
}

/** 想接着写的章：有正文但状态还没到「已完稿」的第一章；否则第一个没动笔的章。 */
export function pickResumeChapter() {
	const metaById = new Map(state.chapters.map((item) => [item.id, item]));
	const half = state.outline.find((item) => {
		const meta = metaById.get(item.id);
		return meta && meta.words > 0 && item.status !== "done" && item.status !== "drafted";
	});
	if (half) return half.id;
	const fresh = state.outline.find((item) => !metaById.get(item.id)?.hasDraft);
	if (fresh) return fresh.id;
	return "";
}

export function leaveProject() {
	state.project = null;
	state.chapters = [];
	state.outline = [];
	state.volumes = [];
	state.materials = [];
	state.draft = null;
	state.stats = null;
	state.activeId = "";
	state.session = null;
	state.run = null;
	rememberProject("");
	setView("desk", { silent: true });
	notify("project");
	notify("draft");
	notify("view");
}

export function setView(view, { silent = false } = {}) {
	if (view === "studio" && !state.project) return;
	if (state.view === view) return;
	state.view = view;
	document.getElementById("app").dataset.view = view;
	notify("view");
	if (!silent) notify("view:flash");
}

/* ---------- 章节与正文 ---------- */

export function chapterMeta(id) {
	return state.chapters.find((item) => item.id === id) || null;
}

export function outlineItem(id) {
	return state.outline.find((item) => item.id === id) || state.project?.outline?.find((item) => item.id === id) || null;
}

export function chapterIndex(id) {
	return state.outline.findIndex((item) => item.id === id);
}

export function chapterLabel(id) {
	const index = chapterIndex(id);
	return index >= 0 ? `第 ${index + 1} 章` : "";
}

export async function loadDraft(id, { silent = false } = {}) {
	if (!state.project || !id) return;
	let data = null;
	try {
		data = await api.getDraft(state.project.id, id);
	} catch (error) {
		if (error?.status !== 404) throw error;
	}
	const item = outlineItem(id);
	const meta = chapterMeta(id);
	const content = data?.chapter?.content ?? "";
	state.draft = {
		id,
		title: data?.chapter?.title || meta?.title || item?.title || "",
		content,
		summary: data?.chapter?.summary || item?.summary || "",
		revision: data?.chapter?.revision ?? 0,
		updatedAt: data?.chapter?.updatedAt ?? 0,
		materialIds: data?.chapter?.materialIds || item?.materialIds || [],
		words: countWords(content),
		exists: Boolean(data),
	};
	state.saving = "idle";
	if (!silent) notify("draft");
	return state.draft;
}

export async function openChapter(id) {
	if (!state.project || !id) return;
	if (id === state.activeId && state.draft?.id === id) {
		notify("active");
		return;
	}
	await flushSave();
	state.activeId = id;
	state.tab = "paper";
	notify("active");
	notify("chapters");
	await loadDraft(id);
	notify("draft");
	notify("tab");
}

/* ---------- 存稿 ---------- */

let saveTimer = 0;
let savingPromise = null;

export function markDirty(content) {
	if (!state.draft) return;
	if (state.draft.content === content) return;
	state.draft.content = content;
	state.draft.words = countWords(content);
	state.saving = "dirty";
	notify("save");
	notify("words");
	clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		void saveDraft({ autosave: true });
	}, 1100);
}

export async function saveDraft({ autosave = false, force = false } = {}) {
	if (!state.project || !state.draft) return null;
	clearTimeout(saveTimer);
	const draft = state.draft;
	const snapshot = { id: draft.id, content: draft.content, title: draft.title };
	if (!force && state.saving === "saved" && !autosave) return draft;
	if (savingPromise) {
		await savingPromise.catch(() => {});
		if (state.draft !== draft) return null;
	}
	state.saving = "saving";
	notify("save");
	savingPromise = (async () => {
		const data = await api.saveChapter(state.project.id, snapshot.id, {
			content: snapshot.content,
			title: snapshot.title,
			autosave: autosave || undefined,
		});
		const meta = data?.chapter;
		if (meta) {
			const index = state.chapters.findIndex((item) => item.id === snapshot.id);
			if (index >= 0) state.chapters[index] = { ...state.chapters[index], ...meta };
			else state.chapters.push(meta);
			if (state.draft?.id === snapshot.id) {
				state.draft.revision = meta.revision ?? state.draft.revision;
				state.draft.updatedAt = meta.updatedAt ?? Date.now();
				state.draft.exists = true;
			}
		}
		if (data?.stats) state.stats = data.stats;
		if (state.draft?.content === snapshot.content) state.saving = "saved";
		state.lastSavedAt = Date.now();
		notify("save");
		notify("words");
		notify("chapters");
		return data;
	})();
	try {
		return await savingPromise;
	} catch (error) {
		state.saving = "error";
		notify("save");
		toast(error.message || "这一稿没存上。", "error");
		throw error;
	} finally {
		savingPromise = null;
	}
}

/** 切章、切视图、关页之前把没落盘的正文推上去。 */
export async function flushSave() {
	if (state.saving === "dirty" || state.saving === "saving") {
		try {
			await saveDraft({ autosave: true });
		} catch {
			/* 已经在界面上报过了 */
		}
	}
}

/* ---------- 局部刷新 ---------- */

export async function reloadProjectStructure() {
	if (!state.project) return;
	// 服务重启往往一两秒就回来：静默不等于放弃。多敲几次门，端口一回来就把账本补上，
	// 否则作者得自己刷新页面才知道刚才那一轮写没写成。
	const delays = [0, 600, 1500, 3000];
	let data = null;
	for (const wait of delays) {
		if (wait) await sleep(wait);
		try {
			data = await api.getProject(state.project.id);
			break;
		} catch (error) {
			if (!(error instanceof api.ApiError) || error.status !== 0) throw error;
		}
	}
	if (!data) return;
	state.project = data.project;
	state.chapters = data.chapters || [];
	state.stats = data.stats || null;
	state.outline = data.project?.outline || [];
	state.volumes = data.project?.volumes || [];
	state.materials = data.project?.materials || [];
	notify("project");
	notify("chapters");
	notify("outline");
	notify("materials");
	notify("stats");
}

export function patchChapterMeta(id, patch) {
	const index = state.chapters.findIndex((item) => item.id === id);
	if (index < 0) {
		state.chapters.push({ id, words: 0, revision: 0, hasDraft: false, ...patch });
	} else {
		state.chapters[index] = { ...state.chapters[index], ...patch };
	}
	notify("chapters");
}

export function setStats(stats) {
	if (!stats) return;
	state.stats = stats;
	notify("stats");
}

/* ---------- 运行中的任务 ---------- */

export function beginRun({ kind, label, id = "", abort = null }) {
	state.run = { kind, label, id, abort, startedAt: Date.now() };
	notify("run");
}

export function endRun() {
	state.run = null;
	notify("run");
}

export function canRun() {
	return !state.run;
}

/* ---------- 通用小工具 ---------- */

export function statusLabel(status) {
	switch (status) {
		case "planned":
			return "待列纲";
		case "outlined":
			return "已列纲";
		case "drafting":
			return "初稿中";
		case "drafted":
			return "已成稿";
		case "revising":
			return "修订中";
		case "done":
			return "定稿";
		default:
			return "待列纲";
	}
}

export const STATUS_OPTIONS = [
	{ value: "planned", label: "待列纲" },
	{ value: "outlined", label: "已列纲" },
	{ value: "drafting", label: "初稿中" },
	{ value: "drafted", label: "已成稿" },
	{ value: "revising", label: "修订中" },
	{ value: "done", label: "定稿" },
];

export function kindLabel(kind) {
	const found = state.kinds.find((item) => item.kind === kind);
	if (found) return found.label;
	return kind || "其他";
}

export function activeChapter() {
	return outlineItem(state.activeId);
}

export function aimModel() {
	return state.defaultModel || state.models[0]?.id || "";
}
