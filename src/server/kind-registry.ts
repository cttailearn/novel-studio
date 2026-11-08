/**
 * 自定义素材种类的多用户登记表。
 *
 * 素材种类的校验（isKnownKind）查的是 store/project.ts 里的一张模块级表，
 * 因为智能体的工具 schema、素材录入、界面分组都问它。单机模式只有一位作者，
 * 整表重填没问题；云端模式有多个用户，A 自建的分类不能因此让 B 也能用，
 * 也不能在 B 的种类目录里露出来。
 *
 * 做法：每个用户各记一份，全局表填「所有活跃用户自定义种类的并集」，
 * 保证任何人的素材都能通过校验；「可见目录」再按用户过滤（api-router 的
 * allowedKinds）。这样既不会丢数据，也不会串门。
 */
import { registerCustomKinds } from "../store/project.ts";

export interface KindEntry {
	id: string;
	label: string;
}

export class KindRegistry {
	private readonly byUser = new Map<string, readonly KindEntry[]>();

	/** 某用户的种类表变了（增删改或首次载入）。 */
	update(userId: string, list: readonly KindEntry[]): void {
		this.byUser.set(userId, [...list]);
		this.refresh();
	}

	/** 某用户的工作区卸载/删号。 */
	remove(userId: string): void {
		if (!this.byUser.delete(userId)) return;
		this.refresh();
	}

	/** 这位用户可见的自定义 kind 集合；内置 kind 不在此列。 */
	allowedFor(userId: string): ReadonlySet<string> {
		return new Set((this.byUser.get(userId) ?? []).map((entry) => entry.id));
	}

	/** 当前有多少用户在表里（测试/运维用）。 */
	get size(): number {
		return this.byUser.size;
	}

	/** 把并集重填进全局表。 */
	private refresh(): void {
		const union = new Map<string, KindEntry>();
		for (const list of this.byUser.values()) {
			for (const entry of list) union.set(entry.id, entry);
		}
		registerCustomKinds([...union.values()]);
	}
}
