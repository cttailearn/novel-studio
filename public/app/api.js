/**
 * 与后端说话的唯一个出口。
 *
 * 所有请求都走同源 /api：单机跑在 node 上，浏览器包里由 boot.js 把 /api 转到
 * local-api.js（IndexedDB），云端模式由 auth-gate.js 改写 fetch 带上令牌。
 * 所以这里不需要知道自己在哪种模式下，只管拼路径。
 */

export class ApiError extends Error {
	constructor(message, status, payload) {
		super(message || "请求失败");
		this.name = "ApiError";
		this.status = status || 0;
		this.payload = payload || null;
	}
}

function errorMessage(payload, status) {
	if (payload && typeof payload === "object") {
		if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
		if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
	}
	if (status === 401) return "还没有登录。";
	if (status === 403) return "没有权限。";
	if (status === 404) return "没有找到。";
	if (status === 413) return "文件或内容太大了。";
	if (status === 503) return "服务暂时不可用。";
	return `请求失败（${status || "网络"}）`;
}

function withQuery(path, query) {
	if (!query) return path;
	const url = new URL(path, location.origin);
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url.pathname + url.search;
}

async function readPayload(response) {
	const type = response.headers.get("content-type") || "";
	if (type.includes("application/json")) {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}
	const text = await response.text().catch(() => "");
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return { error: text.slice(0, 400) };
	}
}

async function request(method, path, { body, json, query, signal } = {}) {
	let payload = body;
	const headers = { accept: "application/json" };
	if (json !== undefined) {
		payload = JSON.stringify(json);
		headers["content-type"] = "application/json";
	}
	let response;
	try {
		response = await fetch(withQuery(path, query), {
			method,
			headers,
			body: payload,
			signal,
			credentials: "same-origin",
		});
	} catch (error) {
		if (error?.name === "AbortError") throw error;
		throw new ApiError("服务没接上。它可能正在重启——稍等两秒再试，稿子都还在。", 0, null);
	}
	if (!response.ok) {
		const data = await readPayload(response);
		throw new ApiError(errorMessage(data, response.status), response.status, data);
	}
	if (response.status === 204) return null;
	return readPayload(response);
}

export const http = {
	get: (path, options) => request("GET", path, { ...options, method: "GET" }),
	post: (path, json, options) => request("POST", path, { ...options, json }),
	patch: (path, json, options) => request("PATCH", path, { ...options, json }),
	put: (path, json, options) => request("PUT", path, { ...options, json }),
	del: (path, options) => request("DELETE", path, { ...options, method: "DELETE" }),
};

/**
 * 逐行读 NDJSON。
 *
 * 后端一条事件一行，最后一定会有 run_end / done / error 收尾。
 * 中途连不上不算失败——轮次还在服务端跑，可以用 /api/runs/:id/stream?since= 接回。
 */
