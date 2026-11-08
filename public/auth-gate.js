// 登录门：app.js 起手前先问清楚“你是谁”。
//
// 三种情况：
//   · 纯本地模式（__DSH_LOCAL_MODE__）：立即放行，不发任何请求；
//   · 云端模式（__NOVEL_CLOUD__）：改写 fetch，把同源 /api/* 发到云端，
//     未登录时渲染全屏登录/注册浮层；
//   · 同源 Cookie 模式：直接请求 /api/auth/me，401 时同样出浮层。
//
// 浮层不用 innerHTML，全部用 createElement/textContent 搭，避免把服务端
// 返回的文案当成 HTML；也没有内联事件，符合现有 CSP。

import { clearCloudConfig, cloudToken, getCloudConfig, setCloudConfig } from "./cloud-client.js";

const DEFAULT_APP_NAME = "墨耕";
const DEFAULT_MIN_PASSWORD = 8;

let authPromise = null;
let cloudFetchInstalled = false;
let activeGate = null;

/** app.js 顶部 await 的就是这个函数：成功才 resolve，需要登录就一直等到登录成功。 */
export async function ensureAuth() {
	if (!authPromise) authPromise = runEnsureAuth();
	return authPromise;
}

function defaultAuthConfig() {
	return {
		appName: DEFAULT_APP_NAME,
		registration: "open",
		minPasswordLength: DEFAULT_MIN_PASSWORD,
		mode: "",
	};
}

function cleanText(value) {
	return typeof value === "string" ? value.trim() : "";
}

async function loadAuthConfig() {
	const result = await fetchJson("/api/auth/config", { headers: { accept: "application/json" } });
	if (!result.ok || !result.data || typeof result.data !== "object") return defaultAuthConfig();
	const minPasswordLength = Number(result.data.minPasswordLength);
	return {
		appName: cleanText(result.data.appName) || DEFAULT_APP_NAME,
		registration: result.data.registration === "closed" ? "closed" : "open",
		minPasswordLength:
			Number.isFinite(minPasswordLength) && minPasswordLength > 0
				? Math.floor(minPasswordLength)
				: DEFAULT_MIN_PASSWORD,
		mode: cleanText(result.data.mode),
	};
}

async function runEnsureAuth() {
	if (window.__DSH_LOCAL_MODE__ === true) {
		return publish({ kind: "open", mode: "local" });
	}

	installCloudFetch();
	const config = await loadAuthConfig();
	const probe = await probeSession();
	if (probe.kind === "ready") {
		return publish({
			kind: "open",
			mode: probe.mode,
			user: probe.user || null,
			usage: probe.usage || null,
		});
	}

	if (probe.kind === "unauthorized" || probe.kind === "forbidden") forgetCloudToken();

	return new Promise((resolveAuth) => {
		renderGate(config, probe, resolveAuth);
	});
}

function publish(state) {
	window.__NOVEL_AUTH_STATE__ = state;
	return state;
}

async function probeSession() {
	const result = await fetchJson("/api/auth/me", { headers: { accept: "application/json" } });
	if (result.network) return { kind: "offline" };
	if (result.status === 401) return { kind: "unauthorized" };
	if (result.status === 403) return { kind: "forbidden", data: result.data };
	if (result.ok) {
		const data = result.data && typeof result.data === "object" ? result.data : null;
		if (!data) {
			// 200 却不是 JSON：云端不能当成已登录，单机版则继续放行。
			return window.__NOVEL_CLOUD__ ? { kind: "error", status: 200, data: null } : { kind: "ready", mode: "single" };
		}
		if (data.mode === "multi" || (data.user && data.mode !== "single" && data.mode !== "local")) {
			if (!data.user) return { kind: "unauthorized" };
			return { kind: "ready", mode: "multi", user: data.user, usage: data.usage || null };
		}
		return { kind: "ready", mode: data.mode === "local" ? "local" : "single" };
	}
	if (result.status === 404 || result.status === 405 || result.status === 501) {
		return { kind: "ready", mode: "single" };
	}
	if (window.__NOVEL_CLOUD__) {
		return { kind: "error", status: result.status, data: result.data };
	}
	// 同源部署里，账号接口暂缺或服务端抽风时不要把人锁在门外；
	// 页面自己的请求会把真实错误显示出来。
	return { kind: "ready", mode: "single" };
}

async function fetchJson(path, options = {}) {
	const headers = new Headers(options.headers || {});
	if (!headers.has("accept")) headers.set("accept", "application/json");
	let body = options.body;
	if (body && typeof body === "object") {
		if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
		body = JSON.stringify(body);
	}
	try {
		const response = await fetch(path, {
			...options,
			headers,
			body,
			credentials: options.credentials || "same-origin",
		});
		let data = null;
		const text = await response.text();
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
		}
		return { ok: response.ok, status: response.status, data };
	} catch {
		return { ok: false, status: 0, network: true };
	}
}

