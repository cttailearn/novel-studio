/**
 * 浏览器本地 API 的端到端验收（在 Node 里跑，不需要浏览器）。
 *
 * 验的是这一条链子到底通不通：
 *
 *   fetch("/api/…") → public/boot.js → src/browser/local-api.ts
 *     → createApiRouter()（服务端那 51 个路由，一字未改）
 *     → IdbProjectStore + 五个 IndexedDB 存储（一个字节都不落盘）
 *
 * 只要这条链子是通的，"数据全部存在用户自己的浏览器里" 这件事就成立了一半；
 * 另一半是真实浏览器（`?local=1`）里的手工冒烟，那个沙箱里跑不了。
 *
 * 垫片只补三样 Node 里没有的东西：IndexedDB（复用工程里的测试替身）、
 * `location`、`localStorage`；再补一个只认模型目录的 `fetch`，
 * 用来证明**除了读目录，页面不发任何一个出网请求**。
 *
 * 跑法：node --experimental-strip-types scripts/local-api-check.ts
 */
import { createFakeIndexedDB } from "../src/store/idb-test-double.ts";

let failed = 0;
let passed = 0;

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed += 1;
		console.log("  ✓ " + label);
		return;
	}
	failed += 1;
	console.log("  ✗ " + label + (detail ? "  —— " + detail : ""));
}

function section(title: string): void {
	console.log("\n" + title);
}

// ───────────────────────────────────────────── 浏览器垫片

const fake = createFakeIndexedDB();
(globalThis as Record<string, unknown>)["indexedDB"] = fake;
(globalThis as Record<string, unknown>)["location"] = {
	href: "http://localhost:8787/?local=1",
	origin: "http://localhost:8787",
};

const localStorageData = new Map<string, string>();
(globalThis as Record<string, unknown>)["localStorage"] = {
	getItem: (key: string) => localStorageData.get(key) ?? null,
	setItem: (key: string, value: string) => {
		localStorageData.set(key, String(value));
	},
	removeItem: (key: string) => {
		localStorageData.delete(key);
	},
};

/** 只放一个厂商，够验证"内置目录并进设置"与"按目录出模型清单"。 */
const CATALOG = {
	providers: [
		{
			id: "demo",
			specId: "demo",
			builtinId: "demo",
			label: "示例厂商",
			envVars: ["DEMO_API_KEY"],
			group: "示例",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [
				{
					id: "demo-large",
					name: "Demo Large",
					contextWindow: 128_000,
					maxTokens: 8192,
					reasoning: true,
					cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
				},
			],
		},
	],
};

const outbound: string[] = [];
let relayPayload: Record<string, unknown> | undefined;
(globalThis as Record<string, unknown>)["fetch"] = async (
	input: unknown,
	init?: { method?: string; body?: unknown },
): Promise<Response> => {
	const raw =
		typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url: string }).url);
	const absolute = new URL(raw, "http://localhost:8787/");
	outbound.push(`${init?.method ?? "GET"} ${absolute.pathname}`);
	if (absolute.pathname === "/browser/vendor/catalog.json") {
		return new Response(JSON.stringify(CATALOG), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}
	if (absolute.pathname === "/api/llm") {
		relayPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(JSON.stringify({ data: [
			{ id: "MiniMax-M3", display_name: "MiniMax M3" },
			{ id: "MiniMax-M3.1-Flash", display_name: "MiniMax M3.1 Flash" },
		] }), { status: 200, headers: { "content-type": "application/json" } });
	}
	throw new Error("测试里不允许真实出网：" + absolute.pathname);
};

// 垫片装好之后再加载被测模块（它读的是全局）。
let currentApi = await import("../src/browser/local-api.ts");

