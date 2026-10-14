import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type ChapterStatus = "planned" | "outlined" | "drafting" | "drafted" | "revising" | "done";
export type NoteSeverity = "info" | "warning" | "blocker";
export type NoteStatus = "open" | "resolved";
/** 素材来源：书者手写 / 墨客所拟 / 取自通用素材库。 */
export type MaterialSource = "human" | "agent" | "library";
export type MaterialStatus = "draft" | "confirmed";

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

export interface ChapterDraft {
	id: string;
	title: string;
	content: string;
	revision: number;
	updatedAt: number;
	/** 写作时装配了哪些素材，用于回溯"这段正文是从什么料来的"。 */
	materialIds: string[];
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
		notes: Array.isArray(input.notes) ? (input.notes as ContinuityNote[]) : [],
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

/**
 * 小说工程的持久化存储。
 * 内存为主，每次写入后异步落盘为一个 JSON 文件。
 */
export class ProjectStore {
	private readonly projects = new Map<string, Project>();
	/** 同一项目的写入串行化，避免并发落盘相互覆盖。 */
	private readonly writeChains = new Map<string, Promise<void>>();

	private readonly dir: string;

	private constructor(dir: string) {
		this.dir = dir;
	}

	static async open(dir: string): Promise<ProjectStore> {
		await mkdir(dir, { recursive: true });
		const store = new ProjectStore(dir);
		const entries = await readdir(dir).catch(() => [] as string[]);
		await Promise.all(
			entries
				.filter(
					(name) =>
						name.endsWith(".json") &&
						name !== "settings.json" &&
						name !== "credentials.json" &&
						// 通用素材库是跨作品的另一个文件，别当成一部作品读进来。
						name !== "library.json",
				)
				.map(async (name) => {
					const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
					if (raw === undefined) return;
					try {
						const project = normalizeProject(JSON.parse(raw));
						store.projects.set(project.id, project);
					} catch (error) {
						console.warn("[store] 跳过解析失败的工程文件 " + name + ":", error);
					}
				}),
		);
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

	/** 在原对象上实施变更并落盘。传入的对象不应在外部长期持有。 */
	mutate(id: string, mutate: (project: Project) => void): Project {
		const project = this.projects.get(id);
		if (!project) throw new Error("工程 " + id + " 不存在");
		mutate(project);
		project.updatedAt = Date.now();
		void this.persist(project);
		return project;
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

	remove(id: string): Promise<void> {
		this.projects.delete(id);
		return rm(path.join(this.dir, id + ".json"), { force: true });
	}

	stats(project: Project): ProjectStats {
		return projectStats(project);
	}

	private persist(project: Project): Promise<void> {
		const file = path.join(this.dir, project.id + ".json");
		const previous = this.writeChains.get(project.id) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => writeFile(file, JSON.stringify(project, null, 2), "utf8"))
			.catch((error) => console.error("[store] 落盘 " + file + " 失败:", error))
			.then(() => undefined);
		this.writeChains.set(project.id, next);
		return next;
	}
}
