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
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createNovelAgent } from "../src/ai/novel-agent.ts";
import { ProjectStore } from "../src/store/project.ts";
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

	const materialAgent = createNovelAgent({
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

	const writingAgent = createNovelAgent({
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
	check("正文已落盘", afterWriting.drafts.ch01?.content === "雨停了三天。");
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
} finally {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
