/**
 * 设置：笔、偏好、数据，还有「这是哪一版」。
 *
 * 模型中那一段是整块的重点——默认用哪支笔、笔从哪儿来、联网查不查，
 * 其余偏好只是让这张桌子更顺手。数据那一段管的是这台机器上的原稿。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, $$, el, icon, toast, openModal, confirmAction, timeAgo, num } from "./core.js";
import { openAccountPanel, openCloudConnect } from "../account.js";
import {
	DEFAULT_CLOUD_BASE,
	clearCloudConfig,
	cloudBase as readCloudBase,
	getCloudConfig as getStoredCloud,
	normalizeCloudBase,
} from "../cloud-client.js";

let mounted = false;
let panel = "model";
let view = null;
let loading = false;

const API_FORMATS = [
	["openai-completions", "OpenAI Chat Completions", "支持 /v1/chat/completions 的服务"],
	["openai-responses", "OpenAI Responses", "新一代 /v1/responses 协议"],
	["anthropic-messages", "Anthropic Messages", "原生 /v1/messages 协议"],
	["google-generative-ai", "Google Generative AI", "Gemini 原生协议"],
];

export function initSettings() {
	if (mounted) return;
	mounted = true;
	const dialog = $("#settings");
	for (const item of $$("#settings-nav-list .settings-nav-item")) {
		item.addEventListener("click", () => {
			panel = item.dataset.panel || "model";
			paintNav();
			void renderPanel();
		});
	}
	$("#settings-close")?.addEventListener("click", () => dialog?.close());
	dialog?.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
	});
	dialog?.addEventListener("close", () => {
		document.activeElement?.blur?.();
	});
	dialog?.addEventListener("show", () => void refreshSettings());
	renderModeLine();
	paintNav();
}

export async function refreshSettings() {
	if (loading) return;
	loading = true;
	renderModeLine();
	try {
		view = await api.getSettings();
		renderPanel();
	} catch (error) {
		const host = $("#settings-panel-model");
		if (host) host.replaceChildren(note(`设置没打开：${error.message || "接口不通"}`, "is-warn"));
	} finally {
		loading = false;
	}
}

function paintNav() {
	for (const item of $$("#settings-nav-list .settings-nav-item")) {
		item.classList.toggle("is-active", item.dataset.panel === panel);
	}
	for (const section of $$("#settings-panels .settings-panel")) {
		section.classList.toggle("is-active", section.dataset.panel === panel);
	}
}

function renderModeLine() {
	const line = $("#settings-mode-line");
	if (!line) return;
	const auth = window.__NOVEL_AUTH_STATE__ || {};
	if (window.__NOVEL_MULTIUSER__) {
		line.textContent = auth.user?.name ? `云端 · ${auth.user.name}` : "云端";
	} else if (window.__NOVEL_LOCAL_MODE__ || window.__DSH_LOCAL_MODE__) {
		line.textContent = "本地单机 · 稿子留在这台机器";
	} else {
		line.textContent = "本机服务";
	}
}

/* ---------------------------------------------------------------- 面板 */

async function renderPanel() {
	if (panel === "model") await renderModelPanel();
	if (panel === "prefs") renderPrefsPanel();
	if (panel === "server") renderServerPanel();
	if (panel === "data") await renderDataPanel();
	if (panel === "about") renderAboutPanel();
}

function section(title, ...children) {
	return el("section", { class: "set-section" }, el("h3", { class: "set-title", text: title }), ...children);
}

function note(text, kind = "") {
	return el("p", { class: `set-note${kind ? ` ${kind}` : ""}`, text });
}

function row(label, hint, ...control) {
	return el(
		"div",
		{ class: "set-row" },
		el("div", { class: "set-row-main" }, el("div", { class: "set-row-label", text: label }), hint ? el("div", { class: "set-row-hint", text: hint }) : null),
		el("div", { class: "set-row-control" }, ...control),
	);
}

function toggle(checked, onChange, label = "") {
	const btn = el("button", {
		class: "switch",
		type: "button",
		role: "switch",
		"aria-checked": checked ? "true" : "false",
		"aria-label": label,
		on: {
			click: () => {
				const next = btn.getAttribute("aria-checked") !== "true";
				btn.setAttribute("aria-checked", next ? "true" : "false");
				onChange(next);
			},
		},
	});
	return btn;
}

/* ---------------------------------------------------------------- 模型中 */

