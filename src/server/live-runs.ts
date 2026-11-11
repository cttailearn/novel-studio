/**
 * 正在跑的那一轮，与「这条连接」分开存。
 *
 * 从前一轮生成和一条 HTTP 响应是绑死的：浏览器一关、网络一抖，
 * 服务端就在 close 里把 agent.abort()，半天的字一个字不剩，事后连日志都没有。
 *
 * 现在一轮生成是一个实体（LiveRun）：
 *   - 事件先进环形缓冲，再有几条订阅连接就发几份；
 *   - 订阅断了只是少一个看客，生成照跑，章末照常落盘；
 *   - 客户端回来时按 `since=<seq>` 补发漏掉的那段，看起来像没断过；
 *   - 真要停，走 abort 接口明确说一声，别再靠"关连接"暗示。
 *
 * 这里不碰 Node 也不碰浏览器：两边共用同一份，才能让本机模式与云端一个行为。
 */

/** 一轮生成的生命周期。 */
export type RunStatus = "running" | "done" | "aborted" | "failed";

/** 谁发起的：一次性成文，还是对议里的一问一答。 */
export type RunKind = "write" | "session" | "polish";

export interface RunInit {
	id: string;
	kind: RunKind;
	/** 写作轮次才有。 */
	projectId?: string;
	chapterId?: string;
	/** 会话轮次才有。 */
	sessionId?: string;
	role?: string;
	model?: string;
	label?: string;
}

/** 一条订阅连接。Node 与浏览器各自的 sink 适配成这两个方法即可。 */
export interface RunSubscriber {
	write(chunk: string): void;
	end(): void;
}

/** 事件的序号与内容。序号从 1 开始，客户端拿它做 `since`。 */
interface BufferedEvent {
	seq: number;
	event: unknown;
}

/** 缓冲上限：一轮长章跑下来事件不少，但只留最近这些供补发。 */
const MAX_EVENTS = 4000;

/** 跑完的轮次留这么久，够客户端刷新一次页面回来接上。 */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

/** 兜底：超过这么久还在跑的，按超时中止，免得一条坏流永远占着章锁。 */
export const MAX_RUN_MS = 2 * 60 * 60 * 1000;

export class LiveRun {
	readonly id: string;
	readonly kind: RunKind;
	readonly projectId?: string;
	readonly chapterId?: string;
	readonly sessionId?: string;
	readonly role?: string;
	/** 跑起来之后才知道用的是哪个模型，因此可写。 */
	model?: string;
	label?: string;

	status: RunStatus = "running";
	startedAt = Date.now();
	endedAt = 0;
	error = "";
	abortReason = "";
	/** 已经发出去的事件总数，客户端回来时拿它对自己收到的 lastSeq。 */
	seq = 0;

	private events: BufferedEvent[] = [];
	private subs = new Set<RunSubscriber>();
	private abortFn: (() => void) | null = null;

	constructor(init: RunInit) {
		this.id = init.id;
		this.kind = init.kind;
		this.projectId = init.projectId;
		this.chapterId = init.chapterId;
		this.sessionId = init.sessionId;
		this.role = init.role;
		this.model = init.model;
		this.label = init.label;
	}

	/**
	 * 登记这一轮怎么停。
	 *
	 * 可能在 abort 之后才登记（例如先把 abort 接口的请求处理完），
	 * 因此登记时若已经请求过停止，要立刻执行一次。
	 */
	setAbort(fn: () => void): void {
		this.abortFn = fn;
		if (this.abortReason) fn();
	}

	/** 发一条事件：先编号入缓冲，再发给每一条还连着的订阅。 */
	publish(event: unknown): void {
		if (this.status !== "running") return;
		const seq = ++this.seq;
		if (this.events.length >= MAX_EVENTS) this.events.shift();
		this.events.push({ seq, event });
		const line = JSON.stringify({ ...(event as Record<string, unknown>), seq }) + "\n";
		for (const sub of this.subs) {
			try {
				sub.write(line);
			} catch {
				// 某条连接断了不该影响别的看客，也不该影响这一轮。
				this.subs.delete(sub);
			}
		}
	}

	/**
	 * 接上这一轮：先把 `since` 之后的事件补发一遍，再挂成实时订阅。
	 *
	 * 已经跑完的轮次补发完就收尾，不挂着。
	 */
	subscribe(sub: RunSubscriber, since = 0): () => void {
		let broke = false;
		this.replay(since, (line) => {
			try {
				sub.write(line);
			} catch {
				broke = true;
			}
		});
		if (broke) return () => {};
		if (this.status !== "running") {
			try {
				sub.end();
			} catch {
				// 已经关了就算了。
			}
			return () => {};
		}
		this.subs.add(sub);
		return () => this.subs.delete(sub);
	}

	/** 把 `since` 之后的缓冲事件逐行交给调用方（补发用）。 */
	replay(since: number, write: (line: string) => void): void {
		for (const item of this.events) {
			if (item.seq <= since) continue;
			write(JSON.stringify({ ...(item.event as Record<string, unknown>), seq: item.seq }) + "\n");
		}
	}