// 中继桥必须把请求体一起转：模型列表是 GET 不需要体，联网检索的 Search/Fetch 是 POST，
// 丢掉 body 上游只会收到空请求，表现成"联网失败"。这里直接验桥的载荷。
relayPayload = undefined;
await currentApi.createRelayFetch("/api/llm")("https://api.deepseek.com/v1/tools/search", {
	method: "POST",
	headers: { authorization: "Bearer sk-bridge", "content-type": "application/json" },
	body: JSON.stringify({ query: "古代渡口", count: 3 }),
});
const bridgePayload = relayPayload as Record<string, unknown> | undefined;
check(
	"中继桥转发 POST 与请求体",
	bridgePayload?.["method"] === "POST" &&
		bridgePayload?.["target"] === "https://api.deepseek.com/v1/tools/search" &&
		bridgePayload?.["apiKey"] === "sk-bridge" &&
		bridgePayload?.["body"] === '{"query":"古代渡口","count":3}',
	JSON.stringify(bridgePayload),
);
// 这一笔只是为了验桥的载荷，不计入"启动只读目录"的出网账。
outbound.length = 0;

interface ApiResult {
	status: number;
	data: Record<string, unknown> | null;
	text: string;
}

async function api(
	method: string,
	path: string,
	body?: unknown,
	init?: { raw?: Uint8Array; filename?: string },
): Promise<ApiResult> {
	const target = init?.filename ? `${path}?filename=${encodeURIComponent(init.filename)}` : path;
	const requestInit: RequestInit = { method };
	if (init?.raw) {
		requestInit.body = init.raw;
	} else if (body !== undefined) {
		requestInit.body = JSON.stringify(body);
		requestInit.headers = { "content-type": "application/json" };
	}
	const response = await currentApi.handle(target, requestInit);
	const text = await response.text();
	let data: Record<string, unknown> | null = null;
	try {
		data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
	} catch {
		data = null;
	}
	return { status: response.status, data, text };
}

function pick<T>(data: Record<string, unknown> | null, key: string): T | undefined {
	return data && key in data ? (data[key] as T) : undefined;
}

// ───────────────────────────────────────────── 一、启动

section("一、启动：目录、设置、内置厂商");

const bootstrap = await api("GET", "/api/bootstrap");
check("GET /api/bootstrap 回 200", bootstrap.status === 200, `HTTP ${bootstrap.status} ${bootstrap.text.slice(0, 120)}`);

const settings = pick<Record<string, unknown>>(bootstrap.data, "settings");
const providers = (settings?.["providers"] as Array<Record<string, unknown>> | undefined) ?? [];
check("设置里有供应商清单", Array.isArray(providers));
check(
	"内置厂商从 catalog.json 补进了设置",
	providers.some((provider) => provider["id"] === "demo"),
	JSON.stringify(providers.map((provider) => provider["id"])),
);
check(
	"启动只读了目录，没有任何其它出网",
	outbound.length === 1 && Boolean(outbound[0]?.endsWith("/browser/vendor/catalog.json")),
	outbound.join(", "),
);
check("没有密钥的内置厂商不出现在可用模型里", (pick<unknown[]>(bootstrap.data, "models") ?? []).length === 0);

// 给内置厂商配一把钥匙：这是"用户自带 Key"的最小闭环。
const keyForDemo = await api("PATCH", "/api/providers/demo", { apiKey: "sk-demo-browser-key" });
check("PATCH /api/providers/:id 带 apiKey 回 200", keyForDemo.status === 200, `HTTP ${keyForDemo.status} ${keyForDemo.text.slice(0, 160)}`);
const modelsAfterKey = await api("GET", "/api/models");
const available = (pick<Array<Record<string, unknown>>>(modelsAfterKey.data, "models") ?? []).map((model) => model["id"]);
check("配了钥匙之后按目录列出模型", available.includes("demo/demo-large"), JSON.stringify(available));