async function renderModelPanel() {
	const host = $("#settings-panel-model");
	if (!host) return;
	if (!view) {
		host.replaceChildren(note("正在读设置…"));
		return;
	}
	host.replaceChildren();

	const models = ctx.state.models?.length ? ctx.state.models : [];
	const modelSelect = el("select", { class: "set-select" });
	const groups = new Map();
	for (const model of models) {
		const key = model.providerLabel || model.provider || "其他";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(model);
	}
	for (const [label, entries] of groups) {
		const group = el("optgroup", { label });
		for (const model of entries) {
			group.append(
				el("option", {
					value: model.id,
					text: `${model.name || model.modelId}${model.placeholder ? "（待核对）" : ""}`,
					selected: model.id === (view.defaultModel || ctx.state.defaultModel) ? true : undefined,
				}),
			);
		}
		modelSelect.append(group);
	}
	if (!models.length) {
		modelSelect.append(el("option", { value: "", text: "还没有模型，先加一个供应商" }));
		modelSelect.disabled = true;
	}

	const thinkingSelect = el("select", { class: "set-select" });
	const paintThinking = () => {
		const chosen = modelSelect.value;
		const model = models.find((item) => item.id === chosen);
		const levels = model?.thinkingLevels?.length ? model.thinkingLevels : ["off"];
		thinkingSelect.replaceChildren();
		for (const level of levels) {
			thinkingSelect.append(el("option", { value: level, text: thinkingLabel(level), selected: level === view.defaultThinkingLevel ? true : undefined }));
		}
		thinkingSelect.disabled = levels.length <= 1 && levels[0] === "off";
	};
	paintThinking();
	modelSelect.addEventListener("change", paintThinking);

	const saveModel = el(
		"button",
		{
			class: "btn btn-primary btn-sm",
			type: "button",
			on: {
				click: async () => {
					try {
						view = await api.putSettings({ defaultModel: modelSelect.value, defaultThinkingLevel: thinkingSelect.value });
						ctx.state.defaultModel = view.defaultModel;
						ctx.state.defaultThinkingLevel = view.defaultThinkingLevel;
						toast("默认模型换好了。", "ok");
						await reloadModels();
						await renderModelPanel();
					} catch (error) {
						toast(error.message || "存不上。", "error");
					}
				},
			},
		},
		icon("check"),
		"就用它",
	);

	host.append(
		section(
			"默认执笔",
			row("哪支笔", "新建会话、一键起稿都用这一支", modelSelect),
			row("想多久", "思考档位越高越慢，也越贵", thinkingSelect),
			el("div", { class: "set-actions" }, saveModel, el("span", { class: "set-hint", text: `${models.length} 个模型可用` })),
		),
	);

	// 联网检索
	const web = view.webSearch || { enabled: false, maxResults: 5, includeContent: false };
	const webSwitch = toggle(Boolean(web.enabled), () => {}, "联网检索");
	const countInput = el("input", { class: "set-input", type: "number", min: "1", max: "10", value: String(web.maxResults || 5) });
	const contentSwitch = toggle(Boolean(web.includeContent), () => {}, "取回正文");
	const keyInput = el("input", { class: "set-input", type: "password", placeholder: web.configured ? "已存，留空就不动" : "DeepSeek API Key", autocomplete: "off" });
	const testOut = el("p", { class: "set-note" });
	const saveWeb = el(
		"button",
		{
			class: "btn btn-ghost btn-sm",
			type: "button",
			on: {
				click: async () => {
					try {
						view = await api.putSettings({
							webSearch: {
								enabled: webSwitch.getAttribute("aria-checked") === "true",
								maxResults: Math.min(10, Math.max(1, Number(countInput.value) || 5)),
								includeContent: contentSwitch.getAttribute("aria-checked") === "true",
							},
							webApiKey: keyInput.value.trim() || undefined,
						});
						keyInput.value = "";
						toast("检索设置存好了。", "ok");
						await renderModelPanel();
					} catch (error) {
						testOut.textContent = error.message || "存不上。";
						testOut.classList.add("is-warn");
					}
				},
			},
		},
		"存下",
	);
	const testWeb = el(
		"button",
		{
			class: "btn btn-quiet btn-sm",
			type: "button",
			on: {
				click: async () => {
					testOut.textContent = "查一下…";
					testOut.classList.remove("is-warn", "is-ok");
					try {
						const result = await api.testWebSearch();
						testOut.textContent = result.ok
							? `通了：${(result.results || []).length} 条结果${result.message ? ` · ${result.message}` : ""}`
							: result.message || "没通。";
						testOut.classList.add(result.ok ? "is-ok" : "is-warn");
					} catch (error) {
						testOut.textContent = error.message || "没通。";
						testOut.classList.add("is-warn");
					}
				},
			},
		},
		icon("globe"),
		"试一次",
	);

	host.append(
		section(
			"联网检索",
			row(
				"让设定官能查资料",
				web.authSource === "env" ? "用的是环境变量里的 DEEPSEEK_API_KEY" : web.configured ? "Key 已存" : "还没配 Key",
				webSwitch,
			),
			row("一次取几条", "1–10", countInput),
			row("把正文也取回来", "省一次往返，但更费上下文", contentSwitch),
			el("div", { class: "set-field-row" }, keyInput, saveWeb, testWeb),
			testOut,
		),
	);

	// 供应商
	const providers = el("div", { class: "provider-list" });
	const statuses = (view.statuses || []).slice().sort((a, b) => Number(b.enabled) - Number(a.enabled));
	for (const status of statuses) {
		providers.append(providerCard(status));
	}
	const addBtn = el(
		"button",
		{
			class: "btn btn-ghost btn-sm",
			type: "button",
			on: { click: () => openProviderEditor(null) },
		},
		icon("plus"),
		"接一个供应商",
	);
	host.append(section("笔从哪儿来", el("p", { class: "set-note", text: "内置厂商读环境变量里的 Key；自己接的服务可以随手填一个更快的中转。" }), providers, el("div", { class: "set-actions" }, addBtn)));
}

