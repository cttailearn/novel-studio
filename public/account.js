// 账户面板：顶栏「账户」按钮背后的全部界面。
//
// 普通用户：配额、明细、设备、改密码、改昵称、退出登录；
// 管理员：额外有总览 / 用户 / 审计三个页签；
// Tauri 本地模式：显示「连接云端账号」，登录成功写入 novel-studio/cloud 后刷新。
//
// 和 settings.js 一样是原生 DOM，不引入框架，也不使用 innerHTML。

import {
	DEFAULT_CLOUD_BASE,
	api,
	apiErrorMessage,
	audit,
	changePassword,
	clearCloudConfig,
	createUser,
	deleteUser,
	getCloudConfig,
	listUsers,
	logout,
	normalizeCloudBase,
	patchUser,
	resetPassword,
	revokeOtherSessions,
	revokeSession,
	sessions as fetchSessions,
	setCloudConfig,
	stats as fetchStats,
	updateProfile,
	usage as fetchUsage,
} from "./cloud-client.js";

const DEFAULT_AUTH_CONFIG = {
	appName: "墨耕",
	registration: "open",
	minPasswordLength: 8,
};

const CLIENT_LABELS = {
	native: "原生客户端",
	web: "网页",
	browser: "浏览器",
	desktop: "桌面客户端",
	mobile: "手机客户端",
};

const AUDIT_LABELS = {
	login: "登录",
	logout: "退出登录",
	register: "注册",
	password: "修改密码",
	profile: "修改资料",
	create_user: "新建用户",
	update_user: "修改用户",
	delete_user: "删除用户",
	reset_password: "重置密码",
	revoke_session: "撤销设备",
	revoke_sessions: "撤销其它设备",
};

let uid = 0;

const state = {
	booted: false,
	button: null,
	dialog: null,
	header: null,
	tabs: null,
	body: null,
	tab: "account",
	mode: "loading",
	loading: false,
	busy: false,
	user: null,
	usage: null,
	sessions: [],
	authConfig: { ...DEFAULT_AUTH_CONFIG },
	connectMode: "login",
	flash: null,
	notice: null,
	admin: {
		stats: null,
		statsLoading: false,
		users: [],
		total: 0,
		query: "",
		offset: 0,
		limit: 20,
		usersLoading: false,
		usersLoaded: false,
		audit: [],
		auditLoading: false,
	},
};

// ── 小工具 ──────────────────────────────────────────────────

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label, className, onClick) {
	const node = el("button", className, label);
	node.type = "button";
	if (onClick) node.addEventListener("click", onClick);
	return node;
}

function nextId(prefix) {
	uid += 1;
	return prefix + "-" + uid;
}

function isTauri() {
	return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

function isAdmin() {
	return Boolean(state.user && state.user.role === "admin");
}

function displayNameOf(user) {
	if (!user) return "";
	return user.displayName || user.username || user.email || "未命名用户";
}

function initialOf(user) {
	const text = displayNameOf(user).trim();
	return text ? text.slice(0, 1).toUpperCase() : "账";
}

function roleText(role) {
	return role === "admin" ? "管理员" : "普通用户";
}

function formatBytes(bytes) {
	const number = Number(bytes);
	if (!Number.isFinite(number) || number <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = number;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return value.toFixed(digits) + " " + units[index];
}

function formatTime(value) {
	if (value === undefined || value === null || value === "") return "—";
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	const date = new Date(number < 1e12 ? number * 1000 : number);
	if (Number.isNaN(date.getTime())) return "—";
	const pad = (part) => String(part).padStart(2, "0");
	return (
		date.getFullYear() +
		"-" +
		pad(date.getMonth() + 1) +
		"-" +
		pad(date.getDate()) +
		" " +
		pad(date.getHours()) +
		":" +
		pad(date.getMinutes())
	);
}

function normalizeAuthConfig(data) {
	if (!data || typeof data !== "object") return { ...DEFAULT_AUTH_CONFIG };
	const min = Number(data.minPasswordLength);
	return {
		appName: typeof data.appName === "string" && data.appName.trim() ? data.appName.trim() : DEFAULT_AUTH_CONFIG.appName,
		registration: data.registration === "closed" ? "closed" : "open",
		minPasswordLength: Number.isFinite(min) && min > 0 ? Math.floor(min) : DEFAULT_AUTH_CONFIG.minPasswordLength,
	};
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
			return "登录已失效，请重新登录。";
		case 403:
			return "当前账号无权进行这个操作。";
		case 404:
			return "服务端没有这个接口。";
		case 409:
			return "这个邮箱或用户名已经被使用了。";
		case 429:
			return "尝试太频繁，请稍后再试。";
		case 507:
			return "云端容量已满，请联系管理员。";
		default:
			return status >= 500 ? "服务器出错了（HTTP " + status + "）。" : "请求没有成功（HTTP " + status + "）。";
	}
}

function empty(text) {
	return el("p", "account-empty", text);
}

function field(labelText, control, hint) {
	const id = nextId("account-field");
	control.id = id;
	const wrap = el("div", "field");
	const label = el("label", "", labelText);
	label.htmlFor = id;
	wrap.append(label, control);
	if (hint) wrap.append(el("p", "hint", hint));
	return wrap;
}

function textInput(type, name, autocomplete, placeholder) {
	const input = document.createElement("input");
	input.type = type;
	input.name = name;
	if (autocomplete) input.autocomplete = autocomplete;
	if (placeholder) input.placeholder = placeholder;
	return input;
}

function section(title, hint) {
	const sec = el("section", "account-section");
	const head = el("div", "account-section-head");
	const copy = el("div", "account-section-copy");
	copy.append(el("h4", "account-section-title", title));
	if (hint) copy.append(el("p", "account-section-hint", hint));
	head.append(copy);
	sec.append(head);
	return { sec, head };
}

function pageHead(title, hint, action) {
	const head = el("div", "account-page-head");
	const copy = el("div", "account-page-copy");
	copy.append(el("h4", "account-page-title", title));
	if (hint) copy.append(el("p", "account-page-hint", hint));
	head.append(copy);
	if (action) head.append(action);
	return head;
}

function badge(text, tone) {
	return el("span", "account-badge is-" + tone, text);
}

function flashContent() {
	if (!state.flash) return [];
	const box = el("div", "account-flash is-" + state.flash.tone);
	box.append(el("span", "account-flash-mark", state.flash.tone === "error" ? "!" : "✓"));
	box.append(el("p", "account-flash-text", state.flash.text));
	const close = button("×", "account-flash-close", () => {
		state.flash = null;
		renderFlash();
	});
	close.setAttribute("aria-label", "关闭提示");
	box.append(close);
	return [box];
}

function renderFlash() {
	const host = state.body ? state.body.querySelector(".account-flash-host") : null;
	if (!host) {
		if (state.body) renderBody();
		return;
	}
	host.replaceChildren(...flashContent());
}

function setFlash(text, tone = "error") {
	state.flash = text ? { text, tone } : null;
	renderFlash();
}

// ── 网络动作 ────────────────────────────────────────────────

async function runAction(control, task) {
	if (state.busy) return;
	state.busy = true;
	if (control) control.disabled = true;
	try {
		await task();
	} catch (error) {
		setFlash(apiErrorMessage(error), "error");
	} finally {
		state.busy = false;
		if (control && control.isConnected) control.disabled = false;
	}
}

async function runBusy(control, busyLabel, task) {
	if (state.busy) return;
	const previous = control.textContent;
	control.textContent = busyLabel;
	await runAction(control, task);
	if (control.isConnected) control.textContent = previous;
}

async function loadAuthConfig() {
	try {
		const data = await api("/api/auth/config");
		state.authConfig = normalizeAuthConfig(data);
	} catch {
		state.authConfig = { ...DEFAULT_AUTH_CONFIG };
	}
}

async function loadUsageAndSessions() {
	const errors = [];
	const [usageResult, sessionsResult] = await Promise.allSettled([fetchUsage(), fetchSessions()]);
	if (usageResult.status === "fulfilled") state.usage = usageResult.value;
	else errors.push(apiErrorMessage(usageResult.reason));
	if (sessionsResult.status === "fulfilled") state.sessions = sessionsResult.value;
	else errors.push(apiErrorMessage(sessionsResult.reason));
	if (errors.length) setFlash(errors[0], "error");
}

function applyUser(user) {
	if (!user) return;
	state.user = user;
	if (state.button) state.button.title = "账户：" + displayNameOf(user);
	if (user.usage) state.usage = user.usage;
}

function replaceAdminUser(updated) {
	if (!updated) return;
	const index = state.admin.users.findIndex((user) => String(user.id) === String(updated.id));
	if (index >= 0) state.admin.users[index] = { ...state.admin.users[index], ...updated };
	if (state.user && String(state.user.id) === String(updated.id)) applyUser({ ...state.user, ...updated });
}

// ── 对话框骨架 ──────────────────────────────────────────────

function buildDialog() {
	const dialog = document.createElement("dialog");
	dialog.className = "sheet account-sheet";
	dialog.setAttribute("aria-labelledby", "account-title");

	const head = el("div", "account-head");
	const identity = el("div", "account-id");
	const avatar = el("span", "account-avatar", "账");
	const text = el("div", "account-id-text");
	const title = el("h3", "account-title", "账户");
	title.id = "account-title";
	const sub = el("p", "account-sub", "");
	text.append(title, sub);
	identity.append(avatar, text);

	const close = button("完成", "btn btn-quiet account-close", () => dialog.close());
	close.setAttribute("aria-label", "关闭账户面板");
	head.append(identity, close);

	const tabs = el("div", "account-tabs");
	tabs.setAttribute("role", "tablist");
	const body = el("div", "account-body");

	dialog.append(head, tabs, body);
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
	});
	(document.body || document.documentElement).append(dialog);

	state.dialog = dialog;
	state.header = { avatar, title, sub, tabs, body };
	state.tabs = tabs;
	state.body = body;
}

