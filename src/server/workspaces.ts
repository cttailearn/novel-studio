/**
 * 每用户一套工作区。
 *
 * 云端账号模式下，服务端为每个用户各开一份存储、一份设置、一套模型运行时
 * 和一个路由实例。路由层原本就是「依赖全从外面递进来」的形状，所以这里
 * 不需要改任何业务逻辑，只需要把同一个 dataDir 换成 data/users/<userId>。
 *
 * 生命周期：
 *   · 第一次访问某用户时懒加载（open），之后复用；
 *   · 空闲一段时间且没有请求在跑时卸载，避免几百个用户各开一整套文件句柄；
 *   · 删号时 flush 之后连目录一起删。
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createApiRouter, type ApiRouter, type Session } from "./api-router.ts";
import { answerQuestionFor, AskChannel } from "./ask.ts";
import { RECORDS_KEEP } from "./records.ts";
import { RecordStore } from "./records-disk.ts";
import { KindRegistry } from "./kind-registry.ts";
import { FileCredentialStore } from "../config/credential-disk.ts";
import { SettingsStore } from "../config/settings-disk.ts";
import type { AppConfig } from "../config/env.ts";
import {
	BUILTIN_PROVIDERS,
	createModelRuntime,
	listAvailableModelsFor,
	listProviderStatusFor,
	rebuildModelRuntime,
	resolveModelFor,
	syncBuiltinProviders,
	type ModelRuntime,
} from "../ai/models.ts";
import { newId } from "../store/project.ts";
import { ProjectStore } from "../store/project-disk.ts";
import { MaterialLibrary } from "../store/library-disk.ts";
import { NovelSourceLibrary } from "../store/novel-source-disk.ts";
import { KindStore } from "../store/kinds-disk.ts";

/** 配额统计的形状；与云端模块的 Usage 结构一致，避免循环 import。 */
export interface UsageSnapshot {
	usedBytes: number;
	quotaBytes: number;
	breakdown: {
		projects: number;
		library: number;
		sources: number;
		records: number;
		settings: number;
		other: number;
	};
	updatedAt: number;
}

/** app.ts 递给云端模块的用量端口。 */
export interface WorkspaceUsageProvider {
	usageOf(userId: string): Promise<UsageSnapshot>;
	invalidate(userId: string): void;
	dispose(userId: string): Promise<void>;
}

/** 一个用户的工作区：存储 + 模型运行时 + 路由 + 会话表。 */
export interface Workspace {
	readonly userId: string;
	readonly dir: string;
	readonly stores: {
		store: ProjectStore;
		libraryStore: MaterialLibrary;
		novelStore: NovelSourceLibrary;
		kindStore: KindStore;
		settingsStore: SettingsStore;
		credentialStore: FileCredentialStore;
		recordStore: RecordStore;
	};
	/** 当前模型运行时；设置改动后会被替换。 */
	runtime: ModelRuntime;
	/** 这一用户自己的会话表（进程内，重启即失）。 */
	readonly sessions: Map<string, Session>;
	readonly router: ApiRouter;
	activeRequests: number;
	lastUsed: number;
}

interface UsageCacheEntry {
	usage: UsageSnapshot;
	at: number;
}

/** 空闲多久后允许卸载。 */
const IDLE_UNLOAD_MS = 30 * 60 * 1000;
/** 同时驻留的工作区上限。 */
const MAX_WORKSPACES = 50;
/** 用量缓存时间。 */
const USAGE_TTL_MS = 5_000;

/** 内置厂商目录投影；各工作区共用一份。 */
const BUILTIN_CATALOG = BUILTIN_PROVIDERS.map((spec) => ({
	id: spec.id,
	label: spec.label,
	envVars: [...spec.envVars],
	...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
	...(spec.api ? { api: spec.api } : {}),
}));

/**
 * 工作区管理器。
 *
 * 只负责「谁的工作区、什么时候开、什么时候收」；鉴权、配额判定、
 * 路由分发在 app.ts，账号数据在 cloud/。
 */
export class WorkspaceManager {
	readonly config: AppConfig;
	readonly kinds: KindRegistry;
	private readonly workspaces = new Map<string, Workspace>();
	/** 正在打开的工作区，避免同一用户并发首访时开两套。 */
	private readonly opening = new Map<string, Promise<Workspace>>();
	private readonly usageCache = new Map<string, UsageCacheEntry>();

