/**
 * 小说拆解库的磁盘实现。
 *
 * 目录布局：
 *   data/material-sources/<sourceId>/meta.json
 *   data/material-sources/<sourceId>/chapters/ch001.txt
 *
 * 普通资料也按单章保存，与整本小说共用同一套读取/检索/备份逻辑。
 * meta.json 只放章节名/字数；正文按章独立文件，列表接口不会把整本书读进内存。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	chapterIdAt,
	makeNovelSourceMeta,
	normalizeNovelSourceMeta,
	searchNovelChapter,
	splitNovelText,
	queryTokens,
	type NovelChapter,
	type NovelSearchHit,
	type NovelSearchOptions,
	type NovelSourceInput,
	type NovelSourceMeta,
} from "./novel-source.ts";
import type { NovelSourceStorePort } from "./store-port.ts";

function cloneMeta(meta: NovelSourceMeta): NovelSourceMeta {
	return { ...meta, chapters: meta.chapters.map((chapter) => ({ ...chapter })) };
}

export class NovelSourceLibrary implements NovelSourceStorePort {
	private readonly root: string;
	private sources: NovelSourceMeta[];
	private readonly chapterCache = new Map<string, Map<string, string>>();

	private constructor(root: string, sources: NovelSourceMeta[]) {
		this.root = root;
		this.sources = sources;
	}

	static async open(dataDir: string): Promise<NovelSourceLibrary> {
		const root = path.join(dataDir, "material-sources");
		await mkdir(root, { recursive: true });
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		const sources: NovelSourceMeta[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const raw = await readFile(path.join(root, entry.name, "meta.json"), "utf8").catch(() => undefined);
			if (raw === undefined) continue;
			try {
				const meta = normalizeNovelSourceMeta(JSON.parse(raw));
				if (meta) sources.push(meta);
			} catch {
				// 单本损坏不影响其它书；正文仍在磁盘上，作者可手动检查。
				console.error("[material-source] 跳过损坏的 meta.json:", entry.name);
			}
		}
		sources.sort((a, b) => b.updatedAt - a.updatedAt);
		return new NovelSourceLibrary(root, sources);
	}

	list(): NovelSourceMeta[] {
		return this.sources.map(cloneMeta);
	}

	get(id: string): NovelSourceMeta | undefined {
		const source = this.sources.find((item) => item.id === id);
		return source ? cloneMeta(source) : undefined;
	}

	async create(input: NovelSourceInput): Promise<NovelSourceMeta> {
		const kind = input.kind === "document" ? "document" : "novel";
		const split = splitNovelText(input.text, {
			splitMode: kind === "document" ? "single" : input.splitMode,
			fixedChars: input.fixedChars,
		});
		const meta = makeNovelSourceMeta({ ...input, kind }, split);
		const dir = path.join(this.root, meta.id);
		try {
			// 先写章节、最后写 meta.json。中途失败时删掉半成品目录；
			// meta 是“这本书存在”的唯一标志，最后落盘可避免列出不完整的书。
			await mkdir(path.join(dir, "chapters"), { recursive: true });
			const cache = new Map<string, string>();
			for (let i = 0; i < split.chapters.length; i++) {
				const chapter = split.chapters[i]!;
				const id = chapterIdAt(i);
				await writeFile(path.join(dir, "chapters", `${id}.txt`), chapter.content, "utf8");
				cache.set(id, chapter.content);
			}
			await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
			this.chapterCache.set(meta.id, cache);
			this.sources.unshift(meta);
			return cloneMeta(meta);
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async remove(id: string): Promise<boolean> {
		const index = this.sources.findIndex((item) => item.id === id);
		if (index < 0) return false;
		await rm(path.join(this.root, id), { recursive: true, force: true });
		this.sources.splice(index, 1);
		this.chapterCache.delete(id);
		return true;
	}

	async readChapter(sourceId: string, chapterId: string): Promise<NovelChapter | undefined> {
		const source = this.sources.find((item) => item.id === sourceId);
		const chapter = source?.chapters.find((item) => item.id === chapterId);
		if (!source || !chapter) return undefined;
		const content = await this.readContent(sourceId, chapterId);
		if (content === undefined) return undefined;
		return { id: chapter.id, index: chapter.index, title: chapter.title, content, chars: chapter.chars };
	}

	async search(sourceId: string, query: string, options: NovelSearchOptions = {}): Promise<NovelSearchHit[]> {
		const source = this.sources.find((item) => item.id === sourceId);
		if (!source) return [];
		const tokens = queryTokens(query);
		if (tokens.length === 0) return [];
		const hits: NovelSearchHit[] = [];
		for (const chapter of source.chapters) {
			const content = await this.readContent(sourceId, chapter.id);
			if (content === undefined) continue;
			const hit = searchNovelChapter(
				{ id: chapter.id, index: chapter.index, title: chapter.title, content, chars: chapter.chars },
				tokens,
			);
			if (hit) hits.push(hit);
		}
		hits.sort((a, b) => b.score - a.score || a.chapterId.localeCompare(b.chapterId));
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
		return hits.slice(offset, offset + limit);
	}

	async flush(): Promise<void> {
		// create/remove 都等待文件写完后才返回，没有排队写入。
	}

	private async readContent(sourceId: string, chapterId: string): Promise<string | undefined> {
		let cache = this.chapterCache.get(sourceId);
		if (!cache) {
			cache = new Map();
			this.chapterCache.set(sourceId, cache);
		}
		const cached = cache.get(chapterId);
		if (cached !== undefined) return cached;
		const content = await readFile(path.join(this.root, sourceId, "chapters", `${chapterId}.txt`), "utf8").catch(() => undefined);
		if (content !== undefined) cache.set(chapterId, content);
		return content;
	}
}

/** 兼容旧命名：外部只把它当 NovelSourceStorePort 用。 */
export type NovelSourceStore = NovelSourceStorePort;
export const MaterialSourceLibrary = NovelSourceLibrary;
