/**
 * 模型解析失败的错误类型。
 *
 * 单独成文件，是为了路由层能在浏览器里 `instanceof` 它，
 * 而不必 import 整个 `src/ai/models.ts`（那里面拖着 42 个 provider 与 4 个 SDK）。
 */
export class ModelResolutionError extends Error {
	/** 候选模型 id，便于前端提示「请指定 provider」。 */
	readonly candidates: string[];

	constructor(message: string, candidates: string[] = []) {
		super(message);
		this.name = "ModelResolutionError";
		this.candidates = candidates;
	}
}