function renderHeader() {
	if (!state.header) return;
	const user = state.user;
	if (user) {
		state.header.avatar.textContent = initialOf(user);
		state.header.title.textContent = displayNameOf(user);
		const parts = [user.email || "", roleText(user.role)];
		if (user.status === "disabled") parts.push("已停用");
		state.header.sub.textContent = parts.filter(Boolean).join(" · ");
		return;
	}
	state.header.avatar.textContent = "账";
	if (state.mode === "connect") {
		state.header.title.textContent = "连接云端账号";
		state.header.sub.textContent = "这台设备还没有连接云端";
	} else if (state.mode === "expired") {
		state.header.title.textContent = "账户";
		state.header.sub.textContent = "登录已失效";
	} else if (state.mode === "single") {
		state.header.title.textContent = "账户";
		state.header.sub.textContent = "当前是单机模式";
	} else if (state.mode === "error") {
		state.header.title.textContent = "账户";
		state.header.sub.textContent = "账户信息暂时不可用";
	} else {
		state.header.title.textContent = "账户";
		state.header.sub.textContent = "正在读取账户…";
	}
}

function renderTabs() {
	if (!state.header) return;
	const tabs = state.header.tabs;
	tabs.replaceChildren();
	if (state.mode !== "account" || !isAdmin()) {
		tabs.classList.add("hidden");
		return;
	}
	tabs.classList.remove("hidden");
	const items = [
		["account", "账户"],
		["stats", "总览"],
		["users", "用户"],
		["audit", "审计"],
	];
	for (const [id, label] of items) {
		const tab = button(label, "account-tab" + (state.tab === id ? " is-on" : ""), () => switchTab(id));
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", state.tab === id ? "true" : "false");
		tab.dataset.tab = id;
		tabs.append(tab);
	}
}

function renderAll() {
	if (!state.dialog) return;
	state.dialog.classList.toggle("is-admin", state.mode === "account" && isAdmin());
	renderHeader();
	renderTabs();
	renderBody();
}

function renderBody() {
	const body = state.body;
	if (!body) return;
	body.replaceChildren();
	const flashHost = el("div", "account-flash-host");
	flashHost.append(...flashContent());
	body.append(flashHost);
	if (state.notice) body.append(noticeNode());

	if (state.loading) {
		body.append(empty("正在读取账户…"));
		return;
	}
	if (state.mode === "connect") {
		body.append(connectView());
		return;
	}
	if (state.mode === "expired") {
		body.append(expiredView());
		return;
	}
	if (state.mode === "single") {
		body.append(singleView());
		return;
	}
	if (state.mode === "error") {
		body.append(errorView());
		return;
	}
	if (!state.user) {
		body.append(empty("账户信息还没有回来，请稍后重试。"));
		return;
	}

	if (state.tab === "stats" && isAdmin()) {
		body.append(statsView());
		return;
	}
	if (state.tab === "users" && isAdmin()) {
		body.append(usersView());
		return;
	}
	if (state.tab === "audit" && isAdmin()) {
		body.append(auditView());
		return;
	}
	body.append(accountView());
}

