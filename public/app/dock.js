/**
 * 副驾：坐在稿纸右边的那一位。
 *
 * 三种身份共用一条会话流——执笔者管这一章怎么写，设定官管料够不够，
 * 润色那一位不聊天，它只认正文里你选中的那一段。
 */

import * as api from "./api.js";
import * as ctx from "./ctx.js";
import { $, $$, el, icon, toast, renderMarkdown, excerpt, num, wordLabel } from "./core.js";
import { createRunCard, chapterRefs } from "./run-card.js";

let mounted = false;
let streamEl = null;
let inputEl = null;
let mode = "writing"; // writing | material | polish
let pendingRecordId = "";
let busy = false;
let abortCtl = null;
// 副驾可以被搬进读稿台：记住原来的位置，收起时送回去。
let embedded = false;
const home = { parent: null, next: null };
// 手机上副驾是一张半屏抽屉：默认收成一条，把稿纸让出来；要聊了再拉满。
let sheetExpanded = false;

const sheetDock = () => window.matchMedia("(max-width: 920px)").matches;

/** 手机上把副驾拉开／收成一条。宽屏上什么也不做——那一栏本来就是常开的。 */
export function setSheetExpanded(next) {
	sheetExpanded = Boolean(next);
	const node = $("#dock");
	node?.classList.toggle("is-expanded", sheetExpanded);
	const btn = $("#btn-dock-expand");
	if (btn) {
		btn.setAttribute("aria-expanded", sheetExpanded ? "true" : "false");
		btn.title = sheetExpanded ? "收起对话" : "展开对话";
	}
	syncSheetScrim();
}

/** 收着的时候不压暗稿纸：那正是要读的字。拉开成了半屏抽屉，才放遮罩。 */
function syncSheetScrim() {
	if (embedded || !sheetDock()) return;
	const scrim = $("#scrim");
	if (!scrim) return;
	scrim.hidden = !sheetExpanded;
	scrim.classList.toggle("is-on", sheetExpanded);
}

const ROLE_LABEL = { writing: "执笔者", material: "设定官", polish: "润色" };
const ROLE_HINT = {
	writing: "跟执笔者说：这一章怎么写…",
	material: "问设定官：料够不够、哪里对不上…",
	polish: "在正文里选一段，再按「润色这段」。",
};

const esc = (value) => String(value == null ? "" : value);

export function initDock() {
	if (mounted) return;
	mounted = true;
	streamEl = $("#dock-stream");
	inputEl = $("#dock-input");

	for (const chip of $$("#dock-roles .chip")) {
		chip.addEventListener("click", () => setMode(chip.dataset.role));
	}
	$("#btn-dock-new")?.addEventListener("click", () => void newSession());
	$("#btn-close-dock")?.addEventListener("click", () => closeDock());
	$("#btn-dock-expand")?.addEventListener("click", () => setSheetExpanded(!sheetExpanded));
	$("#btn-dock-send")?.addEventListener("click", () => void send());
	$("#btn-dock-model")?.addEventListener("click", (event) => openModelMenu(event.currentTarget));

	inputEl?.addEventListener("input", () => {
		autosize();
		renderSendState();
	});
	inputEl?.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	});

	ctx.onChange((scope) => {
		if (scope === "project" || scope === "active" || scope === "draft") {
			renderAttach();
			renderQuick();
			renderModelLabel();
			// 换章之后，开场那句得跟着换；已经说过话就不要再插一张卡。
			if (!messages().length) renderIntro();
		}
		if (scope === "chapters" || scope === "outline") renderAttach();
	});
	renderAttach();
	renderQuick();
	renderModelLabel();
	renderSendState();
	renderIntro();
}

export function closeDock() {
	ctx.state.prefs.dockOpen = false;
	ctx.savePrefs({ dockOpen: false });
	if (embedded) {
		// 嵌在读稿台里时，收起来只影响读稿台那一栏。
		return;
	}
	$("#app").classList.remove("dock-open");
	const scrim = $("#scrim");
	if (scrim) {
		scrim.classList.remove("is-on");
		scrim.hidden = true;
	}
}

