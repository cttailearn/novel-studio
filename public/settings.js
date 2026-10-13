// 模型与供应商设置界面。
//
// 职责边界：这里只负责配置的读写与呈现，不直接操作 pi-ai。
// 任何改动都会让服务端重建 Models 注册表，然后广播 settings-changed 让主界面刷新。

const $ = (id) => document.getElementById(id);

const API_FORMATS = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", hint: "支持 /v1/chat/completions 的服务，如 vLLM、Ollama 兼容层、大部分中国厂商" },
	{ value: "openai-responses", label: "OpenAI Responses", hint: "支持 /v1/responses 的服务" },
	{ value: "anthropic-messages", label: "Anthropic Messages", hint: "Anthropic 原生 /v1/messages 协议" },
	{ value: "google-generative-ai", label: "Google Generative AI", hint: "Google 原生 /v1beta/models，模型名会自动去掉 models/ 前缀" },
];

const THINKING_LEVELS = [
	["off", "关"],
	["minimal", "最低"],
	["low", "低"],
	["medium", "中"],
	["high", "高"],
	["xhigh", "极高"],
	["max", "最高"],
];

const view = {
	data: null,
	models: [],
	selected: null,
};

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
	if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
	return data;
}

function notifyChanged() {
	window.dispatchEvent(new CustomEvent("settings-changed"));
}

// ---------------------------------------------------------------- 打开 / 刷新

export async function openSettings() {
	await refresh();
	$("settings-dialog").showModal();
}

async function refresh() {
	const [settings, models] = await Promise.all([api("/api/settings"), api("/api/models")]);
	view.data = settings;
	view.models = models.models;
	if (!view.selected || !settings.providers.some((p) => p.id === view.selected)) {
		view.selected = settings.providers[0]?.id ?? null;
	}
	renderAll();
}

function statusOf(id) {
	return view.data.statuses.find((status) => status.id === id);
}

function renderAll() {
	renderDefaults();
	renderProviderList();
	renderDetail();
}

function renderDefaults() {
	const modelSelect = $("settings-default-model");
	modelSelect.replaceChildren();
	if (view.models.length === 0) {
		const option = el("option", "", "暂无可用模型，请先配置供应商");
		option.value = "";
		modelSelect.append(option);
		modelSelect.disabled = true;
	} else {
		modelSelect.disabled = false;
		for (const model of view.models) {
			const option = el("option", "", `${model.providerLabel} · ${model.name}`);
			option.value = model.id;
			modelSelect.append(option);
		}
		modelSelect.value = view.data.defaultModel;
		if (!view.data.defaultModel) modelSelect.value = view.models[0].id;
	}

	const thinking = $("settings-default-thinking");
	thinking.replaceChildren();
	for (const [value, label] of THINKING_LEVELS) {
		const option = el("option", "", label);
		option.value = value;
		thinking.append(option);
	}
	thinking.value = view.data.defaultThinkingLevel;
}

async function saveDefaults() {
	await api("/api/settings", {
		method: "PUT",
		body: {
			defaultModel: $("settings-default-model").value,
			defaultThinkingLevel: $("settings-default-thinking").value,
		},
	});
	notifyChanged();
}

function renderProviderList() {
	const list = $("settings-providers");
	list.replaceChildren();

	const builtin = view.data.providers.filter((p) => p.kind === "builtin");
	const custom = view.data.providers.filter((p) => p.kind === "custom");

	const addRow = () => {
		const row = el("li", "provider-row");
		row.append(el("span", "dot on"));
		const name = el("span", "name", "+ 添加自定义供应商");
		row.append(name);
		row.addEventListener("click", () => openAddProvider());
		list.append(row);
	};

	if (builtin.length > 0) {
		list.append(el("li", "group-label", "默认供应商"));
		for (const provider of builtin) list.append(providerRow(provider));
	}
	if (custom.length > 0) {
		list.append(el("li", "group-label", "自定义供应商"));
		for (const provider of custom) list.append(providerRow(provider));
	}
	list.append(el("li", "group-label", ""));
	addRow();
}