function thinkingLabel(level) {
	const map = { off: "不想（最快）", minimal: "略想", low: "少想一点", medium: "想一想", high: "多想一会儿", xhigh: "很用力想" };
	return map[level] || String(level);
}

function providerCard(status) {
	const head = el(
		"div",
		{ class: "provider-head" },
		el("div", { class: "provider-name" }, status.label || status.id, el("span", { class: `tag${status.enabled ? "" : " tag-line"}`, text: status.enabled ? "已启用" : "已停用" })),
		el(
			"div",
			{ class: "provider-meta" },
			status.baseUrl ? el("span", { class: "provider-url", text: status.baseUrl }) : null,
			status.maskedKey ? el("span", { class: "provider-key", text: status.maskedKey }) : null,
			status.envVars?.length ? el("span", { class: "provider-env", text: status.envVars.map((name) => `${name}`).join(" / ") }) : null,
		),
	);
	const actions = el("div", { class: "provider-actions" });
	actions.append(
		el(
			"button",
			{
				class: "btn btn-quiet btn-sm",
				type: "button",
				text: status.kind === "custom" ? "改 Key" : "填 Key",
				on: {
					click: () => openKeyEditor(status),
				},
			},
		),
	);
	if (status.kind === "custom") {
		actions.append(
			el(
				"button",
				{
					class: "btn btn-quiet btn-sm",
					type: "button",
					on: {
						click: async () => {
							try {
								const result = await api.fetchProviderModels(status.id);
								toast(`拉到 ${result?.models?.length || result?.added || 0} 个模型。`, "ok");
								await refreshSettings();
								await reloadModels();
							} catch (error) {
								toast(error.message || "拉不到模型。", "error");
							}
						},
					},
				},
				icon("refresh"),
				"拉模型",
			),
		);
		actions.append(
			el("button", {
				class: "btn btn-quiet btn-sm",
				type: "button",
				text: status.enabled ? "停用" : "启用",
				on: {
					click: async () => {
						try {
							await api.patchProvider(status.id, { enabled: !status.enabled });
							await refreshSettings();
							await reloadModels();
						} catch (error) {
							toast(error.message || "改不了。", "error");
						}
					},
				},
			}),
		);
	}
	actions.append(
		el("button", {
			class: "btn btn-quiet btn-sm btn-danger",
			type: "button",
			title: "删掉这个供应商",
			on: {
				click: async () => {
					const yes = await confirmAction({
						title: `删掉「${status.label || status.id}」？`,
						message: "它下面登记过的模型会一起消失。已经写好的稿子不受影响。",
						confirmLabel: "删掉",
						danger: true,
					});
					if (!yes) return;
					try {
						await api.deleteProvider(status.id);
						toast("删了。");
						await refreshSettings();
						await reloadModels();
					} catch (error) {
						toast(error.message || "删不掉。", "error");
					}
				},
			},
		}, icon("trash")),
	);

	const card = el("div", { class: "provider-card" }, head, actions);
	const meta = [];
	if (status.modelCount) meta.push(`${status.configuredModelCount || 0}/${status.modelCount} 个模型可信`);
	if (status.error) meta.push(status.error);
	if (!status.apiFormatKnown) meta.push("接入协议没登记");
	if (meta.length) card.append(el("p", { class: `set-note${status.error ? " is-warn" : ""}`, text: meta.join(" · ") }));
	return card;
}