	constructor(config: AppConfig) {
		this.config = config;
		this.kinds = new KindRegistry();
	}

	/** 用户数据目录。 */
	dirOf(userId: string): string {
		return path.join(this.config.dataDir, "users", userId);
	}

	/** 取工作区；不存在就开一套。 */
	async get(userId: string): Promise<Workspace> {
		const existing = this.workspaces.get(userId);
		if (existing) {
			existing.lastUsed = Date.now();
			return existing;
		}
		const pending = this.opening.get(userId);
		if (pending) return pending;

		const task = this.open(userId).finally(() => {
			this.opening.delete(userId);
		});
		this.opening.set(userId, task);
		return task;
	}

	/**
	 * 取工作区并占一个活跃请求。
	 *
	 * 请求结束必须 release()；卸载只在 activeRequests 归零后进行，
	 * 否则正在写的一章会被从内存里抽走。
	 */
	async acquire(userId: string): Promise<{ workspace: Workspace; release: () => void }> {
		const workspace = await this.get(userId);
		workspace.activeRequests += 1;
		workspace.lastUsed = Date.now();
		let released = false;
		return {
			workspace,
			release: () => {
				if (released) return;
				released = true;
				workspace.activeRequests = Math.max(0, workspace.activeRequests - 1);
				workspace.lastUsed = Date.now();
			},
		};
	}

	private async open(userId: string): Promise<Workspace> {
		const dir = this.dirOf(userId);
		// 目录不存在时各 store 会自己建，这里不必预先 mkdir。
		const kindStore = await KindStore.open(dir);
		const store = await ProjectStore.open(dir);
		const libraryStore = await MaterialLibrary.open(dir);
		const novelStore = await NovelSourceLibrary.open(dir);
		const settingsStore = await SettingsStore.open(dir);
		const credentialStore = await FileCredentialStore.open(dir);
		const recordStore = await RecordStore.open(dir);

		settingsStore.replace(syncBuiltinProviders(settingsStore.get(), this.config.defaultModel));
		const runtime = createModelRuntime(settingsStore, credentialStore);

		const sessions = new Map<string, Session>();
		const workspace = {} as Workspace;
		const router = createApiRouter({
			store,
			libraryStore,
			novelStore,
			kindStore,
			settingsStore,
			credentialStore,
			recordStore,
			sessions,
			config: this.config,
			// 云端模式不把服务端部署者的 API Key 环境变量透给用户：
			// 那是这台机器的凭据，不是这位用户的。
			env: {},
			recordsKeep: RECORDS_KEEP,
			newId,
			builtinCatalog: BUILTIN_CATALOG,
			createAskChannel: (sessionId: string) => new AskChannel(sessionId, userId),
			answerQuestion: (id: string, answer: string) => answerQuestionFor(userId, id, answer),
			refreshKinds: () => this.kinds.update(userId, kindStore.list()),
			allowedKinds: () => this.kinds.allowedFor(userId),
			models: {
				list: () => listAvailableModelsFor(workspace.runtime),
				status: () => listProviderStatusFor(workspace.runtime, {}),
				resolve: (reference: string) => resolveModelFor(workspace.runtime, reference),
				rebuild: () => {
					workspace.runtime = rebuildModelRuntime(workspace.runtime);
				},
				current: () => getModelsOf(workspace),
			},
		});

		Object.assign(workspace, {
			userId,
			dir,
			stores: { store, libraryStore, novelStore, kindStore, settingsStore, credentialStore, recordStore },
			runtime,
			sessions,
			router,
			activeRequests: 0,
			lastUsed: Date.now(),
		} satisfies Workspace);

		this.kinds.update(userId, kindStore.list());
		this.workspaces.set(userId, workspace);
		this.evictIdle(userId);

		// 上次退出若有没落盘的稿，进工作区时补写一次（与单机模式同款兜底）。
		void store
			.retryPending()
			.then(() => {
				const pending = store.pendingWrites();
				if (pending.length > 0) {
					console.error(`[workspace:${userId}] 仍有 ${pending.length} 部作品未能落盘：${pending.join(", ")}`);
				}
			})
			.catch((error) => console.error(`[workspace:${userId}] 补写失败`, error));

		return workspace;
	}

