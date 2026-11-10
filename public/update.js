// 设置页「关于与更新」。
//
// 桌面端走 Tauri updater：先取 latest.json，再用 minisign 公钥校验安装包。
// 这一步必须由 Rust 侧完成，网页里的 JS 没有权限覆盖安装。Android/iOS
// 只做应用内下载 + 唤起系统安装器：安卓禁止静默安装，最后一步必须由用户确认；
// 网页版则随服务器部署更新。三种入口在同一个面板里说清楚，不假装统一。

const RELEASES_URL = "https://github.com/cttailearn/novel-studio/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/cttailearn/novel-studio/releases/latest";
const AUTO_CHECK_KEY = "mogeng.update.auto-check";
const AUTO_INSTALL_KEY = "mogeng.update.auto-install";

const state = {
	initialized: false,
	currentVersion: "",
	pref: true,
	autoInstall: true,
	checking: false,
	installing: false,
	stage: "",
	received: 0,
	total: 0,
	percent: 0,
	info: null,
	error: "",
};

const refs = {};

function $(id) {
	return document.getElementById(id);
}

function isTauri() {
	return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

function platformKind() {
	if (!isTauri()) return "web";
	if (/Android/i.test(navigator.userAgent)) return "android";
	if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return "ios";
	return "desktop";
}

async function invoke(name, args) {
	const core = window.__TAURI__?.core;
	const internals = window.__TAURI_INTERNALS__;
	const call = core?.invoke ?? internals?.invoke;
	if (typeof call !== "function") throw new Error("当前环境没有原生更新接口");
	return call(name, args);
}

async function listen(name, handler) {
	const api = window.__TAURI__?.event;
	const internals = window.__TAURI_INTERNALS__;
	const subscribe = api?.listen ?? internals?.listen;
	if (typeof subscribe !== "function") return null;
	return subscribe(name, (event) => handler(event?.payload));
}

function readPref() {
	try {
		return localStorage.getItem(AUTO_CHECK_KEY) !== "0";
	} catch {
		return true;
	}
}

function writePref(value) {
	try {
		localStorage.setItem(AUTO_CHECK_KEY, value ? "1" : "0");
	} catch {
		// 存不下就只在本次运行里生效；不影响检查更新本身。
	}
}

/** 发现新版后是否直接下载并安装。关掉就只提示，等用户点按钮。 */
function readAutoInstall() {
	try {
		return localStorage.getItem(AUTO_INSTALL_KEY) !== "0";
	} catch {
		return true;
	}
}

function writeAutoInstall(value) {
	try {
		localStorage.setItem(AUTO_INSTALL_KEY, value ? "1" : "0");
	} catch {
		// 同上。
	}
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function setStatus(text, tone = "") {
	if (!refs.status) return;
	refs.status.textContent = text;
	refs.status.className = `about-status${tone ? ` is-${tone}` : ""}`;
}

function formatDate(timestamp) {
	if (!timestamp) return "";
	const date = new Date(timestamp * 1000);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function compareVersions(left, right) {
	const parse = (value) =>
		String(value || "0")
			.replace(/^v/i, "")
			.split(/[.+-]/)
			.slice(0, 3)
			.map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
	}
	return 0;
}

function buildPanel() {
	const host = $("settings-about-panel");
	if (!host || host.childElementCount > 0) return;
	host.replaceChildren();

	const intro = el("div", "web-intro about-intro");
	intro.append(
		el("span", "settings-eyebrow", "VERSION & UPDATES"),
		el("h4", "", "让笔墨常新"),
		el("p", "", "在这里查看当前版本、检查新版，并在确认后下载安装。更新只读取版本清单，不会上传作品、素材或密钥。"),
	);
	const channel = el("span", "web-state", "");
	intro.append(channel);
	host.append(intro);

	const card = el("section", "about-card");
	const versionLine = el("div", "about-version-line");
	const versionBlock = el("div", "about-version-block");
	versionBlock.append(
		el("span", "about-version", "—"),
		el("span", "about-version-note", "当前版本"),
	);
	versionLine.append(versionBlock);
	const status = el("span", "about-status", "尚未检查");
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	versionLine.append(status);
	card.append(versionLine);

	const actions = el("div", "about-actions");
	const check = el("button", "btn btn-primary btn-sm", "检查更新");
	check.type = "button";
	check.addEventListener("click", () => void checkForUpdates(false));
	const release = el("a", "btn btn-ghost btn-sm", "打开发布页 ↗");
	release.href = RELEASES_URL;
	release.target = "_blank";
	release.rel = "noopener noreferrer";
	actions.append(check, release);
	card.append(actions);
	host.append(card);

	const autoSection = el("section", "web-section about-auto");
	autoSection.append(el("h5", "", "自动更新"));
	const autoLabel = el("label", "switch about-switch");
	const auto = document.createElement("input");
	auto.type = "checkbox";
	auto.addEventListener("change", () => {
		state.pref = auto.checked;
		writePref(auto.checked);
		setStatus(auto.checked ? "会在下次启动时自动检查" : "已关闭启动时自动检查");
	});
	autoLabel.append(auto, document.createTextNode(" 启动时自动检查更新"));

	const installLabel = el("label", "switch about-switch");
	const autoInstall = document.createElement("input");
	autoInstall.type = "checkbox";
	autoInstall.addEventListener("change", () => {
		state.autoInstall = autoInstall.checked;
		writeAutoInstall(autoInstall.checked);
		setStatus(
			autoInstall.checked
				? "发现新版会直接下载并安装，装完自动重启"
				: "发现新版只提示，等你点「下载并安装」",
		);
	});
	installLabel.append(autoInstall, document.createTextNode(" 发现新版后自动下载安装"));

	autoSection.append(autoLabel, installLabel);
	autoSection.append(
		el(
			"p",
			"settings-section-note",
			"安装包先经签名校验再交给系统安装器；安装完成后应用会自动关闭并重启，作品与素材不受影响。关掉自动下载后，仍可随时点「下载并安装」。",
		),
	);
	host.append(autoSection);

	const updateBox = el("section", "about-update");
	const updateHead = el("div", "about-update-head");
	const newVersion = el("strong", "", "");
	const updateDate = el("span", "about-update-date", "");
	updateHead.append(newVersion, updateDate);
	const notes = el("p", "about-notes", "");
	const install = el("button", "btn btn-ink btn-sm", "下载并安装更新");
	install.type = "button";
	install.addEventListener("click", () => void installUpdate());
	const download = el("a", "btn btn-ink btn-sm", "打开发布页下载 APK ↗");
	download.href = RELEASES_URL;
	download.target = "_blank";
	download.rel = "noopener noreferrer";
	const progress = el("div", "about-progress", "");
	progress.append(el("span", "", ""));
	progress.append(el("p", "", "正在下载并校验安装包，请保持网络连接…"));
	updateBox.append(updateHead, notes, install, download, progress);
	host.append(updateBox);

	const platformNote = el("p", "about-platform-note", "");
	host.append(platformNote);

	Object.assign(refs, {
		host,
		channel,
		version: versionBlock.querySelector(".about-version"),
		status,
		check,
		release,
		autoSection,
		auto,
		autoInstall,
		updateBox,
		newVersion,
		updateDate,
		notes,
		install,
		download,
		progress,
		platformNote,
	});
}

function sync() {
	if (!refs.host) return;
	const kind = platformKind();
	const info = state.info;
	const version = state.currentVersion ? `v${state.currentVersion}` : kind === "web" ? "网页版" : "—";

	refs.version.textContent = version;
	refs.channel.textContent =
		kind === "desktop" ? "桌面版" : kind === "android" ? "Android 版" : kind === "ios" ? "iOS 版" : "网页版";
	refs.channel.className = "web-state" + (info?.available ? " is-on" : "");
	refs.autoSection.hidden = kind !== "desktop";
	refs.auto.checked = state.pref;
	refs.autoInstall.checked = state.autoInstall;
	refs.check.hidden = kind === "web";
	refs.check.disabled = state.checking || state.installing;
	refs.check.textContent = state.checking ? "检查中…" : "检查更新";

	if (kind === "web") {
		setStatus("随服务器更新");
	} else if (state.error) {
		setStatus(state.error, "err");
	} else if (state.checking) {
		setStatus("正在检查…");
	} else if (state.installing) {
		setStatus(progressLine(), "warn");
	} else if (state.stage === "installed") {
		setStatus("安装完成，应用即将重启…", "ok");
	} else if (info?.available) {
		setStatus(`发现新版本 v${info.version}`, "ok");
	} else if (info) {
		setStatus("已是最新版本", "ok");
	} else {
		setStatus(kind === "desktop" ? "尚未检查" : "可手动检查新版");
	}

	const available = Boolean(info?.available);
	refs.updateBox.hidden = !available || kind === "web";
	refs.updateBox.classList.toggle("is-installing", state.installing);
	refs.install.hidden = kind !== "desktop" && kind !== "android";
	refs.install.disabled = state.installing;
	refs.install.textContent = state.installing
		? state.stage === "installing"
			? "正在安装…"
			: "正在下载…"
		: kind === "android"
			? "下载并安装"
			: "下载并安装更新";
	refs.download.hidden = kind === "desktop";
	refs.progress.hidden = !state.installing;
	if (state.installing) {
		const line = refs.progress.querySelector("span");
		if (line) line.textContent = progressLine();
		const note = refs.progress.querySelector("p");
		if (note) {
			note.textContent =
				state.stage === "installing"
					? "安装包已下载并通过签名校验，正在交给系统安装器；应用会自动重启。"
					: "正在下载并校验安装包，请保持网络连接…";
		}
	}
	if (available) {
		refs.newVersion.textContent = `v${info.version}`;
		refs.updateDate.textContent = formatDate(info.date);
		refs.notes.textContent = info.notes?.trim() || "这个版本没有附带更新说明。";
	} else {
		refs.newVersion.textContent = "";
		refs.updateDate.textContent = "";
		refs.notes.textContent = "";
	}

	if (kind === "desktop") {
		refs.platformNote.textContent = "桌面版使用签名安装包更新；安装完成后应用会自动重启。";
	} else if (kind === "android") {
		refs.platformNote.textContent =
			"下载完成后由系统安装器确认安装，作品与素材都会保留；也可以打开发布页手动下载 APK。";
	} else if (kind === "ios") {
		refs.platformNote.textContent = "iOS 版尚未提供安装包，请在发布页查看可用平台。";
	} else {
		refs.platformNote.textContent = "网页版由部署服务器统一更新，无需在这里安装。";
	}

	const dot = $("settings-update-nav-dot");
	if (dot) {
		dot.textContent = available ? "新" : "";
		dot.className = `settings-nav-dot${available ? " is-warn" : ""}`;
	}
}

async function loadVersion() {
	if (!isTauri()) return;
	try {
		state.currentVersion = String(await invoke("app_version"));
	} catch {
		// 版本号取不到时仍允许检查更新，Rust 侧会返回 currentVersion。
	}
}

async function checkViaGithub() {
	const response = await fetch(LATEST_RELEASE_API, {
		headers: { Accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`发布页返回 ${response.status}`);
	const release = await response.json();
	const latest = String(release.tag_name || "").replace(/^v/i, "");
	if (!latest) throw new Error("发布页没有版本号");
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const apk = assets.find(
		(asset) =>
			typeof asset?.name === "string" &&
			asset.name.endsWith("-android-arm64.apk") &&
			typeof asset.browser_download_url === "string",
	);
	const published = Date.parse(release.published_at || "");
	return {
		available: compareVersions(latest, state.currentVersion) > 0,
		currentVersion: state.currentVersion,
		version: latest,
		notes: release.body || "",
		date: Number.isNaN(published) ? null : Math.floor(published / 1000),
		assetUrl: apk?.browser_download_url || "",
	};
}

async function checkForUpdates(silent) {
	if (state.checking || state.installing) return;
	const kind = platformKind();
	if (kind === "web") return;
	state.checking = true;
	state.error = "";
	if (!silent) setStatus("正在检查…");
	sync();
	try {
		const info = kind === "desktop" ? await invoke("update_check") : await checkViaGithub();
		state.info = info;
		if (info?.currentVersion && !state.currentVersion) state.currentVersion = info.currentVersion;
		state.error = "";
		// 桌面端默认「发现新版就下载并安装」：静默检查也走这条路，
		// 用户下次打开就是新版本，不必再去设置页点一次。
		if (kind === "desktop" && info?.available && state.autoInstall && !state.installing) {
			window.setTimeout(() => {
				if (state.autoInstall) void installUpdate(true);
			}, 900);
		}
	} catch (error) {
		// 后台静默检查失败只记日志，不把「尚未检查」的干净状态改成红字；
		// 用户主动点检查时仍然要把失败原因说清楚。
		if (silent) console.warn("自动检查更新失败", error);
		else state.error = error instanceof Error ? error.message : String(error);
	} finally {
		state.checking = false;
		sync();
	}
}

/** 状态行文字：下载阶段给百分比与已下载量，安装阶段说明会重启。 */
function progressLine() {
	const size = (value) => `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (state.stage === "installing") return "正在安装，应用即将重启…";
	if (!state.received) return "正在准备下载…";
	if (state.total) return `已下载 ${state.percent}% · ${size(state.received)} / ${size(state.total)}`;
	return `已下载 ${size(state.received)}`;
}

async function installUpdate(auto = false) {
	if (state.installing) return;
	const kind = platformKind();

	if (kind === "desktop") {
		const version = state.info?.version ? `v${state.info.version}` : "新版本";
		if (!auto && !window.confirm(`将下载并安装 ${version}。安装完成后应用会自动关闭并重启，现在继续吗？`)) return;
		state.installing = true;
		state.stage = "downloading";
		state.received = 0;
		state.total = 0;
		state.percent = 0;
		state.error = "";
		sync();
		// 面板通常停在版本行，安装卡在折叠线以下：把它带进视野，
		// 否则「正在下载」只出现在按钮上，看着像没反应。
		refs.updateBox?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		let stop = null;
		try {
			stop = await listen("update-progress", (payload) => {
				const received = Number(payload?.received) || 0;
				const total = Number(payload?.total) || 0;
				const percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
				state.received = received;
				state.total = total;
				// 分块回调可能一秒几十次：只在百分比真的变了才重排界面；
				// 服务器没给总大小时退化成按字节数更新。
				if (total && percent === state.percent) return;
				state.percent = percent;
				sync();
			});
			await listen("update-stage", (stage) => {
				if (typeof stage === "string") {
					state.stage = stage;
					sync();
				}
			});
			await invoke("update_install");
			state.stage = "installed";
			state.percent = 100;
			state.installing = false;
			sync();
			setStatus("安装完成，应用即将重启…", "ok");
		} catch (error) {
			state.installing = false;
			state.stage = "";
			state.error = error instanceof Error ? error.message : String(error);
			sync();
		} finally {
			if (typeof stop === "function") stop();
		}
		return;
	}

	if (kind !== "android") return;
	const info = state.info;
	const assetUrl = info?.assetUrl || "";
	if (!assetUrl) {
		state.error = "发布页没有找到 Android 安装包，请打开发布页手动下载";
		sync();
		return;
	}
	const version = info?.version ? `v${info.version}` : "新版本";
	if (
		!window.confirm(
			`将下载 ${version} 的安装包，下载完成后由系统安装器安装，作品与素材都会保留。现在继续吗？`,
		)
	)
		return;

	state.installing = true;
	state.error = "";
	sync();
	let stop = null;
	let handedOff = false;
	try {
		stop = await listen("update-progress", (payload) => {
			const received = Number(payload?.received) || 0;
			const total = Number(payload?.total) || 0;
			const line = refs.progress?.querySelector("span");
			if (!line) return;
			const size = (value) => `${(value / 1024 / 1024).toFixed(1)} MB`;
			line.textContent = total
				? `已下载 ${Math.min(100, Math.round((received / total) * 100))}% · ${size(received)} / ${size(total)}`
				: `已下载 ${size(received)}`;
		});
		await invoke("android_install_update", { url: assetUrl, version: info.version });
		handedOff = true;
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
	} finally {
		state.installing = false;
		if (typeof stop === "function") stop();
		sync();
		// sync() 会按 state 重写状态行，所以这句放在它后面。
		if (handedOff) setStatus("安装包已交给系统，请按提示完成安装", "ok");
	}
}

function scheduleAutoCheck() {
	if (platformKind() !== "desktop" || !state.pref) return;
	// 启动时先让主界面把项目加载完，再悄悄查一次；失败不打扰用户。
	window.setTimeout(() => void checkForUpdates(true), 4500);
}

export function initUpdatePanel() {
	if (state.initialized) return;
	state.initialized = true;
	state.pref = readPref();
	state.autoInstall = readAutoInstall();
	buildPanel();
	sync();
	void loadVersion().then(() => {
		sync();
		scheduleAutoCheck();
	});
}

export function renderUpdatePanel() {
	buildPanel();
	sync();
}