function openKeyEditor(status) {
	const input = el("input", { class: "set-input", type: "password", placeholder: status.maskedKey ? "已存，留空就不动" : "粘贴 Key", autocomplete: "off" });
	const noauth = toggle(Boolean(status.noAuthRequired), () => {}, "不需要 Key");
	const body = el(
		"div",
		{ class: "form-grid" },
		el("p", { class: "set-note field-wide", text: `${status.label || status.id}${status.baseUrl ? ` · ${status.baseUrl}` : ""}` }),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "API Key" }), input),
		status.kind === "custom" ? el("div", { class: "field field-wide" }, el("span", { class: "field-label", text: "本地或内网服务，不用 Key" }), noauth) : null,
	);
	const { close } = openModal({
		eyebrow: "供应商",
		title: "换一把钥匙",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "存下",
				kind: "primary",
				onClick: async () => {
					try {
						await api.patchProvider(status.id, {
							apiKey: input.value.trim() || undefined,
							noAuthRequired: noauth.getAttribute("aria-checked") === "true",
						});
						close();
						toast("存下了。", "ok");
						await refreshSettings();
						await reloadModels();
					} catch (error) {
						toast(error.message || "存不上。", "error");
					}
				},
			},
		],
	});
	input.focus();
}

function openProviderEditor() {
	const labelInput = el("input", { class: "set-input", type: "text", placeholder: "如：公司内网 vLLM" });
	const urlInput = el("input", { class: "set-input", type: "text", placeholder: "https://example.com/v1" });
	const apiSelect = el("select", { class: "set-select" });
	for (const [value, label, hint] of API_FORMATS) apiSelect.append(el("option", { value, text: label, title: hint }));
	const keyInput = el("input", { class: "set-input", type: "password", placeholder: "服务不要 Key 就留空", autocomplete: "off" });
	const body = el(
		"div",
		{ class: "form-grid" },
		el("label", { class: "field" }, el("span", { class: "field-label", text: "名字" }), labelInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "接口协议" }), apiSelect),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "Base URL" }), urlInput),
		el("label", { class: "field field-wide" }, el("span", { class: "field-label", text: "API Key" }), keyInput),
	);
	const { close } = openModal({
		eyebrow: "供应商",
		title: "接一个供应商",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "接上",
				kind: "primary",
				onClick: async () => {
					try {
						await api.createProvider({
							label: labelInput.value.trim(),
							baseUrl: urlInput.value.trim(),
							api: apiSelect.value,
							apiKey: keyInput.value.trim() || undefined,
							noAuthRequired: keyInput.value.trim() ? undefined : true,
						});
						close();
						toast("接上了，去拉模型清单。", "ok");
						await refreshSettings();
						await reloadModels();
					} catch (error) {
						toast(error.message || "接不上。", "error");
					}
				},
			},
		],
	});
	labelInput.focus();
}

async function reloadModels() {
	try {
		const data = await api.bootstrap();
		ctx.state.models = data.models?.all || data.models || [];
		ctx.state.defaultModel = data.defaultModel || "";
		ctx.state.defaultThinkingLevel = data.defaultThinkingLevel || "off";
		ctx.notify("boot");
	} catch {
		/* 设不动就下次启动再说 */
	}
}

/* ---------------------------------------------------------------- 偏好 */

