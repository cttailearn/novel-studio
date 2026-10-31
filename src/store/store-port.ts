/**
 * 存储端口：上层只认这些接口，不认实现。
 *
 * 现在有两种实现：
 * - *-disk.ts 里的磁盘版（ProjectStore / MaterialLibrary / KindStore /
 *   SettingsStore / FileCredentialStore / RecordStore）：单机自用模式，落在 data/ 目录。
 * - 浏览器端的 IndexedDB 版（IdbProjectStore 等）：多用户模式，落在用户自己的 IndexedDB 里。
 *
 * AI 工具层（src/ai/tools.ts）只依赖这些接口，因此同一套智能体
 * 既能在服务端跑，也能在浏览器里跑，不为"数据存哪"写两份代码。
 *
 * 每个端口只列**实例方法**：磁盘实现另有 static open(dataDir) 这个工厂，
 * 浏览器实现各有自己的打开方式，不该由端口规定。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AuthOperationOptions, Credential, CredentialInfo } from "@earendil-works/pi-ai";
import type { ProviderConfig, Settings } from "../config/settings.ts";
import type { GenerationRecord, RecordFilter, RecordRole, RecordSummary } from "../server/records.ts";
import type { CustomKind, KindResult } from "./kinds.ts";
import type { LibraryMaterial, LibraryMaterialInput } from "./library.ts";
import type {
	ChapterMeta,
	DeletedProject,
	DraftBody,
	Project,
	ProjectStats,
} from "./project.ts";

/** 新建作品时允许覆盖的字段。 */
export type ProjectCreateInput = Partial<
	Pick<Project, "title" | "genre" | "logline" | "synopsis" | "styleGuide" | "targetWords">
>;

/** 存一章正文的入参。 */
export interface SaveDraftBodyInput {
	title: string;
	content: string;
	summary?: string;
	materialIds?: string[];
	mode?: string;
	/** 是否把旧稿归档成历史版本。自动存稿为 false。 */
	keepHistory?: boolean;
}

/** 一份快照的内容：骨架与各章正文。 */
export interface SnapshotContent {
	project: Project;
	bodies: Record<string, DraftBody>;
}

/** 快照清单里的一项。 */
export interface SnapshotInfo {
	name: string;
	at: number;
	size: number;
}

export interface ProjectStorePort {
	/** 全部作品，按更新时间倒序。 */
	list(): Project[];
	/** 取一部作品。取不到返回 undefined。 */
	get(id: string): Project | undefined;
	/** 新建一部作品。 */
	create(input?: ProjectCreateInput): Project;
	/** 在原对象上实施变更并落盘。 */
	mutate(id: string, mutate: (project: Project) => void): Project;
	/** 等指定工程排队中的落盘做完；仍有未落盘数据时抛错。 */
	flushForProject(id: string): Promise<void>;
	/** 等全部落盘完成；任何工程仍有未落盘数据都会抛错。 */
	flush(): Promise<void>;
	/** 同一章节的写入串行化。 */
	withChapterLock<T>(id: string, chapterId: string, fn: () => Promise<T> | T): Promise<T>;
	/** 写一章正文，落成元数据。 */
	saveDraftBody(projectId: string, chapterId: string, input: SaveDraftBodyInput): Promise<ChapterMeta>;
	/** 读一章的正文与历史。 */
	readDraftBody(projectId: string, chapterId: string, options?: { history?: boolean }): Promise<DraftBody | undefined>;
	/** 派生统计。 */
	stats(project: Project): ProjectStats;
	/** 拍一份整部作品的快照。 */
	snapshot(project: Project, label?: string): Promise<string>;
	/** 删除作品。默认进回收站，permanent 为 true 才永久删除。 */
	remove(id: string, options?: { permanent?: boolean }): Promise<void>;
	/** 回收站列表，最新的在前。 */
	listDeleted(): Promise<DeletedProject[]>;
	/** 从回收站恢复整部作品。 */
	restoreDeleted(id: string): Promise<Project>;
	/** 列出某部作品的快照，最新的在前。 */
	listSnapshots(projectId: string): Promise<SnapshotInfo[]>;
	/** 读回一份快照。文件损坏时返回 undefined 而不是抛错。 */
	readSnapshot(projectId: string, name: string): Promise<SnapshotContent | undefined>;
	/** 重试挂起的落盘。 */
	retryPending(): Promise<void>;
	/** 还有哪些工程没存上。 */
	pendingWrites(): string[];
	/** 具体是哪几章没存上。 */
	pendingChapterWrites(): Record<string, string[]>;
}

/**
 * 通用素材库（跨作品）。
 *
 * 与 ProjectStorePort 分开是因为它落在另一个文件（library.json）里，
 * 而且不属于任何一部作品 —— 浏览器端也是两条独立的存储。
 */
