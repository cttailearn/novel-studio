import { existsSync } from "node:fs";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** 解析 .env 到 process.env。文件不存在时静默跳过。 */
export function loadEnvFile(): void {
	const file = process.env.NOVEL_STUDIO_ENV_FILE ?? path.resolve(process.cwd(), ".env");
	if (!existsSync(file)) return;
	try {
		process.loadEnvFile(file);
	} catch (error) {
		console.warn(`[config] 读取 ${file} 失败，忽略:`, error);
	}
}

export interface AppConfig {
	port: number;
	host: string;
	dataDir: string;
	/** "provider/modelId"；为空表示由前端选择。 */
	defaultModel: string;
	defaultThinkingLevel: ThinkingLevel;
	maxTokens: number | undefined;
	temperature: number | undefined;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function num(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function readConfig(): AppConfig {
	const thinking = (process.env.DEFAULT_THINKING_LEVEL ?? "off").trim() as ThinkingLevel;
	return {
		port: num(process.env.PORT) ?? 8787,
		host: process.env.HOST?.trim() || "127.0.0.1",
		dataDir: path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || "./data"),
		defaultModel: process.env.DEFAULT_MODEL?.trim() || "",
		defaultThinkingLevel: THINKING_LEVELS.includes(thinking) ? thinking : "off",
		maxTokens: num(process.env.MAX_TOKENS),
		temperature: num(process.env.TEMPERATURE),
	};
}