function renderPrefsPanel() {
	const host = $("#settings-panel-prefs");
	if (!host) return;
	host.replaceChildren();
	const dark = document.documentElement.dataset.theme === "dark";
	const themeSeg = el("div", { class: "seg" });
	const themes = [
		["light", "亮"],
		["dark", "暗"],
		["auto", "跟系统"],
	];
	const stored = localStorage.getItem("novel-studio-theme");
	const current = stored === "light" || stored === "dark" ? stored : "auto";
	for (const [value, label] of themes) {
		themeSeg.append(
			el("button", {
				class: `seg-btn${value === current ? " is-active" : ""}`,
				type: "button",
				text: label,
				on: {
					click: () => {
						for (const other of themeSeg.children) other.classList.toggle("is-active", other === themeSeg.children[themes.findIndex(([v]) => v === value)]);
						applyTheme(value);
					},
				},
			}),
		);
	}

	const sizeInput = el("input", { class: "set-input", type: "range", min: "0.85", max: "1.35", step: "0.05", value: String(ctx.state.prefs.fontScale || 1) });
	const sizeOut = el("span", { class: "set-hint", text: `${Math.round((ctx.state.prefs.fontScale || 1) * 100)}%` });
	sizeInput.addEventListener("input", () => {
		const scale = Number(sizeInput.value);
		sizeOut.textContent = `${Math.round(scale * 100)}%`;
		applyFontScale(scale);
	});

	const lhInput = el("input", { class: "set-input", type: "range", min: "1.6", max: "2.3", step: "0.05", value: String(ctx.state.prefs.lineHeight || 1.95) });
	const lhOut = el("span", { class: "set-hint", text: (ctx.state.prefs.lineHeight || 1.95).toFixed(2) });
	lhInput.addEventListener("input", () => {
		const lh = Number(lhInput.value);
		lhOut.textContent = lh.toFixed(2);
		applyLineHeight(lh);
	});

	const dockSwitch = toggle(ctx.state.prefs.dockOpen !== false, (next) => ctx.savePrefs({ dockOpen: next }), "默认打开副驾");
	const restoreSwitch = toggle(ctx.state.prefs.restoreLast !== false, (next) => ctx.savePrefs({ restoreLast: next }), "回到上次的书");
	const caretSwitch = toggle(ctx.state.prefs.typewriter === true, (next) => {
		ctx.savePrefs({ typewriter: next });
		document.getElementById("ms-page")?.classList.toggle("is-typewriter", next);
	}, "打字机模式");

	host.append(
		section(
			"亮暗",
			row("纸的颜色", "暗色是为夜里写的", themeSeg),
			row("纸上的字多大", "只影响稿纸与读稿", el("div", { class: "set-inline" }, sizeInput, sizeOut)),
			row("行多松", "行距松一点，眼睛轻一点", el("div", { class: "set-inline" }, lhInput, lhOut)),
		),
		section(
			"顺手",
			row("一进来就开副驾", "关掉就更像一张白纸", dockSwitch),
			row("回到上次写的那本书", "启动直接续上", restoreSwitch),
			row("打字机模式", "让光标那一行停在纸中间", caretSwitch),
		),
		section(
			"本地偏好",
			el("p", { class: "set-note", text: "这些只存在这台机器的浏览器里，不跟着书稿走。" }),
			el(
				"div",
				{ class: "set-actions" },
				el(
					"button",
					{
						class: "btn btn-quiet btn-sm",
						type: "button",
						text: "恢复默认",
						on: {
							click: () => {
								ctx.savePrefs({ fontScale: 1, lineHeight: 1.95, dockOpen: true, restoreLast: true, typewriter: false });
								applyFontScale(1);
								applyLineHeight(1.95);
								document.documentElement.style.removeProperty("--paper-lh");
								applyTheme(current === "auto" ? "auto" : current);
								renderPrefsPanel();
								toast("回原样了。");
							},
						},
					},
					"恢复默认",
				),
			),
		),
	);
}

/* 启动时把上次调好的读书参数摆回纸面（设置面板只管改，应用在纸这边）。 */
export function applyReadPrefs() {
	const prefs = ctx.state.prefs || {};
	const scale = typeof prefs.fontScale === "number" && Number.isFinite(prefs.fontScale) ? prefs.fontScale : 1;
	if (Math.abs(scale - 1) > 0.001) {
		document.documentElement.style.setProperty("--paper-fs", `${(17.5 * scale).toFixed(2)}px`);
	}
	const lh = typeof prefs.lineHeight === "number" && Number.isFinite(prefs.lineHeight) ? prefs.lineHeight : 1.95;
	if (Math.abs(lh - 1.95) > 0.001) {
		document.documentElement.style.setProperty("--paper-lh", String(lh));
	}
	document.getElementById("ms-page")?.classList.toggle("is-typewriter", prefs.typewriter === true);
}

