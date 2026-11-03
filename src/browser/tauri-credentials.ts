/**
 * Tauri 下的厂商密钥存储：key 进系统密钥串，SQLite 只留元信息。
 *
 * 业务层只依赖 `CredentialStorePort`，所以这里不碰 UI/路由：
 *   - 能拿到系统密钥串时，key 永远不写 SQLite；
 *   - 读不到密钥串（移动端 v1）时整体退回 `IdbCredentialStore`，
 *     不假装安全，也不改变已有行为；
 *   - 首次启动会把历史 SQLite 里的明文 key 迁到密钥串，再把明文从行里剥掉。
 */
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { MASKED_KEY } from "../config/credential-store.ts";
import { IdbCredentialStore } from "../store/idb-stores.ts";
import type { CredentialStorePort } from "../store/store-port.ts";
import { invoke } from "./tauri.ts";

interface SecureAvailability {
	available: boolean;
	backend: string;
	note: string;
}

export class TauriCredentialStore implements CredentialStore, CredentialStorePort {
	private readonly base: IdbCredentialStore;
	private readonly keys = new Map<string, string>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private available = false;

	private constructor(base: IdbCredentialStore) {
		this.base = base;
	}

	static async open(base: IdbCredentialStore): Promise<TauriCredentialStore> {
		const store = new TauriCredentialStore(base);
		await store.initialize();
		return store;
	}

	private async initialize(): Promise<void> {
		let availability: SecureAvailability;
		try {
			availability = await invoke<SecureAvailability>("secure_available");
		} catch {
			return;
		}
		if (!availability.available) return;
		this.available = true;
		const infos = await this.base.list();
		for (const info of infos) {
			const legacy = await this.base.read(info.providerId);
			const key = legacy?.type === "api_key" ? legacy.key?.trim() : undefined;
			if (key && legacy) {
				try {
					await invoke("secure_set", { id: info.providerId, value: key });
					this.keys.set(info.providerId, key);
					// 已经在密钥串里了，SQLite 行只保留 type/env，绝不留明文。
					await this.stripBaseKey(info.providerId, legacy);
				} catch {
					// 密钥串写失败：先留在内存，旧行不删，至少不丢 key。
					this.keys.set(info.providerId, key);
				}
				continue;
			}
			if (legacy?.type !== "api_key") continue;
			try {
				const stored = await invoke<string | null>("secure_get", { id: info.providerId });
				if (stored) this.keys.set(info.providerId, stored);
			} catch {
				/* 单个厂商读失败不影响其他厂商 */
			}
		}
	}

	private async stripBaseKey(providerId: string, current: Credential): Promise<void> {
		const env = current.type === "api_key" ? current.env : undefined;
		await this.base.modify(providerId, async () => (env ? { type: "api_key" as const, env } : { type: "api_key" as const }));
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		if (!this.available) return this.base.read(providerId, options);
		const metadata = await this.base.read(providerId, options);
		if (metadata?.type === "oauth") return metadata;
		const key = this.keys.get(providerId);
		if (!key) return metadata;
		const env = metadata?.type === "api_key" ? metadata.env : undefined;
		return env ? { type: "api_key", key, env } : { type: "api_key", key };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		if (!this.available) return this.base.list(options);
		const infos = [...(await this.base.list(options))];
		const seen = new Set(infos.map((info) => info.providerId));
		for (const [providerId, key] of this.keys) {
			if (key && !seen.has(providerId)) infos.push({ providerId, type: "api_key" });
		}
		return infos;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		if (!this.available) return this.base.modify(providerId, fn, options);
		return this.serialized(providerId, async () => {
			const current = await this.read(providerId, options);
			const result = await fn(current);
			if (result === undefined) return current;
			if (result.type === "api_key") {
				const key = result.key?.trim();
				const metadata: Credential = result.env
					? { type: "api_key", env: result.env }
					: { type: "api_key" };
				if (key) {
					await invoke("secure_set", { id: providerId, value: key });
					this.keys.set(providerId, key);
				} else {
					await invoke("secure_delete", { id: providerId }).catch(() => undefined);
					this.keys.delete(providerId);
				}
				// SQLite 只留 type/env，不再写 key。
				await this.base.modify(providerId, async () => metadata, options);
				return result;
			}
			// OAuth 仍交给原存储（当前没有 OAuth 提供商，保留扩展位）。
			await this.base.modify(providerId, async () => result, options);
			return result;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		if (!this.available) {
			await this.base.delete(providerId, options);
			return;
		}
		await this.serialized(providerId, async () => {
			await invoke("secure_delete", { id: providerId }).catch(() => undefined);
			this.keys.delete(providerId);
			await this.base.delete(providerId, options);
		});
	}

	async setKey(providerId: string, apiKey: string | undefined): Promise<void> {
		if (!this.available) {
			await this.base.setKey(providerId, apiKey);
			return;
		}
		const key = apiKey?.trim();
		if (!key) {
			await this.delete(providerId);
			return;
		}
		await this.modify(providerId, async (current) => {
			const env = current?.type === "api_key" ? current.env : undefined;
			return env ? { type: "api_key", key, env } : { type: "api_key", key };
		});
	}

	hasKey(providerId: string): boolean {
		if (!this.available) return this.base.hasKey(providerId);
		return Boolean(this.keys.get(providerId));
	}

	maskedKey(providerId: string): string {
		return this.hasKey(providerId) ? MASKED_KEY : "";
	}

	async flush(): Promise<void> {
		await this.base.flush();
	}

	async retryPending(): Promise<void> {
		await this.base.retryPending();
	}

	close(): void {
		this.base.close();
	}

	private serialized<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this.chains.set(
			providerId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}
}