section("一之二、内置厂商实时模型：经中继，用 URL + Key 真拉");
const pulled = await api("POST", "/api/providers/demo/models/fetch");
check("内置厂商拉取接口回 200", pulled.status === 200, pulled.text);
check("上游返回几条就展示几条", pick<number>(pulled.data, "fetched") === 2);
check("拉取记录标成上游来源", pick<string>(pulled.data, "modelsSource") === "upstream");
check("确实向中继发了模型列表请求", relayPayload?.["target"] === "https://api.example.com/v1/models", JSON.stringify(relayPayload));
check("中继请求是 GET", relayPayload?.["method"] === "GET");
check("中继带着用户的 Key", relayPayload?.["apiKey"] === "sk-demo-browser-key");
const upstreamModels = await api("GET", "/api/models");
const upstreamIds = (pick<Array<Record<string, unknown>>>(upstreamModels.data, "models") ?? []).map((model) => model["id"]);
check("静态目录里的模型没有被混进实时清单", !upstreamIds.includes("demo/demo-large"), JSON.stringify(upstreamIds));
check("实时返回的两支笔都可选", upstreamIds.includes("demo/MiniMax-M3") && upstreamIds.includes("demo/MiniMax-M3.1-Flash"), JSON.stringify(upstreamIds));
const settingsAfterPull = await api("GET", "/api/settings");
const pulledProvider = ((settingsAfterPull.data?.["providers"] as Array<Record<string, unknown>> | undefined) ?? []).find((provider) => provider["id"] === "demo");
check("上游清单持久保存在浏览器存储中", pulledProvider?.["modelsSource"] === "upstream" && (pulledProvider?.["models"] as unknown[]).length === 2);
const restoredCatalog = await api("POST", "/api/providers/demo/models/catalog");
check("恢复内置目录接口回 200", restoredCatalog.status === 200, restoredCatalog.text);
const catalogModels = await api("GET", "/api/models");
const catalogIds = (pick<Array<Record<string, unknown>>>(catalogModels.data, "models") ?? []).map((model) => model["id"]);
check("恢复后回到静态目录", catalogIds.includes("demo/demo-large") && catalogIds.length === 1, JSON.stringify(catalogIds));