function applyTheme(theme) {	const next = theme === "auto" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
	document.documentElement.dataset.theme = next;
	const meta = document.querySelector('meta[name="theme-color"]:not([media])');
	if (meta) meta.setAttribute("content", next === "dark" ? "#17150f" : "#efe8d9");
	try {
		if (theme === "auto") localStorage.removeItem("novel-studio-theme");
		else localStorage.setItem("novel-studio-theme", next);
	} catch {
		/* 存不了也照用 */
	}
}

function applyFontScale(scale) {
	ctx.savePrefs({ fontScale: scale });
	document.documentElement.style.setProperty("--paper-fs", `${(17.5 * scale).toFixed(2)}px`);
}

function applyLineHeight(lh) {
	ctx.savePrefs({ lineHeight: lh });
	document.documentElement.style.setProperty("--paper-lh", String(lh));
}

/* ---------------------------------------------------------------- 服务器 */

/**
 * 服务器：这一台把稿子放在哪儿。
 *
 * 默认是「本机」——不连服务器也能把一本书写完，手机上装完就能用。
 * 想让自己几台设备共用一个账号时，在这里填地址、连上并登录；
 * 连过之后这一页显示连的是哪台，并给一个「断开，回到本机」。
 *
 * 地址在登录成功之前不写进 localStorage：写早了，下次冷启动会直接
 * 进云端模式，网络不通就卡在登录页上——这是本地优先最不该出现的样子。
 */