function providerRow(provider) {
	const status = statusOf(provider.id);
	const row = el("li", `provider-row${provider.id === view.selected ? " active" : ""}${provider.enabled ? "" : " disabled"}`);
	row.append(el("span", "dot" + (status?.authSource !== "none" ? " on" : "")));

	const name = el("span", "name", provider.label);
	row.append(name);

	if (provider.kind === "custom") row.append(el("span", "badge custom", "自定义"));

	if (!provider.enabled) row.append(el("span", "badge", "已停用"));
	else if (status?.error) row.append(el("span", "badge err-badge", "注册失败"));
	else if (status?.authSource === "app") row.append(el("span", "badge ok", "已配置"));
	else if (status?.authSource === "env") row.append(el("span", "badge ok", "环境变量"));
	else row.append(el("span", "badge", "未配置"));

	row.addEventListener("click", () => {
		view.selected = provider.id;
		renderAll();
	});
	return row;
}

// ---------------------------------------------------------------- 详情区

function renderDetail() {
	const box = $("settings-detail");
	box.replaceChildren();
	const provider = view.data.providers.find((p) => p.id === view.selected);
	if (!provider) {
		box.append(el("div", "empty-hint", "从左侧选择一个供应商，或添加一个自定义供应商。"));
		return;
	}
	const status = statusOf(provider.id);
	if (provider.kind === "builtin") renderBuiltinDetail(box, provider, status);
	else renderCustomDetail(box, provider, status);
}

function field(labelText, control, hint) {
	const wrap = el("div", "field");
	wrap.append(el("label", "", labelText));
	wrap.append(control);
	if (hint) wrap.append(el("div", "hint", hint));
	return wrap;
}

function renderBuiltinDetail(box, provider, status) {
	box.append(el("h4", "", provider.label));
	box.append(
		el(
			"p",
			"sub",
			status?.error
				? `注册失败：${status.error}`
				: `内置供应商，模型目录由 pi-ai 内置维护（当前 ${status?.modelCount ?? 0} 个）。` +
					`环境变量：${(status?.envVars ?? []).join("、") || "无"}`,
		),
	);

	if (status?.error) box.append(el("div", "notice err", status.error));

	const keyInput = document.createElement("input");
	keyInput.type = "password";
	keyInput.placeholder =
		status?.authSource === "app" ? `已保存 ${status.maskedKey}，留空则不修改` : "粘贴 API Key，覆盖环境变量";
	box.append(
		field(
			"API Key",
			keyInput,
			status?.authSource === "env" ? `当前来自环境变量 ${status.envVars[0]}` : "仅保存在本机 data/credentials.json",
		),
	);

	const actions = el("div", "actions");
	const save = el("button", "btn btn-primary btn-sm", "保存 Key");
	save.addEventListener("click", async () => {
		if (!keyInput.value.trim()) {
			box.append(el("div", "notice err", "请输入 API Key，或用清除按钮移除已保存的 Key"));
			return;
		}
		await saveProvider(provider.id, { apiKey: keyInput.value.trim() });
	});
	actions.append(save);

	if (status?.authSource === "app") {
		const clear = el("button", "btn btn-ghost btn-sm", "清除已保存的 Key");
		clear.addEventListener("click", async () => {
			await api(`/api/providers/${provider.id}/key`, { method: "DELETE" });
			await refresh();
			notifyChanged();
		});
		actions.append(clear);
	}
	actions.append(el("span", "spacer"));
	actions.append(toggleButton(provider));
	box.append(actions);

	// 内置目录只读展示，够用即可：它的模型清单由 pi-ai 维护，不需要手工配 token 上限。
	box.append(el("h5", "detail-h", "可用模型"));
	if ((status?.modelCount ?? 0) === 0) {
		box.append(el("div", "empty-hint", "该供应商没有内置模型目录。"));
		return;
	}
	const table = el("table", "model-table");
	table.append(
		headerRow(["模型", "上下文", "输出上限", "思考", ""]),
	);
	for (const model of view.models.filter((m) => m.provider === provider.id)) {
		const tr = el("tr", model.id === view.data.defaultModel ? "is-default" : "");
		tr.append(cell(model.modelId, "model-id"));
		tr.append(cell(formatTokens(model.contextWindow)));
		tr.append(cell(formatTokens(model.maxTokens)));
		tr.append(cell(model.reasoning ? model.thinkingLevels.join("/") : "不支持"));
		const actions2 = el("td");
		const pick = el("button", "btn btn-sm", model.id === view.data.defaultModel ? "当前默认" : "设为默认");
		pick.disabled = model.id === view.data.defaultModel;
		pick.addEventListener("click", () => saveDefaultsFor(model.id));
		actions2.append(pick);
		tr.append(actions2);
		table.append(tr);
	}
	box.append(table);
}