// ── 打开与加载 ──────────────────────────────────────────────

async function openAccount() {
	if (!state.dialog) buildDialog();
	state.tab = "account";
	state.flash = null;
	state.notice = null;
	state.mode = "loading";
	state.loading = true;
	renderAll();
	if (!state.dialog.open) state.dialog.showModal();
	await loadAccount();
}

async function loadAccount() {
	state.loading = true;
	state.mode = "loading";
	renderAll();

	try {
		if (window.__DSH_LOCAL_MODE__ === true && !window.__NOVEL_CLOUD__) {
			state.user = null;
			state.mode = isTauri() ? "connect" : "single";
			return;
		}

		await loadAuthConfig();
		const data = await api("/api/auth/me");
		if (data && data.mode === "multi" && data.user) {
			applyUser(data.user);
			state.usage = data.usage || state.usage;
			state.mode = "account";
			await loadUsageAndSessions();
		} else if (data && (data.mode === "single" || data.mode === "local")) {
			state.user = null;
			state.sessions = [];
			state.mode = window.__NOVEL_CLOUD__ ? "single" : isTauri() ? "connect" : "single";
		} else {
			state.user = null;
			state.mode = isTauri() ? "connect" : "single";
		}
	} catch (error) {
		const status = Number(error && error.status);
		if (status === 401) {
			state.user = null;
			state.sessions = [];
			// Tauri 本地模式还没有云端配置：401 是本地接口“不认识账号”，
			// 应当引导连接云端，而不是说登录失效。
			state.mode = isTauri() && !window.__NOVEL_CLOUD__ ? "connect" : "expired";
		} else if (status === 403) {
			state.user = null;
			state.sessions = [];
			state.mode = isTauri() && !window.__NOVEL_CLOUD__ ? "connect" : "expired";
			setFlash(apiErrorMessage(error), "error");
		} else if (window.__NOVEL_CLOUD__) {
			state.mode = "error";
			setFlash(apiErrorMessage(error), "error");
		} else if (isTauri()) {
			state.mode = "connect";
			setFlash(apiErrorMessage(error), "error");
		} else {
			state.mode = "single";
		}
	} finally {
		state.loading = false;
		renderAll();
	}
}

async function refreshAccount() {
	await loadAccount();
}

// ── 普通账户页 ──────────────────────────────────────────────

function accountView() {
	const wrap = el("div", "account-page");
	wrap.append(quotaSection());
	wrap.append(sessionsSection());
	wrap.append(passwordSection());
	wrap.append(profileSection());
	wrap.append(cloudSection());
	wrap.append(logoutSection());
	return wrap;
}

function quotaSection() {
	const usage = state.usage || {};
	const quota = Number(usage.quotaBytes !== undefined ? usage.quotaBytes : state.user && state.user.quotaBytes);
	const used = Number(usage.usedBytes) || 0;
	const unlimited = !Number.isFinite(quota) || quota <= 0;
	const percent = unlimited ? 0 : Math.min(100, Math.max(0, (used / quota) * 100));
	const over = !unlimited && used > quota;

	const { sec, head } = section("云端用量", "配额按账号计算，作品、素材与记录都算在里面。");
	const refresh = button("刷新", "btn btn-quiet btn-sm", () => {
		void runAction(refresh, async () => {
			await loadUsageAndSessions();
			renderBody();
		});
	});
	head.append(refresh);

	const top = el("div", "account-quota-top");
	top.append(el("span", "account-quota-used", formatBytes(used)));
	top.append(el("span", "account-quota-total", unlimited ? "不限容量" : "/ " + formatBytes(quota)));
	sec.append(top);

	const bar = el("div", "account-bar");
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	bar.setAttribute("aria-valuenow", String(Math.round(percent)));
	const fill = el("span", "account-bar-fill" + (over ? " is-over" : percent >= 85 ? " is-warn" : ""));
	fill.style.width = (unlimited ? 100 : percent) + "%";
	bar.append(fill);
	sec.append(bar);

	const note = el(
		"p",
		"account-quota-note",
		unlimited ? "这个账号没有设置容量上限。" : "已用 " + percent.toFixed(percent >= 10 ? 0 : 1) + "%" + (over ? "，已超出配额。" : "。"),
	);
	sec.append(note);

	const labels = {
		projects: "作品",
		library: "素材库",
		sources: "原文",
		records: "记录",
		settings: "设置",
		other: "其它",
	};
	const breakdown = usage.breakdown && typeof usage.breakdown === "object" ? usage.breakdown : {};
	const grid = el("div", "account-breakdown");
	for (const key of Object.keys(labels)) {
		const item = el("div", "account-breakdown-item");
		item.append(el("span", "account-breakdown-label", labels[key]));
		item.append(el("span", "account-breakdown-value", formatBytes(breakdown[key])));
		grid.append(item);
	}
	sec.append(grid);
	if (usage.updatedAt) sec.append(el("p", "account-muted", "用量更新于 " + formatTime(usage.updatedAt)));
	return sec;
}