export function openDock() {
	ctx.state.prefs.dockOpen = true;
	ctx.savePrefs({ dockOpen: true });
	if (!embedded) {
		$("#app").classList.add("dock-open");
		if (sheetDock()) {
			// 手机上先只露一条：正文还是主角，收起来的那一截随时可以拉回来。
			setSheetExpanded(false);
		} else if (window.matchMedia("(max-width: 1160px)").matches) {
			// 平板那档还是整张抽屉，得把遮罩也放下来。
			const scrim = $("#scrim");
			if (scrim) {
				scrim.hidden = false;
				requestAnimationFrame(() => scrim.classList.add("is-on"));
			}
		}
	}
	if ($("#dock-input")) setTimeout(() => $("#dock-input").focus(), 120);
}

/**
 * 把副驾整块搬进读稿台/别处。元素本身不重建，会话、监听、滚动位置都还在；
 * 搬走前记住原位，unmountDock() 再放回去。
 */
export function mountDock(host) {
	const node = $("#dock");
	if (!node || !host) return false;
	if (!home.parent) {
		home.parent = node.parentElement;
		home.next = node.nextElementSibling;
	}
	embedded = true;
	node.classList.add("is-embedded");
	host.append(node);
	renderAttach();
	renderQuick();
	renderIntro();
	renderSendState();
	return true;
}

export function unmountDock() {
	const node = $("#dock");
	if (!node || !home.parent) return;
	embedded = false;
	node.classList.remove("is-embedded");
	if (home.next && home.next.parentElement === home.parent) home.parent.insertBefore(node, home.next);
	else home.parent.append(node);
	$("#app").classList.remove("dock-open");
}

/* ---------------------------------------------------------------- 身份 */

function setMode(next) {
	if (!["writing", "material", "polish"].includes(next)) return;
	if (mode === next) return;
	mode = next;
	for (const chip of $$("#dock-roles .chip")) chip.classList.toggle("is-active", chip.dataset.role === mode);
	renderIntro();
	renderQuick();
	renderModelLabel();
	renderSendState();
	if (inputEl) {
		inputEl.placeholder = ROLE_HINT[mode];
		if (mode !== "polish") inputEl.focus();
	}
	if (mode === "polish") {
		toast("选中正文里的一段，再按「润色这段」。");
	}
}

function sessionRole() {
	return mode === "material" ? "material" : "writing";
}

/* ---------------------------------------------------------------- 会话 */

function messages() {
	const session = ctx.state.session;
	return session && session.messages ? session.messages : [];
}

function pushMessage(message) {
	if (!ctx.state.session) ctx.state.session = { role: sessionRole(), id: "", recordId: "", messages: [] };
	ctx.state.session.messages.push(message);
	return message;
}

async function ensureSession() {
	const existing = ctx.state.session;
	if (existing?.id && existing.role === sessionRole()) return existing;
	if (!ctx.state.project) throw new Error("先打开一部书。");
	if (sessionRole() === "writing" && !ctx.state.activeId) throw new Error("先挑一章。");
	const body = {
		projectId: ctx.state.project.id,
		role: sessionRole(),
		modelRef: ctx.state.prefs.dockModel || ctx.aimModel() || undefined,
		thinkingLevel: ctx.state.prefs.dockThinking || undefined,
	};
	if (sessionRole() === "writing") body.chapterId = ctx.state.activeId;
	if (pendingRecordId) body.recordId = pendingRecordId;
	const data = await api.createSession(body);
	ctx.state.session = {
		role: sessionRole(),
		id: data.sessionId,
		recordId: data.recordId || pendingRecordId || "",
		model: data.model,
		thinkingLevel: data.thinkingLevel,
		messages: ctx.state.session?.messages || [],
	};
	pendingRecordId = "";
	return ctx.state.session;
}

