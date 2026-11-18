/**
 * 运行卡：执笔者、设定官、润色共用的那一张「它正在干什么」。
 *
 * 跑着的时候点一下点、走计时、一步一步亮出来；跑完折成一行，点开还是这一轮的全过程
 * —— 读了哪一段正文、取了哪几条料、改前改后长什么样。展开的那一栏底下还带着
 * 「手上的稿与料」：从那儿把正文或素材抄进输入框，写交代就不必回头翻页。
 *
 * 改编台那张卡是这套东西的起点，但它和右栏的稿纸绑得太紧（结构里写死了全局 id），
 * 所以这里另起一份：只靠元素引用找自己，同一屏里可以同时活着好几张。
 */

import { el, icon, toast, excerpt, renderMarkdown } from "./core.js";

const TOOL_LABELS = {
	read_chapter: "读这一章",
	read_previous_chapter: "读上一章",
	read_original_chapter: "读原书这一章",
	read_adapted_chapter: "读改编稿",
	read_novel_chapter: "读原著",
	list_chapters: "翻章目",
	list_materials: "看手上的料",
	list_notes: "翻待办",
	list_novel_sources: "翻原料库",
	search_materials: "搜素材",
	search_novel_source: "搜原著",
	search_adaptation_changes: "翻台账",
	get_outline: "翻大纲",
	get_project_brief: "翻这本书的底子",
	write_chapter: "写整章",
	append_chapter: "续一段",
	revise_chapter: "改一段",
	upsert_material: "记一条料",
	attach_materials: "挂料",
	detach_materials: "卸料",
	add_note: "记一条待办",
	resolve_note: "结一条待办",
	update_outline: "改章目",
	rename_chapter: "改章名",
	propose_adaptation: "交改编稿",
	propose_chapter: "拟大纲",
	ask_user: "问你一句",
	ask: "问你一句",
};

/** 读料、读正文这类工具的结果值得多摊几行：它就是作者要拿来写交代的东西。 */
const RICH_TOOLS = /^(read_|list_|search_|get_|upsert_material|attach_materials)/;

export function toolTitle(name) {
	return TOOL_LABELS[name] || name || "动手";
}

