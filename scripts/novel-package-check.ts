#!/usr/bin/env node
/**
 * `.novel` 包的检查脚本。
 *
 * 用一套**内存里的假存储端口**（不碰 IndexedDB，也不碰磁盘）把导出/导入跑一遍：
 * 造数据 → 导出 → 导进另一套假存储 → 逐项比对。
 *
 * 假存储照着磁盘版 src/store/project-disk.ts 的行为写：正文变了才归档旧稿、
 * 历史最多留 10 版、版本号加一、快照按 "<时间戳>-<编码标签>.json.gz" 命名。
 *
 * 跑法：node --experimental-strip-types scripts/novel-package-check.ts
 */

import {
	countWords,
	emptyProject,
	newId,
	projectStats,
	type DeletedProject,
	type DraftBody,
	type DraftRevision,
	type Project,
	type ProjectStats,
} from "../src/store/project.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Credential, CredentialInfo } from "@earendil-works/pi-ai";
import type { Settings } from "../src/config/settings.ts";
import type { GenerationRecord, RecordFilter, RecordSummary } from "../src/server/records.ts";
import type { CustomKind, KindResult } from "../src/store/kinds.ts";
import type { LibraryMaterial, LibraryMaterialInput } from "../src/store/library.ts";
import type {
	CredentialStorePort,
	KindsStorePort,
	LibraryStorePort,
	ProjectCreateInput,
	ProjectStorePort,
	RecordStorePort,
	SaveDraftBodyInput,
	SettingsStorePort,
	SnapshotContent,
	SnapshotInfo,
} from "../src/store/store-port.ts";
import {
	decodeSnapshotLabel,
	exportNovel,
	importNovel,
	NOVEL_PACKAGE_MAGIC,
	sanitizeNovelSettings,
	type NovelImportResult,
} from "../src/store/novel-package.ts";

/* ------------------------------------------------------------------ *
 * 断言的小工具（照 scripts/storage-check.ts 的house style）
 * ------------------------------------------------------------------ */

let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

/* ------------------------------------------------------------------ *
 * 假存储端口
 * ------------------------------------------------------------------ */

const MAX_HISTORY = 10;
const MAX_SNAPSHOTS = 20;

interface FakeSnapshot {
	name: string;
	at: number;
	size: number;
	project: Project;
	bodies: Record<string, DraftBody>;
}