function renderServerPanel() {
	const host = $("#settings-panel-server");
	if (!host) return;
	host.replaceChildren();

	const base = readCloudBase();
	const auth = window.__NOVEL_AUTH_STATE__ || {};
	const who = auth.user ? auth.user.name || auth.user.email || "已登录" : "";

	if (base) {
		const card = el("div", { class: "set-card" });
		card.append(
			el("p", { class: "set-note", text: "这台设备连着云端，作品保存在下面这台服务器上。" }),
			el("div", { class: "set-row" },
				el("div", { class: "set-row-main" },
					el("div", { class: "set-row-label", text: "服务器" }),
					el("div", { class: "set-row-hint", text: base }),
				),
			),
			el("div", { class: "set-row" },
				el("div", { class: "set-row-main" },
					el("div", { class: "set-row-label", text: "账号" }),
					el("div", { class: "set-row-hint", text: who || "已经连上，账号信息还没读到" }),
				),
			),
		);
		card.append(
			el("div", { class: "set-actions" },
				el("button", {
					class: "btn btn-ghost btn-sm",
					type: "button",
					text: "账号与用量",
					on: { click: () => openAccountPanel() },
				}),
				el("button", {
					class: "btn btn-quiet btn-sm",
					type: "button",
					text: "断开，回到本机",
					on: {
						click: async () => {
							const ok = await confirmAction({
								title: "断开云端，回到本机？",
								message: "断开后这台设备切回本机模式，现在的稿子还在本机；云端上的作品不会被删掉，下次登录还在。",
								confirmLabel: "断开",
								danger: true,
							});
							if (!ok) return;
							clearCloudConfig();
							window.location.reload();
						},
					},
				}),
			),
		);
		host.append(section("云端账号", card));
		host.append(note("想换一台服务器，先「断开，回到本机」，再填新地址登录。"));
		return;
	}

	if (window.__NOVEL_MULTIUSER__) {
		const origin = window.location.origin;
		const card = el("div", { class: "set-card" });
		card.append(
			el("p", { class: "set-note", text: "这个页面由服务器直接提供，账号就是这台服务器的账号。" }),
			el("div", { class: "set-row" },
				el("div", { class: "set-row-main" },
					el("div", { class: "set-row-label", text: "服务器" }),
					el("div", { class: "set-row-hint", text: origin }),
				),
			),
			el("div", { class: "set-actions" },
				el("button", {
					class: "btn btn-ghost btn-sm",
					type: "button",
					text: "账号与用量",
					on: { click: () => openAccountPanel() },
				}),
			),
		);
		host.append(section("这台服务器", card));
		return;
	}

	// 单机部署的服务器：页面由服务器提供，数据也在服务器上，没有账号这回事。
	// 这一页要说清「你不用登录」，而不是摆一张连云端的表把人弄糊涂。
	if (window.__DSH_LOCAL_MODE__ !== true) {
		const card = el("div", { class: "set-card" });
		card.append(
			el("p", { class: "set-note", text: "这个页面由服务器提供，稿子也存在这台服务器上，不用登录。" }),
			el("div", { class: "set-row" },
				el("div", { class: "set-row-main" },
					el("div", { class: "set-row-label", text: "服务器" }),
					el("div", { class: "set-row-hint", text: window.location.origin }),
				),
			),
			el("p", { class: "set-note", text: "手机上的应用默认用本机数据，不连服务器也能写；想连，请在那台设备上装应用后在「设置 → 服务器」里填地址。" }),
		);
		host.append(section("这台服务器", card));
		return;
	}

	// 本机模式：这是原生应用（手机/桌面）的默认样子。
	const localCard = el("div", { class: "set-card" });
	localCard.append(
		el("p", { class: "set-note", text: "本机模式：稿子留在这台设备上。写稿、改编、润色都不用服务器，断网也照常写。" }),
		el("p", { class: "set-note", text: "想多台设备共用一个账号，才需要连云端。不连也一直能用。" }),
	);
	host.append(section("这台设备", localCard));

	const remembered = (getStoredCloud() && getStoredCloud().base) || "";
	const addr = el("input", {
		class: "set-input",
		type: "url",
		inputmode: "url",
		value: remembered || DEFAULT_CLOUD_BASE,
		placeholder: DEFAULT_CLOUD_BASE,
		spellcheck: "false",
		autocomplete: "off",
		"aria-label": "服务器地址",
	});
	const connect = el("button", {
		class: "btn btn-primary btn-sm",
		type: "button",
		text: "连上并登录",
		on: {
			click: () => {
				const next = normalizeCloudBase(addr.value) || DEFAULT_CLOUD_BASE;
				if (!next) {
					toast("先填一个服务器地址。", "error");
					addr.focus();
					return;
				}
				openCloudConnect(next);
			},
		},
	});
	const cloudCard = el("div", { class: "set-card" });
	cloudCard.append(
		el("div", { class: "set-row" },
			el("div", { class: "set-row-main" },
				el("div", { class: "set-row-label", text: "服务器地址" }),
				el("div", { class: "set-row-hint", text: "默认是官方地址；用自建服务器就换成自己的域名。" }),
			),
			el("div", { class: "set-row-control" }, addr),
		),
		el("div", { class: "set-actions" },
			connect,
			el("button", {
				class: "btn btn-quiet btn-sm",
				type: "button",
				text: "用默认地址",
				on: {
					click: () => {
						addr.value = DEFAULT_CLOUD_BASE;
						addr.focus();
					},
				},
			}),
		),
		el("p", { class: "set-note", text: "登录成功之后才会切到云端；连不上就一直留在本机，什么都不影响。" }),
	);
	host.append(section("连云端（可选）", cloudCard));
}

/* ---------------------------------------------------------------- 数据 */