export interface LibraryStorePort {
	/** 全部库条目（返回副本，调用方改了不会影响库里）。 */
	list(): LibraryMaterial[];
	/** 取一条。取不到返回 undefined。 */
	get(id: string): LibraryMaterial | undefined;
	/** 新建一条，返回落库后的条目。 */
	create(input: LibraryMaterialInput): LibraryMaterial;
	/** 改已有条目，未传的字段保持原样。取不到返回 undefined。 */
	update(id: string, input: LibraryMaterialInput): LibraryMaterial | undefined;
	/** 删一条。删掉返回 true，本来就没有返回 false。 */
	remove(id: string): boolean;
	/** 等全部已排队写入；仍有未落盘数据时抛错。 */
	flush(): Promise<void>;
	/** 不改内存地补写最近状态，供启动或显式恢复流程使用。 */
	retryPending(): Promise<void>;
}

/** 作者自建的素材种类表。 */
export interface KindsStorePort {
	/** 全部自建种类，按添的先后排。 */
	list(): CustomKind[];
	/** 这个 id 是不是自建种类。 */
	has(id: string): boolean;
	/** 添一个种类；名字重了就不添。 */
	add(label: string): KindResult<CustomKind>;
	/** 改名。id 不变。 */
	rename(id: string, label: string): KindResult<CustomKind>;
	/** 删一个自建种类。内置种类不归这里管。 */
	remove(id: string): KindResult<CustomKind>;
}

/** 应用设置（不含密钥，密钥走 CredentialStorePort）。 */
export interface SettingsStorePort {
	/** 整份设置。 */
	get(): Settings;
	/** 取一个供应商。取不到返回 undefined。 */
	getProvider(id: string): ProviderConfig | undefined;
	/** 以一次写入替换整份设置。 */
	replace(next: Settings): Settings;
	/** 改一份设置的副本，再整份替换。 */
	mutate(fn: (settings: Settings) => void): Settings;
	/** 添或改一个供应商。 */
	upsertProvider(provider: ProviderConfig): ProviderConfig;
	/** 删一个供应商，顺带清掉指向它的默认模型。 */
	removeProvider(id: string): boolean;
	/** 调用方在回复保存成功前必须等待真实落盘。 */
	flush(): Promise<void>;
}

/**
 * 厂商密钥。
 *
 * 前四个方法与 pi-ai 的 CredentialStore 一一对应（签名完全相同），
 * 所以磁盘实现能直接交给 createModels；后三个是应用自己用的：
 * 设置页要能直接设一个 key、能查有没有 key、能拿到脱显写法。
 */
export interface CredentialStorePort {
	/** 读一个厂商的凭据。 */
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;
	/** 列出凭据的元信息，不暴露密钥本身。 */
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;
	/** 唯一的写入路径：拿当前值改出新值。返回 undefined 表示不改。 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;
	/** 删一个厂商的凭据（登出）。 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
	/** 直接设置或清除一个厂商的 key（应用自身的写入路径）。 */
	setKey(providerId: string, apiKey: string | undefined): Promise<void>;
	/** 有没有可用的 key（只查，不暴露）。 */
	hasKey(providerId: string): boolean;
	/** 键的脱显写法，仅用于设置页回显。 */
	maskedKey(providerId: string): string;
}

/** 生成记录：每一轮落笔的对话。 */
export interface RecordStorePort {
	/** 记录列表（轻量视图，不带消息体），按更新时间倒序。 */
	list(filter?: RecordFilter, limit?: number): RecordSummary[];
	/** 取一条完整记录。取不到返回 undefined。 */
	get(id: string): GenerationRecord | undefined;
	/** 建一条空记录：先占住 id，这一轮怎么收场都能把消息补进去。 */
	create(input: {
		role: RecordRole;
		projectId: string;
		chapterId?: string;
		libraryScope?: boolean;
		title: string;
	}): Promise<GenerationRecord>;
	/** 一轮跑完（或被中止）后把消息补进记录。 */
	saveMessages(id: string, messages: AgentMessage[], title?: string): Promise<GenerationRecord | undefined>;
	/** 改这条记录的标题。 */
	rename(id: string, title: string): Promise<void>;
	/** 删一条记录。 */
	remove(id: string): Promise<boolean>;
}

/**
 * 计划文档里用的是另一套名字，这里留别名，免得两边对不上。
 * （docs/multi-user-browser-local-plan.md 的 R0-2 一节。）
 */
export type MaterialLibraryPort = LibraryStorePort;
export type KindStorePort = KindsStorePort;
export type SettingsPort = SettingsStorePort;
export type CredentialPort = CredentialStorePort;
