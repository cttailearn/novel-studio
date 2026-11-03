/**
 * Tauri 2 的浏览器侧适配。
 *
 * 这里只碰两样东西：
 *   1. `invoke` —— 调 Rust 命令（SQLite、keyring、文件、流式代理）；
 *   2. `createTauriFetch` —— 把标准 fetch 的请求转给 Rust 的 `proxy_stream`，
 *      再把 Rust 推回来的字节流包成一个真正的 `Response`。
 *
 * 为什么不用浏览器直连：Tauri WebView 里没有 CORS 豁免，厂商接口大多不放行；
 * 更重要的是，密钥不该出现在 WebView 的 Network 面板里。Rust 代理只把
 * 「已经拼好鉴权头」的请求发出去，前端始终拿不到也不需要暴露给页面脚本。
 *
 * tsconfig 没有 DOM lib（和 src/store/project-idb.ts 一样），所以这里的
 * DOM 类型全部按最小结构用 any 取，运行时就是 WebView 的真实实现。
 */

interface TauriChannelLike<T> {
	onmessage: ((message: T) => void) | null;
}

interface TauriGlobal {
	core?: {
		invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
		Channel?: new <T>() => TauriChannelLike<T>;
	};
}

interface ProxyEvent {
	type: "response" | "chunk" | "end" | "error";
	status?: number;
	headers?: Record<string, string>;
	url?: string;
	data?: string;
	message?: string;
}

function tauriGlobal(): TauriGlobal | undefined {
	const global = globalThis as unknown as {
		__TAURI__?: TauriGlobal;
		__TAURI_INTERNALS__?: unknown;
	};
	if (global.__TAURI__) return global.__TAURI__;
	return undefined;
}

/** 当前页面是否跑在 Tauri 壳里。 */
export function isTauri(): boolean {
	const global = globalThis as unknown as {
		__TAURI__?: unknown;
		__TAURI_INTERNALS__?: unknown;
	};
	return Boolean(global.__TAURI__ || global.__TAURI_INTERNALS__);
}

/** 调一个 Rust 命令；不在 Tauri 里直接报错，避免静默走错分支。 */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	const core = tauriGlobal()?.core;
	if (!core?.invoke) return Promise.reject(new Error("当前不在 Tauri 环境里，无法调用 " + command));
	return core.invoke<T>(command, args);
}

/** 建一个 Tauri Channel；没有全局 API 时返回 null。 */
export function createChannel<T>(): TauriChannelLike<T> | null {
	const Channel = tauriGlobal()?.core?.Channel;
	if (!Channel) return null;
	return new Channel<T>();
}

function randomId(): string {
	const crypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
	if (crypto?.randomUUID) return crypto.randomUUID();
	return "tauri-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function headerRecord(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	const global = globalThis as unknown as { Headers?: new (init?: unknown) => { forEach(fn: (value: string, key: string) => void): void } };
	if (typeof headers === "object" && global.Headers && headers instanceof global.Headers) {
		(headers as InstanceType<NonNullable<typeof global.Headers>>).forEach((value, key) => {
			out[key.toLowerCase()] = value;
		});
		return out;
	}
	if (Array.isArray(headers)) {
		for (const pair of headers as [string, string][]) {
			if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
		}
		return out;
	}
	if (typeof headers === "object") {
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			if (typeof value === "string") out[key.toLowerCase()] = value;
		}
	}
	return out;
}

function requestBody(body: unknown): string | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
	if (typeof body === "object") {
		const candidate = body as { toString?: () => string };
		if (typeof candidate.toString === "function" && candidate.toString !== Object.prototype.toString) {
			return candidate.toString();
		}
	}
	throw new Error("Tauri 代理只接受文本请求体");
}