async function streamNdjson(path, { method = "POST", json, query, signal, onEvent } = {}) {
	let response;
	try {
		response = await fetch(withQuery(path, query), {
			method,
			headers: {
				accept: "application/x-ndjson",
				...(json !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: json !== undefined ? JSON.stringify(json) : undefined,
			signal,
			credentials: "same-origin",
		});
	} catch (error) {
		if (error?.name === "AbortError") throw error;
		throw new ApiError("服务没接上。这一轮可能还在服务端跑——回到这一章看看，或稍后用记录接回来。", 0, null);
	}
	if (!response.ok) {
		const data = await readPayload(response);
		throw new ApiError(errorMessage(data, response.status), response.status, data);
	}
	const meta = {
		runId: response.headers.get("x-run") || "",
		replay: response.headers.get("x-write-replay") === "1",
	};
	if (!response.body) {
		throw new ApiError("这条流没有可读的内容。", response.status, null);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const events = [];
	const dispatch = (line) => {
		const text = line.trim();
		if (!text) return;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		events.push(event);
		if (typeof event.type === "string" && event.type === "run" && event.id && !meta.runId) {
			meta.runId = event.id;
		}
		if (onEvent) onEvent(event);
	};
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				dispatch(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		}
		if (buffer.trim()) dispatch(buffer);
	} finally {
		reader.releaseLock?.();
	}
	return { ...meta, events };
}

/* ---------------------------------------------------------------- bootstrap */

export const bootstrap = () => http.get("/api/bootstrap");
export const models = () => http.get("/api/models");

/* ---------------------------------------------------------------- projects */

export const listProjects = () => http.get("/api/projects");
export const createProject = (json) => http.post("/api/projects", json);
export const getProject = (pid) => http.get(`/api/projects/${encodeURIComponent(pid)}`);
export const patchProject = (pid, json) => http.patch(`/api/projects/${encodeURIComponent(pid)}`, json);
export const deleteProject = (pid) => http.del(`/api/projects/${encodeURIComponent(pid)}`);
export const listTrash = () => http.get("/api/projects/trash");
export const restoreProject = (pid) => http.post(`/api/projects/trash/${encodeURIComponent(pid)}/restore`);

export const addChapter = (pid, json) => http.post(`/api/projects/${encodeURIComponent(pid)}/chapters`, json);
export const saveChapter = (pid, cid, json) =>
	http.patch(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}`, json);
export const getDraft = (pid, cid, { history = false } = {}) =>
	http.get(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/draft`, {
		query: { history: history ? 1 : undefined },
	});

export const addVolume = (pid, json) => http.post(`/api/projects/${encodeURIComponent(pid)}/volumes`, json);
export const patchVolume = (pid, vid, json) =>
	http.patch(`/api/projects/${encodeURIComponent(pid)}/volumes/${encodeURIComponent(vid)}`, json);
export const deleteVolume = (pid, vid) =>
	http.del(`/api/projects/${encodeURIComponent(pid)}/volumes/${encodeURIComponent(vid)}`);

export const patchOutline = (pid, cid, json) =>
	http.patch(`/api/projects/${encodeURIComponent(pid)}/outline/${encodeURIComponent(cid)}`, json);
export const deleteOutline = (pid, cid) => http.del(`/api/projects/${encodeURIComponent(pid)}/outline/${encodeURIComponent(cid)}`);

export const patchNote = (pid, nid, json) =>
	http.patch(`/api/projects/${encodeURIComponent(pid)}/notes/${encodeURIComponent(nid)}`, json);
export const deleteNote = (pid, nid) => http.del(`/api/projects/${encodeURIComponent(pid)}/notes/${encodeURIComponent(nid)}`);

export function exportUrl(pid, chapterId, format = "md") {
	const query = new URLSearchParams({ format });
	if (chapterId) query.set("chapter", chapterId);
	return `/api/projects/${encodeURIComponent(pid)}/export?${query.toString()}`;
}

/* ---------------------------------------------------------------- materials */

export const listMaterials = (pid, kind) =>
	http.get(`/api/projects/${encodeURIComponent(pid)}/materials`, { query: { kind: kind || undefined } });
export const createMaterial = (pid, json) => http.post(`/api/projects/${encodeURIComponent(pid)}/materials`, json);
export const patchMaterial = (pid, mid, json) =>
	http.patch(`/api/projects/${encodeURIComponent(pid)}/materials/${encodeURIComponent(mid)}`, json);
export const deleteMaterial = (pid, mid) =>
	http.del(`/api/projects/${encodeURIComponent(pid)}/materials/${encodeURIComponent(mid)}`);
export const assembleMaterials = (pid, cid, json) =>
	http.post(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/materials`, json);
export const saveMaterialToLibrary = (pid, mid, json) =>
	http.post(`/api/projects/${encodeURIComponent(pid)}/materials/${encodeURIComponent(mid)}/library`, json);

/* ---------------------------------------------------------------- library */

export const listLibrary = () => http.get("/api/library");
export const createLibraryMaterial = (json) => http.post("/api/library", json);
export const patchLibraryMaterial = (id, json) => http.patch(`/api/library/${encodeURIComponent(id)}`, json);
export const deleteLibraryMaterial = (id) => http.del(`/api/library/${encodeURIComponent(id)}`);

export const listKinds = () => http.get("/api/kinds");
export const createKind = (label) => http.post("/api/kinds", { label });
export const patchKind = (kind, label) => http.patch(`/api/kinds/${encodeURIComponent(kind)}`, { label });
export const deleteKind = (kind) => http.del(`/api/kinds/${encodeURIComponent(kind)}`);

/* ---------------------------------------------------------------- sources */

export const listSources = () => http.get("/api/material-sources");
export const deleteSource = (id) => http.del(`/api/material-sources/${encodeURIComponent(id)}`);
export const readSourceChapter = (id, cid) =>
	http.get(`/api/material-sources/${encodeURIComponent(id)}/chapters/${encodeURIComponent(cid)}`);

/* ---------------------------------------------------------------- uploads */

/** 文件按原始字节直传，元信息全在查询串里。 */
export async function uploadFile(file, { projectId = "", kind = "", title = "", splitMode = "", fixedChars = "" } = {}) {
	const path = projectId
		? `/api/projects/${encodeURIComponent(projectId)}/uploads`
		: "/api/uploads";
	const query = new URLSearchParams({ filename: file.name || "未命名.txt" });
	if (kind) query.set("kind", kind);
	if (title) query.set("title", title);
	if (splitMode) query.set("splitMode", splitMode);
	if (fixedChars) query.set("fixedChars", String(fixedChars));
	const response = await fetch(`${path}?${query.toString()}`, {
		method: "POST",
		headers: { "content-type": file.type || "application/octet-stream" },
		body: file,
		credentials: "same-origin",
	});
	const data = await readPayload(response);
	if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status, data);
	return data;
}

/** 原料入库（原书/资料），查询串同样带全部元信息。 */
export async function ingestSource(file, { kind = "novel", title = "", splitMode = "", fixedChars = "" } = {}) {
	const query = new URLSearchParams({ filename: file.name || "未命名.txt", kind });
	if (title) query.set("title", title);
	if (splitMode) query.set("splitMode", splitMode);
	if (fixedChars) query.set("fixedChars", String(fixedChars));
	const response = await fetch(`/api/material-sources?${query.toString()}`, {
		method: "POST",
		headers: { "content-type": file.type || "application/octet-stream" },
		body: file,
		credentials: "same-origin",
	});
	const data = await readPayload(response);
	if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status, data);
	return data;
}

/* ---------------------------------------------------------------- sessions */

export const createSession = (json) => http.post("/api/sessions", json);
export const sendMessage = (sid, input, { signal, onEvent } = {}) =>
	streamNdjson(`/api/sessions/${encodeURIComponent(sid)}/messages`, { json: { input }, signal, onEvent });
export const setSessionModel = (sid, json) => http.post(`/api/sessions/${encodeURIComponent(sid)}/model`, json);
export const abortSession = (sid) => http.post(`/api/sessions/${encodeURIComponent(sid)}/abort`);
export const deleteSession = (sid) => http.del(`/api/sessions/${encodeURIComponent(sid)}`);
export const answerQuestion = (qid, answer) =>
	http.post(`/api/questions/${encodeURIComponent(qid)}/answer`, { answer });

/* ---------------------------------------------------------------- writing */

export const writeChapter = (pid, cid, json, { signal, onEvent } = {}) =>
	streamNdjson(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/write`, {
		json,
		signal,
		onEvent,
	});

/* ---------------------------------------------------------------- adaptation */

export const getAdaptation = (pid) => http.get(`/api/projects/${encodeURIComponent(pid)}/adaptation`);
export const patchAdaptation = (pid, json) => http.patch(`/api/projects/${encodeURIComponent(pid)}/adaptation`, json);
export const adaptChapter = (pid, cid, json, { signal, onEvent } = {}) =>
	streamNdjson(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/adapt`, {
		json,
		signal,
		onEvent,
	});
export const getProposal = (pid, cid) =>
	http.get(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/adapt`);
/** 改编的进度是把章的游标：一章一章往下走，改到底之后才允许回头。 */
export const moveAdaptCursor = (pid, chapterId) =>
	http.post(
		`/api/projects/${encodeURIComponent(pid)}/adaptation/cursor`,
		chapterId ? { chapterId } : {},
	);
export const applyProposal = (pid, cid, json) =>
	http.post(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/adapt/apply`, json || {});

/* ---------------------------------------------------------------- polish */

export const polishChapter = (pid, cid, json, { signal, onEvent } = {}) =>
	streamNdjson(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/polish`, {
		json,
		signal,
		onEvent,
	});
export const applyPolish = (pid, cid, json) =>
	http.post(`/api/projects/${encodeURIComponent(pid)}/chapters/${encodeURIComponent(cid)}/polish/apply`, json);

/* ---------------------------------------------------------------- records & runs */

export const listRecords = (query) => http.get("/api/records", { query });
export const getRecord = (id) => http.get(`/api/records/${encodeURIComponent(id)}`);
export const deleteRecord = (id) => http.del(`/api/records/${encodeURIComponent(id)}`);

export const listRuns = (query) => http.get("/api/runs", { query });
export const abortRun = (id) => http.post(`/api/runs/${encodeURIComponent(id)}/abort`);
export const streamRun = (id, since, { onEvent, signal } = {}) =>
	streamNdjson(`/api/runs/${encodeURIComponent(id)}/stream`, { method: "GET", query: { since: since || 0 }, onEvent, signal });

/* ---------------------------------------------------------------- settings */

export const getSettings = () => http.get("/api/settings");
export const putSettings = (json) => http.put("/api/settings", json);
export const testWebSearch = () => http.post("/api/settings/web-search/test");

export const createProvider = (json) => http.post("/api/providers", json);
export const patchProvider = (id, json) => http.patch(`/api/providers/${encodeURIComponent(id)}`, json);
export const deleteProvider = (id) => http.del(`/api/providers/${encodeURIComponent(id)}`);
export const clearProviderKey = (id) => http.del(`/api/providers/${encodeURIComponent(id)}/key`);
export const fetchProviderModels = (id) => http.post(`/api/providers/${encodeURIComponent(id)}/models/fetch`, {});

/* ---------------------------------------------------------------- storage */

export const getStorage = () => http.get("/api/storage");
export const retryStorage = () => http.post("/api/storage/retry");
export const listSnapshots = (pid) => http.get(`/api/projects/${encodeURIComponent(pid)}/snapshots`);
export const restoreSnapshot = (pid, id) =>
	http.post(`/api/projects/${encodeURIComponent(pid)}/snapshots/${encodeURIComponent(id)}`);

export function novelExportUrl({ projectId = "", passphrase = "", credentials = false, compress = true } = {}) {
	const query = new URLSearchParams();
	if (projectId) query.set("project", projectId);
	if (passphrase) query.set("passphrase", passphrase);
	if (credentials) query.set("credentials", "1");
	if (!compress) query.set("compress", "0");
	const qs = query.toString();
	return `/api/novel/export${qs ? `?${qs}` : ""}`;
}

export async function importNovel(file, { passphrase = "", onConflict = "skip" } = {}) {
	const query = new URLSearchParams({ onConflict });
	if (passphrase) query.set("passphrase", passphrase);
	const response = await fetch(`/api/novel/import?${query.toString()}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: file,
		credentials: "same-origin",
	});
	const data = await readPayload(response);
	if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status, data);
	return data;
}