/** 与 project.ts 的 encodeFileName 同款：非 [\w-] 转义成 _hex_，末尾带短哈希。 */
function encodeFileName(raw: string): string {
	let h = 5381;
	for (let index = 0; index < raw.length; index++) h = ((h << 5) + h + raw.charCodeAt(index)) | 0;
	const suffix = "_" + (h >>> 0).toString(36);
	const encoded = raw.replace(/[^\w-]/g, (ch) => "_" + ch.codePointAt(0)!.toString(16) + "_");
	const room = 120 - suffix.length;
	return (encoded.length > room ? encoded.slice(0, room) : encoded) + suffix;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** 作品 + 正文 + 快照。行为照抄磁盘版。 */
class FakeProjectStore implements ProjectStorePort {
	readonly projects = new Map<string, Project>();
	readonly bodies = new Map<string, Map<string, DraftBody>>();
	readonly snapshots = new Map<string, FakeSnapshot[]>();
	readonly trash = new Map<string, Project>();

	list(): Project[] {
		return [...this.projects.values()];
	}

	get(id: string): Project | undefined {
		return this.projects.get(id);
	}

	create(input?: ProjectCreateInput): Project {
		const project = emptyProject(input ?? {});
		this.projects.set(project.id, project);
		return project;
	}

	mutate(id: string, mutate: (project: Project) => void): Project {
		const project = this.projects.get(id);
		if (!project) throw new Error(`没有这个作品：${id}`);
		mutate(project);
		project.updatedAt = Date.now();
		return project;
	}

	async saveDraftBody(projectId: string, chapterId: string, input: SaveDraftBodyInput): Promise<import("../src/store/project.ts").ChapterMeta> {
		const project = this.projects.get(projectId);
		if (!project) throw new Error(`没有这个作品：${projectId}`);
		const existingMeta = project.drafts[chapterId];
		const existingBody = this.bodies.get(projectId)?.get(chapterId);
		const oldContent = existingBody?.content ?? "";
		const keepHistory = input.keepHistory !== false;
		const history: DraftRevision[] = keepHistory ? [...(existingBody?.history ?? [])] : [];
		if (existingMeta && oldContent.trim() && keepHistory && oldContent !== input.content) {
			history.push({
				revision: existingMeta.revision,
				title: existingMeta.title,
				content: oldContent,
				materialIds: [...existingMeta.materialIds],
				updatedAt: existingMeta.updatedAt,
				mode: input.mode ?? "manual",
			});
		}
		if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
		const meta = {
			id: chapterId,
			title: input.title,
			summary: input.summary ?? existingMeta?.summary ?? "",
			words: countWords(input.content),
			revision: (existingMeta?.revision ?? 0) + 1,
			updatedAt: Date.now(),
			materialIds: [...(input.materialIds ?? existingMeta?.materialIds ?? [])],
			hasDraft: input.content.length > 0,
		};
		project.drafts[chapterId] = meta;
		let map = this.bodies.get(projectId);
		if (!map) {
			map = new Map();
			this.bodies.set(projectId, map);
		}
		map.set(chapterId, { content: input.content, history });
		return meta;
	}

	async readDraftBody(
		projectId: string,
		chapterId: string,
		options?: { history?: boolean },
	): Promise<DraftBody | undefined> {
		const body = this.bodies.get(projectId)?.get(chapterId);
		if (!body) return undefined;
		if (options?.history === false) return { content: body.content, history: [] };
		return {
			content: body.content,
			history: body.history.map((item) => ({ ...item, materialIds: [...item.materialIds] })),
		};
	}

	async snapshot(project: Project, label = ""): Promise<string> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = `${stamp}-${encodeFileName(label)}.json.gz`;
		const bodies: Record<string, DraftBody> = {};
		for (const chapterId of Object.keys(project.drafts)) {
			const body = await this.readDraftBody(project.id, chapterId, { history: true });
			if (body) bodies[chapterId] = body;
		}
		const list = this.snapshots.get(project.id) ?? [];
		list.push({ name, at: Date.now(), size: JSON.stringify(bodies).length, project: clone(project), bodies });
		list.sort((left, right) => (left.name < right.name ? -1 : 1));
		while (list.length > MAX_SNAPSHOTS) list.shift();
		this.snapshots.set(project.id, list);
		return name;
	}

	async listSnapshots(projectId: string): Promise<SnapshotInfo[]> {
		return [...(this.snapshots.get(projectId) ?? [])]
			.sort((left, right) => (left.name < right.name ? 1 : -1))
			.map((item) => ({ name: item.name, at: item.at, size: item.size }));
	}

	async readSnapshot(projectId: string, name: string): Promise<SnapshotContent | undefined> {
		const found = (this.snapshots.get(projectId) ?? []).find((item) => item.name === name);
		if (!found) return undefined;
		return { project: clone(found.project), bodies: clone(found.bodies) };
	}

	async remove(id: string, options?: { permanent?: boolean }): Promise<void> {
		const project = this.projects.get(id);
		if (!project) return;
		this.projects.delete(id);
		this.bodies.delete(id);
		this.snapshots.delete(id);
		if (!options?.permanent) this.trash.set(id, project);
	}

	async listDeleted(): Promise<DeletedProject[]> {
		return [...this.trash.values()].map((project) => ({
			id: project.id,
			title: project.title,
			deletedAt: Date.now(),
		}));
	}

	async restoreDeleted(id: string): Promise<Project> {
		const project = this.trash.get(id);
		if (!project) throw new Error(`回收站里没有这个作品：${id}`);
		this.trash.delete(id);
		this.projects.set(project.id, project);
		return project;
	}

	stats(project: Project): ProjectStats {
		return projectStats(project);
	}

	async flush(): Promise<void> {}
	async flushForProject(): Promise<void> {}
	async withChapterLock<T>(_projectId: string, _chapterId: string, fn: () => Promise<T>): Promise<T> {
		return fn();
	}
	async retryPending(): Promise<void> {}
	pendingWrites(): string[] {
		return [];
	}
	pendingChapterWrites(): Record<string, string[]> {
		return {};
	}
}

class FakeLibraryStore implements LibraryStorePort {
	readonly items = new Map<string, LibraryMaterial>();

	list(): LibraryMaterial[] {
		return [...this.items.values()];
	}

	get(id: string): LibraryMaterial | undefined {
		return this.items.get(id);
	}

	create(input: LibraryMaterialInput): LibraryMaterial {
		const material: LibraryMaterial = {
			id: newId(),
			kind: input.kind ?? "other",
			title: input.title ?? "",
			content: input.content ?? "",
			tags: [...(input.tags ?? [])],
			usage: input.usage ?? "",
			status: input.status ?? "confirmed",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.items.set(material.id, material);
		return material;
	}

	update(id: string, input: LibraryMaterialInput): LibraryMaterial | undefined {
		const item = this.items.get(id);
		if (!item) return undefined;
		Object.assign(item, input);
		item.updatedAt = Date.now();
		return item;
	}

	remove(id: string): boolean {
		return this.items.delete(id);
	}

	async flush(): Promise<void> {}
	async retryPending(): Promise<void> {}
}

class FakeKindStore implements KindsStorePort {
	readonly items = new Map<string, CustomKind>();

	list(): CustomKind[] {
		return [...this.items.values()];
	}

	has(id: string): boolean {
		return this.items.has(id);
	}

	add(label: string): KindResult<CustomKind> {
		const trimmed = label.trim();
		if (!trimmed) return { ok: false, error: "名字不能为空", status: 400 };
		const kind: CustomKind = { id: newId(), label: trimmed, createdAt: Date.now() };
		this.items.set(kind.id, kind);
		return { ok: true, value: kind };
	}