function sessionsSection() {
	const { sec, head } = section("管理设备", "当前登录的设备；不认识的设备可以立刻撤销。");
	const actions = el("div", "account-section-actions");
	const refresh = button("刷新", "btn btn-quiet btn-sm", () => {
		void runAction(refresh, async () => {
			state.sessions = await fetchSessions();
			renderBody();
		});
	});
	actions.append(refresh);
	if (state.sessions.length > 1) {
		const revokeOthers = button("撤销其它设备", "btn btn-quiet btn-sm", () => {
			if (!window.confirm("撤销除当前设备外的所有登录？其它设备需要重新登录。")) return;
			void runBusy(revokeOthers, "正在撤销…", async () => {
				await revokeOtherSessions();
				state.sessions = state.sessions.filter((session) => session.current);
				setFlash("其它设备已退出登录。", "ok");
				renderBody();
			});
		});
		actions.append(revokeOthers);
	}
	head.append(actions);

	if (!state.sessions.length) {
		sec.append(empty("还没有设备记录。"));
		return sec;
	}

	const list = el("div", "account-sessions");
	for (const session of state.sessions) {
		const row = el("div", "account-session");
		const main = el("div", "account-session-main");
		const title = el("div", "account-session-title");
		const client = session.client && CLIENT_LABELS[session.client] ? CLIENT_LABELS[session.client] : session.client || "未知客户端";
		title.append(el("strong", "", client));
		if (session.device) title.append(el("span", "account-session-device", session.device));
		if (session.current) title.append(badge("当前设备", "current"));
		main.append(title);
		const meta = [
			session.ip ? "IP " + session.ip : "",
			"最近 " + formatTime(session.lastSeenAt),
			session.createdAt ? "登录于 " + formatTime(session.createdAt) : "",
		]
			.filter(Boolean)
			.join(" · ");
		main.append(el("p", "account-session-meta", meta));
		row.append(main);
		if (!session.current) {
			const revoke = button("撤销", "btn btn-quiet btn-sm", () => {
				if (!window.confirm("撤销这台设备的登录？它需要重新登录才能继续使用。")) return;
				void runBusy(revoke, "撤销中…", async () => {
					await revokeSession(session.id);
					state.sessions = state.sessions.filter((item) => String(item.id) !== String(session.id));
					setFlash("已撤销该设备的登录。", "ok");
					renderBody();
				});
			});
			row.append(revoke);
		}
		list.append(row);
	}
	sec.append(list);
	return sec;
}

function passwordSection() {
	const { sec } = section("修改密码", "修改成功后，其它设备上的登录会被撤销。");
	const form = document.createElement("form");
	form.className = "account-form";
	const current = textInput("password", "currentPassword", "current-password", "现在的密码");
	const next = textInput("password", "newPassword", "new-password", "新密码（至少 " + state.authConfig.minPasswordLength + " 位）");
	const confirm = textInput("password", "confirmPassword", "new-password", "再输一次新密码");
	form.append(
		field("当前密码", current),
		field("新密码", next),
		field("确认新密码", confirm),
	);
	const submit = el("button", "btn btn-ink btn-sm", "更新密码");
	submit.type = "submit";
	const actions = el("div", "account-form-actions");
	actions.append(submit);
	form.append(actions);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!current.value) {
			setFlash("请填写当前密码。", "error");
			current.focus();
			return;
		}
		if (next.value.length < state.authConfig.minPasswordLength) {
			setFlash("新密码至少需要 " + state.authConfig.minPasswordLength + " 位。", "error");
			next.focus();
			return;
		}
		if (next.value !== confirm.value) {
			setFlash("两次输入的新密码不一样。", "error");
			confirm.focus();
			return;
		}
		void runBusy(submit, "正在更新…", async () => {
			await changePassword(current.value, next.value);
			form.reset();
			setFlash("密码已更新，其它设备已退出登录。", "ok");
			await loadUsageAndSessions();
			renderBody();
		});
	});
	sec.append(form);
	return sec;
}

function profileSection() {
	const { sec } = section("修改昵称", "昵称只影响展示，不影响登录邮箱。");
	const form = document.createElement("form");
	form.className = "account-form";
	const displayName = textInput("text", "displayName", "nickname", "怎么称呼你");
	displayName.value = state.user && state.user.displayName ? state.user.displayName : "";
	displayName.maxLength = 40;
	form.append(field("昵称", displayName));
	const submit = el("button", "btn btn-quiet btn-sm", "保存昵称");
	submit.type = "submit";
	const actions = el("div", "account-form-actions");
	actions.append(submit);
	form.append(actions);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = displayName.value.trim();
		if (!value) {
			setFlash("昵称不能为空。", "error");
			displayName.focus();
			return;
		}
		void runBusy(submit, "正在保存…", async () => {
			const data = await updateProfile({ displayName: value });
			const updated = data && data.user ? data.user : { ...state.user, displayName: value };
			applyUser({ ...state.user, ...updated });
			setFlash("昵称已更新。", "ok");
			renderAll();
		});
	});
	sec.append(form);
	return sec;
}

function cloudSection() {
	if (!window.__NOVEL_CLOUD__) return el("span");
	const base = (getCloudConfig() && getCloudConfig().base) || (typeof window.__NOVEL_CLOUD__.base === "string" ? window.__NOVEL_CLOUD__.base : "");
	const { sec } = section("云端连接", base ? "正在使用 " + base : "正在使用云端模式。");
	const disconnect = button("断开云端", "btn btn-quiet btn-sm", () => {
		if (!window.confirm("断开后这台设备会回到本地模式；云端上的作品不会被删除。继续？")) return;
		clearCloudConfig();
		window.location.reload();
	});
	sec.append(disconnect);
	sec.append(el("p", "account-muted", "断开后可以再用顶栏「账户」重新连接。"));
	return sec;
}

function logoutSection() {
	const { sec } = section("退出登录", "退出后需要重新输入账号密码。");
	const quit = button("退出登录", "btn btn-danger btn-sm", () => {
		if (!window.confirm("退出当前账号？")) return;
		void runBusy(quit, "正在退出…", async () => {
			if (window.__NOVEL_CLOUD__) {
				try {
					await logout();
				} catch {
					// 云端 token 可能已经失效；本地配置仍然要清掉。
				}
				clearCloudConfig();
				window.location.reload();
				return;
			}
			await logout();
			window.location.reload();
		});
	});
	sec.append(quit);
	return sec;
}

// ── 连接云端 ────────────────────────────────────────────────

