#!/usr/bin/env node
/**
 * 浏览器构建脚本。
 *
 *   node --experimental-strip-types scripts/browser-build.ts
 *
 * 目标：把我们自己的 TypeScript 源码与 vendor 依赖（pi-agent-core / pi-ai）
 * 变成浏览器可以直接 import 的原生 ES 模块，**不需要打包器，也不新增任何 npm 依赖**。
 *
 * 做法：
 *   1. 用 Node 自带的 `module.stripTypeScriptTypes`（mode: "strip"）去掉类型，
 *      再把 import/export 里的 `.ts` 说明符改写成 `.js`；
 *   2. 从入口出发解析相对导入的传递闭包，Node-only 的模块一旦可达就报错；
 *   3. vendor 依赖原样复制，裸说明符（@earendil-works/pi-ai 等）交给
 *      public/index.html 里的 import map 解析；
 *   4. 在 Node 侧生成模型目录 catalog.json（provider 代码绝不进浏览器）。
 *
 * 输出目录默认是 public/browser；如果当前环境对 public/ 没有写权限（某些沙箱
 * 会这样），脚本会退回到一个可写目录并大声提示，避免"看起来构建成功、其实没写进去"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_REL = path.join("public", "browser");

/** 需要进浏览器的入口（相对仓库根，posix 风格）。 */
const ENTRY_POINTS = [
	"src/ai/tools.ts",
	"src/ai/novel-agent.ts",
	"src/ai/prompts.ts",
	"src/ai/web-search.ts",
	"src/ai/llm-client.ts",
	"src/store/project.ts",
	"src/store/store-port.ts",
	"src/store/project-idb.ts",
	"src/store/library.ts",
	"src/store/kinds.ts",
	"src/config/settings.ts",
	"src/server/records.ts",
	"src/server/upload.ts",
];

/** 别的 agent 可能还没写完，缺失只警告不报错。 */
const OPTIONAL_ENTRIES = new Set(["src/ai/llm-client.ts", "src/store/project-idb.ts"]);

/**
 * 这些文件正在被别的 agent 改造成纯逻辑层；如果它们此刻还带 node: 导入，
 * 跳过并警告（而不是让整个构建挂掉）。
 */
const SOFT_SKIP = new Set<string>([]);

/** Node-only 模块：被浏览器可达的代码运行时引用到就直接失败。 */
const FORBIDDEN_MODULES = new Set([
	// 静态 import 了 42 个 pi-ai 内置 provider 与四个厂商 SDK。
	"src/ai/models.ts",
	"src/ai/custom-provider.ts",
	// 真正只该跑在服务器上的进程入口。
	"src/server/main.ts",
	"src/server/llm-relay.ts",
	"src/server/relay-route.ts",
	"src/server/node-http.ts",
	// 读环境变量（node:fs 读 .env）与磁盘实现。
	"src/config/env.ts",
	"src/config/settings-disk.ts",
	"src/config/credential-disk.ts",
]);

/** 浏览器里绝对不该出现的 provider SDK。 */
const FORBIDDEN_BARESPECIFIERS = [
	"openai",
	"@anthropic-ai/sdk",
	"@google/genai",
	"@aws-sdk/",
	"@smithy/",
	"http-proxy-agent",
	"https-proxy-agent",
	"@earendil-works/pi-telemetry",
	"ollama",
];

/** 允许留在产物里、由 import map 解析的裸说明符。 */
const ALLOWED_BARESPECIFIERS = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"typebox/compile",
	"typebox/value",
	"partial-json",
]);

const IMPORT_MAP = {
	"@earendil-works/pi-ai": "/browser/vendor/pi-ai/shim.js",
	"@earendil-works/pi-agent-core": "/browser/vendor/pi-agent-core/index.js",
	"typebox/compile": "/browser/vendor/typebox/compile.js",
	"typebox/value": "/browser/vendor/typebox/value.js",
	"partial-json": "/browser/vendor/partial-json.js",
};