function renderCustomDetail(box, provider, status) {
	box.append(el("h4", "", provider.label || "自定义供应商"));
	box.append(el("p", "sub", status?.error ? `注册失败：${status.error}` : `Base URL：${provider.baseUrl || "未填写"}`));
	if (status?.error) box.append(el("div", "notice err", status.error));

	const label = document.createElement("input");
	label.value = provider.label;
	const baseUrl = document.createElement("input");
	baseUrl.value = provider.baseUrl ?? "";
	baseUrl.placeholder = "https://api.example.com/v1";
	const apiSelect = document.createElement("select");
	for (const format of API_FORMATS) {
		const option = el("option", "", format.label);
		option.value = format.value;
		apiSelect.append(option);
	}
	apiSelect.value = provider.api ?? "openai-completions";
	const hint = API_FORMATS.find((f) => f.value === apiSelect.value)?.hint ?? "";
	apiSelect.addEventListener("change", () => {
		hintBox.textContent = API_FORMATS.find((f) => f.value === apiSelect.value)?.hint ?? "";
	});
	const hintBox = el("div", "hint", hint);

	const row = el("div", "field-row");
	const left = field("名称", label);
	const right = field("接口格式", apiSelect);
	row.append(left, right);
	box.append(row, field("Base URL", baseUrl, "填到版本路径即可，例如 https://api.deepseek.com/v1；服务端会自行补 /models"), hintBox);

	const keyInput = document.createElement("input");
	keyInput.type = "password";
	keyInput.placeholder = status?.authSource === "app" ? `已保存 ${status.maskedKey}，留空则不修改` : "粘贴 API Key";
	const keyHint = el(
		"div",
		"hint",
		"仅保存在本机 data/credentials.json。勾选下方开关后该字段可留空。",
	);
	box.append(field("API Key", keyInput), keyHint);

	const noAuth = document.createElement("input");
	noAuth.type = "checkbox";
	noAuth.checked = provider.noAuthRequired === true;
	const noAuthLabel = el("label", "switch");
	noAuthLabel.append(noAuth, document.createTextNode("该服务不需要鉴权（本地 / 自建）"));
	box.append(noAuthLabel);
	box.append(el("div", "hint", "开启后不会因缺少 Key 而判定为未配置。部分服务会忽略 Authorization 头，部分会直接拒绝，遇到 401 可关掉此开关。"));

	const actions = el("div", "actions");
	const save = el("button", "btn btn-primary btn-sm", "保存供应商");
	save.addEventListener("click", async () => {
		if (!baseUrl.value.trim()) {
			box.append(el("div", "notice err", "请填写 Base URL"));
			return;
		}
		await saveProvider(provider.id, {
			label: label.value.trim(),
			baseUrl: baseUrl.value.trim(),
			api: apiSelect.value,
			noAuthRequired: noAuth.checked,
			...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
		});
	});
	actions.append(save);

	const pull = el("button", "btn btn-sm", "拉取模型");
	pull.addEventListener("click", () => pullModels(provider.id, box));
	actions.append(pull);

	const test = el("button", "btn btn-sm", "测试连接");
	test.addEventListener("click", () => testConnection(provider.id, box));
	actions.append(test);

	actions.append(el("span", "spacer"));
	actions.append(toggleButton(provider));

	const remove = el("button", "btn btn-danger btn-sm", "删除供应商");
	remove.addEventListener("click", async () => {
		if (!confirm(`确定删除供应商「${provider.label}」？已保存的 Key 与模型配置会一并清除。`)) return;
		await api(`/api/providers/${provider.id}`, { method: "DELETE" });
		view.selected = null;
		await refresh();
		notifyChanged();
	});
	actions.append(remove);
	box.append(actions);

	renderCustomModels(box, provider);
}