function connectView() {
	const wrap = el("div", "account-page");
	wrap.append(
		pageHead(
			"连接云端账号",
			"这台设备现在用的是本地数据。填入云端服务器地址并登录后，作品会保存到云端，多台设备共用同一个账号。",
		),
	);

	const form = document.createElement("form");
	form.className = "account-form account-connect-form";

	const server = textInput("url", "server", "url", DEFAULT_CLOUD_BASE);
	server.spellcheck = false;
	server.autocapitalize = "off";
	// 预填官方地址；上次连过的服务器优先，用户手填的地址会覆盖默认值。
	const remembered =
		(getCloudConfig() && getCloudConfig().base) ||
		(typeof window.__NOVEL_CLOUD__?.base === "string" ? window.__NOVEL_CLOUD__.base : "");
	server.value = remembered || DEFAULT_CLOUD_BASE;
	const serverField = field(
		"服务器地址",
		server,
		"默认已填官方地址，直接登录即可；换用自建服务器时改成自己的域名，会覆盖默认值。",
	);
	const resetServer = button("用默认地址", "btn btn-quiet btn-xs account-server-reset", () => {
		server.value = DEFAULT_CLOUD_BASE;
		server.focus();
	});
	resetServer.type = "button";
	const serverHint = serverField.querySelector(".hint");
	if (serverHint) serverField.insertBefore(resetServer, serverHint);
	else serverField.append(resetServer);
	form.append(serverField);

	const modeRow = el("div", "account-seg");
	const loginTab = button("登录", "account-seg-item is-on", () => setMode("login"));
	const registerTab = button("注册", "account-seg-item", () => setMode("register"));
	if (state.authConfig.registration === "closed") registerTab.classList.add("hidden");
	modeRow.append(loginTab, registerTab);
	form.append(modeRow);

	const account = textInput("text", "account", "username", "邮箱或用户名");
	const accountField = field("邮箱或用户名", account);
	const email = textInput("email", "email", "email", "you@example.com");
	const emailField = field("邮箱", email);
	const display = textInput("text", "displayName", "nickname", "怎么称呼你（可选）");
	const displayField = field("昵称（可选）", display);
	const password = textInput("password", "password", "current-password", "密码");
	const passwordHint = el("p", "hint", "至少 " + state.authConfig.minPasswordLength + " 位");
	const passwordField = field("密码", password);
	passwordField.append(passwordHint);
	form.append(accountField, emailField, displayField, passwordField);

	const status = el("p", "account-connect-status hidden");
	status.setAttribute("role", "alert");
	form.append(status);

	const submit = el("button", "btn btn-ink", "登录");
	submit.type = "submit";
	const actions = el("div", "account-form-actions");
	actions.append(submit);
	form.append(actions);

	const note = el("p", "account-note");
	note.textContent =
		state.authConfig.registration === "closed"
			? "当前仅管理员可建号。"
			: "首次连接会先在这台设备上保存服务器地址和登录令牌；之后打开会直接进入云端。";
	form.append(note);

	let mode = "login";

	const setStatus = (text, tone = "error") => {
		if (!text) {
			status.textContent = "";
			status.className = "account-connect-status hidden";
			return;
		}
		status.textContent = text;
		status.className = "account-connect-status is-" + tone;
	};

	const setMode = (next) => {
		mode = next === "register" ? "register" : "login";
		const registering = mode === "register";
		accountField.classList.toggle("hidden", registering);
		emailField.classList.toggle("hidden", !registering);
		displayField.classList.toggle("hidden", !registering);
		passwordHint.classList.toggle("hidden", !registering);
		password.autocomplete = registering ? "new-password" : "current-password";
		loginTab.classList.toggle("is-on", !registering);
		registerTab.classList.toggle("is-on", registering);
		submit.textContent = registering ? "注册并连接" : "登录并连接";
		setStatus("");
		if (!registering) setTimeout(() => account.focus(), 0);
		else setTimeout(() => email.focus(), 0);
	};

	setMode(state.connectMode || "login");
	state.connectMode = mode;

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (state.busy) return;
		setStatus("");
		const base = normalizeCloudBase(server.value);
		if (!base) {
			setStatus("请填写云端服务器地址。");
			server.focus();
			return;
		}
		if (mode === "login") {
			if (!account.value.trim()) {
				setStatus("请填写邮箱或用户名。");
				account.focus();
				return;
			}
			if (!password.value) {
				setStatus("请填写密码。");
				password.focus();
				return;
			}
		} else {
			const address = email.value.trim();
			if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
				setStatus("请填写有效的邮箱地址。");
				email.focus();
				return;
			}
			if (password.value.length < state.authConfig.minPasswordLength) {
				setStatus("密码至少需要 " + state.authConfig.minPasswordLength + " 位。");
				password.focus();
				return;
			}
		}

		state.busy = true;
		submit.disabled = true;
		submit.textContent = mode === "login" ? "正在登录…" : "正在注册…";
		const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
		const payload =
			mode === "login"
				? { account: account.value.trim(), password: password.value }
				: {
						email: email.value.trim(),
						password: password.value,
						...(display.value.trim() ? { displayName: display.value.trim() } : {}),
					};
		const result = await postRemote(base, path, payload);
		state.busy = false;
		submit.disabled = false;
		submit.textContent = mode === "login" ? "登录并连接" : "注册并连接";

		if (!result.ok) {
			setStatus(errorText(result.status, result.data));
			return;
		}
		const data = result.data && typeof result.data === "object" ? result.data : {};
		if (!data.token || typeof data.token !== "string") {
			setStatus("登录成功，但服务端没有返回登录令牌。请确认服务端以云端模式运行，并允许原生客户端连接。");
			return;
		}
		try {
			setCloudConfig({ base, token: data.token });
		} catch (error) {
			setStatus("登录成功，但保存云端配置失败：" + (error && error.message ? error.message : "存储不可用"));
			return;
		}
		window.location.reload();
	});

	wrap.append(form);
	return wrap;
}

