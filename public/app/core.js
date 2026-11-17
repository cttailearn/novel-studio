/**
 * 基础层：选元素、造节点、格式化、弹窗、提示条、轻量 Markdown。
 * 这里不放业务，只放每个视图都会用到的手。
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 造节点。
 * attrs 里 class/dataset/style/text 直接吃，on* 绑事件，其余当属性。
 */
export function el(tag, attrs = null, ...children) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === null || value === undefined || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = String(value);
			else if (key === "html") node.innerHTML = value;
			else if (key === "dataset") Object.assign(node.dataset, value);
			else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
			else if (key === "on" && typeof value === "object") {
				for (const [event, handler] of Object.entries(value)) {
					if (event && typeof handler === "function") node.addEventListener(event, handler);
				}
			} else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
			else if (value === true) node.setAttribute(key, "");
			else node.setAttribute(key, String(value));
		}
	}
	for (const child of children.flat(9)) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

/** 把可能为空的节点摊平，给 replaceChildren/append 用 */
export function pack(...children) {
	return children.flat(9).filter((child) => child !== null && child !== undefined && child !== false);
}

/** 图标：<svg><use href="#i-xxx"></svg> */export function icon(name, cls = "ico") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", cls);
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("viewBox", "0 0 24 24");
	const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

export function escapeHtml(raw) {
	return String(raw == null ? "" : raw)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** 中文按字、拉丁按词——与后端 countWords 同一口径，前端好即时算。 */
export function countWords(text) {
	const clean = String(text || "")
		.replace(/[\u3000\s]+/g, " ")
		.trim();
	if (!clean) return 0;
	let cjk = 0;
	for (const ch of clean) {
		const code = ch.codePointAt(0);
		if (
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0xac00 && code <= 0xd7af)
		) {
			cjk += 1;
		}
	}
	const latin = clean.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
	return cjk + (latin ? latin.length : 0);
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function wordLabel(n) {
	const value = Number(n) || 0;
	if (value >= 100000) {
		const wan = value / 10000;
		return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)} 万字`;
	}
	if (value >= 10000) return `${(value / 10000).toFixed(value >= 20000 ? 1 : 2)} 万字`;
	return `${value} 字`;
}

export function num(n) {
	const value = Number(n) || 0;
	return value.toLocaleString("zh-CN");
}

export function pct(part, whole) {
	const a = Number(part) || 0;
	const b = Number(whole) || 0;
	if (b <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
}

export function timeAgo(ts) {
	if (!ts) return "";
	const diff = Date.now() - Number(ts);
	if (!Number.isFinite(diff) || diff < 0) return "刚刚";
	const min = Math.floor(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day} 天前`;
	const d = new Date(Number(ts));
	return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function clock(ts) {
	if (!ts) return "";
	const d = new Date(Number(ts));
	const pad = (v) => String(v).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(ts) {
	if (!ts) return "";
	const d = new Date(Number(ts));
	const pad = (v) => String(v).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 正文预览：去掉换行过多的空行，截到 n 个字。 */
export function excerpt(text, n = 90) {
	const clean = String(text || "")
		.replace(/\r/g, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
	if (clean.length <= n) return clean;
	return `${clean.slice(0, n)}…`;
}

export function initials(text) {
	const clean = String(text || "").trim();
	if (!clean) return "墨";
	return clean.slice(0, 1);
}

export function debounce(fn, wait = 300) {
	let timer = 0;
	const wrapped = (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
	wrapped.flush = (...args) => {
		clearTimeout(timer);
		fn(...args);
	};
	wrapped.cancel = () => clearTimeout(timer);
	return wrapped;
}

export function throttle(fn, wait = 120) {
	let last = 0;
	let timer = 0;
	return (...args) => {
		const now = Date.now();
		const rest = wait - (now - last);
		if (rest <= 0) {
			last = now;
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				timer = 0;
				last = Date.now();
				fn(...args);
			}, rest);
		}
	};
}

/* ---------- 提示条 ---------- */

let toastSeq = 0;

export function toast(message, kind = "info", ms = 3600) {
	const host = $("#toasts");
	if (!host) return;
	const id = ++toastSeq;
	const node = el(
		"div",
		{ class: `toast${kind === "error" ? " is-error" : kind === "ok" ? " is-ok" : ""}`, dataset: { toast: String(id) } },
		kind === "ok" ? icon("check", "ico ico-sm toast-mark") : kind === "error" ? icon("alert", "ico ico-sm") : null,
		el("div", { class: "toast-text", text: message }),
		el(
			"button",
			{
				class: "toast-close",
				type: "button",
				"aria-label": "关闭",
				on: {
					click: () => node.remove(),
				},
			},
			icon("x"),
		),
	);
	host.append(node);
	const limit = 4;
	while (host.children.length > limit) host.firstElementChild.remove();
	setTimeout(() => {
		if (!node.isConnected) return;
		node.style.opacity = "0";
		node.style.transform = "translateY(4px)";
		node.style.transition = "opacity 160ms ease, transform 160ms ease";
		setTimeout(() => node.remove(), 200);
	}, Math.max(1200, ms));
}

/* ---------- 弹窗 ---------- */

let modalCleanup = null;

/**
 * 打开通用弹窗。返回 { close, element }。
 * body 传节点或节点数组；actions 传 [{label, kind, onClick, id}]。
 */
export function openModal({ eyebrow = "", title = "", body = null, actions = [], footNote = null, wide = false } = {}) {
	const dialog = $("#modal");
	const titleNode = $("#modal-title");
	const eyebrowNode = $("#modal-eyebrow");
	const bodyNode = $("#modal-body");
	const footNode = $("#modal-foot");
	if (!dialog || !bodyNode) return { close() {}, element: null };

	if (typeof modalCleanup === "function") modalCleanup();

	titleNode.textContent = title;
	eyebrowNode.textContent = eyebrow;
	eyebrowNode.hidden = !eyebrow;
	bodyNode.replaceChildren();
	if (body) {
		for (const item of Array.isArray(body) ? body : [body]) {
			if (item) bodyNode.append(item);
		}
	}
	footNode.replaceChildren();
	dialog.classList.toggle("is-wide", Boolean(wide));

	for (const action of actions) {
		if (!action) continue;
		if (action.node) {
			footNode.append(action.node);
			continue;
		}
		const btn = el("button", {
			class: `btn ${action.kind === "primary" ? "btn-ink" : action.kind === "seal" ? "btn-seal" : "btn-ghost"}`,
			type: action.type || "button",
			id: action.id || null,
			on: {
				click: (event) => {
					if (action.onClick) action.onClick({ close, event });
				},
			},
		});
		if (action.icon) btn.append(icon(action.icon));
		btn.append(document.createTextNode(action.label));
		footNode.append(btn);
	}
	if (footNote) footNode.append(el("span", { class: "modal-foot-note", text: footNote }));

	const close = () => {
		if (dialog.open) dialog.close();
	};
	if (!dialog.open) dialog.showModal();

	const onClose = () => {
		dialog.removeEventListener("close", onClose);
		modalCleanup = null;
	};
	dialog.addEventListener("close", onClose);
	modalCleanup = () => {
		if (dialog.open) dialog.close();
	};

	const firstInput = bodyNode.querySelector("input,textarea,select");
	if (firstInput) setTimeout(() => firstInput.focus({ preventScroll: true }), 40);
	return { close, element: bodyNode };
}

export function closeModal() {
	const dialog = $("#modal");
	if (dialog && dialog.open) dialog.close();
}

/** 只问一句话的确认框。 */
export function confirmAction({ title, message, confirmLabel = "确定", danger = false }) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const { close } = openModal({
			title,
			body: el("p", { class: "confirm-text", text: message }),
			actions: [
				{ label: "先不", onClick: () => (close(), done(false)) },
				{
					label: confirmLabel,
					kind: danger ? "seal" : "primary",
					onClick: () => (close(), done(true)),
				},
			],
		});
		$("#modal").addEventListener(
			"close",
			() => {
				setTimeout(() => done(false), 0);
			},
			{ once: true },
		);
	});
}