function seconds(ms) {
	const value = Math.max(0, Number(ms) || 0) / 1000;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}s`;
}

function elapsed(state) {
	return Math.max(0, (state.endedAt || Date.now()) - state.startedAt);
}

function argsText(args) {
	if (!args || typeof args !== "object") return "";
	const parts = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === null || value === undefined || value === "") continue;
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		parts.push(`${key}: ${excerpt(String(raw), 28)}`);
		if (parts.length >= 2) break;
	}
	return parts.join(" · ");
}

/** 抄进剪贴板：没有 navigator.clipboard 的时候退到老办法。 */
export async function copyText(text) {
	const body = String(text || "");
	if (!body) return false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(body);
			return true;
		}
	} catch {
		/* 没给权限就退一步 */
	}
	try {
		const area = document.createElement("textarea");
		area.value = body;
		area.setAttribute("readonly", "");
		area.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * 造一张卡。onUse(ref) 是「抄进」那一下要做的事，由各屏自己给；
 * 不给就退成「抄进剪贴板」。onGrow 每长一段字叫一声，用来把列表滚到底。
 */
export function createRunCard({ title = "执笔者", hint = "", useLabel = "抄进", showText = true, onUse = null, onGrow = null, onClose = null } = {}) {
	const state = {
		status: "running",
		open: true,
		model: "",
		hint,
		startedAt: Date.now(),
		endedAt: 0,
		steps: [],
		text: "",
		thought: "",
		error: "",
		refs: [],
		timer: null,
		saved: "",
	};

	const root = el("section", { class: "run-card is-running is-open" });
	let metaEl = null;
	let textEl = null;
	let onStop = null;

	const headText = () => (state.model ? `${title} · ${state.model}` : title);

	const statusText = () => {
		if (state.status === "running") return `在干 · ${seconds(elapsed(state))}`;
		if (state.status === "aborted") return `停下了 · ${seconds(elapsed(state))}`;
		if (state.status === "failed") return `没跑完 · ${seconds(elapsed(state))}`;
		return `跑完了 · ${seconds(elapsed(state))}`;
	};

	const metaText = () => {
		const steps = state.steps.filter((step) => step.name).length;
		const tail = state.saved ? ` · ${state.saved}` : "";
		return `${statusText()}${steps ? ` · ${steps} 步` : ""}${tail}`;
	};

	const stepNode = (step) => {
		const row = el(
			"div",
			{
				class: `run-step is-${step.phase}${step.isError ? " is-error" : ""}${RICH_TOOLS.test(step.name || "") ? " is-rich" : ""}`,
			},
			el("span", { class: "run-step-dot" }),
			el("span", { class: "run-step-label", text: step.label || toolTitle(step.name) }),
		);
		if (step.phase === "done" && step.name) row.append(el("span", { class: "run-step-time", text: seconds(step.durationMs) }));
		if (step.name) row.append(el("span", { class: "run-step-tool", text: step.args ? `${step.name}(${step.args})` : step.name }));
		if (step.preview) row.append(el("p", { class: "run-step-preview", text: excerpt(step.preview, 400) }));
		return row;
	};

	const useRef = async (ref) => {
		if (onUse) {
			onUse(ref);
			return;
		}
		const ok = await copyText(ref.text);
		toast(ok ? `《${ref.label}》已抄进剪贴板。` : "没抄进去，手动选一段吧。", ok ? "ok" : "error");
	};

	const refsNode = () => {
		if (!state.refs.length) return null;
		const box = el("div", { class: "run-refs" });
		box.append(
			el(
				"div",
				{ class: "run-refs-head" },
				el("span", { class: "eyebrow", text: "手上的稿与料" }),
				el("span", { class: "run-refs-hint", text: `${useLabel}之后直接写交代` }),
			),
		);
		for (const ref of state.refs) {
			const head = el(
				"div",
				{ class: "run-ref-head" },
				el("span", { class: "run-ref-label", text: ref.label }),
				el("span", { class: "run-ref-meta", text: ref.meta || "" }),
			);
			if (ref.text) {
				head.append(
					el("button", {
						class: "btn btn-quiet btn-sm run-ref-use",
						type: "button",
						text: useLabel,
						on: { click: () => void useRef(ref) },
					}),
				);
			}
			box.append(el("div", { class: "run-ref" }, head, el("p", { class: "run-ref-text", text: excerpt(ref.text || "", 1200) })));
		}
		return box;
	};

	const bodyNode = () => {
		const body = el("div", { class: "run-card-body" });
		if (state.error) body.append(el("p", { class: "run-error", text: state.error }));
		// 琢磨常常是一大段自问自答，压在步骤上面会把真正要看的「它读了什么」挤走：
		// 折起来，标题写清多少字，想看再点开。
		if (state.thought) {
			body.append(
				el(
					"details",
					{ class: "run-think" },
					el("summary", { class: "run-think-head" }, el("span", { class: "eyebrow", text: "琢磨" }), el("span", { class: "run-think-size", text: `${state.thought.length} 字` })),
					el("p", { class: "run-thinking", text: excerpt(state.thought, 1200) }),
				),
			);
		}
		const steps = el("div", { class: "run-steps" });
		for (const step of state.steps) steps.append(stepNode(step));
		if (!state.steps.length) steps.append(el("p", { class: "set-note", text: state.status === "running" ? "还没动手。" : "这一轮没调用工具。" }));
		body.append(steps);
		// 稿与料摆在「流下来的字」前面：那一栏可能很长，压下去就要滚很久才捞得到原文，
		// 而作者正是要照着原文写下一句交代。
		const refs = refsNode();
		if (refs) body.append(refs);
		if (showText && state.text) {
			body.append(el("p", { class: "eyebrow", text: "流下来的字" }));
			textEl = el("div", { class: "run-text", html: renderMarkdown(state.text) });
			body.append(textEl);
			requestAnimationFrame(() => {
				if (textEl) textEl.scrollTop = textEl.scrollHeight;
			});
		} else {
			textEl = null;
		}
		return body;
	};

	const paint = () => {
		root.className = `run-card is-${state.status}${state.open ? " is-open" : ""}`;
		root.replaceChildren();
		const toggle = el(
			"button",
			{
				class: "run-card-toggle",
				type: "button",
				"aria-expanded": state.open ? "true" : "false",
				on: {
					click: () => {
						state.open = !state.open;
						paint();
					},
				},
			},
			el("span", { class: "run-card-dot" }),
			el("span", { class: "run-card-title", text: headText() }),
			(metaEl = el("span", { class: "run-card-meta", text: metaText() })),
			icon("chevron-down", "ico ico-sm run-card-arrow"),
		);
		const head = el("div", { class: "run-card-head" }, toggle);
		if (state.status === "running" && typeof onStop === "function") {
			head.append(el("button", { class: "btn btn-quiet btn-sm run-card-halt", type: "button", title: "停下这一轮", on: { click: () => onStop() } }, icon("stop")));
		} else {
			head.append(el("button", { class: "btn btn-quiet btn-sm run-card-close", type: "button", title: "收起这张卡", on: { click: () => card.destroy() } }, icon("x")));
		}
		root.append(head);
		if (state.open) root.append(bodyNode());
	};

	const card = {
		get el() {
			return root;
		},
		get state() {
			return state;
		},
		/** 停下那一轮要做的事，由调用方给。 */
		setStop(fn) {
			onStop = fn;
			paint();
			return card;
		},
		open(open = true) {
			state.open = open;
			paint();
			return card;
		},
		start({ model = "" } = {}) {
			if (model) state.model = model;
			state.status = "running";
			state.startedAt = Date.now();
			state.endedAt = 0;
			// 同一张卡会跑第二遍（润色里「再改一遍」）：上一轮的「改好了」与报错都得先抹掉，
			// 否则新一轮在跑，抬头还挂着上一轮的结果。
			state.saved = "";
			state.error = "";
			paint();
			clearInterval(state.timer);
			state.timer = setInterval(() => {
				if (metaEl && state.status === "running") metaEl.textContent = metaText();
			}, 500);
			return card;
		},
		step(name, args) {
			for (let index = state.steps.length - 1; index >= 0; index -= 1) {
				const step = state.steps[index];
				if (step.name === name && step.phase !== "done") {
					step.phase = "running";
					step.startedAt = Date.now();
					step.args = argsText(args) || step.args;
					paint();
					return card;
				}
			}
			state.steps.push({ name, args: argsText(args), phase: "running", startedAt: Date.now(), durationMs: 0, isError: false, preview: "" });
			paint();
			return card;
		},
		finishStep(event) {
			const name = event?.name || "";
			for (let index = state.steps.length - 1; index >= 0; index -= 1) {
				const step = state.steps[index];
				if (step.name !== name || step.phase === "done") continue;
				step.phase = "done";
				step.durationMs = Number(event.durationMs) || Date.now() - step.startedAt;
				step.isError = Boolean(event.isError);
				step.preview = event.preview || "";
				break;
			}
			paint();
			return card;
		},
		note(label, kind = "") {
			state.steps.push({ name: "", label, phase: "done", startedAt: Date.now(), durationMs: 0, isError: kind === "warn", preview: "" });
			paint();
			return card;
		},
		text(delta) {
			state.text += String(delta || "");
			// 字一段一段来，整卡重画会把展开的步骤抖散：能就地改就只改正文那一段。
			if (state.open && textEl) {
				textEl.innerHTML = renderMarkdown(state.text);
				textEl.scrollTop = textEl.scrollHeight;
			} else if (state.open) paint();
			onGrow?.();
			return card;
		},
		setText(text) {
			state.text = String(text || "");
			if (state.open) paint();
			return card;
		},
		thinking(delta) {
			state.thought += String(delta || "");
			// 琢磨的字不每来一段就重画：那会把展开的步骤行抖散，收笔时一起看。
			return card;
		},
		setRefs(refs) {
			state.refs = Array.isArray(refs) ? refs : [];
			if (state.open) paint();
			return card;
		},
		finish({ aborted = false, error = "", saved = "" } = {}) {
			clearInterval(state.timer);
			state.timer = null;
			state.status = aborted ? "aborted" : error ? "failed" : "done";
			state.error = error || state.error;
			state.saved = saved || "";
			state.endedAt = Date.now();
			state.open = false;
			paint();
			return card;
		},
		fail(message) {
			clearInterval(state.timer);
			state.timer = null;
			state.status = "failed";
			state.error = message || "这一轮没跑完。";
			state.endedAt = Date.now();
			state.open = true;
			paint();
			return card;
		},
		destroy() {
			clearInterval(state.timer);
			state.timer = null;
			// 作者手动收掉的卡不该在翻章回来时又冒出来：留个记号，宿主那边据此不再挂回。
			root.dataset.dropped = "1";
			root.remove();
			onClose?.();
		},
	};

	paint();
	return card;
}

/**
 * 「手上的稿与料」：正文一段 + 这一章挂着的料。
 * 给的是能直接抄进输入框的字 —— 写交代时手上有原文可指，比只看见标题有用。
 */
export function chapterRefs({ chapterId = "", draft = null, materials = [], draftLimit = 1200 } = {}) {
	const refs = [];
	const content = String(draft?.content || "").trim();
	if (content) {
		refs.push({
			label: `这一章正文${draft?.title ? ` · ${draft.title}` : ""}`,
			meta: `${content.length} 字`,
			text: content.slice(0, draftLimit),
			kind: "draft",
		});
	}
	const attached = (materials || []).filter((material) => {
		if (!chapterId) return true;
		if ((material.chapterIds || []).includes(chapterId)) return true;
		return (draft?.materialIds || []).includes(material.id);
	});
	for (const material of attached.slice(0, 8)) {
		const body = String(material.content || "").trim();
		if (!body) continue;
		refs.push({
			label: material.title || "（未命名的料）",
			meta: `${body.length} 字`,
			text: body.slice(0, 600),
			kind: "material",
			id: material.id,
		});
	}
	return refs;
}