export interface BuildOptions {
	/** 输出目录；不给就用 public/browser，写不进去时自动退让。 */
	outDir?: string;
	quiet?: boolean;
}

export interface BuildReport {
	outDir: string;
	fallback: boolean;
	files: number;
	bytes: number;
	groups: Record<string, { files: number; bytes: number }>;
	warnings: string[];
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function stripTs(source: string): string {
	return nodeModule.stripTypeScriptTypes(source, { mode: "strip" });
}

/**
 * 抓出 import/export 说明符。
 *
 * 只关心两种：以 "." 开头的相对路径，以及 "@earendil-works/pi-ai/utils/" 前缀
 * （构建时会被改写成 vendor 目录里的相对路径）。其余一律原样保留，由 import map 处理。
 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;

function extractSpecifiers(code: string): string[] {
	const found: string[] = [];
	for (const match of code.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[2];
		if (!specifier) continue;
		if (specifier.startsWith(".") || specifier.startsWith("@earendil-works/pi-ai/utils/")) {
			found.push(specifier);
		}
	}
	return found;
}

function extractBareSpecifiers(code: string): string[] {
	const found: string[] = [];
	for (const match of code.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[2];
		if (!specifier) continue;
		if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
		found.push(specifier);
	}
	return found;
}

function hasNodeImport(code: string): boolean {
	return /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])node:/.test(code);
}

/** 把相对说明符解析成仓库内的相对路径（posix 风格）。 */
function resolveRelative(fromRel: string, specifier: string): string {
	const fromDir = path.posix.dirname(fromRel);
	const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
	return joined.startsWith(".") ? joined : `./${joined}`;
}

/**
 * 源文件 → 产物路径（相对输出根，posix 风格）。
 *
 * 少数文件有专门的落点：浏览器里的 pi-ai 入口必须叫 shim.js，typebox 必须拆成
 * compile.js / value.js，local-api 必须落在 public/browser/local-api.js。
 */
function outputPathFor(rel: string): string[] {
	switch (rel) {
		case "src/browser/shim/pi-ai.ts":
			return ["vendor/pi-ai/shim.js"];
		case "src/browser/shim/type.ts":
			return ["vendor/typebox/type.js"];
		case "src/browser/shim/typebox.ts":
			return ["vendor/typebox/compile.js", "vendor/typebox/value.js"];
		case "src/browser/local-api.ts":
			return ["local-api.js"];
		default:
			return [rel.replace(/\.ts$/, ".js")];
	}
}

function relativeSpecifier(fromOut: string, toOut: string): string {
	let rel = path.posix.relative(path.posix.dirname(fromOut), toOut);
	if (!rel.startsWith(".")) rel = `./${rel}`;
	return rel;
}

/** 找到第一个可写的输出目录；public/browser 写不进去时退让到别处。 */
function resolveOutDir(explicit: string | undefined): { outDir: string; fallback: boolean } {
	const candidates: string[] = [];
	if (explicit) {
		candidates.push(path.isAbsolute(explicit) ? explicit : path.join(REPO_ROOT, explicit));
	} else {
		candidates.push(path.join(REPO_ROOT, DEFAULT_OUT_REL));
		candidates.push(path.join(REPO_ROOT, ".dsh-tmp", "browser"));
		candidates.push(path.join(os.tmpdir(), "novel-studio-browser"));
		candidates.push(path.join(REPO_ROOT, "browser-out"));
	}
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			fs.mkdirSync(candidate, { recursive: true });
			const probe = path.join(candidate, ".write-probe");
			fs.writeFileSync(probe, "ok");
			fs.rmSync(probe, { force: true });
			return { outDir: candidate, fallback: candidate !== path.join(REPO_ROOT, DEFAULT_OUT_REL) };
		} catch (err) {
			errors.push(`${candidate}: ${(err as Error).message}`);
		}
	}
	throw new Error(`找不到可写的输出目录：\n${errors.join("\n")}`);
}