function renderCustomModels(box, provider) {
	box.append(el("h5", "detail-h", `模型配置（${provider.models.length}）`));

	if (provider.models.length === 0) {
		box.append(el("div", "empty-hint", "还没有模型。填好 Base URL 与 Key 后点「拉取模型」，或直接在下方手动添加。"));
	}

	const table = el("table", "model-table");
	table.append(headerRow(["模型", "输入上下文", "输出上限", "思考", "档位", ""]));

	for (const model of provider.models) {
		const tr = el("tr", `${provider.id}/${model.id}` === view.data.defaultModel ? "is-default" : "");

		const idCell = el("td");
		const idInput = document.createElement("input");
		idInput.type = "text";
		idInput.value = model.id;
		idInput.addEventListener("change", () => void saveModel(provider.id, { ...model, id: idInput.value.trim() || model.id }));
		idCell.append(idInput);
		tr.append(idCell);

		const ctxCell = el("td");
		const ctx = numberInput(model.contextWindow, (value) => void saveModel(provider.id, { ...model, contextWindow: value }));
		ctxCell.append(ctx);
		tr.append(ctxCell);

		const maxCell = el("td");
		const max = numberInput(model.maxTokens, (value) => void saveModel(provider.id, { ...model, maxTokens: value }));
		maxCell.append(max);
		tr.append(maxCell);

		const reasonCell = el("td");
		const reason = document.createElement("input");
		reason.type = "checkbox";
		reason.checked = model.reasoning;
		reason.addEventListener("change", () =>
			void saveModel(provider.id, {
				...model,
				reasoning: reason.checked,
				thinkingLevels: reason.checked ? model.thinkingLevels.filter((l) => l !== "off") : ["off"],
			}),
		);
		reasonCell.append(reason);
		tr.append(reasonCell);

		const levelsCell = el("td");
		const levels = el("div", "levels");
		for (const [value, labelText] of THINKING_LEVELS) {
			if (value === "off") continue;
			const wrap = el("label", "", "");
			const box = document.createElement("input");
			box.type = "checkbox";
			box.checked = model.reasoning && model.thinkingLevels.includes(value);
			box.addEventListener("change", () => {
				const next = new Set(model.thinkingLevels);
				if (box.checked) next.add(value);
				else next.delete(value);
				void saveModel(provider.id, { ...model, reasoning: true, thinkingLevels: [...next] });
			});
			wrap.append(box, document.createTextNode(labelText));
			levels.append(wrap);
		}
		levelsCell.append(levels);
		tr.append(levelsCell);

		const actCell = el("td");
		const box = el("div", "row-actions");
		const pick = el("button", "btn btn-sm", `${provider.id}/${model.id}` === view.data.defaultModel ? "当前默认" : "默认");
		pick.disabled = `${provider.id}/${model.id}` === view.data.defaultModel;
		pick.addEventListener("click", () => saveDefaultsFor(`${provider.id}/${model.id}`));
		const del = el("button", "btn btn-ghost btn-sm", "删");
		del.addEventListener("click", () => void deleteModel(provider.id, model.id));
		box.append(pick, del);
		actCell.append(box);
		tr.append(actCell);

		table.append(tr);
	}
	box.append(table);

	const addRow = el("div", "actions");
	const add = el("button", "btn btn-sm", "+ 手动添加模型");
	add.addEventListener("click", () => {
		const name = prompt("模型 id（发送给服务端的 model 字段）");
		if (!name?.trim()) return;
		void saveModel(provider.id, {
			id: name.trim(),
			name: name.trim(),
			contextWindow: 128000,
			maxTokens: 8192,
			reasoning: false,
			thinkingLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
	addRow.append(add);
	box.append(addRow);
}

function headerRow(labels) {
	const tr = el("tr");
	for (const label of labels) tr.append(el("th", "", label));
	return tr;
}

function cell(text, className) {
	return el("td", className, text);
}

function numberInput(value, onChange) {
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.step = "1000";
	input.value = String(value);
	input.addEventListener("change", () => onChange(Math.max(1, Math.floor(Number(input.value) || value))));
	return input;
}

function toggleButton(provider) {
	const button = el("button", "btn btn-ghost btn-sm", provider.enabled ? "停用" : "启用");
	button.addEventListener("click", () => void saveProvider(provider.id, { enabled: !provider.enabled }));
	return button;
}

function formatTokens(value) {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}K`;
	return String(value);
}

// ---------------------------------------------------------------- 操作

async function saveProvider(id, body) {
	await api(`/api/providers/${id}`, { method: "PATCH", body });
	await refresh();
	notifyChanged();
}

async function saveModel(providerId, model) {
	await api(`/api/providers/${providerId}/models`, { method: "POST", body: model });
	await refresh();
	notifyChanged();
}

async function deleteModel(providerId, modelId) {
	await api(`/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
	await refresh();
	notifyChanged();
}

async function saveDefaultsFor(modelId) {
	await api("/api/settings", { method: "PUT", body: { defaultModel: modelId } });
	await refresh();
	notifyChanged();
}

function noticeBox(box, message, kind) {
	const existing = box.querySelector(".notice");
	if (existing) existing.remove();
	const node = el("div", "notice" + (kind ? " " + kind : ""), message);
	box.append(node);
	setTimeout(() => node.remove(), 6000);
}

async function pullModels(providerId, box) {
	noticeBox(box, "正在从上游拉取模型列表…");
	try {
		const result = await api(`/api/providers/${providerId}/models/fetch`, { method: "POST" });
		await refresh();
		notifyChanged();
		const detail = $("settings-detail");
		noticeBox(detail, `拉取到 ${result.fetched} 个模型，新增 ${result.added} 个。已有配置保持不变。`, "ok");
	} catch (error) {
		noticeBox(box, `拉取失败：${error.message}`, "err");
	}
}

async function testConnection(providerId, box) {
	const config = view.data.providers.find((p) => p.id === providerId);
	if (!config || config.kind !== "custom") {
		noticeBox(box, "内置供应商没有独立的探测接口，请直接保存后尝试一次对话。");
		return;
	}
	noticeBox(box, "正在测试连接…");
	try {
		const result = await api(`/api/providers/${providerId}/models/fetch`, { method: "POST" });
		noticeBox(box, `连接正常，发现 ${result.fetched} 个模型。`, "ok");
		await refresh();
	} catch (error) {
		noticeBox(box, `连接失败：${error.message}`, "err");
	}
}

function openAddProvider() {
	const label = prompt("供应商名称，例如：我的中转服务");
	if (!label?.trim()) return;
	const baseUrl = prompt("Base URL，例如 https://api.example.com/v1");
	if (!baseUrl?.trim()) return;
	api("/api/providers", { method: "POST", body: { label: label.trim(), baseUrl: baseUrl.trim(), api: "openai-completions" } })
		.then(async (result) => {
			view.selected = result.provider.id;
			await refresh();
			notifyChanged();
		})
		.catch((error) => alert(`创建失败：${error.message}`));
}

// ---------------------------------------------------------------- 绑定

export function bindSettings() {
	$("open-settings").addEventListener("click", () => void openSettings());
	$("settings-close").addEventListener("click", () => $("settings-dialog").close());
	$("settings-default-model").addEventListener("change", () => void saveDefaults());
	$("settings-default-thinking").addEventListener("change", () => void saveDefaults());
}
