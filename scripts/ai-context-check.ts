import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { trimConversation } from "../src/ai/novel-agent.ts";

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) console.log("  ✓ " + label);
	else { failures += 1; console.log("  ✗ " + label + " " + extra); }
}
const system = { role: "system", content: "系统头", timestamp: 1 } as AgentMessage;
const user = (text: string) => ({ role: "user", content: text, timestamp: 2 }) as AgentMessage;
const calls = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read_chapter", arguments: {} }], timestamp: 3 }) as AgentMessage;
const result = (id: string, text = "结果") => ({ role: "toolResult", toolCallId: id, toolName: "read_chapter", content: [{ type: "text", text }], isError: false, timestamp: 4 }) as AgentMessage;
const digest = { role: "system", content: "digest", timestamp: 5 } as AgentMessage;

console.log("\n上下文配对裁剪");
const paired = trimConversation([system, user("旧问题"), calls("a"), result("a"), user("最新问题")], digest);
check("系统头和最新用户保留", paired[0] === system && paired.at(-1)?.role === "user" && JSON.stringify(paired.at(-1)).includes("最新问题"));
check("调用与结果成组保留", paired.some((m) => m.role === "assistant") && paired.some((m) => m.role === "toolResult"));
const orphan = trimConversation([system, result("orphan"), user("最新问题")], digest);
check("孤儿 toolResult 被删除", !orphan.some((m) => m.role === "toolResult"));
const dangling = trimConversation([system, calls("missing"), user("最新问题")], digest);
check("缺结果的 toolCall 被删除", !dangling.some((m) => m.role === "assistant"));

const many: AgentMessage[] = [system];
for (let i = 0; i < 30; i += 1) many.push(calls("call-" + i), result("call-" + i));
many.push(user("最后一轮"));
const capped = trimConversation(many, digest);
const callIds = new Set(capped.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.id) : []));
const resultIds = capped.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []);
check("超过工具组上限按整组裁剪", resultIds.length === 24 && callIds.size === resultIds.length && resultIds.every((id) => callIds.has(id)), resultIds.length + "/" + callIds.size);
check("最新用户在大量工具消息后仍保留", capped.at(-1)?.role === "user");

const huge: AgentMessage[] = [system];
for (let i = 0; i < 5; i += 1) huge.push(calls("huge-" + i), result("huge-" + i, "字".repeat(25_000)));
huge.push(user("大问题" + "新".repeat(1000)));
const budgeted = trimConversation(huge, digest);
const budgetCalls = new Set(budgeted.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.id) : []));
const budgetResults = budgeted.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []);
check("字符预算裁剪不产生孤儿", budgetCalls.size === budgetResults.length && budgetResults.every((id) => budgetCalls.has(id)), budgetCalls.size + "/" + budgetResults.length);
check("字符预算仍保留系统头/digest/最新用户", budgeted[0] === system && budgeted[1] === digest && budgeted.at(-1)?.role === "user");

process.exit(failures === 0 ? 0 : 1);