	rename(id: string, label: string): KindResult<CustomKind> {
		const item = this.items.get(id);
		if (!item) return { ok: false, error: "没有这个种类", status: 404 };
		item.label = label;
		return { ok: true, value: item };
	}

	remove(id: string): KindResult<CustomKind> {
		const item = this.items.get(id);
		if (!item) return { ok: false, error: "没有这个种类", status: 404 };
		this.items.delete(id);
		return { ok: true, value: item };
	}
}

class FakeSettingsStore implements SettingsStorePort {
	private settings: Settings;

	constructor(settings: Settings) {
		this.settings = settings;
	}

	get(): Settings {
		return clone(this.settings);
	}

	getProvider(id: string): Settings["providers"][number] | undefined {
		return this.settings.providers.find((provider) => provider.id === id);
	}

	replace(next: Settings): Settings {
		this.settings = clone(next);
		return this.get();
	}

	mutate(fn: (settings: Settings) => void): Settings {
		const draft = clone(this.settings);
		fn(draft);
		this.settings = draft;
		return this.get();
	}

	upsertProvider(provider: Settings["providers"][number]): Settings["providers"][number] {
		const index = this.settings.providers.findIndex((item) => item.id === provider.id);
		if (index >= 0) this.settings.providers[index] = clone(provider);
		else this.settings.providers.push(clone(provider));
		return clone(provider);
	}

	removeProvider(id: string): boolean {
		const before = this.settings.providers.length;
		this.settings.providers = this.settings.providers.filter((provider) => provider.id !== id);
		return this.settings.providers.length !== before;
	}

	async flush(): Promise<void> {}
}

class FakeCredentialStore implements CredentialStorePort {
	readonly apiKeys = new Map<string, string>();

	async read(providerId: string): Promise<Credential | undefined> {
		const key = this.apiKeys.get(providerId);
		if (key === undefined) return undefined;
		return { type: "api_key", key } as Credential;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return [...this.apiKeys.keys()].map((providerId) => ({ providerId, type: "api_key" as const }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const next = await fn(await this.read(providerId));
		if (!next) {
			this.apiKeys.delete(providerId);
			return undefined;
		}
		const raw = next as { type?: string; key?: string };
		if (raw.type === "api_key" && typeof raw.key === "string") this.apiKeys.set(providerId, raw.key);
		return next;
	}

	async delete(providerId: string): Promise<void> {
		this.apiKeys.delete(providerId);
	}

	async setKey(providerId: string, apiKey: string | undefined): Promise<void> {
		if (apiKey === undefined) this.apiKeys.delete(providerId);
		else this.apiKeys.set(providerId, apiKey);
	}

	hasKey(providerId: string): boolean {
		return this.apiKeys.has(providerId);
	}

	maskedKey(providerId: string): string {
		return this.apiKeys.has(providerId) ? "sk-***" : "";
	}

	/** 存了密钥的服务商（给检查脚本用）。 */
	providerIds(): string[] {
		return [...this.apiKeys.keys()];
	}
}

class FakeRecordStore implements RecordStorePort {
	readonly items = new Map<string, GenerationRecord>();

	list(filter?: RecordFilter, limit?: number): RecordSummary[] {
		let all = [...this.items.values()];
		if (filter?.role) all = all.filter((record) => record.role === filter.role);
		if (filter?.projectId) all = all.filter((record) => record.projectId === filter.projectId);
		if (filter?.chapterId) all = all.filter((record) => record.chapterId === filter.chapterId);
		if (filter?.libraryScope !== undefined) {
			all = all.filter((record) => (record.libraryScope === true) === filter.libraryScope);
		}
		all.sort((left, right) => right.createdAt - left.createdAt);
		const capped = limit === undefined ? all : all.slice(0, limit);
		return capped.map((record) => ({
			id: record.id,
			role: record.role,
			projectId: record.projectId,
			...(record.chapterId ? { chapterId: record.chapterId } : {}),
			...(record.libraryScope ? { libraryScope: true } : {}),
			title: record.title,
			preview: record.preview,
			messageCount: record.messages.length,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		}));
	}

	get(id: string): GenerationRecord | undefined {
		return this.items.get(id);
	}

	async create(input: {
		role: GenerationRecord["role"];
		projectId: string;
		chapterId?: string;
		libraryScope?: boolean;
		title: string;
	}): Promise<GenerationRecord> {
		const record: GenerationRecord = {
			id: newId(),
			role: input.role,
			projectId: input.projectId,
			title: input.title,
			preview: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: [],
		};
		if (input.chapterId) record.chapterId = input.chapterId;
		if (input.libraryScope) record.libraryScope = true;
		this.items.set(record.id, record);
		return record;
	}

	async saveMessages(id: string, messages: GenerationRecord["messages"], title?: string): Promise<GenerationRecord | undefined> {
		const record = this.items.get(id);
		if (!record) return undefined;
		record.messages = clone(messages);
		record.preview = messages.map((message) => message.content).filter(Boolean).join(" ").slice(0, 120);
		if (title !== undefined) record.title = title;
		record.updatedAt = Date.now();
		return record;
	}

	async rename(id: string, title: string): Promise<void> {
		const record = this.items.get(id);
		if (record) record.title = title;
	}

	async remove(id: string): Promise<boolean> {
		return this.items.delete(id);
	}
}

interface Stores {
	store: ProjectStorePort;
	libraryStore: LibraryStorePort;
	kindStore: KindsStorePort;
	settingsStore: SettingsStorePort;
	recordStore: RecordStorePort;
	credentialStore: FakeCredentialStore;
}

function makeStores(): Stores {
	const settings: Settings = {
		version: 1,
		defaultModel: "openai/gpt-4o",
		defaultThinkingLevel: "medium",
		webSearch: { enabled: true, maxResults: 5, includeContent: true },
		providers: [],
	};
	return {
		store: new FakeProjectStore(),
		libraryStore: new FakeLibraryStore(),
		kindStore: new FakeKindStore(),
		settingsStore: new FakeSettingsStore(settings),
		recordStore: new FakeRecordStore(),
		credentialStore: new FakeCredentialStore(),
	};
}

/* ------------------------------------------------------------------ *
 * 造数据
 * ------------------------------------------------------------------ */

const API_KEY = "sk-SUPER-SECRET-KEY-999";
const SETTINGS_SECRET = "sk-settings-secret";

/** 一条像样的对话消息（字段跟 pi-ai 的 AgentMessage 对齐）。 */
function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1700000000000 };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1700000000000,
	};
}