function errorText(status, data) {
	const server = data && typeof data.error === "string" ? data.error.trim() : "";
	if (server) {
		let message = server;
		if (status === 429 && data && Number(data.retryAfter) > 0) {
			message += "（约 " + Math.ceil(Number(data.retryAfter)) + " 秒后可再试）";
		}
		return message;
	}
	switch (status) {
		case 0:
			return "连不上服务器，请检查网络或服务器地址后重试。";
		case 400:
			return "请检查填写的内容是否完整。";
		case 401:
			return "账号或密码不对，请重新输入。";
		case 403:
			return "这个账号当前不可用，可能已被停用。";
		case 404:
			return "服务端没有登录接口，可能还是单机版。";
		case 409:
			return "这个邮箱或用户名已经被使用了。";
		case 429:
			return "尝试太频繁，请稍后再试。";
		case 507:
			return "云端容量已满，请联系管理员。";
		default:
			return status >= 500 ? "服务器出错了（HTTP " + status + "），请稍后重试。" : "请求没有成功（HTTP " + status + "）。";
	}
}

function forgetCloudToken() {
	if (!window.__NOVEL_CLOUD__) return;
	try {
		const stored = getCloudConfig();
		if (stored) setCloudConfig({ base: stored.base, token: "" });
		else if (typeof window.__NOVEL_CLOUD__.setToken === "function") window.__NOVEL_CLOUD__.setToken("");
	} catch {
		// 清不掉旧 token 也不能阻止登录浮层出现。
	}
}

function serverDisplay() {
	const stored = getCloudConfig();
	const cloud = window.__NOVEL_CLOUD__;
	const base =
		(stored && stored.base) || (cloud && typeof cloud.base === "string" ? cloud.base : "");
	if (!base) return "";
	try {
		return new URL(base).host;
	} catch {
		return base;
	}
}

/** 把同源 /api/* 改写到云端地址，并带上 token / 原生客户端标记。 */
function installCloudFetch() {
	if (cloudFetchInstalled) return;
	const cloud = window.__NOVEL_CLOUD__;
	const base = cloud && typeof cloud.base === "string" ? cloud.base.replace(/\/+$/, "") : "";
	if (!base) return;
	const previous = window.fetch;
	if (typeof previous !== "function") return;

	cloudFetchInstalled = true;
	window.fetch = function novelCloudFetch(input, init) {
		const target = rewriteApiTarget(input, base);
		if (!target) return previous.call(window, input, init);

		let options = { ...(init || {}) };
		let headers;
		if (typeof Request !== "undefined" && input instanceof Request) {
			headers = new Headers(input.headers);
			if (options.headers) {
				new Headers(options.headers).forEach((value, key) => headers.set(key, value));
			}
		} else {
			headers = new Headers(options.headers || undefined);
		}
		const token = cloudToken();
		if (token && !headers.has("authorization")) headers.set("authorization", "Bearer " + token);
		if (window.__TAURI_INTERNALS__ && !headers.has("x-novel-client")) headers.set("x-novel-client", "native");
		if (!options.credentials) options.credentials = "same-origin";
		options.headers = headers;

		if (typeof Request !== "undefined" && input instanceof Request) {
			const carried = new Request(target, input);
			return previous.call(window, new Request(carried, { headers }));
		}
		return previous.call(window, target, options);
	};
}

function rewriteApiTarget(input, base) {
	let url = null;
	try {
		if (typeof input === "string") url = new URL(input, window.location.href);
		else if (typeof URL !== "undefined" && input instanceof URL) url = new URL(input.href);
		else if (typeof Request !== "undefined" && input instanceof Request) url = new URL(input.url, window.location.href);
		else return "";
	} catch {
		return "";
	}
	if (url.origin !== window.location.origin) return "";
	if (!url.pathname.startsWith("/api/")) return "";
	return base + url.pathname + url.search;
}

// ── 浮层 ────────────────────────────────────────────────────

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function makeButton(label, className) {
	const node = el("button", className, label);
	node.type = "button";
	return node;
}

function removeGate() {
	if (activeGate && activeGate.parentNode) activeGate.parentNode.removeChild(activeGate);
	activeGate = null;
	document.documentElement.classList.remove("auth-locked");
}

