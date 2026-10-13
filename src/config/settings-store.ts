import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSettings, type ProviderConfig, type Settings } from "./settings.ts";

/**
 * 应用设置的持久化存储。
 * 与凭据分文件保存：settings.json 可以安全分享，credentials.json 含密钥，不应进仓。
 * 两者都位于被 git 忽略的 data/ 目录下。
 */
export class SettingsStore {
	private settings: Settings;
	private writeChain: Promise<void> = Promise.resolve();

	private readonly file: string;

	private constructor(file: string, settings: Settings) {
		this.file = file;
		this.settings = settings;
	}

	static async open(dataDir: string): Promise<SettingsStore> {
		await mkdir(dataDir, { recursive: true });
		const file = path.join(dataDir, "settings.json");
		const raw = await readFile(file, "utf8").catch(() => undefined);
		const settings = raw ? normalizeSettings(safeParse(raw)) : normalizeSettings(null);
		return new SettingsStore(file, settings);
	}

	get(): Settings {
		return this.settings;
	}

	getProvider(id: string): ProviderConfig | undefined {
		return this.settings.providers.find((provider) => provider.id === id);
	}

	/** 以一次写入替换整份设置，并经串行化落盘。 */
	replace(next: Settings): Settings {
		this.settings = normalizeSettings(next);
		void this.persist();
		return this.settings;
	}

	mutate(fn: (settings: Settings) => void): Settings {
		const draft = structuredClone(this.settings);
		fn(draft);
		return this.replace(draft);
	}

	upsertProvider(provider: ProviderConfig): ProviderConfig {
		const next: ProviderConfig = { ...provider, updatedAt: Date.now() };
		this.mutate((settings) => {
			const index = settings.providers.findIndex((item) => item.id === next.id);
			if (index >= 0) settings.providers[index] = next;
			else settings.providers.push(next);
		});
		return next;
	}

	removeProvider(id: string): boolean {
		let removed = false;
		this.mutate((settings) => {
			const before = settings.providers.length;
			settings.providers = settings.providers.filter((provider) => provider.id !== id);
			removed = settings.providers.length !== before;
			if (settings.defaultModel.startsWith(id + "/")) settings.defaultModel = "";
		});
		return removed;
	}

	private persist(): Promise<void> {
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const tmp = `${this.file}.tmp`;
				await writeFile(tmp, JSON.stringify(this.settings, null, 2), "utf8");
				await rename(tmp, this.file);
			})
			.catch((error) => console.error("[settings] 落盘失败:", error))
			.then(() => undefined);
		return this.writeChain;
	}
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		console.warn("[settings] 解析设置文件失败，已忽略:", error);
		return null;
	}
}