async function newSession() {
	const old = ctx.state.session?.id;
	ctx.state.session = null;
	pendingRecordId = "";
	if (old) {
		try {
			await api.deleteSession(old);
		} catch {
			/* 过期了就过期了 */
		}
	}
	renderStream();
	renderIntro();
	toast("换了一席新的。");
	if (inputEl) inputEl.focus();
}

export function resumeFromRecord(record) {
	if (!record) return;
	mode = record.role === "material" ? "material" : record.role === "adapt" ? "material" : "writing";
	for (const chip of $$("#dock-roles .chip")) chip.classList.toggle("is-active", chip.dataset.role === mode);
	ctx.state.session = null;
	pendingRecordId = record.id;
	renderStream();
	renderIntro(record);
	openDock();
	if (record.chapterId) void ctx.openChapter(record.chapterId);
	toast(`接着「${record.title || "那一席"}」说。`);
	if (inputEl) setTimeout(() => inputEl.focus(), 200);
}

/* ---------------------------------------------------------------- 渲染 */

function renderIntro(record = null) {
	if (!streamEl) return;
	if (messages().length) return;
	streamEl.replaceChildren();
	const card = el("div", { class: "dock-intro" });
	card.append(el("div", { class: "dock-intro-seal" }, icon(mode === "material" ? "feather" : mode === "polish" ? "wand" : "quill")));
	card.append(el("p", { class: "dock-intro-title", text: ROLE_LABEL[mode] }));
	if (record) {
		card.append(el("p", { class: "dock-intro-note", text: `接着「${record.title || "那一席"}」：${excerpt(record.preview || "", 90)}` }));
	} else if (mode === "writing") {
		const chapter = ctx.outlineItem(ctx.state.activeId);
		const meta = chapter ? ctx.chapterMeta(chapter.id) : null;
		card.append(
			el("p", {
				class: "dock-intro-note",
				text: chapter
					? meta?.hasDraft
						? `现在写的是「${chapter.title}」。说一句想要的方向，我就动手；不交代也行，我会照纲往下写。`
						: `「${chapter.title}」还空着。要我照纲起一稿，或者你先落第一句，我接着写。`
					: "先在左边挑一章，我才能替你写。",
			}),
		);
	} else if (mode === "material") {
		card.append(el("p", { class: "dock-intro-note", text: "料在心里、在纸上都不用讲两遍。问我要什么，我读完这本再答。" }));
	} else {
		card.append(el("p", { class: "dock-intro-note", text: "润色只改你选中的那一段。选中之后按稿纸上方的「润色这段」，我来动手。" }));
	}
	streamEl.append(card);
}

function renderStream() {
	if (!streamEl) return;
	streamEl.replaceChildren();
	if (!messages().length) {
		renderIntro();
		return;
	}
	for (const message of messages()) streamEl.append(messageNode(message));
	scrollToEnd(true);
}

function messageNode(message) {
	const wrap = el("article", { class: `msg msg-${message.role}` });
	const body = el("div", { class: message.role === "user" ? "msg-user-body" : "msg-agent-body" });
	if (message.blocks?.length) {
		for (const block of message.blocks) {
			const node = blockNode(block);
			if (node) body.append(node);
		}
	} else if (message.text) {
		body.append(message.role === "user" ? el("p", { text: message.text }) : el("div", { html: renderMarkdown(message.text) }));
	}
	wrap.append(body);
	if (message.meta) wrap.append(message.meta);
	return wrap;
}

