/**
 * 小说工程的纯模型层：类型、归一化、派生计算。
 *
 * 这一层不碰文件系统，因此可以原样搬到浏览器里 ——
 * 浏览器端的 IndexedDB 版存储（IdbProjectStore）只需要实现同一套接口。
 * 磁盘实现见 project-disk.ts；两侧共用这里定义的数据形状与纯函数。
 */

export type ChapterStatus = "planned" | "outlined" | "drafting" | "drafted" | "revising" | "done";
export type NoteSeverity = "info" | "warning" | "blocker";
export type NoteStatus = "open" | "resolved";
/** 素材来源：书者手写 / 墨客所拟 / 取自通用素材库。 */
export type MaterialSource = "human" | "agent" | "library";
export type MaterialStatus = "draft" | "confirmed";

/**
 * 生成一个唯一 id。
 *
 * 用 Web Crypto 而不是 node:crypto：这一层要能在浏览器里原样跑起来，
 * 而浏览器端（IndexedDB 存储与浏览器内的智能体）也要靠它造 id。
 *
 * crypto.randomUUID() 只在安全上下文可用 —— 通过纯 HTTP 部署的站点上它是
 * undefined，所以还得留一条 getRandomValues 的退路。
 */
export function newId(): string {
	const source = globalThis.crypto;
	if (source && typeof source.randomUUID === "function") return source.randomUUID();
	const bytes = new Uint8Array(16);
	if (source && typeof source.getRandomValues === "function") {
		source.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	// 摆成 UUIDv4 的形状：版本位 4，变体位 10。
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < bytes.length; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	);
}

/**
 * 每章保留的历史版本数上限。
 *
 * 正文动辄数万字，全量留档会让工程文件迅速膨胀到不可接受；
 * 但一份都不留不行 —— 覆盖写是这套流程里唯一会销毁内容的动作，必须留退路。
 */
export const MAX_DRAFT_HISTORY = 10;

export interface DeletedProject {
	id: string;
	title: string;
	deletedAt: number;
}

/**
 * 编码后的文件名主体上限（含短哈希后缀，不含 .json）。
 *
 * Windows 单个文件名上限 255 字节，而章节 id 由模型生成、可能是几百字的中文：
 * 每个非 ASCII 字符会转义成 "_4e2d_" 这样的 6 个 ASCII 字符，不截断必然撞上限，
 * 落盘就成了永久的 EPERM。截断到 120 字符再拼短哈希：可读前缀够用，
 * 短哈希保证两个共享前缀的长 id 仍映射到不同文件。
 */
const MAX_ENCODED_NAME = 120;

/**
 * 把章节 id 编码成安全的文件名。
 *
 * 章节 id 由模型生成，可能是任意字符串；Windows 上 \ / : * ? " < > | 都非法，
 * 且结尾的点会被系统悄悄吃掉。这里只保留字母数字与连字符，其余转义后可逆。
 * 超过长度上限时截断，并始终附带短哈希，避免长 id 之间撞名。
 */
export function encodeFileName(raw: string): string {
	const suffix = "_" + shortHash(raw);
	const encoded = raw.replace(/[^\w-]/g, (ch) => "_" + ch.codePointAt(0)!.toString(16) + "_");
	const room = MAX_ENCODED_NAME - suffix.length;
	return (encoded.length > room ? encoded.slice(0, room) : encoded) + suffix;
}