	/** 明确叫停。只有还在跑的轮次才有效；重复调用返回 false。 */
	abort(reason = "user"): boolean {
		if (this.status !== "running" || this.abortReason) return false;
		this.abortReason = reason;
		this.abortFn?.();
		return true;
	}

	/** 收尾：改状态、断订阅、把结论留给事后查。 */
	finish(status: RunStatus, error = ""): void {
		if (this.status !== "running") return;
		this.status = status;
		this.error = error;
		this.endedAt = Date.now();
		for (const sub of this.subs) {
			try {
				sub.end();
			} catch {
				// 收尾时的写失败没有补救意义。
			}
		}
		this.subs.clear();
	}

	/** 对外的一份摘要：不含事件，列表接口用它。 */
	snapshot() {
		return {
			id: this.id,
			kind: this.kind,
			status: this.status,
			projectId: this.projectId,
			chapterId: this.chapterId,
			sessionId: this.sessionId,
			role: this.role,
			model: this.model,
			label: this.label,
			startedAt: this.startedAt,
			endedAt: this.endedAt || undefined,
			seq: this.seq,
			error: this.error || undefined,
			abortReason: this.abortReason || undefined,
		};
	}

	/** 自己这一轮占的内存，给 sweep 判断用。 */
	get finished(): boolean {
		return this.status !== "running";
	}
}

/** 一轮跑完时的观察者。服务端拿它写 journal，浏览器里不传。 */
export type RunObserver = (run: LiveRun) => void;

export class LiveRunRegistry {
	private runs = new Map<string, LiveRun>();
	private observer?: RunObserver;

	constructor(observer?: RunObserver) {
		this.observer = observer;
	}

	create(init: RunInit): LiveRun {
		const run = new LiveRun(init);
		this.runs.set(run.id, run);
		return run;
	}

	get(id: string): LiveRun | undefined {
		return this.runs.get(id);
	}

	list(filter: { projectId?: string; status?: RunStatus; kind?: RunKind } = {}): LiveRun[] {
		const out: LiveRun[] = [];
		for (const run of this.runs.values()) {
			if (filter.projectId && run.projectId !== filter.projectId) continue;
			if (filter.status && run.status !== filter.status) continue;
			if (filter.kind && run.kind !== filter.kind) continue;
			out.push(run);
		}
		return out.sort((a, b) => b.startedAt - a.startedAt);
	}

	/**
	 * 周期清理。
	 *
	 * 跑太久的按超时中止（章锁才能释放），跑完的过了保留期就丢掉。
	 * 返回这一轮收掉的条数，方便调用方判断要不要再扫。
	 */
	sweep(now = Date.now()): number {
		let removed = 0;
		for (const [id, run] of this.runs) {
			if (run.status === "running") {
				if (now - run.startedAt > MAX_RUN_MS) {
					run.abort("timeout");
					run.finish("aborted", "跑得太久，已按超时中止");
					this.observer?.(run);
				}
				continue;
			}
			if (run.endedAt && now - run.endedAt > KEEP_FINISHED_MS) {
				this.runs.delete(id);
				removed += 1;
			}
		}
		return removed;
	}

	/** 轮次收尾：交给观察者记一笔，再等 sweep 回收。 */
	report(run: LiveRun): void {
		this.observer?.(run);
	}
}

/**
 * 同一部作品最多同时跑几轮。
 *
 * 两章并行是正常用法，但同一部书里开五六轮只会互相抢模型配额、
 * 把稿子写乱。超出的排队等，作者看得见自己在第几位。
 */
export class ProjectLimiter {
	private readonly limit: number;
	private active = new Map<string, number>();
	private queue: { projectId: string; grant: () => void }[] = [];

	constructor(limit = 2) {
		this.limit = Math.max(1, limit);
	}

	/** 排到位置之前先告诉调用方自己在第几位。 */
	async acquire(projectId: string, onWait?: (position: number) => void): Promise<() => void> {
		const running = this.active.get(projectId) ?? 0;
		if (running < this.limit) {
			this.active.set(projectId, running + 1);
			return () => this.release(projectId);
		}
		const position = this.queue.filter((item) => item.projectId === projectId).length + 1;
		onWait?.(position);
		return new Promise<() => void>((resolve) => {
			this.queue.push({
				projectId,
				grant: () => {
					this.active.set(projectId, (this.active.get(projectId) ?? 0) + 1);
					resolve(() => this.release(projectId));
				},
			});
		});
	}

	private release(projectId: string): void {
		const running = (this.active.get(projectId) ?? 1) - 1;
		if (running <= 0) this.active.delete(projectId);
		else this.active.set(projectId, running);
		const next = this.queue.findIndex((item) => item.projectId === projectId);
		if (next >= 0) {
			const [item] = this.queue.splice(next, 1);
			item?.grant();
		}
	}

	/** 当前排队与在跑的数量，测试与 /api/runs 摘要用。 */
	stats(projectId: string): { running: number; queued: number } {
		return {
			running: this.active.get(projectId) ?? 0,
			queued: this.queue.filter((item) => item.projectId === projectId).length,
		};
	}
}
