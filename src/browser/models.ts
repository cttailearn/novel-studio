/**
 * 浏览器端的模型门面。
 *
 * 服务端那份 `src/ai/models.ts` 之所以进不了浏览器，是因为它在顶部静态 import 了
 * 42 个 pi-ai 内置 provider 的工厂函数（其中 amazon-bedrock 还要拖出
 * `@aws-sdk/client-bedrock-runtime`）。浏览器只需要三样东西：
 *
 *   1. 模型**目录**（纯数据）—— 构建脚本在 Node 侧跑一遍 `BUILTIN_PROVIDERS`，
 *      导出成 `public/browser/vendor/catalog.json`，浏览器读 JSON 就行；
 *   2. 按设置与密钥算出"哪些厂商现在可用、有哪些模型"（本文件）；
 *   3. 真的去请求上游 —— 交给 `src/ai/llm-client.ts`，它只用 `fetch`。
 *
 * 于是同一个 `createApiRouter()` 既能在 Node 里跑（磁盘存储 + pi-ai 的 provider），
 * 也能在浏览器里跑（IndexedDB + catalog.json + llm-client），
 * 上层 `public/app.js` 一行都不用改。
 */
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { ModelResolutionError } from "../ai/model-errors.ts";
import type { ModelSummary, ProviderAuthSource, ProviderStatus } from "../ai/model-types.ts";
import type { BuiltinCatalogEntry } from "../ai/provider-catalog.ts";
import {
	API_FORMATS,
	THINKING_LEVELS,
	isPlaceholderModel,
	type ApiFormat,
	type CostRates,
	type ModelConfig,
	type ModelThinkingLevel,
	type ProviderConfig,
	type Settings,
} from "../config/settings.ts";
import type { LlmClient } from "../ai/llm-client.ts";
import type { CredentialStorePort, SettingsStorePort } from "../store/store-port.ts";

// ───────────────────────────────────────────── catalog.json 的形状

/** catalog.json 里的一个模型（纯数据，没有可执行代码）。 */
export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	cost: CostRates;
}

/**
 * catalog.json 里的一个内置厂商。
 *
 * `specId` 是"我们的"供应商 id（设置文件里用的那个），`id` 是 pi-ai 的 provider id。
 * 对绝大多数厂商两者相同，但中转类的内置供应商不一定 —— 两个都留着。
 */
export interface CatalogProvider {
	id: string;
	specId: string;
	builtinId: string;
	label: string;
	envVars: string[];
	group: string;
	baseUrl: string;
	api: string;
	models: CatalogModel[];
}

export interface BrowserCatalog {
	providers: CatalogProvider[];
}

/**
 * 把目录里的内置厂商补进设置（只追加缺失的，绝不覆盖作者已有的改动）。
 *
 * 服务端有一份等价的 `syncBuiltinProviders()`（`src/ai/models.ts:418`），
 * 它靠 `BUILTIN_PROVIDERS` 拿清单；浏览器没有那份清单，用 `catalog.json` 代替。
 * 两边都必须做这件事，否则设置页里根本看不到内置厂商。
 *
 * 补进来的条目 `models` 留空 —— 模型清单以目录为准（见 `modelsOf()`），
 * 设置里的同 id 条目只当参数覆盖用。返回是否真的改动了设置。
 */
export function syncBuiltinProvidersFromCatalog(settingsStore: SettingsStorePort, catalog: BrowserCatalog): boolean {
	const settings = settingsStore.get();

	// 先把"其实就是内置厂商"的自定义条目收编回内置（与服务端
	// promoteMatchingCustoms 同一条规矩）：早先手工配过 CTTAI 中转的人，
	// 目录补上之后会看到一条同名自定义条目把内置项挡在外面。
	const providers = settings.providers.map((provider) => {
		if (provider.kind !== "custom") return provider;
		const entry = catalog.providers.find(
			(item) => item.specId === provider.id && sameBaseUrl(item.baseUrl, provider.baseUrl),
		);
		if (!entry) return provider;
		return {
			...provider,
			kind: "builtin" as const,
			builtinId: entry.builtinId,
			label: provider.label && provider.label !== provider.id ? provider.label : entry.label,
		};
	});
	const promoted = providers.some((provider, index) => provider !== settings.providers[index]);

	const known = new Set(providers.map((provider) => provider.id));
	const missing: ProviderConfig[] = [];
	for (const entry of catalog.providers) {
		if (known.has(entry.specId)) continue;
		missing.push({
			id: entry.specId,
			label: entry.label,
			kind: "builtin",
			builtinId: entry.builtinId,
			models: [],
			enabled: true,
			updatedAt: 0,
		});
	}
	if (missing.length === 0 && !promoted) return false;
	settingsStore.replace({ ...settings, providers: [...providers, ...missing] });
	return true;
}

