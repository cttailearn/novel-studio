// 上传原料的文本提取。
//
// 只做"把文件里的字拿出来"这一件事，不落盘、不建素材 ——
// 提取结果交回前端预览，作者确认后才决定是存成素材还是交给墨客提炼。
//
// 支持两类：
//   · 纯文本家族（txt / md / csv / json / html …）直接按 UTF-8 解码
//   · .docx 自己解 zip 再剥 XML（Word 文档是最常见的资料载体，值得为它写这几十行）
// 其余格式（pdf / epub / doc 老格式）明确拒绝，而不是塞一堆乱码给模型。
//
// 这一层要同时跑在 Node 与浏览器里，所以：
//   · 只用 Uint8Array + DataView，不碰 Buffer
//   · 解压走标准 CompressionStream（Node 18+ 与浏览器都有），不用 node:zlib
//   · 解压是异步的，extractText 因此返回 Promise

/** 提取结果的字数上限。超出部分截断，并如实回报。 */
export const MAX_TEXT_CHARS = 200_000;
/** 上传体积上限（字节）。 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/**
 * docx 解压后的体积上限（字节）。
 *
 * 32 MB 的压缩包可以解出几个 GB —— 解压前必须先设上限，
 * 否则一个 zip 炸弹就能把进程内存吃光。
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export interface ExtractedText {
	/** 建议的素材标题：文件名去掉扩展名。 */
	title: string;
	text: string;
	/** 识别出的格式，用于前端提示。 */
	format: "text" | "docx";
	/** 原始字符数（截断前）。 */
	originalChars: number;
	/** 是否因为超长被截断。 */
	truncated: boolean;
}

export class UnsupportedUploadError extends Error {}

/** 上传或解压后的体积超过上限。单独一类是为了让接口回 413 而不是 415。 */
export class UploadTooLargeError extends Error {}

const TEXT_EXTENSIONS = new Set([
	".txt", ".text", ".md", ".markdown", ".log",
	".csv", ".tsv", ".json", ".yaml", ".yml",
	".html", ".htm", ".xml",
]);

/** 剥标签前要先把块级边界换成占位符，否则段落会连成一片。 */
const PARA_MARK = "\u0000";

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** XML / HTML 实体解码。认不出的实体原样保留，不要吞掉。 */
function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		let code: number | undefined;
		if (/^#x/i.test(body)) code = Number.parseInt(body.slice(2), 16);
		else if (body.startsWith("#")) code = Number.parseInt(body.slice(1), 10);
		if (code !== undefined) {
			return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body] ?? whole;
	});
}

function normalize(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function htmlToText(html: string): string {
	const marked = html
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)\s*>/gi, PARA_MARK)
		.replace(/<[^>]*>/g, "");
	return decodeEntities(marked).split(PARA_MARK).join("\n");
}

/** docx 正文的 XML → 纯文本。段落靠 `</w:p>` 划界，`<w:br>` / `<w:tab>` 是行内换行与制表。 */
function docxXmlToText(xml: string): string {
	const marked = xml
		.replace(/<w:br\b[^>]*\/?>/gi, "\n")
		.replace(/<w:cr\b[^>]*\/?>/gi, "\n")
		.replace(/<w:tab\b[^>]*\/?>/gi, "\t")
		.replace(/<\/w:p\s*>/gi, PARA_MARK)
		.replace(/<w:p\b[^>]*\/>/gi, PARA_MARK)
		.replace(/<\/w:tc\s*>/gi, "\t");
	return decodeEntities(marked.replace(/<[^>]*>/g, "")).split(PARA_MARK).join("\n");
}