	/** 空闲卸载：只在没有活跃请求、且超过空闲阈值时动手。 */
	private evictIdle(currentUserId: string): void {
		const now = Date.now();
		for (const [userId, workspace] of this.workspaces) {
			if (userId === currentUserId) continue;
			if (workspace.activeRequests > 0) continue;
			if (now - workspace.lastUsed < IDLE_UNLOAD_MS) continue;
			void this.unload(userId);
		}
		while (this.workspaces.size > MAX_WORKSPACES) {
			const candidates = [...this.workspaces.entries()]
				.filter(([userId, item]) => userId !== currentUserId && item.activeRequests === 0)
				.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
			const oldest = candidates[0];
			if (!oldest) break;
			void this.unload(oldest[0]);
		}
	}

	/** 把工作区从内存里拿掉（先 flush，不删磁盘）。 */
	async unload(userId: string): Promise<void> {
		const workspace = this.workspaces.get(userId);
		if (!workspace || workspace.activeRequests > 0) return;
		this.workspaces.delete(userId);
		this.usageCache.delete(userId);
		this.kinds.remove(userId);
		await Promise.allSettled([
			workspace.stores.store.flush(),
			workspace.stores.libraryStore.flush(),
			workspace.stores.novelStore.flush(),
			workspace.stores.settingsStore.flush(),
		]);
	}

	/** 删号：先卸载并 flush，再删用户目录。 */
	async dispose(userId: string): Promise<void> {
		const workspace = this.workspaces.get(userId);
		if (workspace) {
			// 删号时不再等进行中的请求，先把引用摘掉，避免新请求继续往里写。
			this.workspaces.delete(userId);
			this.kinds.remove(userId);
			this.usageCache.delete(userId);
			await Promise.allSettled([
				workspace.stores.store.flush(),
				workspace.stores.libraryStore.flush(),
				workspace.stores.novelStore.flush(),
				workspace.stores.settingsStore.flush(),
			]);
		}
		this.kinds.remove(userId);
		this.usageCache.delete(userId);
		await rm(this.dirOf(userId), { recursive: true, force: true });
	}

	/** 用量：扫用户目录，缓存 5 秒。配额由云端按数据库里的用户记录覆盖。 */
	async usageOf(userId: string): Promise<UsageSnapshot> {
		const cached = this.usageCache.get(userId);
		if (cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.usage;

		const breakdown: UsageSnapshot["breakdown"] = {
			projects: 0,
			library: 0,
			sources: 0,
			records: 0,
			settings: 0,
			other: 0,
		};
		const dir = this.dirOf(userId);
		let entries: import("node:fs").Dirent[] = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			entries = [];
		}

		await Promise.all(
			entries.map(async (entry) => {
				const size = await sizeOf(path.join(dir, entry.name));
				if (size === 0) return;
				if (entry.name === "projects" || entry.name === "snapshots") breakdown.projects += size;
				else if (entry.name === "library.json" || entry.name === "kinds.json") breakdown.library += size;
				else if (entry.name === "material-sources" || entry.name === "novel-sources") breakdown.sources += size;
				else if (entry.name === "records.json" || entry.name === "records") breakdown.records += size;
				else if (entry.name === "settings.json" || entry.name === "credentials.json") breakdown.settings += size;
				else breakdown.other += size;
			}),
		);

		const usage: UsageSnapshot = {
			usedBytes: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
			quotaBytes: 0,
			breakdown,
			updatedAt: Date.now(),
		};
		this.usageCache.set(userId, { usage, at: Date.now() });
		return usage;
	}

	/** 写操作之后调用，让下一次用量读取重新扫描。 */
	invalidate(userId: string): void {
		this.usageCache.delete(userId);
	}

	/** 进程收尾：flush 所有驻留工作区。 */
	async close(): Promise<void> {
		await Promise.allSettled([...this.workspaces.keys()].map((userId) => this.unload(userId)));
	}
}

/** 目录或文件的字节数；目录递归累加，读不到当 0。 */
async function sizeOf(target: string): Promise<number> {
	let info: import("node:fs").Stats;
	try {
		info = await stat(target);
	} catch {
		return 0;
	}
	if (!info.isDirectory()) return info.size;
	let total = 0;
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch {
		return total;
	}
	await Promise.all(
		entries.map(async (entry) => {
			total += await sizeOf(path.join(target, entry.name));
		}),
	);
	return total;
}

/** 取当前运行时里的模型表；工作区被重建后仍然指向最新的一套。 */
function getModelsOf(workspace: Workspace) {
	return workspace.runtime.models;
}