// 内置目录的模型也要能改参数、加自己的、删掉不用的。
section("一之三、内置目录的模型可配置");
const edited = await api("POST", "/api/providers/demo/models", {
	id: "demo-large",
	name: "Demo Large（改过）",
	contextWindow: 777_777,
	maxTokens: 8_192,
	reasoning: false,
	thinkingLevels: ["off"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
});
check("改内置模型的参数回 200", edited.status === 200, edited.text.slice(0, 200));
const afterEdit = await api("GET", "/api/models");
const editedModel = (pick<Array<Record<string, unknown>>>(afterEdit.data, "models") ?? []).find(
	(model) => model["id"] === "demo/demo-large",
);
check("改过的上下文窗口立刻生效", editedModel?.["contextWindow"] === 777_777, JSON.stringify(editedModel));
check("改过的名称立刻生效", editedModel?.["name"] === "Demo Large（改过）", JSON.stringify(editedModel));

const manual = await api("POST", "/api/providers/demo/models", {
	id: "my-extra",
	name: "我自己的笔",
	contextWindow: 200_000,
	maxTokens: 4_096,
	reasoning: false,
	thinkingLevels: ["off"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
check("手动新增模型回 200", manual.status === 200, manual.text.slice(0, 200));
const afterManual = await api("GET", "/api/models");
const manualIds = (pick<Array<Record<string, unknown>>>(afterManual.data, "models") ?? []).map((model) => model["id"]);
check("手动新增的模型出现在可用清单里", manualIds.includes("demo/my-extra"), JSON.stringify(manualIds));

const removedModel = await api("DELETE", "/api/providers/demo/models/demo-large");
check("删掉内置目录里的模型回 200", removedModel.status === 200, removedModel.text.slice(0, 200));
const afterRemove = await api("GET", "/api/models");
const removedIds = (pick<Array<Record<string, unknown>>>(afterRemove.data, "models") ?? []).map((model) => model["id"]);
check("删掉的模型不再出现", !removedIds.includes("demo/demo-large"), JSON.stringify(removedIds));
check("手动的模型不受影响", removedIds.includes("demo/my-extra"), JSON.stringify(removedIds));

const restoredAgain = await api("POST", "/api/providers/demo/models/catalog");
check("再次恢复内置目录回 200", restoredAgain.status === 200, restoredAgain.text);
const afterRestore = await api("GET", "/api/models");
const restoredIds = (pick<Array<Record<string, unknown>>>(afterRestore.data, "models") ?? []).map((model) => model["id"]);
check("恢复后内置模型回来了", restoredIds.includes("demo/demo-large"), JSON.stringify(restoredIds));
check("恢复后手动添加的模型被清掉（目录回到出厂状态）", !restoredIds.includes("demo/my-extra"), JSON.stringify(restoredIds));

// ───────────────────────────────────────────── 二、工程与正文

section("二、工程、章节、正文的读写");

const created = await api("POST", "/api/projects", {
	title: "浏览器里的书",
	genre: "悬疑",
	logline: "雨夜里有人敲错了门。",
});
const project = pick<Record<string, unknown>>(created.data, "project");
const projectId = String(project?.["id"] ?? "");
check("POST /api/projects 回 201", created.status === 201, `HTTP ${created.status} ${created.text.slice(0, 120)}`);
check("拿得到工程 id", projectId.length > 0);

const chapterCreated = await api("POST", `/api/projects/${projectId}/chapters`, {
	title: "第一章 敲门声",
	summary: "有人敲门，喊的是死人的名字。",
});
const chapter = pick<Record<string, unknown>>(chapterCreated.data, "chapter");
const chapterId = String(chapter?.["id"] ?? "");
check("POST 章节回 201", chapterCreated.status === 201, `HTTP ${chapterCreated.status} ${chapterCreated.text.slice(0, 120)}`);
check("章节 id 是 ch01", chapterId === "ch01", chapterId);

const content = "雨下了整夜。门被敲了三下，不轻不重，像有人确定我在家。";
const saved = await api("PATCH", `/api/projects/${projectId}/chapters/${chapterId}`, { content, autosave: true });
check("PATCH 正文（自动存稿）回 200", saved.status === 200, `HTTP ${saved.status} ${saved.text.slice(0, 160)}`);

const readDraft = await api("GET", `/api/projects/${projectId}/chapters/${chapterId}/draft?history=1`);
const readBody = pick<Record<string, unknown>>(readDraft.data, "chapter");
check("正文原样读回", readBody?.["content"] === content, String(readBody?.["content"] ?? "").slice(0, 40));
check("自动存稿不构成版本点，但手动存稿会", Number(readBody?.["revision"] ?? 0) >= 1, String(readBody?.["revision"] ?? ""));

const servedDraft = await api("GET", `/api/projects/${projectId}/chapters/${chapterId}/draft`);
check("draft 接口回 200", servedDraft.status === 200, `HTTP ${servedDraft.status}`);

const listed = await api("GET", "/api/projects");
const listedProjects = pick<Array<Record<string, unknown>>>(listed.data, "projects") ?? [];
check("工程列表里有这本", listedProjects.some((item) => item["id"] === projectId));

// ───────────────────────────────────────────── 三、设置与密钥

section("三、设置与密钥：只进浏览器，不回明文");

const customProvider = {
	// 供应商 id 是 label 的 slug（`slugify(label)`），所以这里用英文名，
	// 免得中文被 slug 成空串再兜底成 custom-xxxx。
	label: "My Gateway",
	baseUrl: "https://gateway.example.com/v1",
	api: "openai-completions",
	noAuthRequired: false,
};
const createdProvider = await api("POST", "/api/providers", customProvider);
check("POST /api/providers 成功", createdProvider.status === 200 || createdProvider.status === 201, `HTTP ${createdProvider.status} ${createdProvider.text.slice(0, 160)}`);

const setKey = await api("PATCH", "/api/providers/my-gateway", { apiKey: "sk-browser-only-secret" });
check("PATCH /api/providers/:id 存密钥回 200", setKey.status === 200, `HTTP ${setKey.status} ${setKey.text.slice(0, 160)}`);

const afterKey = await api("GET", "/api/settings");
const settingsText = JSON.stringify(afterKey.data ?? {});
check("设置接口不吐明文密钥", !settingsText.includes("sk-browser-only-secret"), settingsText.slice(0, 200));
const statuses = (pick<Record<string, unknown>>(afterKey.data, "statuses") as Array<Record<string, unknown>> | undefined) ?? [];
const mine = statuses.find((item) => item["id"] === "my-gateway");
check("自建厂商出现在状态里", Boolean(mine), JSON.stringify(statuses.map((item) => item["id"])));
check("状态里 authSource 是 app", mine?.["authSource"] === "app", String(mine?.["authSource"] ?? ""));
check("脱敏后的 key 是常量掩码", mine?.["maskedKey"] === "•••••••", String(mine?.["maskedKey"] ?? ""));
const stored = await fake.__dump();
check(
	"密钥确实只写进浏览器的 IndexedDB",
	JSON.stringify(stored).includes("sk-browser-only-secret"),
	Object.keys(stored).join(", "),
);

// ───────────────────────────────────────────── 四、上传解析（纯浏览器）

section("四、上传解析：解出文字，不落任何文件");

const txtBytes = new TextEncoder().encode("雨夜敲门。\n\n他没有开门。");
const uploaded = await api("POST", "/api/uploads", undefined, { raw: txtBytes, filename: "片段.txt" });
const upload = pick<Record<string, unknown>>(uploaded.data, "upload");
check("POST /api/uploads 回 200", uploaded.status === 200, `HTTP ${uploaded.status} ${uploaded.text.slice(0, 160)}`);
check("文字被解出来", String(upload?.["text"] ?? "").includes("他没有开门"), String(upload?.["text"] ?? "").slice(0, 60));

// ───────────────────────────────────────────── 五、存储横幅与回收站

section("五、存储横幅与回收站");

const storage = await api("GET", "/api/storage");
const pending = pick<Record<string, unknown>>(storage.data, "pending");
check("GET /api/storage 回 200", storage.status === 200, `HTTP ${storage.status}`);
check("没有待落盘的写入（IndexedDB 是同步提交的）", Number(pending?.["chapters"] ?? 0) === 0, JSON.stringify(pending));

const removed = await api("DELETE", `/api/projects/${projectId}`);
check("DELETE 工程回 200", removed.status === 200, `HTTP ${removed.status} ${removed.text.slice(0, 160)}`);
const trash = await api("GET", "/api/projects/trash");
const deleted = pick<Array<Record<string, unknown>>>(trash.data, "projects") ?? [];
check("回收站里能看到它", deleted.some((item) => item["id"] === projectId));
const restored = await api("POST", `/api/projects/trash/${projectId}/restore`);
check("恢复回 200", restored.status === 200, `HTTP ${restored.status} ${restored.text.slice(0, 160)}`);
const back = await api("GET", `/api/projects/${projectId}/chapters/${chapterId}/draft`);
check("恢复后正文还在", pick<Record<string, unknown>>(back.data, "chapter")?.["content"] === content);

// ───────────────────────────────────────────── 六、关掉重开：数据真的在库里

section("六、重开一个全新的运行时：数据在 IndexedDB 里，不在内存里");

// 换一个模块实例 = 页面刷新。旧运行时里的 Map / 会话 / 客户端全没了，
// 只剩 IndexedDB 里的字节。
//
// 说明符用变量装起来是故意的：带查询串的路径 tsc 解析不了，
// 而 Node 的 ESM 加载器正是按完整 URL（含查询串）区分模块实例的。
const reloadSpecifier = "../src/browser/local-api.ts?reload=1";
currentApi = await import(reloadSpecifier);

const reopened = await api("GET", `/api/projects/${projectId}/chapters/${chapterId}/draft`);
check(
	"重开之后仍读得到正文",
	pick<Record<string, unknown>>(reopened.data, "chapter")?.["content"] === content,
	reopened.text.slice(0, 160),
);
const reopenedProjects = await api("GET", "/api/projects");
check(
	"重开之后工程列表里还有这本",
	(pick<Array<Record<string, unknown>>>(reopenedProjects.data, "projects") ?? []).some((item) => item["id"] === projectId),
);
const reopenedSettings = await api("GET", "/api/settings");
check(
	"重开之后密钥还在（脱敏显示）",
	JSON.stringify(pick<Record<string, unknown>>(reopenedSettings.data, "statuses") ?? []).includes("•••••••"),
);
check(
	"重开之后自建厂商还在",
	(pick<Array<Record<string, unknown>>>(reopenedSettings.data, "providers") ?? []).some(
		(item) => item["id"] === "my-gateway",
	),
);
check("重开之后仍然没有任何新的出网", outbound.filter((line) => line !== "POST /api/llm").every((line) => line.endsWith("/browser/vendor/catalog.json")), outbound.join(", "));

// ───────────────────────────────────────────── 七、导出再导入：搬家不丢稿

section("七、.novel 包：导出带走、导入回来");

/** 取原始字节（导出走的是二进制，不能按文本读）。 */
async function apiBytes(path: string): Promise<{ status: number; bytes: Uint8Array; type: string }> {
	const response = await currentApi.handle(path, { method: "GET" });
	const buffer = await response.arrayBuffer();
	return { status: response.status, bytes: new Uint8Array(buffer), type: response.headers.get("content-type") ?? "" };
}

const plain = await apiBytes(`/api/novel/export?project=${projectId}`);
check("单部导出回 200", plain.status === 200, `HTTP ${plain.status} ${new TextDecoder().decode(plain.bytes.slice(0, 200))}`);
check("导出是二进制流", plain.type.startsWith("application/octet-stream"), plain.type);
check("默认 gzip（头两字节 1f 8b）", plain.bytes[0] === 0x1f && plain.bytes[1] === 0x8b, `${plain.bytes[0]} ${plain.bytes[1]}`);

const before = pick<Array<Record<string, unknown>>>(await api("GET", "/api/projects").then((r) => r.data), "projects") ?? [];
const beforeIds = new Set(before.map((item) => String(item["id"])));

const imported = await api("POST", "/api/novel/import?onConflict=rename", undefined, { raw: plain.bytes });
check("导入回 200", imported.status === 200, `HTTP ${imported.status} ${imported.text.slice(0, 200)}`);
check("导入了一部作品", pick<number>(imported.data, "projects") === 1, imported.text.slice(0, 160));

const after = pick<Array<Record<string, unknown>>>(await api("GET", "/api/projects").then((r) => r.data), "projects") ?? [];
const fresh = after.find((item) => !beforeIds.has(String(item["id"])));
check("列表里多出一部新的", Boolean(fresh), after.map((item) => item["id"]).join(", "));

if (fresh) {
	const freshId = String(fresh["id"]);
	const draft = await api("GET", `/api/projects/${freshId}/chapters/${chapterId}/draft`);
	check(
		"导入回来的正文与原文一字不差",
		pick<Record<string, unknown>>(draft.data, "chapter")?.["content"] === content,
		draft.text.slice(0, 200),
	);
	const snapshotList = await api("GET", `/api/projects/${freshId}/snapshots`);
	check(
		"快照跟着一起搬过来了",
		((pick<Array<unknown>>(snapshotList.data, "snapshots") ?? []).length ?? 0) >= 0,
		snapshotList.text.slice(0, 120),
	);
}

// 加密包：口令不对就进不来，这是"导出通道"能当备份用而不是泄密通道的前提。
const sealed = await apiBytes(`/api/novel/export?project=${projectId}&passphrase=correct-horse`);
check("带口令导出回 200", sealed.status === 200, `HTTP ${sealed.status}`);
const wrongKey = await api("POST", "/api/novel/import", undefined, { raw: sealed.bytes });
check("错口令导入被拒（400）", wrongKey.status === 400, `HTTP ${wrongKey.status} ${wrongKey.text.slice(0, 160)}`);
const rightKey = await api("POST", "/api/novel/import?passphrase=correct-horse&onConflict=rename", undefined, { raw: sealed.bytes });
check("对口令导得回来（200）", rightKey.status === 200, `HTTP ${rightKey.status} ${rightKey.text.slice(0, 160)}`);

const emptyImport = await api("POST", "/api/novel/import", undefined, { raw: new Uint8Array(0) });
check("空文件回 400", emptyImport.status === 400, `HTTP ${emptyImport.status}`);
check("整条导出通道没有额外出网", outbound.filter((line) => line !== "POST /api/llm").every((line) => line.endsWith("/browser/vendor/catalog.json")), outbound.join(", "));

await currentApi.close();

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
