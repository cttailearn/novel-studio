/**
 * 小说工程的磁盘持久化实现。
 *
 * 纯模型（类型、归一化、派生计算）在 project.ts —— 那一层不碰文件系统，
 * 所以浏览器端的 IndexedDB 实现（IdbProjectStore）可以照着同一个接口重写一遍。
 * 本文件只负责把那些模型落到 data/ 目录：骨架一份、正文按章一份、历史按版一份。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	MAX_DRAFT_HISTORY,
	countWords,
	draftMeta,
	emptyProject,
	encodeFileName,
	extractLegacyDrafts,
	newId,
	normalizeProject,
	projectStats,
	type ChapterDraft,
	type ChapterMeta,
	type DeletedProject,
	type DraftBody,
	type DraftRevision,
	type Project,
	type ProjectStats,
} from "./project.ts";
import type { ProjectStorePort } from "./store-port.ts";

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
export class ProjectStore implements ProjectStorePort {
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
		const tmp = file + "." + newId() + ".tmp";
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
		const tmp = file + "." + newId() + ".tmp";
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
		const tmp = file + "." + newId() + ".tmp";
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

/** 章节正文子目录名。正文按章拆文件后落在 data/drafts/<projectId>/ 下。 */
const DRAFTS_DIR = "drafts";

/** 整部作品的快照目录，落在 data/snapshots/<projectId>/ 下。 */
const SNAPSHOTS_DIR = "snapshots";

/** 已删除作品的完整目录，默认移到这里而不是永久删除。 */
const TRASH_DIR = "trash";

/** 每部作品保留的快照数上限。 */
const MAX_SNAPSHOTS = 20;
