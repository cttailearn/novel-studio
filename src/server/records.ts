/**
 * 生成记录的纯模型层：类型、摘要、裁剪、归一化。
 *
 * 这一层不碰文件系统，因此可以原样搬进浏览器 ——
 * 浏览器端的 IndexedDB 版记录库只需要实现同一个接口
 * （RecordStorePort，见 store-port.ts）。
 * 磁盘实现见 records-disk.ts；两侧共用这里定义的数据形状与纯函数。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RecordStorePort } from "../store/store-port.ts";

/**
 * 生成记录：每一轮落笔的对话都留下来。
 *
 * 留它是因为作者会回头看：「上一版是怎么写的」「那会儿我让它改的是哪一句」。
 * 所以记的必须是**完整消息**（含工具调用与工具结果），只记成一段摘要，
 * 就没法照着它接着写了 —— 而"接着写"正是这个功能存在的理由。
 *
 * 每个面板（role + 作品 + 章节）只留最近 10 条：再多也没人翻，
 * 而 messages 里躺着整章正文与工具结果，攒一年能到几十兆。
 */
export type RecordRole = "material" | "writing";

/** 一块面板的留存条数。 */
export const RECORDS_KEEP = 10;

/**
 * 单条记录的体积上限。
 *
 * 一轮里可能读过整章正文、整份素材，全部留着会让 records.json 迅速胀到几十兆，
 * 每次落盘都要重写整份文件。超了就丢最老的消息 —— 最近几轮才是作者要接着写的。
 */
export const MAX_RECORD_BYTES = 512 * 1024;

export interface GenerationRecord {
	id: string;
	role: RecordRole;
	projectId: string;
	chapterId?: string;
	/** 通用素材库那一席不属于任何作品，靠这个标记区分。 */
	libraryScope?: boolean;
	title: string;
	/** 列表里显示的一行摘要，取最后一句助手的话。 */
	preview: string;
	createdAt: number;
	updatedAt: number;
	messages: AgentMessage[];
}

/** 列表用的轻量视图：不带 messages，否则列一次记录就把几十兆传给了浏览器。 */
export interface RecordSummary {
	id: string;
	role: RecordRole;
	projectId: string;
	chapterId?: string;
	libraryScope?: boolean;
	title: string;
	preview: string;
	messageCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface RecordFilter {
	role?: RecordRole;
	projectId?: string;
	chapterId?: string;
	libraryScope?: boolean;
}

/** 记录文件的形状。 */
export interface RecordsFile {
	version: 1;
	records: GenerationRecord[];
}

export function isRecordRole(value: unknown): value is RecordRole {
	return value === "material" || value === "writing";
}

/** 从消息里摘一句能看懂的话，列表上用来认记录。 */
export function previewOf(messages: AgentMessage[]): string {
	const textOf = (message: AgentMessage): string => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				const item = part as { type?: string; text?: string };
				return item.type === "text" && typeof item.text === "string" ? item.text : "";
			})
			.join(" ");
	};
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const text = textOf(message).replace(/\s+/g, " ").trim();
		if (text) return text.slice(0, 90);
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		const text = textOf(message).replace(/\s+/g, " ").trim();
		if (text) return text.slice(0, 90);
	}
	return "";
}

/** 超出体积上限时从最老的消息开始丢，最近几轮一定留着。 */
export function trimForStorage(messages: AgentMessage[]): AgentMessage[] {
	let total = 0;
	const kept: AgentMessage[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		let size = 0;
		try {
			size = JSON.stringify(message).length;
		} catch {
			size = 0;
		}
		// 至少留 4 条：再少就剩不下"问了什么、答了什么"。
		if (total + size > MAX_RECORD_BYTES && kept.length >= 4) break;
		total += size;
		kept.unshift(message);
	}
	return kept;
}

/** 面板归属：同一块面板的记录才互相挤占那 10 个名额。 */
export function scopeKey(record: GenerationRecord): string {
	return [record.role, record.libraryScope ? "library" : record.projectId, record.chapterId ?? ""].join(":");
}

/** 把完整记录压成列表用的轻量视图。 */
export function toSummary(record: GenerationRecord): RecordSummary {
	const summary: RecordSummary = {
		id: record.id,
		role: record.role,
		projectId: record.projectId,
		title: record.title,
		preview: record.preview,
		messageCount: record.messages.length,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (record.chapterId) summary.chapterId = record.chapterId;
	if (record.libraryScope) summary.libraryScope = true;
	return summary;
}

/** 归一化一条记录。坏数据在这里被挡掉，不进内存。 */
export function normalizeRecord(raw: unknown): GenerationRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<GenerationRecord> & { messages?: unknown };
	if (typeof input.id !== "string" || !input.id) return undefined;
	if (!isRecordRole(input.role)) return undefined;
	if (typeof input.projectId !== "string") return undefined;
	const messages = Array.isArray(input.messages) ? (input.messages as AgentMessage[]) : [];
	const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
	return {
		id: input.id,
		role: input.role,
		projectId: input.projectId,
		...(typeof input.chapterId === "string" ? { chapterId: input.chapterId } : {}),
		...(input.libraryScope === true ? { libraryScope: true } : {}),
		title: typeof input.title === "string" && input.title.trim() ? input.title : "未命名的一轮",
		preview: typeof input.preview === "string" ? input.preview : previewOf(messages),
		createdAt,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : createdAt,
		messages,
	};
}

/**
 * 生成记录存储这个角色。
 *
 * 只留名字：磁盘实现见 records-disk.ts，浏览器端见 IndexedDB 版。
 */
export type RecordStore = RecordStorePort;
