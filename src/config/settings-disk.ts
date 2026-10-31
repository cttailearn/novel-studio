/**
 * 应用设置的磁盘持久化实现。
 *
 * 纯模型（设置的数据形状与归一化）在 settings.ts / settings-store.ts ——
 * 那一层不碰文件系统，所以浏览器端的 IndexedDB 实现可以照着同一个接口重写一遍。
 * 本文件只负责把设置落到 <dataDir>/settings.json。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "../store/project.ts";
import { normalizeSettings, type ProviderConfig, type Settings } from "./settings.ts";
import type { SettingsStorePort } from "../store/store-port.ts";

/**
 * 应用设置的持久化存储。
 * 与凭据分文件保存：settings.json 可以安全分享，credentials.json 含密钥，不应进仓。
 * 两者都位于被 git 忽略的 data/ 目录下。
 */
export class SettingsStore implements SettingsStorePort {
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
		if (raw === undefined) return new SettingsStore(file, normalizeSettings(null));

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			// 解析失败不能当成"空配置"直接继续：下一次落盘会拿默认配置覆盖原文，
			// 用户配的供应商、模型与默认模型全没了，而且没有备份。
			// 改名隔离，原文留在磁盘上可人工恢复；这次先用默认值把应用跑起来。
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const kept = file + ".corrupt-" + stamp;
			try {
				await rename(file, kept);
				console.error(
					"[settings] 设置文件不是合法 JSON，已隔离为 " + path.basename(kept) + "，本次使用默认设置。请检查该文件恢复自定义配置：",
					error,
				);
			} catch (renameError) {
				// 改名失败（例如被占用）时宁可保留原文件，也别让它被后续写入覆盖。
				console.error("[settings] 设置文件不是合法 JSON，且隔离改名失败（本次使用默认设置）:", renameError, error);
			}
			return new SettingsStore(file, normalizeSettings(null));
		}
		return new SettingsStore(file, normalizeSettings(parsed));
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

	/**
	 * 串行化落盘。
	 *
	 * 临时文件名带随机后缀：唯一的写入路径还不够，Windows 上 rename 覆盖
	 * 已存在文件会偶发 EPERM，因此重试几次。留着的 .tmp 由下次写入覆盖。
	 */
	private persist(): Promise<void> {
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(async () => {
				const tmp = this.file + "." + newId() + ".tmp";
				await writeFile(tmp, JSON.stringify(this.settings, null, 2), "utf8");
				for (let attempt = 0; ; attempt++) {
					try {
						await rename(tmp, this.file);
						return;
					} catch (error) {
						if (attempt >= 4) throw error;
						await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
					}
				}
			})
			.catch((error) => {
				console.error("[settings] 落盘失败:", error);
				throw error;
			});
		return this.writeChain;
	}

	/** 调用方在回复设置保存成功前必须等待真实落盘。 */
	async flush(): Promise<void> {
		await this.writeChain;
	}
}