/** 列出 src/browser 下的全部 .ts。 */
function listBrowserSources(): string[] {
	const root = path.join(REPO_ROOT, "src", "browser");
	if (!fs.existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile() && entry.name.endsWith(".ts")) {
				out.push(toPosix(path.relative(REPO_ROOT, abs)));
			}
		}
	};
	walk(root);
	return out.sort();
}

/** 把 partial-json 的 CJS 产物机械转换成单个 ESM 文件（不重写算法）。 */
function convertPartialJson(optionsSource: string, indexSource: string): string {
	return [
		"// 由 scripts/browser-build.ts 从 partial-json@0.1.7 的 CommonJS 产物机械转换而来。",
		"// 算法原样保留，只是把 module/exports/require 换成了等价的 ESM 包装。",
		"const __options = (() => {",
		"\tconst module = { exports: {} };",
		"\tconst exports = module.exports;",
		optionsSource,
		"\treturn module.exports;",
		"})();",
		"",
		"const __cjs = (() => {",
		"\tconst module = { exports: {} };",
		"\tconst exports = module.exports;",
		"\tconst require = (id) => {",
		"\t\tif (id === './options') return __options;",
		"\t\tthrow new Error(\"Cannot find module '\" + id + \"'\");",
		"\t};",
		indexSource,
		"\treturn module.exports;",
		"})();",
		"",
		"export const Allow = __cjs.Allow;",
		"export const PartialJSON = __cjs.PartialJSON;",
		"export const MalformedJSON = __cjs.MalformedJSON;",
		"export const parseJSON = __cjs.parseJSON;",
		"export const parse = __cjs.parse;",
		"export default __cjs.default ?? __cjs.Allow ?? __cjs;",
		"",
	].join("\n");
}

