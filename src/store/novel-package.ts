/**
 * `.novel` 包：把作品（或整个工作区）装进一个自足的文件。
 *
 * 这套产品**不做云同步** —— 服务端什么都不存，每个人的数据都在他自己浏览器的
 * IndexedDB 里。跨设备搬数据只有一条路：导出一个 `.novel` 文件，在另一台设备上
 * 导进去。这个文件就是"搬家的箱子"。
 *
 * ## 箱子的形状
 *
 * 箱子是一个 JSON 信封：
 *
 * ```json
 * {
 *   "magic": "novel-studio/novel",
 *   "formatVersion": 1,
 *   "exportedAt": "2026-01-02T03:04:05.000Z",
 *   "kind": "full",
 *   "encrypted": false,
 *   "payload": {
 *     "projects": [
 *       {
 *         "project": { "id": "…", "title": "…", "materials": [], "volumes": [], "outline": [], "drafts": {}, "notes": [] },
 *         "bodies": { "ch1": { "content": "正文", "history": [ { "revision": 1, "content": "旧稿", "mode": "revise" } ] } },
 *         "snapshots": [ { "name": "2026-01-01T00-00-00-000Z-标签.json.gz", "at": 0, "size": 0, "project": {…}, "bodies": {…} } ]
 *       }
 *     ],
 *     "library": [ { "id": "…", "kind": "character", "title": "…", "content": "…", "tags": [], "usage": "", "status": "confirmed" } ],
 *     "kinds":   [ { "id": "…", "label": "行当", "createdAt": 0 } ],
 *     "settings": { "version": 1, "defaultModel": "…", "providers": [ … ] },
 *     "records": [ { "id": "…", "role": "writing", "projectId": "…", "title": "…", "messages": [ … ] } ],
 *     "credentials": null
 *   }
 * }
 * ```
 *
 * - `kind` 为 `"full"` 时 payload 里是全部作品 + 素材库 + 自建种类 + 设置 + 生成记录；
 *   为 `"project"` 时只有一部作品和它的正文、历史与快照（不带设置与密钥）。
 * - `credentials` 默认是 `null`（不导出）。见下面"密钥"一节。
 *
 * ## gzip 还是明文 JSON
 *
 * 不压缩时磁盘上的东西就是上面这段 JSON —— 人眼能看、能改、能 diff。
 * 压缩时整段 JSON 被 gzip 压成二进制（默认行为），文件头两个字节是 `1f 8b`。
 * 读的时候**先**看这两个字节：是 gzip 就解压，不是就当 JSON 解析。
 * 这条判定是唯一的入口，两条路不会互相误认 —— 压缩过的包绝不会被当成 JSON 解析。
 *
 * ## 口令保护（计划文档 R2）
 *
 * 给了口令，信封的 payload 换成密文信封
 * `{ kdf, iterations, salt, iv, ciphertext }`。密钥用 PBKDF2-SHA-256 派生
 * （210000 轮、随机 16 字节盐），正文用 AES-GCM 加密（随机 12 字节 IV，
 * 校验标签由 WebCrypto 自己接在密文后头）。口令不对时报一句人话
 * （"口令不对或包已损坏"），不抛 WebCrypto 的内部错误，也绝不打印口令、密钥或明文。
 *
 * ## 密钥默认不导出
 *
 * 设置里只有供应商与模型，API 密钥单独存在 CredentialStorePort 里；要把它一起带走，
 * 作者必须显式勾选（`includeCredentials: true`）并给一个口令（密钥会用同一个口令加密）。
 * 单部作品的导出（`kind: "project"`）永远不含密钥。导出时设置还会过一遍
 * `sanitizeNovelSettings`，把任何长得像密钥的字段（apiKey / token / secret…）剔掉。
 *
 * ## 环境要求
 *
 * `crypto.subtle` 只在**安全上下文**里才有（https 或 localhost）。纯 http 的部署下
 * 加密不可用 —— 这时导出会直接报一句人话，而不是抛一串 WebCrypto 的内部错误。
 * 压缩用的是浏览器与 Node 18+ 都有的 `CompressionStream`/`DecompressionStream`，
 * 不引任何新依赖。
 *
 * ## 兼容层
 *
 * 文件末尾还有一组旧接口（`buildNovelPackage` / `parseNovelPackage` /
 * `serializeNovelPackage` …）。那是给 `src/store/novel-crypto.ts` 用的：
 * 它加密的是"摊平后的旧容器"。保留它们是为了不打断那个模块；
 * 新代码一律用上面的 `exportNovel` / `importNovel`。
 */

import { newId } from "./project.ts";
import type { ApiFormat, Settings } from "../config/settings.ts";
import type { GenerationRecord } from "../server/records.ts";
import type { CustomKind } from "./kinds.ts";
import type { LibraryMaterial } from "./library.ts";
import type {
	ChapterMeta,
	ContinuityNote,
	DraftBody,
	DraftRevision,
	Material,
	MaterialKind,
	OutlineChapter,
	Project,
	Volume,
} from "./project.ts";
import type {
	CredentialStorePort,
	KindsStorePort,
	LibraryStorePort,
	ProjectStorePort,
	RecordStorePort,
	SettingsStorePort,
} from "./store-port.ts";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 包头标识。认它才认这个文件。 */
export const NOVEL_PACKAGE_MAGIC = "novel-studio/novel";
/** 包格式版本。往后改格式就加一，老包还能读。 */
export const NOVEL_PACKAGE_FORMAT_VERSION = 1;
/** 密钥派生算法名，写在密文信封里。 */
export const NOVEL_PACKAGE_KDF = "PBKDF2-SHA-256";
/** PBKDF2 轮数。210000 轮是 OWASP 对 PBKDF2-SHA-256 的建议值。 */
export const NOVEL_PACKAGE_PBKDF2_ITERATIONS = 210_000;
/**
 * 单个文本字段的上限（字符数）。
 *
 * 四百万字符约合 12 MB UTF-8。正常一章正文是几万字，一份包的正文总量
 * 另受包体积上限约束；这个上限拦的是"一个字段塞进几十兆"这种畸形包 ——
 * 导入时宁可报错，也不要把一个坏包撑爆内存。
 */
export const NOVEL_PACKAGE_MAX_TEXT_CHARS = 4_000_000;
/** 整个包的上限（字节）。512 MB。 */
export const NOVEL_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 包的两种形态：整个工作区，还是一部作品。 */
export type NovelPackageKind = "full" | "project";

/** 密文信封：加密时 payload 就是它。 */
export interface NovelEncryptedPayload {
	/** 密钥派生算法，目前只有 PBKDF2-SHA-256。 */
	kdf: typeof NOVEL_PACKAGE_KDF;
	/** PBKDF2 轮数。 */
	iterations: number;
	/** 盐（base64）。 */
	salt: string;
	/** 初始向量（base64）。 */
	iv: string;
	/** 密文（base64，含 WebCrypto 追加的 GCM 校验标签）。 */
	ciphertext: string;
}

/** 一份快照：名字、时间、体积，加上当时的骨架与正文。 */
export interface NovelSnapshotPayload {
	/** 快照文件名（原样带进包里，方便两边对照快照清单）。 */
	name: string;
	/** 作者自己起的标签（从文件名里还原出来的）。 */
	label?: string;
	/** 快照时间（毫秒时间戳）。 */
	at: number;
	/** 快照体积（字节）。 */
	size: number;
	/** 当时的骨架。 */
	project: Project;
	/** 当时的正文与历史。 */
	bodies: Record<string, DraftBody>;
}

/** 一部作品：骨架 + 各章正文与历史 + 快照。 */
export interface NovelProjectPayload {
	/** 骨架：卷、大纲、素材、备注、各章元数据。 */
	project: Project;
	/** 章节 id → 正文与历史版本。 */
	bodies: Record<string, DraftBody>;
	/** 该作品的快照（从旧到新）。 */
	snapshots: NovelSnapshotPayload[];
}

/** 信封里的数据。 */
export interface NovelPayload {
	/** 全部作品（kind:"project" 时只有一部）。 */
	projects: NovelProjectPayload[];
	/** 通用素材库。 */
	library: LibraryMaterial[];
	/** 作者自建的素材种类。 */
	kinds: CustomKind[];
	/** 应用设置（不含密钥）。 */
	settings?: Settings;
	/** 生成记录。 */
	records: GenerationRecord[];
	/**
	 * 供应商 id → API 密钥。
	 *
	 * 默认没有这个字段（不导出）。只有作者显式勾选"连密钥一起带走"并给了口令时才有值。
	 */
	credentials?: Record<string, string>;
}

/** 包的信封。 */
export interface NovelPackageEnvelope {
	magic: typeof NOVEL_PACKAGE_MAGIC;
	formatVersion: number;
	/** 导出时间（ISO 字符串）。 */
	exportedAt: string;
	kind: NovelPackageKind;
	/** payload 是不是密文。 */
	encrypted: boolean;
	/** 数据本身；加密时是密文信封。 */
	payload: NovelPayload | NovelEncryptedPayload;
}