function renderGate(config, probe, resolveAuth) {
	removeGate();
	document.documentElement.classList.add("auth-locked");

	const appName = config.appName || DEFAULT_APP_NAME;
	const gate = el("div", "auth-gate");
	gate.setAttribute("role", "dialog");
	gate.setAttribute("aria-modal", "true");
	gate.setAttribute("aria-labelledby", "auth-title");

	const card = el("div", "auth-card");
	const brand = el("div", "auth-brand");
	const logo = el("span", "auth-logo", appName.slice(0, 1) || "墨");
	const brandText = el("div", "auth-brand-text");
	const heading = el("h1", "auth-title", appName);
	heading.id = "auth-title";
	brandText.append(heading, el("p", "auth-tagline", "云端书房"));
	brand.append(logo, brandText);

	const lead = el("p", "auth-lead", "登录后继续写你的书。作品、素材与记录会跟着账号走。");
	card.append(brand, lead);

	const server = serverDisplay();
	if (server) card.append(el("p", "auth-server", "云端：" + server));

	const alertBox = el("div", "auth-alert hidden");
	alertBox.setAttribute("role", "alert");
	card.append(alertBox);

	const form = document.createElement("form");
	form.className = "auth-form";
	form.setAttribute("novalidate", "");
	form.autocomplete = "on";

	const accountInput = document.createElement("input");
	accountInput.className = "auth-input";
	accountInput.type = "text";
	accountInput.name = "account";
	accountInput.autocomplete = "username";
	accountInput.placeholder = "you@example.com";
	accountInput.spellcheck = false;
	const accountField = el("label", "auth-field");
	accountField.append(el("span", "auth-field-label", "邮箱或用户名"), accountInput);

	const emailInput = document.createElement("input");
	emailInput.className = "auth-input";
	emailInput.type = "email";
	emailInput.name = "email";
	emailInput.autocomplete = "email";
	emailInput.inputMode = "email";
	emailInput.placeholder = "you@example.com";
	emailInput.spellcheck = false;
	const emailField = el("label", "auth-field");
	emailField.append(el("span", "auth-field-label", "邮箱"), emailInput);

	const displayInput = document.createElement("input");
	displayInput.className = "auth-input";
	displayInput.type = "text";
	displayInput.name = "displayName";
	displayInput.autocomplete = "nickname";
	displayInput.placeholder = "怎么称呼你";
	displayInput.maxLength = 40;
	const displayField = el("label", "auth-field");
	displayField.append(el("span", "auth-field-label", "昵称（可选）"), displayInput);

	const passwordInput = document.createElement("input");
	passwordInput.className = "auth-input";
	passwordInput.type = "password";
	passwordInput.name = "password";
	passwordInput.autocomplete = "current-password";
	passwordInput.placeholder = "密码";
	const passwordHint = el("span", "auth-field-hint hidden", "至少 " + config.minPasswordLength + " 位");
	const passwordField = el("label", "auth-field");
	passwordField.append(el("span", "auth-field-label", "密码"), passwordInput, passwordHint);

	form.append(accountField, emailField, displayField, passwordField);

	const submit = el("button", "btn btn-ink auth-submit", "登录");
	submit.type = "submit";
	form.append(submit);

	const switchRow = el("div", "auth-switch-row");
	const switchButton = makeButton("还没有账号？注册", "auth-switch");
	switchRow.append(switchButton);
	form.append(switchRow);

	const closedNote = el("p", "auth-note hidden", "当前仅管理员可建号。");
	form.append(closedNote);

	const retryPanel = el("div", "auth-retry hidden");
	const retryText = el("p", "auth-retry-text", "");
	const retryButton = makeButton("重试连接", "btn btn-ink auth-submit");
	retryPanel.append(retryText, retryButton);
	card.append(form, retryPanel);

	if (window.__TAURI_INTERNALS__) {
		const localButton = makeButton("先本地使用", "btn btn-quiet auth-local");
		localButton.title = "清掉云端配置，改用这台电脑上的本地数据";
		localButton.addEventListener("click", () => {
			if (busy) return;
			clearCloudConfig();
			window.location.reload();
		});
		card.append(localButton);
	}

	card.append(
		el(
			"p",
			"auth-foot",
			server ? "登录令牌只保存在这台设备；公共电脑上用完请退出。" : "登录状态由当前网站的安全 Cookie 维持。",
		),
	);

	gate.append(card);
	(document.body || document.documentElement).append(gate);
	activeGate = gate;

	let mode = "login";
	let busy = false;
	let stage = "form";

	const setAlert = (message) => {
		if (!message) {
			alertBox.textContent = "";
			alertBox.classList.add("hidden");
			return;
		}
		alertBox.textContent = message;
		alertBox.classList.remove("hidden");
	};

	const setMode = (next) => {
		mode = next === "register" ? "register" : "login";
		const isRegister = mode === "register";
		accountField.classList.toggle("hidden", isRegister);
		emailField.classList.toggle("hidden", !isRegister);
		displayField.classList.toggle("hidden", !isRegister);
		passwordHint.classList.toggle("hidden", !isRegister);
		passwordInput.autocomplete = isRegister ? "new-password" : "current-password";
		submit.textContent = isRegister ? "注册并登录" : "登录";
		switchButton.textContent = isRegister ? "已有账号？去登录" : "还没有账号？注册";
		setAlert("");
		if (!busy) setTimeout(() => (isRegister ? emailInput : accountInput).focus(), 0);
	};

	const showStage = (next) => {
		stage = next;
		form.classList.toggle("hidden", stage !== "form");
		retryPanel.classList.toggle("hidden", stage !== "retry");
	};

	const setRetryText = (message) => {
		retryText.textContent = message;
	};

	const setBusy = (value) => {
		busy = value;
		submit.disabled = value;
		switchButton.disabled = value;
		submit.textContent = value ? (mode === "login" ? "正在登录…" : "正在注册…") : mode === "login" ? "登录" : "注册并登录";
	};

	const finish = (result) => {
		const state = publish({ kind: "open", ...result });
		removeGate();
		resolveAuth(state);
	};

	const registrationClosed = config.registration === "closed";
	if (registrationClosed) {
		switchRow.classList.add("hidden");
		closedNote.classList.remove("hidden");
	}
	setMode("login");

	switchButton.addEventListener("click", () => {
		if (busy) return;
		setMode(mode === "login" ? "register" : "login");
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (busy) return;
		setAlert("");

		const password = passwordInput.value;
		if (mode === "login") {
			const account = accountInput.value.trim();
			if (!account) {
				setAlert("请填写邮箱或用户名。");
				accountInput.focus();
				return;
			}
			if (!password) {
				setAlert("请填写密码。");
				passwordInput.focus();
				return;
			}
		} else {
			const email = emailInput.value.trim();
			if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
				setAlert("请填写有效的邮箱地址。");
				emailInput.focus();
				return;
			}
			if (password.length < config.minPasswordLength) {
				setAlert("密码至少需要 " + config.minPasswordLength + " 位。");
				passwordInput.focus();
				return;
			}
		}

		const payload =
			mode === "login"
				? { account: accountInput.value.trim(), password }
				: {
						email: emailInput.value.trim(),
						password,
						...(displayInput.value.trim() ? { displayName: displayInput.value.trim() } : {}),
					};

		setBusy(true);
		const result = await fetchJson(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
			method: "POST",
			body: payload,
		});
		setBusy(false);

		if (result.network) {
			setAlert("连不上服务器，请检查网络或服务器地址后重试。");
			return;
		}
		if (!result.ok) {
			setAlert(errorText(result.status, result.data));
			return;
		}

		const data = result.data && typeof result.data === "object" ? result.data : {};
		const cloud = window.__NOVEL_CLOUD__;
		if (cloud) {
			if (!data.token || typeof data.token !== "string") {
				setAlert("登录成功，但服务端没有返回登录令牌。请确认服务端以云端模式运行，并允许原生客户端连接。");
				return;
			}
			try {
				if (typeof cloud.setToken === "function") cloud.setToken(data.token);
				const stored = getCloudConfig();
				const base = (stored && stored.base) || (typeof cloud.base === "string" ? cloud.base : "");
				setCloudConfig({ base, token: data.token });
			} catch (error) {
				setAlert("登录成功，但保存登录令牌失败：" + (error && error.message ? error.message : "存储不可用"));
				return;
			}
		}

		finish({ mode: "multi", user: data.user || null, usage: data.usage || null });
	});

	retryButton.addEventListener("click", async () => {
		if (busy) return;
		busy = true;
		retryButton.disabled = true;
		retryButton.textContent = "正在连接…";
		setRetryText("正在连接" + (server ? " " + server : "服务器") + "…");

		const next = await probeSession();
		busy = false;
		retryButton.disabled = false;
		retryButton.textContent = "重试连接";

		if (next.kind === "ready") {
			finish({ mode: next.mode, user: next.user || null, usage: next.usage || null });
			return;
		}
		if (next.kind === "unauthorized") {
			forgetCloudToken();
			showStage("form");
			setAlert("");
			setTimeout(() => accountInput.focus(), 0);
			return;
		}
		if (next.kind === "forbidden") {
			forgetCloudToken();
			showStage("form");
			setAlert(errorText(403, next.data));
			return;
		}
		showStage("retry");
		setRetryText(errorText(next.status || 0, next.data));
	});

	if (probe.kind === "unauthorized") {
		showStage("form");
	} else if (probe.kind === "forbidden") {
		showStage("form");
		setAlert(errorText(403, probe.data));
	} else if (probe.kind === "offline") {
		showStage("retry");
		setRetryText("连不上服务器，登录页暂时打不开。请检查网络或服务器地址后重试。");
	} else if (probe.kind === "error") {
		showStage("retry");
		setRetryText(errorText(probe.status, probe.data));
	}

	setTimeout(() => {
		if (stage === "form") {
			if (mode === "register") emailInput.focus();
			else accountInput.focus();
		} else {
			retryButton.focus();
		}
	}, 0);
}
