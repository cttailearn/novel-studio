import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * 文件持久化的 CredentialStore，供 createModels 使用。
 *
 * pi-ai 规定 modify 是唯一写入路径，且同一 provider 的 read-modify-write 必须串行。
 * 这里用每 provider 一条 Promise 链保证串行，写入先写临时文件再 rename ，避免半截断。
 */
export class FileCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private readonly chains = new Map<string, Promise<unknown>>();

	private readonly file: string;

	private constructor(file: string) {
		this.file = file;
	}

	static async open(dataDir: string): Promise<FileCredentialStore> {
		await mkdir(dataDir, { recursive: true });
		const file = path.join(dataDir, "credentials.json");
		const store = new FileCredentialStore(file);
		const raw = await readFile(file, "utf8").catch(() => undefined);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Record<string, Credential>;
				for (const [providerId, credential] of Object.entries(parsed)) {
					if (credential && typeof credential === "object") store.credentials.set(providerId, credential);
				}
			} catch (error) {
				console.warn("[credentials] 解析凭据文件失败，已忽略:", error);
			}
		}
		return store;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return [...this.credentials.entries()].map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.serialized(providerId, async () => {
			const current = this.credentials.get(providerId);
			const result = await fn(current);
			// fn 返回 undefined 表示"调用方决定不修改"，而不是"删除"。
			if (result === undefined) return current;
			this.credentials.set(providerId, result);
			await this.flush();
			return result;
		});
	}

	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		// 不能借道 modify：它的 undefined 语义是"不修改"。
		await this.serialized(providerId, async () => {
			if (!this.credentials.delete(providerId)) return undefined;
			await this.flush();
			return undefined;
		});
	}

	/** 同一 provider 的串行调用点，避免并发 read-modify-write 互相覆盖。 */
	private serialized<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.then(fn);
		this.chains.set(
			providerId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/** 应用自身的写入路径：直接设置或清除一个厂商的 key。 */
	async setKey(providerId: string, apiKey: string | undefined): Promise<void> {
		const key = apiKey?.trim();
		if (!key) {
			await this.delete(providerId);
			return;
		}
		await this.modify(providerId, async (current) => {
			// 保留其他字段，例如 provider 级 env。
			return { ...(current ?? { type: "api_key" as const }), type: "api_key" as const, key } as Credential;
		});
	}

	/** 只读查询，不暴露密钥本身。 */
	hasKey(providerId: string): boolean {
		const credential = this.credentials.get(providerId);
		return credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0;
	}

	/** 键的脱显写法，仅用于设置页回显。 */
	maskedKey(providerId: string): string {
		if (!this.hasKey(providerId)) return "";
		return "•••••••";
	}

	private async flush(): Promise<void> {
		const payload = JSON.stringify(Object.fromEntries(this.credentials), null, 2);
		// 临时文件名必须唯一：串行化是按 provider 粒度的，不同 provider 的并发写
		// 会落到同一个固定 tmp 上互相覆盖；多个 store 实例指向同一文件时同理。
		// rename 在 Windows 上覆盖已存在文件会偶发 EPERM，因此重试几次。
		const tmp = this.file + "." + randomUUID() + ".tmp";
		await writeFile(tmp, payload, "utf8");
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, this.file);
				return;
			} catch (error) {
				if (attempt >= 4) throw error;
				await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
	}
}