function blockNode(block) {
	if (block.kind === "text") {
		const box = el("div", { class: "msg-text" });
		box.innerHTML = renderMarkdown(block.text || "");
		block.node = box;
		return box;
	}
	if (block.kind === "thinking") {
		const details = el("details", { class: "thinking" });
		details.append(el("summary", { text: "想了想" }));
		const pre = el("div", { class: "thinking-body", text: block.text || "" });
		details.append(pre);
		block.node = pre;
		return details;
	}
	if (block.kind === "tool") {
		const row = el("div", { class: "tool-line" });
		row.append(icon("spark"));
		row.append(el("span", { class: "tool-name", text: toolLabel(block.name) }));
		if (block.durationMs) row.append(el("span", { class: "tool-time", text: `${Math.round(block.durationMs / 100) / 10}s` }));
		if (block.preview) row.append(el("span", { class: "tool-preview", text: excerpt(block.preview, 60) }));
		block.node = row;
		return row;
	}
	if (block.kind === "run") {
		// 运行卡自己会重画，这里只把它摆回去：重排对话时不重建，计时与展开状态都还在。
		return block.node || null;
	}
	if (block.kind === "ask") {
		return askCard(block);
	}
	if (block.kind === "note") {
		return el("p", { class: `run-note${block.kind2 ? ` is-${block.kind2}` : ""}`, text: block.text || "" });
	}
	if (block.kind === "usage") {
		return el("p", { class: "run-usage", text: block.text || "" });
	}
	return null;
}

function toolLabel(name) {
	const map = {
		read_chapter: "读了这一章",
		write_chapter: "写了整章",
		append_chapter: "续了一段",
		revise_chapter: "改了一段",
		get_outline: "翻了大纲",
		list_materials: "看了素材",
		upsert_material: "记了一条料",
		attach_materials: "挂了料",
		detach_materials: "卸了料",
		read_previous_chapter: "读了上一章",
		search_web: "查了资料",
		get_project: "翻了这本书",
		read_source_chapter: "读了原书",
		propose_chapter: "拟了大纲",
	};
	return map[name] || name || "动手";
}

function askCard(block) {
	const card = el("div", { class: "ask-card" });
	card.append(el("p", { class: "ask-q", text: block.question || "这一步怎么走？" }));
	const options = Array.isArray(block.options) ? block.options : [];
	if (options.length) {
		const list = el("div", { class: "ask-opts" });
		for (const option of options) {
			const label = typeof option === "string" ? option : option?.label || option?.value || String(option);
			list.append(
				el("button", {
					class: "ask-opt",
					type: "button",
					text: label,
					on: {
						click: async (event) => {
							event.currentTarget.disabled = true;
							await answer(block, label);
						},
					},
				}),
			);
		}
		card.append(list);
	}
	const custom = el("input", { class: "ask-custom", type: "text", placeholder: options.length ? "或者自己说一句" : "答一句，或者留空跳过" });
	const send = el("button", {
		class: "btn btn-ghost btn-sm",
		type: "button",
		text: "答",
		on: { click: () => void answer(block, custom.value) },
	});
	custom.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void answer(block, custom.value);
		}
	});
	card.append(el("div", { class: "ask-custom-row" }, custom, send));
	block.node = card;
	return card;
}

async function answer(block, text) {
	if (block.answered) return;
	block.answered = true;
	try {
		await api.answerQuestion(block.id, String(text || "").trim());
		if (block.node) {
			block.node.classList.add("is-answered");
			block.node.append(el("p", { class: "ask-done", text: text ? `答了：${text}` : "跳过了。" }));
		}
	} catch (error) {
		block.answered = false;
		toast(error.message || "这句没送到。", "error");
	}
}

function autosize() {
	if (!inputEl) return;
	inputEl.style.height = "auto";
	inputEl.style.height = `${Math.min(160, Math.max(40, inputEl.scrollHeight))}px`;
}

function scrollToEnd(force = false) {
	if (!streamEl) return;
	const near = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 120;
	if (force || near) streamEl.scrollTop = streamEl.scrollHeight;
}

/* ---------------------------------------------------------------- 说罢 */

