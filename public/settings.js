// 模型与供应商设置界面。
//
// 职责边界：这里只负责配置的读写与呈现，不直接操作 pi-ai。
// 任何改动都会让服务端重建 Models 注册表，然后广播 settings-changed 让主界面刷新。
//
// 模型区不再是一张宽表格：三十个模型的供应商在窄屏上根本读不完，
// 一行六个思考档位复选框更是把表格撑到要横向滚动。
// 现在改成「检索 + 卡片行 + 批量」，占位值（待核对）能一次处理掉。

const $ = (id) => document.getElementById(id);

// 接口格式的说明只留「怎么认」，一句话讲完。
// 原来那句「如 vLLM、Ollama 兼容层、大部分中国厂商」是背景知识，
// 看完也替用户做不了决定，只会把下拉底下那一行撑成两行。
const API_FORMATS = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", hint: "兼容 /v1/chat/completions，多数厂商选这个" },
	{ value: "openai-responses", label: "OpenAI Responses", hint: "走 /v1/responses" },
	{ value: "anthropic-messages", label: "Anthropic Messages", hint: "Anthropic 原生 /v1/messages" },
	{ value: "google-generative-ai", label: "Google Generative AI", hint: "Google 原生 /v1beta/models（自动去 models/ 前缀）" },
];

const API_FORMAT_HINTS = {
	"openai-completions": "兼容 /v1/chat/completions，多数厂商选这个",
	"openai-responses": "走 /v1/responses",
	"anthropic-messages": "Anthropic 原生 /v1/messages",
	"google-generative-ai": "Google 原生 /v1beta/models（自动去 models/ 前缀）",
};

/**
 * 思考档位表 —— 设置页与工作台顶栏共用这一份。
 *
 * 顶栏按所选模型过滤后重建下拉，设置页则全量列出：
 * 那里配的是「这个模型理论上支持什么」，与此刻手上这支笔无关。
 * 文案统一用水墨一套，值与 pi-ai 的 ThinkingLevel 一一对应。
 */
export const THINKING_LEVELS = [
	["off", "不思"],
	["minimal", "微思"],
	["low", "略思"],
	["medium", "细思"],
	["high", "深思"],
	["xhigh", "极思"],
	["max", "尽思"],
];

/**
 * 档位展示文案：中文水墨词后头跟一句原始值。
 *
 * 中文词只管意境，真正写进 .env 或调 API 的是括号里的那个词，
 * 摆在一起免得对着屏幕猜 high 到底是「深思」还是「尽思」。
 */
export function levelText(value, label) {
	return `${label}（${value}）`;
}

/** 档位值取水墨文案；认不出的原样透出，免得静默吞掉。 */
function levelLabel(value) {
	return THINKING_LEVELS.find((level) => level[0] === value)?.[1] ?? value;
}

/** 可勾选的思考档位（不含「不思」）。「不思」是关闭思考时的状态，不是可选项。 */
const THINKING_CHIPS = THINKING_LEVELS.filter(([value]) => value !== "off");

/** 后端没给 defaults 时的占位兜底，与服务端 DEFAULT_CONTEXT_WINDOW / DEFAULT_MAX_TOKENS 一致。 */
const FALLBACK_DEFAULTS = { contextWindow: 1_048_576, maxTokens: 131_072 };

/** 成本估算的粗略口径：中文 1 字 ≈ 0.7 token，一章按 3000 字算。 */
const CHAPTER_CHARS = 3000;
const CHARS_PER_TOKEN = 0.7;

const view = {
	data: null,
	models: [],
	/** 当前选中的供应商 id。 */
	selected: null,
	/** 供应商搜索词。 */
	query: "",
	/** 模型搜索词。 */
	modelQuery: "",
	/** 批量选择：模型键 "providerId/modelId"。 */
	picked: new Set(),
	/** 批量设置小表单是否展开。 */
	batchOpen: false,
	/** 默认模型下拉的搜索词。 */
	defaultSearch: "",
	/** 当前模型区的上下文，供「只重画列表」用。 */
	modelContext: null,
	/** 窄屏的两页：list = 供应商列表，detail = 某一家的详情。宽屏两栏并排，这个字段不起作用。 */
	pane: "list",
	section: "models",
	/** 上一次画出的供应商。换了一家就把详情滚回顶部，同一次刷新则保留滚动位置。 */
	lastSelected: null,
	/** 打开设置前的焦点，关闭时还回去。 */
	returnFocus: null,
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
	if (!res.ok) {
		const error = new Error(data.error || `请求失败 (${res.status})`);
		// 带上状态码：批量接口没上线时（404 / 405）要能退回到逐个设置。
		error.status = res.status;
		throw error;
	}
	return data;
}

function notifyChanged() {
	window.dispatchEvent(new CustomEvent("settings-changed"));
}

// ---------------------------------------------------------------- 打开 / 刷新

export async function openSettings() {
	view.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	// 手机上每次打开都从供应商列表起步：上次停在谁家是上一段的语境，
	// 直接落进详情会让人一睁眼就在陌生的表单里。
	view.pane = "list";
	setSection("models");

	// 先把对话框打开，再去取数据。
	// 之前是 `await refresh()` 之后才 showModal：慢网下第一次拉设置要等好几秒，
	// 用户看到的就是「点了没反应」。现在立刻给出反馈，数据到了再填进去。
	const dialog = $("settings-dialog");
	if (dialog && !dialog.open) dialog.showModal();
	const heading = dialog?.querySelector("h3");
	if (heading) {
		heading.tabIndex = -1;
		heading.focus({ preventScroll: true });
	}
	if (!view.data) showSettingsLoading();

	try {
		await refresh();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showSettingsError(message);
		saveStatus(`设置加载失败：${message}`, "err");
	}
	applyPane();
}

/** 首屏还没数据时的占位，别让用户对着一张空白纸。 */
function showSettingsLoading() {
	const list = $("settings-providers");
	if (list) list.replaceChildren(el("li", "empty-hint", "正在加载设置…"));
	const detail = $("settings-detail");
	if (detail) detail.replaceChildren(el("div", "empty-hint", "正在加载设置…"));
}

/** 设置拉取失败时，把原因留在纸面上，而不是静默地什么都不发生。 */
function showSettingsError(message) {
	const list = $("settings-providers");
	if (list) {
		list.replaceChildren(
			el("li", "empty-hint", `设置加载失败：${message}`),
			el("li", "empty-hint", "检查网络后关掉这个窗口重开一次。"),
		);
	}
	const detail = $("settings-detail");
	if (detail) detail.replaceChildren(el("div", "notice err", `设置加载失败：${message}`));
	const summary = $("provider-summary");
	if (summary) summary.textContent = "加载失败";
}

/**
 * 窄屏「列表 / 详情」两页的开关。
 *
 * 只挂一个类名：宽屏上两栏并排，这个类名没有任何规则认领；
 * 手机上由 CSS 决定哪一页露面。不碰 URL、不碰浏览器的返回键。
 */
function applyPane() {
	const dialog = $("settings-dialog");
	if (!dialog) return;
	dialog.classList.toggle("is-pane-detail", view.pane === "detail");
}

async function refresh() {
	const [settings, models] = await Promise.all([api("/api/settings"), api("/api/models")]);
	view.data = settings;
	view.models = Array.isArray(models?.models) ? models.models : [];
	if (!view.selected || !settings.providers.some((p) => p.id === view.selected)) {
		view.selected = settings.providers[0]?.id ?? null;
	}
	renderAll();
}

function setSection(section) {
	view.section = section === "web" ? "web" : "models";
	for (const name of ["models", "web"]) {
		const active = view.section === name;
		const tab = $(`settings-tab-${name}`);
		const panel = $(`settings-${name}-panel`);
		tab.classList.toggle("is-on", active);
		tab.setAttribute("aria-selected", String(active));
		tab.tabIndex = active ? 0 : -1;
		panel.hidden = !active;
	}
}

function statusOf(id) {
	return view.data.statuses.find((status) => status.id === id);
}

/** 占位默认值：后端没给就用兜底。 */
function defaultLimits() {
	return view.data?.defaults ?? FALLBACK_DEFAULTS;
}

function renderAll() {
	renderDefaults();
	renderProviderList();
	renderDetail();
	renderWebSettings();
	renderReadySummary();
	renderStorageSummary();
	setSection(view.section);
	applyPane();
}

function renderReadySummary() {
	const configured = view.data.providers.filter((provider) => provider.enabled && !unavailableReason(provider)).length;
	$("provider-summary").textContent = `${configured} 家已就绪`;
	const web = view.data.webSearch ?? {};
	const badge = $("settings-web-nav-status");
	badge.textContent = web.enabled ? (web.configured ? "已开启" : "缺密钥") : "";
	badge.className = `settings-nav-dot${web.enabled ? web.configured ? " is-ok" : " is-warn" : ""}`;
}

/**
 * 数据与密钥存哪、占多少、怎么带走。
 * 多用户部署（STORAGE=idb）下服务端不保存任何作品和密钥，这件事只写在部署文档里没人看得见，
 * 所以直接摆在设置第一屏：模式不同文案也不同，别让单机自用的人误以为数据在云端。
 */
function renderStorageSummary() {
	const box = $("storage-summary");
	const subtitle = $("settings-subtitle");
	const browserMode = isBrowserStorage();
	if (subtitle) {
		subtitle.textContent = browserMode
			? "模型、供应商与联网资料 · 数据与密钥只存在你的浏览器里"
			: "模型、供应商与联网资料 · 所有密钥仅保存在本机";
	}
	if (!box) return;
	box.hidden = false;
	box.replaceChildren();
	box.append(el("span", "storage-title", browserMode ? "数据与密钥只在这台设备的浏览器里" : "数据与密钥保存在本机 data/ 目录"));
	box.append(el("span", "storage-detail", browserMode
		? "服务器不保存作品和密钥；换设备或清理浏览器数据后会丢，建议定期导出备份。"
		: "不会上传到服务器。"));
	if (!browserMode) return;

	const usage = el("span", "storage-usage", "正在统计占用…");
	const actions = el("span", "storage-actions");
	const backup = el("button", "btn btn-quiet btn-sm", "导出备份");
	backup.type = "button";
	backup.title = "把全部作品、素材与设置打包成 .novel 文件，存到本机";
	backup.addEventListener("click", () => {
		const dialog = $("settings-dialog");
		if (dialog?.open) dialog.close();
		window.dispatchEvent(new Event("novel:open-backup"));
	});
	actions.append(backup);

	const storage = navigator.storage;
	if (typeof storage?.persist === "function") {
		const pin = el("button", "btn btn-quiet btn-sm", "固化存储");
		pin.type = "button";
		pin.title = "请浏览器尽量别因为空间紧张清掉本站数据";
		pin.addEventListener("click", async () => {
			pin.disabled = true;
			let granted = false;
			try {
				granted = await storage.persist();
			} catch {
				// 不支持就照常提示未固化，不影响别的功能。
			}
			pin.textContent = granted ? "已固化" : "未获批";
			void refreshStorageUsage(usage);
		});
		actions.append(pin);
	}

	box.append(usage, actions);
	void refreshStorageUsage(usage);
}

