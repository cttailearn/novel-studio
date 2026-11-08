/*
 * 引导脚本（classic script，不是 module）：决定这个页面怎么取数据。
 *
 * 按优先级分成三种形态：
 *
 *   1. 云端账号（Tauri 与 Web 都适用）：localStorage["novel-studio/cloud"] 里有
 *      {"base":"https://novel.example.com","token":"..."}。这时**不接管** /api/*，
 *      也不注入本地模式，只把服务器地址与令牌挂到 window.__NOVEL_CLOUD__ 上；
 *      请求改写、登录浮层、令牌写回都由 auth-gate.js 负责。
 *
 *   2. 本地模式：没有云端配置时——Tauri 一律用本机 SQLite；浏览器里有 IndexedDB，
 *      并且 URL 带 ?local=1、或 localStorage["novel-studio/mode"] === "local"、
 *      或服务端注入了 window.__NOVEL_LOCAL_MODE__（STORAGE=idb 的部署）。
 *      这一形态下 /api/* 交给浏览器里的 /browser/local-api.js 处理，数据留在本机。
 *
 *   3. 服务器模式：以上都没有，请求照常打到服务器，服务端行为完全不受影响。
 *
 * 注意：/api/llm 是例外——它是流式转发上游模型的通道，本地模式下也仍然走真实网络。
 */