/* ---------- 轻量 Markdown ----------
   智能体回话里常见的是段落、列表、代码、粗体。
   先整体转义再做变换，模型吐出来的东西一律当数据。 */
export function renderMarkdown(raw) {
	const source = String(raw || "").replace(/\r\n?/g, "\n");
	const blocks = [];
	let text = source;

	// 先把围栏代码抽出来，避免内部被当成 markdown。
	text = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
		const idx = blocks.length;
		blocks.push({ lang, code });
		return `\u0000BLOCK${idx}\u0000`;
	});

	const inline = (s) => {
		let out = escapeHtml(s);
		out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
		out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		out = out.replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s）).,，。]|$)/g, "$1<em>$2</em>");
		out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
		out = out.replace(/(^|[\s>（(])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');
		// 中文书名号里的引文不做处理；只把「==高亮==」留给批注用。
		out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");
		return out;
	};

	const lines = text.split("\n");
	const out = [];
	let listType = null;
	let paragraph = [];
	let quote = [];

	const flushParagraph = () => {
		if (!paragraph.length) return;
		out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (!listType) return;
		out.push(`</${listType}>`);
		listType = null;
	};
	const flushQuote = () => {
		if (!quote.length) return;
		out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
		quote = [];
	};

	for (const line of lines) {
		const blockRef = line.match(/^\u0000BLOCK(\d+)\u0000\s*$/);
		if (blockRef) {
			flushParagraph();
			flushList();
			flushQuote();
			const block = blocks[Number(blockRef[1])];
			if (block) {
				out.push(`<pre><code>${escapeHtml(block.code.replace(/\n$/, ""))}</code></pre>`);
			}
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			flushList();
			flushQuote();
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			flushList();
			flushQuote();
			const level = Math.min(4, heading[1].length + 3);
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}
		if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
			flushParagraph();
			flushList();
			flushQuote();
			out.push("<hr />");
			continue;
		}
		const quoteLine = line.match(/^>\s?(.*)$/);
		if (quoteLine) {
			flushParagraph();
			flushList();
			quote.push(quoteLine[1]);
			continue;
		}
		flushQuote();
		const bullet = line.match(/^\s*[-*·•]\s+(.*)$/);
		const ordered = line.match(/^\s*\d+[.)、]\s+(.*)$/);
		if (bullet || ordered) {
			flushParagraph();
			const want = bullet ? "ul" : "ol";
			if (listType !== want) {
				flushList();
				listType = want;
				out.push(`<${want}>`);
			}
			out.push(`<li>${inline((bullet || ordered)[1])}</li>`);
			continue;
		}
		flushList();
		paragraph.push(line);
	}
	flushParagraph();
	flushList();
	flushQuote();
	return out.join("");
}

/** 文本框按内容长高。 */
export function fitTextarea(node, max = 168) {
	if (!node) return;
	node.style.height = "auto";
	const next = Math.min(max, Math.max(24, node.scrollHeight));
	node.style.height = `${next}px`;
	node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
}

export function fitTextareaFull(node, min = 0) {
	if (!node) return;
	node.style.height = "auto";
	node.style.height = `${Math.max(min, node.scrollHeight)}px`;
}

/** 焦点离开时收起浮层；返回取消函数。 */
export function onOutsideClick(node, handler) {
	const listener = (event) => {
		if (!node || node.contains(event.target)) return;
		handler(event);
	};
	document.addEventListener("pointerdown", listener, true);
	return () => document.removeEventListener("pointerdown", listener, true);
}

export function isCoarsePointer() {
	return window.matchMedia("(pointer: coarse)").matches;
}

export function isMac() {
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function modKey() {
	return isMac() ? "⌘" : "Ctrl";
}

/** 章节序号：第 N 章。 */
export function ordinal(n) {
	const value = Number(n) || 0;
	return value > 0 ? String(value).padStart(2, "0") : "";
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CJK_RE };
