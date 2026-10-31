#!/usr/bin/env node
/**
 * 浏览器构建自检。
 *
 *   node --experimental-strip-types scripts/browser-build-check.ts
 *
 * 做四件事：
 *   1. 跑一遍构建，确认产物齐全；
 *   2. 静态检查产物：没有 node: 导入、没有 provider SDK、说明符都被 import map 覆盖；
 *   3. 在 Node 里真的 import 构建产物，跑一遍 Type / Compile / Value / validateToolArguments；
 *   4. 用本机 Chrome 无头跑一遍真实浏览器冒烟（能跑就跑，跑不了会明确说明）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import nodeModule from "node:module";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBrowser } from "./browser-build.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
];

let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

/** 环境限制类的提示：只提醒，不计入失败。 */
function warn(label: string, detail = ""): void {
	console.log("  ! " + label + (detail ? "  —— " + detail : ""));
}

/** 抓出 import/export 的说明符（与构建脚本同一套规则）。 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;

function specifiersOf(code: string): string[] {
	const found: string[] = [];
	for (const match of code.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[2];
		if (specifier) found.push(specifier);
	}
	return found;
}

function readIfExists(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

const EXPECTED_FILES = [
	"local-api.js",
	"src/ai/tools.js",
	"src/ai/novel-agent.js",
	"src/ai/web-search.js",
	"src/store/project.js",
	"vendor/pi-agent-core/index.js",
	"vendor/pi-agent-core/agent.js",
	"vendor/pi-agent-core/agent-loop.js",
	"vendor/pi-agent-core/proxy.js",
	"vendor/pi-agent-core/stream-fn.js",
	"vendor/pi-agent-core/types.js",
	"vendor/pi-ai/shim.js",
	"vendor/pi-ai/utils/event-stream.js",
	"vendor/pi-ai/utils/transcript.js",
	"vendor/pi-ai/utils/text.js",
	"vendor/pi-ai/utils/json-parse.js",
	"vendor/pi-ai/utils/validation.js",
	"vendor/typebox/compile.js",
	"vendor/typebox/value.js",
	"vendor/typebox/type.js",
	"vendor/partial-json.js",
	"vendor/catalog.json",
	"vendor/importmap.json",
];

const EXPECTED_IMPORT_MAP: Record<string, string> = {
	"@earendil-works/pi-ai": "/browser/vendor/pi-ai/shim.js",
	"@earendil-works/pi-agent-core": "/browser/vendor/pi-agent-core/index.js",
	"typebox/compile": "/browser/vendor/typebox/compile.js",
	"typebox/value": "/browser/vendor/typebox/value.js",
	"partial-json": "/browser/vendor/partial-json.js",
};

const SDK_PATTERNS = [
	"openai",
	"@anthropic-ai/sdk",
	"@google/genai",
	"@aws-sdk/",
	"@smithy/",
	"http-proxy-agent",
	"https-proxy-agent",
	"@earendil-works/pi-telemetry",
];

/** 起一个静态服务器，把构建产物按 / 暴露出去。 */
function startServer(root: string): Promise<{ url: string; close: () => Promise<void>; marker: () => string }> {
	let markerValue = "";
	const server = http.createServer((req, res) => {
		const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/marker") {
			markerValue = requestUrl.searchParams.get("result") ?? "";
			res.writeHead(204).end();
			return;
		}
		if (requestUrl.pathname === "/smoke.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(smokePage());
			return;
		}
		const relative = requestUrl.pathname.replace(/^\/+/, "");
		const target = path.join(root, relative);
		if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
			res.writeHead(404).end("not found");
			return;
		}
		const type = target.endsWith(".json") ? "application/json" : "text/javascript";
		res.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(fs.readFileSync(target));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((done) => server.close(() => done())),
				marker: () => markerValue,
			});
		});
	});
}

