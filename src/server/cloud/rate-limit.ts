/**
 * 内存滑动窗口限流。
 *
 * 只挡暴力破解，不做持久化：进程重启后人手再试几次也无所谓，
 * 而写库反而会让每条失败请求都产生一次磁盘 IO。
 *
 * 每个 key 只保留窗口内的命中时间戳，命中数本来就被 limit 封顶，
 * 所以单个 key 的内存占用是有界的；key 总数也设了上限，防止换 IP 刷爆内存。
 */
export class SlidingWindowLimiter {
	private readonly limit: number;
	private readonly windowMs: number;
	private readonly maxKeys: number;
	private readonly hits = new Map<string, number[]>();

	constructor(limit: number, windowMs: number, maxKeys = 4096) {
		this.limit = Math.max(1, Math.floor(limit));
		this.windowMs = Math.max(1000, Math.floor(windowMs));
		this.maxKeys = Math.max(16, Math.floor(maxKeys));
	}

	/** 只看还能不能试：返回 0 表示允许，否则是还需等待的毫秒数。 */
	peek(key: string, now: number): number {
		const list = this.hits.get(key);
		if (!list) return 0;
		// 窗口是滑动的，先丢掉滑出去的，再看剩多少。
		while (list.length > 0 && (list[0] ?? 0) <= now - this.windowMs) list.shift();
		if (list.length < this.limit) return 0;
		const oldest = list[0] ?? now;
		return Math.max(1, oldest + this.windowMs - now);
	}

	/** 记一次尝试；返回 0 表示这次放行，否则是还需等待的毫秒数（此时不记录）。 */
	hit(key: string, now: number): number {
		const wait = this.peek(key, now);
		if (wait > 0) return wait;
		let list = this.hits.get(key);
		if (!list) {
			if (this.hits.size >= this.maxKeys) this.evictOldest();
			list = [];
			this.hits.set(key, list);
		}
		list.push(now);
		return 0;
	}

	/** 成功之后清掉这个 key：一次成功登录不该继续背着之前的失败次数。 */
	reset(key: string): void {
		this.hits.delete(key);
	}

	/** 清掉所有 key 下的过期记录。定时调用，防止长期运行攒出一堆空数组。 */
	prune(now: number): void {
		for (const [key, list] of this.hits) {
			while (list.length > 0 && (list[0] ?? 0) <= now - this.windowMs) list.shift();
			if (list.length === 0) this.hits.delete(key);
		}
	}

	clear(): void {
		this.hits.clear();
	}

	/** Map 按插入序迭代，删最早的 key 就够了。 */
	private evictOldest(): void {
		const first = this.hits.keys().next();
		if (!first.done) this.hits.delete(first.value);
	}
}