/** 比接入点：末尾斜杠与大小写都不算差别。 */
function sameBaseUrl(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}


const EMPTY_COST: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toCost(value: unknown): CostRates {
	const raw = (value ?? {}) as Partial<Record<keyof CostRates, unknown>>;
	const pick = (item: unknown): number => (typeof item === "number" && Number.isFinite(item) ? item : 0);
	return {
		input: pick(raw.input),
		output: pick(raw.output),
		cacheRead: pick(raw.cacheRead),
		cacheWrite: pick(raw.cacheWrite),
	};
}

function toStr(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function toNum(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 宽容地读一份 catalog.json。
 *
 * 目录文件是构建产物，缺了或坏了不该让整个页面炸掉 —— 退化成"没有任何内置厂商"，
 * 设置页会只剩用户自己加的供应商。这样至少还进得去、还能导出数据。
 */
export function parseCatalog(value: unknown): BrowserCatalog {
	const raw = (value ?? {}) as { providers?: unknown };
	const list = Array.isArray(raw.providers) ? raw.providers : [];
	const providers: CatalogProvider[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const specId = toStr(entry.specId) || toStr(entry.id);
		if (!specId) continue;
		const modelsRaw = Array.isArray(entry.models) ? entry.models : [];
		const models: CatalogModel[] = [];
		for (const rawModel of modelsRaw) {
			if (!rawModel || typeof rawModel !== "object") continue;
			const model = rawModel as Record<string, unknown>;
			const id = toStr(model.id);
			if (!id) continue;
			models.push({
				id,
				name: toStr(model.name, id),
				contextWindow: toNum(model.contextWindow),
				maxTokens: toNum(model.maxTokens),
				reasoning: model.reasoning === true,
				cost: toCost(model.cost),
			});
		}
		providers.push({
			id: toStr(entry.id, specId),
			specId,
			builtinId: toStr(entry.builtinId, specId),
			label: toStr(entry.label, specId),
			envVars: Array.isArray(entry.envVars) ? entry.envVars.filter((name): name is string => typeof name === "string") : [],
			group: toStr(entry.group),
			baseUrl: toStr(entry.baseUrl),
			api: toStr(entry.api),
			models,
		});
	}
	return { providers };
}

// ───────────────────────────────────────────── 对外接口

export interface BrowserModelsOptions {
	settingsStore: SettingsStorePort;
	credentialStore: CredentialStorePort;
	catalog: BrowserCatalog;
	/** 浏览器版 LLM 客户端（`src/ai/llm-client.ts` 的 `createLlmClient()`）。 */
	client: LlmClient;
}

/**
 * 浏览器模型门面。
 *
 * 形状与 `ApiRouterDeps["models"]` 对齐（list/status/resolve/rebuild/current），
 * 另外多出两个给路由装配用的小接口。
 */
export interface BrowserModels {
	list(): Promise<ModelSummary[]>;
	status(): Promise<ProviderStatus[]>;
	resolve(reference: string): Promise<Model<Api>>;
	rebuild(): void;
	current(): MutableModels;
	/** 内置厂商目录投影，喂给 `ApiRouterDeps.builtinCatalog`。 */
	builtinCatalog(): BuiltinCatalogEntry[];
	/** 给 llm-client 的 resolveApiKey：从浏览器的凭据库里取一把 key。 */
	apiKey(providerId: string): Promise<string | undefined>;
}

function asApiFormat(value: string | undefined): ApiFormat | undefined {
	return API_FORMATS.includes(value as ApiFormat) ? (value as ApiFormat) : undefined;
}

function thinkingLevelsFor(reasoning: boolean, configured?: readonly ModelThinkingLevel[]): ModelThinkingLevel[] {
	if (!reasoning) return ["off"];
	if (configured && configured.length > 0) return [...configured];
	return [...THINKING_LEVELS];
}

/** 一个对话模型的完整描述（设置里的模型参数优先，目录当兜底）。 */
interface ResolvedModel {
	config: ModelConfig;
	api: ApiFormat;
	baseUrl: string;
	input: CanvasInput;
}

type CanvasInput = Model<Api>["input"];

/**
 * 建浏览器模型门面。
 *
 * 读设置与密钥都是同步的（IndexedDB 版存储把骨架常驻在内存里），
 * 所以这里不需要缓存 —— 每次调用都拿最新的一份，设置页改完立刻生效。
 */
export function createBrowserModels(options: BrowserModelsOptions): BrowserModels {
	const { settingsStore, credentialStore, catalog, client } = options;
	const bySpecId = new Map(catalog.providers.map((provider) => [provider.specId, provider]));
	const byBuiltinId = new Map<string, CatalogProvider>();
	for (const provider of catalog.providers) {
		if (!byBuiltinId.has(provider.builtinId)) byBuiltinId.set(provider.builtinId, provider);
	}

	function catalogEntryOf(provider: ProviderConfig): CatalogProvider | undefined {
		if (provider.kind !== "builtin") return undefined;
		return bySpecId.get(provider.id) ?? byBuiltinId.get(provider.builtinId ?? "") ?? bySpecId.get(provider.builtinId ?? "");
	}

	function apiOf(provider: ProviderConfig, entry: CatalogProvider | undefined): ApiFormat {
		return asApiFormat(provider.api) ?? asApiFormat(entry?.api) ?? "openai-completions";
	}

	function baseUrlOf(provider: ProviderConfig, entry: CatalogProvider | undefined): string {
		const explicit = provider.baseUrl?.trim();
		if (explicit) return explicit;
		return (entry?.baseUrl ?? "").trim();
	}

	/**
	 * 一个厂商现在有哪些模型。
	 *
	 * 自建厂商只认设置里手写的清单；内置厂商以目录为准，设置里的同 id 条目当作
	 * 参数覆盖（作者调过上下文窗口/输出上限/思考档位时以他填的为准）。
	 */
	function modelsOf(provider: ProviderConfig, entry: CatalogProvider | undefined): ModelConfig[] {
		if (provider.kind === "custom" || !entry) return provider.models;
		// 实时模式只认上游清单；静态目录一个都不混入。
		if (provider.modelsSource === "upstream") return provider.models;
		const overrides = new Map(provider.models.map((model) => [model.id, model]));
		return entry.models.map((model) => {
			const override = overrides.get(model.id);
			const base: ModelConfig = {
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				thinkingLevels: thinkingLevelsFor(model.reasoning),
				cost: model.cost,
			};
			if (!override) return base;
			// 只有作者真的写过参数（不是占位值）才覆盖目录。
			const contextWindow =
				isPlaceholderModel(override) || override.contextWindow === base.contextWindow
					? base.contextWindow
					: override.contextWindow;
			const maxTokens =
				isPlaceholderModel(override) || override.maxTokens === base.maxTokens ? base.maxTokens : override.maxTokens;
			const reasoning = override.reasoning ?? base.reasoning;
			return {
				id: base.id,
				name: override.name?.trim() ? override.name : base.name,
				contextWindow,
				maxTokens,
				reasoning,
				thinkingLevels: thinkingLevelsFor(reasoning, override.thinkingLevels),
				cost: override.cost ?? base.cost,
			};
		});
	}

	/** 这个厂商现在能不能用：有 key，或者它自己声明不需要鉴权。 */
	function isRegistered(provider: ProviderConfig): boolean {
		if (!provider.enabled) return false;
		if (provider.noAuthRequired) return true;
		return credentialStore.hasKey(provider.id);
	}

	function authSourceOf(provider: ProviderConfig): ProviderAuthSource {
		// 浏览器里没有环境变量可看：要么浏览器里存着 key，要么没有。
		if (provider.noAuthRequired) return "app";
		return credentialStore.hasKey(provider.id) ? "app" : "none";
	}

	function toPiModel(provider: ProviderConfig, entry: CatalogProvider | undefined, model: ModelConfig): Model<Api> {
		const api = apiOf(provider, entry);
		return {
			id: model.id,
			name: model.name,
			api,
			provider: provider.id,
			baseUrl: baseUrlOf(provider, entry),
			input: ["text"],
			cost: model.cost ?? EMPTY_COST,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		} as Model<Api>;
	}

	function summarize(provider: ProviderConfig, model: ModelConfig): ModelSummary {
		return {
			id: `${provider.id}/${model.id}`,
			provider: provider.id,
			providerLabel: provider.label,
			providerKind: provider.kind,
			modelId: model.id,
			name: model.name,
			api: apiOf(provider, catalogEntryOf(provider)),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			thinkingLevels: thinkingLevelsFor(model.reasoning, model.thinkingLevels),
			placeholder: isPlaceholderModel(model),
			cost: model.cost ?? EMPTY_COST,
		};
	}

	/** 当前可用的"厂商 + 模型"对，顺序稳定（label → 模型名）。 */
	function available(): Array<{ provider: ProviderConfig; entry: CatalogProvider | undefined; model: ModelConfig }> {
		const settings = settingsStore.get();
		const pairs: Array<{ provider: ProviderConfig; entry: CatalogProvider | undefined; model: ModelConfig }> = [];
		for (const provider of settings.providers) {
			if (!isRegistered(provider)) continue;
			const entry = catalogEntryOf(provider);
			for (const model of modelsOf(provider, entry)) pairs.push({ provider, entry, model });
		}
		return pairs;
	}

	async function list(): Promise<ModelSummary[]> {
		return available()
			.map((pair) => summarize(pair.provider, pair.model))
			.sort(
				(a, b) =>
					a.providerLabel.localeCompare(b.providerLabel, "zh-CN") || a.name.localeCompare(b.name, "zh-CN"),
			);
	}

	async function status(): Promise<ProviderStatus[]> {
		const settings: Settings = settingsStore.get();
		return settings.providers.map((provider) => {
			const entry = catalogEntryOf(provider);
			const models = modelsOf(provider, entry);
			const api = asApiFormat(provider.api) ?? asApiFormat(entry?.api);
			const status: ProviderStatus = {
				id: provider.id,
				label: provider.label,
				kind: provider.kind,
				group: entry?.group,
				enabled: provider.enabled,
				baseUrl: baseUrlOf(provider, entry) || undefined,
				api,
				apiFormatKnown: api !== undefined,
				envVars: entry ? [...entry.envVars] : [],
				authSource: authSourceOf(provider),
				maskedKey: credentialStore.maskedKey(provider.id),
				modelCount: models.length,
				configuredModelCount: provider.models.length,
				registered: isRegistered(provider),
			};
			return status;
		});
	}

	async function resolve(reference: string): Promise<Model<Api>> {
		const ref = reference.trim();
		if (!ref) throw new ModelResolutionError("未指定模型");

		const pairs = available();

		// 只按第一个斜杠切分：模型 id 本身可能含斜杠（OpenRouter 的 "vendor/model"）。
		if (ref.includes("/")) {
			const cut = ref.indexOf("/");
			const providerId = ref.slice(0, cut);
			const modelId = ref.slice(cut + 1);
			const hit = pairs.find((pair) => pair.provider.id === providerId && pair.model.id === modelId);
			if (hit) return toPiModel(hit.provider, hit.entry, hit.model);
		}

		const normalized = ref.toLowerCase();
		const fullIds = pairs.map((pair) => `${pair.provider.id}/${pair.model.id}`);

		const byId = pairs.find((pair) => pair.model.id.toLowerCase() === normalized);
		if (byId) return toPiModel(byId.provider, byId.entry, byId.model);

		const byLabel = pairs.find((pair) => pair.model.name.toLowerCase() === normalized);
		if (byLabel) return toPiModel(byLabel.provider, byLabel.entry, byLabel.model);

		const contains = pairs.filter(
			(pair) =>
				pair.model.id.toLowerCase().includes(normalized) || pair.model.name.toLowerCase().includes(normalized),
		);
		if (contains.length === 1 && contains[0]) {
			return toPiModel(contains[0].provider, contains[0].entry, contains[0].model);
		}
		if (contains.length > 1) {
			throw new ModelResolutionError(
				`模型 "${ref}" 匹配到多个结果，请指定 provider`,
				contains.map((pair) => `${pair.provider.id}/${pair.model.id}`),
			);
		}

		throw new ModelResolutionError(
			pairs.length === 0 ? "没有可用模型，请先在设置中配置供应商的 API Key" : `找不到模型 "${ref}"`,
			fullIds,
		);
	}

	async function apiKey(providerId: string): Promise<string | undefined> {
		const credential = await credentialStore.read(providerId);
		const key = credential && credential.type === "api_key" ? credential.key : undefined;
		return key?.trim() ? key : undefined;
	}

	return {
		list,
		status,
		resolve,
		// 浏览器里没有"注册表"这层缓存，设置一变下次调用就是新的。留着是为了形状一致。
		rebuild: () => undefined,
		current: () =>
			({
				streamSimple: client.streamSimple,
				// pi-ai 的 MutableModels 还有一堆注册/查询方法，智能体只用到 streamSimple
				// （见 src/ai/novel-agent.ts 的 withStreamDefaults）。多余的成员不补。
			}) as unknown as MutableModels,
		builtinCatalog: () =>
			catalog.providers.map((provider) => ({
				id: provider.specId,
				label: provider.label,
				envVars: [...provider.envVars],
				...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
				...(asApiFormat(provider.api) ? { api: asApiFormat(provider.api) } : {}),
			})),
		apiKey,
	};
}