function decodeBase64(data: string): Uint8Array {
	const global = globalThis as unknown as { atob?: (input: string) => string };
	if (!global.atob) throw new Error("当前环境缺少 atob");
	const binary = global.atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** 把 Tauri Channel 的字节流包成 fetch 风格的函数。 */
export function createTauriFetch(): typeof globalThis.fetch {
	const fetchLike = async (input: unknown, init?: unknown): Promise<unknown> => {
		const global = globalThis as unknown as {
			Response?: new (body?: unknown, init?: unknown) => unknown;
			ReadableStream?: new (source: {
				start?: (controller: unknown) => void;
				cancel?: () => void;
			}) => unknown;
			Headers?: new (init?: unknown) => unknown;
		};
		if (!global.Response || !global.ReadableStream) {
			throw new Error("当前 WebView 缺少 Response/ReadableStream，无法走 Tauri 代理");
		}

		const rawInput = input as { url?: string; href?: string } | string;
		const url = typeof rawInput === "string" ? rawInput : rawInput?.url ?? rawInput?.href ?? "";
		if (!url) throw new Error("请求缺少 URL");
		const options = (init ?? {}) as {
			method?: string;
			headers?: unknown;
			body?: unknown;
			signal?: { aborted?: boolean; addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void };
		};

		const headers = headerRecord(options.headers);
		let apiKey: string | undefined;
		let authHeader: string | undefined;
		let authScheme = "";
		const authorization = headers.authorization;
		if (authorization && /^Bearer\s+/i.test(authorization)) {
			apiKey = authorization.replace(/^Bearer\s+/i, "");
			authHeader = "authorization";
			authScheme = "Bearer ";
		} else if (headers["x-api-key"]) {
			apiKey = headers["x-api-key"];
			authHeader = "x-api-key";
		} else if (headers["x-goog-api-key"]) {
			apiKey = headers["x-goog-api-key"];
			authHeader = "x-goog-api-key";
		}
		delete headers.authorization;
		delete headers["x-api-key"];
		delete headers["x-goog-api-key"];

		const id = randomId();
		const channel = createChannel<ProxyEvent>();
		if (!channel) throw new Error("Tauri Channel 未初始化，无法发起流式请求");

		return await new Promise<unknown>((resolve, reject) => {
			let controller: { enqueue: (chunk: Uint8Array) => void; close: () => void; error: (error: unknown) => void } | null = null;
			let responseStarted = false;
			let finished = false;
			let pending: Uint8Array[] = [];
			let status = 0;
			let responseHeaders: Record<string, string> = {};
			let responseUrl = url;

			const stream = new global.ReadableStream!({
				start(nextController: unknown) {
					controller = nextController as typeof controller;
				},
				cancel() {
					void invoke("proxy_abort", { id }).catch(() => undefined);
				},
			});

			const fail = (error: unknown): void => {
				if (finished) return;
				finished = true;
				if (responseStarted && controller) {
					try {
						controller.error(error);
					} catch {
						/* 流已经关掉了 */
					}
					return;
				}
				reject(error);
			};

			const maybeResolve = (): void => {
				if (responseStarted) return;
				responseStarted = true;
				const ResponseCtor = global.Response!;
				const HeadersCtor = global.Headers;
				const responseInit: Record<string, unknown> = {
					status,
					statusText: "",
					headers: HeadersCtor ? new HeadersCtor(responseHeaders) : responseHeaders,
				};
				resolve(new ResponseCtor(stream, responseInit));
				for (const chunk of pending) {
					try {
						controller?.enqueue(chunk);
					} catch {
						/* 流已关闭 */
					}
				}
				pending = [];
			};

			channel.onmessage = (event: ProxyEvent) => {
				if (!event || finished) return;
				if (event.type === "response") {
					status = event.status ?? 200;
					responseHeaders = event.headers ?? {};
					responseUrl = event.url ?? url;
					maybeResolve();
					return;
				}
				if (event.type === "chunk") {
					const bytes = decodeBase64(event.data ?? "");
					if (responseStarted && controller) controller.enqueue(bytes);
					else pending.push(bytes);
					return;
				}
				if (event.type === "end") {
					finished = true;
					// 有的上游没有 response 事件（极少数），至少把 promise 解开。
					maybeResolve();
					try {
						controller?.close();
					} catch {
						/* 已经关闭 */
					}
					return;
				}
				if (event.type === "error") {
					fail(new Error(event.message || "上游请求失败"));
				}
			};

			const onAbort = (): void => {
				void invoke("proxy_abort", { id }).catch(() => undefined);
				fail(new Error("已中止"));
			};
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener?.("abort", onAbort);

			// 不 await：这个 promise 要等整个流结束才 resolve，fetch 不能等它。
			void invoke("proxy_stream", {
				request: {
					id,
					url,
					method: (options.method ?? "GET").toUpperCase(),
					headers,
					body: requestBody(options.body),
					apiKey,
					authHeader,
					authScheme,
				},
				onEvent: channel,
			}).catch((error: unknown) => {
				fail(error instanceof Error ? error : new Error(String(error)));
			}).finally(() => {
				// 正常结束时 Rust 已经发过 end；这里兜底，避免连接泄漏。
				if (!finished) {
					finished = true;
					maybeResolve();
					try {
						controller?.close();
					} catch {
						/* 已经关闭 */
					}
				}
			});
		});
	};
	return fetchLike as unknown as typeof globalThis.fetch;
}