/** 导出与导入要用的那套存储端口。 */
export interface NovelExportDeps {
	/** 作品与正文。 */
	store: ProjectStorePort;
	/** 通用素材库。 */
	libraryStore: LibraryStorePort;
	/** 作者自建的素材种类。 */
	kindStore: KindsStorePort;
	/** 应用设置（不含密钥）。 */
	settingsStore: SettingsStorePort;
	/** 生成记录。 */
	recordStore: RecordStorePort;
	/** 厂商密钥。只有导出密钥时才用得上。 */
	credentialStore?: CredentialStorePort;
}

/** 导出的选项。 */
export interface NovelExportOptions {
	/** 只导一部作品；不给就全导。 */
	projectId?: string;
	/** 是否包含 API 密钥。true 时必须给 passphrase。 */
	includeCredentials?: boolean;
	/** 口令。给了就加密。 */
	passphrase?: string;
	/** 是否 gzip 压缩。默认 true。 */
	compress?: boolean;
	/** 取时间的函数。默认 Date.now。测试时用来固定导出时间。 */
	now?: () => number;
}

/** 导入的选项。 */
export interface NovelImportOptions {
	/** 口令。包里加密就必须给。 */
	passphrase?: string;
	/** 与已有作品重名/同 id 时怎么办。默认 "skip"。 */
	onConflict?: "skip" | "replace" | "rename";
	/** 取时间的函数。默认 Date.now。 */
	now?: () => number;
}