async function buildFixture(): Promise<{ stores: Stores; projectA: string; projectB: string; expectedSettings: Settings }> {
	const stores = makeStores();

	// 设置：故意在供应商里塞一个像密钥的字段，看导出时会不会被剔掉。
	const rawSettings = {
		version: 1 as const,
		defaultModel: "openai/gpt-4o",
		defaultThinkingLevel: "medium" as const,
		webSearch: { enabled: true, maxResults: 5, includeContent: true },
		providers: [
			{
				id: "openai",
				label: "OpenAI",
				kind: "custom" as const,
				baseUrl: "https://api.openai.com/v1",
				api: "openai-completions" as const,
				models: [
					{
						id: "gpt-4o",
						name: "GPT-4o",
						contextWindow: 128000,
						maxTokens: 16384,
						reasoning: false,
						thinkingLevels: ["off", "low", "medium", "high"] as const,
						cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
					},
				],
				enabled: true,
				updatedAt: 1700000000000,
				apiKey: SETTINGS_SECRET,
			},
		],
	};
	stores.settingsStore.replace(rawSettings as unknown as Settings);
	const expectedSettings = sanitizeNovelSettings(rawSettings, []) as Settings;

	// 密钥
	await stores.credentialStore.setKey("openai", API_KEY);

	// 通用素材库
	stores.libraryStore.create({
		kind: "character",
		title: "李停云",
		content: "十七岁的刀客，左手小指少一截。",
		tags: ["主角"],
		usage: "全书",
		status: "confirmed",
	});
	stores.libraryStore.create({
		kind: "world",
		title: "长安城",
		content: "九门十二坊，宵禁之后不许点灯。",
		tags: ["地图"],
		usage: "第一卷",
		status: "confirmed",
	});
	stores.libraryStore.create({
		kind: "other",
		title: "雨",
		content: "雨声贯穿全书，象征命运不可挽留。",
		tags: [],
		usage: "",
		status: "draft",
	});

	// 作者自建的种类
	stores.kindStore.add("行当");
	stores.kindStore.add("门派");

	// 作品 A：长安夜雨
	const a = stores.store.create({
		title: "长安夜雨",
		genre: "古风悬疑",
		logline: "一个雨夜，失踪的刀客留下了一句话。",
		synopsis: "主角顺着雨水里的血迹一路查下去，最后查到了自己头上。",
		styleGuide: "短句，白描，不写心理活动。",
		targetWords: 120000,
	});
	stores.store.mutate(a.id, (project) => {
		project.materials = [
			{
				id: "m1",
				kind: "character",
				title: "李停云",
				content: "十七岁的刀客。",
				tags: ["主角"],
				usage: "全书",
				status: "confirmed",
				chapterIds: ["ch1"],
				source: "human",
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
			},
		];
		project.volumes = [
			{ id: "v1", title: "第一卷", summary: "雨夜", targetWords: 60000, notes: "开篇" },
			{ id: "v2", title: "第二卷", summary: "追凶", targetWords: 60000, notes: "" },
		];
		project.outline = [
			{
				id: "ch1",
				title: "第一章 雨落长安",
				summary: "雨夜，血迹，一句没头没尾的话。",
				pov: "李停云",
				volumeId: "v1",
				status: "drafted",
				targetWords: 3000,
				notes: "开场别超过两百字",
				materialIds: ["m1"],
			},
			{
				id: "ch2",
				title: "第二章 城南旧坊",
				summary: "找到第一个目击者。",
				pov: "李停云",
				volumeId: "v1",
				status: "drafted",
				targetWords: 2800,
				notes: "",
				materialIds: [],
			},
			{
				id: "ch3",
				title: "第三章 刀",
				summary: "第一次动手。",
				pov: "李停云",
				volumeId: "v1",
				status: "outlined",
				targetWords: 3200,
				notes: "",
				materialIds: [],
			},
		];
		project.notes = [
			{
				id: "n1",
				severity: "warning",
				category: "时间线",
				subject: "ch1",
				description: "雨季的时间对不上。",
				status: "open",
				createdAt: 1700000000000,
			},
		];
	});
	await stores.store.saveDraftBody(a.id, "ch1", {
		title: "第一章 雨落长安",
		content: "正文一：雨下了三天。",
		materialIds: ["m1"],
		mode: "manual",
	});
	await stores.store.saveDraftBody(a.id, "ch1", {
		title: "第一章 雨落长安",
		content: "正文一改：雨下了三天，青石板上全是脚印。",
		materialIds: ["m1"],
		mode: "revise",
	});
	await stores.store.saveDraftBody(a.id, "ch1", {
		title: "第一章 雨落长安",
		content: "正文一改二：雨下了三天，青石板上的脚印朝城里去。",
		materialIds: ["m1"],
		mode: "polish",
	});
	await stores.store.saveDraftBody(a.id, "ch2", {
		title: "第二章 城南旧坊",
		content: "正文二：城南的旧坊没有人。",
		materialIds: [],
		mode: "manual",
	});
	await stores.store.saveDraftBody(a.id, "ch3", {
		title: "第三章 刀",
		content: "正文三：刀出鞘的时候，雨停了。",
		materialIds: [],
		mode: "manual",
	});
	const aLive = stores.store.get(a.id);
	if (aLive) await stores.store.snapshot(aLive, "起笔");

	await stores.store.saveDraftBody(a.id, "ch2", {
		title: "第二章 城南旧坊",
		content: "正文二改：城南的旧坊没有人，只有一盏没灭的灯。",
		materialIds: [],
		mode: "revise",
	});
	const aLive2 = stores.store.get(a.id);
	if (aLive2) await stores.store.snapshot(aLive2, "初稿");

	// 作品 B：山海拾遗
	const b = stores.store.create({
		title: "山海拾遗",
		genre: "志怪",
		logline: "捡到的东西会说话。",
		synopsis: "一个收破烂的人，和一堆会说话的破烂。",
		styleGuide: "短句，略带荒诞。",
		targetWords: 80000,
	});
	stores.store.mutate(b.id, (project) => {
		project.outline = [
			{
				id: "b1",
				title: "第一章 会说话的碗",
				summary: "碗说它记得上一个主人。",
				pov: "老周",
				volumeId: "",
				status: "drafted",
				targetWords: 2500,
				notes: "",
				materialIds: [],
			},
		];
	});
	await stores.store.saveDraftBody(b.id, "b1", {
		title: "第一章 会说话的碗",
		content: "正文乙：碗说它记得上一个主人。",
		materialIds: [],
		mode: "manual",
	});
	const bLive = stores.store.get(b.id);
	if (bLive) await stores.store.snapshot(bLive, "初稿");

	// 生成记录
	const recordA = await stores.recordStore.create({
		role: "writing",
		projectId: a.id,
		chapterId: "ch1",
		title: "第一章的润色",
	});
	await stores.recordStore.saveMessages(
		recordA.id,
		[userMessage("把这段改得更冷一点。"), assistantMessage("雨下了三天，青石板上的脚印朝城里去。")],
		"第一章的润色",
	);
	const recordB = await stores.recordStore.create({
		role: "material",
		projectId: "",
		libraryScope: true,
		title: "李停云的人物卡",
	});
	await stores.recordStore.saveMessages(
		recordB.id,
		[userMessage("给李停云写一张人物卡。"), assistantMessage("十七岁的刀客，左手小指少一截。")],
		"李停云的人物卡",
	);

	return { stores, projectA: a.id, projectB: b.id, expectedSettings };
}