async function send(text) {
	const input = inputEl;
	const content = String(text ?? input?.value ?? "").trim();
	if (!content) return;
	if (busy) {
		toast("上一句还在写。");
		return;
	}
	if (mode === "polish") {
		toast("润色不走对话——选中正文后按「润色这段」。");
		return;
	}
	if (!ctx.state.prefs.dockModel && !ctx.aimModel()) {
		toast("还没有能用的模型。先去设置里接一个。");
		$("#btn-settings")?.click();
		return;
	}
	let session;
	try {
		session = await ensureSession();
	} catch (error) {
		toast(error.message || "这一席开不起来。", "error");
		return;
	}
	if (input) {
		input.value = "";
		autosize();
	}
	renderSendState();

	if (!messages().length) streamEl?.replaceChildren();
	pushMessage({ role: "user", text: content });
	const reply = pushMessage({ role: "assistant", blocks: [] });
	renderStream();

	busy = true;
	abortCtl = new AbortController();
	// 说了一句话，就得看得见它怎么回：手机上这时把抽屉拉满。
	if (sheetDock()) setSheetExpanded(true);
	const roleName = ROLE_LABEL[mode];
	// 这一轮的「它正在干什么」：摆在回复最上面，跑着有动效，跑完折起来还能点开看
	// 读了哪一段正文、取了哪几条料；手里那段稿与料也能直接抄进输入框。
	const card = createRunCard({
		title: `${roleName}在想`,
		useLabel: "抄进输入框",
		showText: false,
		onUse: (ref) => {
			const box = inputEl;
			if (!box) return;
			const glue = box.value.trim() ? "\n\n" : "";
			box.value = `${box.value}${glue}${ref.text}`;
			autosize();
			renderSendState();
			box.focus();
			toast(`《${ref.label}》抄进输入框了，接着说你要怎么改。`, "ok");
		},
		onGrow: () => scrollToEnd(),
	});
	card.setRefs(chapterRefs({ chapterId: ctx.state.activeId || "", draft: ctx.state.draft, materials: ctx.state.materials }));
	card.setStop(() => abortCtl?.abort());
	card.start({ model: ctx.state.prefs.dockModel || ctx.aimModel() });
	const cardBlock = { kind: "run", node: card.el };
	reply.blocks.push(cardBlock);
	if (streamEl) streamEl.append(card.el);
	scrollToEnd(true);

	ctx.beginRun({ kind: "session", label: `${roleName}在想`, abort: () => abortCtl?.abort() });
	let textBlock = null;
	let thinkingBlock = null;
	let lastEvent = null;

	const note = (textValue, kind2 = "") => {
		const block = { kind: "note", text: textValue, kind2 };
		reply.blocks.push(block);
		if (streamEl) streamEl.append(blockNode(block));
		scrollToEnd();
	};

	try {
		await api.sendMessage(session.id, content, {
			signal: abortCtl.signal,
			onEvent(event) {
				lastEvent = event;
				if (event.type === "queued") {
					note(`前面还有 ${event.position} 轮，排着。`);
					return;
				}
				if (event.type === "run_start") {
					card.state.model = event.model || card.state.model;
					card.start({ model: event.model });
					return;
				}
				if (event.type === "thinking_start") {
					thinkingBlock = { kind: "thinking", text: "" };
					reply.blocks.push(thinkingBlock);
					return;
				}
				if (event.type === "thinking" && event.delta) {
					card.thinking(event.delta);
					if (!thinkingBlock) {
						thinkingBlock = { kind: "thinking", text: "" };
						reply.blocks.push(thinkingBlock);
						if (streamEl) streamEl.append(blockNode(thinkingBlock));
					}
					thinkingBlock.text += event.delta;
					if (thinkingBlock.node) thinkingBlock.node.textContent = thinkingBlock.text;
					return;
				}
				if (event.type === "thinking_end") {
					thinkingBlock = null;
					return;
				}
				if (event.type === "text" && event.delta) {
					if (!textBlock) {
						textBlock = { kind: "text", text: "" };
						reply.blocks.push(textBlock);
						if (streamEl) streamEl.append(blockNode(textBlock));
					}
					textBlock.text += event.delta;
					if (textBlock.node) textBlock.node.innerHTML = renderMarkdown(textBlock.text);
					scrollToEnd();
					return;
				}
				if (event.type === "tool_start" || event.type === "tool_call") {
					// 工具留在运行卡里：对话正文只留说的话，翻看时一眼能分清「说了什么」与「做了什么」。
					card.step(event.name || "", event.args);
					scrollToEnd();
					return;
				}
				if (event.type === "tool_end") {
					card.finishStep(event);
					return;
				}
				if (event.type === "ask") {
					const block = { kind: "ask", id: event.id, question: event.question, options: event.options };
					reply.blocks.push(block);
					if (streamEl) streamEl.append(blockNode(block));
					scrollToEnd();
					return;
				}
				if (event.type === "proposal") {
					note("改编提案拟好了，去改编台看一眼。", "ok");
					return;
				}
				if (event.type === "message_end" && event.error) {
					note(event.error, "warn");
					return;
				}
				if (event.type === "error") {
					note(event.message || "这一轮出错了。", "warn");
					return;
				}
				if (event.type === "run_end") {
					if (event.usage) {
						const block = { kind: "usage", text: usageText(event.usage, event.cost) };
						reply.blocks.push(block);
						if (streamEl) streamEl.append(blockNode(block));
					}
					if (event.error) note(event.error, "warn");
					else if (event.aborted) note("停下了。");
					else if (sessionRole() === "writing") {
						note(event.saved ? `正文存下了（第 ${event.savedRevision || "?"} 稿）。` : "这一轮没落进正文。", event.saved ? "ok" : "warn");
					}
					scrollToEnd();
				}
			},
		});
	} catch (error) {
		if (error?.name === "AbortError") {
			card.state.status = "aborted";
			note("停下了。");
		} else if (error?.status === 404) {
			card.state.status = "failed";
			card.state.error = "这一席过期了。";
			note("这一席过期了，下一句会自动接着上次的记录开一席新的。", "warn");
			pendingRecordId = ctx.state.session?.recordId || "";
			ctx.state.session = null;
		} else {
			card.state.status = "failed";
			card.state.error = error?.message || "没连上。";
			note(error?.message || "没连上。", "warn");
		}
	} finally {
		busy = false;
		abortCtl = null;
		ctx.endRun();
		card.finish({
			aborted: card.state.status === "aborted",
			error: card.state.status === "failed" ? card.state.error : "",
			saved: lastEvent?.type === "run_end" && lastEvent.saved ? `第 ${lastEvent.savedRevision || "?"} 稿` : "",
		});
		renderSendState();
		if (sessionRole() === "writing" && lastEvent?.type === "run_end" && lastEvent.saved && ctx.state.activeId) {
			await ctx.loadDraft(ctx.state.activeId, { silent: true });
			await ctx.reloadProjectStructure().catch(() => {});
			ctx.notify("draft");
		}
	}
}

