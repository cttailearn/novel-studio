/**
 * 带出去：导出与搬家。
 *
 * 桌面端交给 Tauri 的原生保存框（boot.js 装的 window.__mogengSaveFile），
 * 浏览器里退回成一次下载。两处都不弹第二个窗。
 */

import * as api from "./api.js";
import { el, icon, toast, openModal } from "./core.js";

const nativeSave = () =>
	typeof window.__mogengSaveFile === "function" ? window.__mogengSaveFile : null;

/**
 * 存一段文本。返回 "saved" | "cancelled" | "unsupported" | "downloaded"。
 * 名字保留 saveFileNatively：契约测试按它找原生保存这条路。
 */
export async function saveFileNatively(name, content, binary = false) {
	const save = nativeSave();
	if (!save) return "unsupported";
	try {
		const result = await save(name, content, binary);
		return result === "saved" || result === "cancelled" ? result : "unsupported";
	} catch {
		return "unsupported";
	}
}

function triggerDownload(name, blob) {
	const url = URL.createObjectURL(blob);
	const anchor = el("a", { href: url, download: name, style: { display: "none" } });
	document.body.append(anchor);
	anchor.click();
	setTimeout(() => {
		anchor.remove();
		URL.revokeObjectURL(url);
	}, 4000);
}

export async function saveText(name, text) {
	const native = await saveFileNatively(name, text, false);
	if (native === "saved") {
		toast("存好了。", "ok");
		return native;
	}
	if (native === "cancelled") return native;
	triggerDownload(name, new Blob([text], { type: "text/plain;charset=utf-8" }));
	toast("下载好了。", "ok");
	return "downloaded";
}

export async function saveBlob(name, blob) {
	const native = await saveFileNatively(name, await blob.text(), false);
	if (native === "saved") {
		toast("存好了。", "ok");
		return native;
	}
	if (native === "cancelled") return native;
	triggerDownload(name, blob);
	toast("下载好了。", "ok");
	return "downloaded";
}

/** 从接口地址取一份文件下来存掉。 */
export async function saveFile({ name, url }) {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			const payload = await response.json().catch(() => null);
			throw new Error(payload?.error || `导出失败（${response.status}）`);
		}
		const blob = await response.blob();
		return await saveBlob(name || "书稿", blob);
	} catch (error) {
		toast(error.message || "没取下来。", "error");
		return "failed";
	}
}

/** 整本导出：默认给 .novel 包（含素材、大纲、履历）。 */
export async function exportNovel({ projectId, title, passphrase = "", credentials = false, compress = true } = {}) {
	const url = api.novelExportUrl({ projectId, passphrase, credentials, compress });
	const name = `${title || "书稿"}${compress ? ".novel" : ".json"}`;
	return saveFile({ name, url });
}

/** 搬进一本书：选文件 → 问口令与冲突处理 → 导入。 */
export async function importNovelFlow(file) {
	if (!file) return;
	const passInput = el("input", { class: "set-input", type: "password", placeholder: "没设口令就留空", autocomplete: "off" });
	const conflict = el("select", { class: "set-select" });
	for (const [value, label] of [
		["skip", "跳过同名的"],
		["rename", "重命名收进来"],
		["overwrite", "覆盖同名的"],
	]) {
		conflict.append(el("option", { value, text: label }));
	}
	const body = el(
		"div",
		{ class: "form-grid" },
		el("p", { class: "set-note field-wide", text: `要收进来的是「${file.name}」，${Math.round(file.size / 1024)} KB。` }),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "口令（如果有）" }), passInput),
		el("label", { class: "field" }, el("span", { class: "field-label", text: "撞名了怎么办" }), conflict),
	);
	const { close } = openModal({
		eyebrow: "搬家",
		title: "收一本书进来",
		body,
		actions: [
			{ label: "算了", onClick: () => close() },
			{
				label: "收进来",
				kind: "primary",
				icon: "upload",
				onClick: async () => {
					close();
					toast("在读，稍等…", "info", 8000);
					try {
						const data = await api.importNovel(file, {
							passphrase: passInput.value,
							onConflict: conflict.value,
						});
						const imported = data?.imported || data?.projects || [];
						toast(`收进来了：${imported.length || 1} 部。`, "ok");
						const ctx = await import("./ctx.js");
						await ctx.refreshProjects();
					} catch (error) {
						toast(error.message || "这本收不进来。", "error");
					}
				},
			},
		],
	});
	passInput.focus();
}

/** 选文件入口：桌面上也能用同一个隐藏 input。 */
export function pickNovelFile() {
	const input = document.getElementById("novel-file-input");
	if (!input) return;
	input.value = "";
	input.onchange = () => {
		const file = input.files?.[0];
		if (file) void importNovelFlow(file);
	};
	input.click();
}

export async function copyText(text, note = "抄好了。") {
	try {
		await navigator.clipboard.writeText(text);
		toast(note, "ok");
		return true;
	} catch {
		toast("这台机器不让抄。", "error");
		return false;
	}
}

export function downloadIcon() {
	return icon("download");
}