/** 短哈希，用于保证编码后仍能唯一对应原 id。 */
function shortHash(raw: string): string {
	let h = 5381;
	for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/**
 * 主文件只留骨架：卷、大纲、素材、备注，以及各章的元数据。
 *
 * 正文与历史在 data/drafts/<projectId>/ 下按章单独存，
 * 骨架里一个字的正文都不留 —— 这是"千万字也不卡"的第一道门。
 */
/**
 * 素材种类。
 *
 * 内置的十三个是"笔法"上的基本盘，但作者可以自己添（见 kindOptions）——
 * 添之前先问一句：已有的种类里，换一个 title 和 tags 能不能装下？
 */
export const MATERIAL_KINDS = [
	"premise",
	"character",
	"world",
	"location",
	"plot",
	"beat",
	"scene",
	"dialogue",
	"imagery",
	"foreshadow",
	"style",
	"research",
	"other",
] as const;
export type BuiltinMaterialKind = (typeof MATERIAL_KINDS)[number];
/**
 * 素材种类：内置那十三种，外加作者自建的。
 *
 * 自建种的 id 就是作者起的那个名字（限 ASCII 字母数字与中文），
 * 所以这一型是开放的 —— 用 (string & {}) 保住内置种名的字面量补全，
 * 又不至于把作者自建的种类挡在门外。
 */
export type MaterialKind = BuiltinMaterialKind | (string & {});

export const MATERIAL_KIND_LABELS: Record<BuiltinMaterialKind, string> = {
	premise: "核心设定",
	character: "人物",
	world: "世界观",
	location: "场景地点",
	plot: "情节线",
	beat: "桥段",
	scene: "场景卡",
	dialogue: "对话",
	imagery: "意象",
	foreshadow: "伏笔",
	style: "文风",
	research: "考据",
	other: "其他",
};

/** 作者自建的种类：id → 显示名。服务端启动时从 data/kinds.json 登记。 */
const customKindLabels = new Map<string, string>();

/** 种类目录里的一项。 */
export interface KindOption {
	kind: string;
	label: string;
	builtin: boolean;
}

/**
 * 登记作者自建的种类。
 *
 * 放在 store/project 里是因为这里已经住着 MaterialKind 这个型：
 * 种类认不认、叫什么、怎么分组，都在同一个地方说了算，
 * 免得各处各认一套，最后智能体认的种类和界面认的不一样。
 */
export function registerCustomKinds(list: readonly { id: string; label: string }[]): void {
	customKindLabels.clear();
	for (const item of list) {
		const id = typeof item?.id === "string" ? item.id.trim() : "";
		const label = typeof item?.label === "string" ? item.label.trim() : "";
		if (!id || !label) continue;
		customKindLabels.set(id, label);
	}
}

/** 种类目录：内置在前，自定义在后。界面、智能体提示词、工具 schema 都用它。 */
export function kindOptions(): KindOption[] {
	const out: KindOption[] = MATERIAL_KINDS.map((kind) => ({
		kind,
		label: MATERIAL_KIND_LABELS[kind],
		builtin: true,
	}));
	for (const [kind, label] of customKindLabels) out.push({ kind, label, builtin: false });
	return out;
}

/** 任意种类的显示名：内置 → 自定义 → 原样（认不出来的种类至少还能看）。 */
export function kindLabel(kind: string): string {
	return MATERIAL_KIND_LABELS[kind as BuiltinMaterialKind] ?? customKindLabels.get(kind) ?? kind;
}

/** 这个种类认不认。写入时用它把关，读取时用它兜底。 */
export function isKnownKind(kind: string): boolean {
	return MATERIAL_KINDS.includes(kind as BuiltinMaterialKind) || customKindLabels.has(kind);
}

/**
 * 素材：可复用的创作单位。
 *
 * 素材不是正文。它描述"这个世界是什么样、这场戏要发生什么、这个人说话什么调"，
 * 正文是拿素材组装出来的产物。所以素材要自包含，脱离任何具体章节也能读懂。
 */
export interface Material {
	id: string;
	kind: MaterialKind;
	title: string;
	content: string;
	tags: string[];
	/**
	 * 装配提示：什么情况下该把这条素材拿出来用。
	 * 组装智能体靠这句话判断相关性，不写就等于素材藏在库里没人用。
	 */
	usage: string;
	status: MaterialStatus;
	/** 显式装配到哪些章节。写作时这些章节会拿到本文全文。 */
	chapterIds: string[];
	source: MaterialSource;
	/**
	 * 取自素材库时的来源条目 id。
	 * 有它才能回溯"这条料是从库里哪一条来的"，也才能把作品里的改动推回库里。
	 */
	originId?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * 卷：一卷书。
 *
 * 卷只管分组与"这一卷大致写什么"，不存正文 —— 正文按章存在 drafts 里。
 * 章挂不挂卷是自由的：volumeId 为空串就是"不分卷"，
 * 于是老工程、短篇、以及只想先写着再分的作者都不必被卷挡住。
 */
export interface Volume {
	id: string;
	title: string;
	/** 卷要略：这一卷大致写什么。与章的要略一样，是开写前定的，不是写完之后的小结。 */
	summary: string;
	/** 卷目标字数，0 表示没定。 */
	targetWords: number;
	notes: string;
}

export interface OutlineChapter {
	id: string;
	title: string;
	summary: string;
	pov: string;
	/** 所属卷。空串 = 不分卷；指向已删的卷时归一化会清成空串，章不会因此消失。 */
	volumeId: string;
	status: ChapterStatus;
	targetWords: number;
	notes: string;
	/** 本章装配清单。写作智能体会拿到这些素材的全文。 */
	materialIds: string[];
}

export interface DraftRevision {
	revision: number;
	title: string;
	content: string;
	/** 这一版当时装配的素材，用于回溯"这稿是从什么料写出来的"。 */
	materialIds: string[];
	updatedAt: number;
	/** 触发这次写入的作业类型，create 没有前序故为 create。 */
	mode: string;
}

/**
 * 一章的元数据：骨架里存的就是它。
 *
 * 正文不进骨架 —— 骨架是每次都要读进读出的东西，一部千万字的书若把正文也挂在
 * 骨架上，光是刷新一次页面就得搬动几十兆。骨架只留"这章写过没有、多少字、
 * 第几稿、装配了哪些料"，正文与历史按需从磁盘单独取。
 */
export interface ChapterMeta {
	id: string;
	title: string;
	/** 这一章实际写了什么的小结（与大纲的 summary 要略不是一回事）。 */
	summary: string;
	/** 这一章正文的字数，存稿时算好，统计时直接加。 */
	words: number;
	revision: number;
	updatedAt: number;
	/** 写作时装配了哪些素材，用于回溯"这段正文是从什么料写出来的"。 */
	materialIds: string[];
	/** 有没有正文。草稿文件在磁盘上但正文是空的，仍算写过。 */
	hasDraft: boolean;
}

/** 一章的正文与历史版本，按需从磁盘取。 */
export interface DraftBody {
	content: string;
	history: DraftRevision[];
}

/**
 * 章节正文的完整形态（含正文与历史）。
 *
 * 磁盘上不再以这个形状存（拆成 .meta.json / .txt / .hist/），
 * 但工具与提示词之间传的就是它：写作上下文要的是"上一章正文 + 小结"。
 */
export interface ChapterDraft {
	id: string;
	title: string;
	content: string;
	/**
	 * 这一章**实际写了什么**的小结，2-4 句。
	 *
	 * 与大纲的 summary（要略）不是一回事，别混：
	 * 要略是开写前定下的"打算写什么"，这里是写完之后交上来的"实际写了什么"——
	 * 谁做了什么、留下了什么钩子、哪些事没写完。
	 * 下一章靠它接续，所以既不是正文的复述，也不是要略的复述。
	 *
	 * 老工程没有这个字段，缺省空串：读得开，只是接续时拿不到上一章小结。
	 */
	summary: string;
	revision: number;
	updatedAt: number;
	/** 写作时装配了哪些素材，用于回溯"这段正文是从什么料来的"。 */
	materialIds: string[];
	/**
	 * 历史版本。只在覆盖旧稿时追加，且限量。
	 *
	 * 早先 revision 只是自增计数器，旧稿被整段覆盖后无处可寻 ——
	 * 模型在看不见原文的情况下执行覆盖，出错就是静默截断且不可恢复。
	 * 存最近若干版，够回退又不至于让工程文件无限膨胀。
	 */
	history: DraftRevision[];
}

export interface ContinuityNote {
	id: string;
	severity: NoteSeverity;
	category: string;
	subject: string;
	description: string;
	status: NoteStatus;
	createdAt: number;
}

export interface Project {
	id: string;
	title: string;
	genre: string;
	logline: string;
	synopsis: string;
	styleGuide: string;
	targetWords: number;
	/** 全部素材。人物、世界观、场景、桥段都在这里，靠 kind 区分。 */
	materials: Material[];
	/**
	 * 卷序。数组顺序就是卷的先后，章按 outline 里的顺序落在各自的卷下；
	 * 卷头在章目里只在"换卷的地方"出现，所以卷序实际上由章的先后决定，
	 * 这个数组只定"新建卷时的默认位置"与卷自己的元数据。
	 */
	volumes: Volume[];
	outline: OutlineChapter[];
	/** 各章的元数据。正文不在这里，按需从 drafts/<projectId>/ 取。 */
	drafts: Record<string, ChapterMeta>;
	notes: ContinuityNote[];
	createdAt: number;
	updatedAt: number;
}

/** 章的状态档。界面、接口、智能体工具共用这一份，免得各处各认一套。 */
export const CHAPTER_STATUSES: readonly ChapterStatus[] = ["planned", "outlined", "drafting", "drafted", "revising", "done"];

/** 中英文混排的字数统计：CJK 按字计，西文按单词计。 */
export function countWords(text: string): number {
	const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
	const latin = text
		.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ")
		.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)?.length ?? 0;
	return cjk + latin;
}

export function emptyProject(input: Partial<Pick<Project, "title" | "genre" | "logline" | "synopsis" | "styleGuide" | "targetWords">> = {}): Project {
	const now = Date.now();
	return {
		id: newId(),
		title: input.title?.trim() || "未命名作品",
		genre: input.genre?.trim() || "",
		logline: input.logline?.trim() || "",
		synopsis: input.synopsis?.trim() || "",
		styleGuide: input.styleGuide?.trim() || "",
		targetWords: input.targetWords && input.targetWords > 0 ? Math.floor(input.targetWords) : 0,
		materials: [],
		volumes: [],
		outline: [],
		drafts: {},
		notes: [],
		createdAt: now,
		updatedAt: now,
	};
}
const NOTE_SEVERITIES: readonly NoteSeverity[] = ["info", "warning", "blocker"];
const NOTE_STATUSES: readonly NoteStatus[] = ["open", "resolved"];

/**
 * 归一化一条连续性备注。
 *
 * 早先 notes 走的是裸 `as ContinuityNote[]` 断言，全文件唯一一个没做校验的字段：
 * 一条缺 status 的 note 会从 projectStats 与 list_notes 里永久消失（那边按 status 过滤），
 * 却仍会被拼进提示词 —— 状态自相矛盾，且作者在界面上再也找不到它。
 */
function normalizeNote(raw: unknown): ContinuityNote | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<ContinuityNote>;
	if (typeof input.description !== "string" || !input.description.trim()) return undefined;
	const now = Date.now();
	return {
		id: typeof input.id === "string" && input.id ? input.id : newId(),
		severity: NOTE_SEVERITIES.includes(input.severity as NoteSeverity) ? (input.severity as NoteSeverity) : "info",
		category: typeof input.category === "string" ? input.category : "",
		subject: typeof input.subject === "string" ? input.subject : "",
		description: input.description,
		status: NOTE_STATUSES.includes(input.status as NoteStatus) ? (input.status as NoteStatus) : "open",
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
	};
}