function usageText(usage, cost) {
	const pieces = [];
	if (usage.input) pieces.push(`入 ${num(usage.input)}`);
	if (usage.output) pieces.push(`出 ${num(usage.output)}`);
	if (usage.turns > 1) pieces.push(`${usage.turns} 轮`);
	if (cost?.amount) pieces.push(`$${cost.amount.toFixed(3)}`);
	return pieces.length ? `这一轮：${pieces.join(" · ")}` : "";
}

/* ---------------------------------------------------------------- 边上那些小件 */

function renderAttach() {
	const host = $("#dock-attach");
	if (!host) return;
	host.replaceChildren();
	const chapter = ctx.outlineItem(ctx.state.activeId);
	if (!chapter) return;
	const words = ctx.chapterMeta(chapter.id)?.words || 0;
	host.append(
		el("span", { class: "attach-chip" }, icon("quill"), el("span", { text: chapter.title || "这一章" }), el("span", { class: "attach-meta", text: words ? wordLabel(words) : "空章" })),
	);
	const mats = ctx.state.materials?.filter((item) => (item.chapterIds || []).includes(chapter.id)) || [];
	if (mats.length) host.append(el("span", { class: "attach-chip is-dim" }, icon("layers"), el("span", { text: `${mats.length} 条料已挂` })));
}