(function () {
	"use strict";

	var MODE_KEY = "novel-studio/mode";
	var CLOUD_KEY = "novel-studio/cloud";
	var LOCAL_API_MODULE = "/browser/local-api.js";

	/**
	 * console.warn 的兜底。
	 *
	 * 某些运行环境没有 console（例如测试里用的 vm 沙箱），引导脚本不该因为
	 * 想打一行日志就把整个页面带崩。
	 */
	function warn(message, error) {
		try {
			if (typeof console === "undefined" || !console || typeof console.warn !== "function") return;
			if (error === undefined) console.warn(message);
			else console.warn(message, error);
		} catch (err) {
			/* 日志失败不关引导的事 */
		}
	}

	/* ───────────────────────────────────────────── 云端账号 */

	/**
	 * 读云端配置。拿不到、解析不了、或 base 为空都当作"没有云端配置"。
	 *
	 * 存的是 {"base":"https://…","token":"…"} 这一层 JSON；坏数据（手改坏的、
	 * 老版本留下的字符串）只 warn 一次，不抛错——宁可让用户进本地模式，
	 * 也不要卡在一个打不开的页面上。
	 */
	function readCloudConfig() {
		var raw;
		try {
			raw = window.localStorage.getItem(CLOUD_KEY);
		} catch (err) {
			// 隐私模式 / 禁用存储时读取会抛错，按没有配置处理。
			return null;
		}
		if (!raw) return null;

		var parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			warn("[boot] 云端配置不是合法 JSON，已忽略（按本地模式处理）：", err);
			return null;
		}
		if (!parsed || typeof parsed !== "object") {
			warn("[boot] 云端配置格式不对（应为对象），已忽略");
			return null;
		}

		var base = typeof parsed.base === "string" ? parsed.base.trim() : "";
		if (!base) return null;
		return {
			base: base.replace(/\/+$/, ""),
			token: typeof parsed.token === "string" ? parsed.token : "",
		};
	}

	/** 把云端配置写回 localStorage；token 为空时只留 base。 */
	function persistCloud(base, token) {
		try {
			var value = { base: base };
			if (token) value.token = token;
			window.localStorage.setItem(CLOUD_KEY, JSON.stringify(value));
			return true;
		} catch (err) {
			warn("[boot] 云端配置写回失败，刷新后可能丢失登录态：", err);
			return false;
		}
	}

	/**
	 * 云端模式：只暴露地址与令牌，不动 fetch。
	 *
	 * 形状固定为 { base, token, setToken(t), clear() }：
	 *   - base 去掉了末尾斜杠，拼接时直接 `${base}/api/...`；
	 *   - token 是 Bearer 令牌（Web 上可能为空，靠 cookie）；
	 *   - setToken 写内存并落 localStorage，刷新后仍是登录态；
	 *   - clear 只清令牌、**保留服务器地址**（"断开云端"时页面自己先删 localStorage）。
	 */
	function installCloud(cloud) {
		var state = {
			base: cloud.base,
			token: cloud.token,
			setToken: function (next) {
				var value = next === null || next === undefined ? "" : String(next);
				state.token = value;
				persistCloud(state.base, value);
				return state.token;
			},
			clear: function () {
				state.token = "";
				persistCloud(state.base, "");
			},
		};
		window.__NOVEL_CLOUD__ = state;
		// 方案文档里的老名字，一并挂上，免得调用方两处猜。
		window.__NOVEL_CLOUD_BASE__ = cloud.base;
	}

	/* ───────────────────────────────────────────── 本地模式 */

	function isTauri() {
		return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
	}

	function hasLocalFlag() {
		// 部署方把服务端配成 STORAGE=idb 时，服务端会在页面里预先置上这个标记。
		// 那种部署形态下服务端本来就不存数据，用户不该还要自己去拼一个 ?local=1。
		if (window.__NOVEL_LOCAL_MODE__ === true) return true;
		try {
			if (new URLSearchParams(window.location.search).get("local") === "1") return true;
		} catch (err) {
			/* URLSearchParams 一定存在，这里只是兜底 */
		}
		try {
			return window.localStorage.getItem(MODE_KEY) === "local";
		} catch (err) {
			return false;
		}
	}

	/** 本地模式开关：Tauri 一定本地；浏览器里没有 IndexedDB（隐私模式等）就不进本地模式。 */
	function shouldRunLocal() {
		if (isTauri()) return true;
		if (!window.indexedDB) return false;
		return hasLocalFlag();
	}

	/** 取请求的路径；拿不到就返回 null。 */
	function pathOf(input) {
		var raw = null;
		try {
			if (typeof input === "string") raw = input;
			else if (input && typeof input.url === "string") raw = input.url;
			else if (input && typeof input.href === "string") raw = input.href;
		} catch (err) {
			return null;
		}
		if (raw === null) return null;
		try {
			return new URL(raw, window.location.href);
		} catch (err) {
			return null;
		}
	}

	/** 是否应该由浏览器本地处理这条请求。 */
	function isLocalApiRequest(input) {
		var url = pathOf(input);
		if (!url) return false;
		if (url.pathname === "/api/llm" || url.pathname.indexOf("/api/llm/") === 0) return false;
		if (url.pathname.indexOf("/api/") !== 0) return false;
		// 跨域的 /api/ 不归我们管，交给原始 fetch。
		if (url.origin !== window.location.origin) return false;
		return true;
	}

	var localApiPromise = null;

	function loadLocalApi() {
		if (!localApiPromise) {
			localApiPromise = import(LOCAL_API_MODULE).catch(function (err) {
				localApiPromise = null;
				throw err;
			});
		}
		return localApiPromise;
	}

	/**
	 * 本地模式：接管同源的 /api/*（/api/llm 除外），其余照旧走网络。
	 */
	function installLocalMode() {
		/**
		 * 本地 API 的统一入口。公开给页面里需要绕过 fetch 包装的代码。
		 */
		window.__dshLocalFetch = function (input, init) {
			return loadLocalApi().then(function (mod) {
				return mod.handle(input, init);
			});
		};

		var originalFetch = window.fetch ? window.fetch.bind(window) : null;

		window.fetch = function (input, init) {
			if (originalFetch && isLocalApiRequest(input)) {
				return window.__dshLocalFetch(input, init);
			}
			if (!originalFetch) {
				return Promise.reject(new Error("fetch 不可用"));
			}
			return originalFetch(input, init);
		};

		window.__DSH_LOCAL_MODE__ = true;
	}

	/* ───────────────────────────────────────────── 原生保存（Tauri） */

	/**
	 * 桌面端原生保存。
	 *
	 * 返回 "saved" | "cancelled" | "unsupported"：
	 *   - saved：用户选了路径并且文件已写入；
	 *   - cancelled：用户在系统对话框里取消，页面不要再偷偷触发浏览器下载；
	 *   - unsupported：浏览器/PWA 或调用失败，调用方回退到 <a download>。
	 *
	 * 云端模式下也照样可用：写稿在服务器，导出仍可以落到本机磁盘。
	 */
	function installNativeSave() {
		window.__mogengSaveFile = async function (name, content, binary) {
			if (!isTauri()) return "unsupported";
			try {
				var core = window.__TAURI__ && window.__TAURI__.core;
				var invoke = core && core.invoke;
				if (typeof invoke !== "function") return "unsupported";
				var path;
				if (binary) {
					var bytes;
					if (content instanceof Uint8Array) bytes = content;
					else if (content && typeof content.arrayBuffer === "function") {
						bytes = new Uint8Array(await content.arrayBuffer());
					} else bytes = new Uint8Array(content);
					var chunks = [];
					var step = 32768;
					for (var i = 0; i < bytes.length; i += step) {
						chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
					}
					path = await invoke("save_binary_file", {
						suggestedName: name,
						base64Data: btoa(chunks.join("")),
					});
				} else {
					path = await invoke("save_text_file", {
						suggestedName: name,
						content: String(content),
					});
				}
				return path ? "saved" : "cancelled";
			} catch (err) {
				console.warn("原生保存失败，回退浏览器下载", err);
				return "unsupported";
			}
		};
	}

	/* ───────────────────────────────────────────── 分流 */

	var cloud = readCloudConfig();

	if (cloud) {
		/*
		 * 云端优先：既不设 __DSH_LOCAL_MODE__，也不把 /api/* 接到 IndexedDB 上。
		 * 请求改写到云端地址、附带 Bearer、登录浮层都在 auth-gate.js 里做。
		 */
		installCloud(cloud);
	} else if (shouldRunLocal()) {
		installLocalMode();
	}

	installNativeSave();
})();
