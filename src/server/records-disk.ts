/**
 * 生成记录的磁盘持久化实现。
 *
 * 纯模型（类型、摘要、裁剪、归一化）在 records.ts —— 那一层不碰文件系统，
 * 所以浏览器端的 IndexedDB 实现可以照着同一个接口重写一遍。
 * 本文件只负责把记录落到 <dataDir>/records.json。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { newId } from "../store/project.ts";
import {
	normalizeRecord,
	previewOf,
	RECORDS_KEEP,
	scopeKey,
	toSummary,
	trimForStorage,
	type GenerationRecord,
	type RecordFilter,
	type RecordRole,
	type RecordSummary,
	type RecordsFile,
} from "./records.ts";
import type { RecordStorePort } from "../store/store-port.ts";

/**
 * 生成记录的存储。
 *
 * 每个面板（role + 作品 + 章节）只留最近 10 条，落盘前先裁一遍，
 * 所以 records.json 的大小有上界，不会随着用得越久越胀。
 */
export class RecordStore implements RecordStorePort {
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
			id: newId(),
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
				const tmp = this.file + "." + newId() + ".tmp";
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