/* ------------------------------------------------------------------ *
 * 比对用的"标准形状"
 *
 * 端口没有"按指定 id 写入"的接口，所以导入后 id 是重新生成的，
 * 时间戳与版本号也变了。这里比的是内容，不是那些会变的东西。
 * ------------------------------------------------------------------ */

async function canonical(stores: Stores): Promise<unknown> {
	const titleById = new Map(stores.store.list().map((project) => [project.id, project.title]));
	const projects = [];
	for (const project of stores.store.list().sort((left, right) => (left.title < right.title ? -1 : 1))) {
		const bodies: Record<string, DraftBody> = {};
		for (const chapterId of Object.keys(project.drafts).sort()) {
			const body = await stores.store.readDraftBody(project.id, chapterId, { history: true });
			if (body) bodies[chapterId] = body;
		}
		const snapshots = [];
		for (const info of await stores.store.listSnapshots(project.id)) {
			const content = await stores.store.readSnapshot(project.id, info.name);
			if (!content) continue;
			snapshots.push({
				label: decodeSnapshotLabel(info.name),
				bodies: Object.fromEntries(
					Object.entries(content.bodies)
						.sort(([left], [right]) => (left < right ? -1 : 1))
						.map(([chapterId, body]) => [
							chapterId,
							{
								content: body.content,
								history: body.history.map((item) => ({
									title: item.title,
									content: item.content,
									materialIds: item.materialIds,
									mode: item.mode,
								})),
							},
						]),
				),
			});
		}
		snapshots.sort((left, right) => (left.label < right.label ? -1 : 1));
		projects.push({
			title: project.title,
			genre: project.genre,
			logline: project.logline,
			synopsis: project.synopsis,
			styleGuide: project.styleGuide,
			targetWords: project.targetWords,
			materials: project.materials.map((material) => ({
				kind: material.kind,
				title: material.title,
				content: material.content,
				tags: material.tags,
				usage: material.usage,
				status: material.status,
				chapterIds: material.chapterIds,
				source: material.source,
			})),
			volumes: project.volumes.map((volume) => ({
				title: volume.title,
				summary: volume.summary,
				targetWords: volume.targetWords,
				notes: volume.notes,
			})),
			outline: project.outline.map((chapter) => ({
				id: chapter.id,
				title: chapter.title,
				summary: chapter.summary,
				pov: chapter.pov,
				volumeId: chapter.volumeId,
				status: chapter.status,
				targetWords: chapter.targetWords,
				notes: chapter.notes,
				materialIds: chapter.materialIds,
			})),
			notes: project.notes.map((note) => ({
				severity: note.severity,
				category: note.category,
				subject: note.subject,
				description: note.description,
				status: note.status,
			})),
			drafts: Object.fromEntries(
				Object.entries(project.drafts)
					.sort(([left], [right]) => (left < right ? -1 : 1))
					.map(([chapterId, meta]) => [
						chapterId,
						{
							title: meta.title,
							summary: meta.summary,
							words: meta.words,
							materialIds: meta.materialIds,
							hasDraft: meta.hasDraft,
						},
					]),
			),
			bodies: Object.fromEntries(
				Object.entries(bodies)
					.sort(([left], [right]) => (left < right ? -1 : 1))
					.map(([chapterId, body]) => [
						chapterId,
						{
							content: body.content,
							history: body.history.map((item) => ({
								title: item.title,
								content: item.content,
								materialIds: item.materialIds,
								mode: item.mode,
							})),
						},
					]),
			),
			snapshots,
		});
	}
	return {
		projects,
		library: stores.libraryStore
			.list()
			.map((material) => ({
				kind: material.kind,
				title: material.title,
				content: material.content,
				tags: material.tags,
				usage: material.usage,
				status: material.status,
			}))
			.sort((left, right) => (left.title < right.title ? -1 : 1)),
		kinds: stores.kindStore
			.list()
			.map((kind) => kind.label)
			.sort(),
		settings: sanitizeNovelSettings(stores.settingsStore.get(), []) ?? null,
		records: stores.recordStore
			.list()
			.map((summary) => {
				const full = stores.recordStore.get(summary.id);
				return {
					role: summary.role,
					project: summary.libraryScope ? "<library>" : (titleById.get(summary.projectId) ?? summary.projectId),
					chapterId: summary.chapterId ?? "",
					libraryScope: summary.libraryScope === true,
					title: summary.title,
					messages: full?.messages ?? [],
				};
			})
			.sort((left, right) => (left.title < right.title ? -1 : 1)),
	};
}

