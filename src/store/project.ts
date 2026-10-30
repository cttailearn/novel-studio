import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type ChapterStatus = "planned" | "outlined" | "drafting" | "drafted" | "revising" | "done";
export type NoteSeverity = "info" | "warning" | "blocker";
export type NoteStatus = "open" | "resolved";
/** 素材来源：书者手写 / 墨客所拟 / 取自通用素材库。 */
export type MaterialSource = "human" | "agent" | "library";
export type MaterialStatus = "draft" | "confirmed";

/**
 * 每章保留的历史版本数上限。
 *
 * 正文动辄数万字，全量留档会让工程文件迅速膨胀到不可接受；
 * 但一份都不留不行 —— 覆盖写是这套流程里唯一会销毁内容的动作，必须留退路。
 */
export const MAX_DRAFT_HISTORY = 10;

/** 章节正文子目录名。正文按章拆文件后落在 data/drafts/<projectId>/ 下。 */
const DRAFTS_DIR = "drafts";

/** 整部作品的快照目录，落在 data/snapshots/<projectId>/ 下。 */
const SNAPSHOTS_DIR = "snapshots";

/** 已删除作品的完整目录，默认移到这里而不是永久删除。 */
const TRASH_DIR = "trash";

export interface DeletedProject {
	id: string;
	title: string;
	deletedAt: number;
}

