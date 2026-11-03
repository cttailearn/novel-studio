// 主题必须在首帧之前定下来，否则暗色用户会先看到一屏白纸。
// 独立成文件是为了让 Tauri 的 CSP 不必给 script-src 开 'unsafe-inline'。
// 这段要排在样式表之前：data-theme 晚于 CSS 生效，第一帧就已经是错色了。
// 三档：存过就用存的，没存过就听系统的。
(function () {
	try {
		var saved = localStorage.getItem("novel-studio-theme");
		var prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
		var theme = saved === "light" || saved === "dark" ? saved : prefers ? "dark" : "light";
		document.documentElement.dataset.theme = theme;
		// 顶栏颜色也跟着昼夜走，手机上的地址栏才不会在暗色里留一条白边。
		var meta = document.querySelector('meta[name="theme-color"]:not([media])');
		if (meta) meta.setAttribute("content", theme === "dark" ? "#17150f" : "#efe8d9");
	} catch (e) {
		document.documentElement.dataset.theme = "light";
	}
})();