async function postRemote(base, path, payload) {
	try {
		const headers = {
			accept: "application/json",
			"content-type": "application/json; charset=utf-8",
		};
		if (window.__TAURI_INTERNALS__) headers["x-novel-client"] = "native";
		const response = await fetch(base + path, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			credentials: "same-origin",
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
		return { ok: false, status: 0, data: null };
	}
}

// ── 失效 / 单机 / 错误 ──────────────────────────────────────

function expiredView() {
	const wrap = el("div", "account-page");
	wrap.append(pageHead("登录已失效", "这台设备上的登录令牌已经失效或过期，需要重新登录。"));
	const actions = el("div", "account-form-actions");
	const retry = button("重新登录", "btn btn-ink btn-sm", () => window.location.reload());
	actions.append(retry);
	if (window.__NOVEL_CLOUD__) {
		const disconnect = button("断开云端", "btn btn-quiet btn-sm", () => {
			if (!window.confirm("断开云端后回到本地模式；云端数据不受影响。继续？")) return;
			clearCloudConfig();
			window.location.reload();
		});
		actions.append(disconnect);
	}
	wrap.append(actions);
	return wrap;
}

function errorView() {
	const wrap = el("div", "account-page");
	wrap.append(pageHead("账户暂时读不到", "云端可能正在重启，或者网络不通。稍后重试即可。"));
	const actions = el("div", "account-form-actions");
	const retry = button("重试", "btn btn-ink btn-sm", () => {
		void refreshAccount();
	});
	actions.append(retry);
	if (window.__NOVEL_CLOUD__) {
		const disconnect = button("断开云端", "btn btn-quiet btn-sm", () => {
			if (!window.confirm("断开云端后回到本地模式；云端数据不受影响。继续？")) return;
			clearCloudConfig();
			window.location.reload();
		});
		actions.append(disconnect);
	}
	wrap.append(actions);
	return wrap;
}

function singleView() {
	const wrap = el("div", "account-page");
	wrap.append(
		pageHead(
			"当前是单机模式",
			window.__NOVEL_CLOUD__ ? "这个服务器运行在单机模式，不需要账号；也可以断开云端回到本机。" : "数据保存在这台电脑上，不需要登录。",
		),
	);
	if (window.__NOVEL_CLOUD__) {
		const disconnect = button("断开云端", "btn btn-quiet btn-sm", () => {
			if (!window.confirm("断开云端后回到本地模式；云端数据不受影响。继续？")) return;
			clearCloudConfig();
			window.location.reload();
		});
		wrap.append(disconnect);
	}
	return wrap;
}

// ── 通知 ────────────────────────────────────────────────────

function noticeNode() {
	const box = el("div", "account-notice");
	const main = el("div", "account-notice-main");
	main.append(el("strong", "account-notice-title", state.notice.title || "提示"));
	if (state.notice.hint) main.append(el("p", "account-notice-hint", state.notice.hint));
	if (state.notice.password) {
		const row = el("div", "account-copy-row");
		const value = document.createElement("input");
		value.type = "text";
		value.readOnly = true;
		value.value = state.notice.password;
		value.className = "account-copy-value";
		const copy = button("复制", "btn btn-quiet btn-sm", async () => {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(state.notice.password);
				else {
					value.select();
					document.execCommand("copy");
				}
				copy.textContent = "已复制";
			} catch {
				value.select();
				copy.textContent = "请手动复制";
			}
		});
		row.append(value, copy);
		main.append(row);
	}
	const close = button("×", "account-notice-close", () => {
		state.notice = null;
		renderAll();
	});
	close.setAttribute("aria-label", "关闭通知");
	box.append(main, close);
	return box;
}

// ── 管理员：总览 ────────────────────────────────────────────

function statsView() {
	const wrap = el("div", "account-page");
	const refresh = button("刷新", "btn btn-quiet btn-sm", () => {
		void loadStats();
	});
	wrap.append(pageHead("总览", "云端用户的容量与状态。", refresh));

	if (state.admin.statsLoading && !state.admin.stats) {
		wrap.append(empty("正在读取统计…"));
		return wrap;
	}
	const data = state.admin.stats;
	if (!data) {
		wrap.append(empty("还没有读到统计数据。"));
		return wrap;
	}

	const grid = el("div", "account-stat-grid");
	grid.append(statCard("用户", String(data.users ?? 0), "已启用 " + (data.activeUsers ?? 0) + " · 已停用 " + (data.disabledUsers ?? 0)));
	grid.append(statCard("已用容量", formatBytes(data.totalUsedBytes), "所有账号合计"));
	grid.append(
		statCard(
			"总配额",
			Number(data.totalQuotaBytes) > 0 ? formatBytes(data.totalQuotaBytes) : "不限",
			Number(data.totalQuotaBytes) > 0 ? "按账号配额合计" : "至少一个账号不限容量",
		),
	);
	if (data.dataDir) {
		const dir = statCard("数据目录", "", "服务端保存云端数据的位置");
		const value = el("code", "account-code", data.dataDir);
		dir.querySelector(".account-stat-value").replaceChildren(value);
		grid.append(dir);
	}
	wrap.append(grid);
	return wrap;
}

function statCard(label, value, hint) {
	const card = el("div", "account-stat");
	card.append(el("span", "account-stat-label", label));
	card.append(el("strong", "account-stat-value", value));
	if (hint) card.append(el("span", "account-stat-hint", hint));
	return card;
}

async function loadStats() {
	state.admin.statsLoading = true;
	renderAll();
	try {
		state.admin.stats = await fetchStats();
	} catch (error) {
		setFlash(apiErrorMessage(error), "error");
	} finally {
		state.admin.statsLoading = false;
		renderAll();
	}
}

// ── 管理员：用户 ────────────────────────────────────────────

function usersView() {
	const wrap = el("div", "account-page");
	const refresh = button("刷新", "btn btn-quiet btn-sm", () => {
		void loadUsers();
	});
	wrap.append(pageHead("用户", "共 " + state.admin.total + " 个账号。", refresh));
	wrap.append(searchForm());
	wrap.append(createUserDetails());

	if (state.admin.usersLoading && !state.admin.users.length) {
		wrap.append(empty("正在读取用户…"));
		return wrap;
	}
	if (!state.admin.users.length) {
		wrap.append(empty(state.admin.query ? "没有匹配的用户。" : "还没有用户。"));
		return wrap;
	}

	const list = el("div", "account-users");
	for (const user of state.admin.users) list.append(userRow(user));
	wrap.append(list);
	wrap.append(pager());
	return wrap;
}

function searchForm() {
	const form = document.createElement("form");
	form.className = "account-search";
	const input = document.createElement("input");
	input.type = "search";
	input.placeholder = "搜索邮箱、用户名或昵称";
	input.value = state.admin.query;
	const submit = el("button", "btn btn-quiet btn-sm", "搜索");
	submit.type = "submit";
	form.append(input, submit);
	if (state.admin.query) {
		form.append(
			button("清除", "btn btn-quiet btn-sm", () => {
				state.admin.query = "";
				state.admin.offset = 0;
				void loadUsers();
			}),
		);
	}
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		state.admin.query = input.value.trim();
		state.admin.offset = 0;
		void loadUsers();
	});
	return form;
}