interface CatalogModel {
	id?: string;
	name?: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface CatalogProvider {
	id?: string;
	name?: string;
	baseUrl?: string;
	getAllModels?: () => Promise<CatalogModel[]>;
}

interface BuiltinProviderSpec {
	id: string;
	label?: string;
	builtinId?: string;
	envVars?: readonly string[];
	group?: string;
	baseUrl?: string;
	create: () => CatalogProvider;
}

/** 在 Node 侧生成模型目录；provider 代码永远不进浏览器。 */
async function buildCatalog(): Promise<{ catalog: { providers: unknown[] }; warnings: string[] }> {
	const warnings: string[] = [];
	try {
		const imported = (await import(pathToFileURL(path.join(REPO_ROOT, "src", "ai", "models.ts")).href)) as {
			BUILTIN_PROVIDERS?: BuiltinProviderSpec[];
		};
		const specs = imported.BUILTIN_PROVIDERS ?? [];
		const providers: unknown[] = [];
		for (const spec of specs) {
			try {
				const provider = spec.create();
				if (typeof provider.getAllModels !== "function") {
					warnings.push(`目录跳过 provider ${spec.id}：没有 getAllModels()`);
					continue;
				}
				const models = await provider.getAllModels();
				providers.push({
					// specId 是"我们的"供应商 id（设置里用的那个），
					// id 是 pi-ai 的 provider id，两者对绝大多数厂商相同，
					// 但 cttai 这类中转内置供应商不一定相同 —— 两个都留着。
					id: provider.id ?? spec.id,
					specId: spec.id,
					builtinId: spec.builtinId ?? spec.id,
					label: spec.label,
					envVars: [...(spec.envVars ?? [])],
					group: spec.group ?? "",
					baseUrl: provider.baseUrl ?? spec.baseUrl ?? "",
					api: models[0]?.api ?? "",
					models: models.map((model) => ({
						id: model.id ?? "",
						name: model.name ?? model.id ?? "",
						contextWindow: model.contextWindow ?? 0,
						maxTokens: model.maxTokens ?? 0,
						reasoning: model.reasoning ?? false,
						cost: {
							input: model.cost?.input ?? 0,
							output: model.cost?.output ?? 0,
							cacheRead: model.cost?.cacheRead ?? 0,
							cacheWrite: model.cost?.cacheWrite ?? 0,
						},
					})),
				});
			} catch (err) {
				warnings.push(`目录跳过 provider ${spec.id}：${(err as Error).message}`);
			}
		}
		return { catalog: { providers }, warnings };
	} catch (err) {
		warnings.push(`目录生成失败，catalog.json 为空：${(err as Error).message}`);
		return { catalog: { providers: [] }, warnings };
	}
}

/** 找到 partial-json 在 pnpm 布局里的位置。 */
function resolvePartialJsonDir(): string {
	const piAi = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai");
	const real = fs.realpathSync(piAi);
	const nodeModulesDir = path.resolve(path.dirname(real), "..");
	const candidate = path.join(nodeModulesDir, "partial-json", "dist");
	if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
	throw new Error(`找不到 partial-json 产物目录（尝试过 ${candidate}）`);
}

/** 主构建流程。 */
export async function buildBrowser(options: BuildOptions = {}): Promise<BuildReport> {
	const warnings: string[] = [];
	const resolved = resolveOutDir(options.outDir);
	const outDir = resolved.outDir;
	if (resolved.fallback) {
		warnings.push(
			`public/browser 不可写，产物写到 ${outDir}。` +
				"请在没有沙箱限制的环境里重新运行本脚本，或手动把产物复制到 public/browser。",
		);
	}

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });

	const groups: Record<string, { files: number; bytes: number }> = {};
	const write = (relOut: string, content: string): void => {
		const target = path.join(outDir, relOut);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		const group = relOut.startsWith("vendor/") ? "vendor" : relOut.startsWith("src/") ? "src" : "meta";
		const bucket = groups[group] ?? { files: 0, bytes: 0 };
		bucket.files += 1;
		bucket.bytes += Buffer.byteLength(content);
		groups[group] = bucket;
	};

	// 1) 收集入口。
	const seeds = new Set<string>(ENTRY_POINTS);
	for (const extra of listBrowserSources()) seeds.add(extra);

	// 2) 解析传递闭包。
	const stripped = new Map<string, string>();
	const queue: string[] = [...seeds];
	while (queue.length > 0) {
		const rel = queue.shift() as string;
		if (stripped.has(rel)) continue;
		const abs = path.join(REPO_ROOT, rel);
		if (!fs.existsSync(abs)) {
			const hint = OPTIONAL_ENTRIES.has(rel) ? "（可选文件，暂不存在）" : "（文件不存在）";
			warnings.push(`跳过 ${rel} ${hint}`);
			continue;
		}
		const source = fs.readFileSync(abs, "utf8");
		if (hasNodeImport(source)) {
			if (SOFT_SKIP.has(rel)) {
				warnings.push(`跳过 ${rel}：仍包含 node: 导入，等它被改造成纯逻辑层后再纳入浏览器构建`);
				continue;
			}
			throw new Error(`${rel} 含有 node: 导入，不能进浏览器`);
		}
		let code: string;
		try {
			code = stripTs(source);
		} catch (err) {
			throw new Error(`${rel} 转译失败：${(err as Error).message}`);
		}
		for (const bare of extractBareSpecifiers(code)) {
			if (ALLOWED_BARESPECIFIERS.has(bare)) continue;
			// pi-ai 的 utils 子路径会被改写成 vendor 目录里的相对路径，不算未知依赖。
			if (bare.startsWith("@earendil-works/pi-ai/utils/")) continue;
			if (FORBIDDEN_BARESPECIFIERS.some((prefix) => bare === prefix || bare.startsWith(prefix))) {
				throw new Error(`${rel} 引入了浏览器端不允许的依赖：${bare}`);
			}
			warnings.push(`${rel} 引入了未知的裸说明符 ${bare}，浏览器里可能解析不到`);
		}
		stripped.set(rel, code);
		for (const specifier of extractSpecifiers(code)) {
			if (specifier.startsWith("@earendil-works/pi-ai/utils/")) continue;
			const target = resolveRelative(rel, specifier).replace(/^\.\//, "");
			if (FORBIDDEN_MODULES.has(target) || target.endsWith("-disk.ts")) {
				throw new Error(`${rel} → ${target} is not browser-safe`);
			}
			queue.push(target);
		}
	}

	// 3) 输出我们自己的模块（改写说明符）。
	for (const [rel, code] of stripped) {
		const outPaths = outputPathFor(rel);
		const fromOut = outPaths[0] as string;
		const rewritten = code.replace(SPECIFIER_PATTERN, (match, _quote: string, specifier: string) => {
			let targetOut: string | null = null;
			if (specifier.startsWith("@earendil-works/pi-ai/utils/")) {
				const name = specifier.slice("@earendil-works/pi-ai/utils/".length);
				targetOut = `vendor/pi-ai/utils/${name}.js`;
			} else if (specifier.startsWith(".")) {
				const targetRel = resolveRelative(rel, specifier).replace(/^\.\//, "");
				const targetOuts = outputPathFor(targetRel);
				targetOut = targetOuts[0] as string;
			}
			if (!targetOut) return match;
			const next = relativeSpecifier(fromOut, targetOut);
			return match.replace(specifier, next);
		});
		for (const outPath of outPaths) write(outPath, rewritten);
	}

	// 4) vendor 依赖。
	const coreDist = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-agent-core", "dist");
	for (const entry of fs.readdirSync(coreDist)) {
		if (!entry.endsWith(".js")) continue;
		write(`vendor/pi-agent-core/${entry}`, fs.readFileSync(path.join(coreDist, entry), "utf8"));
	}

	const aiUtils = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "utils");
	for (const name of ["event-stream", "transcript", "text", "json-parse", "validation"]) {
		write(`vendor/pi-ai/utils/${name}.js`, fs.readFileSync(path.join(aiUtils, `${name}.js`), "utf8"));
	}

	const partialDir = resolvePartialJsonDir();
	const partialOptions = fs.readFileSync(path.join(partialDir, "options.js"), "utf8");
	const partialIndex = fs.readFileSync(path.join(partialDir, "index.js"), "utf8");
	write("vendor/partial-json.js", convertPartialJson(partialOptions, partialIndex));

	// 5) 模型目录 + import map。
	const { catalog, warnings: catalogWarnings } = await buildCatalog();
	warnings.push(...catalogWarnings);
	write("vendor/catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
	write("vendor/importmap.json", `${JSON.stringify({ imports: IMPORT_MAP }, null, 2)}\n`);

	let files = 0;
	let bytes = 0;
	for (const bucket of Object.values(groups)) {
		files += bucket.files;
		bytes += bucket.bytes;
	}

	const report: BuildReport = { outDir, fallback: resolved.fallback, files, bytes, groups, warnings };
	if (!options.quiet) {
		console.log("浏览器构建完成");
		console.log(`  输出目录：${outDir}`);
		for (const [name, bucket] of Object.entries(groups)) {
			console.log(`  ${name}: ${bucket.files} 个文件 / ${(bucket.bytes / 1024).toFixed(1)} KB`);
		}
		console.log(`  合计：${files} 个文件 / ${(bytes / 1024).toFixed(1)} KB`);
		for (const warning of warnings) console.log(`  ! ${warning}`);
	}
	return report;
}

const invokedDirectly = (() => {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return path.resolve(entry) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	const outArgIndex = process.argv.indexOf("--out");
	const outArg = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : undefined;
	buildBrowser({ outDir: outArg ?? process.env.NOVEL_STUDIO_BROWSER_OUT })
		.then(() => undefined)
		.catch((err: unknown) => {
			console.error(`构建失败：${(err as Error).message}`);
			process.exitCode = 1;
		});
}
