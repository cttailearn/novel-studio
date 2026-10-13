/**
 * 智能体循环的端到端测试。
 * 使用 pi-ai 自带的 faux provider 脚本化模型响应，因此不需要任何 API Key，
 * 却能真实走完 “模型输出 → 工具调用 → 工具执行 → 结果回填 → 下一轮” 的完整链路。
 *
 * 运行：pnpm test
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

	// 脚本化三轮模型响应：建大纲 → 写正文 → 收尾
	const faux = fauxProvider({ tokensPerSecond: 10000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("update_outline", {
			chapters: [
				{ id: "ch01", title: "第一章", summary: "开场", targetWords: 3000, status: "planned" },
			],
		})),
		fauxAssistantMessage(fauxToolCall("write_chapter", {
			chapterId: "ch01",
			title: "第一章",
			content: "雨停了三天。",
			mode: "create",
		})),
		fauxAssistantMessage([fauxText("已完成第一章的大纲与初稿。")], { stopReason: "stop" }),
	]);

	const agent = createNovelAgent({
		store,
		projectId: project.id,
		model,
		models,
		config,
		sessionId: "loop-test",
	});

	// 收集事件序列
	const events: AgentEvent[] = [];
	const types: string[] = [];
	agent.subscribe((event) => {
		events.push(event);
		types.push(event.type);
	});

	await agent.prompt("帮我把开篇写出来。");

	console.log("\n事件流");
	const seq = [...new Set(types)];
	console.log("  序列: " + seq.join(" → "));
	check("以 agent_start 开始", types[0] === "agent_start", types[0]);
	check("以 agent_end 结束", types[types.length - 1] === "agent_end", types[types.length - 1]);
	check("三个 turn", types.filter((t) => t === "turn_start").length === 3, String(types.filter((t) => t === "turn_start").length));
	check("有流式增量事件", types.filter((t) => t === "message_update").length > 0);
	check("有工具执行事件", types.filter((t) => t === "tool_execution_start").length === 2);
	check("工具全部成功", events.filter((e) => e.type === "tool_execution_end" && !e.isError).length === 2);
	check("智能体最终非流", agent.state.isStreaming === false);
	check("无错误状态", agent.state.errorMessage === undefined, String(agent.state.errorMessage));

	console.log("\n工具执行结果");
	const final = store.get(project.id)!;
	check("update_outline 已落盘", final.outline.length === 1 && final.outline[0]?.id === "ch01");
	check("write_chapter 已落盘", final.drafts.ch01?.content === "雨停了三天。");
	check("正文版本为 1", final.drafts.ch01?.revision === 1);
	check("大纲状态自动更新为 drafted", final.outline[0]?.status === "drafted", String(final.outline[0]?.status));

	console.log("\n上下文管理");
	// agent.state.messages 返回的是内部数组本身，测试里只能取长度快照，不能保留引用。
	const messages = [...agent.state.messages];
	check("已积累对话历史", messages.length > 1, String(messages.length));
	check("首条是系统提示词", messages[0]?.role === "system");
	check("系统提示词含工具声明", JSON.stringify(messages[0]).includes("write_chapter"));
	check("工具结果已回填到上下文", messages.some((m) => m.role === "toolResult"));

	// 第二轮：transformContext 应注入工程快照
	const store2 = await ProjectStore.open(dir);
	store2.create({ title: "另一个工程" });
	faux.setResponses([fauxAssistantMessage([fauxText("第二轮回复")])]);
	await agent.prompt("再说一句");
	const afterSecond = [...agent.state.messages];
	check("第二轮追加了历史", afterSecond.length > messages.length, messages.length + " -> " + afterSecond.length);
	check("第二轮后系统提示词仍在头部", afterSecond[0]?.role === "system");
	check("第二轮后无残留错误", agent.state.errorMessage === undefined);

	console.log("\n流式内容");
	const assistantText = events
		.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
		.map((e) => (e as any).assistantMessageEvent.delta as string)
		.join("");
	check("收到文本增量", assistantText.includes("已完成第一章"), JSON.stringify(assistantText.slice(0, 40)));
} finally {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
