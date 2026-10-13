/**
 * 配置层测试：供应商配置、凭据存储、自定义 provider 构造、模型拉取合并。
 * 不需要 API Key，也不访问网络。
 *
 * 运行：pnpm test:config
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { buildCustomProvider, buildThinkingLevelMap, toModel } from "../src/ai/custom-provider.ts";
import { mergeFetched } from "../src/ai/fetch-models.ts";
import { FileCredentialStore } from "../src/config/credential-store.ts";
import { SettingsStore } from "../src/config/settings-store.ts";
import { emptyModel, emptySettings, normalizeSettings, type ModelConfig, type ProviderConfig } from "../src/config/settings.ts";

let failures = 0;
function check(label: string, condition: boolean, extra = ""): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
}

const dir = await mkdtemp(path.join(tmpdir(), "novel-studio-config-"));

try {
	// ---------------------------------------------------------------- 归一化
	console.log("\n配置归一化");
	const base = emptySettings();
	check("空配置合法", base.providers.length === 0 && base.defaultModel === "");

	const messy = normalizeSettings({
		defaultModel: "  ",
		defaultThinkingLevel: "turbo",
		providers: [
			{ id: "a", label: " A ", kind: "builtin", builtinId: "deepseek", models: [{ id: "m1" }], enabled: true },
			{ id: "", label: "no id", kind: "custom" },
			{ id: "b", label: "B", kind: "custom", baseUrl: "https://x.test/v1", api: "openai-completions", models: [{ id: "m2", contextWindow: -5, maxTokens: 0 }] },
			{ id: "c", label: "C", kind: "custom", api: "not-a-format" },
		],
	});
	check("非法 id 的供应商被丢弃", messy.providers.length === 3, String(messy.providers.length));
	check("label 去空格", messy.providers[0]?.label === "A");
	check("非法思考档位回落 off", messy.defaultThinkingLevel === "off");
	const b = messy.providers.find((p) => p.id === "b")!;
	check("非法 contextWindow 回落默认值", b.models[0]?.contextWindow === 128000, String(b.models[0]?.contextWindow));
	check("非法 maxTokens 回落默认值", b.models[0]?.maxTokens === 8192);
	check("非法接口格式被丢弃", messy.providers[3]?.api === undefined);
	check("缺省 enabled 为 true", messy.providers.every((p) => p.enabled));

	const bad = normalizeSettings({ providers: "not-an-array", defaultThinkingLevel: 42 });
	check("垃圾输入不抛异常", Array.isArray(bad.providers) && bad.providers.length === 0);

	// ---------------------------------------------------------------- 凭据存储
	console.log("\n凭据存储");
	const credentials = await FileCredentialStore.open(dir);
	check("初始无 key", credentials.hasKey("deepseek") === false);
	check("脱敏返回空串", credentials.maskedKey("deepseek") === "");

	await credentials.setKey("deepseek", "sk-test-123");
	check("写入后有 key", credentials.hasKey("deepseek"));
	check("不暴露明文", credentials.maskedKey("deepseek").indexOf("sk-test") === -1 && credentials.maskedKey("deepseek").length > 0);
	const read = await credentials.read("deepseek");
	check("读回类型正确", read?.type === "api_key");
	const listed = await credentials.list();
	check("list 不含明文", JSON.stringify(listed).indexOf("sk-test") === -1, JSON.stringify(listed));

	await credentials.setKey("deepseek", "sk-rotated");
	check("轮换 key", (await credentials.read("deepseek"))?.key === "sk-rotated");

	// 同一 provider 的并发写必须串行，不能丢更新
	await Promise.all([credentials.setKey("zai", "a"), credentials.setKey("zai", "b")]);
	check("并发写后仍可读", credentials.hasKey("zai"));

	const rawCred = JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8"));
	check("已落盘", rawCred.deepseek?.key === "sk-rotated", JSON.stringify(rawCred));

	const reopened = await FileCredentialStore.open(dir);
	check("重开后仍在", reopened.hasKey("deepseek"));

	await reopened.delete("deepseek");
	check("删除后为空", (await reopened.read("deepseek")) === undefined);

	// ---------------------------------------------------------------- 设置存储
	console.log("\n设置存储");
	const settings = await SettingsStore.open(dir);
	check("新目录为空配置", settings.get().providers.length === 0);
	settings.upsertProvider({ id: "p1", label: "P1", kind: "custom", baseUrl: "https://x.test/v1", api: "openai-completions", models: [emptyModel("m")], enabled: true, updatedAt: 0 });
	check("upsert 新增", settings.getProvider("p1")?.label === "P1");
	settings.upsertProvider({ id: "p1", label: "P1-renamed", kind: "custom", baseUrl: "https://x.test/v1", api: "openai-completions", models: [], enabled: true, updatedAt: 0 });
	check("upsert 覆盖", settings.get().providers.length === 1 && settings.getProvider("p1")?.label === "P1-renamed");

	settings.mutate((draft) => {
		draft.defaultModel = "p1/m";
	});
	await new Promise((resolve) => setTimeout(resolve, 120));
	const settingsRaw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
	check("设置已落盘", settingsRaw.defaultModel === "p1/m", JSON.stringify(settingsRaw.defaultModel));

	const settingsReopened = await SettingsStore.open(dir);
	check("重开后保留", settingsReopened.getProvider("p1")?.label === "P1-renamed");

	settingsReopened.mutate((draft) => {
		draft.defaultModel = "p1/other";
	});
	settingsReopened.removeProvider("p1");
	check("删除供应商", settingsReopened.getProvider("p1") === undefined);
	check("删除时清空失效的默认模型", settingsReopened.get().defaultModel === "");

	// ---------------------------------------------------------------- 自定义 provider
	console.log("\n自定义 provider 构造");
	const custom: ProviderConfig = {
		id: "mine",
		label: "我的服务",
		kind: "custom",
		baseUrl: "https://api.test/v1",
		api: "openai-completions",
		models: [
			{ ...emptyModel("plain"), contextWindow: 32000, maxTokens: 4096 },
			{ ...emptyModel("thinker"), contextWindow: 131072, maxTokens: 16384, reasoning: true, thinkingLevels: ["low", "medium", "high"] },
		],
		enabled: true,
		updatedAt: 0,
	};
	const provider = buildCustomProvider(custom);
	check("id 正确", provider.id === "mine");
	check("名称正确", provider.name === "我的服务");
	check("baseUrl 去尾斜杠后保持", provider.baseUrl === "https://api.test/v1");
	check("注册了两个模型", provider.getModels().length === 2);

	const plain = provider.getModels().find((model) => model.id === "plain")!;
	check("普通模型 reasoning=false", plain.reasoning === false);
	check("普通模型无 thinkingLevelMap", plain.thinkingLevelMap === undefined);
	check("上下文窗口透传", plain.contextWindow === 32000);
	check("输出上限透传", plain.maxTokens === 4096);
	check("baseUrl 指向自定义地址", plain.baseUrl === "https://api.test/v1");
	check("api 正确", plain.api === "openai-completions");
	check("provider 归属正确", plain.provider === "mine");

	const thinker = provider.getModels().find((model) => model.id === "thinker")!;
	const levels = getSupportedThinkingLevels(thinker);
	check("思考模型档位包含配置的三档", ["low", "medium", "high"].every((level) => levels.includes(level as never)), levels.join(","));
	check("思考模型屏蔽了未配置的 xhigh", !levels.includes("xhigh" as never), levels.join(","));
	check("思考模型不含 max", !levels.includes("max" as never), levels.join(","));

	const map = buildThinkingLevelMap({ ...emptyModel("x"), reasoning: true, thinkingLevels: ["high"] });
	check("thinkingLevelMap 排除 off", !("off" in map), JSON.stringify(map));
	check("thinkingLevelMap 标记支持档位", map.high === "high");
	check("thinkingLevelMap 标记不支持档位为 null", map.low === null, JSON.stringify(map));

	// ---------------------------------------------------------------- 拉取合并
	console.log("\n拉取合并");
	const existing: ModelConfig[] = [
		{ ...emptyModel("keep"), contextWindow: 999999, maxTokens: 1234, reasoning: true, thinkingLevels: ["high"] },
	];
	const merged = mergeFetched(existing, [
		{ id: "keep", name: "keep-renamed" },
		{ id: "fresh", name: "Fresh", contextWindow: 64000, maxTokens: 8192 },
	]);
	check("已存在模型保留原配置", merged.models.find((m) => m.id === "keep")?.contextWindow === 999999);
	check("已存在模型保留原名称", merged.models.find((m) => m.id === "keep")?.name !== "keep-renamed");
	check("已存在模型保留思考档位", merged.models.find((m) => m.id === "keep")?.thinkingLevels.join() === "high");
	check("新模型预填上限", merged.models.find((m) => m.id === "fresh")?.maxTokens === 8192);
	check("新增计数正确", merged.added.length === 1 && merged.added[0] === "fresh", merged.added.join(","));

	const removed = mergeFetched([emptyModel("gone"), emptyModel("stays")], []);
	check("上游删除的模型仍保留配置", removed.models.length === 2, String(removed.models.length));
} finally {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