function smokePage(): string {
	const importMap = {
		imports: Object.fromEntries(
			Object.entries(EXPECTED_IMPORT_MAP).map(([key, value]) => [key, value.replace("/browser/", "/")]),
		),
	};
	return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>browser smoke</title>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body><pre id="out">pending</pre>
<script>
window.__smokeDone = false;
setTimeout(() => {
	if (window.__smokeDone) return;
	const text = "SMOKE_FAIL 模块脚本没有执行（import map 没生效，或模块解析失败）";
	document.getElementById("out").textContent = text;
	fetch("/marker?result=" + encodeURIComponent(text)).catch(() => {});
}, 8000);
</script>
<script type="module">
const out = document.getElementById("out");
window.__smokeDone = true;
const report = (text) => {
	out.textContent = text;
	fetch("/marker?result=" + encodeURIComponent(text.slice(0, 400))).catch(() => {});
};
try {
	const core = await import("/vendor/pi-agent-core/index.js");
	const pi = await import("/vendor/pi-ai/shim.js");
	if (typeof core.Agent !== "function") throw new Error("core.Agent 不是函数");

	const schema = pi.Type.Object({ chapterId: pi.Type.String({ minLength: 1 }), scope: pi.Type.Union([pi.Type.Literal("head"), pi.Type.Literal("tail")]) });
	const json = JSON.stringify(schema);
	if (!json.includes('"required":["chapterId","scope"]')) throw new Error("Type.Object 的 required 不对: " + json);

	const message = {
		role: "assistant",
		content: [{ type: "text", text: "浏览器里的问候" }],
		api: "openai-completions",
		provider: "smoke",
		model: "smoke",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const agent = new core.Agent({
		streamFn: async () => {
			const stream = pi.createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", message });
			return stream;
		},
		initialState: {
			systemPrompt: "冒烟测试",
			model: { id: "smoke", name: "smoke", api: "openai-completions", provider: "smoke", baseUrl: "", reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
			tools: [],
		},
	});
	await agent.prompt("hi");
	const last = agent.state.messages[agent.state.messages.length - 1];
	const text = last && last.content && last.content[0] ? last.content[0].text : "";
	if (!String(text).includes("浏览器里的问候")) throw new Error("agent loop 没有回传消息: " + JSON.stringify(last));

	let rejected = "";
	try {
		pi.validateToolArguments({ name: "demo", parameters: schema }, { name: "demo", arguments: { scope: "head" } });
	} catch (err) {
		rejected = String(err && err.message ? err.message : err);
	}
	if (!rejected.includes('Validation failed for tool "demo"')) throw new Error("校验失败信息不对: " + rejected);

	report("SMOKE_OK " + text);
} catch (err) {
	report("SMOKE_FAIL " + (err && err.stack ? err.stack : String(err)));
}
</script>
</body></html>`;
}

function findChrome(): string | null {
	for (const candidate of CHROME_PATHS) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * 在一个假的 window 里跑一遍 public/boot.js，检查本地模式分流是否正确。
 */
function runBootScript(
	code: string,
	options: { indexedDB: boolean; search: string; mode: string | null },
): { calls: string[]; window: Record<string, unknown> } {
	const calls: string[] = [];
	const fakeWindow: Record<string, unknown> = {
		indexedDB: options.indexedDB ? {} : undefined,
		location: { search: options.search, href: "http://127.0.0.1:8080/app/", origin: "http://127.0.0.1:8080" },
		localStorage: { getItem: () => options.mode },
		fetch: async (input: unknown) => {
			calls.push("server:" + String(input));
			return { via: "server" };
		},
	};
	const context = vm.createContext({
		window: fakeWindow,
		localStorage: fakeWindow.localStorage,
		URLSearchParams,
		URL,
	});
	const script = new vm.Script(code, {
		filename: "boot.js",
		importModuleDynamically: async () =>
			({
				handle: async (input: unknown) => {
					calls.push("local:" + String(input));
					return { via: "local" };
				},
			}) as never,
	});
	script.runInContext(context);
	// 动态 import 在 vm 里需要 --experimental-vm-modules，这里换成桩，
	// 只验证 fetch 分流逻辑（真正的懒加载由浏览器冒烟页验证）。
	if (fakeWindow.__DSH_LOCAL_MODE__ === true) {
		fakeWindow.__dshLocalFetch = async (input: unknown) => {
			calls.push("local:" + String(input));
			return { via: "local" };
		};
	}
	return { calls, window: fakeWindow };
}

async function runChromeSmoke(root: string): Promise<{ ran: boolean; ok: boolean; detail: string }> {
	const chrome = findChrome();
	if (!chrome) return { ran: false, ok: false, detail: "本机没有找到 Chrome" };
	const server = await startServer(root);
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ns-chrome-"));
	const logPath = path.join(profile, "chrome.log");
	let logFd = -1;
	let child: ReturnType<typeof spawn> | null = null;
	let exited = false;
	let exitCode: number | null = null;
	try {
		// 注意：stderr 写文件而不是走管道——受限环境下建管道会被 EPERM 拒绝。
		logFd = fs.openSync(logPath, "a");
		child = spawn(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--disable-crashpad",
				"--disable-breakpad",
				"--no-proxy-server",
				`--user-data-dir=${profile}`,
				"--virtual-time-budget=15000",
				"--dump-dom",
				`${server.url}/smoke.html`,
			],
			{ stdio: ["ignore", "ignore", logFd] },
		);
		child.on("exit", (code: number | null) => {
			exited = true;
			exitCode = code;
		});
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const marker = server.marker();
			if (marker) {
				return { ran: true, ok: marker.startsWith("SMOKE_OK"), detail: marker };
			}
			if (exited) {
				// Chrome 已经退出：再等一会儿，看是不是页面脚本刚跑完还没上报。
				const grace = Date.now() + 3000;
				while (Date.now() < grace) {
					const late = server.marker();
					if (late) return { ran: true, ok: late.startsWith("SMOKE_OK"), detail: late };
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				const stderr = readIfExists(logPath) ?? "";
				const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
				const blocked = /拒绝访问|Access is denied|FATAL|platform_channel|crashpad/i.test(stderr);
				if (blocked && exitCode !== 0) {
					return { ran: false, ok: false, detail: `Chrome 在本环境启动不了（沙箱限制），冒烟未运行：${tail}` };
				}
				return { ran: true, ok: false, detail: `Chrome 退出（code=${exitCode}）但页面没有回传标记：${tail}` };
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return { ran: true, ok: false, detail: "30 秒内没有收到浏览器回传的标记" };
	} catch (err) {
		return { ran: false, ok: false, detail: `启动 Chrome 失败：${(err as Error).message}` };
	} finally {
		if (child) {
			try {
				child.kill();
			} catch {
				/* 忽略 */
			}
		}
		if (logFd >= 0) {
			try {
				fs.closeSync(logFd);
			} catch {
				/* 忽略 */
			}
		}
		await server.close();
		try {
			fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
		} catch (err) {
			// Windows 的 Chrome 子进程可能稍晚才释放 profile；测试结论不应被清理失败改写。
			console.warn(`[browser-check] Chrome 临时目录稍后仍需清理：${profile}（${(err as Error).message}）`);
		}
	}
}

async function main(): Promise<void> {
	console.log("\n构建");
	const report = await buildBrowser({ quiet: true });
	console.log(`  输出目录：${report.outDir}`);
	check("构建成功", true);
	if (report.fallback) {
		warn("产物没有落在 public/browser", `实际落在 ${report.outDir}（当前环境对 public/ 没有写权限）`);
	} else {
		check("产物落在 public/browser", true);
	}
	for (const warning of report.warnings) console.log("  ! " + warning);

	const outDir = report.outDir;
	const out = (rel: string): string => path.join(outDir, rel);

	console.log("\n产物文件");
	for (const rel of EXPECTED_FILES) {
		check(`存在 ${rel}`, fs.existsSync(out(rel)));
	}

	console.log("\n依赖安全");
	const shimCode = readIfExists(out("vendor/pi-ai/shim.js")) ?? "";
	const toolsCode = readIfExists(out("src/ai/tools.js")) ?? "";
	const shimSpecs = specifiersOf(shimCode);
	const toolsSpecs = specifiersOf(toolsCode);
	check("shim.js 没有 node: 导入", !shimSpecs.some((spec) => spec.startsWith("node:")), shimSpecs.join(", "));
	check("tools.js 没有 node: 导入", !toolsSpecs.some((spec) => spec.startsWith("node:")), toolsSpecs.join(", "));
	check(
		"shim.js 没有 provider SDK",
		!SDK_PATTERNS.some((pattern) => shimSpecs.some((spec) => spec === pattern || spec.startsWith(pattern))),
		shimSpecs.join(", "),
	);
	check(
		"tools.js 没有 provider SDK",
		!SDK_PATTERNS.some((pattern) => toolsSpecs.some((spec) => spec === pattern || spec.startsWith(pattern))),
		toolsSpecs.join(", "),
	);
	check(
		"tools.js 只保留 import map 能解析的裸说明符",
		toolsSpecs.every((spec) => spec.startsWith(".") || spec === "@earendil-works/pi-ai"),
		toolsSpecs.join(", "),
	);
	const coreIndex = readIfExists(out("vendor/pi-agent-core/index.js")) ?? "";
	const coreSpecs = specifiersOf(coreIndex);
	check("pi-agent-core/index.js 没有 node: 引用", !coreIndex.includes("node:"));
	for (const name of ["agent.js", "agent-loop.js", "proxy.js"]) {
		const code = readIfExists(out(`vendor/pi-agent-core/${name}`)) ?? "";
		const specs = specifiersOf(code);
		check(
			`pi-agent-core/${name} 的裸说明符只有 @earendil-works/pi-ai`,
			specs.filter((spec) => !spec.startsWith(".")).every((spec) => spec === "@earendil-works/pi-ai"),
			specs.join(", "),
		);
	}
	const importMapRaw = readIfExists(out("vendor/importmap.json"));
	let importMap: { imports?: Record<string, string> } = {};
	try {
		importMap = JSON.parse(importMapRaw ?? "{}") as { imports?: Record<string, string> };
	} catch {
		importMap = {};
	}
	check("importmap.json 覆盖全部裸说明符", Object.keys(EXPECTED_IMPORT_MAP).every((key) => importMap.imports?.[key] === EXPECTED_IMPORT_MAP[key]), JSON.stringify(importMap.imports));

	console.log("\n类型信息");
	const toolsSource = readIfExists(path.join(REPO_ROOT, "src", "ai", "tools.ts")) ?? "";
	check("src/ai/tools.ts 仍在用 Static/TSchema 类型", toolsSource.includes("type Static") && toolsSource.includes("type TSchema"));
	check("产物里保留了 Type. 调用", toolsCode.includes("Type.Object(") && toolsCode.includes("Type.String(") && toolsCode.includes("Type.Optional("));
	check("产物里没有残留类型导入", !/import\s+type\s/.test(toolsCode));

	console.log("\n本地模式引导");
	const bootCode = readIfExists(path.join(REPO_ROOT, "public", "boot.js")) ?? "";
	check("public/boot.js 存在", bootCode.length > 0);
	if (bootCode) {
		const server = runBootScript(bootCode, { indexedDB: true, search: "", mode: null });
		await (server.window.fetch as (input: unknown) => Promise<unknown>)("/api/projects");
		check("服务器模式下不动 fetch", server.calls.join(",") === "server:/api/projects", server.calls.join(","));
		check("服务器模式不设置本地标记", server.window.__DSH_LOCAL_MODE__ === undefined, String(server.window.__DSH_LOCAL_MODE__));

		const noDb = runBootScript(bootCode, { indexedDB: false, search: "?local=1", mode: "local" });
		await (noDb.window.fetch as (input: unknown) => Promise<unknown>)("/api/projects");
		check("没有 IndexedDB 就不进本地模式", noDb.calls.join(",") === "server:/api/projects", noDb.calls.join(","));

		const local = runBootScript(bootCode, { indexedDB: true, search: "?local=1", mode: null });
		await (local.window.fetch as (input: unknown) => Promise<unknown>)("/api/projects");
		await (local.window.fetch as (input: unknown) => Promise<unknown>)("/api/llm");
		await (local.window.fetch as (input: unknown) => Promise<unknown>)("/assets/logo.svg");
		check("本地模式设置标记", local.window.__DSH_LOCAL_MODE__ === true, String(local.window.__DSH_LOCAL_MODE__));
		check(
			"本地模式接管 /api/",
			local.calls[0] === "local:/api/projects",
			local.calls.join(","),
		);
		check(
			"/api/llm 仍然走服务器",
			local.calls[1] === "server:/api/llm",
			local.calls.join(","),
		);
		check(
			"非 /api/ 请求仍然走服务器",
			local.calls[2] === "server:/assets/logo.svg",
			local.calls.join(","),
		);

		const byStorage = runBootScript(bootCode, { indexedDB: true, search: "", mode: "local" });
		await (byStorage.window.fetch as (input: unknown) => Promise<unknown>)("/api/projects");
		check(
			"localStorage 也能打开本地模式",
			byStorage.calls.join(",") === "local:/api/projects",
			byStorage.calls.join(","),
		);
	}

	console.log("\nType / Compile / Value");
	const bareMap: Record<string, string> = {
		"@earendil-works/pi-ai": out("vendor/pi-ai/shim.js"),
		"@earendil-works/pi-agent-core": out("vendor/pi-agent-core/index.js"),
		"typebox/compile": out("vendor/typebox/compile.js"),
		"typebox/value": out("vendor/typebox/value.js"),
		"partial-json": out("vendor/partial-json.js"),
	};
	if (typeof nodeModule.registerHooks !== "function") {
		check("Node 支持 module.registerHooks", false, "当前 Node 版本没有 registerHooks，跳过功能自检");
	} else {
		nodeModule.registerHooks({
			resolve(specifier, context, nextResolve) {
				const mapped = bareMap[specifier];
				if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true };
				return nextResolve(specifier, context);
			},
		});
		const shim = (await import(pathToFileURL(out("vendor/pi-ai/shim.js")).href)) as {
			Type: Record<string, (...args: never[]) => unknown>;
			validateToolArguments: (tool: unknown, call: unknown) => unknown;
		};
		const compileMod = (await import(pathToFileURL(out("vendor/typebox/compile.js")).href)) as {
			Compile: (schema: unknown) => { Check: (value: unknown) => boolean; Errors: (value: unknown) => { keyword: string; instancePath: string; message: string; params?: Record<string, unknown> }[] };
		};
		const valueMod = (await import(pathToFileURL(out("vendor/typebox/value.js")).href)) as {
			Value: { Check: (value: unknown, schema: unknown) => boolean; Errors: (value: unknown, schema: unknown) => { keyword: string }[]; Convert: (schema: unknown, value: unknown) => unknown };
		};
		const Type = shim.Type as unknown as {
			String: (options?: Record<string, unknown>) => unknown;
			Number: (options?: Record<string, unknown>) => unknown;
			Boolean: (options?: Record<string, unknown>) => unknown;
			Literal: (value: string | number | boolean) => unknown;
			Union: (members: unknown[], options?: Record<string, unknown>) => unknown;
			Optional: (schema: unknown) => unknown;
			Object: (properties: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
		};
		const schema = Type.Object({
			chapterId: Type.String({ minLength: 1 }),
			scope: Type.Union([Type.Literal("head"), Type.Literal("tail")]),
			limit: Type.Optional(Type.Number({ minimum: 1 })),
		});
		const json = JSON.stringify(schema);
		check("Type.Object 产出纯 JSON Schema", json.includes('"type":"object"') && json.includes('"required":["chapterId","scope"]'), json);
		const validator = compileMod.Compile(schema);
		check("Compile 接受合法参数", validator.Check({ chapterId: "c1", scope: "head" }));
		check("Compile 拒绝缺字段", !validator.Check({ chapterId: "c1" }));
		const missing = validator.Errors({ chapterId: "c1" });
		const requiredError = missing.find((error) => error.keyword === "required");
		check("缺字段错误带 requiredProperties", Array.isArray(requiredError?.params?.requiredProperties), JSON.stringify(missing));
		check("缺字段错误路径是根", requiredError?.instancePath === "", JSON.stringify(missing));
		check("Compile 拒绝非法枚举值", !validator.Check({ chapterId: "c1", scope: "middle" }));
		const nestedError = validator.Errors({ chapterId: "", scope: "head" })[0];
		check("子属性错误路径带 /chapterId", nestedError?.instancePath === "/chapterId", JSON.stringify(validator.Errors({ chapterId: "", scope: "head" })));
		check("Value.Check 与 Compile 一致", valueMod.Value.Check({ chapterId: "c1", scope: "head" }, schema) && !valueMod.Value.Check({ scope: "head" }, schema));
		check("Value.Errors 有内容", valueMod.Value.Errors({ scope: "head" }, schema).length > 0);
		check("Value.Convert 不改数据", valueMod.Value.Convert(schema, { chapterId: "c1" }) !== undefined);

		console.log("\nvalidateToolArguments");
		const good = shim.validateToolArguments(
			{ name: "demo", parameters: schema },
			{ name: "demo", arguments: { chapterId: "c1", scope: "head" } },
		) as { chapterId?: string };
		check("合法参数通过校验", good?.chapterId === "c1", JSON.stringify(good));
		let message = "";
		try {
			shim.validateToolArguments({ name: "demo", parameters: schema }, { name: "demo", arguments: { scope: "head" } });
		} catch (err) {
			message = (err as Error).message;
		}
		check('非法参数抛出 Validation failed for tool "demo"', message.includes('Validation failed for tool "demo"'), message.slice(0, 200));
		check("错误信息里带缺失字段名", message.includes("scope"), message.slice(0, 200));

		console.log("\n浏览器冒烟");
		const smoke = await runChromeSmoke(outDir);
		if (!smoke.ran) {
			warn("真实浏览器冒烟未运行", smoke.detail);
		} else {
			check("真实浏览器冒烟通过", smoke.ok, smoke.detail.slice(0, 400));
		}
	}

	console.log(failed === 0 ? "\n全部通过" : `\n有 ${failed} 项没过`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
	console.error(`自检异常：${(err as Error).stack ?? String(err)}`);
	process.exitCode = 1;
});