async function refreshStorageUsage(node) {
	try {
		const storage = navigator.storage;
		const estimate = await storage?.estimate?.();
		const persisted = await storage?.persisted?.();
		if (!node.isConnected) return;
		const parts = [`已用 ${formatBytes(estimate?.usage ?? 0)}`];
		if (estimate?.quota) parts.push(`可用额度 ${formatBytes(estimate.quota)}`);
		parts.push(persisted ? "已固化" : "未固化（空间紧张时可能被清理）");
		node.textContent = parts.join(" · ");
	} catch {
		if (node.isConnected) node.textContent = "";
	}
}

let statusTimer;
function saveStatus(message, kind = "") {
	const node = $("settings-save-status");
	clearTimeout(statusTimer);
	node.textContent = message;
	node.className = `settings-save-status${kind ? ` is-${kind}` : ""}`;
	if (kind === "ok") statusTimer = setTimeout(() => { node.textContent = ""; }, 5000);
}

async function operation(message, task) {
	saveStatus(message);
	try {
		const result = await task();
		saveStatus("已保存", "ok");
		return result;
	} catch (error) {
		saveStatus(error.message, "err");
		throw error;
	}
}

// ---------------------------------------------------------------- 默认笔与思深

/**
 * 默认模型的可选项。
 *
 * 两头都要：
 *  - view.models 里「当前可用」的模型（后端只列注册成功、鉴权齐备的）；
 *  - 配置里存着、此刻却用不了的模型（供应商停用 / 没配 Key / 已从上游消失）。
 * 后者若直接不列，用户会以为模型凭空消失了 —— 标出来更诚实。
 */
