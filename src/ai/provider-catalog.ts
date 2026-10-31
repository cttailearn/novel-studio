/**
 * 内置厂商目录的形状（纯类型）。
 *
 * 目录本身只有一份真源：`src/ai/models.ts` 的 `BUILTIN_PROVIDERS`。
 * 服务端把它投影成这个形状塞进 `ApiRouterDeps.builtinCatalog`；
 * 浏览器侧则由构建脚本（`scripts/browser-build.ts`）从 `BUILTIN_PROVIDERS`
 * 导出成 `public/browser/vendor/catalog.json`，运行时读 JSON 填同样的形状。
 *
 * 这样路由层既不必 import 重模块 `models.ts`，两边也不会各写一份 42 条目录。
 */

/** 内置厂商目录里的一条记录。 */
export interface BuiltinCatalogEntry {
	/** 厂商 id，例如 "anthropic"。 */
	id: string;
	/** 展示名。 */
	label: string;
	/** 这个厂商认的环境变量名，用来提示用户配 key。 */
	envVars: string[];
	/** 内置接入点（实时拉取模型要用）。 */
	baseUrl?: string;
	/** 默认接口格式，用来决定 /models 路径与鉴权头。 */
	api?: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
}
