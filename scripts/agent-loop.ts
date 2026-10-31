/**
 * 智能体循环的端到端测试。
 * 使用 pi-ai 自带的 faux provider 脚本化模型响应，因此不需要任何 API Key，
 * 却能真实走完两个智能体各自的 "模型输出 → 工具调用 → 工具执行 → 结果回填 → 下一轮"。
 *
 * 运行：pnpm test:loop
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createNovelAgent, trimConversation } from "../src/ai/novel-agent.ts";
import type { AskBroker, AskRequest } from "../src/ai/ask.ts";
import { ProjectStore } from "../src/store/project-disk.ts";
import { readConfig } from "../src/config/env.ts";

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
}

const config = readConfig();
const dir = await mkdtemp(path.join(tmpdir(), "novel-studio-loop-"));

try {
	const store = await ProjectStore.open(dir);
	const project = store.create({ title: "循环测试", genre: "悬疑", targetWords: 100000 });

	const faux = fauxProvider({ tokensPerSecond: 10000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();

	// 捕获真正发给模型的消息：transformContext 的结果不在 state.messages 里，
	// 它只存在于每次请求的上下文中。断言必须打在这里才准。
	const sentRequests: string[] = [];
	const record = (context: { messages: unknown[] }) => {
		sentRequests.push(JSON.stringify(context.messages));
	};

	// ───────────────────────────────── 素材智能体
	console.log("\n素材智能体循环");
	// 脚本化三轮：立章 → 造料并装料 → 收尾
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("update_outline", {
			chapters: [
				{ id: "ch01", title: "第一章", summary: "开场", targetWords: 3000, status: "planned" },
			],
		})),
		fauxAssistantMessage(fauxToolCall("upsert_material", {
			kind: "character",
			title: "林晓",
			content: "痕迹鉴定员，习惯用左手记笔记。",
			usage: "雨夜追踪戏，交代她的职业与观察习惯",
			chapterIds: ["ch01"],
		})),
		fauxAssistantMessage([fauxText("已备好第一章的料。")], { stopReason: "stop" }),
	]);

	const materialAgent = await createNovelAgent({
		store,
		projectId: project.id,
		model,
		models,
		config,
		sessionId: "material-loop",
		role: "material",
	});

	const materialEvents: AgentEvent[] = [];
	const materialTypes: string[] = [];
	materialAgent.subscribe((event) => {
		materialEvents.push(event);
		materialTypes.push(event.type);
	});

	await materialAgent.prompt("给第一章备料。");

	check("以 agent_start 开始", materialTypes[0] === "agent_start", materialTypes[0]);
	check("以 agent_end 结束", materialTypes[materialTypes.length - 1] === "agent_end");
	check("三个 turn", materialTypes.filter((t) => t === "turn_start").length === 3, String(materialTypes.filter((t) => t === "turn_start").length));
	check("执行了两次工具", materialTypes.filter((t) => t === "tool_execution_start").length === 2);
	check("工具全部成功", materialEvents.filter((e) => e.type === "tool_execution_end" && !e.isError).length === 2);
	check("无错误状态", materialAgent.state.errorMessage === undefined, String(materialAgent.state.errorMessage));

	const afterMaterial = store.get(project.id)!;
	check("update_outline 已落盘", afterMaterial.outline.length === 1 && afterMaterial.outline[0]?.id === "ch01");
	check("素材已落盘", afterMaterial.materials.length === 1 && afterMaterial.materials[0]?.title === "林晓");
	check("usage 已记录", Boolean(afterMaterial.materials[0]?.usage.includes("雨夜追踪戏")));
	check("素材自动关联到章节", afterMaterial.outline[0]?.materialIds.length === 1, String(afterMaterial.outline[0]?.materialIds.length));
	check("未写入任何正文", Object.keys(afterMaterial.drafts).length === 0);

	const materialMessages = [...materialAgent.state.messages];
	check("已积累对话历史", materialMessages.length > 1, String(materialMessages.length));
	check("首条是系统提示词", materialMessages[0]?.role === "system");
	check("工具结果已回填到上下文", materialMessages.some((m) => m.role === "toolResult"));
	check(
		"系统提示词声明素材智能体不写正文",
		String(materialMessages[0]?.content).includes("不写正文"),
	);
	check(
		"素材提示词要求 content 精减",
		String(materialMessages[0]?.content).includes("精减是硬要求"),
	);
	check(
		"素材提示词声明题材不设边界",
		String(materialMessages[0]?.content).includes("题材不设边界"),
	);

	const materialText = materialEvents
		.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
		.map((e) => (e as any).assistantMessageEvent.delta as string)
		.join("");
	check("收到文本增量", materialText.includes("已备好第一章"), JSON.stringify(materialText.slice(0, 40)));

	// ───────────────────────────────── 组装智能体
	console.log("\n组装智能体循环");
	const materialId = afterMaterial.materials[0]!.id;

	faux.setResponses([
		(context) => {
			record(context as unknown as { messages: unknown[] });
			return fauxAssistantMessage(fauxToolCall("write_chapter", {
			chapterId: "ch01",
			title: "第一章",
			content: "雨停了三天。",
			mode: "create",
			materialIds: [materialId],
			}));
		},
		fauxAssistantMessage([fauxText("本章已成稿。")], { stopReason: "stop" }),
	]);

	const writingAgent = await createNovelAgent({
		store,
		projectId: project.id,
		model,
		models,
		config,
		sessionId: "writing-loop",
		role: "writing",
		chapterId: "ch01",
	});

	const writingEvents: AgentEvent[] = [];
	const writingTypes: string[] = [];
	writingAgent.subscribe((event) => {
		writingEvents.push(event);
		writingTypes.push(event.type);
	});

	await writingAgent.prompt("写出本章。");

	check("写作智能体无错误", writingAgent.state.errorMessage === undefined, String(writingAgent.state.errorMessage));
	check("执行了 write_chapter", writingTypes.filter((t) => t === "tool_execution_start").length === 1);
	check(
		"工具全部成功",
		writingEvents.filter((e) => e.type === "tool_execution_end" && !e.isError).length === 1,
	);

	const afterWriting = store.get(project.id)!;
	// 正文已挪到磁盘上的 .txt，元数据只留字数与版本 —— 断言要去读正文本体。
	const writtenBody = await store.readDraftBody(project.id, "ch01");
	check("正文已落盘", writtenBody?.content === "雨停了三天。", String(writtenBody?.content));
	check("版本号为 1", afterWriting.drafts.ch01?.revision === 1);
	check("记录用到的素材", afterWriting.drafts.ch01?.materialIds[0] === materialId);
	check("大纲状态自动更新为 drafted", afterWriting.outline[0]?.status === "drafted", String(afterWriting.outline[0]?.status));

	const writingMessages = [...writingAgent.state.messages];
	const systemPrompt = String(writingMessages[0]?.content);
	check("写作提示词带出本章素材全文", systemPrompt.includes("痕迹鉴定员"), "");
	check("写作提示词声明唯一事实来源", systemPrompt.includes("唯一"));
	check("写作提示词声明题材不设边界", systemPrompt.includes("题材不设边界"));
	// 素材全文由系统提示词带出（上面已断言），这里只确认请求里确实带了那一条素材，
	// 且不再由 digest 重复注入一遍。
	check(
		"写作请求带出本章素材",
		sentRequests.some((payload) => payload.includes("痕迹鉴定员")),
	);
	check(
		"写作快照不重复注入素材全文",
		!sentRequests.some((payload) => payload.includes("本章素材（写作依据）")),
	);
	check(
		"写作工具集不含素材写入",
		!JSON.stringify((writingAgent.state as unknown as { tools?: { name: string }[] }).tools ?? []).includes("upsert_material"),
	);

	// ───────────────────────────────── 局部修改
	console.log("\n局部修改");
	// 整章重写的风险在"改动量"不受控：patch 档要证明没点名的字一个都没动。
	// 先落一版可控的长正文 —— write_chapter 的产物只有一句，挑不出"唯一"与"重复"两种定位。
	const patchBody = [
		"雨停了三天。",
		"裴渡在渡口数人头，数到第十九个就停了。",
		"他没再往下数。",
		"江面起了雾。",
		"江面起了雾。船在雾里像一块没写完的字。",
	].join("\n\n");
	const patchSeed = await store.saveDraftBody(project.id, "ch01", {
		title: "第一章",
		content: patchBody,
		summary: "雨停后，裴渡在渡口数人头。",
		materialIds: [materialId],
		mode: "rewrite",
		keepHistory: true,
	});
	check("局部修改的基线正文已落盘", patchSeed.revision === 2, String(patchSeed.revision));

	// 一次性成文走 patch：提示词必须点名 revise_chapter，且不能退回"整章落稿"的作业。
	const patchChapter = store.get(project.id)!.outline.find((chapter) => chapter.id === "ch01")!;
	const patchAgent = await createNovelAgent({
		store,
		projectId: project.id,
		model,
		models,
		config,
		sessionId: "patch-loop",
		role: "writing",
		chapterId: "ch01",
		writing: {
			chapter: patchChapter,
			materials: [],
			existing: {
				id: "ch01",
				title: patchSeed.title,
				content: patchBody,
				summary: patchSeed.summary,
				revision: patchSeed.revision,
				updatedAt: patchSeed.updatedAt,
				materialIds: patchSeed.materialIds,
				history: [],
			},
			mode: "patch",
		},
	});

	// 工具集是角色边界：改正文是执笔者的活，备料的不该有这把刀。
	const patchToolNames = ((patchAgent.state as unknown as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
	check("写作智能体的工具集含 revise_chapter", patchToolNames.includes("revise_chapter"), patchToolNames.join(","));
	const patchMaterialToolNames = ((materialAgent.state as unknown as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
	check(
		"素材智能体的工具集不含 revise_chapter",
		!patchMaterialToolNames.includes("revise_chapter"),
		patchMaterialToolNames.join(","),
	);

	const patchEvents: AgentEvent[] = [];
	patchAgent.subscribe((event) => {
		patchEvents.push(event);
	});
	const lastPatchToolEnd = (): Extract<AgentEvent, { type: "tool_execution_end" }> | undefined =>
		patchEvents
			.filter((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end")
			.at(-1);
	const patchToolText = (event: Extract<AgentEvent, { type: "tool_execution_end" }> | undefined): string =>
		(event?.result?.content ?? [])
			.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
			.join("\n");

	// 正例：find 是正文里唯一的一段，替换必须只落在那一段上。
	const patchFind = "裴渡在渡口数人头，数到第十九个就停了。";
	const patchReplace = "裴渡在渡口数人头，数到第二十个才停。";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("revise_chapter", {
			chapterId: "ch01",
			find: patchFind,
			replace: patchReplace,
		})),
		fauxAssistantMessage([fauxText("改好这一处。")], { stopReason: "stop" }),
	]);
	await patchAgent.prompt("把数人头那句改成第二十个。");

	const patchPromptText = String(patchAgent.state.messages[0]?.content);
	check("patch 提示词要求用 revise_chapter", patchPromptText.includes("revise_chapter"));
	check("patch 提示词声明只动点名的那几处", patchPromptText.includes("只动点名的那几处"));
	check("patch 提示词带出现有正文", patchPromptText.includes("现有正文"));
	check("patch 提示词不再要求整章落稿", !patchPromptText.includes("一次写完"));
	check("patch 提示词不退回整章重写", !patchPromptText.includes("整章重写。旧稿会被这次输出整体替换"));

	const patchFirstEnd = lastPatchToolEnd();
	const patchAfterFirst = await store.readDraftBody(project.id, "ch01");
	check("revise_chapter 执行成功", patchFirstEnd?.isError === false, JSON.stringify(patchFirstEnd?.isError));
	check("revise_chapter 工具名对得上", patchFirstEnd?.toolName === "revise_chapter", String(patchFirstEnd?.toolName));
	check(
		"正文只换了点名的那一处",
		patchAfterFirst?.content === patchBody.replace(patchFind, patchReplace),
		String(patchAfterFirst?.content),
	);
	check(
		"其余段落一字未动",
		patchAfterFirst?.content?.startsWith("雨停了三天。\n\n") === true
			&& patchAfterFirst?.content?.includes("他没再往下数。") === true
			&& patchAfterFirst?.content?.endsWith("江面起了雾。船在雾里像一块没写完的字。") === true,
		String(patchAfterFirst?.content),
	);
	check("局部修改后版本号递增 1", store.get(project.id)!.drafts.ch01?.revision === patchSeed.revision + 1);
	check("返回文案点明其余一字未动", patchToolText(patchFirstEnd).includes("其余一字未动"), patchToolText(patchFirstEnd));

	// 反例一：同一段原文出现两次时宁可报错也不猜 —— 猜错就是改坏了别处。
	const patchTwiceFind = "江面起了雾。";
	const patchBeforeTwice = patchAfterFirst!.content;
	const revisionBeforeTwice = store.get(project.id)!.drafts.ch01!.revision;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("revise_chapter", {
			chapterId: "ch01",
			find: patchTwiceFind,
			replace: "江面上浮着一层白。",
		})),
		fauxAssistantMessage([fauxText("这处指不准，先停。")], { stopReason: "stop" }),
	]);
	await patchAgent.prompt("把江面起了雾改掉。");
	const patchTwiceEnd = lastPatchToolEnd();
	const patchAfterTwice = await store.readDraftBody(project.id, "ch01");
	check("重复原文：工具报错", patchTwiceEnd?.isError === true);
	check("重复原文：正文完全没变", patchAfterTwice?.content === patchBeforeTwice, String(patchAfterTwice?.content));
	check("重复原文：版本号没动", store.get(project.id)!.drafts.ch01?.revision === revisionBeforeTwice);
	check("重复原文：文案点明不止一处", patchToolText(patchTwiceEnd).includes("不止一处"), patchToolText(patchTwiceEnd));

	// 反例二：正文里根本没有这段原文 —— 报错让模型拿着 read_chapter 的原文重试。
	const patchMissingFind = "渡口的灯灭了。";
	const patchBeforeMissing = patchAfterTwice!.content;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("revise_chapter", {
			chapterId: "ch01",
			find: patchMissingFind,
			replace: "渡口的灯亮了。",
		})),
		fauxAssistantMessage([fauxText("原文对不上，不硬改。")], { stopReason: "stop" }),
	]);
	await patchAgent.prompt("把渡口那盏灯改掉。");
	const patchMissingEnd = lastPatchToolEnd();
	const patchAfterMissing = await store.readDraftBody(project.id, "ch01");
	check("找不到原文：工具报错", patchMissingEnd?.isError === true);
	check("找不到原文：正文没变", patchAfterMissing?.content === patchBeforeMissing, String(patchAfterMissing?.content));
	check("找不到原文：文案点明找不到", patchToolText(patchMissingEnd).includes("找不到这段原文"), patchToolText(patchMissingEnd));

	// 反例三：章号不在大纲里时不造"幽灵正文"。
	const patchBeforeGhost = patchAfterMissing!.content;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("revise_chapter", {
			chapterId: "ch09",
			find: "雨停了三天。",
			replace: "雨没停。",
		})),
		fauxAssistantMessage([fauxText("章号不对，先确认。")], { stopReason: "stop" }),
	]);
	await patchAgent.prompt("改第九章第一句。");
	const patchGhostEnd = lastPatchToolEnd();
	check("不存在的章节：工具报错", patchGhostEnd?.isError === true);
	check("不存在的章节：正文没变", (await store.readDraftBody(project.id, "ch01"))?.content === patchBeforeGhost);
	check("不存在的章节：文案点明章节范围", patchToolText(patchGhostEnd).includes("只允许操作章节"), patchToolText(patchGhostEnd));

	// 空 replace：删掉那一段，和"替换成空串"逐字等价。
	const patchDeleteFind = "他没再往下数。\n\n";
	const patchBeforeDelete = patchAfterMissing!.content;
	const revisionBeforeDelete = store.get(project.id)!.drafts.ch01!.revision;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("revise_chapter", {
			chapterId: "ch01",
			find: patchDeleteFind,
			replace: "",
		})),
		fauxAssistantMessage([fauxText("删掉了。")], { stopReason: "stop" }),
	]);
	await patchAgent.prompt("那句多余，删掉。");
	const patchDeleteEnd = lastPatchToolEnd();
	const patchAfterDelete = await store.readDraftBody(project.id, "ch01");
	check("空 replace：执行成功", patchDeleteEnd?.isError === false);
	check(
		"空 replace：那一段被删掉",
		patchAfterDelete?.content === patchBeforeDelete.replace(patchDeleteFind, ""),
		String(patchAfterDelete?.content),
	);
	check("空 replace：这一段确实不在了", patchAfterDelete?.content?.includes("他没再往下数") === false);
	check("空 replace：其余段落还在", patchAfterDelete?.content?.includes("江面起了雾。") === true);
	check("空 replace：版本号递增 1", store.get(project.id)!.drafts.ch01?.revision === revisionBeforeDelete + 1);
	check("局部修改智能体无错误", patchAgent.state.errorMessage === undefined, String(patchAgent.state.errorMessage));

	// ───────────────────────────────── 上下文管理
	console.log("\n上下文管理");
	// 第二轮：验证多轮对话下素材仍能落盘。
	// agent-loop 只在"有工具调用待处理"时继续下一轮，纯文本的 stopReason
	// 不会让它多走一步，所以这一轮直接从工具调用开始。
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("upsert_material", {
			kind: "plot",
			title: "排水口",
			content: "街区的雨水都排向同一个老排水口。",
			usage: "雨夜追踪戏的收束点",
		})),
		fauxAssistantMessage([fauxText("已补。")], { stopReason: "stop" }),
	]);
	await materialAgent.prompt("再加一条桥段素材。");
	const afterSecond = [...materialAgent.state.messages];
	check("第二轮追加了历史", afterSecond.length > materialMessages.length, materialMessages.length + " -> " + afterSecond.length);
	check("第二轮后系统提示词仍在头部", afterSecond[0]?.role === "system");
	check("第二轮后无残留错误", materialAgent.state.errorMessage === undefined);
	check("第二轮素材也落盘", store.get(project.id)!.materials.length === 2);

	const systemMessage = { role: "system", content: "系统头", timestamp: 1 } as AgentMessage;
	const userMessage = (text: string) => ({ role: "user", content: text, timestamp: 2 }) as AgentMessage;
	const callMessage = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read_chapter", arguments: {} }], timestamp: 3 }) as AgentMessage;
	const resultMessage = (id: string, text = "结果") => ({ role: "toolResult", toolCallId: id, toolName: "read_chapter", content: [{ type: "text", text }], isError: false, timestamp: 4 }) as AgentMessage;
	const digestMessage = { role: "system", content: "digest", timestamp: 5 } as AgentMessage;
	const paired = trimConversation([systemMessage, callMessage("a"), resultMessage("a"), userMessage("最新问题")], digestMessage);
	check("配对裁剪保留完整工具组", paired.some((m) => m.role === "assistant") && paired.some((m) => m.role === "toolResult"));
	check("孤儿结果与悬空调用都移除", !trimConversation([systemMessage, resultMessage("orphan"), callMessage("dangling"), userMessage("最新")], digestMessage).some((m) => m.role === "toolResult" || m.role === "assistant"));
	const many: AgentMessage[] = [systemMessage];
	for (let i = 0; i < 30; i += 1) many.push(callMessage("call-" + i), resultMessage("call-" + i));
	many.push(userMessage("最后一轮"));
	const capped = trimConversation(many, digestMessage);
	const callIds = new Set(capped.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.id) : []));
	const resultIds = capped.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []);
	check("工具组上限按配对裁剪", resultIds.length === 24 && callIds.size === 24 && resultIds.every((id) => callIds.has(id)), resultIds.length + "/" + callIds.size);
	check("裁剪保留系统头/digest/最新用户", capped[0] === systemMessage && capped[1] === digestMessage && capped.at(-1)?.role === "user");
	const huge: AgentMessage[] = [systemMessage];
	for (let i = 0; i < 5; i += 1) huge.push(callMessage("huge-" + i), resultMessage("huge-" + i, "字".repeat(25_000)));
	huge.push(userMessage("大问题" + "新".repeat(1000)));
	const budgeted = trimConversation(huge, digestMessage);
	const budgetCalls = new Set(budgeted.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.id) : []));
	const budgetResults = budgeted.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []);
	check("字符预算不产生孤儿", budgetCalls.size === budgetResults.length && budgetResults.every((id) => budgetCalls.has(id)), budgetCalls.size + "/" + budgetResults.length);
	check("字符预算仍保留最新用户", budgeted.at(-1)?.role === "user");

	store.mutate(project.id, (draft) => {
		draft.outline.push({ id: "ch02", title: "第二章", summary: "接续", pov: "", volumeId: "", status: "planned", targetWords: 1000, notes: "", materialIds: [] });
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write_chapter", { chapterId: "ch01", title: "越章", content: "不该覆盖", mode: "rewrite" })),
		fauxAssistantMessage(fauxToolCall("read_chapter", { chapterId: "ch03" })),
		fauxAssistantMessage([fauxText("本章范围已限制。")], { stopReason: "stop" }),
	]);
	const scopedAgent = await createNovelAgent({ store, projectId: project.id, model, models, config, sessionId: "scoped-writing", role: "writing", chapterId: "ch02" });
	const scopedEvents: AgentEvent[] = [];
	scopedAgent.subscribe((event) => { scopedEvents.push(event); });
	await scopedAgent.prompt("测试章节边界。");
	const scopedErrors = scopedEvents.filter((e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end" && e.isError);
	check("writing 会话强校验 write_chapter 当前章", scopedErrors.some((e) => e.toolName === "write_chapter"), String(scopedErrors.length));
	check("writing 会话 read_chapter 限制本章/上一章", scopedErrors.some((e) => e.toolName === "read_chapter"), String(scopedErrors.length));

	// ───────────────────────────────── 提问
	console.log("\n提问");

	// 假 broker：把模型发来的问题原样记下来，回一段可控的作者回答。
	const askRequests: AskRequest[] = [];
	const authorAnswer = "主角叫沈砚，出身寒门";
	const fakeBroker: AskBroker = {
		ask: async (request) => {
			askRequests.push(request);
			return authorAnswer;
		},
	};

	const askQuestion = "主角叫什么，出身如何？";
	const askOptions = ["沈砚，寒门", "陆昭，世家"];
	const askClosing = "已按作者的回答记下。";

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: askQuestion, options: askOptions })),
		fauxAssistantMessage([fauxText(askClosing)], { stopReason: "stop" }),
	]);

	const askingAgent = await createNovelAgent({
		store,
		projectId: project.id,
		model,
		models,
		config,
		sessionId: "ask-loop",
		role: "material",
		ask: fakeBroker,
	});

	const askToolNames = (askingAgent.state as unknown as { tools?: { name: string }[] }).tools?.map((t) => t.name) ?? [];
	check("工具集含 ask_user", askToolNames.includes("ask_user"), askToolNames.join(","));

	const askEvents: AgentEvent[] = [];
	askingAgent.subscribe((event) => {
		askEvents.push(event);
	});

	await askingAgent.prompt("主角还没定，先问作者。");

	check("作者被问了一次", askRequests.length === 1, String(askRequests.length));
	check("问题原样送达", askRequests[0]?.question === askQuestion, String(askRequests[0]?.question));
	check(
		"选项原样送达",
		JSON.stringify(askRequests[0]?.options) === JSON.stringify(askOptions),
		JSON.stringify(askRequests[0]?.options),
	);
	check(
		"ask_user 执行成功",
		askEvents.filter((e) => e.type === "tool_execution_end" && !e.isError).length === 1,
		String(askEvents.filter((e) => e.type === "tool_execution_end").length),
	);
	check("提问智能体无错误", askingAgent.state.errorMessage === undefined, String(askingAgent.state.errorMessage));
	check(
		"共两个 turn",
		askEvents.filter((e) => e.type === "turn_start").length === 2,
		String(askEvents.filter((e) => e.type === "turn_start").length),
	);

	// 工具结果里的文本是模型看到的那份回答 —— 作者说的话必须真的回到对话里。
	const toolResultText = (message: Extract<AgentMessage, { role: "toolResult" }>): string =>
		message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	const assistantText = (message: Extract<AgentMessage, { role: "assistant" }>): string =>
		message.content.map((c) => (c.type === "text" ? c.text : "")).join("");

	const askMessages = [...askingAgent.state.messages];
	const askResult = askMessages.find(
		(m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "ask_user",
	);
	check("工具结果已回填", Boolean(askResult));
	const askResultText = askResult ? toolResultText(askResult) : "";
	check("工具结果里带上了作者的回答", askResultText.includes(authorAnswer), askResultText);

	// 拿到回答后要在同一轮里接着往下写，而不是停在工具调用上等下一次指令。
	const afterAsk = askResult ? askMessages.slice(askMessages.indexOf(askResult) + 1) : [];
	const followUps = afterAsk.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant");
	check(
		"拿到回答后仍在同一轮继续产出",
		followUps.some((m) => assistantText(m).includes(askClosing)),
		afterAsk.map((m) => m.role).join(","),
	);

	// 反例：没有 broker 就没有提问工具 —— 问不到人的时候不该给模型一个空转的按钮。
	const noAskToolNames = (materialAgent.state as unknown as { tools?: { name: string }[] }).tools?.map((t) => t.name) ?? [];
	check("未接 broker 的智能体没有 ask_user", !noAskToolNames.includes("ask_user"), noAskToolNames.join(","));
} finally {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