async function renderDataPanel() {
	const host = $("#settings-panel-data");
	if (!host) return;
	host.replaceChildren();
	const project = ctx.state.project;

	// 落盘状态
	let storage = null;
	try {
		storage = await api.getStorage();
	} catch {
		storage = null;
	}
	const storageCard = el("div", { class: "set-card" });
	storageCard.append(
		el("p", { class: storage?.ok === false ? "set-note is-warn" : "set-note", text: storage ? (storage.ok === false ? storage.message || "有改动没落盘" : "所有改动都已写进这台机器") : "这台机器的落盘状态暂时读不到" }),
	);
	if (storage && storage.ok === false) {
		storageCard.append(
			el(
				"div",
				{ class: "set-actions" },
				el(
					"button",
					{
						class: "btn btn-ghost btn-sm",
						type: "button",
						text: "再试一次",
						on: {
							click: async () => {
								try {
									await api.retryStorage();
									toast("再试了一遍。", "ok");
									await renderDataPanel();
								} catch (error) {
									toast(error.message || "还是不行。", "error");
								}
							},
						},
					},
					"再试一次",
				),
			),
		);
	}

	// 快照
	const snapCard = el("div", { class: "set-card" });
	if (!project) {
		snapCard.append(note("打开一部书，这里会列出它的快照。"));
	} else {
		const list = el("div", { class: "snap-list" });
		try {
			const data = await api.listSnapshots(project.id);
			const snaps = data.snapshots || [];
			if (!snaps.length) list.append(note("还没有快照。"));
			for (const snap of snaps.slice(0, 12)) {
				list.append(
					el(
						"div",
						{ class: "snap-row" },
						el("div", { class: "snap-main" }, el("span", { class: "snap-name", text: snap.name || "快照" }), el("span", { class: "snap-meta", text: `${timeAgo(snap.at)} · ${Math.round((snap.size || 0) / 1024)} KB` })),
						el(
							"button",
							{
								class: "btn btn-quiet btn-sm",
								type: "button",
								text: "回到这一版",
								on: {
									click: async () => {
										const yes = await confirmAction({
											title: "回到这一版？",
											message: "当前的稿子会先自动拍一份快照留底，再切过去。",
											confirmLabel: "回去",
										});
										if (!yes) return;
										try {
											await api.restoreSnapshot(project.id, snap.name);
											await ctx.openProject(project.id).catch(() => {});
											toast("回去了。", "ok");
											await renderDataPanel();
										} catch (error) {
											toast(error.message || "回不去。", "error");
										}
									},
								},
							},
						),
					),
				);
			}
		} catch (error) {
			list.append(note(error.message || "快照读不到。", "is-warn"));
		}
		snapCard.append(list);
	}

	// 搬家
	const passInput = el("input", { class: "set-input", type: "password", placeholder: "口令（可留空）", autocomplete: "off" });
	const credSwitch = toggle(false, () => {}, "带上密钥");
	const exportBtn = el(
		"button",
		{
			class: "btn btn-ghost btn-sm",
			type: "button",
			on: {
				click: async () => {
					const { exportNovel } = await import("./share.js");
					if (!project) return toast("先打开一部书。", "error");
					await exportNovel({ projectId: project.id, title: project.title, passphrase: passInput.value });
				},
			},
		},
		icon("download"),
		project ? "导出这一本的 .novel" : "导出（先打开一本书）",
	);
	exportBtn.disabled = !project;

	if (!project) credSwitch.setAttribute("disabled", "true");

	const importBtn = el(
		"button",
		{
			class: "btn btn-ghost btn-sm",
			type: "button",
			on: {
				click: async () => {
					const { pickNovelFile } = await import("./share.js");
					pickNovelFile();
				},
			},
		},
		icon("upload"),
		"收一本 .novel 进来",
	);

	host.append(
		section("这台机器上的原稿", storageCard),
		section("快照", el("p", { class: "set-note", text: "每回落盘前都会留一版，写崩了能回去。" }), snapCard),
		section(
			"搬家",
			el("p", { class: "set-note", text: "整本导出成一个文件，换个设备打开；带口令时会连正文一起加密。" }),
			el("div", { class: "set-field-row" }, passInput, exportBtn),
			el("p", { class: "set-note", text: "「带上密钥」只对全量导出有效，且必须给口令。" }),
			el("div", { class: "set-actions" }, importBtn),
		),
	);
}

/* ---------------------------------------------------------------- 关于 */

function renderAboutPanel() {
	const host = $("#settings-panel-about");
	if (!host) return;
	const keep = $("#settings-about-panel");
	host.replaceChildren();
	const local = Boolean(window.__NOVEL_LOCAL_MODE__ || window.__DSH_LOCAL_MODE__);
	host.append(
		section(
			"墨耕",
			el(
				"div",
				{ class: "about-intro" },
				el("div", { class: "about-card" }, el("p", { class: "set-title", text: "墨耕 · 书案" }), note("本地优先的中文长篇小说创作台。稿子、素材、履历都在这台机器上；连上模型才需要联网。")),
				el("p", { class: "set-note", text: local ? "现在跑在本地单机模式。" : "现在连着服务端。" }),
			),
		),
		section("这一版", el("p", { class: "set-note", text: `界面重写版 · ${new Date().getFullYear()} 年` })),
	);
	host.append(
		section(
			"快捷键",
			el(
				"div",
				{ class: "set-actions" },
				el("button", {
					class: "btn btn-quiet btn-sm",
					type: "button",
					on: { click: () => import("./palette.js").then((mod) => mod.showHelp()) },
				}, icon("command"), "看一遍"),
			),
		),
	);
	if (keep) host.append(keep);
}

export { note as settingsNote, num as settingsNum };