function defaultCandidates() {
	const out = [];
	const seen = new Set();
	for (const model of view.models) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		const config = configModelOf(model.provider, model.modelId);
		const provider = view.data.providers.find((p) => p.id === model.provider) ?? null;
		const reason = unavailableReason(provider);
		out.push({
			id: model.id,
			modelId: model.modelId,
			name: model.name || model.modelId,
			providerId: model.provider,
			providerLabel: model.providerLabel,
			available: !reason,
			reason,
			model: mergeModel(model, config),
		});
	}
	for (const provider of view.data.providers) {
		for (const config of provider.models ?? []) {
			const key = `${provider.id}/${config.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const reason = unavailableReason(provider, false);
			out.push({
				id: key,
				modelId: config.id,
				name: config.name || config.id,
				providerId: provider.id,
				providerLabel: provider.label,
				available: !reason,
				reason,
				model: mergeModel(null, config),
			});
		}
	}
	return out;
}

/** 配置里的模型条目（自定义供应商才有）。 */
function configModelOf(providerId, modelId) {
	const provider = view.data.providers.find((p) => p.id === providerId);
	return provider?.models?.find((m) => m.id === modelId) ?? null;
}

/** 运行时摘要（/api/models）与配置条目合并：配置说了算，摘要补运行时才知道的东西。 */
function mergeModel(summary, config) {
	if (!config) return summary ?? null;
	return { ...(summary ?? {}), ...config, cost: costOf(config, summary) };
}

/**
 * 某个模型此刻为什么用不了。
 *
 * known=false 表示配置里有、运行时却没有登记（模型 id 写错了、或者上游还没拉到）。
 * 返回空串就是「能用」。
 */
function unavailableReason(provider, known = true) {
	if (!provider) return "未注册";
	if (!provider.enabled) return "供应商已停用";
	const status = statusOf(provider.id);
	if (status && status.authSource === "none") {
		if (provider.kind === "custom") return provider.noAuthRequired === true ? "" : "未配置密钥";
		// 内置供应商：只有确实要密钥的那种才算缺，别把本地模型也判成不可用。
		return (status.envVars ?? []).length > 0 ? "未配置密钥" : "";
	}
	if (!known) return "未注册";
	return "";
}

/** 成本。后端没透出 cost 就返回 null，界面据此隐藏成本编辑区。 */
function costOf(config, summary) {
	const raw = config?.cost ?? summary?.cost;
	if (!raw || typeof raw !== "object") return null;
	const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
	return {
		input: num(raw.input),
		output: num(raw.output),
		cacheRead: num(raw.cacheRead),
		cacheWrite: num(raw.cacheWrite),
	};
}

/** 模型下拉按供应商分组。 */
function groupCandidates(candidates) {
	const groups = new Map();
	for (const entry of candidates) {
		if (!groups.has(entry.providerId)) {
			const provider = view.data.providers.find((p) => p.id === entry.providerId);
			const label = entry.providerLabel || entry.providerId;
			groups.set(entry.providerId, {
				id: entry.providerId,
				label: provider && !provider.enabled ? `${label}（已停用）` : label,
				entries: [],
			});
		}
		groups.get(entry.providerId).entries.push(entry);
	}
	return [...groups.values()];
}

function optionLabel(entry) {
	return entry.available ? entry.name : `${entry.name}（${entry.reason}）`;
}

function matchesCandidate(entry, query) {
	const haystack = [entry.name, entry.modelId, entry.providerLabel].join(" ").toLowerCase();
	return haystack.includes(query);
}

function renderDefaults() {
	const modelSelect = $("settings-default-model");
	if (!modelSelect) return;
	const candidates = defaultCandidates();
	const query = view.defaultSearch.trim().toLowerCase();
	let shown = query ? candidates.filter((entry) => matchesCandidate(entry, query)) : candidates.slice();
	// 当前默认的那一支永远留在下拉里：筛掉了它，下拉就会变成空的，看起来像默认丢了。
	const current = modelSelect.value || view.data.defaultModel || "";
	if (current && !shown.some((entry) => entry.id === current)) {
		const keep = candidates.find((entry) => entry.id === current);
		if (keep) shown.unshift(keep);
	}

	modelSelect.replaceChildren();
	if (shown.length === 0) {
		const option = el("option", "", candidates.length === 0 ? "暂无可用模型，请先配置供应商" : "没有匹配的模型");
		option.value = "";
		modelSelect.append(option);
		modelSelect.disabled = true;
	} else {
		modelSelect.disabled = false;
		for (const group of groupCandidates(shown)) {
			const optgroup = el("optgroup");
			optgroup.label = group.label;
			for (const entry of group.entries) {
				const option = el("option", "", optionLabel(entry));
				option.value = entry.id;
				if (!entry.available) option.dataset.unavailable = "1";
				optgroup.append(option);
			}
			modelSelect.append(optgroup);
		}
		const wanted = [...modelSelect.options].some((option) => option.value === current)
			? current
			: shown[0].id;
		modelSelect.value = wanted;
	}

	renderThinkingSelect();
	updateDefaultHints();
}

function renderThinkingSelect() {
	const thinking = $("settings-default-thinking");
	if (!thinking) return;
	const current = thinking.value || view.data.defaultThinkingLevel;
	thinking.replaceChildren();
	for (const [value, label] of THINKING_LEVELS) {
		const option = el("option", "", levelText(value, label));
		option.value = value;
		thinking.append(option);
	}
	thinking.value = [...thinking.options].some((option) => option.value === current)
		? current
		: view.data.defaultThinkingLevel;
}

/**
 * 默认档位与所选模型的联动提示，以及成本粗估。
 *
 * 选了支不支持思考的模型，档位还停在「深思」上，是静默失效 —— 得说出来。
 */
function updateDefaultHints() {
	const hint = $("settings-default-hint");
	const costBox = $("settings-default-cost");
	const modelSelect = $("settings-default-model");
	const thinking = $("settings-default-thinking");
	if (!modelSelect || !thinking) return;

	const modelId = modelSelect.value || view.data.defaultModel || "";
	const entry = defaultCandidates().find((item) => item.id === modelId) ?? null;
	const level = thinking.value;

	let text = "";
	if (entry) {
		if (!entry.available) {
			text = `「${entry.name}」当前不可用：${entry.reason}。`;
		} else if (entry.model?.reasoning === false && level !== "off") {
			text = `「${entry.name}」未开启思考能力，当前档位「${levelLabel(level)}」不会生效。`;
		} else if (entry.model?.reasoning === true && level !== "off" && Array.isArray(entry.model.thinkingLevels)) {
			if (!entry.model.thinkingLevels.includes(level)) {
				text = `「${entry.name}」不支持「${levelLabel(level)}」档位。`;
			}
		}
	}
	if (hint) {
		hint.textContent = text;
		hint.classList.toggle("is-warn", Boolean(text));
	}
	if (costBox) costBox.replaceChildren(costNodes(costEstimate(entry)));
}

/**
 * 把粗估那句话拆成「数字」与「单位」两色。
 *
 * 数字换等宽（几位数一眼对齐），单位退成飞白 —— 整句同色时读的人得自己找钱数。
 * 只切文本、不拼 HTML，所以不存在注入问题。
 */
function costNodes(text) {
	const frag = document.createDocumentFragment();
	const pattern = /\d+(?:[.,]\d+)?\s?[KM]?/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) frag.append(el("span", "cost-unit", text.slice(last, match.index)));
		frag.append(el("span", "cost-num", match[0]));
		last = match.index + match[0].length;
	}
	if (last < text.length) frag.append(el("span", "cost-unit", text.slice(last)));
	return frag;
}

/**
 * 一章的成本粗估。
 *
 * 中文 1 字 ≈ 0.7 token，一章 3000 字 ≈ 4.3K token；输入与输出各按这个量级估。
 * 没填成本就说没填，不写 ¥0.00 —— 那会被当成「这家不收钱」。
 */
function costEstimate(entry) {
	if (!entry) return "未选模型";
	const cost = entry.model?.cost;
	if (!cost || (!cost.input && !cost.output)) return "未填成本";
	const tokens = Math.round(CHAPTER_CHARS / CHARS_PER_TOKEN);
	const total = (tokens / 1_000_000) * (cost.input + cost.output);
	const money = total >= 0.1 ? total.toFixed(2) : total.toFixed(3);
	return `一章 ${CHAPTER_CHARS} 字 ≈ 输入 ${formatTokens(tokens)} + 输出 ${formatTokens(tokens)} token ≈ ¥${money}（粗估，1 字 ≈ 0.7 token）`;
}

async function saveDefaults() {
	const modelSelect = $("settings-default-model");
	const thinking = $("settings-default-thinking");
	const body = {};
	// 下拉为空或被禁用时不要把 defaultModel 写成空串：那等于把默认笔抹掉。
	if (modelSelect && !modelSelect.disabled && modelSelect.value) body.defaultModel = modelSelect.value;
	if (thinking && thinking.value) body.defaultThinkingLevel = thinking.value;
	if (Object.keys(body).length === 0) return;
	await operation("正在保存默认配置…", async () => {
		await api("/api/settings", { method: "PUT", body });
		await refresh();
		notifyChanged();
	});
}

// ---------------------------------------------------------------- 供应商列表

/** 搜索命中：名称、id、环境变量名任一包含即可。 */
function matches(provider, query) {
	if (!query) return true;
	const status = statusOf(provider.id);
	const haystack = [provider.label, provider.id, ...(status?.envVars ?? [])].join(" ").toLowerCase();
	return haystack.includes(query);
}

function renderProviderList() {
	const list = $("settings-providers");
	list.replaceChildren();

	// 搜索框在 index.html 里，不归这里管：它若跟着列表一起重建，
	// 每敲一个字就被销毁一次，焦点掉回 body，第二个字永远敲不进去。
	// 也别在这里回写它的 value：view.query 是小写化过的，回写会把作者
	// 刚敲的大小写抹掉、把光标弹回末尾。

	const builtin = view.data.providers.filter((p) => p.kind === "builtin");
	const custom = view.data.providers.filter((p) => p.kind === "custom");

	// 新增入口固定在最上。内置 42 个之后它会被挤到列表底部，等于没有。
	const addRow = el("li", "provider-row add-row");
	addRow.append(el("span", "dot on"));
	addRow.append(el("span", "name", "＋ 添加自定义供应商"));
	pressable(addRow, () => openAddProvider());
	list.append(addRow);

	if (custom.length > 0) {
		list.append(el("li", "group-label", "自定义供应商"));
		for (const provider of custom) list.append(providerRow(provider));
	}

	// 内置供应商按分组展开，命中搜索时只显示命中的
	const order = ["推荐", "国际通用", "国内厂商", "云平台与推理"];
	for (const group of order) {
		const items = builtin.filter((p) => statusOf(p.id)?.group === group && matches(p, view.query));
		if (items.length === 0) continue;
		list.append(el("li", "group-label", group + "（" + items.length + "）"));
		for (const provider of items) list.append(providerRow(provider));
	}

	const hidden = builtin.length - builtin.filter((p) => matches(p, view.query)).length;
	if (builtin.length === 0) {
		list.append(el("li", "group-label", "默认供应商"));
	}
	if (hidden > 0) {
		list.append(el("li", "group-label", view.query ? "无更多匹配项" : ""));
	}

	// 列表末尾再给一个入口，滚到底时仍可点
	const addRowEnd = el("li", "provider-row add-row");
	addRowEnd.append(el("span", "dot on"));
	addRowEnd.append(el("span", "name", "＋ 添加自定义供应商"));
	pressable(addRowEnd, () => openAddProvider());
	list.append(addRowEnd);
}

/** 让普通元素也能用键盘按下去：Tab 走得到，回车与空格都算按。 */
function pressable(node, onPress) {
	node.tabIndex = 0;
	node.setAttribute("role", "button");
	node.addEventListener("click", onPress);
	node.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		onPress();
	});
	return node;
}

function providerRow(provider) {
	const status = statusOf(provider.id);
	const kind = provider.kind === "custom" ? "kind-custom" : "kind-builtin";
	const row = el(
		"li",
		`provider-row ${kind}${provider.id === view.selected ? " is-on" : ""}${provider.enabled ? "" : " is-off"}`,
	);
	if (provider.id === view.selected) row.setAttribute("aria-current", "true");
	row.append(el("span", "dot" + (status?.authSource !== "none" ? " on" : "")));

	const name = el("span", "name", provider.label);
	row.append(name);

	if (provider.kind === "custom") row.append(el("span", "badge custom", "自定义"));

	if (!provider.enabled) row.append(el("span", "badge", "停用"));
	else if (status?.error) row.append(el("span", "badge err-badge", "注册失败"));
	else if (status?.authSource === "app") row.append(el("span", "badge ok", "已配置"));
	else if (status?.authSource === "env") row.append(el("span", "badge ok", "环境变量"));
	else row.append(el("span", "badge", "未配置"));

	pressable(row, () => {
		if (view.selected !== provider.id) {
			// 换供应商时，勾选与批量表单都是上一家的语境，留在原地会误伤。
			view.picked.clear();
			view.modelQuery = "";
			view.batchOpen = false;
		}
		view.selected = provider.id;
		// 窄屏上点一家就翻到详情页；宽屏两栏并排，翻页类名没有规则认领。
		view.pane = "detail";
		renderAll();
	});
	return row;
}

// ---------------------------------------------------------------- 详情区

/**
 * 窄屏详情页的退路。
 *
 * 手机上列表与详情是两页，没有这一步就只能在地址栏后退 —— 那会连对话框一起关掉。
 * 宽屏两栏并排，这个按钮由 CSS 藏起来，留着不碍事。
 */
function backButton() {
	const button = el("button", "btn btn-quiet btn-sm settings-back", "← 返回供应商列表");
	button.id = "settings-back";
	button.setAttribute("aria-label", "返回供应商列表");
	button.addEventListener("click", () => {
		view.pane = "list";
		applyPane();
	});
	return button;
}

function renderDetail() {
	const box = $("settings-detail");
	if (!box) return;
	// 重画会把滚动位置和焦点一并清掉：模型列表往往很长，存完一个值就跳回顶部很难受。
	// 换了供应商是另一回事 —— 那时候正该回到新一家的顶上。
	const changed = view.lastSelected !== view.selected;
	const scrollTop = changed ? 0 : box.scrollTop;
	const active = document.activeElement;
	const keepFocus = active && active.id && box.contains(active) && (active.type === "search" || active.type === "text");
	const focusId = keepFocus ? active.id : null;
	const caret = keepFocus && typeof active.selectionStart === "number" ? active.selectionStart : null;

	box.replaceChildren();
	box.append(backButton());
	view.lastSelected = view.selected;
	const provider = view.data.providers.find((p) => p.id === view.selected);
	if (!provider) {
		box.append(el("div", "empty-hint", "从左侧选择一个供应商，或添加一个自定义供应商。"));
		return;
	}
	const status = statusOf(provider.id);
	if (provider.kind === "builtin") renderBuiltinDetail(box, provider, status);
	else renderCustomDetail(box, provider, status);

	box.scrollTop = scrollTop;
	if (focusId) {
		const next = document.getElementById(focusId);
		if (next) {
			next.focus();
			if (caret !== null && typeof next.setSelectionRange === "function") {
				try {
					next.setSelectionRange(caret, caret);
				} catch {
					/* 某些输入类型不支持选区，忽略即可 */
				}
			}
		}
	}
}

/** 表单字段计数器：给没 id 的控件补一个，好让 label 真的能指到它。 */
let fieldSeq = 0;

/** 控件 id 计数器：思考开关、档位组都需要一个唯一 id，label 才能指对地方。 */
let reasonSeq = 0;

/** 只有表单控件才配得上 label for。 */
const LABELABLE = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * 一行小字说明。
 *
 * 屏幕上只留能指导操作的那半句；原文（数据存哪、什么情况下会失效）
 * 收进 title —— 想看的人悬停就有，不看的人也不用被三行灰字挡住。
 */
function hintLine(short, full) {
	const node = el("div", "hint", short);
	if (full) node.title = full;
	return node;
}

/**
 * 这个部署形态下密钥存在哪。
 *
 * 同一份界面既跑在「服务端 + data/credentials.json」的单机模式，也跑在
 * 「数据全在浏览器」的多用户模式，提示文案不能写死 —— 否则用户会以为
 * 密钥被传到服务器上了（恰恰相反）。
 */
function isBrowserStorage() {
	return window.__DSH_LOCAL_MODE__ === true || window.__NOVEL_LOCAL_MODE__ === true;
}

function keyStorageShort() {
	return isBrowserStorage() ? "仅存这台设备的浏览器里" : "仅存本机";
}

function keyStorageFull() {
	return isBrowserStorage()
		? "仅保存在这台设备的浏览器里（IndexedDB），不会上传到服务器；换设备或清理浏览器数据后需要重新填写。"
		: "仅保存在本机 data/credentials.json，不会上传到服务器。";
}

/**
 * 「细则」折叠块：纯背景解释收进来，默认收起。
 *
 * 用原生 details/summary，键盘可达与读屏语义都是白送的，
 * 不必自己造开关再补一套 aria。
 */
function foldBox(summaryText, ...paragraphs) {
	const box = document.createElement("details");
	box.className = "fold";
	box.append(el("summary", "fold-head", summaryText));
	const body = el("div", "fold-body");
	for (const text of paragraphs) body.append(el("p", "", text));
	box.append(body);
	return box;
}

function field(labelText, control, hint) {
	const wrap = el("div", "field");
	const label = el("label", "", labelText);
	if (LABELABLE.has(control.tagName)) {
		// 标签只画在眼前却没指到控件上，读屏的人听到的是一串没头没尾的字。
		if (!control.id) control.id = `settings-fld-${++fieldSeq}`;
		label.htmlFor = control.id;
	}
	wrap.append(label);
	wrap.append(control);
	// 提示既可以是短句，也可以是 hintLine() 造好的节点（带 title 的那种）。
	if (hint) wrap.append(typeof hint === "string" ? el("div", "hint", hint) : hint);
	return wrap;
}

/** 模型卡片里的字段：沿用 .field 的排版，再加一个网格类。 */
function modelField(labelText, control, hint) {
	const wrap = field(labelText, control, hint);
	wrap.classList.add("model-field");
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
				: provider.modelsSource === "upstream"
					? `上游实时清单（${status?.modelCount ?? 0} 个）：模型参数可以自行修改` +
						(provider.modelsFetchedAt ? ` · ${new Date(provider.modelsFetchedAt).toLocaleString("zh-CN")} 拉取` : "") +
						` · 接入点：${status?.baseUrl ?? "未配置"}`
					: `内置供应商（当前 ${status?.modelCount ?? 0} 个模型）：接入点由应用维护，模型参数可以自行修改。` +
						`环境变量：${(status?.envVars ?? []).join("、") || "无"}` +
						(status?.baseUrl ? ` · 接入点：${status.baseUrl}` : ""),
		),
	);

	if (status?.error) box.append(el("div", "notice err", status.error));

	const keyInput = document.createElement("input");
	keyInput.type = "password";
	keyInput.autocomplete = "off";
	keyInput.placeholder =
		status?.authSource === "app" ? `已保存 ${status.maskedKey}，留空则不修改` : "粘贴 API Key，覆盖环境变量";
	const reveal = document.createElement("button");
	reveal.type = "button";
	reveal.className = "btn btn-quiet btn-sm";
	reveal.textContent = "显示";
	reveal.setAttribute("aria-label", "显示 API Key");
	reveal.setAttribute("aria-pressed", "false");
	reveal.addEventListener("click", () => {
		const visible = keyInput.type === "text";
		keyInput.type = visible ? "password" : "text";
		reveal.textContent = visible ? "显示" : "隐藏";
		reveal.setAttribute("aria-pressed", String(!visible));
		reveal.setAttribute("aria-label", `${visible ? "显示" : "隐藏"} API Key`);
	});
	const keyRow = el("div", "key-input-row");
	keyRow.append(keyInput, reveal);
	box.append(
		field(
			"API Key",
			keyRow,
			status?.authSource === "env" ? `当前来自环境变量 ${status.envVars[0]}` : keyStorageFull(),
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

	// 与自定义厂商相同：用接入点 + 已保存的 Key 真去请求 /models。
	const pull = el("button", "btn btn-sm", "从上游拉取模型");
	pull.addEventListener("click", () => pullModels(provider.id, box));
	actions.append(pull);
	if (provider.modelsSource === "upstream") {
		const restore = el("button", "btn btn-ghost btn-sm", "恢复内置目录");
		restore.title = "清掉从上游拉来的清单与所有参数改动，回到应用内置的模型目录";
		restore.addEventListener("click", async () => {
			await operation("正在恢复内置目录…", async () => {
				await api(`/api/providers/${provider.id}/models/catalog`, { method: "POST" });
				await refresh();
				notifyChanged();
			});
		});
		actions.append(restore);
	}

	if (status?.authSource === "app") {
		const clear = el("button", "btn btn-ghost btn-sm", "清除已保存的 Key");
		clear.addEventListener("click", async () => {
			await operation("正在清除密钥…", async () => {
				await api(`/api/providers/${provider.id}/key`, { method: "DELETE" });
				await refresh();
				notifyChanged();
			});
		});
		actions.append(clear);
	}
	actions.append(el("span", "spacer"));
	actions.append(toggleButton(provider));
	box.append(actions);

	// 内置供应商的模型同样可以改：上下文、输出上限、思考档位、成本，以及增删。
	// 改动以「同 id 参数覆盖」的形式存在设置里，内置目录本身不动；
	// 点「恢复内置目录」会把覆盖清掉，回到出厂清单。
	renderModelZone(box, provider, true, { pickable: false, backfill: false });

	const addRow = el("div", "actions");
	const add = el("button", "btn btn-sm", "+ 手动添加模型");
	add.addEventListener("click", () => {
		const name = prompt("模型 id（发送给服务端的 model 字段）");
		if (!name?.trim()) return;
		const defaults = defaultLimits();
		void saveModel(provider.id, {
			id: name.trim(),
			name: name.trim(),
			contextWindow: defaults.contextWindow,
			maxTokens: defaults.maxTokens,
			reasoning: false,
			thinkingLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
	addRow.append(add);
	box.append(addRow);
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
	box.append(row);

	// Base URL 比别的字段宽一档：完整地址本来就长，压到 520 会天天折行。
	const baseField = field("Base URL", baseUrl, "填到版本路径即可，服务端会补 /models");
	baseField.classList.add("field--wide");
	box.append(baseField, hintBox);

	const keyInput = document.createElement("input");
	keyInput.type = "password";
	keyInput.autocomplete = "off";
	keyInput.placeholder = status?.authSource === "app" ? `已保存 ${status.maskedKey}，留空则不修改` : "粘贴 API Key";
	const revealKey = el("button", "btn btn-quiet btn-sm", "显示");
	revealKey.type = "button";
	revealKey.setAttribute("aria-label", "显示 API Key");
	revealKey.setAttribute("aria-pressed", "false");
	revealKey.addEventListener("click", () => {
		const visible = keyInput.type === "text";
		keyInput.type = visible ? "password" : "text";
		revealKey.textContent = visible ? "显示" : "隐藏";
		revealKey.setAttribute("aria-pressed", String(!visible));
		revealKey.setAttribute("aria-label", `${visible ? "显示" : "隐藏"} API Key`);
	});
	const keyRow = el("div", "key-input-row");
	keyRow.append(keyInput, revealKey);
	box.append(
		field(
			"API Key",
			keyRow,
			hintLine(
				`${keyStorageShort()}；勾选下方开关后可留空`,
				`${keyStorageFull()}勾选「该服务不需要鉴权」后，此字段可留空。`,
			),
		),
	);

	const noAuth = document.createElement("input");
	noAuth.type = "checkbox";
	noAuth.checked = provider.noAuthRequired === true;
	const noAuthLabel = el("label", "switch");
	noAuthLabel.append(noAuth, document.createTextNode("该服务不需要鉴权（本地 / 自建）"));
	box.append(noAuthLabel);
	box.append(
		hintLine(
			"开启后缺 Key 也算已配置；遇 401 就关掉",
			"开启后不会因缺少 Key 而判定为未配置。部分服务会忽略 Authorization 头，部分会直接拒绝，遇到 401 可关掉此开关。",
		),
	);

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
		view.picked.clear();
		await refresh();
		notifyChanged();
	});
	actions.append(remove);
	box.append(actions);

	renderModelZone(box, provider, true);

	const addRow = el("div", "actions");
	const add = el("button", "btn btn-sm", "+ 手动添加模型");
	add.addEventListener("click", () => {
		const name = prompt("模型 id（发送给服务端的 model 字段）");
		if (!name?.trim()) return;
		// 默认值由服务端下发，不在前端硬编码
		const defaults = defaultLimits();
		void saveModel(provider.id, {
			id: name.trim(),
			name: name.trim(),
			contextWindow: defaults.contextWindow,
			maxTokens: defaults.maxTokens,
			reasoning: false,
			thinkingLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
	addRow.append(add);
	box.append(addRow);
}

// ---------------------------------------------------------------- 模型区

/**
 * 模型区的条目。
 *
 * 自定义供应商以配置为准（配置里就有上下文、上限、档位与成本）；
 * 内置供应商的清单由 pi-ai 维护，从 /api/models 里取，只读展示。
 */
function modelEntries(provider) {
	const limits = defaultLimits();
	if (provider.kind === "custom") {
		return (provider.models ?? []).map((config) => {
			const summary = view.models.find((m) => m.provider === provider.id && m.modelId === config.id) ?? null;
			const reason = unavailableReason(provider, Boolean(summary));
			return {
				key: `${provider.id}/${config.id}`,
				modelId: config.id,
				name: config.name || config.id,
				contextWindow: config.contextWindow,
				maxTokens: config.maxTokens,
				reasoning: config.reasoning === true,
				thinkingLevels: Array.isArray(config.thinkingLevels) ? [...config.thinkingLevels] : ["off"],
				cost: costOf(config, summary),
				placeholder: isPlaceholder(config, summary),
				contextPlaceholder: config.contextWindow === limits.contextWindow,
				maxPlaceholder: config.maxTokens === limits.maxTokens,
				available: !reason,
				reason,
				config,
				summary,
			};
		});
	}
	const summaries = view.models.filter((model) => model.provider === provider.id);
	const entries = summaries.map((model) => {
		const reason = unavailableReason(provider);
		const saved = (provider.models ?? []).find((config) => config.id === model.modelId) ?? null;
		// 没存过参数的目录模型也得能改：按运行时值补一条完整配置。
		// 只提交一个字段会被后端当成「其余字段用默认值」，成本和思考档位就丢了。
		const config = saved ?? {
			id: model.modelId,
			name: model.name || model.modelId,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning === true,
			thinkingLevels: Array.isArray(model.thinkingLevels) ? [...model.thinkingLevels] : ["off"],
			cost: costOf(null, model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		return {
			key: model.id,
			modelId: model.modelId,
			name: model.name || model.modelId,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning === true,
			thinkingLevels: Array.isArray(model.thinkingLevels) ? [...model.thinkingLevels] : ["off"],
			cost: costOf(saved, model),
			placeholder: isPlaceholder(model, model),
			contextPlaceholder: model.contextWindow === limits.contextWindow,
			maxPlaceholder: model.maxTokens === limits.maxTokens,
			available: !reason,
			reason,
			config,
			summary: model,
		};
	});

	// 手动添加、但运行时还没登记出来的模型也要露面，否则用户会以为没保存成功。
	for (const config of provider.models ?? []) {
		if (config.hidden) continue;
		if (summaries.some((model) => model.modelId === config.id)) continue;
		const reason = unavailableReason(provider, false);
		entries.push({
			key: `${provider.id}/${config.id}`,
			modelId: config.id,
			name: config.name || config.id,
			contextWindow: config.contextWindow,
			maxTokens: config.maxTokens,
			reasoning: config.reasoning === true,
			thinkingLevels: Array.isArray(config.thinkingLevels) ? [...config.thinkingLevels] : ["off"],
			cost: costOf(config, null),
			placeholder: isPlaceholder(config, null),
			contextPlaceholder: config.contextWindow === limits.contextWindow,
			maxPlaceholder: config.maxTokens === limits.maxTokens,
			available: !reason,
			reason,
			config,
			summary: null,
		});
	}
	return entries;
}

/**
 * 是不是「待核对」。
 *
 * 后端给了 placeholder 就以它为准；没给就自己按占位默认值比 ——
 * 老后端也得能看，不能因为少个字段就整页报错。
 */
function isPlaceholder(model, summary) {
	if (summary && typeof summary.placeholder === "boolean") return summary.placeholder;
	const limits = defaultLimits();
	return model?.contextWindow === limits.contextWindow || model?.maxTokens === limits.maxTokens;
}

/**
 * 供应商详情里的模型区：检索 + 统计 + 批量 + 卡片行。
 *
 * editable = false 时只读展示。
 * 内置供应商可编辑参数，但不给全选/批量（内置模型未必都在设置里存过条目，
 * 批量接口只认已存的条目，静默漏掉一半会更糟）；回填同理，它做的事和
 * 「从上游拉取模型」重叠，放在这一区容易误点成整表替换。
 */
function renderModelZone(box, provider, editable, options = {}) {
	const pickable = editable && options.pickable !== false;
	const withBackfill = editable && options.backfill !== false;
	const entries = modelEntries(provider);
	const zone = el("div", "model-zone");
	zone.id = "model-zone";

	const head = el("div", "model-zone-head");
	head.append(el("h5", "detail-h", editable ? `模型配置（${entries.length}）` : `可用模型（${entries.length}）`));

	const searchWrap = el("div", "model-search-wrap");
	const search = document.createElement("input");
	search.type = "search";
	search.id = "model-search";
	search.className = "model-search";
	search.placeholder = "搜模型：id 或名称";
	search.autocomplete = "off";
	search.setAttribute("aria-label", "搜索模型");
	search.value = view.modelQuery;
	// 只重画列表，输入框本身不动 —— 否则每敲一个字焦点就没了。
	search.addEventListener("input", (event) => {
		view.modelQuery = event.target.value;
		renderModelList();
	});
	searchWrap.append(search);
	head.append(searchWrap);

	const stats = el("div", "model-stats");
	stats.id = "model-stats";
	head.append(stats);

	// 「按上游回填」放进表头而不是另起一行：它改的就是这些数字本身。
	if (withBackfill) {
		const backfill = el("button", "btn btn-sm", "按上游回填");
		backfill.id = "model-backfill";
		backfill.title = "从上游拉取模型并回填上下文与输出上限";
		backfill.setAttribute("aria-label", "从上游拉取模型并回填上下文与输出上限");
		backfill.addEventListener("click", () => void backfillFromUpstream(provider));
		head.append(backfill);
	}
	zone.append(head);

	// 「待核对」是什么意思，得说清楚：不然用户看到虚线框不知道该动还是不该动。
	// 但整段说明不该一直杵在模型列表上方 —— 折起来，标题里只留"有几处待核对"。
	const pendingCount = entries.filter((entry) => entry.placeholder).length;
	if (editable && pendingCount > 0) {
		const limits = defaultLimits();
		zone.append(
			foldBox(
				`${pendingCount} 个模型的上下文 / 输出上限还是占位值（点开看说明）`,
				`带 ${formatTokens(limits.contextWindow)} / ${formatTokens(limits.maxTokens)} 的是默认占位值，不是探测结果。`,
				"上游接口报了限制就用上游的（点「按上游回填」）；报不出来（OpenAI 兼容的 /models 只回 id）的模型需要你按实际规格核对，" +
					"否则超长的输入会被上游直接拒绝。",
			),
		);
	}

	const toolbar = el("div", "model-toolbar");
	toolbar.id = "model-toolbar";
	const ctx = { provider, entries, editable, pickable, allBox: null, countEl: null, shown: entries, stats };
	view.modelContext = ctx;

	if (pickable) {
		const pickAll = el("label", "model-pick-all");
		const allBox = document.createElement("input");
		allBox.type = "checkbox";
		allBox.id = "model-select-all";
		allBox.setAttribute("aria-label", "全选当前列出的模型");
		allBox.addEventListener("change", () => setAllPicked(allBox.checked));
		pickAll.append(allBox, document.createTextNode("全选"));
		toolbar.append(pickAll);
		ctx.allBox = allBox;

		const count = el("span", "model-selected-count");
		count.id = "model-selected-count";
		count.setAttribute("aria-live", "polite");
		toolbar.append(count);
		ctx.countEl = count;

		const batch = el("button", "btn btn-sm", "批量设置…");
		batch.id = "model-batch-open";
		batch.addEventListener("click", () => {
			view.batchOpen = !view.batchOpen;
			renderDetail();
		});
		toolbar.append(batch);
	}
	zone.append(toolbar);

	const panelHost = el("div", "model-batch-host");
	panelHost.id = "model-batch-host";
	zone.append(panelHost);

	const list = el("div", "model-list");
	list.id = "model-list";
	zone.append(list);

	box.append(zone);
	ctx.list = list;
	ctx.panelHost = panelHost;

	renderBatchPanel(ctx);
	renderModelList();
	updatePickUi();
}

/** 只重画模型列表：搜索时用，输入框与工具条都不动。 */
function renderModelList() {
	const ctx = view.modelContext;
	if (!ctx || !ctx.list) return;
	const list = ctx.list;
	list.replaceChildren();
	const query = view.modelQuery.trim().toLowerCase();
	const shown = ctx.entries.filter(
		(entry) =>
			!query ||
			entry.modelId.toLowerCase().includes(query) ||
			entry.name.toLowerCase().includes(query),
	);
	if (shown.length === 0) {
		list.append(
			el(
				"div",
				"empty-hint",
				query
					? "没有匹配的模型。"
					: ctx.provider.kind === "builtin"
						? "还没有模型。点「从上游拉取模型」，或用下方「＋ 手动添加模型」。"
						: ctx.editable
							? "还没有模型。填好 Base URL 与 Key 后点「拉取模型」，或用下方「＋ 手动添加模型」。"
							: statusOf(ctx.provider.id)?.authSource === "none"
								? "保存 API Key 后，即可列出内置模型。"
								: "该供应商当前没有可用模型。",
			),
		);
	} else {
		for (const entry of shown) list.append(modelCard(ctx.provider, entry, ctx.editable, ctx.pickable));
	}
	ctx.shown = shown;
	updateModelStats();
	updatePickUi();
}

function updateModelStats() {
	const ctx = view.modelContext;
	if (!ctx || !ctx.stats) return;
	const total = ctx.entries.length;
	const pending = ctx.entries.filter((entry) => entry.placeholder).length;
	const unavailable = ctx.entries.filter((entry) => !entry.available).length;
	const shown = ctx.shown?.length ?? total;
	const bits = [`共 ${total} 个模型`];
	if (shown !== total) bits.push(`显示 ${shown} 个`);
	bits.push(`待核对 ${pending} 个`);
	if (unavailable) bits.push(`不可用 ${unavailable} 个`);
	ctx.stats.textContent = bits.join(" · ");
}

function updatePickUi() {
	const ctx = view.modelContext;
	if (!ctx || !ctx.allBox) return;
	const shown = ctx.shown ?? ctx.entries;
	const picked = shown.filter((entry) => view.picked.has(entry.key)).length;
	ctx.allBox.checked = shown.length > 0 && picked === shown.length;
	ctx.allBox.indeterminate = picked > 0 && picked < shown.length;
	if (ctx.countEl) ctx.countEl.textContent = `已选 ${view.picked.size} 个`;
	// 勾中的卡片描一道朱边，批量改谁就看得见了。
	if (ctx.list) {
		for (const card of ctx.list.querySelectorAll(".model-card")) {
			card.classList.toggle("is-picked", view.picked.has(card.dataset.modelKey));
		}
	}
}

function togglePick(key, on) {
	if (on) view.picked.add(key);
	else view.picked.delete(key);
	updatePickUi();
}

function setAllPicked(on) {
	const ctx = view.modelContext;
	const shown = ctx?.shown ?? [];
	for (const entry of shown) {
		if (on) view.picked.add(entry.key);
		else view.picked.delete(entry.key);
	}
	updatePickUi();
}

/** 一个模型的卡片行。 */
function modelCard(provider, entry, editable, pickable) {
	const card = el("div", "model-card" + (entry.key === view.data.defaultModel ? " is-default" : ""));
	card.dataset.modelKey = entry.key;

	const head = el("div", "model-card-head");
	if (pickable) {
		const wrap = el("label", "model-pick");
		const check = document.createElement("input");
		check.type = "checkbox";
		check.className = "model-check";
		check.checked = view.picked.has(entry.key);
		check.setAttribute("aria-label", `选择模型 ${entry.name}`);
		check.addEventListener("change", () => togglePick(entry.key, check.checked));
		wrap.append(check);
		head.append(wrap);
	}
	const title = el("div", "model-card-title");
	title.append(el("span", "model-name", entry.name));
	title.append(el("code", "model-id", entry.modelId));
	head.append(title);
	if (entry.placeholder) head.append(el("span", "model-badge is-warn", "待核对"));
	if (entry.key === view.data.defaultModel) head.append(el("span", "model-badge is-ok", "默认"));
	if (!entry.available) head.append(el("span", "model-badge is-off", entry.reason));
	card.append(head);
	const summary = el("div", "model-card-summary");
	summary.append(el("span", "", `${formatTokens(entry.contextWindow)} 上下文`), el("span", "", `${formatTokens(entry.maxTokens)} 输出`), el("span", "", entry.reasoning ? "支持思考" : "标准生成"));
	card.append(summary);

	const body = el("div", "model-card-body");

	// 模型 id
	if (editable) {
		const idInput = document.createElement("input");
		idInput.type = "text";
		idInput.className = "model-id-input";
		idInput.value = entry.modelId;
		idInput.setAttribute("aria-label", `模型 id：${entry.name}`);
		idInput.addEventListener("change", () => {
			const next = idInput.value.trim();
			if (!next || next === entry.modelId) {
				idInput.value = entry.modelId;
				return;
			}
			void renameModel(provider, entry.modelId, next);
		});
		body.append(modelField("模型 id", idInput));
	} else {
		body.append(modelField("模型 id", el("div", "model-value", entry.modelId)));
	}

	// 输入上下文
	body.append(
		modelField(
			"输入上下文",
			editable ? contextInput(provider, entry) : el("div", "model-value", formatTokens(entry.contextWindow)),
			editable && entry.placeholder ? "占位值，需人工核对" : null,
		),
	);

	// 输出上限
	body.append(
		modelField(
			"输出上限",
			editable ? maxInput(provider, entry) : el("div", "model-value", formatTokens(entry.maxTokens)),
			editable && entry.placeholder ? "占位值，需人工核对" : null,
		),
	);

	// 思考
	const thinkField = el("div", "model-field model-field-wide");
	const thinkLabel = el("label", "", "思考");
	thinkField.append(thinkLabel);
	if (editable) {
		const line = el("div", "model-think-line");
		const reason = document.createElement("input");
		reason.type = "checkbox";
		reason.className = "model-reason";
		reason.id = `settings-reason-${++reasonSeq}`;
		reason.checked = entry.reasoning;
		reason.setAttribute("aria-label", `是否支持思考：${entry.name}`);
		thinkLabel.htmlFor = reason.id;
		reason.addEventListener("change", () => {
			const on = reason.checked;
			// 打开思考却一个档位都没选，就当「全都支持」：这比让模型停在
			// 一个半吊子状态更贴近多数厂商的实际情况。
			const levels = on
				? entry.thinkingLevels.filter((level) => level !== "off").length
					? entry.thinkingLevels.filter((level) => level !== "off")
					: THINKING_CHIPS.map(([value]) => value)
				: ["off"];
			void saveModel(provider.id, { ...entry.config, reasoning: on, thinkingLevels: levels });
		});
		const reasonLabel = el("label", "model-reason-label");
		reasonLabel.append(reason, document.createTextNode("支持思考"));
		line.append(reasonLabel);
		line.append(levelChips(provider, entry));
		thinkField.append(line);
	} else {
		const levels = entry.thinkingLevels.filter((level) => level !== "off");
		thinkField.append(
			el("div", "model-value", entry.reasoning ? (levels.length ? levels.map(levelLabel).join(" / ") : "可深思") : "不支持"),
		);
	}
	body.append(thinkField);

	// 成本
	if (entry.cost) {
		const costField = el("div", "model-field");
		const costLabel = el("span", "model-field-label");
		costLabel.append(document.createTextNode("成本"));
		// 单位独立成小字：数字是数字，口径是口径，混在一行里读起来要停一下。
		costLabel.append(el("span", "model-unit", "元 / 百万 token"));
		costField.append(costLabel);
		if (editable) {
			const row = el("div", "model-cost-row");
			row.append(costInput(provider, entry, "input", "输入"));
			row.append(costInput(provider, entry, "output", "输出"));
			costField.append(row);
		} else {
			costField.append(el("div", "model-value", `输入 ${entry.cost.input} · 输出 ${entry.cost.output}`));
		}
		body.append(costField);
	}

	const details = el("details", "model-card-details");
	details.append(el("summary", "", "参数与思考设置"));
	details.append(body);
	card.append(details);

	const actions = el("div", "model-card-actions");
	const pick = el("button", "btn btn-sm", entry.key === view.data.defaultModel ? "当前默认" : "设为默认");
	pick.disabled = entry.key === view.data.defaultModel;
	pick.addEventListener("click", () => void saveDefaultsFor(entry.key));
	actions.append(pick);
	if (editable) {
		const del = el("button", "btn btn-ghost btn-sm", "删");
		del.setAttribute("aria-label", `删除模型 ${entry.name}`);
		del.addEventListener("click", () => void deleteModel(provider.id, entry.modelId));
		actions.append(del);
	}
	card.append(actions);
	return card;
}

function contextInput(provider, entry) {
	const input = numberInput(entry.contextWindow, (value) => void saveModel(provider.id, { ...entry.config, contextWindow: value }), `输入上下文：${entry.name}`);
	input.className = "model-num";
	if (entry.contextPlaceholder) input.classList.add("is-placeholder");
	return input;
}

function maxInput(provider, entry) {
	const input = numberInput(entry.maxTokens, (value) => void saveModel(provider.id, { ...entry.config, maxTokens: value }), `输出上限：${entry.name}`);
	input.className = "model-num";
	if (entry.maxPlaceholder) input.classList.add("is-placeholder");
	return input;
}

function costInput(provider, entry, key, label) {
	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.step = "0.01";
	input.className = "model-num model-cost-num";
	input.value = String(entry.cost[key] ?? 0);
	input.setAttribute("aria-label", `${label}价（每百万 token）：${entry.name}`);
	input.addEventListener("change", () => {
		const value = Math.max(0, Number(input.value) || 0);
		void saveModel(provider.id, { ...entry.config, cost: { ...entry.cost, [key]: value } });
	});
	return input;
}

/**
 * 思考档位的 chip 组。
 *
 * 关闭思考时档位固定为「不思(off)」，chip 全部禁用；
 * 打开后 chip 可勾，取消到空会自动回到「全选」——不会出现「支持思考但一个档位都没有」的半截状态。
 */
function levelChips(provider, entry) {
	const wrap = el("div", "level-chips");
	wrap.setAttribute("role", "group");
	wrap.setAttribute("aria-label", `思考档位：${entry.name}`);

	if (!entry.reasoning) {
		const locked = el("span", "level-chip is-locked is-on");
		locked.dataset.level = "off";
		locked.append(el("span", "level-text", "不思"), el("span", "level-code", "off"));
		wrap.append(locked);
	}

	for (const [value, label] of THINKING_CHIPS) {
		const chip = el("label", "level-chip" + (entry.reasoning && entry.thinkingLevels.includes(value) ? " is-on" : ""));
		// data-level 只给 CSS 认：七块竹签要按「微 → 尽」排出一道由浅入深的墨色。
		chip.dataset.level = value;
		const box = document.createElement("input");
		box.type = "checkbox";
		box.value = value;
		box.checked = entry.reasoning && entry.thinkingLevels.includes(value);
		box.disabled = !entry.reasoning;
		box.setAttribute("aria-label", `${label}（${value}）`);
		box.addEventListener("change", () => {
			// 先改脸再去问后端：等一个来回才变色，手会以为没点中。
			chip.classList.toggle("is-on", box.checked);
			const next = new Set(entry.thinkingLevels.filter((level) => level !== "off"));
			if (box.checked) next.add(value);
			else next.delete(value);
			const levels = next.size ? [...next] : THINKING_CHIPS.map(([v]) => v);
			void saveModel(provider.id, { ...entry.config, reasoning: true, thinkingLevels: levels });
		});
		chip.append(box, el("span", "level-text", label), el("span", "level-code", value));
		wrap.append(chip);
	}

	if (entry.reasoning) {
		const chosen = entry.thinkingLevels.filter((level) => level !== "off").length;
		wrap.append(el("span", "level-note", `已选 ${chosen} 档`));
	}
	return wrap;
}

// ---------------------------------------------------------------- 批量

/** 批量设置小表单。收起时不占地方，展开后只多出一小块。 */
function renderBatchPanel(ctx) {
	const host = ctx.panelHost;
	if (!host) return;
	host.replaceChildren();
	// 内置供应商不给批量：批量接口只认设置里存过的条目，
	// 内置模型大多还没存过，勾选面板会漏人。
	if (!ctx.pickable || !view.batchOpen) return;

	const panel = el("div", "model-batch-panel");
	panel.id = "model-batch-panel";
	panel.setAttribute("role", "group");
	panel.setAttribute("aria-label", "批量设置模型参数");
	panel.append(el("div", "batch-title", "批量设置：填好数值，再选一个去处"));

	// 表单与按钮分开两层：手机上档位一多，按钮不该被推出纸面之外 ——
	// 只有表单那层滚，去处始终钉在浮层底部。
	const sheetBody = el("div", "batch-body");
	const form = el("div", "model-batch-form");

	const ctxInput = document.createElement("input");
	ctxInput.type = "number";
	ctxInput.min = "1";
	ctxInput.step = "1000";
	ctxInput.placeholder = "留空 = 不改";
	ctxInput.className = "model-num";
	ctxInput.setAttribute("aria-label", "批量输入上下文");
	form.append(modelField("输入上下文", ctxInput));

	const maxInputBox = document.createElement("input");
	maxInputBox.type = "number";
	maxInputBox.min = "1";
	maxInputBox.step = "1000";
	maxInputBox.placeholder = "留空 = 不改";
	maxInputBox.className = "model-num";
	maxInputBox.setAttribute("aria-label", "批量输出上限");
	form.append(modelField("输出上限", maxInputBox));

	const reasonSelect = document.createElement("select");
	for (const [value, label] of [
		["", "不改"],
		["on", "开启"],
		["off", "关闭"],
	]) {
		const option = el("option", "", label);
		option.value = value;
		reasonSelect.append(option);
	}
	reasonSelect.setAttribute("aria-label", "批量设置思考能力");
	form.append(modelField("思考能力", reasonSelect));

	const levelField = el("div", "model-field model-field-wide");
	const levelLabel = el("label", "", "思考档位");
	levelField.append(levelLabel);
	const chips = el("div", "level-chips");
	chips.id = `settings-batch-levels-${++reasonSeq}`;
	chips.setAttribute("role", "group");
	levelLabel.htmlFor = chips.id;
	const chosen = new Set();
	for (const [value, label] of THINKING_CHIPS) {
		const chip = el("label", "level-chip");
		chip.dataset.level = value;
		const box = document.createElement("input");
		box.type = "checkbox";
		box.value = value;
		box.setAttribute("aria-label", `${label}（${value}）`);
		box.addEventListener("change", () => {
			if (box.checked) chosen.add(value);
			else chosen.delete(value);
		});
		chip.append(box, el("span", "level-text", label), el("span", "level-code", value));
		chips.append(chip);
	}
	levelField.append(chips);
	levelField.append(el("div", "hint", "勾了档位就按「开启思考」处理；一个都不勾 = 思考能力保持原样。"));
	form.append(levelField);
	sheetBody.append(form);
	panel.append(sheetBody);

	const actions = el("div", "actions batch-actions");
	const readForm = () => ({
		contextWindow: Number(ctxInput.value) > 0 ? Math.floor(Number(ctxInput.value)) : 0,
		maxTokens: Number(maxInputBox.value) > 0 ? Math.floor(Number(maxInputBox.value)) : 0,
		reasoning: reasonSelect.value,
		levels: [...chosen],
	});

	const picked = [...view.picked];
	const applyPicked = el("button", "btn btn-primary btn-sm", `应用到选中（${picked.length}）`);
	applyPicked.disabled = picked.length === 0;
	applyPicked.addEventListener("click", () => void applyBatch(ctx.provider, picked, readForm()));
	actions.append(applyPicked);

	const pending = ctx.entries.filter((entry) => entry.placeholder).map((entry) => entry.key);
	const applyPending = el("button", "btn btn-sm", `应用到待核对（${pending.length}）`);
	applyPending.disabled = pending.length === 0;
	applyPending.addEventListener("click", () => void applyBatch(ctx.provider, pending, readForm()));
	actions.append(applyPending);

	const close = el("button", "btn btn-ghost btn-sm", "收起");
	close.addEventListener("click", () => {
		view.batchOpen = false;
		renderDetail();
	});
	actions.append(close);
	panel.append(actions);

	host.append(panel);
}

/**
 * 批量改一批模型。
 *
 * 走后端的批量接口：PATCH /api/providers/:id/models。
 * 后端还没上线这个接口时（404 / 405）退回逐个设置 —— 结果一样，只是慢一点。
 */
async function applyBatch(provider, keys, form) {
	const detail = $("settings-detail");
	if (!keys.length) {
		noticeBox(detail, "没有可应用的模型。", "err");
		return;
	}
	// 界面里用的键是「供应商/模型」（如 cttai/MiniMax-M3），
	// 后端批量接口认的是裸模型 id，所以这里要拆掉供应商前缀。
	const prefix = `${provider.id}/`;
	const ids = keys.map((key) => (key.startsWith(prefix) ? key.slice(prefix.length) : key));
	const body = {};
	if (form.contextWindow > 0) body.contextWindow = form.contextWindow;
	if (form.maxTokens > 0) body.maxTokens = form.maxTokens;
	if (form.levels.length) {
		body.reasoning = true;
		body.thinkingLevels = [...form.levels];
	} else if (form.reasoning === "on") {
		body.reasoning = true;
		body.thinkingLevels = THINKING_CHIPS.map(([value]) => value);
	} else if (form.reasoning === "off") {
		body.reasoning = false;
		body.thinkingLevels = ["off"];
	}
	if (Object.keys(body).length === 0) {
		noticeBox(detail, "没有填写要改的内容。", "err");
		return;
	}

	try {
		const result = await api(`/api/providers/${provider.id}/models`, { method: "PATCH", body: { ids, ...body } });
		const updated = Array.isArray(result?.updated) ? result.updated : ids;
		await refresh();
		notifyChanged();
		noticeBox(
			$("settings-detail"),
			updated.length ? `已更新 ${updated.length} 个模型。` : "没有模型被改动（填的值与原值相同）。",
			updated.length ? "ok" : "err",
		);
	} catch (error) {
		if (error.status !== 404 && error.status !== 405) {
			noticeBox(detail, `批量设置失败：${error.message}`, "err");
			return;
		}
		const done = await applyOneByOne(provider, ids, body);
		await refresh();
		notifyChanged();
		noticeBox(
			$("settings-detail"),
			done > 0
				? `后端批量接口尚未上线，已逐个设置 ${done} 个模型。`
				: `批量设置失败：${error.message}`,
			done > 0 ? "ok" : "err",
		);
	}
}

/** 批量接口不可用时的兜底：逐个走单模型接口。ids 是裸模型 id。 */
async function applyOneByOne(provider, ids, body) {
	const models = view.data.providers.find((p) => p.id === provider.id)?.models ?? [];
	let done = 0;
	for (const modelId of ids) {
		const current = models.find((m) => m.id === modelId);
		if (!current) continue;
		try {
			await api(`/api/providers/${provider.id}/models`, { method: "POST", body: { ...current, ...body } });
			done += 1;
		} catch {
			/* 单个失败不打断其余 */
		}
	}
	return done;
}

/**
 * 按上游回填：拉一次模型，让后端把上游报出的上限写回仍是占位值的那些模型。
 *
 * 后端没给 backfilled 字段时退回到普通提示，不假装回填成功。
 */
async function backfillFromUpstream(provider) {
	const detail = $("settings-detail");
	noticeBox(detail, "正在从上游拉取模型并回填上限…");
	try {
		const result = await api(`/api/providers/${provider.id}/models/fetch`, { method: "POST" });
		await refresh();
		notifyChanged();
		const backfilled = Array.isArray(result?.backfilled) ? result.backfilled : [];
		const message = backfilled.length
			? `已回填 ${backfilled.length} 个模型的上游上限。`
			: `拉取到 ${result?.fetched ?? 0} 个模型，新增 ${result?.added ?? 0} 个。上游没有报出可回填的限制，仍需人工核对。`;
		noticeBox($("settings-detail"), message, "ok");
	} catch (error) {
		noticeBox(detail, `回填失败：${error.message}`, "err");
	}
}

// ---------------------------------------------------------------- 辅助

function numberInput(value, onChange, ariaLabel) {
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.step = "1000";
	input.value = String(value);
	if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
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

function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	const digits = value >= 100 || index === 0 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[index]}`;
}

// ---------------------------------------------------------------- 操作

async function saveProvider(id, body) {
	await operation("正在保存供应商…", async () => {
		await api(`/api/providers/${id}`, { method: "PATCH", body });
		await refresh();
		notifyChanged();
	});
}

async function saveModel(providerId, model) {
	try {
		await operation("正在保存模型参数…", async () => {
			await api(`/api/providers/${providerId}/models`, { method: "POST", body: model });
			await refresh();
			notifyChanged();
		});
	} catch {
		// 错误由顶部状态条持续显示；当前值由 refresh 回读，避免失败后假装已保存。
	}
}

/** 改模型 id：先建新的，再删旧的；默认笔若指着旧 id，一并指到新 id。 */
async function renameModel(provider, oldId, newId) {
	try {
		const current = (view.data.providers.find((p) => p.id === provider.id)?.models ?? []).find((m) => m.id === oldId);
		if (!current) return;
		await api(`/api/providers/${provider.id}/models`, {
			method: "POST",
			body: { ...current, id: newId, name: current.name === oldId ? newId : current.name },
		});
		await api(`/api/providers/${provider.id}/models/${encodeURIComponent(oldId)}`, { method: "DELETE" });
		if (view.data.defaultModel === `${provider.id}/${oldId}`) {
			await api("/api/settings", { method: "PUT", body: { defaultModel: `${provider.id}/${newId}` } });
		}
		await refresh();
		notifyChanged();
	} catch (error) {
		noticeBox($("settings-detail"), `改名失败：${error.message}`, "err");
	}
}

async function deleteModel(providerId, modelId) {
	await api(`/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
	view.picked.delete(`${providerId}/${modelId}`);
	await refresh();
	notifyChanged();
}

async function saveDefaultsFor(modelId) {
	await api("/api/settings", { method: "PUT", body: { defaultModel: modelId } });
	await refresh();
	notifyChanged();
}

/**
 * 提示条。
 *
 * prepend 而不是 append：详情栏是滚动区，提示追加到最后就滚出视野了。
 * 点一下可以收起 —— 有些失败信息很长，挡着下面的模型表。
 */
function noticeBox(box, message, kind) {
	const existing = box.querySelector(".notice");
	if (existing) existing.remove();
	const node = el("div", "notice" + (kind ? " " + kind : ""), message);
	node.title = "点一下收起";
	node.addEventListener("click", () => node.remove());
	box.prepend(node);
	setTimeout(() => node.remove(), 12000);
}

async function pullModels(providerId, box) {
	noticeBox(box, "正在从上游拉取模型列表…");
	try {
		const result = await api(`/api/providers/${providerId}/models/fetch`, { method: "POST" });
		await refresh();
		notifyChanged();
		const detail = $("settings-detail");
		const backfilled = Array.isArray(result?.backfilled) ? result.backfilled.length : 0;
		const tail = backfilled > 0 ? `，回填了 ${backfilled} 个模型的上游上限` : "，已有配置保持不变";
		noticeBox(detail, `拉取到 ${result.fetched} 个模型，新增 ${result.added} 个${tail}。`, "ok");
	} catch (error) {
		noticeBox(box, `拉取失败：${error.message}`, "err");
	}
}

async function testConnection(providerId, box) {
	const config = view.data.providers.find((p) => p.id === providerId);
	if (!config) {
		noticeBox(box, "找不到这个供应商。", "err");
		return;
	}
	noticeBox(box, "正在测试连接…");

	let result;
	try {
		result = await api(`/api/providers/${providerId}/models/fetch`, { method: "POST" });
	} catch (error) {
		noticeBox($("settings-detail"), `连接失败：${error.message}`, "err");
		return;
	}

	// 先刷新再写提示：refresh 会重建整个详情栏，先写的提示会被冲掉 —— 之前就是这样"什么都不显示"的。
	await refresh();
	noticeBox($("settings-detail"), `连接正常，发现 ${result.fetched} 个模型。`, "ok");
}

/** 新增自定义供应商：正式表单，而不是两次 prompt。 */
function openAddProvider() {
	const dialog = $("provider-dialog");
	$("provider-form").reset();
	$("provider-form-error").textContent = "";
	const apiSelect = $("provider-form-api");
	apiSelect.value = "openai-completions";
	$("provider-form-hint").textContent = API_FORMAT_HINTS[apiSelect.value] ?? "";
	dialog.showModal();
	$("provider-form-label").focus();
}

export function bindProviderForm() {
	const dialog = $("provider-dialog");
	const form = $("provider-form");
	const error = $("provider-form-error");
	const apiSelect = $("provider-form-api");

	apiSelect.addEventListener("change", () => {
		$("provider-form-hint").textContent = API_FORMAT_HINTS[apiSelect.value] ?? "";
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		error.textContent = "";
		const data = new FormData(form);
		const label = String(data.get("label") ?? "").trim();
		const baseUrl = String(data.get("baseUrl") ?? "").trim();
		const apiKey = String(data.get("apiKey") ?? "").trim();
		const noAuth = data.get("noAuth") === "on";

		if (!label) return void (error.textContent = "请填写供应商名称");
		if (!baseUrl) return void (error.textContent = "请填写 Base URL");
		try {
			new URL(baseUrl);
		} catch {
			return void (error.textContent = "Base URL 不是合法地址");
		}
		if (!apiKey && !noAuth) return void (error.textContent = "请填写 API Key，或勾选「不需要鉴权」");

		const submit = form.querySelector("button[type=submit]");
		submit.disabled = true;
		try {
			const result = await api("/api/providers", {
				method: "POST",
				body: { label, baseUrl, api: apiSelect.value, apiKey: apiKey || undefined, noAuthRequired: noAuth },
			});
			view.selected = result.provider.id;
			view.query = "";
			// 刚录入的这一家是用户此刻唯一关心的事，窄屏直接翻到它的详情。
			view.pane = "detail";
			dialog.close();
			await refresh();
			notifyChanged();

			// 建完就顺手探一次，省得再点一次「拉取模型」
			const detail = $("settings-detail");
			if (apiKey || noAuth) {
				try {
					const pulled = await api("/api/providers/" + result.provider.id + "/models/fetch", { method: "POST" });
					await refresh();
					noticeBox(detail, "已连通，拉到 " + pulled.fetched + " 个模型，新增 " + pulled.added + " 个。请在下方确认输入上下文与输出上限。", "ok");
				} catch (err) {
					noticeBox(detail, "供应商已录入，但拉取模型失败：" + err.message, "err");
				}
			} else {
				noticeBox(detail, "供应商已录入。填上 API Key 后点「拉取模型」即可取回模型列表。");
			}
		} catch (err) {
			error.textContent = err.message;
		} finally {
			submit.disabled = false;
		}
	});
}

// ---------------------------------------------------------------- 联网资料

function renderWebSettings() {
	const host = $("settings-web-panel");
	const web = view.data.webSearch ?? { enabled: false, configured: false, maxResults: 5, includeContent: false };
	host.replaceChildren();
	const intro = el("div", "web-intro");
	const eyebrow = el("span", "settings-eyebrow", "DEEPSEEK SEARCH / FETCH");
	const title = el("h4", "", "让资料有据可查");
	intro.append(eyebrow, title, el("p", "", "设定官可以按需检索公开网页，提炼为素材并保留来源。执笔者仍只使用本章已装配的素材，不直接联网。"));
	const state = el("span", `web-state${web.enabled && web.configured ? " is-on" : ""}`, web.enabled ? (web.configured ? "已就绪" : "等待密钥") : "未开启");
	intro.append(state);
	host.append(intro);

	const enable = document.createElement("input");
	enable.type = "checkbox";
	enable.id = "web-search-enabled";
	enable.checked = web.enabled === true;
	const enableLabel = el("label", "web-enable");
	const copy = el("span", "", "");
	copy.append(el("strong", "", "允许设定官联网检索"), el("small", "", "仅在任务需要现实资料时调用，不会自动上传作品或素材全文。"));
	enableLabel.append(enable, copy);
	enable.addEventListener("change", () => void saveWebSettings({ enabled: enable.checked }));
	host.append(enableLabel);

	const connection = el("section", "web-section");
	connection.append(el("h5", "", "01 · 连接与密钥"), el("p", "settings-section-note", "使用 DeepSeek 官方 Search / Fetch API。可复用环境变量 DEEPSEEK_API_KEY，也可以在这里单独保存。"));
	const key = document.createElement("input");
	key.type = "password";
	key.id = "web-search-key";
	key.autocomplete = "off";
	key.placeholder = web.authSource === "app" ? "已保存密钥 · 留空保持不变" : web.authSource === "env" ? "正在使用环境变量 · 可覆盖" : "粘贴 DeepSeek API Key";
	const keyLine = el("div", "web-key-line");
	keyLine.append(key);
	const reveal = el("button", "btn btn-quiet btn-sm", "显示");
	reveal.type = "button";
	reveal.setAttribute("aria-label", "显示或隐藏联网 API Key");
	reveal.addEventListener("click", () => {
		key.type = key.type === "password" ? "text" : "password";
		reveal.textContent = key.type === "password" ? "显示" : "隐藏";
	});
	keyLine.append(reveal);
	connection.append(field("DeepSeek API Key", keyLine));
	const actions = el("div", "actions");
	const saveKey = el("button", "btn btn-primary btn-sm", "保存密钥");
	saveKey.addEventListener("click", () => {
		if (!key.value.trim()) return void saveStatus("请输入 API Key；留空表示不修改。", "err");
		void saveWebSettings({}, key.value.trim());
	});
	actions.append(saveKey);
	if (web.authSource === "app") {
		const clear = el("button", "btn btn-ghost btn-sm", "清除密钥");
		clear.addEventListener("click", () => void saveWebSettings({}, ""));
		actions.append(clear);
	}
	const test = el("button", "btn btn-sm", "测试联网检索");
	test.disabled = !(web.enabled && web.configured);
	test.title = test.disabled ? "请先保存 API Key 并开启联网检索。" : "";
	test.addEventListener("click", async () => {
		test.disabled = true;
		saveStatus("正在执行一次真实搜索…");
		try {
			const result = await api("/api/settings/web-search/test", { method: "POST" });
			saveStatus(result.message, "ok");
		} catch (error) { saveStatus(error.message, "err"); }
		finally { test.disabled = false; }
	});
	actions.append(test);
	connection.append(actions);
	host.append(connection);

	const limits = el("section", "web-section");
	limits.append(el("h5", "", "02 · 检索方式"), el("p", "settings-section-note", "控制单次调用的信息量，减少不必要的上下文与网页抓取。"));
	const count = document.createElement("select");
	count.id = "web-search-count";
	for (const n of [3, 5, 8, 10]) { const option = el("option", "", `${n} 条`); option.value = String(n); count.append(option); }
	count.value = String(web.maxResults ?? 5);
	count.addEventListener("change", () => void saveWebSettings({ maxResults: Number(count.value) }));
	limits.append(field("单次搜索结果", count, "摘要足够时无需抓取网页正文。"));
	const content = document.createElement("input");
	content.type = "checkbox";
	content.id = "web-search-content";
	content.checked = web.includeContent === true;
	const contentLabel = el("label", "switch web-content-switch");
	contentLabel.append(content, document.createTextNode("搜索时附网页正文摘录（摘要不足时再开启）"));
	content.addEventListener("change", () => void saveWebSettings({ includeContent: content.checked }));
	limits.append(contentLabel);
	host.append(limits);

	const billing = el("aside", "web-billing");
	billing.append(el("strong", "", "按次计费 · 默认关闭"), el("p", "", "Search 与 Fetch 是独立服务，不使用创作模型的 Key 权限推断。按官方当前价格，成功的搜索或网页抓取各为 5 元 / 1000 次；空结果与失败请求不计费。“测试联网检索”会发起真实搜索。"));
	const link = el("a", "", "查看 DeepSeek 官方接口与价格 ↗");
	link.href = "https://api-docs.deepseek.com/zh-cn/guides/search";
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	billing.append(link);
	host.append(billing);
}

async function saveWebSettings(patch, apiKey) {
	try {
		await operation("正在保存联网设置…", async () => {
			await api("/api/settings", { method: "PUT", body: { webSearch: patch, ...(apiKey !== undefined ? { webApiKey: apiKey } : {}) } });
			await refresh();
		});
	} catch {
		// 保存失败时控件已经先被用户改过；重新读一次服务端状态，避免开关看起来已开启。
		try { await refresh(); } catch { /* 顶部状态条已展示保存失败原因 */ }
	}
}

// ---------------------------------------------------------------- 绑定

/**
 * 默认模型区的搜索框与提示行。
 *
 * 这一块在 index.html 里只有一个 select，搜索与提示都是运行时挂上去的：
 * index.html 由别人在改，这里不碰它。
 */
function ensureDefaultsExtras() {
	const host = document.querySelector(".settings-defaults .defaults-fields");
	if (!host || $("settings-default-extra")) return;
	const extra = el("div", "default-extra");
	extra.id = "settings-default-extra";
	const hint = el("p", "default-hint");
	hint.id = "settings-default-hint";
	hint.setAttribute("role", "status");
	const cost = el("p", "default-cost");
	cost.id = "settings-default-cost";
	extra.append(hint, cost);
	host.append(extra);

	const details = document.createElement("details");
	details.className = "default-filter";
	const summary = el("summary", "", "按供应商或模型名筛选");
	const search = document.createElement("input");
	search.type = "search";
	search.id = "settings-default-search";
	search.className = "default-search-input";
	search.placeholder = "输入模型 id 或名称";
	search.autocomplete = "off";
	search.setAttribute("aria-label", "筛选默认模型");
	search.addEventListener("input", (event) => {
		view.defaultSearch = event.target.value;
		renderDefaults();
	});
	details.append(summary, search);
	host.append(details);
}

export function bindSettings() {
	$("open-settings").addEventListener("click", () => void openSettings());
	$("provider-form-cancel").addEventListener("click", () => $("provider-dialog").close());
	bindProviderForm();
	// 接口格式下拉在模块加载时填充一次
	for (const format of API_FORMATS) {
		const option = el("option", "", format.label);
		option.value = format.value;
		$("provider-form-api").append(option);
	}
	$("settings-close").addEventListener("click", () => $("settings-dialog").close());
	$("settings-dialog").addEventListener("close", () => {
		const target = view.returnFocus;
		view.returnFocus = null;
		if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
	});
	for (const name of ["models", "web"]) {
		$(`settings-tab-${name}`).addEventListener("click", () => setSection(name));
	}
	document.querySelector(".settings-nav").addEventListener("keydown", (event) => {
		if (event.isComposing || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const next = event.key === "Home" ? "models" : event.key === "End" ? "web" : view.section === "models" ? "web" : "models";
		setSection(next);
		$(`settings-tab-${next}`).focus();
	});
	$("settings-default-model").addEventListener("change", () => void saveDefaults().catch(() => {}));
	$("settings-default-thinking").addEventListener("change", () => void saveDefaults().catch(() => {}));
	// 搜索只重画列表，搜索框本身不动，焦点才留得住
	$("provider-search").addEventListener("input", (event) => {
		view.query = event.target.value.trim().toLowerCase();
		renderProviderList();
	});
	ensureDefaultsExtras();
}
