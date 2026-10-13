// Novel Studio 前端。不使用框架，直接消费后端 NDJSON 事件流。

import { bindSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

const state = { projects: [], projectId: null, sessionId: null, streaming: false };

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
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

// ---------------------------------------------------------------- bootstrap

async function bootstrap() {
	const data = await api("/api/bootstrap");
	state.projects = data.projects;
	renderProviders(data.providers);
	renderModels(data.models, data.defaultModel);
	$("thinking-select").value = data.defaultThinkingLevel || "off";

	if (data.models.length === 0) {
		const box = $("messages");
		box.replaceChildren(el("div", "empty"));
		const inner = box.firstElementChild;
		inner.append(el("h3", "", "还没有可用模型"));
		inner.append(el("p", "", "请复制 .env.example 为 .env，配置至少一个厂商的 API Key，然后重启服务。"));
	}

	renderProjects();
	if (state.projects.length > 0) await selectProject(state.projects[0].id);
}

function renderProviders(providers) {
	const list = $("provider-list");
	list.replaceChildren();
	for (const provider of providers) {
		const item = el("li", "provider-item");
		item.append(el("span", "dot" + (provider.configured ? " on" : "")));
		item.append(el("span", "", provider.label));
		item.append(el("span", "count", provider.configured ? String(provider.modelCount) : "未配置"));
		item.title = provider.configured
			? "环境变量：" + provider.envVars.join(", ")
			: "需要配置 " + provider.envVars.join(" 或 ");
		list.append(item);
	}
}

function renderModels(models, defaultModel) {
	const select = $("model-select");
	select.replaceChildren();
	if (models.length === 0) {
		select.append(el("option", "", "无可用模型"));
		select.disabled = true;
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

// ---------------------------------------------------------------- projects

function renderProjects() {
	const list = $("project-list");
	list.replaceChildren();
	for (const project of state.projects) {
		const item = el("li", "project-item" + (project.id === state.projectId ? " active" : ""));
		item.append(el("div", "name", project.title));
		item.append(
			el(
				"div",
				"meta",
				project.stats.chapters + " 章 · " +
					project.stats.words.toLocaleString() + " 字" +
					(project.stats.openNotes ? " · " + project.stats.openNotes + " 待办" : ""),
			),
		);
		item.addEventListener("click", () => selectProject(project.id));
		list.append(item);
	}
}

function statsText(stats) {
	return (
		stats.chapters + " 章 · " +
		stats.words.toLocaleString() + " 字 · " +
		stats.characters + " 人物 · " +
		stats.worldFacts + " 设定 · " +
		stats.openNotes + " 待办"
	);
}

async function selectProject(id) {
	state.projectId = id;
	state.sessionId = null;
	const data = await api("/api/projects/" + id);
	const project = data.project;

	$("project-title").textContent = project.title;
	$("project-stats").textContent = statsText(data.stats);
	$("messages").replaceChildren();
	appendMessage("user", "工作台已切换到《" + project.title + "》。直接说你想写什么就行。");
	renderProjects();
}

$("new-project").addEventListener("click", () => $("project-dialog").showModal());

$("project-form").addEventListener("submit", async (event) => {
	if (event.submitter && event.submitter.value !== "create") return;
	const body = Object.fromEntries(new FormData(event.target).entries());
	if (!body.targetWords) delete body.targetWords;
	try {
		const result = await api("/api/projects", { method: "POST", body });
		const project = result.project;
		state.projects = [project, ...state.projects];
		await selectProject(project.id);
		event.target.reset();
	} catch (error) {
		appendMessage("error", error.message);
	}
});

// ---------------------------------------------------------------- streaming

function appendMessage(role, text) {
	const wrap = el("div", "msg " + role);
	wrap.append(el("div", "msg-role", role === "user" ? "你" : role === "error" ? "错误" : "智能体"));
	const body = el("div", "msg-body", text);
	wrap.append(body);
	$("messages").append(wrap);
	scrollToBottom();
	return { wrap, body };
}

function appendTool(name, preview, failed) {
	const wrap = el("div", failed ? "tool failed" : "tool");
	wrap.append(el("span", "tool-icon", failed ? "✗" : "▸"));
	const main = el("div");
	main.append(el("div", "tool-name", name));
	if (preview) main.append(el("div", "tool-preview", preview));
	wrap.append(main);
	$("messages").append(wrap);
	scrollToBottom();
	return wrap;
}

function scrollToBottom() {
	const box = $("messages");
	box.scrollTop = box.scrollHeight;
}

function setStreaming(on) {
	state.streaming = on;
	$("send").disabled = on;
	$("abort").classList.toggle("hidden", !on);
	$("model-select").disabled = on;
	$("thinking-select").disabled = on;
}

async function ensureSession() {
	if (state.sessionId) return state.sessionId;
	const modelRef = $("model-select").value;
	if (!modelRef) throw new Error("请先在 .env 配置厂商 API Key");
	const data = await api("/api/sessions", {
		method: "POST",
		body: { projectId: state.projectId, modelRef, thinkingLevel: $("thinking-select").value },
	});
	state.sessionId = data.sessionId;
	return state.sessionId;
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const input = $("input");
	const text = input.value.trim();
	if (!text || state.streaming || !state.projectId) return;

	appendMessage("user", text);
	input.value = "";
	setStreaming(true);
	try {
		const sessionId = await ensureSession();
		await streamRun(sessionId, text);
	} catch (error) {
		appendMessage("error", error.message);
	} finally {
		setStreaming(false);
		refreshStats();
	}
});

$("abort").addEventListener("click", () => {
	if (state.sessionId) fetch("/api/sessions/" + state.sessionId + "/abort", { method: "POST" }).catch(() => {});
});

/** 通过 fetch 读取响应体，逐行解析 NDJSON。 */
async function streamRun(sessionId, text) {
	const res = await fetch("/api/sessions/" + sessionId + "/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: text }),
	});
	if (!res.ok || !res.body) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.error || "请求失败 (" + res.status + ")");
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let message = null;
	let thinkingBox = null;
	let usage = null;
	let turns = 0;

	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			const event = JSON.parse(line);
			switch (event.type) {
				case "text":
					if (!message) message = appendMessage("assistant", "");
					thinkingBox = null;
					message.body.textContent += event.delta;
					scrollToBottom();
					break;
				case "thinking_start":
					if (!message) message = appendMessage("assistant", "");
					thinkingBox = el("div", "thinking");
					message.wrap.insertBefore(thinkingBox, message.body);
					break;
				case "thinking":
					if (thinkingBox) thinkingBox.textContent += event.delta;
					break;
				case "tool_start": {
					const wrap = appendTool(event.name, "执行中…", false);
					wrap.dataset.pending = "1";
					break;
				}
				case "tool_end": {
					const pending = [...$("messages").querySelectorAll(".tool")].pop();
					if (pending && pending.dataset.pending === "1") {
						delete pending.dataset.pending;
						pending.className = event.isError ? "tool failed" : "tool";
						pending.replaceChildren();
						pending.append(el("span", "tool-icon", event.isError ? "✗" : "✓"));
						const main = el("div");
						main.append(el("div", "tool-name", event.name));
						if (event.preview) main.append(el("div", "tool-preview", event.preview));
						pending.append(main);
					} else {
						appendTool(event.name, event.preview, event.isError);
					}
					scrollToBottom();
					break;
				}
				case "run_end":
					usage = event.usage;
					if (event.error) appendMessage("error", event.error);
					break;
				case "error":
					appendMessage("error", event.message);
					break;
			}
		}
	}

	if (usage) {
		turns = usage.turns;
		$("messages").append(
			el("div", "msg-foot", "输入 " + usage.input + " · 输出 " + usage.output + " · " + turns + " 轮"),
		);
		scrollToBottom();
	}
}

async function refreshStats() {
	if (!state.projectId) return;
	const data = await api("/api/projects/" + state.projectId).catch(() => null);
	if (data) $("project-stats").textContent = statsText(data.stats);
}

$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});

// 切换模型时保留当前会话历史
$("model-select").addEventListener("change", () => {
	if (!state.sessionId) return;
	fetch("/api/sessions/" + state.sessionId + "/model", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ modelRef: $("model-select").value, thinkingLevel: $("thinking-select").value }),
	}).catch(() => {});
});

// 设置页改动供应商后，刷新模型列表并重新应用默认模型。
window.addEventListener("settings-changed", async () => {
	const data = await api("/api/bootstrap").catch(() => null);
	if (!data) return;
	const previous = $("model-select").value;
	renderModels(data.models, data.defaultModel);
	if (data.models.some((model) => model.id === previous)) $("model-select").value = previous;
});

bindSettings();

bootstrap().catch((error) => {
	$("messages").replaceChildren(el("div", "msg error", "初始化失败：" + error.message));
});
