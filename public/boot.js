/*
 * 本地模式引导脚本（classic script，不是 module）。
 *
 * 作用：
 *   1. 判断当前是否处于「本地模式」——浏览器里有 IndexedDB，并且 URL 带 ?local=1
 *      或 localStorage 里 novel-studio/mode === "local"；
 *   2. 本地模式下接管 /api/* 请求：不再打到服务器，而是交给浏览器内的
 *      /browser/local-api.js 处理（数据留在本机浏览器里）；
 *   3. 服务器模式下这个脚本什么都不做，服务端行为完全不受影响。
 *
 * 注意：/api/llm 是例外——它是流式转发上游模型的通道，仍然走真实网络。
 */
(function () {
	"use strict";

	var MODE_KEY = "novel-studio/mode";
	var LOCAL_API_MODULE = "/browser/local-api.js";

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

	/** 本地模式开关：没有 IndexedDB（隐私模式等）就不进本地模式。 */
	function shouldRunLocal() {
		if (!window.indexedDB) return false;
		return hasLocalFlag();
	}

	if (!shouldRunLocal()) return;

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
})();