function createUserDetails() {
	const details = document.createElement("details");
	details.className = "account-details";
	details.append(el("summary", "account-details-summary", "新建用户"));

	const form = document.createElement("form");
	form.className = "account-form account-create-form";
	const email = textInput("email", "email", "email", "you@example.com");
	const password = textInput("password", "password", "new-password", "留空则自动生成");
	const displayName = textInput("text", "displayName", "nickname", "怎么称呼（可选）");
	const role = document.createElement("select");
	role.append(new Option("普通用户", "user"), new Option("管理员", "admin"));
	const quota = textInput("number", "quotaMb", "", "0 表示不限");
	quota.min = "0";
	quota.step = "1";

	form.append(
		field("邮箱", email),
		field("初始密码", password),
		field("昵称（可选）", displayName),
		field("角色", role),
		field("配额（MB）", quota, "留空使用服务端默认值，0 表示不限。"),
	);
	const submit = el("button", "btn btn-ink btn-sm", "新建用户");
	submit.type = "submit";
	const actions = el("div", "account-form-actions");
	actions.append(submit);
	form.append(actions);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const address = email.value.trim();
		if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
			setFlash("请填写有效的邮箱地址。", "error");
			email.focus();
			return;
		}
		const payload = { email: address, role: role.value };
		if (password.value) payload.password = password.value;
		if (displayName.value.trim()) payload.displayName = displayName.value.trim();
		if (quota.value.trim() !== "") {
			const mb = Number(quota.value);
			if (!Number.isFinite(mb) || mb < 0) {
				setFlash("配额要填 0 或正数（单位 MB）。", "error");
				quota.focus();
				return;
			}
			payload.quotaBytes = Math.round(mb * 1024 * 1024);
		}
		void runBusy(submit, "正在创建…", async () => {
			const data = await createUser(payload);
			const created = data && data.user ? data.user : null;
			state.notice = {
				title: "用户已创建" + (created && created.email ? "：" + created.email : ""),
				password: data && data.password ? data.password : "",
				hint: data && data.password ? "一次性密码只显示这一次，请现在交给对方。" : "",
			};
			state.admin.query = "";
			state.admin.offset = 0;
			await loadUsers();
		});
	});

	details.append(form);
	return details;
}

function userRow(user) {
	const card = el("article", "account-user");
	const head = el("div", "account-user-head");
	const identity = el("div", "account-user-identity");
	identity.append(el("strong", "account-user-name", displayNameOf(user)));
	identity.append(el("span", "account-user-email", user.email || ""));
	head.append(identity);
	const badges = el("div", "account-user-badges");
	badges.append(badge(roleText(user.role), user.role === "admin" ? "admin" : "user"));
	badges.append(badge(user.status === "disabled" ? "已停用" : "已启用", user.status === "disabled" ? "off" : "on"));
	head.append(badges);
	card.append(head);

	const quota = Number(user.quotaBytes) || 0;
	const meta = [
		"用量 " + formatBytes(user.usedBytes) + " / " + (quota > 0 ? formatBytes(quota) : "不限"),
		"会话 " + (user.sessionCount ?? 0),
		"最近 " + formatTime(user.lastSeenAt),
	].join(" · ");
	card.append(el("p", "account-user-meta", meta));

	const actions = el("div", "account-user-actions");

	const roleWrap = el("label", "account-inline");
	roleWrap.append(el("span", "", "角色"));
	const role = document.createElement("select");
	role.append(new Option("普通用户", "user"), new Option("管理员", "admin"));
	role.value = user.role === "admin" ? "admin" : "user";
	role.addEventListener("change", () => {
		const next = role.value;
		void runAction(role, async () => {
			try {
				const data = await patchUser(user.id, { role: next });
				replaceAdminUser(data && data.user ? data.user : { ...user, role: next });
				setFlash("角色已更新。", "ok");
				renderBody();
			} catch (error) {
				role.value = user.role === "admin" ? "admin" : "user";
				throw error;
			}
		});
	});
	roleWrap.append(role);
	actions.append(roleWrap);

	const quotaWrap = el("label", "account-inline");
	quotaWrap.append(el("span", "", "配额 MB"));
	const quotaInput = document.createElement("input");
	quotaInput.type = "number";
	quotaInput.min = "0";
	quotaInput.step = "1";
	quotaInput.value = quota > 0 ? String(Math.round((quota / 1024 / 1024) * 100) / 100) : "";
	quotaInput.placeholder = "0 不限";
	quotaInput.className = "account-quota-input";
	const saveQuota = button("存", "btn btn-quiet btn-sm", () => {
		const raw = quotaInput.value.trim();
		const mb = raw === "" ? 0 : Number(raw);
		if (!Number.isFinite(mb) || mb < 0) {
			setFlash("配额要填 0 或正数（单位 MB）。", "error");
			quotaInput.focus();
			return;
		}
		void runBusy(saveQuota, "…", async () => {
			const bytes = Math.round(mb * 1024 * 1024);
			const data = await patchUser(user.id, { quotaBytes: bytes });
			replaceAdminUser(data && data.user ? data.user : { ...user, quotaBytes: bytes });
			setFlash("配额已更新。", "ok");
			renderBody();
		});
	});
	quotaWrap.append(quotaInput, saveQuota);
	actions.append(quotaWrap);

	const toggle = button(user.status === "disabled" ? "启用" : "停用", "btn btn-quiet btn-sm", () => {
		const next = user.status === "disabled" ? "active" : "disabled";
		if (next === "disabled" && !window.confirm("停用 " + (user.email || "这个账号") + "？该账号会立刻无法登录。")) return;
		void runBusy(toggle, "…", async () => {
			const data = await patchUser(user.id, { status: next });
			replaceAdminUser(data && data.user ? data.user : { ...user, status: next });
			setFlash(next === "disabled" ? "账号已停用。" : "账号已启用。", "ok");
			renderBody();
		});
	});
	actions.append(toggle);

	const reset = button("重置密码", "btn btn-quiet btn-sm", () => {
		if (!window.confirm("给 " + (user.email || "这个账号") + " 生成一个新密码？旧密码会立刻失效。")) return;
		void runBusy(reset, "重置中…", async () => {
			const data = await resetPassword(user.id);
			if (!data || !data.password) throw new Error("服务端没有返回一次性密码，请重试。");
			state.notice = {
				title: "已为 " + (user.email || "该账号") + " 重置密码",
				password: data.password,
				hint: "一次性密码只显示这一次，请现在交给对方。",
			};
			renderAll();
		});
	});
	actions.append(reset);

	const remove = button("删除", "btn btn-danger btn-sm", () => {
		if (!window.confirm("删除用户 " + (user.email || "") + "？账号将无法再登录，云端数据不会被删除。")) return;
		void runBusy(remove, "删除中…", async () => {
			await deleteUser(user.id);
			state.admin.users = state.admin.users.filter((item) => String(item.id) !== String(user.id));
			state.admin.total = Math.max(0, state.admin.total - 1);
			if (!state.admin.users.length && state.admin.offset > 0) state.admin.offset = Math.max(0, state.admin.offset - state.admin.limit);
			setFlash("用户已删除。", "ok");
			await loadUsers();
		});
	});
	actions.append(remove);

	card.append(actions);
	return card;
}

