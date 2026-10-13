import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ChapterStatus = "planned" | "outlined" | "drafting" | "drafted" | "revising" | "done";
export type NoteSeverity = "info" | "warning" | "blocker";
export type NoteStatus = "open" | "resolved";

export interface Character {
	id: string;
	name: string;
	aliases: string[];
	role: string;
	appearance: string;
	personality: string;
	background: string;
	relations: string[];
	arc: string;
	notes: string;
}

export interface WorldFact {
	id: string;
	category: string;
	title: string;
	content: string;
	tags: string[];
}

export interface OutlineChapter {
	id: string;
	title: string;
	summary: string;
	pov: string;
	status: ChapterStatus;
	targetWords: number;
	notes: string;
}

export interface ChapterDraft {
	id: string;
	title: string;
	content: string;
	revision: number;
	updatedAt: number;
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
	characters: Character[];
	worldFacts: WorldFact[];
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
		characters: [],
		worldFacts: [],
		outline: [],
		drafts: {},
		notes: [],
		createdAt: now,
		updatedAt: now,
	};
}

function normalizeProject(raw: unknown): Project {
	const base = emptyProject();
	if (!raw || typeof raw !== "object") return base;
	const input = raw as Partial<Project>;
	return {
		...base,
		...input,
		id: typeof input.id === "string" ? input.id : base.id,
		characters: Array.isArray(input.characters) ? input.characters : [],
		worldFacts: Array.isArray(input.worldFacts) ? input.worldFacts : [],
		outline: Array.isArray(input.outline)
			? input.outline.map((chapter) => ({
					...chapter,
					status: CHAPTER_STATUSES.includes(chapter.status) ? chapter.status : "planned",
				}))
			: [],
		drafts: input.drafts && typeof input.drafts === "object" ? input.drafts : {},
		notes: Array.isArray(input.notes) ? input.notes : [],
		createdAt: typeof input.createdAt === "number" ? input.createdAt : base.createdAt,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : base.updatedAt,
	};
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
				.filter((name) => name.endsWith(".json"))
				.map(async (name) => {
					const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
					if (raw === undefined) return;
					try {
						const project = normalizeProject(JSON.parse(raw));
						store.projects.set(project.id, project);
					} catch (error) {
						console.warn(`[store] 跳过解析失败的工程文件 ${name}:`, error);
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
		if (!project) throw new Error(`工程 ${id} 不存在`);
		mutate(project);
		project.updatedAt = Date.now();
		void this.persist(project);
		return project;
	}

	/** 消除作品所有派生数据的字段，用于界面展示。 */
	stats(project: Project): { chapters: number; words: number; characters: number; worldFacts: number; openNotes: number } {
		const words = Object.values(project.drafts).reduce((sum, draft) => sum + countWords(draft.content), 0);
		return {
			chapters: project.outline.length,
			words,
			characters: project.characters.length,
			worldFacts: project.worldFacts.length,
			openNotes: project.notes.filter((note) => note.status === "open").length,
		};
	}

	private persist(project: Project): Promise<void> {
		const file = path.join(this.dir, `${project.id}.json`);
		const previous = this.writeChains.get(project.id) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => writeFile(file, JSON.stringify(project, null, 2), "utf8"))
			.catch((error) => console.error(`[store] 落盘 ${file} 失败:`, error))
			.then(() => undefined);
		this.writeChains.set(project.id, next);
		return next;
	}
}
