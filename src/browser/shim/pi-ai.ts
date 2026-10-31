/**
 * 浏览器端的 `@earendil-works/pi-ai` 入口。
 *
 * 构建脚本会把本文件转译成 `public/browser/vendor/pi-ai/shim.js`，并把
 * `@earendil-works/pi-ai` 这个裸说明符通过 import map 指到这里。
 *
 * 组成：
 * - pi-ai 自带的工具函数（event-stream / transcript / json-parse / validation）
 *   原样复制进 vendor/pi-ai/utils/，逻辑完全不变（validation.js 尤其不能重写，
 *   否则服务端与浏览器的校验行为会分叉）；
 * - `partial-json`、`typebox/compile`、`typebox/value` 三个裸依赖由 import map
 *   指向构建产物；
 * - 我们自己实现的 `Type` 构造器（纯 JSON Schema，无 TypeBox 内部符号）。
 *
 * 注意：这里只导出"浏览器端真正用得到"的部分，provider SDK 相关的代码一律
 * 不进浏览器。
 */
import {
	EventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import {
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	toToolDeclaration,
} from "@earendil-works/pi-ai/utils/transcript";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Type } from "./type.ts";

export { EventStream, createAssistantMessageEventStream };
export {
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	toToolDeclaration,
};
export { parseStreamingJson };
export { validateToolArguments };
export { Type };
export type { ObjectProperties, Static, TSchema } from "./type.ts";

export default {
	EventStream,
	createAssistantMessageEventStream,
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	parseStreamingJson,
	toToolDeclaration,
	Type,
	validateToolArguments,
};