/** 每部作品保留的快照数上限。 */
const MAX_SNAPSHOTS = 20;

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
		id: randomUUID(),
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
		id: typeof input.id === "string" && input.id ? input.id : randomUUID(),
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
	const id = typeof input.id === "string" && input.id ? input.id : randomUUID();
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
				id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
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
				id: typeof f.id === "string" && f.id ? f.id : randomUUID(),
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
		id: typeof input.id === "string" && input.id ? input.id : randomUUID(),
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
			if (taken.has(volume.id)) volume.id = randomUUID();
			taken.add(volume.id);
			volumes.push(volume);
		}
	}
	const volumeIds = new Set(volumes.map((volume) => volume.id));

	const outline = Array.isArray(input.outline)
		? input.outline.filter((c): c is OutlineChapter => Boolean(c) && typeof c === "object").map((chapter) => ({
			id: typeof chapter.id === "string" && chapter.id ? chapter.id : randomUUID(),
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

/** 某部作品尚未落盘的部分：主文件与失败章分开记。 */
interface PendingWrites {
	/** 主文件（素材、大纲、备注）是否需要重写。 */
	project: boolean;
	/** 哪几章的正文文件没写成功。 */
	chapters: Set<string>;
}

/** 一份还没写进磁盘的正文，等重试时补写。 */
interface PendingBody {
	title: string;
	content: string;
	summary?: string;
	materialIds?: string[];
	mode?: string;
	keepHistory?: boolean;
}

/**
 * 小说工程的持久化存储。
 * 内存为主，每次写入后异步落盘为一个 JSON 文件。
 */
export class ProjectStore {
	private readonly projects = new Map<string, Project>();
	/** 同一项目的写入串行化，避免并发落盘相互覆盖。 */
	private readonly writeChains = new Map<string, Promise<void>>();
	/**
	 * 落盘失败待重试的部分。存上才算数，所以失败必须留痕；
	 * 又因为正文按章拆文件，失败必须按章记 —— 否则一次成功写入会把
	 * 上一次失败、这一轮根本没重试的章一并从待重试里清掉。
	 */
	private readonly dirty = new Map<string, PendingWrites>();
	/**
	 * 上一轮没写进磁盘的正文（工程 id → 章 id → 原文）。
	 *
	 * 正文落在 .txt 与 .hist/，与骨架分开写：骨架写成功不代表正文写成功。
	 * 写正文失败时原文还在手里，留一份在这儿，等 retryPending 补写 ——
	 * 否则这一稿就只剩编辑器里那一份，刷新就没了。
	 */
	private readonly pendingBodies = new Map<string, Map<string, PendingBody>>();

	/** 最近一次落盘异常，按工程保留，供 flush 把后台失败传回调用方。 */
	private readonly writeErrors = new Map<string, unknown>();

	private readonly dir: string;

	private constructor(dir: string) {
		this.dir = dir;
	}

	/** 章节正文目录：data/drafts/<projectId>/ */
	private draftDir(projectId: string): string {
		return path.join(this.dir, DRAFTS_DIR, projectId);
	}

	/**
	 * 一章的三个落点：元数据、正文、历史。
	 *
	 * <enc>.meta.json —— ChapterMeta（骨架里也有一份，这里是权威副本）
	 * <enc>.txt        —— 正文纯文本
	 * <enc>.hist/      —— 历史版本，每版一个 <revision>.json
	 *
	 * 拆开是为了两件事：正文能被单独取（不拖着一整本书走），
	 * 历史不必与正文同生共死（回滚时只翻历史目录，不必整章重写）。
	 */
	private draftBase(projectId: string, chapterId: string): string {
		return path.join(this.draftDir(projectId), encodeFileName(chapterId));
	}

	private metaFile(projectId: string, chapterId: string): string {
		return this.draftBase(projectId, chapterId) + ".meta.json";
	}

	private bodyFile(projectId: string, chapterId: string): string {
		return this.draftBase(projectId, chapterId) + ".txt";
	}

	private histDir(projectId: string, chapterId: string): string {
		return this.draftBase(projectId, chapterId) + ".hist";
	}

	/**
	 * 落盘：随机临时名 + rename + 重试，与 library / settings / credentials 同一套写法。
	 *
	 * 早先这里是裸 writeFile（truncate-then-write），写到一半崩溃就留下截断 JSON，
	 * 而 open() 对解析失败的文件只跳过 —— 结果是整部作品从列表里凭空消失。
	 * rename 是原子的：要么还是旧文件，要么已经是新文件，不存在中间态。
	 *
	 * 正文按章单独落盘（changed 给出这一轮动过的章），主文件只留素材、大纲与备注。
	 * 否则一次 upsert 就要重写整本书：长篇的 drafts 内联在同一个 JSON 里，
	 * 写放大与写盘窗口都随书稿一起膨胀。
	 *
	 * 失败不再静默：挂 dirty 标记并重试，重试仍失败才报出来，
	 * 否则调用方（API 照样返回 200）无从得知这一稿其实没存上。
	 * 标记按章记：一章写失败不影响其余章，也不会被别的章的成功写入清掉。
	 */
	private persist(project: Project, changed?: ReadonlySet<string>): Promise<void> {
		const file = path.join(this.dir, project.id + ".json");
		void changed;
		const previous = this.writeChains.get(project.id) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				// 骨架里只有卷、大纲、素材、备注与各章元数据，没有正文。
				// 正文由 saveDraftBody 自己按章写，两边不互相依赖：
				// 骨架落后一拍只影响字数显示，正文落后一拍则是"字还在但没存上"，
				// 后者由 writeBody 的失败标记单独追。
				try {
					await this.writeAtomic(file, project);
					this.clearDirtyProject(project.id);
					if (!this.dirty.has(project.id)) this.writeErrors.delete(project.id);
				} catch (error) {
					this.markDirtyProject(project.id);
					this.writeErrors.set(project.id, error);
					console.error("[store] 落盘 " + file + " 失败（已标记待重试）:", error);
				}
			})
			.catch((error) => {
				// 兜底：上面每一步都自己接住了错误，走到这里说明是意料之外的故障。
				this.markDirtyProject(project.id);
				this.writeErrors.set(project.id, error);
				console.error("[store] 落盘 " + file + " 失败（已标记待重试）:", error);
			})
			.then(() => undefined);
		this.writeChains.set(project.id, next);
		return next;
	}

	/**
	 * 清掉上次崩溃留下的临时文件。
	 *
	 * writeAtomic 每次用唯一 tmp 名，崩溃会留下一个孤儿。它们既占地方又会让
	 * "目录里有哪些文件"的判断失准，趁启动时按 *.tmp 后缀清一遍。
	 */
	private async sweepTemp(dir: string): Promise<void> {
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (!name.endsWith(".tmp")) continue;
			await rm(path.join(dir, name), { force: true });
		}
	}

	/**
	 * 写一章：正文落 .txt，元数据落 .meta.json，历史落 .hist/。
	 *
	 * 顺序是"先正文、后元数据"：元数据说"这章有正文"却找不到正文文件，
	 * 界面就会摆出一个空章节（幽灵章）；反过来只是字数晚一拍显示。
	 *
	 * 历史版本每版一个文件（<revision>.json）。留着它们是因为覆盖写是这套流程里
	 * 唯一会销毁内容的动作 —— 模型看不见原文时执行覆盖，出错就是静默截断。
	 */
	async saveDraftBody(
		projectId: string,
		chapterId: string,
		input: {
			title: string;
			content: string;
			summary?: string;
			materialIds?: string[];
			mode?: string;
			/** 是否把旧稿归档成历史版本。自动存稿为 false。 */
			keepHistory?: boolean;
		},
	): Promise<ChapterMeta> {
		try {
			return await this.writeDraftBody(projectId, chapterId, input);
		} catch (error) {
			// 写不进去就把原文留在手里，等 retryPending 补写。
			// 只留一个标记不济事 —— 原文没了就再也补不回来。
			this.markDirtyChapter(projectId, chapterId);
			this.writeErrors.set(projectId, error);
			let chapters = this.pendingBodies.get(projectId);
			if (!chapters) {
				chapters = new Map<string, PendingBody>();
				this.pendingBodies.set(projectId, chapters);
			}
			chapters.set(chapterId, { ...input });
			throw error;
		}
	}

	private async writeDraftBody(
		projectId: string,
		chapterId: string,
		input: {
			title: string;
			content: string;
			summary?: string;
			materialIds?: string[];
			mode?: string;
			keepHistory?: boolean;
		},
	): Promise<ChapterMeta> {
		const project = this.projects.get(projectId);
		if (!project) throw new Error("工程 " + projectId + " 不存在");
		const existingMeta = project.drafts[chapterId];
		// 自动存稿不需要历史：绝不能为了"不使用它"而先把全部历史读进内存。
		// 这里只读旧正文；保留历史仍留在磁盘原处，下面也不会逐个重写。
		const existingBody = await this.readDraftBody(projectId, chapterId, {
			history: input.keepHistory !== false,
		});
		const oldContent = existingBody?.content ?? "";
		const content = input.content;
		// 内容没变就不留版本：连点两次"存稿"不该产生一份重复历史。
		const changed = oldContent.trim() !== content.trim();
		const history: DraftRevision[] = [...(existingBody?.history ?? [])];
		let archived: DraftRevision | undefined;
		if (existingMeta && oldContent.trim() && input.keepHistory !== false && changed) {
			archived = {
				revision: existingMeta.revision,
				title: existingMeta.title,
				content: oldContent,
				materialIds: existingMeta.materialIds,
				updatedAt: existingMeta.updatedAt,
				mode: input.mode ?? "manual",
			};
			history.push(archived);
		}
		while (history.length > MAX_DRAFT_HISTORY) history.shift();

		const meta: ChapterMeta = {
			id: chapterId,
			title: input.title,
			summary: input.summary ?? existingMeta?.summary ?? "",
			words: countWords(content),
			revision: (existingMeta?.revision ?? 0) + 1,
			updatedAt: Date.now(),
			materialIds: input.materialIds ?? existingMeta?.materialIds ?? [],
			hasDraft: content.length > 0,
		};

		await mkdir(this.draftDir(projectId), { recursive: true });
		// 正文先落。
		await this.writeAtomicText(this.bodyFile(projectId, chapterId), content);
		// 历史已经按版拆文件，只新增当前旧版即可。自动存稿连目录都不碰。
		// 逐个重写保留历史会把 O(1) 的存稿变成 O(历史总字数)。
		if (input.keepHistory !== false) {
			const histDir = this.histDir(projectId, chapterId);
			if (archived) {
				await mkdir(histDir, { recursive: true });
				await this.writeAtomic(path.join(histDir, archived.revision + ".json"), archived);
			}
			await this.trimHistory(histDir, history);
		}
		// 元数据最后落：它说"有正文"时，正文一定已经在盘上。
		await this.writeAtomic(this.metaFile(projectId, chapterId), meta);

		project.drafts[chapterId] = meta;
		project.updatedAt = meta.updatedAt;
		await this.persist(project);
		// 写成功了：撤下这一章的待重试标记，也不再留着原文副本。
		this.clearDirtyChapter(projectId, chapterId);
		if (!this.dirty.has(projectId)) this.writeErrors.delete(projectId);
		const pending = this.pendingBodies.get(projectId);
		if (pending) {
			pending.delete(chapterId);
			if (pending.size === 0) this.pendingBodies.delete(projectId);
		}
		return meta;
	}

	/** 历史版本只留最近若干版，旧的删掉，免得目录无限膨胀。 */
	private async trimHistory(histDir: string, history: DraftRevision[]): Promise<void> {
		const keep = new Set(history.map((revision) => revision.revision + ".json"));
		const names = await readdir(histDir).catch(() => [] as string[]);
		for (const name of names) {
			if (!name.endsWith(".json") || keep.has(name)) continue;
			await rm(path.join(histDir, name), { force: true });
		}
	}

	/**
	 * 读一章的正文与历史。按需从磁盘取，不常驻内存。
	 *
	 * 老工程（正文与历史同处一个 <enc>.json）在这里惰性迁移：
	 * 写出新的 .meta.json / .txt / .hist/ 之后，把老文件改名成 .migrated 留着。
	 * 改名而不是删除 —— 迁移万一算错，原件还在。
	 */
	async readDraftBody(
		projectId: string,
		chapterId: string,
		options: { history?: boolean } = {},
	): Promise<DraftBody | undefined> {
		const meta = this.projects.get(projectId)?.drafts[chapterId];
		const base = this.draftBase(projectId, chapterId);
		let content = await readFile(this.bodyFile(projectId, chapterId), "utf8").catch(() => undefined);
		let history: DraftRevision[] = [];
		if (options.history) {
			history = await this.readHistoryFiles(this.histDir(projectId, chapterId));
		}
		if (content !== undefined) {
			return { content, history };
		}
		// 没有 .txt：可能是老格式（正文在 <enc>.json 里），也可能这章压根没写过。
		const legacy = await readFile(base + ".json", "utf8").catch(() => undefined);
		if (legacy === undefined) {
			return meta ? { content: "", history } : undefined;
		}
		try {
			const draft = JSON.parse(legacy) as ChapterDraft;
			if (typeof draft?.content !== "string") throw new Error("老章节文件缺少 content");
			content = draft.content;
			history = Array.isArray(draft.history) ? draft.history.slice(-MAX_DRAFT_HISTORY) : [];
			// 迁移：先写新文件，全部成功后才把老文件改名。
			await this.migrateLegacyChapter(projectId, draft, content, history);
			return { content, history };
		} catch (error) {
			const kept = base + ".json.corrupt";
			await rename(base + ".json", kept).catch(() => undefined);
			console.error("[store] 章节正文损坏，已隔离为 " + path.basename(kept) + ":", error);
			return meta ? { content: "", history } : undefined;
		}
	}

	/** 把老格式的一章拆成 .meta.json / .txt / .hist/，成功后再把老文件改名留存。 */
	private async migrateLegacyChapter(
		projectId: string,
		draft: ChapterDraft,
		content: string,
		history: DraftRevision[],
	): Promise<void> {
		const chapterId = draft.id;
		try {
			await mkdir(this.draftDir(projectId), { recursive: true });
			await this.writeAtomicText(this.bodyFile(projectId, chapterId), content);
			const histDir = this.histDir(projectId, chapterId);
			await mkdir(histDir, { recursive: true });
			for (const revision of history) {
				await this.writeAtomic(path.join(histDir, revision.revision + ".json"), revision);
			}
			const meta = draftMeta({ ...draft, content, history });
			await this.writeAtomic(this.metaFile(projectId, chapterId), meta);
			// 老文件改名留存，不删：迁移万一有偏差，原件还在原地。
			await rename(this.draftBase(projectId, chapterId) + ".json", this.draftBase(projectId, chapterId) + ".json.migrated");
		} catch (error) {
			// 迁移失败就保持老文件原样，下次再试；内容仍能从老文件读出来。
			console.error("[store] 老章节迁移失败，保留原文件待下次重试:", error);
		}
	}

	/** 读历史版本目录，按版本号从旧到新。 */
	private async readHistoryFiles(histDir: string): Promise<DraftRevision[]> {
		const names = await readdir(histDir).catch(() => [] as string[]);
		const out: DraftRevision[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const raw = await readFile(path.join(histDir, name), "utf8").catch(() => undefined);
			if (raw === undefined) continue;
			try {
				const revision = JSON.parse(raw) as DraftRevision;
				if (typeof revision?.content !== "string") continue;
				out.push(revision);
			} catch {
				// 历史里坏掉的一版不该牵连别的版本：跳过即可。
			}
		}
		return out.sort((a, b) => a.revision - b.revision);
	}

	/** 原子写纯文本：写唯一临时文件，再 rename 覆盖。 */
	private async writeAtomicText(file: string, text: string): Promise<void> {
		const tmp = file + "." + randomUUID() + ".tmp";
		await writeFile(tmp, text, "utf8");
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, file);
				return;
			} catch (error) {
				if (attempt >= 4) {
					await rm(tmp, { force: true }).catch(() => undefined);
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
	}

	/** 原子写：写唯一临时文件，再 rename 覆盖。Windows 上 rename 偶发 EPERM，故重试。 */
	private async writeAtomic(file: string, payload: unknown): Promise<void> {
		const tmp = file + "." + randomUUID() + ".tmp";
		await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, file);
				return;
			} catch (error) {
				if (attempt >= 4) {
					await rm(tmp, { force: true }).catch(() => undefined);
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
	}

	static async open(dir: string): Promise<ProjectStore> {
		await mkdir(dir, { recursive: true });
		const store = new ProjectStore(dir);
		const broken: string[] = [];
		const entries = await readdir(dir).catch(() => [] as string[]);
		await mkdir(path.join(dir, DRAFTS_DIR), { recursive: true });
		// 主目录里也可能躺着上次崩溃的 tmp，一并清掉。
		await store.sweepTemp(dir);
		await Promise.all(
			entries
				.filter(
					(name) =>
						name.endsWith(".json") &&
						name !== "settings.json" &&
						name !== "credentials.json" &&
						// 通用素材库是跨作品的另一个文件，别当成一部作品读进来。
						name !== "library.json" &&
						// 章节正文目录与快照目录不是作品文件。
						name !== DRAFTS_DIR &&
						name !== SNAPSHOTS_DIR,
				)
				.map(async (name) => {
					const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
					if (raw === undefined) return;
					let project: Project | undefined;
					try {
					// 老工程的主文件里还内联着正文（拆文件之前的形状）。
					// 先把这份原始副本取出来，迁移要用；normalizeProject 只留元数据。
					const parsed = JSON.parse(raw) as unknown;
					const legacyInline = extractLegacyDrafts(parsed);
					project = normalizeProject(parsed);
					const fromFiles = await store.loadChapterMetas(project);
					project.drafts = { ...project.drafts, ...fromFiles };
					store.projects.set(project.id, project);
					// 把内联正文拆成按章文件：.txt 落正文，.hist/ 落历史，.meta.json 落元数据。
					// 拆完主文件只剩骨架，正文不再随骨架进出内存。
					for (const [chapterId, draft] of Object.entries(legacyInline)) {
						if (!draft.content) continue;
						await store.saveDraftBody(project.id, chapterId, {
							title: draft.title,
							content: draft.content,
							summary: draft.summary,
							materialIds: draft.materialIds,
							keepHistory: false,
						}).catch((error) => {
							console.error("[store] 老工程内联正文拆分失败（正文仍在主文件里，不会丢）:", error);
						});
					}
					if (Object.keys(project.drafts).length > 0) void store.persist(project);
					await store.sweepTemp(path.join(dir, DRAFTS_DIR, project.id));
					} catch (error) {
						if (project && store.projects.has(project.id)) {
							// 迁移阶段的临时写入失败不能误删刚刚读成功的工程；
							// 只有 JSON 解析/归一化失败才隔离原始主文件。
							console.error("[store] 工程章节迁移失败，保留主文件待重试:", error);
							return;
						}
						// 解析失败绝不能就地把文件删掉或覆盖掉 —— 那是这本书唯一的副本。
						// 改名隔离，原文留在磁盘上等人工处理。
						broken.push(name);
						const kept = path.join(dir, name + ".corrupt");
						await rename(path.join(dir, name), kept).catch(() => undefined);
						console.error("[store] 工程文件解析失败，已隔离为 " + path.basename(kept) + ":", error);
					}
				}),
		);
		if (broken.length > 0) {
			console.error(
				"[store] 有 " + broken.length + " 个工程文件无法读取，已改名为 *.corrupt 保留。" +
					"原文仍在 data/ 目录，确认内容后可自行改名恢复。",
			);
		}
		return store;
	}

	list(): Project[] {
		return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): Project | undefined {
		return this.projects.get(id);
	}

	create(input?: Partial<Pick<Project, "title" | "genre" | "logline" | "synopsis" | "styleGuide" | "targetWords">>): Project {
		const project = emptyProject(input);
		this.projects.set(project.id, project);
		void this.persist(project);
		return project;
	}

	/**
	 * 在原对象上实施变更并落盘。传入的对象不应在外部长期持有。
	 *
	 * 这里只管骨架（卷、大纲、素材、备注）。正文另有落点：
	 * 走 saveDraftBody，它自己写 .txt 与 .hist/ 并更新元数据。
	 */
	mutate(id: string, mutate: (project: Project) => void): Project {
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		mutate(project);
		project.updatedAt = Date.now();
		void this.persist(project);
		return project;
	}

	/**
	 * 等指定工程排队中的落盘做完；若本次或此前写入仍未落盘则抛错。
	 * 同步的 create/mutate 可继续原样使用，需要确认落盘的调用方 await 此方法。
	 */
	async flushForProject(id: string): Promise<void> {
		const chain = this.writeChains.get(id);
		if (chain) await chain;
		const pending = this.dirty.get(id);
		if (!pending) return;
		const cause = this.writeErrors.get(id);
		throw new Error("工程 " + id + " 仍有未落盘数据", { cause });
	}

	/** 等全部后台落盘完成；任何工程仍有 dirty 数据都会抛错。 */
	async flush(): Promise<void> {
		await Promise.all([...this.writeChains.values()]);
		for (const id of this.dirty.keys()) await this.flushForProject(id);
	}

	/**
	 * 读出各章的元数据。正文不进内存，要看正文另行按需取。
	 *
	 * 目录里两种文件都认：新格式的 <enc>.meta.json，以及老格式的 <enc>.json
	 * （正文与历史同处一文件）。老格式在这里惰性迁移：拆成 .txt 与 .hist/，
	 * 老文件改名成 .migrated 留存。损坏的章节文件隔离保留，不牵连整部作品。
	 */
	private async loadChapterMetas(project: Project): Promise<Record<string, ChapterMeta>> {
		const out: Record<string, ChapterMeta> = {};
		const dir = path.join(this.dir, DRAFTS_DIR, project.id);
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (name.endsWith(".meta.json")) {
				const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
				if (raw === undefined) continue;
				try {
					const meta = JSON.parse(raw) as ChapterMeta;
					if (typeof meta?.id !== "string" || !meta.id) throw new Error("章节元数据缺少 id");
					out[meta.id] = {
						id: meta.id,
						title: typeof meta.title === "string" ? meta.title : "",
						summary: typeof meta.summary === "string" ? meta.summary : "",
						words: typeof meta.words === "number" && meta.words >= 0 ? Math.floor(meta.words) : 0,
						revision: typeof meta.revision === "number" ? meta.revision : 1,
						updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now(),
						materialIds: Array.isArray(meta.materialIds) ? meta.materialIds.filter((v) => typeof v === "string") : [],
						hasDraft: meta.hasDraft !== false,
					};
				} catch (error) {
					const kept = path.join(dir, name + ".corrupt");
					await rename(path.join(dir, name), kept).catch(() => undefined);
					console.error("[store] 章节元数据损坏，已隔离为 " + path.basename(kept) + ":", error);
				}
				continue;
			}
			// 老格式：正文与历史同处一个 <enc>.json。
			if (!name.endsWith(".json") || name.endsWith(".meta.json")) continue;
			const file = path.join(dir, name);
			const raw = await readFile(file, "utf8").catch(() => undefined);
			if (raw === undefined) continue;
			try {
				const draft = JSON.parse(raw) as ChapterDraft;
				if (typeof draft?.id !== "string" || typeof draft.content !== "string") {
					throw new Error("章节正文缺少 id 或 content");
				}
				const history = Array.isArray(draft.history) ? draft.history.slice(-MAX_DRAFT_HISTORY) : [];
				const meta = draftMeta({
					...draft,
					history,
					materialIds: Array.isArray(draft.materialIds) ? draft.materialIds : [],
					summary: typeof draft.summary === "string" ? draft.summary : "",
				});
				out[draft.id] = meta;
				// 迁移：先写新文件，成功后才把老文件改名留存。
				await this.migrateLegacyChapter(project.id, { ...draft, history }, draft.content, history);
			} catch (error) {
				const kept = file + ".corrupt";
				await rename(file, kept).catch(() => undefined);
				console.error("[store] 章节正文损坏，已隔离为 " + path.basename(kept) + ":", error);
			}
		}
		return out;
	}

	/**
	 * 同一章节的写入串行化。
	 *
	 * 智能体的 write_chapter 与作者在稿面直接保存（PATCH /chapters/:id）都会
	 * 整段覆盖同一章。两边并发时后写者会静默吞掉先写者，因此共用一把按章的锁。
	 */
	async withChapterLock<T>(id: string, chapterId: string, fn: () => Promise<T> | T): Promise<T> {
		const key = id + "::" + chapterId;
		const previous = this.chapterChains.get(key) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this.chapterChains.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/** 按章的写锁队列，键为 "projectId::chapterId"。 */
	private readonly chapterChains = new Map<string, Promise<unknown>>();

	/**
	 * 删除工程。默认把主文件、正文和快照整体移入 data/trash/<id>/，
	 * 因而无需调用方先拍快照也能恢复。传 { permanent: true } 才永久删除。
	 */
	async remove(id: string, options: { permanent?: boolean } = {}): Promise<void> {
		// 先等已经排队的写入，避免 remove 与后台 rename 交错造成半份回收站。
		const chain = this.writeChains.get(id);
		if (chain) await chain;
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		// 回收站必须拿到完整内存状态，不能把此前失败的 dirty 数据静默丢掉。
		await this.flushForProject(id);
		if (options.permanent) {
			this.projects.delete(id);
			this.dirty.delete(id);
			this.pendingBodies.delete(id);
			this.writeErrors.delete(id);
			this.writeChains.delete(id);
		}
		try {
			if (options.permanent) {
				await Promise.all([
					rm(path.join(this.dir, id + ".json"), { force: true }),
					rm(path.join(this.dir, DRAFTS_DIR, id), { recursive: true, force: true }),
					rm(path.join(this.dir, SNAPSHOTS_DIR, id), { recursive: true, force: true }),
				]);
				return;
			}
			const trash = path.join(this.dir, TRASH_DIR, id);
			if (await stat(trash).then(() => true, () => false)) {
				throw new Error("回收站中已存在工程 " + id + "，未执行删除");
			}
			await mkdir(trash, { recursive: true });
			await rename(path.join(this.dir, id + ".json"), path.join(trash, "project.json"));
			const drafts = path.join(this.dir, DRAFTS_DIR, id);
			const snapshots = path.join(this.dir, SNAPSHOTS_DIR, id);
			if (await stat(drafts).then(() => true, () => false)) {
				await rename(drafts, path.join(trash, DRAFTS_DIR));
			}
			if (await stat(snapshots).then(() => true, () => false)) {
				await rename(snapshots, path.join(trash, SNAPSHOTS_DIR));
			}
			await this.writeAtomic(path.join(trash, "deleted.json"), {
				id,
				title: project.title,
				deletedAt: Date.now(),
			});
			this.projects.delete(id);
			this.dirty.delete(id);
			this.pendingBodies.delete(id);
			this.writeErrors.delete(id);
			this.writeChains.delete(id);
		} catch (error) {
			// 文件仍可能部分留在原处；保留内存对象，调用方可以重试或人工处理。
			this.projects.set(id, project);
			throw error;
		}
	}

	/** 回收站列表，最新的在前。 */
	async listDeleted(): Promise<DeletedProject[]> {
		const root = path.join(this.dir, TRASH_DIR);
		const names = await readdir(root).catch(() => [] as string[]);
		const out: DeletedProject[] = [];
		for (const id of names) {
			const file = path.join(root, id, "project.json");
			try {
				const project = normalizeProject(JSON.parse(await readFile(file, "utf8")));
				const info = await stat(file);
				let deletedAt = info.mtimeMs;
				const marker = await readFile(path.join(root, id, "deleted.json"), "utf8").catch(() => undefined);
				if (marker) {
					const parsed = JSON.parse(marker) as { deletedAt?: unknown };
					if (typeof parsed.deletedAt === "number") deletedAt = parsed.deletedAt;
				}
				out.push({ id: project.id, title: project.title, deletedAt });
			} catch {
				// 单个回收站条目损坏不应让其他作品无法恢复。
			}
		}
		return out.sort((a, b) => b.deletedAt - a.deletedAt);
	}

	/** 从回收站恢复整部作品，包含正文、历史和快照。 */
	async restoreDeleted(id: string): Promise<Project> {
		if (this.projects.has(id)) throw new Error("工程 " + id + " 已存在");
		const trash = path.join(this.dir, TRASH_DIR, id);
		const projectFile = path.join(trash, "project.json");
		const raw = await readFile(projectFile, "utf8").catch(() => undefined);
		if (raw === undefined) throw new Error("回收站中不存在工程 " + id);
		const target = path.join(this.dir, id + ".json");
		const drafts = path.join(this.dir, DRAFTS_DIR, id);
		const snapshots = path.join(this.dir, SNAPSHOTS_DIR, id);
		for (const file of [target, drafts, snapshots]) {
			if (await stat(file).then(() => true, () => false)) {
				throw new Error("恢复目标已存在，未覆盖: " + file);
			}
		}
		await rename(projectFile, target);
		try {
			if (await stat(path.join(trash, DRAFTS_DIR)).then(() => true, () => false)) {
				await rename(path.join(trash, DRAFTS_DIR), drafts);
			}
			if (await stat(path.join(trash, SNAPSHOTS_DIR)).then(() => true, () => false)) {
				await rename(path.join(trash, SNAPSHOTS_DIR), snapshots);
			}
			await rm(path.join(trash, "deleted.json"), { force: true });
			await rm(trash, { recursive: true, force: true });
			const project = normalizeProject(JSON.parse(raw));
			project.drafts = { ...project.drafts, ...(await this.loadChapterMetas(project)) };
			this.projects.set(id, project);
			return project;
		} catch (error) {
			// 尽力把主文件放回回收站；不要在恢复失败后同时从两处隐藏它。
			if (await stat(target).then(() => true, () => false)) {
				await rename(target, projectFile).catch(() => undefined);
			}
			throw error;
		}
	}

	stats(project: Project): ProjectStats {
		return projectStats(project);
	}

	/**
	 * 给整部作品拍一份快照。
	 *
	 * 章节内的 history 只覆盖"这一章被反复覆盖"，管不到误删素材、误改大纲、
	 * 误删整部作品。快照是工程级的退路：调用方在破坏性操作前先拍一份，
	 * 出问题能整本回滚。
	 *
	 * 快照带正文，且用 gzip 落盘。理由有二：
	 * 一是回滚要能连正文一起退回去 —— 只存骨架的快照能把书救回来却救不回字；
	 * 二是正文是高度重复的中文文本，压缩后通常只剩原体积的三四成，
	 * 千万字的书拍一份快照也不再是 GB 级。
	 */
	async snapshot(project: Project, label = ""): Promise<string> {
		const dir = path.join(this.dir, SNAPSHOTS_DIR, project.id);
		await mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = stamp + (label ? "-" + encodeFileName(label) : "") + ".json.gz";
		// 正文按需取：快照是显式动作，才付这个读取代价。
		const bodies: Record<string, DraftBody> = {};
		for (const chapterId of Object.keys(project.drafts)) {
			const body = await this.readDraftBody(project.id, chapterId, { history: true });
			if (body) bodies[chapterId] = body;
		}
		const payload = gzipSync(Buffer.from(JSON.stringify({ project, bodies }), "utf8"));
		const file = path.join(dir, name);
		const tmp = file + "." + randomUUID() + ".tmp";
		await writeFile(tmp, payload);
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, file);
				break;
			} catch (error) {
				if (attempt >= 4) {
					await rm(tmp, { force: true }).catch(() => undefined);
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
		await this.trimSnapshots(project.id, dir);
		return name;
	}

	/** 快照只留最近若干份，旧的清掉，避免 data 目录无限膨胀。 */
	private async trimSnapshots(projectId: string, dir: string): Promise<void> {
		const names = (await readdir(dir).catch(() => [] as string[]))
			.filter((name) => name.endsWith(".json.gz") || name.endsWith(".json"))
			// 文件名以 ISO 时间戳开头，字典序即时间序。
			.sort();
		for (const name of names.slice(0, Math.max(0, names.length - MAX_SNAPSHOTS))) {
			await rm(path.join(dir, name), { force: true });
		}
		void projectId;
	}

	/** 列出某部作品的快照，最新的在前。 */
	async listSnapshots(projectId: string): Promise<{ name: string; at: number; size: number }[]> {
		const dir = path.join(this.dir, SNAPSHOTS_DIR, projectId);
		const names = (await readdir(dir).catch(() => [] as string[]))
			.filter((name) => name.endsWith(".json.gz") || name.endsWith(".json"))
			.sort()
			.reverse();
		const out: { name: string; at: number; size: number }[] = [];
		for (const name of names) {
			const info = await stat(path.join(dir, name)).catch(() => undefined);
			if (!info) continue;
			out.push({ name, at: info.mtimeMs, size: info.size });
		}
		return out;
	}

	/**
	 * 读回一份快照，供回滚使用。文件损坏时返回 undefined 而不是抛错。
	 *
	 * 返回骨架与各章正文两份东西：骨架是卷、大纲、素材、备注与元数据，
	 * 正文是逐章的字。回滚要把两者一起退回去，只退骨架等于字还在原处。
	 * 老快照（.json，正文内联在 drafts 里）也认：解析出来一并给。
	 */
	async readSnapshot(
		projectId: string,
		name: string,
	): Promise<{ project: Project; bodies: Record<string, DraftBody> } | undefined> {
		// 文件名来自 listSnapshots，但仍要挡一手路径穿越。
		if (name.includes("/") || name.includes("\\") || name.includes("..")) return undefined;
		const file = path.join(this.dir, SNAPSHOTS_DIR, projectId, name);
		try {
			if (name.endsWith(".gz")) {
				const raw = await readFile(file);
				const parsed = JSON.parse(gunzipSync(raw).toString("utf8")) as {
					project?: unknown;
					bodies?: Record<string, DraftBody>;
				};
				const project = normalizeProject(parsed.project);
				const bodies: Record<string, DraftBody> = {};
				for (const [chapterId, body] of Object.entries(parsed.bodies ?? {})) {
					if (!body || typeof body.content !== "string") continue;
					bodies[chapterId] = {
						content: body.content,
						history: Array.isArray(body.history) ? body.history : [],
					};
				}
				return { project, bodies };
			}
			// 老快照：正文内联在 drafts 里。
			const raw = await readFile(file, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const project = normalizeProject(parsed);
			const bodies: Record<string, DraftBody> = {};
			for (const [chapterId, draft] of Object.entries(extractLegacyDrafts(parsed))) {
				bodies[chapterId] = { content: draft.content, history: draft.history };
			}
			return { project, bodies };
		} catch {
			return undefined;
		}
	}

	/**
	 * 重试挂起工程的落盘。
	 *
	 * 磁盘满、文件被占用这类故障常常是暂时的。让启动流程和显式调用都过一遍这里，
	 * 用户不用等到下次编辑才发现上一稿没存上。
	 */
	async retryPending(): Promise<void> {
		for (const [id, pending] of [...this.dirty]) {
			const project = this.projects.get(id);
			if (!project) {
				this.dirty.delete(id);
				continue;
			}
			// 正文写在别处（.txt 与 .hist/），骨架无论如何都会再写一遍。
			await this.persist(project);
		}
		// 上一轮没写进磁盘的正文：手里还留着原文，趁这时补写。
		for (const [projectId, chapters] of [...this.pendingBodies]) {
			for (const [chapterId, body] of [...chapters]) {
				try {
					await this.saveDraftBody(projectId, chapterId, body);
					chapters.delete(chapterId);
					this.clearDirtyChapter(projectId, chapterId);
				} catch (error) {
					console.error("[store] 补写章节正文仍失败（已标记待重试）:", error);
				}
			}
			if (chapters.size === 0) this.pendingBodies.delete(projectId);
		}
	}

	/** 还有哪些工程没存上，供接口查询。 */
	pendingWrites(): string[] {
		return [...this.dirty.keys()];
	}

	/**
	 * 具体是哪几章没存上。主文件失败时该工程仍会出现在 pendingWrites 里，
	 * 这里的章节表可能为空 —— 接口把两者都给出去，前端只用前者。
	 */
	pendingChapterWrites(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [id, pending] of this.dirty) out[id] = [...pending.chapters];
		return out;
	}

	private pendingOf(projectId: string): PendingWrites {
		let pending = this.dirty.get(projectId);
		if (!pending) {
			pending = { project: false, chapters: new Set() };
			this.dirty.set(projectId, pending);
		}
		return pending;
	}

	/** 记下某一章没写进磁盘。 */
	private markDirtyChapter(projectId: string, chapterId: string): void {
		this.pendingOf(projectId).chapters.add(chapterId);
	}

	/** 记下主文件没写进磁盘。 */
	private markDirtyProject(projectId: string): void {
		this.pendingOf(projectId).project = true;
	}

	/** 某章写成功只摘这一章的标记，别的失败章继续留着。 */
	private clearDirtyChapter(projectId: string, chapterId: string): void {
		const pending = this.dirty.get(projectId);
		if (!pending) return;
		pending.chapters.delete(chapterId);
		this.dropDirtyIfClean(projectId, pending);
	}

	/** 主文件写成功只摘主文件的标记。 */
	private clearDirtyProject(projectId: string): void {
		const pending = this.dirty.get(projectId);
		if (!pending) return;
		pending.project = false;
		this.dropDirtyIfClean(projectId, pending);
	}

	private dropDirtyIfClean(projectId: string, pending: PendingWrites): void {
		if (!pending.project && pending.chapters.size === 0) this.dirty.delete(projectId);
	}
}