function counts(stores: Stores): string {
	return JSON.stringify({
		projects: stores.store.list().length,
		library: stores.libraryStore.list().length,
		kinds: stores.kindStore.list().length,
		records: stores.recordStore.list().length,
	});
}

function text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** 键排序后的 JSON，用来比两个结构是不是一样。 */
function stableJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

function firstDifference(left: unknown, right: unknown, path = ""): string {
	const leftText = JSON.stringify(left);
	const rightText = JSON.stringify(right);
	if (leftText === rightText) return "";
	let index = 0;
	while (index < leftText.length && index < rightText.length && leftText[index] === rightText[index]) index++;
	const from = Math.max(0, index - 120);
	return `${path || "根"}：第 ${index} 个字符起不一样\n    源  = …${leftText.slice(from, index + 160)}\n    目标= …${rightText.slice(from, index + 160)}`;
}

async function expectError(fn: () => Promise<unknown>): Promise<Error | null> {
	try {
		await fn();
		return null;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/* ------------------------------------------------------------------ *
 * 开跑
 * ------------------------------------------------------------------ */

console.log("\n① 造数据");
const fixture = await buildFixture();
check("造出两部作品", fixture.stores.store.list().length === 2);
check("作品 A 有三章", Object.keys(fixture.stores.store.get(fixture.projectA)?.drafts ?? {}).length === 3);
check("第一章有两版历史", (await fixture.stores.store.readDraftBody(fixture.projectA, "ch1", { history: true }))?.history.length === 2);
check("快照两个", (await fixture.stores.store.listSnapshots(fixture.projectA)).length === 2);

console.log("\n② 导出再导入（往返一致）");
const bytes = await exportNovel(fixture.stores);
const target = makeStores();
const imported: NovelImportResult = await importNovel(target, bytes);
check("导进来两部作品", imported.projects === 2, `实际 ${imported.projects}`);
check("导进来四章正文", imported.chapters === 4, `实际 ${imported.chapters}`);
check("导进来三条素材", imported.materials === 3, `实际 ${imported.materials}`);
check("导进来两个自建种类", imported.kinds === 2, `实际 ${imported.kinds}`);
check("导进来两条记录", imported.records === 2, `实际 ${imported.records}`);
check("没有警告", imported.warnings.length === 0, imported.warnings.join("；"));
const sourceShape = await canonical(fixture.stores);
const targetShape = await canonical(target);
check("内容一字不差", stableJson(sourceShape) === stableJson(targetShape), firstDifference(sourceShape, targetShape));
check("设置里的密钥被剔掉了", !text(bytes).includes(SETTINGS_SECRET));
check("密钥没跟着走", !target.credentialStore.hasKey("openai"));

console.log("\n③ 压缩");
check("默认是 gzip（头两个字节 1f 8b）", bytes[0] === 0x1f && bytes[1] === 0x8b);
const plain = await exportNovel(fixture.stores, { compress: false });
check("compress:false 是明文 JSON", text(plain).trimStart().startsWith("{"));
check("明文里能看见包头", text(plain).includes(NOVEL_PACKAGE_MAGIC));
const fromGzip = makeStores();
await importNovel(fromGzip, bytes);
const fromPlain = makeStores();
await importNovel(fromPlain, plain);
check("两种形式导进去一样", stableJson(await canonical(fromGzip)) === stableJson(await canonical(fromPlain)));

console.log("\n④ 只导一部作品");
const oneBytes = await exportNovel(fixture.stores, { projectId: fixture.projectA, compress: false });
const oneEnvelope = JSON.parse(text(oneBytes)) as {
	kind: string;
	encrypted: boolean;
	payload: { projects: unknown[]; library: unknown[]; kinds: unknown[]; records: unknown[]; settings?: unknown };
};
check("kind 是 project", oneEnvelope.kind === "project");
check("payload 里只有一部作品", oneEnvelope.payload.projects.length === 1);
check("不带素材库与设置", oneEnvelope.payload.library.length === 0 && !oneEnvelope.payload.settings);
check("不带记录与种类", oneEnvelope.payload.records.length === 0 && oneEnvelope.payload.kinds.length === 0);
const oneTarget = makeStores();
const oneResult = await importNovel(oneTarget, oneBytes);
check("只恢复这一部", oneTarget.store.list().length === 1 && oneTarget.store.list()[0]?.title === "长安夜雨");
check("这一部的三章都在", oneResult.chapters === 3, `实际 ${oneResult.chapters}`);
check("另一部没跟过来", !oneTarget.store.list().some((project) => project.title === "山海拾遗"));

console.log("\n⑤ 口令加密");
const encrypted = await exportNovel(fixture.stores, { passphrase: "夜雨口令", compress: false });
const encryptedText = text(encrypted);
check("密文里没有书名", !encryptedText.includes("长安夜雨"));
check("密文里没有正文", !encryptedText.includes("正文一改二"));
check("信封标了 encrypted", (JSON.parse(encryptedText) as { encrypted: boolean }).encrypted === true);
const cipherEnvelope = (JSON.parse(encryptedText) as { payload: Record<string, unknown> }).payload;
check(
	"密文信封记了 kdf/iterations/salt/iv/ciphertext",
	cipherEnvelope["kdf"] === "PBKDF2-SHA-256" &&
		cipherEnvelope["iterations"] === 210000 &&
		typeof cipherEnvelope["salt"] === "string" &&
		typeof cipherEnvelope["iv"] === "string" &&
		typeof cipherEnvelope["ciphertext"] === "string",
);
const cipherTarget = makeStores();
await importNovel(cipherTarget, encrypted, { passphrase: "夜雨口令" });
check("口令对了导得回来", stableJson(await canonical(cipherTarget)) === stableJson(sourceShape));
const wrongPass = await expectError(() => importNovel(makeStores(), encrypted, { passphrase: "错口令" }));
check("口令不对是人话", wrongPass !== null && wrongPass.message.includes("口令不对或包已损坏"), wrongPass?.message ?? "没报错");
const noPass = await expectError(() => importNovel(makeStores(), encrypted));
check("没口令会提示要口令", noPass !== null && noPass.message.includes("需要口令"), noPass?.message ?? "没报错");

console.log("\n⑥ 密钥默认不导出");
const plainBytes = text(await exportNovel(fixture.stores, { compress: false }));
check("默认不带密钥", !plainBytes.includes(API_KEY));
check("要带密钥必须给口令", (await expectError(() => exportNovel(fixture.stores, { includeCredentials: true })))?.message.includes("口令") === true);
const withCred = await exportNovel(fixture.stores, { includeCredentials: true, passphrase: "夜雨口令", compress: false });
check("带密钥时明文里也看不见密钥", !text(withCred).includes(API_KEY));
const credTarget = makeStores();
await importNovel(credTarget, withCred, { passphrase: "夜雨口令" });
check("密钥跟着口令一起回来了", (await credTarget.credentialStore.read("openai"))?.key === API_KEY);

console.log("\n⑦ 坏包");
const garbage = await expectError(() => importNovel(makeStores(), new Uint8Array([1, 2, 3, 4, 5])));
check("乱码有话说", garbage !== null && garbage.message.length > 0, garbage?.message ?? "没报错");
const wrongMagic = await expectError(() =>
	importNovel(makeStores(), patchEnvelope(plain, (envelope) => (envelope["magic"] = "别的包"))),
);
check("包头不对有话说", wrongMagic !== null && wrongMagic.message.includes(NOVEL_PACKAGE_MAGIC), wrongMagic?.message ?? "没报错");
const badVersion = await expectError(() =>
	importNovel(makeStores(), patchEnvelope(plain, (envelope) => (envelope["formatVersion"] = 99))),
);
check("版本不对有话说", badVersion !== null && badVersion.message.includes("版本"), badVersion?.message ?? "没报错");
const brokenTarget = makeStores();
const brokenResult = await importNovel(
	brokenTarget,
	patchEnvelope(plain, (envelope) => {
		const payload = envelope["payload"] as { projects: Array<{ bodies: Record<string, unknown> }> };
		payload.projects[0]!.bodies["ch2"] = { content: 12345 };
	}),
);
check("坏掉的章节被跳过", brokenResult.projects === 2 && brokenResult.chapters === 3, `实际 ${brokenResult.projects}/${brokenResult.chapters}`);
check("跳过的章节进了警告", brokenResult.warnings.some((warning) => warning.includes("正文格式不对")), brokenResult.warnings.join("；"));
check("别的章节照常导进来了", brokenTarget.store.get(brokenTarget.store.list()[0]?.id ?? "") !== undefined);
const huge = await expectError(() =>
	importNovel(
		makeStores(),
		patchEnvelope(plain, (envelope) => {
			const payload = envelope["payload"] as { projects: Array<{ bodies: Record<string, unknown> }> };
			payload.projects[0]!.bodies["ch3"] = { content: "啊".repeat(100_000_000), history: [] };
		}),
	),
);
check("超大正文被拦下", huge !== null && huge.message.includes("太大"), huge?.message ?? "没报错");

console.log("\n⑧ 导两次不会翻倍");
const twice = makeStores();
await importNovel(twice, bytes);
const beforeTwice = counts(twice);
const secondResult = await importNovel(twice, bytes);
check("数量没变", counts(twice) === beforeTwice, `${beforeTwice} → ${counts(twice)}`);
check("第二次报告了跳过", secondResult.skipped > 0, `skipped=${secondResult.skipped}`);
const replaceTarget = makeStores();
await importNovel(replaceTarget, bytes);
const beforeReplace = counts(replaceTarget);
await importNovel(replaceTarget, bytes, { onConflict: "replace" });
check("replace 之后数量不变", counts(replaceTarget) === beforeReplace, `${beforeReplace} → ${counts(replaceTarget)}`);
const renameTarget = makeStores();
await importNovel(renameTarget, bytes);
await importNovel(renameTarget, bytes, { onConflict: "rename" });
check("rename 多出一本", renameTarget.store.list().length === 4, `实际 ${renameTarget.store.list().length}`);
check("rename 改了名字", renameTarget.store.list().some((project) => project.title.includes("（导入")));

console.log("\n⑨ onConflict 三种走法");
const skipTarget = makeStores();
await importNovel(skipTarget, bytes);
const skipResult = await importNovel(skipTarget, bytes, { onConflict: "skip" });
check("skip：不覆盖", skipTarget.store.list().length === 2 && skipResult.projects === 0, `projects=${skipResult.projects}`);
check("skip：说了为什么", skipResult.warnings.some((warning) => warning.includes("已经存在")), skipResult.warnings.join("；"));
const renameResult = await importNovel(skipTarget, bytes, { onConflict: "rename" });
const titles = renameTarget.store.list().map((project) => project.title);
check("rename：新书名不撞车", new Set(titles).size === titles.length, titles.join(" / "));
check("rename：新书名带导入标记", titles.filter((title) => title.includes("（导入")).length === 2, titles.join(" / "));
check("rename：这次真的导了两本", renameResult.projects === 2, `实际 ${renameResult.projects}`);

console.log(failed === 0 ? "\n全部通过" : "\n有 " + failed + " 项没过");
if (failed > 0) process.exitCode = 1;

/** 改一改信封再编码回去（用来造"坏包"）。 */
function patchEnvelope(bytes: Uint8Array, patch: (envelope: Record<string, unknown>) => void): Uint8Array {
	const envelope = JSON.parse(text(bytes)) as Record<string, unknown>;
	patch(envelope);
	return new TextEncoder().encode(JSON.stringify(envelope));
}