/** 导入的结果。 */
export interface NovelImportResult {
	projects: number;
	chapters: number;
	materials: number;
	kinds: number;
	records: number;
	skipped: number;
	/** 非致命的问题：跳过的坏条目、被改名的作品等等。 */
	warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/**
 * 导出一个 `.novel` 包。
 *
 * 返回的是整个文件的字节：默认 gzip 过的（头两个字节 `1f 8b`），
 * `compress: false` 时是明摆着的 JSON 文本。
 */
export async function exportNovel(deps: NovelExportDeps, options: NovelExportOptions = {}): Promise<Uint8Array> {
	const now = options.now ?? Date.now;
	const single = options.projectId !== undefined;

	if (options.includeCredentials && !options.passphrase) {
		throw new Error("要连 API 密钥一起导出，必须先给一个口令（密钥会用它加密）");
	}
	if (options.includeCredentials && single) {
		throw new Error("单部作品的导出不含设置与密钥；要带走密钥请导出整个工作区（不传 projectId）");
	}

	const payload = await collectPayload(deps, options);
	const envelope: NovelPackageEnvelope = {
		magic: NOVEL_PACKAGE_MAGIC,
		formatVersion: NOVEL_PACKAGE_FORMAT_VERSION,
		exportedAt: new Date(now()).toISOString(),
		kind: single ? "project" : "full",
		encrypted: false,
		payload,
	};

	if (options.passphrase) {
		envelope.encrypted = true;
		envelope.payload = await encryptPayload(payload, options.passphrase);
	}

	const bytes = new TextEncoder().encode(JSON.stringify(envelope, null, 2));
	if (options.compress === false) return bytes;
	return gzipBytes(bytes);
}

/** 按选项把各端口里的东西收进一个 payload。 */
async function collectPayload(deps: NovelExportDeps, options: NovelExportOptions): Promise<NovelPayload> {
	const single = options.projectId !== undefined;
	let projects: Project[] = [];
	if (single) {
		const project = deps.store.get(options.projectId as string);
		if (!project) throw new Error(`找不到要导出的作品（id：${options.projectId}）`);
		projects = [project];
	} else {
		projects = deps.store.list();
	}

	const entries: NovelProjectPayload[] = [];
	for (const project of projects) {
		entries.push(await collectProject(deps, project));
	}

	const payload: NovelPayload = {
		projects: entries,
		library: [],
		kinds: [],
		records: [],
	};
	if (!single) {
		payload.library = deps.libraryStore.list().map((item) => cloneJson(item));
		payload.kinds = deps.kindStore.list().map((item) => cloneJson(item));
		const warnings: string[] = [];
		const settings = sanitizeNovelSettings(deps.settingsStore.get(), warnings);
		if (settings) payload.settings = settings;
		payload.records = collectRecords(deps);
		if (options.includeCredentials && options.passphrase) {
			const credentials = await collectCredentials(deps);
			if (Object.keys(credentials).length > 0) payload.credentials = credentials;
		}
	}
	return payload;
}

/** 一部作品的骨架、正文与快照。 */
async function collectProject(deps: NovelExportDeps, project: Project): Promise<NovelProjectPayload> {
	const bodies: Record<string, DraftBody> = {};
	for (const chapterId of Object.keys(project.drafts)) {
		const body = await deps.store.readDraftBody(project.id, chapterId, { history: true });
		if (!body) continue;
		bodies[chapterId] = { content: body.content, history: (body.history ?? []).map((item) => cloneJson(item)) };
	}

	const snapshots: NovelSnapshotPayload[] = [];
	for (const info of await deps.store.listSnapshots(project.id)) {
		const content = await deps.store.readSnapshot(project.id, info.name);
		if (!content) continue;
		snapshots.push({
			name: info.name,
			label: decodeSnapshotLabel(info.name),
			at: info.at,
			size: info.size,
			project: cloneJson(content.project),
			bodies: cloneBodies(content.bodies),
		});
	}

	return { project: cloneJson(project), bodies, snapshots };
}

/** 全部生成记录（列表是轻量视图，正文要一条条取）。 */
function collectRecords(deps: NovelExportDeps): GenerationRecord[] {
	const out: GenerationRecord[] = [];
	for (const summary of deps.recordStore.list({}, Number.MAX_SAFE_INTEGER)) {
		const record = deps.recordStore.get(summary.id);
		if (!record) continue;
		out.push(cloneJson(record));
	}
	return out;
}

/** 各供应商的 API 密钥。OAuth 凭据不在此列 —— 端口只提供 setKey。 */
async function collectCredentials(deps: NovelExportDeps): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const store = deps.credentialStore;
	if (!store) return out;
	for (const info of await store.list()) {
		const credential = await store.read(info.providerId);
		if (!credential) continue;
		const raw = credential as { type?: unknown; key?: unknown };
		if (raw.type !== "api_key") continue;
		if (typeof raw.key !== "string" || !raw.key) continue;
		out[info.providerId] = raw.key;
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

/**
 * 把一个 `.novel` 包导进那套存储端口。
 *
 * 同一个包导两次不会把数据变成两倍：作品按 id 与标题判重，
 * 素材库按内容指纹判重，自建种类按名字判重，记录按面板与内容判重。
 *
 * 注意：存储端口没有"按指定 id 写入"的口子，所以导入后 id 是重新生成的；
 * 作品之间的引用（记录的 projectId）会跟着改写。
 */
export async function importNovel(
	deps: NovelExportDeps,
	bytes: Uint8Array,
	options: NovelImportOptions = {},
): Promise<NovelImportResult> {
	const warnings: string[] = [];
	const envelope = await readEnvelope(bytes);
	const rawPayload = await resolvePayload(envelope, options.passphrase);
	const payload = normalizeSections(rawPayload, warnings);

	const result: NovelImportResult = {
		projects: 0,
		chapters: 0,
		materials: 0,
		kinds: 0,
		records: 0,
		skipped: 0,
		warnings,
	};

	// 包里的作品 id → 这台机器上的作品 id
	const projectIdMap = new Map<string, string>();
	for (const entry of payload.projects) {
		const imported = await importProject(deps, entry, options.onConflict ?? "skip", result, warnings);
		if (imported) projectIdMap.set(entry.project.id, imported.id);
	}

	// 通用素材库
	const libraryFingerprints = new Set(deps.libraryStore.list().map(fingerprintLibrary));
	for (const material of payload.library) {
		const fingerprint = fingerprintLibrary(material);
		if (libraryFingerprints.has(fingerprint)) {
			result.skipped += 1;
			continue;
		}
		deps.libraryStore.create({
			kind: material.kind,
			title: material.title,
			content: material.content,
			tags: [...material.tags],
			usage: material.usage,
			status: material.status,
		});
		libraryFingerprints.add(fingerprint);
		result.materials += 1;
	}

	// 作者自建的种类（按名字判重：端口给的 id 每次都不一样）
	const kindLabels = new Set(deps.kindStore.list().map((item) => item.label));
	for (const kind of payload.kinds) {
		if (kindLabels.has(kind.label)) {
			result.skipped += 1;
			continue;
		}
		const added = deps.kindStore.add(kind.label);
		if (!added.ok) {
			result.skipped += 1;
			warnings.push(`自建种类「${kind.label}」没导进去：${added.error}`);
			continue;
		}
		kindLabels.add(kind.label);
		result.kinds += 1;
	}

	// 应用设置
	if (payload.settings) {
		deps.settingsStore.replace(payload.settings);
	}

	// 生成记录（指纹要用完整记录，列表接口给的是没有消息的轻量视图）
	const recordFingerprints = new Set(
		deps.recordStore
			.list({}, Number.MAX_SAFE_INTEGER)
			.map((summary) => deps.recordStore.get(summary.id))
			.filter((record): record is GenerationRecord => Boolean(record))
			.map(fingerprintRecord),
	);
	for (const record of payload.records) {
		const mapped = record.projectId ? projectIdMap.get(record.projectId) : undefined;
		if (record.projectId && !mapped && !record.libraryScope) {
			result.skipped += 1;
			warnings.push(`有一条生成记录指向的作品没导进去（${record.title}），已跳过`);
			continue;
		}
		const projectId = mapped ?? record.projectId;
		const fingerprint = fingerprintRecord({ ...record, projectId });
		if (recordFingerprints.has(fingerprint)) {
			result.skipped += 1;
			continue;
		}
		const created = await deps.recordStore.create({
			role: record.role,
			projectId,
			title: record.title,
			...(record.chapterId ? { chapterId: record.chapterId } : {}),
			...(record.libraryScope ? { libraryScope: true } : {}),
		});
		await deps.recordStore.saveMessages(created.id, record.messages, record.title);
		recordFingerprints.add(fingerprint);
		result.records += 1;
	}

	// 密钥（只有作者显式勾选过的包才带）
	if (payload.credentials) {
		if (!deps.credentialStore) {
			warnings.push("这个包带了 API 密钥，但这次没给密钥存储，密钥没导进去");
		} else {
			for (const [providerId, key] of Object.entries(payload.credentials)) {
				await deps.credentialStore.setKey(providerId, key);
			}
		}
	}

	return result;
}

/**
 * 一部作品的导入。
 *
 * 返回这台机器上的作品 id 与"是不是真的导进去了"。
 * 被跳过时仍然返回已有作品的 id —— 这样包里指向这部作品的生成记录
 * 还能跟已有记录对上，不会被当成孤儿丢掉。
 */
async function importProject(
	deps: NovelExportDeps,
	entry: NovelProjectPayload,
	onConflict: "skip" | "replace" | "rename",
	result: NovelImportResult,
	warnings: string[],
): Promise<{ id: string; imported: boolean } | undefined> {
	const source = entry.project;
	const existing = deps.store.list().find((item) => item.id === source.id || item.title === source.title);
	if (existing) {
		if (onConflict === "skip") {
			result.skipped += 1;
			warnings.push(`《${source.title}》已经存在，这次没有导入`);
			return { id: existing.id, imported: false };
		}
		if (onConflict === "replace") {
			// 旧作进回收站而不是直接抹掉：万一包里有坏数据，回得去。
			await deps.store.remove(existing.id);
			// 挂在旧作上的生成记录一起让位，否则同一个包导两次会攒出两份记录。
			for (const summary of deps.recordStore.list({ projectId: existing.id })) {
				await deps.recordStore.remove(summary.id);
			}
			warnings.push(`《${source.title}》已存在，旧的那本放进了回收站，新的导入进来了`);
		}
	}

	const title = onConflict === "rename" ? uniqueTitle(deps, source.title) : source.title;
	const created = deps.store.create({ title });

	// 快照先摆：快照要拍的是"当时的样子"，所以先把那时的骨架与正文写进去。
	for (const snapshot of entry.snapshots) {
		deps.store.mutate(created.id, (project) => {
			applySkeleton(project, snapshot.project, title);
		});
		for (const [chapterId, body] of Object.entries(snapshot.bodies)) {
			await restoreBody(deps, created.id, snapshot.project, chapterId, body);
		}
		const current = deps.store.get(created.id);
		if (current) await deps.store.snapshot(current, snapshot.label || decodeSnapshotLabel(snapshot.name));
	}

	// 再摆活的那一部：骨架、正文与历史版本一起写回去。
	deps.store.mutate(created.id, (project) => {
		applySkeleton(project, source, title);
	});
	for (const [chapterId, body] of Object.entries(entry.bodies)) {
		await restoreBody(deps, created.id, source, chapterId, body);
		result.chapters += 1;
	}

	result.projects += 1;
	return { id: created.id, imported: true };
}

/**
 * 把一章的正文与历史版本写回去。
 *
 * 存储层没有"直接写历史"的接口，只有"写正文"；而且它只在内容变了的时候
 * 把旧稿归档成历史版本。所以历史只能一版一版地重写一遍：先写最老的一版
 * （keepHistory:false，历史清零），再一版一版往后写。
 *
 * 归档时记的是"这一次写入的 mode"，所以第 i 次写入要传第 i-1 版的 mode，
 * 还原出来的历史版本才带着原来的 mode。
 */
async function restoreBody(
	deps: NovelExportDeps,
	projectId: string,
	project: Project,
	chapterId: string,
	body: DraftBody,
): Promise<void> {
	const meta = project.drafts[chapterId];
	const history = body.history ?? [];
	for (let index = 0; index < history.length; index++) {
		const revision = history[index] as DraftRevision;
		const previous = index > 0 ? history[index - 1] : undefined;
		await deps.store.saveDraftBody(projectId, chapterId, {
			title: revision.title || chapterTitle(project, chapterId),
			content: revision.content,
			summary: meta?.summary ?? "",
			materialIds: [...(revision.materialIds ?? [])],
			// 归档时记的是"这次写入的 mode"，所以要传上一版的 mode 才还原得出来。
			mode: previous?.mode || revision.mode || "manual",
			keepHistory: index > 0,
		});
	}
	const last = history.length > 0 ? history[history.length - 1] : undefined;
	await deps.store.saveDraftBody(projectId, chapterId, {
		title: meta?.title || chapterTitle(project, chapterId),
		content: body.content,
		summary: meta?.summary ?? "",
		materialIds: [...(meta?.materialIds ?? [])],
		mode: last?.mode || "manual",
		keepHistory: history.length > 0,
	});
}

/** 把骨架从一份复制到另一份（id 与 updatedAt 归存储层管）。 */
function applySkeleton(target: Project, source: Project, titleOverride?: string): void {
	target.title = titleOverride ?? source.title;
	target.genre = source.genre;
	target.logline = source.logline;
	target.synopsis = source.synopsis;
	target.styleGuide = source.styleGuide;
	target.targetWords = source.targetWords;
	target.materials = source.materials.map((item) => ({
		...item,
		tags: [...item.tags],
		chapterIds: [...item.chapterIds],
	}));
	target.volumes = source.volumes.map((item) => ({ ...item }));
	target.outline = source.outline.map((item) => ({ ...item, materialIds: [...item.materialIds] }));
	target.drafts = Object.fromEntries(
		Object.entries(source.drafts).map(([key, meta]) => [key, { ...meta, materialIds: [...meta.materialIds] }]),
	);
	target.notes = source.notes.map((item) => ({ ...item }));
	target.createdAt = source.createdAt;
}

/** 章节标题：大纲优先，其次章的元数据，都没有就空串。 */
function chapterTitle(project: Project, chapterId: string): string {
	const meta = project.drafts[chapterId];
	if (meta?.title) return meta.title;
	const outline = project.outline.find((item) => item.id === chapterId);
	return outline?.title ?? "";
}

/** 换个不重名的标题。 */
function uniqueTitle(deps: NovelExportDeps, base: string): string {
	const taken = new Set(deps.store.list().map((item) => item.title));
	if (!taken.has(base)) return base;
	for (let index = 2; index < 1000; index++) {
		const candidate = `${base}（导入${index}）`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}（导入）`;
}

/* ------------------------------------------------------------------ *
 * 读包与校验
 * ------------------------------------------------------------------ */

/** 读信封：先判 gzip，不是 gzip 就当 JSON。 */
async function readEnvelope(bytes: Uint8Array): Promise<NovelPackageEnvelope> {
	if (bytes.length > NOVEL_PACKAGE_MAX_BYTES) {
		throw new Error(`这个包太大了（${bytes.length} 字节），超过上限 ${NOVEL_PACKAGE_MAX_BYTES} 字节`);
	}
	const raw = isGzip(bytes) ? await gunzipBytes(bytes) : bytes;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		throw new Error("这个文件不是有效的 .novel 包（不是合法 JSON）");
	}
	if (!isPlainObject(parsed)) throw new Error("这个文件不是有效的 .novel 包（内容不是一个对象）");
	const record = parsed as Record<string, unknown>;
	if (record["magic"] !== NOVEL_PACKAGE_MAGIC) {
		throw new Error(`这不是 .novel 包（包头标识不对，应该是 ${NOVEL_PACKAGE_MAGIC}）`);
	}
	const version = record["formatVersion"];
	if (typeof version !== "number" || !Number.isInteger(version)) {
		throw new Error("这个包的格式版本不对");
	}
	if (version !== NOVEL_PACKAGE_FORMAT_VERSION) {
		throw new Error(
			`这个包的格式版本是 ${version}，本版本只认 ${NOVEL_PACKAGE_FORMAT_VERSION}，请更新应用后再导`,
		);
	}
	const kind = record["kind"];
	if (kind !== "full" && kind !== "project") throw new Error("这个包的 kind 不对（只能是 full 或 project）");
	return {
		magic: NOVEL_PACKAGE_MAGIC,
		formatVersion: version,
		exportedAt: typeof record["exportedAt"] === "string" ? record["exportedAt"] : "",
		kind,
		encrypted: record["encrypted"] === true,
		payload: record["payload"] as NovelPayload | NovelEncryptedPayload,
	};
}

/** 该不该按 gzip 解。头两个字节 1f 8b 就是 gzip 的铁证。 */
function isGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** 取出 payload：该解密就解密。 */
async function resolvePayload(envelope: NovelPackageEnvelope, passphrase: string | undefined): Promise<unknown> {
	if (!envelope.encrypted) {
		if (!isPlainObject(envelope.payload)) throw new Error("这个包里的内容格式不对");
		return envelope.payload;
	}
	if (!passphrase) throw new Error("这个包是加密的，需要口令才能导入");
	if (!isEncryptedPayload(envelope.payload)) throw new Error("这个包的加密数据格式不对");
	return decryptPayload(envelope.payload, passphrase);
}

/** 归一化之后的数据。 */
interface NormalizedSections {
	projects: NovelProjectPayload[];
	library: LibraryMaterial[];
	kinds: CustomKind[];
	records: GenerationRecord[];
	settings?: Settings;
	credentials?: Record<string, string>;
}

/**
 * 逐项校验包里的数据。
 *
 * 分两类：
 * - 致命问题（抛错）：整个包装不进去的，包不该继续用。
 * - 非致命问题（记进 warnings 跳过）：个别条目坏了，不该拖累整包。
 */
function normalizeSections(raw: unknown, warnings: string[]): NormalizedSections {
	if (!isPlainObject(raw)) throw new Error("这个包里的内容格式不对");
	const source = raw as Record<string, unknown>;

	const projects: NovelProjectPayload[] = [];
	const rawProjects = source["projects"];
	if (Array.isArray(rawProjects)) {
		for (const item of rawProjects) {
			const project = normalizeProjectEntry(item, warnings);
			if (project) projects.push(project);
		}
	} else if (rawProjects !== undefined) {
		warnings.push("包里的作品列表格式不对，已跳过");
	}

	const library: LibraryMaterial[] = [];
	const rawLibrary = source["library"];
	if (Array.isArray(rawLibrary)) {
		for (const item of rawLibrary) {
			const material = normalizeLibraryMaterial(item, warnings);
			if (material) library.push(material);
		}
	} else if (rawLibrary !== undefined) {
		warnings.push("素材库格式不对，已跳过");
	}

	const kinds: CustomKind[] = [];
	const rawKinds = source["kinds"];
	if (Array.isArray(rawKinds)) {
		for (const item of rawKinds) {
			const kind = normalizeCustomKind(item, warnings);
			if (kind) kinds.push(kind);
		}
	} else if (rawKinds !== undefined) {
		warnings.push("自建种类格式不对，已跳过");
	}

	const records: GenerationRecord[] = [];
	const rawRecords = source["records"];
	if (Array.isArray(rawRecords)) {
		for (const item of rawRecords) {
			const record = normalizeRecord(item, warnings);
			if (record) records.push(record);
		}
	} else if (rawRecords !== undefined) {
		warnings.push("生成记录格式不对，已跳过");
	}

	const settings = sanitizeNovelSettings(source["settings"], warnings);

	let credentials: Record<string, string> | undefined;
	const rawCredentials = source["credentials"];
	if (isPlainObject(rawCredentials)) {
		credentials = {};
		for (const [providerId, key] of Object.entries(rawCredentials)) {
			if (typeof key !== "string" || !key) {
				warnings.push(`供应商「${providerId}」的密钥格式不对，已跳过`);
				continue;
			}
			credentials[providerId] = key;
		}
	} else if (rawCredentials !== undefined && rawCredentials !== null) {
		warnings.push("包里的密钥格式不对，已跳过");
	}

	return { projects, library, kinds, records, settings, credentials };
}

/** 一部作品。坏掉就整条跳过，不牵连别的作品。 */
function normalizeProjectEntry(raw: unknown, warnings: string[]): NovelProjectPayload | undefined {
	if (!isPlainObject(raw)) {
		warnings.push("有一条作品数据格式不对，已跳过");
		return undefined;
	}
	const rawProject = raw["project"];
	if (!isPlainObject(rawProject)) {
		warnings.push("有一条作品数据格式不对，已跳过");
		return undefined;
	}
	const title = typeof rawProject["title"] === "string" && rawProject["title"].trim() ? rawProject["title"] : "未命名作品";
	const project: Project = {
		id: typeof rawProject["id"] === "string" && rawProject["id"] ? rawProject["id"] : newId(),
		title,
		genre: readString(rawProject["genre"]),
		logline: readString(rawProject["logline"]),
		synopsis: readString(rawProject["synopsis"]),
		styleGuide: readString(rawProject["styleGuide"]),
		targetWords: readCount(rawProject["targetWords"]),
		materials: normalizeMaterials(rawProject["materials"], title, warnings),
		volumes: normalizeVolumes(rawProject["volumes"], title, warnings),
		outline: normalizeOutline(rawProject["outline"], title, warnings),
		drafts: normalizeDrafts(rawProject["drafts"], title, warnings),
		notes: normalizeNotes(rawProject["notes"], title, warnings),
		createdAt: readTime(rawProject["createdAt"]),
		updatedAt: readTime(rawProject["updatedAt"]),
	};
	const bodies = normalizeBodies(raw["bodies"], title, warnings);
	const snapshots = normalizeSnapshots(raw["snapshots"], title, warnings);
	return { project, bodies, snapshots };
}

function normalizeMaterials(raw: unknown, title: string, warnings: string[]): Material[] {
	if (!Array.isArray(raw)) return [];
	const out: Material[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item["kind"] !== "string" || typeof item["title"] !== "string") {
			warnings.push(`《${title}》有一条素材格式不对，已跳过`);
			continue;
		}
		const content = typeof item["content"] === "string" ? item["content"] : "";
		if (content.length > NOVEL_PACKAGE_MAX_TEXT_CHARS) {
			throw new Error(`《${title}》有一条素材太大了（${content.length} 字），这个包可能损坏`);
		}
		const material: Material = {
			id: typeof item["id"] === "string" && item["id"] ? item["id"] : newId(),
			kind: item["kind"] as MaterialKind,
			title: item["title"],
			content,
			tags: readStringArray(item["tags"]),
			usage: readString(item["usage"]),
			status: item["status"] === "confirmed" ? "confirmed" : "draft",
			chapterIds: readStringArray(item["chapterIds"]),
			source: item["source"] === "agent" ? "agent" : item["source"] === "library" ? "library" : "human",
			createdAt: readTime(item["createdAt"]),
			updatedAt: readTime(item["updatedAt"]),
		};
		const originId = item["originId"];
		if (typeof originId === "string" && originId) material.originId = originId;
		out.push(material);
	}
	return out;
}

function normalizeVolumes(raw: unknown, title: string, warnings: string[]): Volume[] {
	if (!Array.isArray(raw)) return [];
	const out: Volume[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item["id"] !== "string" || typeof item["title"] !== "string") {
			warnings.push(`《${title}》有一卷格式不对，已跳过`);
			continue;
		}
		out.push({
			id: item["id"],
			title: item["title"],
			summary: readString(item["summary"]),
			targetWords: readCount(item["targetWords"]),
			notes: readString(item["notes"]),
		});
	}
	return out;
}

function normalizeOutline(raw: unknown, title: string, warnings: string[]): OutlineChapter[] {
	if (!Array.isArray(raw)) return [];
	const out: OutlineChapter[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item["id"] !== "string" || typeof item["title"] !== "string") {
			warnings.push(`《${title}》有一条章目格式不对，已跳过`);
			continue;
		}
		out.push({
			id: item["id"],
			title: item["title"],
			summary: readString(item["summary"]),
			pov: readString(item["pov"]),
			volumeId: readString(item["volumeId"]),
			status: normalizeChapterStatus(item["status"]),
			targetWords: readCount(item["targetWords"]),
			notes: readString(item["notes"]),
			materialIds: readStringArray(item["materialIds"]),
		});
	}
	return out;
}

function normalizeChapterStatus(raw: unknown): OutlineChapter["status"] {
	if (
		raw === "planned" ||
		raw === "outlined" ||
		raw === "drafting" ||
		raw === "drafted" ||
		raw === "revising" ||
		raw === "done"
	) {
		return raw;
	}
	return "planned";
}

function normalizeDrafts(raw: unknown, title: string, warnings: string[]): Record<string, ChapterMeta> {
	const out: Record<string, ChapterMeta> = {};
	if (!isPlainObject(raw)) return out;
	for (const [key, item] of Object.entries(raw)) {
		if (!isPlainObject(item)) {
			warnings.push(`《${title}》第 ${key} 章的元数据格式不对，已跳过`);
			continue;
		}
		const revision = item["revision"];
		if (typeof revision === "number" && revision < 0) {
			warnings.push(`《${title}》第 ${key} 章的版本号不对，已按 0 处理`);
		}
		const words = item["words"];
		if (typeof words === "number" && words < 0) {
			warnings.push(`《${title}》第 ${key} 章的字数不对，已按 0 处理`);
		}
		out[key] = {
			id: typeof item["id"] === "string" && item["id"] ? item["id"] : key,
			title: readString(item["title"]),
			summary: readString(item["summary"]),
			words: typeof words === "number" && words >= 0 ? Math.floor(words) : 0,
			revision: typeof revision === "number" && revision >= 0 ? Math.floor(revision) : 0,
			updatedAt: readTime(item["updatedAt"]),
			materialIds: readStringArray(item["materialIds"]),
			hasDraft: item["hasDraft"] === true,
		};
	}
	return out;
}

function normalizeNotes(raw: unknown, title: string, warnings: string[]): ContinuityNote[] {
	if (!Array.isArray(raw)) return [];
	const out: ContinuityNote[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item["description"] !== "string") {
			warnings.push(`《${title}》有一条备注格式不对，已跳过`);
			continue;
		}
		const severity = item["severity"];
		const status = item["status"];
		out.push({
			id: typeof item["id"] === "string" && item["id"] ? item["id"] : newId(),
			severity: severity === "warning" || severity === "blocker" ? severity : "info",
			category: readString(item["category"]),
			subject: readString(item["subject"]),
			description: item["description"],
			status: status === "resolved" ? "resolved" : "open",
			createdAt: readTime(item["createdAt"]),
		});
	}
	return out;
}

function normalizeBodies(raw: unknown, title: string, warnings: string[]): Record<string, DraftBody> {
	const out: Record<string, DraftBody> = {};
	if (!isPlainObject(raw)) return out;
	let index = 0;
	for (const [chapterId, item] of Object.entries(raw)) {
		index += 1;
		if (!isPlainObject(item) || typeof item["content"] !== "string") {
			warnings.push(`《${title}》第 ${index} 章正文格式不对，已跳过`);
			continue;
		}
		const content = item["content"];
		if (content.length > NOVEL_PACKAGE_MAX_TEXT_CHARS) {
			throw new Error(
				`《${title}》第 ${index} 章正文太大了（${content.length} 字，上限 ${NOVEL_PACKAGE_MAX_TEXT_CHARS} 字），这个包可能损坏`,
			);
		}
		out[chapterId] = { content, history: normalizeHistory(item["history"], title, index, warnings) };
	}
	return out;
}

function normalizeHistory(raw: unknown, title: string, index: number, warnings: string[]): DraftRevision[] {
	if (!Array.isArray(raw)) return [];
	const out: DraftRevision[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item["content"] !== "string") {
			warnings.push(`《${title}》第 ${index} 章有一段历史版本格式不对，已跳过`);
			continue;
		}
		const content = item["content"];
		if (content.length > NOVEL_PACKAGE_MAX_TEXT_CHARS) {
			throw new Error(`《${title}》第 ${index} 章有一段历史版本太大了（${content.length} 字），这个包可能损坏`);
		}
		const revision = item["revision"];
		if (typeof revision === "number" && revision < 0) {
			warnings.push(`《${title}》第 ${index} 章有一段历史版本的版本号不对，已按 0 处理`);
		}
		out.push({
			revision: typeof revision === "number" && revision >= 0 ? Math.floor(revision) : 0,
			title: readString(item["title"]),
			content,
			materialIds: readStringArray(item["materialIds"]),
			updatedAt: readTime(item["updatedAt"]),
			mode: readString(item["mode"]) || "manual",
		});
	}
	return out;
}

function normalizeSnapshots(raw: unknown, title: string, warnings: string[]): NovelSnapshotPayload[] {
	if (!Array.isArray(raw)) return [];
	const out: NovelSnapshotPayload[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || !isPlainObject(item["project"])) {
			warnings.push(`《${title}》有一份快照格式不对，已跳过`);
			continue;
		}
		const snapTitle =
			typeof item["project"]["title"] === "string" && item["project"]["title"].trim()
				? (item["project"]["title"] as string)
				: title;
		const project = normalizeProjectEntry(
			{ project: item["project"], bodies: item["bodies"], snapshots: [] },
			warnings,
		);
		if (!project) {
			warnings.push(`《${title}》有一份快照格式不对，已跳过`);
			continue;
		}
		const snapshot: NovelSnapshotPayload = {
			name: readString(item["name"]),
			at: readTime(item["at"]),
			size: readCount(item["size"]),
			project: { ...project.project, title: snapTitle },
			bodies: project.bodies,
		};
		const label = item["label"];
		if (typeof label === "string" && label) snapshot.label = label;
		out.push(snapshot);
	}
	return out;
}

function normalizeLibraryMaterial(raw: unknown, warnings: string[]): LibraryMaterial | null {
	if (!isPlainObject(raw)) {
		warnings.push("素材库里有一条格式不对，已跳过");
		return null;
	}
	if (typeof raw["kind"] !== "string" || typeof raw["title"] !== "string") {
		warnings.push("素材库里有一条格式不对，已跳过");
		return null;
	}
	const content = typeof raw["content"] === "string" ? raw["content"] : "";
	if (content.length > NOVEL_PACKAGE_MAX_TEXT_CHARS) {
		throw new Error(`素材库里有一条太大了（${content.length} 字），这个包可能损坏`);
	}
	return {
		id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : newId(),
		kind: raw["kind"] as MaterialKind,
		title: raw["title"],
		content,
		tags: readStringArray(raw["tags"]),
		usage: readString(raw["usage"]),
		status: raw["status"] === "confirmed" ? "confirmed" : "draft",
		createdAt: readTime(raw["createdAt"]),
		updatedAt: readTime(raw["updatedAt"]),
	};
}

function normalizeCustomKind(raw: unknown, warnings: string[]): CustomKind | null {
	if (!isPlainObject(raw) || typeof raw["label"] !== "string" || !raw["label"].trim()) {
		warnings.push("有一个自建种类格式不对，已跳过");
		return null;
	}
	return {
		id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : newId(),
		label: raw["label"],
		createdAt: readTime(raw["createdAt"]),
	};
}

function normalizeRecord(raw: unknown, warnings: string[]): GenerationRecord | null {
	if (!isPlainObject(raw)) {
		warnings.push("有一条生成记录格式不对，已跳过");
		return null;
	}
	const role = raw["role"];
	if (role !== "material" && role !== "writing") {
		warnings.push("有一条生成记录格式不对，已跳过");
		return null;
	}
	if (typeof raw["projectId"] !== "string") {
		warnings.push("有一条生成记录格式不对，已跳过");
		return null;
	}
	const rawMessages = raw["messages"];
	if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
		warnings.push("有一条生成记录的消息格式不对，已跳过");
		return null;
	}
	const messages = Array.isArray(rawMessages) ? (rawMessages as GenerationRecord["messages"]) : [];
	for (const message of messages) {
		if (!isPlainObject(message) || typeof message["role"] !== "string") {
			warnings.push("有一条生成记录的消息格式不对，已跳过");
			return null;
		}
	}
	const record: GenerationRecord = {
		id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : newId(),
		role,
		projectId: raw["projectId"],
		title: readString(raw["title"]),
		preview: readString(raw["preview"]),
		createdAt: readTime(raw["createdAt"]),
		updatedAt: readTime(raw["updatedAt"]),
		messages,
	};
	const chapterId = raw["chapterId"];
	if (typeof chapterId === "string" && chapterId) record.chapterId = chapterId;
	if (raw["libraryScope"] === true) record.libraryScope = true;
	return record;
}

/* ------------------------------------------------------------------ *
 * 设置：剔密钥
 * ------------------------------------------------------------------ */

/**
 * 哪些键名算"密钥"。命中的一律剔除。
 * 注意别把 noAuthRequired 这种正常字段误伤（所以只列了确切的词，不含 auth 这种碎片）。
 */
const SECRET_KEY_PATTERN =
	/^(api[-_]?key|web[-_]?api[-_]?key|key|api[-_]?token|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|password|passwd|credential|credentials|authorization|private[-_]?key)$/i;

/** 思考档位。与 config/settings.ts 的 THINKING_LEVELS 一致（那边是运行时导出，这里抄一份字面量）。 */
const THINKING_LEVEL_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 递归扫掉所有像密钥的键（apiKey / token / credentials / ...）。 */
function stripSecrets(value: unknown, path: string, warnings: string[]): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) => stripSecrets(item, `${path}[${index}]`, warnings));
	}
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			warnings.push(`已剔除设置里的密钥字段「${path ? `${path}.` : ""}${key}」`);
			continue;
		}
		out[key] = stripSecrets(raw, path ? `${path}.${key}` : key, warnings);
	}
	return out;
}

function sanitizeApiFormat(
	raw: unknown,
	path: string,
	warnings: string[],
): ApiFormat | undefined {
	const value = readString(raw);
	if (!value) return undefined;
	if (
		value === "openai-completions" ||
		value === "openai-responses" ||
		value === "anthropic-messages" ||
		value === "google-generative-ai"
	) {
		return value;
	}
	warnings.push(`${path} 的接口格式「${value}」不认，已丢弃`);
	return undefined;
}

function sanitizeThinkingLevel(raw: unknown, path: string, warnings: string[]): Settings["defaultThinkingLevel"] {
	const value = readString(raw);
	if ((THINKING_LEVEL_NAMES as readonly string[]).includes(value)) {
		return value as Settings["defaultThinkingLevel"];
	}
	if (value) warnings.push(`${path} 的思考档位「${value}」不认，已按默认处理`);
	return "off";
}

/** baseUrl 可能被人塞了 ?api_key=xxx 这种参数，查询串和锚点一律去掉。 */
function sanitizeBaseUrl(raw: unknown, path: string, warnings: string[]): string | undefined {
	if (typeof raw !== "string") return undefined;
	const url = raw.trim();
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.search || parsed.hash) {
			warnings.push(`${path} 的 baseUrl 里带了查询参数或锚点（可能藏着密钥），已去掉`);
			return `${parsed.origin}${parsed.pathname}`;
		}
	} catch {
		// 不是标准 URL（自建服务可能只写主机名），原样保留
	}
	return url;
}

function sanitizeModel(
	raw: unknown,
	path: string,
	warnings: string[],
): Settings["providers"][number]["models"][number] | undefined {
	if (!isPlainObject(raw)) {
		warnings.push(`${path} 不是对象，已丢弃`);
		return undefined;
	}
	const id = readString(raw["id"]).trim();
	if (!id) {
		warnings.push(`${path} 缺少 id，已丢弃`);
		return undefined;
	}
	const thinkingLevels: Settings["providers"][number]["models"][number]["thinkingLevels"] = [];
	if (Array.isArray(raw["thinkingLevels"])) {
		for (const level of raw["thinkingLevels"]) {
			const value = readString(level);
			if ((THINKING_LEVEL_NAMES as readonly string[]).includes(value)) {
				thinkingLevels.push(value as Settings["providers"][number]["models"][number]["thinkingLevels"][number]);
			} else warnings.push(`${path} 的思考档位「${value}」不认，已丢弃`);
		}
	}
	const cost = isPlainObject(raw["cost"]) ? raw["cost"] : {};
	return {
		id,
		name: readString(raw["name"]) || id,
		contextWindow: Math.max(0, Math.floor(readCount(raw["contextWindow"]))),
		maxTokens: Math.max(0, Math.floor(readCount(raw["maxTokens"]))),
		reasoning: raw["reasoning"] === true,
		thinkingLevels,
		cost: {
			input: readCount(cost["input"]),
			output: readCount(cost["output"]),
			cacheRead: readCount(cost["cacheRead"]),
			cacheWrite: readCount(cost["cacheWrite"]),
		},
	};
}

function sanitizeProvider(
	raw: unknown,
	path: string,
	warnings: string[],
): Settings["providers"][number] | undefined {
	if (!isPlainObject(raw)) {
		warnings.push(`${path} 不是对象，已丢弃`);
		return undefined;
	}
	const id = readString(raw["id"]).trim();
	if (!id) {
		warnings.push(`${path} 缺少 id，已丢弃`);
		return undefined;
	}
	const models: Settings["providers"][number]["models"] = [];
	if (Array.isArray(raw["models"])) {
		raw["models"].forEach((item, index) => {
			const model = sanitizeModel(item, `${path}.models[${index}]`, warnings);
			if (model) models.push(model);
		});
	} else if (raw["models"] !== undefined) {
		warnings.push(`${path} 的 models 不是数组，已忽略`);
	}
	const provider: Settings["providers"][number] = {
		id,
		label: readString(raw["label"]) || id,
		kind: raw["kind"] === "custom" ? "custom" : "builtin",
		models,
		enabled: raw["enabled"] === true,
		updatedAt: readTime(raw["updatedAt"]),
	};
	const builtinId = readString(raw["builtinId"]).trim();
	if (builtinId) provider.builtinId = builtinId;
	const baseUrl = sanitizeBaseUrl(raw["baseUrl"], path, warnings);
	if (baseUrl) provider.baseUrl = baseUrl;
	const api = sanitizeApiFormat(raw["api"], path, warnings);
	if (api) provider.api = api;
	if (raw["noAuthRequired"] === true) provider.noAuthRequired = true;
	return provider;
}

function sanitizeWebSearch(raw: unknown): Settings["webSearch"] {
	if (!isPlainObject(raw)) return { enabled: false, maxResults: 5, includeContent: false };
	return {
		enabled: raw["enabled"] === true,
		maxResults: Math.min(10, Math.max(1, Math.floor(readCount(raw["maxResults"]) || 5))),
		includeContent: raw["includeContent"] === true,
	};
}

/**
 * 把设置修成能用的形状，并保证里面**没有任何密钥**。
 *
 * 两道关：
 *   1. stripSecrets：凡是像密钥的键（apiKey / token / credentials / ...）全删；
 *   2. 白名单重建：只保留 Settings/ProviderConfig/ModelConfig 认识的字段。
 */
export function sanitizeNovelSettings(raw: unknown, warnings: string[]): Settings | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isPlainObject(raw)) {
		warnings.push("设置不是对象，已忽略");
		return undefined;
	}
	const stripped = stripSecrets(raw, "", warnings) as Record<string, unknown>;
	const providers: Settings["providers"] = [];
	if (Array.isArray(stripped["providers"])) {
		stripped["providers"].forEach((item, index) => {
			const provider = sanitizeProvider(item, `providers[${index}]`, warnings);
			if (provider) providers.push(provider);
		});
	} else if (stripped["providers"] !== undefined) {
		warnings.push("设置里的 providers 不是数组，已忽略");
	}
	return {
		version: 1,
		defaultModel: readString(stripped["defaultModel"]),
		defaultThinkingLevel: sanitizeThinkingLevel(stripped["defaultThinkingLevel"], "设置", warnings),
		webSearch: sanitizeWebSearch(stripped["webSearch"]),
		providers,
	};
}

/* ------------------------------------------------------------------ *
 * 加密
 * ------------------------------------------------------------------ */

/** 加密 payload。口令不落日志，密钥不落日志，明文不落日志。 */
async function encryptPayload(payload: NovelPayload, passphrase: string): Promise<NovelEncryptedPayload> {
	const subtle = requireSubtle();
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = await deriveKey(subtle, passphrase, salt, NOVEL_PACKAGE_PBKDF2_ITERATIONS);
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const cipher = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
	return {
		kdf: NOVEL_PACKAGE_KDF,
		iterations: NOVEL_PACKAGE_PBKDF2_ITERATIONS,
		salt: bytesToBase64(salt),
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(cipher)),
	};
}

/** 解密 payload。口令不对只说一句人话，不把 WebCrypto 的错误抖出来。 */
async function decryptPayload(envelope: NovelEncryptedPayload, passphrase: string): Promise<unknown> {
	const subtle = requireSubtle();
	let salt: Uint8Array;
	let iv: Uint8Array;
	let cipher: Uint8Array;
	try {
		salt = base64ToBytes(envelope.salt);
		iv = base64ToBytes(envelope.iv);
		cipher = base64ToBytes(envelope.ciphertext);
	} catch {
		throw new Error("口令不对或包已损坏");
	}
	if (salt.length !== 16 || iv.length !== 12) throw new Error("口令不对或包已损坏");
	const iterations = envelope.iterations;
	if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) {
		throw new Error("口令不对或包已损坏");
	}
	const key = await deriveKey(subtle, passphrase, salt, iterations);
	let plain: ArrayBuffer;
	try {
		plain = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
	} catch {
		throw new Error("口令不对或包已损坏");
	}
	try {
		return JSON.parse(new TextDecoder().decode(plain)) as unknown;
	} catch {
		throw new Error("口令不对或包已损坏");
	}
}

/** PBKDF2 派生 AES-GCM 密钥。 */
async function deriveKey(
	subtle: SubtleLike,
	passphrase: string,
	salt: Uint8Array,
	iterations: number,
): Promise<unknown> {
	const material = new TextEncoder().encode(passphrase);
	const kdfKey = await subtle.importKey(
		"raw",
		material,
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		false,
		["deriveBits"],
	);
	const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, kdfKey, 256);
	return subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 密文信封长不长那样。 */
function isEncryptedPayload(value: unknown): value is NovelEncryptedPayload {
	if (!isPlainObject(value)) return false;
	return (
		value["kdf"] === NOVEL_PACKAGE_KDF &&
		typeof value["iterations"] === "number" &&
		typeof value["salt"] === "string" &&
		typeof value["iv"] === "string" &&
		typeof value["ciphertext"] === "string"
	);
}

/* ------------------------------------------------------------------ *
 * 平台能力的最小声明
 *
 * 这里不写 DOM 类型，也不写 Node 类型 —— 只声明"用到的那些方法"，
 * 再从 globalThis 上取。浏览器与 Node 都有这些全局对象，
 * 少了就报一句人话（见 requireSubtle / gzipBytes）。
 * ------------------------------------------------------------------ */

interface SubtleLike {
	importKey(
		format: "raw",
		keyData: ArrayBuffer | ArrayBufferView,
		algorithm: { name: string; hash?: string; salt?: ArrayBuffer | ArrayBufferView; iterations?: number },
		extractable: boolean,
		keyUsages: string[],
	): Promise<unknown>;
	deriveBits(
		algorithm: { name: string; hash?: string; salt?: ArrayBuffer | ArrayBufferView; iterations?: number },
		baseKey: unknown,
		length: number,
	): Promise<ArrayBuffer>;
	encrypt(
		algorithm: { name: string; iv: ArrayBuffer | ArrayBufferView },
		key: unknown,
		data: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
	decrypt(
		algorithm: { name: string; iv: ArrayBuffer | ArrayBufferView },
		key: unknown,
		data: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
}

interface CryptoLike {
	getRandomValues<T extends ArrayBufferView>(array: T): T;
	subtle?: SubtleLike;
}

interface ByteReaderLike {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

interface ByteWriterLike {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface ByteTransformLike {
	readonly readable: { getReader(): ByteReaderLike };
	readonly writable: { getWriter(): ByteWriterLike };
}

type ByteTransformCtor = new (format: string) => ByteTransformLike;

/** 拿 WebCrypto。安全上下文以外没有它 —— 这时报一句人话。 */
function requireSubtle(): SubtleLike {
	const scope = globalThis as unknown as { crypto?: CryptoLike };
	const subtle = scope.crypto?.subtle;
	if (!subtle) {
		throw new Error("当前环境不支持加密：请用 https 或 localhost 打开本应用（浏览器只在安全上下文里提供 WebCrypto）");
	}
	return subtle;
}

/** 随机字节。 */
function randomBytes(length: number): Uint8Array {
	const scope = globalThis as unknown as { crypto?: CryptoLike };
	const bytes = new Uint8Array(length);
	const source = scope.crypto;
	if (source && typeof source.getRandomValues === "function") {
		source.getRandomValues(bytes);
		return bytes;
	}
	for (let index = 0; index < length; index++) bytes[index] = Math.floor(Math.random() * 256);
	return bytes;
}

/* ------------------------------------------------------------------ *
 * gzip
 * ------------------------------------------------------------------ */

/** 压成 gzip。 */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
	const Ctor = (globalThis as unknown as { CompressionStream?: ByteTransformCtor }).CompressionStream;
	if (!Ctor) {
		throw new Error("当前环境不支持压缩：请换用支持 CompressionStream 的浏览器或 Node 18+");
	}
	return runTransform(new Ctor("gzip"), data);
}

/** 解 gzip。 */
async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
	const Ctor = (globalThis as unknown as { DecompressionStream?: ByteTransformCtor }).DecompressionStream;
	if (!Ctor) {
		throw new Error("当前环境不支持压缩：请换用支持 DecompressionStream 的浏览器或 Node 18+");
	}
	try {
		return await runTransform(new Ctor("gzip"), data);
	} catch {
		throw new Error("这个文件不是有效的 .novel 包（gzip 解不开）");
	}
}

/** 走一遍压缩流。 */
async function runTransform(stream: ByteTransformLike, data: Uint8Array): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	const written = writer.write(data).then(() => writer.close());
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	await written;
	return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * base64（不引依赖，也不依赖 btoa/atob 的 latin1 限制）
 * ------------------------------------------------------------------ */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
	let out = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] as number;
		const second = index + 1 < bytes.length ? (bytes[index + 1] as number) : undefined;
		const third = index + 2 < bytes.length ? (bytes[index + 2] as number) : undefined;
		out += BASE64_ALPHABET.charAt(first >> 2);
		out += BASE64_ALPHABET.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4));
		out += second === undefined ? "=" : BASE64_ALPHABET.charAt(((second & 0x0f) << 2) | ((third ?? 0) >> 6));
		out += third === undefined ? "=" : BASE64_ALPHABET.charAt(third & 0x3f);
	}
	return out;
}

function base64ToBytes(text: string): Uint8Array {
	const clean = text.replace(/\s+/g, "");
	if (clean.length === 0) return new Uint8Array(0);
	if (clean.length % 4 !== 0) throw new Error("base64 长度不对");
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	const out = new Uint8Array((clean.length * 3) / 4 - padding);
	let offset = 0;
	for (let index = 0; index < clean.length; index += 4) {
		const first = base64Value(clean.charAt(index));
		const second = base64Value(clean.charAt(index + 1));
		const thirdChar = clean.charAt(index + 2);
		const fourthChar = clean.charAt(index + 3);
		const third = thirdChar === "=" ? 0 : base64Value(thirdChar);
		const fourth = fourthChar === "=" ? 0 : base64Value(fourthChar);
		out[offset++] = ((first << 2) | (second >> 4)) & 0xff;
		if (thirdChar !== "=") out[offset++] = ((second << 4) | (third >> 2)) & 0xff;
		if (fourthChar !== "=") out[offset++] = ((third << 6) | fourth) & 0xff;
	}
	return out;
}

function base64Value(char: string): number {
	const index = BASE64_ALPHABET.indexOf(char);
	if (index < 0) throw new Error("base64 里有个不认识的字符");
	return index;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function readTime(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function cloneBodies(bodies: Record<string, DraftBody>): Record<string, DraftBody> {
	const out: Record<string, DraftBody> = {};
	for (const [chapterId, body] of Object.entries(bodies)) {
		out[chapterId] = {
			content: body.content,
			history: (body.history ?? []).map((item) => cloneJson(item)),
		};
	}
	return out;
}

/** 素材指纹：同样的东西不导两遍。 */
function fingerprintLibrary(material: LibraryMaterial): string {
	return JSON.stringify([material.kind, material.title, material.content, material.tags, material.usage, material.status]);
}

/** 记录指纹：同一面板里内容一样的不导两遍。 */
function fingerprintRecord(record: GenerationRecord): string {
	return JSON.stringify([
		record.role,
		record.projectId,
		record.chapterId ?? "",
		record.libraryScope === true,
		record.title,
		record.messages,
	]);
}

/**
 * 从快照文件名里把作者自己起的标签取出来。
 *
 * 文件名是 "<时间戳>-<编码后的标签>.json.gz"，标签里的非字母数字字符被转义成
 * "_4e2d_" 这样的形式，末尾还带一段短哈希（project.ts 的 encodeFileName）。
 * 哈希去不掉，但标签本身能还原 —— 还原不出来就用文件名顶替。
 */
export function decodeSnapshotLabel(name: string): string {
	const base = name.replace(/\.(json\.gz|gz|json)$/i, "");
	const withoutStamp = base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "");
	const cut = withoutStamp.lastIndexOf("_");
	if (cut <= 0) return "";
	const encoded = withoutStamp.slice(0, cut);
	return encoded.replace(/_([0-9a-f]{1,6})_/g, (all, hex: string) => {
		const code = Number.parseInt(hex, 16);
		return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
	});
}

/* ==================================================================== *
 * 兼容层
 *
 * 下面这组是"摊平的旧容器"接口，给 src/store/novel-crypto.ts 用：
 * 它加密的是旧容器（format/version/createdAt + 各段数据）的 JSON。
 * 新代码一律用上面的 exportNovel / importNovel。
 * ==================================================================== */

/** 旧容器的判别符（与新信封的 magic 同一个值）。 */
export const NOVEL_PACKAGE_FORMAT = NOVEL_PACKAGE_MAGIC;
/** 旧容器的版本号。 */
export const NOVEL_PACKAGE_VERSION = NOVEL_PACKAGE_FORMAT_VERSION;
/** 快照上限。与磁盘版 project-disk.ts 的私有常量保持一致。 */
export const MAX_SNAPSHOTS = 20;
/** 历史版本上限。与 project.ts 的 MAX_DRAFT_HISTORY 一致。 */
const MAX_HISTORY = 10;

/** 旧容器里的生成记录。 */
export type NovelRecord = GenerationRecord;
/** 旧容器里的一份快照。 */
export type NovelSnapshot = NovelSnapshotPayload;
/** 旧容器里的一个作品。 */
export type NovelPackageProject = NovelProjectPayload;

/** 旧容器里的一条作品（导出时的输入形状）。 */
export interface NovelProjectEntry {
	project: Project;
	bodies: Record<string, DraftBody>;
	/** 正文与历史分开摆时的历史（会并进 bodies）。 */
	history?: Record<string, DraftRevision[]>;
	snapshots?: NovelSnapshotPayload[];
}

/** 旧容器。 */
export interface NovelPackage {
	format: typeof NOVEL_PACKAGE_FORMAT;
	version: number;
	createdAt: string;
	projects: NovelPackageProject[];
	library: LibraryMaterial[];
	kinds: CustomKind[];
	records: NovelRecord[];
	settings?: Settings;
	warnings: string[];
}

/** 造旧容器的输入。 */
export interface NovelPackageInput {
	projects?: NovelProjectEntry[];
	library?: LibraryMaterial[];
	kinds?: CustomKind[];
	records?: NovelRecord[];
	settings?: Settings | Record<string, unknown>;
	createdAt?: string;
}

/** 包相关的错误码。 */
export type NovelPackageErrorCode = "bad-json" | "bad-shape" | "bad-format" | "bad-version" | "missing-field";

/** 解析/导入 `.novel` 包时的错误。消息一律中文，直接给用户看。 */
export class NovelPackageError extends Error {
	readonly code: NovelPackageErrorCode;

	constructor(code: NovelPackageErrorCode, message: string) {
		super(message);
		this.name = "NovelPackageError";
		this.code = code;
	}
}

/**
 * 归一化：把外来对象（手改过的、别的版本导出的）修成合法的旧容器。
 * 能修的就修，修不了的丢掉，并在 warnings 里说清楚丢的是什么（中文）。
 */
export function normalizeNovelPackage(raw: unknown): NovelPackage {
	if (!isPlainObject(raw)) {
		throw new NovelPackageError("bad-shape", `包内容不是一个 JSON 对象（实际是 ${describeValue(raw)}），不是 .novel 包。`);
	}
	const input = raw as Record<string, unknown>;
	const warnings: string[] = [];

	const format = readString(input["format"]);
	if (format && format !== NOVEL_PACKAGE_FORMAT) {
		throw new NovelPackageError("bad-format", `这不是 .novel 包：format 是「${format}」，应为「${NOVEL_PACKAGE_FORMAT}」。`);
	}

	const rawVersion = input["version"];
	let version = NOVEL_PACKAGE_VERSION;
	if (typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1) {
		version = rawVersion;
	}
	if (version > NOVEL_PACKAGE_VERSION) {
		throw new NovelPackageError(
			"bad-version",
			`这个包的版本是 ${version}，比本程序支持的版本 ${NOVEL_PACKAGE_VERSION} 新。请先升级程序再导入。`,
		);
	}

	const known = new Set(["format", "version", "createdAt", "projects", "library", "kinds", "records", "settings"]);
	for (const key of Object.keys(input)) {
		if (!known.has(key)) warnings.push(`包顶层的「${key}」不认，已丢弃`);
	}

	const sections = normalizeSections(input, warnings);
	const rawCreatedAt = readString(input["createdAt"]).trim();
	let createdAt = rawCreatedAt;
	if (!rawCreatedAt) {
		createdAt = new Date().toISOString();
	} else if (Number.isNaN(Date.parse(rawCreatedAt))) {
		warnings.push("包的 createdAt 不是合法时间，已换成当前时间");
		createdAt = new Date().toISOString();
	}

	return {
		format: NOVEL_PACKAGE_FORMAT,
		version,
		createdAt,
		projects: sections.projects,
		library: sections.library,
		kinds: sections.kinds,
		records: sections.records,
		...(sections.settings ? { settings: sections.settings } : {}),
		warnings,
	};
}

/** 造一个旧容器。走的是和归一化同一条路，所以造出来的容器一定是干净的。 */
export function buildNovelPackage(input: NovelPackageInput): NovelPackage {
	return normalizeNovelPackage({
		format: NOVEL_PACKAGE_FORMAT,
		version: NOVEL_PACKAGE_VERSION,
		createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
		projects: input.projects ?? [],
		library: input.library ?? [],
		kinds: input.kinds ?? [],
		records: input.records ?? [],
		settings: input.settings,
	});
}

/** 序列化成 JSON 字符串。键按字典序排，所以同样的内容导出两次字节完全一样。 */
export function serializeNovelPackage(pkg: NovelPackage, options?: { pretty?: boolean }): string {
	return stableStringify(pkg, options?.pretty === true);
}

/** 解析 `.novel` 包文件的内容。出错一律抛 NovelPackageError（消息是中文）。 */
export function parseNovelPackage(text: string): NovelPackage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new NovelPackageError("bad-json", "这不是合法的 JSON 文件，没法当作 .novel 包导入。");
	}
	if (!isPlainObject(parsed)) {
		throw new NovelPackageError("bad-shape", `包内容不是一个 JSON 对象（实际是 ${describeValue(parsed)}），不是 .novel 包。`);
	}
	const input = parsed as Record<string, unknown>;
	if (input["format"] === undefined) {
		throw new NovelPackageError("missing-field", "包缺少 format 字段，不是完整的 .novel 包。");
	}
	if (readString(input["format"]) !== NOVEL_PACKAGE_FORMAT) {
		throw new NovelPackageError(
			"bad-format",
			`这不是 .novel 包：format 是「${readString(input["format"])}」，应为「${NOVEL_PACKAGE_FORMAT}」。`,
		);
	}
	if (input["version"] === undefined) {
		throw new NovelPackageError("missing-field", "包缺少 version 字段，不是完整的 .novel 包。");
	}
	if (typeof input["version"] !== "number" || !Number.isInteger(input["version"]) || (input["version"] as number) < 1) {
		throw new NovelPackageError("bad-version", `包版本号不对：${describeValue(input["version"])}，应该是正整数。`);
	}
	if ((input["version"] as number) > NOVEL_PACKAGE_VERSION) {
		throw new NovelPackageError(
			"bad-version",
			`这个包的版本是 ${input["version"]}，比本程序支持的版本 ${NOVEL_PACKAGE_VERSION} 新。请先升级程序再导入。`,
		);
	}
	if (input["projects"] === undefined) {
		throw new NovelPackageError("missing-field", "包内缺少 projects（作品列表），不是完整的 .novel 包。");
	}
	if (!Array.isArray(input["projects"])) {
		throw new NovelPackageError("bad-shape", "包内的 projects 不是数组，不是完整的 .novel 包。");
	}
	return normalizeNovelPackage(parsed);
}

/** 旧容器里的所有作品。 */
export function packageProjects(pkg: NovelPackage): NovelPackageProject[] {
	return pkg.projects ?? [];
}

/** 按 id 找一个作品。 */
export function packageProject(pkg: NovelPackage, projectId: string): NovelPackageProject | undefined {
	return (pkg.projects ?? []).find((entry) => entry.project.id === projectId);
}

/** 某个作品的正文表（当前内容 + 历史）。 */
export function packageBodies(pkg: NovelPackage, projectId: string): Record<string, DraftBody> {
	return packageProject(pkg, projectId)?.bodies ?? {};
}

/** 某个作品每章的历史版本。 */
export function packageHistory(pkg: NovelPackage, projectId: string): Record<string, DraftRevision[]> {
	const out: Record<string, DraftRevision[]> = {};
	for (const [chapterId, body] of Object.entries(packageBodies(pkg, projectId))) {
		out[chapterId] = body.history ?? [];
	}
	return out;
}

/** 某个作品的快照（从旧到新）。 */
export function packageSnapshots(pkg: NovelPackage, projectId: string): NovelSnapshotPayload[] {
	return packageProject(pkg, projectId)?.snapshots ?? [];
}

/** 包里的素材库。 */
export function packageLibrary(pkg: NovelPackage): LibraryMaterial[] {
	return pkg.library ?? [];
}

/** 包里的自定义素材类型。 */
export function packageKinds(pkg: NovelPackage): CustomKind[] {
	return pkg.kinds ?? [];
}

/** 包里的生成记录。 */
export function packageRecords(pkg: NovelPackage): NovelRecord[] {
	return pkg.records ?? [];
}

/** 包里的应用设置（已剔除密钥）。 */
export function packageSettings(pkg: NovelPackage): Settings | undefined {
	return pkg.settings;
}

/** 给用户看的"这是个什么东西"。 */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "数组";
	return typeof value;
}

/** 键按字典序排的 JSON.stringify。同样的数据 → 同样的字节。 */
function stableStringify(value: unknown, pretty: boolean, indent = ""): string {
	if (value === null || value === undefined) return "null";
	const type = typeof value;
	if (type === "string") return JSON.stringify(value);
	if (type === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
	if (type === "boolean") return value ? "true" : "false";
	if (type === "bigint") return JSON.stringify((value as bigint).toString());
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const pad = indent + "  ";
		const items = value.map((item) => stableStringify(item, pretty, pad));
		if (!pretty) return `[${items.join(",")}]`;
		return `[\n${pad}${items.join(`,\n${pad}`)}\n${indent}]`;
	}
	if (type === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj)
			.filter((key) => obj[key] !== undefined)
			.sort();
		if (keys.length === 0) return "{}";
		const pad = indent + "  ";
		const parts = keys.map(
			(key) => `${JSON.stringify(key)}:${pretty ? " " : ""}${stableStringify(obj[key], pretty, pad)}`,
		);
		if (!pretty) return `{${parts.join(",")}}`;
		return `{\n${pad}${parts.join(`,\n${pad}`)}\n${indent}]`;
	}
	return "null";
}
