import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
const MAX_RECORD_BYTES = 512 * 1024;

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

interface RecordsFile {
	version: 1;
	records: GenerationRecord[];
}

function isRecordRole(value: unknown): value is RecordRole {
	return value === "material" || value === "writing";
}

/** 从消息里摘一句能看懂的话，列表上用来认记录。 */
function previewOf(messages: AgentMessage[]): string {
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
function trimForStorage(messages: AgentMessage[]): AgentMessage[] {
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
function scopeKey(record: GenerationRecord): string {
	return [record.role, record.libraryScope ? "library" : record.projectId, record.chapterId ?? ""].join(":");
}

function toSummary(record: GenerationRecord): RecordSummary {
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

function normalizeRecord(raw: unknown): GenerationRecord | undefined {
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

export class RecordStore {
	private records: GenerationRecord[];

	private writeChain: Promise<void> = Promise.resolve();

	private readonly file: string;

	private constructor(file: string, records: GenerationRecord[]) {
		this.file = file;
		this.records = records;
	}

	static async open(dataDir: string): Promise<RecordStore> {
		await mkdir(dataDir, { recursive: true });
		const file = path.join(dataDir, "records.json");
		const raw = await readFile(file, "utf8").catch(() => undefined);
		if (raw === undefined) return new RecordStore(file, []);

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			// 同设置文件：坏了就把原文隔离起来，别让下一次落盘把它盖掉。
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const kept = file + ".corrupt-" + stamp;
			try {
				await rename(file, kept);
				console.error(
					"[records] 记录文件不是合法 JSON，已隔离为 " + path.basename(kept) + "，本次从空记录开始。",
					error,
				);
			} catch (renameError) {
				console.error("[records] 记录文件不是合法 JSON，且隔离改名失败:", renameError, error);
			}
			return new RecordStore(file, []);
		}

		const list = (parsed as Partial<RecordsFile>)?.records;
		const records = Array.isArray(list)
			? list.map((item) => normalizeRecord(item)).filter((item): item is GenerationRecord => Boolean(item))
			: [];
		return new RecordStore(file, records);
	}

	list(filter: RecordFilter = {}, limit = RECORDS_KEEP): RecordSummary[] {
		return this.records
			.filter((record) => {
				if (filter.role && record.role !== filter.role) return false;
				if (filter.projectId && record.projectId !== filter.projectId) return false;
				if (filter.chapterId && record.chapterId !== filter.chapterId) return false;
				if (filter.libraryScope !== undefined && Boolean(record.libraryScope) !== filter.libraryScope) return false;
				return true;
			})
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, Math.max(1, limit))
			.map((record) => toSummary(record));
	}

	get(id: string): GenerationRecord | undefined {
		return this.records.find((record) => record.id === id);
	}

	/** 建一条空记录：先占住 id，这一轮怎么收场都能把消息补进去。 */
	async create(input: {
		role: RecordRole;
		projectId: string;
		chapterId?: string;
		libraryScope?: boolean;
		title: string;
	}): Promise<GenerationRecord> {
		const now = Date.now();
		const record: GenerationRecord = {
			id: randomUUID(),
			role: input.role,
			projectId: input.projectId,
			...(input.chapterId ? { chapterId: input.chapterId } : {}),
			...(input.libraryScope ? { libraryScope: true } : {}),
			title: input.title,
			preview: "",
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
		this.records.push(record);
		await this.persistWithCap();
		return record;
	}

	/** 一轮跑完（或被中止）后把消息补进记录。 */
	async saveMessages(id: string, messages: AgentMessage[], title?: string): Promise<GenerationRecord | undefined> {
		const record = this.get(id);
		if (!record) return undefined;
		const kept = trimForStorage(messages);
		record.messages = kept;
		record.preview = previewOf(kept);
		record.updatedAt = Date.now();
		if (title) record.title = title;
		await this.persistWithCap();
		return record;
	}

	async rename(id: string, title: string): Promise<void> {
		const record = this.get(id);
		if (!record) return;
		record.title = title;
		await this.persistWithCap();
	}

	async remove(id: string): Promise<boolean> {
		const before = this.records.length;
		this.records = this.records.filter((record) => record.id !== id);
		if (this.records.length === before) return false;
		await this.persistWithCap();
		return true;
	}

	/** 落盘前先按面板裁到 10 条，文件大小才有上界。 */
	private async persistWithCap(): Promise<void> {
		const keptByScope = new Map<string, GenerationRecord[]>();
		for (const record of this.records) {
			const key = scopeKey(record);
			const bucket = keptByScope.get(key) ?? [];
			bucket.push(record);
			keptByScope.set(key, bucket);
		}
		const survivors = new Set<string>();
		for (const bucket of keptByScope.values()) {
			bucket
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.slice(0, RECORDS_KEEP)
				.forEach((record) => survivors.add(record.id));
		}
		const next = this.records.filter((record) => survivors.has(record.id));
		if (next.length !== this.records.length) this.records = next;
		await this.persist();
	}

	/**
	 * 串行化落盘，写临时文件再改名（Windows 上 rename 覆盖已存在文件会偶发 EPERM，重试几次）。
	 * 与 settings-store 同一套写法：记录文件坏掉的代价不大，但"写一半"的代价很大。
	 */
	private persist(): Promise<void> {
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const payload: RecordsFile = { version: 1, records: this.records };
				const tmp = this.file + "." + randomUUID() + ".tmp";
				await writeFile(tmp, JSON.stringify(payload), "utf8");
				for (let attempt = 0; ; attempt++) {
					try {
						await rename(tmp, this.file);
						return;
					} catch (error) {
						if (attempt >= 4) throw error;
						await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
					}
				}
			})
			.catch((error) => console.error("[records] 落盘失败:", error))
			.then(() => undefined);
		return this.writeChain;
	}
}