function normalizeMaterial(raw: unknown): Material | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<Material>;
	const id = typeof input.id === "string" && input.id ? input.id : newId();
	const kind = isKnownKind(String(input.kind ?? "").trim()) ? String(input.kind).trim() : "other";
	const now = Date.now();
	return {
		id,
		kind,
		title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "未命名素材",
		content: typeof input.content === "string" ? input.content : "",
		tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [],
		usage: typeof input.usage === "string" ? input.usage : "",
		status: input.status === "confirmed" ? "confirmed" : "draft",
		chapterIds: Array.isArray(input.chapterIds) ? input.chapterIds.filter((value): value is string => typeof value === "string") : [],
		source: input.source === "agent" ? "agent" : input.source === "library" ? "library" : "human",
		...(typeof input.originId === "string" && input.originId ? { originId: input.originId } : {}),
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
	};
}

/**
 * 把旧版的人物与世界观字段迁移成素材。
 *
 * 迁移是单向且幂等的：输出里不再有 characters/worldFacts，
 * 所以对已迁移的数据再跑一次不会重复生成。
 */
function migrateLegacy(raw: Record<string, unknown>): Material[] {
	const out: Material[] = [];

	const characters = raw.characters;
	if (Array.isArray(characters)) {
		for (const item of characters) {
			if (!item || typeof item !== "object") continue;
			const c = item as Record<string, unknown>;
			const str = (value: unknown) => (typeof value === "string" ? value : "");
			const lines: string[] = [];
			if (str(c.role)) lines.push("定位：" + str(c.role));
			if (str(c.appearance)) lines.push("外貌：" + str(c.appearance));
			if (str(c.personality)) lines.push("性格：" + str(c.personality));
			if (str(c.background)) lines.push("背景：" + str(c.background));
			if (Array.isArray(c.relations) && c.relations.length > 0) lines.push("关系：" + c.relations.join("、"));
			if (str(c.arc)) lines.push("弧光：" + str(c.arc));
			if (str(c.notes)) lines.push("备注：" + str(c.notes));
			out.push({
				id: typeof c.id === "string" && c.id ? c.id : newId(),
				kind: "character",
				title: str(c.name) || "未命名人物",
				content: lines.join("\n"),
				tags: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : [],
				usage: "",
				status: "draft",
				chapterIds: [],
				source: "human",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	}

	const worldFacts = raw.worldFacts;
	if (Array.isArray(worldFacts)) {
		for (const item of worldFacts) {
			if (!item || typeof item !== "object") continue;
			const f = item as Record<string, unknown>;
			const category = typeof f.category === "string" ? f.category : "";
			const title = typeof f.title === "string" ? f.title : "";
			out.push({
				id: typeof f.id === "string" && f.id ? f.id : newId(),
				kind: "world",
				title: category && title ? category + " · " + title : title || category || "未命名设定",
				content: typeof f.content === "string" ? f.content : "",
				tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t === "string") : [],
				usage: "",
				status: "draft",
				chapterIds: [],
				source: "human",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	}

	return out;
}

/**
 * 归一化一卷。
 *
 * 卷名是作者的门面，空名字的卷在章目里只会显示成一条无名横线，
 * 干脆丢掉：它的章会在下面被清成"不分卷"，不会有章跟着消失。
 */
function normalizeVolume(raw: unknown): Volume | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Partial<Volume>;
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (!title) return undefined;
	return {
		id: typeof input.id === "string" && input.id ? input.id : newId(),
		title,
		summary: typeof input.summary === "string" ? input.summary : "",
		targetWords: typeof input.targetWords === "number" && input.targetWords > 0 ? Math.floor(input.targetWords) : 0,
		notes: typeof input.notes === "string" ? input.notes : "",
	};
}

export function normalizeProject(raw: unknown): Project {
	const base = emptyProject();
	if (!raw || typeof raw !== "object") return base;
	const input = raw as Record<string, unknown>;

	const migrated = migrateLegacy(input);
	const materials = Array.isArray(input.materials)
		? input.materials.map(normalizeMaterial).filter((item): item is Material => item !== undefined)
		: [];

	const volumes: Volume[] = [];
	if (Array.isArray(input.volumes)) {
		const taken = new Set<string>();
		for (const raw of input.volumes) {
			const volume = normalizeVolume(raw);
			if (!volume) continue;
			// 卷 id 重复会让"章挂在哪一卷"变得没法回答，后来的换号。
			if (taken.has(volume.id)) volume.id = newId();
			taken.add(volume.id);
			volumes.push(volume);
		}
	}
	const volumeIds = new Set(volumes.map((volume) => volume.id));

	const outline = Array.isArray(input.outline)
		? input.outline.filter((c): c is OutlineChapter => Boolean(c) && typeof c === "object").map((chapter) => ({
			id: typeof chapter.id === "string" && chapter.id ? chapter.id : newId(),
			title: typeof chapter.title === "string" ? chapter.title : "未命名章节",
			summary: typeof chapter.summary === "string" ? chapter.summary : "",
			pov: typeof chapter.pov === "string" ? chapter.pov : "",
			// 指向已删卷的章不能凭空消失，也不能挂在一个不存在的卷下：清成不分卷。
			volumeId:
				typeof chapter.volumeId === "string" && volumeIds.has(chapter.volumeId) ? chapter.volumeId : "",
			status: CHAPTER_STATUSES.includes(chapter.status) ? chapter.status : "planned",
			targetWords: typeof chapter.targetWords === "number" && chapter.targetWords > 0 ? Math.floor(chapter.targetWords) : 0,
			notes: typeof chapter.notes === "string" ? chapter.notes : "",
			materialIds: Array.isArray(chapter.materialIds)
				? chapter.materialIds.filter((value: unknown): value is string => typeof value === "string")
				: [],
		}))
		: [];

	const drafts: Record<string, ChapterMeta> = {};
	if (input.drafts && typeof input.drafts === "object") {
		for (const [key, value] of Object.entries(input.drafts as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const raw = value as Partial<ChapterMeta> & Partial<ChapterDraft>;
			const id = typeof raw.id === "string" && raw.id ? raw.id : key;
			// 老骨架里正文是内联的（拆文件之前的老工程），这里照样认得：
			// 字数当场算一次，正文随后由迁移写进 .txt。
			const content = typeof raw.content === "string" ? raw.content : "";
			drafts[id] = {
				id,
				title: typeof raw.title === "string" ? raw.title : "",
				// 老工程没有小结字段，缺省空串：读得开，接续时提示"上一章没有小结"。
				summary: typeof raw.summary === "string" ? raw.summary : "",
				words:
					typeof raw.words === "number" && raw.words >= 0
						? Math.floor(raw.words)
						: content
							? countWords(content)
							: 0,
				revision: typeof raw.revision === "number" ? raw.revision : 1,
				updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
				materialIds: Array.isArray(raw.materialIds)
					? raw.materialIds.filter((v): v is string => typeof v === "string")
					: [],
				hasDraft: typeof raw.hasDraft === "boolean" ? raw.hasDraft : content.length > 0,
			};
		}
	}

	return {
		...base,
		id: typeof input.id === "string" ? input.id : base.id,
		title: typeof input.title === "string" && input.title.trim() ? input.title : base.title,
		genre: typeof input.genre === "string" ? input.genre : "",
		logline: typeof input.logline === "string" ? input.logline : "",
		synopsis: typeof input.synopsis === "string" ? input.synopsis : "",
		styleGuide: typeof input.styleGuide === "string" ? input.styleGuide : "",
		targetWords: typeof input.targetWords === "number" && input.targetWords > 0 ? Math.floor(input.targetWords) : 0,
		materials: [...migrated, ...materials],
		volumes,
		outline,
		drafts,
		notes: Array.isArray(input.notes)
			? input.notes.map(normalizeNote).filter((n): n is ContinuityNote => n !== undefined)
			: [],
		createdAt: typeof input.createdAt === "number" ? input.createdAt : base.createdAt,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : base.updatedAt,
	};
}

/**
 * 从老骨架里挑出还内联着正文的那几章。
 *
 * 拆正文之前，drafts 里的每一章都带着 content 与 history。
 * normalizeProject 只留元数据（正文按需取），所以迁移正文要用这份原始副本。
 */
export function extractLegacyDrafts(input: unknown): Record<string, ChapterDraft> {
	const out: Record<string, ChapterDraft> = {};
	if (!input || typeof input !== "object") return out;
	const drafts = (input as { drafts?: unknown }).drafts;
	if (!drafts || typeof drafts !== "object") return out;
	for (const [key, value] of Object.entries(drafts as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const raw = value as Partial<ChapterDraft>;
		if (typeof raw.content !== "string") continue;
		const id = typeof raw.id === "string" && raw.id ? raw.id : key;
		out[id] = {
			id,
			title: typeof raw.title === "string" ? raw.title : "",
			content: raw.content,
			summary: typeof raw.summary === "string" ? raw.summary : "",
			revision: typeof raw.revision === "number" ? raw.revision : 1,
			updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
			materialIds: Array.isArray(raw.materialIds) ? raw.materialIds.filter((v): v is string => typeof v === "string") : [],
			history: Array.isArray(raw.history)
				? raw.history.filter((h): h is DraftRevision => !!h && typeof h.content === "string")
				: [],
		};
	}
	return out;
}

export interface ProjectStats {
	chapters: number;
	words: number;
	materials: number;
	/** 已装配素材的章节比例，用来判断"料够不够开写"。 */
	coveredChapters: number;
	draftedChapters: number;
	openNotes: number;
}

/** 消除作品所有派生数据的字段，用于界面展示。 */
export function projectStats(project: Project): ProjectStats {
	// 字数直接加各章的元数据：正文已经不在内存里了，
	// 每存一次稿就全书扫一遍会把自动存稿拖成几十毫秒的重活。
	const words = Object.values(project.drafts).reduce((sum, meta) => sum + (meta.words || 0), 0);
	return {
		chapters: project.outline.length,
		words,
		materials: project.materials.length,
		coveredChapters: project.outline.filter((chapter) => chapter.materialIds.length > 0).length,
		draftedChapters: Object.values(project.drafts).filter((meta) => meta.hasDraft).length,
		openNotes: project.notes.filter((note) => note.status === "open").length,
	};
}

/** 由完整草稿算出元数据。存稿与迁移都走这里，保证两处算出的字数一致。 */
export function draftMeta(draft: ChapterDraft): ChapterMeta {
	return {
		id: draft.id,
		title: draft.title,
		summary: draft.summary ?? "",
		words: countWords(draft.content ?? ""),
		revision: draft.revision,
		updatedAt: draft.updatedAt,
		materialIds: draft.materialIds ?? [],
		hasDraft: (draft.content ?? "").length > 0,
	};
}

/** 按 id 取卷。取不到返回 undefined —— 章可以指向已经被删掉的卷（归一化时会被清掉）。 */
export function volumeById(project: Project, volumeId: string): Volume | undefined {
	if (!volumeId) return undefined;
	return project.volumes.find((volume) => volume.id === volumeId);
}

/** 卷名。分不清卷就返回空串，调用方据此决定要不要写卷名。 */
export function volumeTitle(project: Project, volumeId: string): string {
	return volumeById(project, volumeId)?.title ?? "";
}

/** 按种类分组，界面与提示词都用它。 */
export function groupByKind(materials: readonly Material[]): Map<MaterialKind, Material[]> {
	const groups = new Map<MaterialKind, Material[]>();
	for (const option of kindOptions()) groups.set(option.kind, []);
	for (const material of materials) {
		// 作者自建的种类也可能在目录之外（比如它在别的机器上添的），
		// 这时照样要有个桶把它接住，不能悄悄丢掉那条素材。
		let bucket = groups.get(material.kind);
		if (!bucket) {
			bucket = [];
			groups.set(material.kind, bucket);
		}
		bucket.push(material);
	}
	return groups;
}

/**
 * 解析某章装配清单指向的素材，跳过指向已删素材的悬空 id。
 *
 * 悬空 id 是会真实出现的：素材被删掉后章节的 materialIds 里可能还留着它。
 * 直接按 id 取会在写作时拿到 undefined，所以统一从这里过一道。
 */
export function assembledMaterials(project: Project, chapterId: string): Material[] {
	const chapter = project.outline.find((item) => item.id === chapterId);
	if (!chapter) return [];
	const byId = new Map(project.materials.map((material) => [material.id, material]));
	return chapter.materialIds
		.map((id) => byId.get(id))
		.filter((material): material is Material => material !== undefined);
}

/**
 * 把素材装配到章节或从章节摘除，并保持双向同步。
 *
 * 素材记着"用在哪几章"，章节记着"装了哪些料"，两份索引必须一致 ——
 * 只改一边，界面上就会出现"素材卡说已装入、章节说没装"的矛盾。
 *
 * 未知 id 直接跳过并回报：挂一个不存在的 id 上去，章节的装料数会虚高，
 * 而写作时那条料又解析不出来。
 */
export function linkMaterials(
	project: Project,
	chapterId: string,
	materialIds: readonly string[],
	mode: "add" | "remove",
): { chapter: OutlineChapter | undefined; applied: string[]; skipped: string[] } {
	const chapter = project.outline.find((item) => item.id === chapterId);
	if (!chapter) return { chapter: undefined, applied: [], skipped: [...materialIds] };
	const byId = new Map(project.materials.map((material) => [material.id, material]));
	const applied: string[] = [];
	const skipped: string[] = [];
	for (const id of materialIds) {
		const material = byId.get(id);
		if (!material) {
			skipped.push(id);
			continue;
		}
		applied.push(id);
		const shouldLink = mode === "add";
		chapter.materialIds = shouldLink
			? chapter.materialIds.includes(id) ? chapter.materialIds : [...chapter.materialIds, id]
			: chapter.materialIds.filter((value) => value !== id);
		material.chapterIds = shouldLink
			? material.chapterIds.includes(chapterId) ? material.chapterIds : [...material.chapterIds, chapterId]
			: material.chapterIds.filter((value) => value !== chapterId);
	}
	return { chapter, applied, skipped };
}

/**
 * 删除素材，并把它从所有章节的装配清单里摘掉。
 *
 * 不摘的话，那些章节的"装料 N 条"会一直虚高，写作时又解析不出内容。
 */
export function removeMaterial(project: Project, materialId: string): Material | undefined {
	const index = project.materials.findIndex((material) => material.id === materialId);
	if (index < 0) return undefined;
	const [removed] = project.materials.splice(index, 1);
	for (const chapter of project.outline) {
		chapter.materialIds = chapter.materialIds.filter((id) => id !== materialId);
	}
	return removed;
}