function pager() {
	const bar = el("div", "account-pager");
	const start = state.admin.total === 0 ? 0 : state.admin.offset + 1;
	const end = Math.min(state.admin.total, state.admin.offset + state.admin.users.length);
	const previous = button("上一页", "btn btn-quiet btn-sm", () => {
		state.admin.offset = Math.max(0, state.admin.offset - state.admin.limit);
		void loadUsers();
	});
	previous.disabled = state.admin.offset <= 0;
	const next = button("下一页", "btn btn-quiet btn-sm", () => {
		state.admin.offset += state.admin.limit;
		void loadUsers();
	});
	next.disabled = state.admin.offset + state.admin.limit >= state.admin.total;
	bar.append(previous, el("span", "account-pager-info", "第 " + start + "–" + end + " 个 / 共 " + state.admin.total + " 个"), next);
	return bar;
}

async function loadUsers() {
	state.admin.usersLoading = true;
	state.tab = "users";
	renderAll();
	try {
		const data = await listUsers({
			query: state.admin.query,
			offset: state.admin.offset,
			limit: state.admin.limit,
		});
		state.admin.users = data && Array.isArray(data.users) ? data.users : [];
		state.admin.total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : state.admin.users.length;
		state.admin.usersLoaded = true;
	} catch (error) {
		setFlash(apiErrorMessage(error), "error");
	} finally {
		state.admin.usersLoading = false;
		renderAll();
	}
}

// ── 管理员：审计 ────────────────────────────────────────────

function auditView() {
	const wrap = el("div", "account-page");
	const refresh = button("刷新", "btn btn-quiet btn-sm", () => {
		void loadAudit();
	});
	wrap.append(pageHead("审计日志", "最近 100 条操作记录。", refresh));

	if (state.admin.auditLoading && !state.admin.audit.length) {
		wrap.append(empty("正在读取日志…"));
		return wrap;
	}
	if (!state.admin.audit.length) {
		wrap.append(empty("还没有审计记录。"));
		return wrap;
	}
	const list = el("div", "account-audit-list");
	for (const entry of state.admin.audit) list.append(auditRow(entry));
	wrap.append(list);
	return wrap;
}

function auditRow(entry) {
	const row = el("article", "account-audit-row");
	const head = el("div", "account-audit-head");
	const action = entry && entry.action ? AUDIT_LABELS[entry.action] || entry.action : "操作";
	head.append(el("strong", "account-audit-action", action));
	head.append(el("time", "account-audit-time", formatTime(entry && entry.at)));
	row.append(head);
	const meta = [entry && entry.userEmail ? entry.userEmail : "未知用户", entry && entry.ip ? "IP " + entry.ip : ""]
		.filter(Boolean)
		.join(" · ");
	row.append(el("p", "account-audit-meta", meta));
	if (entry && entry.detail !== undefined && entry.detail !== null && entry.detail !== "") {
		let detail = "";
		if (typeof entry.detail === "string") detail = entry.detail;
		else {
			try {
				detail = JSON.stringify(entry.detail);
			} catch {
				detail = String(entry.detail);
			}
		}
		if (detail) row.append(el("p", "account-audit-detail", detail));
	}
	return row;
}

async function loadAudit() {
	state.admin.auditLoading = true;
	state.tab = "audit";
	renderAll();
	try {
		const data = await audit(100, 0);
		state.admin.audit = data && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
	} catch (error) {
		setFlash(apiErrorMessage(error), "error");
	} finally {
		state.admin.auditLoading = false;
		renderAll();
	}
}

// ── 页签 ────────────────────────────────────────────────────

function switchTab(tab) {
	if (state.tab === tab && state.mode === "account") {
		// 再点当前页签也当作刷新。
	}
	state.tab = tab;
	state.flash = null;
	state.notice = null;
	renderAll();
	if (tab === "stats") void loadStats();
	else if (tab === "users") void loadUsers();
	else if (tab === "audit") void loadAudit();
}

// ── 顶栏按钮 ────────────────────────────────────────────────

function showButton() {
	if (!state.button) return;
	state.button.classList.remove("hidden");
	if (state.user) state.button.title = "账户：" + displayNameOf(state.user);
	else if (window.__NOVEL_CLOUD__) state.button.title = "账户与云端";
	else state.button.title = "连接云端账号";
}

async function refreshButton() {
	if (!state.button) return;
	const cached = window.__NOVEL_AUTH_STATE__;
	if (cached && cached.kind === "open" && cached.user) {
		applyUser(cached.user);
		if (cached.usage) state.usage = cached.usage;
		showButton();
		return;
	}

	// 登录门已经问过 /api/auth/me 并确认是单机/本地模式：这里不要再探一次，
	// 否则同源单机版每次启动都会多一个没有必要的 401/200 请求。
	if (cached && cached.kind === "open" && (cached.mode === "single" || cached.mode === "local")) {
		if (cached.mode === "local" && isTauri() && !window.__NOVEL_CLOUD__) showButton();
		return;
	}

	if (window.__DSH_LOCAL_MODE__ === true && !window.__NOVEL_CLOUD__) {
		if (isTauri()) showButton();
		return;
	}

	if (window.__NOVEL_CLOUD__) {
		showButton();
		try {
			const data = await api("/api/auth/me");
			if (data && data.mode === "multi" && data.user) {
				applyUser(data.user);
				state.usage = data.usage || state.usage;
			}
		} catch {
			// 打开面板时会再问一次，这里不打扰用户。
		}
		return;
	}

	// 同源 Cookie 模式：单机版没有账号接口就不显示按钮。
	try {
		const data = await api("/api/auth/me");
		if (data && data.mode === "multi" && data.user) {
			applyUser(data.user);
			state.usage = data.usage || state.usage;
			showButton();
		}
	} catch {
		// 单机模式、接口未部署、未登录：都不显示。
	}
}

/** app.js 绑设置的地方顺手调用；重复调用无副作用。 */
export function bindAccount() {
	if (state.booted) return;
	const target = document.getElementById("account-btn");
	if (!target) return;
	state.booted = true;
	state.button = target;
	target.addEventListener("click", () => {
		void openAccount();
	});
	void refreshButton();
}