function renderQuick() {
	const host = $("#dock-quick");
	if (!host) return;
	host.replaceChildren();
	const chapter = ctx.outlineItem(ctx.state.activeId);
	const sets = {
		writing: chapter
			? [
					["按纲写下去", "照这一章的纲写，别问我。"],
					["这一章怎么开头", "给我三个开头，只写第一段。"],
					["哪里拖沓了", "指出现在这一章最拖沓的一段，并说怎么删。"],
				]
			: [["先给我列章", "按现在这本书的设定，列 8 章大纲，每章一句纲。"]],
		material: [
			["还缺什么料", "现在这本书的素材还缺什么？按优先级说三条。"],
			["查设定矛盾", "把现有素材里互相矛盾的地方挑出来。"],
			["补一个人物", "我给这个人补一条人物卡，先问我三个问题。"],
		],
		polish: [
			["怎么用润色", "告诉我在稿纸上选中一段之后怎么走。"],
		],
	};
	for (const [label, text] of sets[mode] || []) {
		host.append(
			el("button", {
				class: "quick-chip",
				type: "button",
				text: label,
				on: {
					click: () => {
						if (mode === "polish") {
							toast("选中正文里的一段，再按「润色这段」。");
							return;
						}
						void send(text);
					},
				},
			}),
		);
	}
}

function renderSendState() {
	const btn = $("#btn-dock-send");
	if (!btn) return;
	const has = Boolean(inputEl?.value.trim());
	btn.disabled = busy || !has;
	btn.classList.toggle("is-busy", busy);
}

function renderModelLabel() {
	const label = $("#dock-model-label");
	if (!label) return;
	const ref = ctx.state.prefs.dockModel || ctx.state.session?.model || ctx.aimModel();
	const model = ctx.state.models.find((item) => item.id === ref);
	label.textContent = model?.name || (ref ? ref.split("/").pop() : "还没接模型");
}

function openModelMenu(anchor) {
	document.querySelector(".model-menu")?.remove();
	const menu = el("div", { class: "model-menu" });
	const models = ctx.state.models || [];
	if (!models.length) {
		menu.append(el("p", { class: "model-empty", text: "还没有可用的模型" }));
	}
	let lastProvider = "";
	for (const model of models.slice(0, 40)) {
		if (model.providerLabel && model.providerLabel !== lastProvider) {
			lastProvider = model.providerLabel;
			menu.append(el("p", { class: "model-group", text: lastProvider }));
		}
		const active = (ctx.state.prefs.dockModel || ctx.aimModel()) === model.id;
		menu.append(
			el(
				"button",
				{
					class: `model-item${active ? " is-active" : ""}`,
					type: "button",
					on: {
						click: async () => {
							menu.remove();
							ctx.savePrefs({ dockModel: model.id });
							renderModelLabel();
							const session = ctx.state.session;
							if (session?.id) {
								try {
									await api.setSessionModel(session.id, { modelRef: model.id, thinkingLevel: ctx.state.prefs.dockThinking || undefined });
									toast(`换成 ${model.name}。`, "ok");
								} catch (error) {
									toast(error.message || "换不了，等这一轮说完。", "error");
								}
							} else {
								toast(`下一席用 ${model.name}。`);
							}
						},
					},
				},
				el("span", { class: "model-name", text: model.name || model.modelId }),
				model.reasoning ? el("span", { class: "tag", text: "思考" }) : null,
				model.placeholder ? el("span", { class: "tag tag-amber", text: "占位" }) : null,
			),
		);
	}
	menu.append(
		el("button", {
			class: "model-item is-more",
			type: "button",
			text: "去设置里加模型",
			on: {
				click: () => {
					menu.remove();
					document.getElementById("settings")?.showModal();
				},
			},
		}),
	);
	const rect = anchor.getBoundingClientRect();
	menu.style.left = `${Math.max(12, rect.left - 40)}px`;
	menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
	menu.style.top = "auto";
	document.body.append(menu);
	const off = (event) => {
		if (!menu.contains(event.target)) {
			menu.remove();
			window.removeEventListener("pointerdown", off, true);
		}
	};
	setTimeout(() => window.addEventListener("pointerdown", off, true), 0);
}
