import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

/** 每部作品保留的快照数上限。 */
const MAX_SNAPSHOTS = 20;

/**
 * 记下当前各章 draft 的对象引用与版本号，用于事后判断哪几章被改过。
 *
 * 只比引用和版本号，不比内容：正文动辄数万字，逐字比较会把每次 mutate
 * 都变成一次全书扫描，拆文件省下的时间又还回去了。
 */
function snapshotDrafts(project: Project): Map<string, { ref: ChapterDraft; revision: number }> {
	return new Map(Object.entries(project.drafts).map(([id, draft]) => [id, { ref: draft, revision: draft.revision }]));
}

/** 比对前后快照，返回需要重写的章 id（含被删除的章）。 */
function changedChapters(
	before: Map<string, { ref: ChapterDraft; revision: number }>,
	project: Project,
): Set<string> {
	const changed = new Set<string>();
	for (const [id, draft] of Object.entries(project.drafts)) {
		const prev = before.get(id);
		if (!prev || prev.ref !== draft || prev.revision !== draft.revision) changed.add(id);
	}
	// 消失的章也要落盘一次：writeChapterFile 见到 undefined 才会删掉那个文件。
	for (const id of before.keys()) {
		if (!(id in project.drafts)) changed.add(id);
	}
	return changed;
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

/** 主文件不带正文：正文按章单独落盘，这里剥掉以免又写一遍。 */
function stripDrafts(project: Project): Omit<Project, "drafts"> & { drafts: Record<string, never> } {
	return { ...project, drafts: {} };
}
/**
 * 素材种类。
 *
 * 这个集合是刻意收窄的：它决定智能体怎么找料、界面怎么分组。
 * 加一个新种类之前先问：已有的种类里，换一个 title 和 tags 能不能装下？
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
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = {
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

export interface OutlineChapter {
	id: string;
	title: string;
	summary: string;
	pov: string;
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

export interface ChapterDraft {
	id: string;
	title: string;
	content: string;
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
	outline: OutlineChapter[];
	drafts: Record<string, ChapterDraft>;
	notes: ContinuityNote[];
	createdAt: number;
	updatedAt: number;
}

const CHAPTER_STATUSES: readonly ChapterStatus[] = ["planned", "outlined", "drafting", "drafted", "revising", "done"];

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
	const kind = MATERIAL_KINDS.includes(input.kind as MaterialKind) ? (input.kind as MaterialKind) : "other";
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

export function normalizeProject(raw: unknown): Project {
	const base = emptyProject();
	if (!raw || typeof raw !== "object") return base;
	const input = raw as Record<string, unknown>;

	const migrated = migrateLegacy(input);
	const materials = Array.isArray(input.materials)
		? input.materials.map(normalizeMaterial).filter((item): item is Material => item !== undefined)
		: [];

	const outline = Array.isArray(input.outline)
		? input.outline.filter((c): c is OutlineChapter => Boolean(c) && typeof c === "object").map((chapter) => ({
			id: typeof chapter.id === "string" && chapter.id ? chapter.id : randomUUID(),
			title: typeof chapter.title === "string" ? chapter.title : "未命名章节",
			summary: typeof chapter.summary === "string" ? chapter.summary : "",
			pov: typeof chapter.pov === "string" ? chapter.pov : "",
			status: CHAPTER_STATUSES.includes(chapter.status) ? chapter.status : "planned",
			targetWords: typeof chapter.targetWords === "number" && chapter.targetWords > 0 ? Math.floor(chapter.targetWords) : 0,
			notes: typeof chapter.notes === "string" ? chapter.notes : "",
			materialIds: Array.isArray(chapter.materialIds)
				? chapter.materialIds.filter((value: unknown): value is string => typeof value === "string")
				: [],
		}))
		: [];

	const drafts: Record<string, ChapterDraft> = {};
	if (input.drafts && typeof input.drafts === "object") {
		for (const [key, value] of Object.entries(input.drafts as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const draft = value as Partial<ChapterDraft>;
			drafts[key] = {
				id: typeof draft.id === "string" ? draft.id : key,
				title: typeof draft.title === "string" ? draft.title : "",
				content: typeof draft.content === "string" ? draft.content : "",
				revision: typeof draft.revision === "number" ? draft.revision : 1,
				updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : Date.now(),
				materialIds: Array.isArray(draft.materialIds)
					? draft.materialIds.filter((v): v is string => typeof v === "string")
					: [],
				// 老工程没有 history 字段，缺省为空数组：升级后第一次覆盖才开始留档。
				// 用 flatMap 而非 filter+map：filter 不收窄 content 的类型，
				// 运行时"确实是 string"这个判断只有 flatMap 里的分支能表达。
				history: Array.isArray(draft.history)
					? draft.history
							.flatMap((h): DraftRevision[] => {
								if (!h || typeof h !== "object" || typeof h.content !== "string") return [];
								return [
									{
										revision: typeof h.revision === "number" ? h.revision : 0,
										title: typeof h.title === "string" ? h.title : "",
										content: h.content,
										materialIds: Array.isArray(h.materialIds)
											? h.materialIds.filter((v): v is string => typeof v === "string")
											: [],
										updatedAt: typeof h.updatedAt === "number" ? h.updatedAt : Date.now(),
										mode: typeof h.mode === "string" ? h.mode : "rewrite",
									},
								];
							})
							.slice(-MAX_DRAFT_HISTORY)
					: [],
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
		outline,
		drafts,
		notes: Array.isArray(input.notes)
			? input.notes.map(normalizeNote).filter((n): n is ContinuityNote => n !== undefined)
			: [],
		createdAt: typeof input.createdAt === "number" ? input.createdAt : base.createdAt,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : base.updatedAt,
	};
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
	const words = Object.values(project.drafts).reduce((sum, draft) => sum + countWords(draft.content), 0);
	return {
		chapters: project.outline.length,
		words,
		materials: project.materials.length,
		coveredChapters: project.outline.filter((chapter) => chapter.materialIds.length > 0).length,
		draftedChapters: Object.keys(project.drafts).length,
		openNotes: project.notes.filter((note) => note.status === "open").length,
	};
}

/** 按种类分组，界面与提示词都用它。 */
export function groupByKind(materials: readonly Material[]): Map<MaterialKind, Material[]> {
	const groups = new Map<MaterialKind, Material[]>();
	for (const kind of MATERIAL_KINDS) groups.set(kind, []);
	for (const material of materials) groups.get(material.kind)?.push(material);
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

	private readonly dir: string;

	private constructor(dir: string) {
		this.dir = dir;
	}

	/** 章节正文目录：data/drafts/<projectId>/<encoded chapterId>.json */
	private draftDir(projectId: string): string {
		return path.join(this.dir, DRAFTS_DIR, projectId);
	}

	private draftFile(projectId: string, chapterId: string): string {
		return path.join(this.draftDir(projectId), encodeFileName(chapterId) + ".json");
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
		// 不显式给 changed 时按全量写：用于新建与全量重试。
		const chapters = new Set(changed ?? Object.keys(project.drafts));
		const previous = this.writeChains.get(project.id) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				// 顺序要紧：先把章节文件写落，再剥主文件里的正文。
				// 反过来（先写主文件）一旦中途崩溃，主文件已不带正文而章节文件还没写全，
				// 重启后读到的就是一部没有正文的书 —— 迁移本身成了丢数据的动作。
				// 先写章节文件则最坏情况只是多留一份冗余，下一轮会覆盖。
				for (const chapterId of chapters) {
					try {
						await this.writeChapterFile(project.id, chapterId, project.drafts[chapterId]);
						// 只摘这一章的标记：别的失败章要继续留着等重试。
						this.clearDirtyChapter(project.id, chapterId);
					} catch (error) {
						this.markDirtyChapter(project.id, chapterId);
						console.error("[store] 落盘 " + project.id + " 章 " + chapterId + " 失败（已标记待重试）:", error);
					}
				}
				try {
					await this.writeAtomic(file, stripDrafts(project));
					this.clearDirtyProject(project.id);
				} catch (error) {
					this.markDirtyProject(project.id);
					console.error("[store] 落盘 " + file + " 失败（已标记待重试）:", error);
				}
			})
			.catch((error) => {
				// 兜底：上面每一步都自己接住了错误，走到这里说明是意料之外的故障。
				this.markDirtyProject(project.id);
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

	/** 章节正文单文件落盘；draft 为 undefined 表示这一章被删了。 */
	private async writeChapterFile(projectId: string, chapterId: string, draft: ChapterDraft | undefined): Promise<void> {
		const file = this.draftFile(projectId, chapterId);
		if (!draft) {
			await rm(file, { force: true });
			return;
		}
		await mkdir(path.dirname(file), { recursive: true });
		await this.writeAtomic(file, draft);
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
					try {
					// normalizeProject 会把主文件里内联的旧 drafts 一并读出来（首次迁移的来源），
					// 这里再叠加按章存放的文件；章节文件优先，它才是拆分后的权威副本。
					const project = normalizeProject(JSON.parse(raw));
					const fromFiles = await store.loadDrafts(project);
					project.drafts = { ...project.drafts, ...fromFiles };
					store.projects.set(project.id, project);
					// 老工程第一次打开时把内联正文拆成按章文件，随后主文件不再带正文。
					// persist 内部先写章节文件再剥主文件，中途失败也只是多留一份冗余。
					if (Object.keys(project.drafts).length > 0) void store.persist(project);
					await store.sweepTemp(path.join(dir, DRAFTS_DIR, project.id));
					} catch (error) {
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
	 * 只重写这一轮真正动过的章：先记住各章 draft 的对象引用与版本号，
	 * 回调跑完再比一遍。正文已按章拆文件，这里若仍全量重写，
	 * 一次改标题也会把几十 MB 的正文全部写一遍，等于拆分没做。
	 */
	mutate(id: string, mutate: (project: Project) => void): Project {
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		const before = snapshotDrafts(project);
		mutate(project);
		project.updatedAt = Date.now();
		void this.persist(project, changedChapters(before, project));
		return project;
	}

	/** 读出按章存放的正文。损坏的章节文件隔离保留，不牵连整部作品。 */
	private async loadDrafts(project: Project): Promise<Record<string, ChapterDraft>> {
		const out: Record<string, ChapterDraft> = {};
		const dir = path.join(this.dir, DRAFTS_DIR, project.id);
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			const raw = await readFile(file, "utf8").catch(() => undefined);
			if (raw === undefined) continue;
			try {
				const draft = JSON.parse(raw) as ChapterDraft;
				if (typeof draft?.id !== "string" || typeof draft.content !== "string") {
					throw new Error("章节正文缺少 id 或 content");
				}
				out[draft.id] = {
					...draft,
					history: Array.isArray(draft.history) ? draft.history.slice(-MAX_DRAFT_HISTORY) : [],
					materialIds: Array.isArray(draft.materialIds) ? draft.materialIds : [],
				};
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
	 * 删除工程，连同它的章节正文与快照目录。
	 *
	 * 章节正文拆成独立目录后，只删主文件会留下一堆孤儿目录；
	 * 快照则是误删的退路，删作品时一并清掉，不给"当初为什么留着这个"留疑问。
	 */
	remove(id: string): Promise<void> {
		this.projects.delete(id);
		this.dirty.delete(id);
		return Promise.all([
			rm(path.join(this.dir, id + ".json"), { force: true }),
			rm(path.join(this.dir, DRAFTS_DIR, id), { recursive: true, force: true }),
			rm(path.join(this.dir, SNAPSHOTS_DIR, id), { recursive: true, force: true }),
		]).then(() => undefined);
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
	 */
	async snapshot(project: Project, label = ""): Promise<string> {
		const dir = path.join(this.dir, SNAPSHOTS_DIR, project.id);
		await mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = stamp + (label ? "-" + encodeFileName(label) : "") + ".json";
		await this.writeAtomic(path.join(dir, name), project);
		await this.trimSnapshots(project.id, dir);
		return name;
	}

	/** 快照只留最近若干份，旧的清掉，避免 data 目录无限膨胀。 */
	private async trimSnapshots(projectId: string, dir: string): Promise<void> {
		const names = (await readdir(dir).catch(() => [] as string[]))
			.filter((name) => name.endsWith(".json"))
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
		const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort().reverse();
		const out: { name: string; at: number; size: number }[] = [];
		for (const name of names) {
			const info = await stat(path.join(dir, name)).catch(() => undefined);
			if (!info) continue;
			out.push({ name, at: info.mtimeMs, size: info.size });
		}
		return out;
	}

	/** 读回一份快照，供回滚使用。文件损坏时返回 undefined 而不是抛错。 */
	async readSnapshot(projectId: string, name: string): Promise<Project | undefined> {
		// 文件名来自 listSnapshots，但仍要挡一手路径穿越。
		if (name.includes("/") || name.includes("\\") || name.includes("..")) return undefined;
		const raw = await readFile(path.join(this.dir, SNAPSHOTS_DIR, projectId, name), "utf8").catch(() => undefined);
		if (raw === undefined) return undefined;
		try {
			return normalizeProject(JSON.parse(raw));
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
			// 只重试真正失败的那几章；主文件无论如何都会再写一遍。
			await this.persist(project, new Set(pending.chapters));
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