interface ZipEntry {
	name: string;
	method: number;
	/** 压缩后字节数（中央目录声明）。 */
	compressedSize: number;
	/** 解压后字节数（中央目录声明，可能被恶意文件伪造）。 */
	uncompressedSize: number;
	localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** UTF-8 解码器。文本家族与 docx 正文都用它。 */
const decoder = new TextDecoder("utf-8");

/**
 * 只读 zip 目录。docx 是标准 zip，而我们要的 word/document.xml 通常没有加密，
 * 所以按中央目录走一遍就够，不需要完整的 zip 实现。
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 中央目录尾部记录（EOCD）在文件末尾，可能跟一段注释，所以从后往前找签名。
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
		if (view.getUint32(i, true) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new UnsupportedUploadError("这个文件不是 zip 结构，可能已损坏或不是 .docx");

	const count = view.getUint16(eocd + 10, true);
	let cursor = view.getUint32(eocd + 16, true);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break;
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		// 目录项本身也可能越界：Read 前先确认整条记录（含文件名/扩展/注释）都在文件里，
		// 否则 toString 会悄悄截断，把一条坏记录当成合法条目。
		if (cursor + 46 + nameLength + extraLength + commentLength > bytes.length) break;
		entries.push({
			name: decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
			method: view.getUint16(cursor + 10, true),
			compressedSize: view.getUint32(cursor + 20, true),
			uncompressedSize: view.getUint32(cursor + 24, true),
			localOffset: view.getUint32(cursor + 42, true),
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/**
 * 解一段 raw deflate 数据。
 *
 * 上限在读取过程中把关：中央目录声明的体积可以少报，真正的兜底是这里边解边看。
 */
async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
	const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new UploadTooLargeError("docx 解压后超过 " + Math.round(maxBytes / 1024 / 1024) + " MB 上限，已拒绝");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof UploadTooLargeError) throw error;
		throw new UnsupportedUploadError("docx 解压失败，文件可能已损坏");
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function readZipFile(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 本地文件头的文件名/扩展字段长度可能与中央目录不同，必须重新读一遍。
	// 偏移与长度全部来自文件本身，先做边界检查：越界读不会抛可读的错误，
	// 要么是 RangeError（接口变 500），要么读到垃圾数据。
	if (entry.localOffset + 30 > bytes.length) {
		throw new UnsupportedUploadError("docx 的 zip 目录指向了文件之外，文件可能已损坏");
	}
	const nameLength = view.getUint16(entry.localOffset + 26, true);
	const extraLength = view.getUint16(entry.localOffset + 28, true);
	const start = entry.localOffset + 30 + nameLength + extraLength;
	const end = start + entry.compressedSize;
	if (start > bytes.length || end > bytes.length) {
		throw new UnsupportedUploadError("docx 的 zip 条目越界，文件可能已损坏");
	}
	// 中央目录声明的解压体积先挡一道；真正的兜底是 inflateRaw 边解边看，
	// 因为恶意文件可以少报体积、让压缩流自己膨胀。
	if (entry.uncompressedSize > MAX_INFLATED_BYTES) {
		throw new UploadTooLargeError("docx 解压后超过 " + Math.round(MAX_INFLATED_BYTES / 1024 / 1024) + " MB 上限，已拒绝");
	}
	const raw = bytes.subarray(start, end);
	if (entry.method === 0) {
		if (raw.length > MAX_INFLATED_BYTES) {
			throw new UploadTooLargeError("docx 解压后超过 " + Math.round(MAX_INFLATED_BYTES / 1024 / 1024) + " MB 上限，已拒绝");
		}
		return raw;
	}
	if (entry.method === 8) {
		return inflateRaw(raw, MAX_INFLATED_BYTES);
	}
	throw new UnsupportedUploadError("docx 使用了不支持的压缩方式（method " + entry.method + "）");
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
	const entries = readZipEntries(bytes);
	const document = entries.find((entry) => entry.name === "word/document.xml");
	if (!document) throw new UnsupportedUploadError("这个 .docx 里没有 word/document.xml，可能不是 Word 文档");
	return docxXmlToText(decoder.decode(await readZipFile(bytes, document)));
}

/** 扩展名，小写并带点。没有扩展名时返回空串。 */
export function extensionOf(filename: string): string {
	const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** 文件名 → 建议标题：去掉扩展名，其余原样（中文文件名不能动）。 */
export function titleFromFilename(filename: string): string {
	const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
	const ext = extensionOf(base);
	return (ext ? base.slice(0, -ext.length) : base).trim() || "上传的原料";
}

/**
 * 从上传的字节里取出文本。
 *
 * 编码只认 UTF-8：猜测 GBK 会引入静默乱码，宁可让作者看到乱码再改存为 UTF-8。
 *
 * 因为 docx 的解压是异步的（标准 CompressionStream 是流式 API），
 * 这个函数返回 Promise。调用方 await 一下即可。
 */
export async function extractText(filename: string, bytes: Uint8Array): Promise<ExtractedText> {
	const ext = extensionOf(filename);
	const title = titleFromFilename(filename);

	let text: string;
	let format: ExtractedText["format"];
	if (ext === ".docx") {
		text = await extractDocx(bytes);
		format = "docx";
	} else if (TEXT_EXTENSIONS.has(ext)) {
		const decoded = decoder.decode(bytes);
		text = ext === ".html" || ext === ".htm" || ext === ".xml" ? htmlToText(decoded) : decoded;
		format = "text";
	} else {
		throw new UnsupportedUploadError(
			ext
				? "暂不支持 " + ext + " 格式。请先转成 .txt / .md / .docx 再上传。"
				: "这个文件没有扩展名，无法判断格式。请先转成 .txt / .md / .docx 再上传。",
		);
	}

	const cleaned = normalize(text);
	if (!cleaned) throw new UnsupportedUploadError("这个文件里没有可提取的文字");
	const truncated = cleaned.length > MAX_TEXT_CHARS;
	return {
		title,
		text: truncated ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned,
		format,
		originalChars: cleaned.length,
		truncated,
	};
}
