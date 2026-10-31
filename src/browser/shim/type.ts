/**
 * 浏览器端的 JSON Schema 构造器（TypeBox 兼容子集）。
 *
 * 为什么不用 typebox：typebox@1.3.27 有 691 个 .mjs、865 KB，而且在 pnpm
 * 严格布局下无法从项目根解析。浏览器端实际只用到十来个 JSON Schema 关键字，
 * 所以这里自己实现一个等价的 Type.* 构造器。
 *
 * 关键约束：产物必须是**纯 JSON Schema**，不能带 TypeBox 的 Kind 符号。
 * pi-ai 的 validateToolArguments 用 `Symbol.for("TypeBox.Kind")` 判断走哪条
 * 校验分支：带 Kind 符号会走 TypeBox 原生路径（浏览器端没有 typebox），
 * 不带才会走它自带的 coerceWithJsonSchema + 我们这份 Compile。
 */

/** TypeBox 用全局 Symbol 标记"可选"，JSON 往返时会被自然丢弃。 */
const OPTIONAL: unique symbol = Symbol.for("TypeBox.Optional");

/** 编译期承载静态类型的幽灵字段，运行时不存在。 */
declare const StaticMarker: unique symbol;
declare const OptionalMarker: unique symbol;

/**
 * 一份 JSON Schema。
 *
 * `T` 是该 schema 对应的静态类型（`Static<T>` 取出来就是它），
 * `Optional` 标记这个 schema 是否出现在 `Type.Optional()` 里。
 */
export interface TSchema<T = unknown, Optional extends boolean = false> {
	readonly [StaticMarker]: T;
	readonly [OptionalMarker]: Optional;
	readonly type?: string | readonly string[];
	readonly properties?: Readonly<Record<string, TSchema<unknown, boolean>>>;
	readonly required?: readonly string[];
	readonly items?: TSchema<unknown, boolean> | readonly TSchema<unknown, boolean>[];
	readonly anyOf?: readonly TSchema<unknown, boolean>[];
	readonly oneOf?: readonly TSchema<unknown, boolean>[];
	readonly allOf?: readonly TSchema<unknown, boolean>[];
	readonly const?: unknown;
	readonly enum?: readonly unknown[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly description?: string;
	readonly title?: string;
	readonly default?: unknown;
	readonly [key: string]: unknown;
}

/** 取 schema 对应的 TS 静态类型。 */
export type Static<S> = S extends TSchema<infer T, boolean> ? T : unknown;

/** 对象里"可选属性"的键集合。 */
type OptionalPropKeys<P> = {
	[K in keyof P]: P[K] extends TSchema<unknown, true> ? K : never;
}[keyof P];

/** 对象里"必填属性"的键集合。 */
type RequiredPropKeys<P> = Exclude<keyof P, OptionalPropKeys<P>>;

/** `Type.Object` 的静态类型：必填键必填，可选键带 `?`。 */
export type ObjectProperties<P> = {
	[K in RequiredPropKeys<P>]: Static<P[K]>;
} & {
	[K in OptionalPropKeys<P>]?: Static<P[K]>;
};

/** 构造器可以携带的公共关键字。 */
export interface SchemaOptions {
	description?: string;
	title?: string;
	default?: unknown;
	examples?: readonly unknown[];
	readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalSchema(schema: unknown): boolean {
	return isRecord(schema) && (schema as Record<symbol, unknown>)[OPTIONAL] === true;
}

function literalType(value: string | number | boolean | null): string {
	if (value === null) return "null";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	return "boolean";
}

function withOptions(base: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> {
	if (!options) return base;
	return { ...base, ...options };
}

/**
 * 与 TypeBox 同名的构造器集合。
 *
 * 运行时产物是纯 JSON（`JSON.parse(JSON.stringify(schema))` 之后完全等价），
 * 这正是 pi-ai 的 `toToolDeclaration` 需要的形态。
 */
export const Type = {
	String(options?: SchemaOptions): TSchema<string> {
		return withOptions({ type: "string" }, options) as unknown as TSchema<string>;
	},

	Number(options?: SchemaOptions): TSchema<number> {
		return withOptions({ type: "number" }, options) as unknown as TSchema<number>;
	},

	Integer(options?: SchemaOptions): TSchema<number> {
		return withOptions({ type: "integer" }, options) as unknown as TSchema<number>;
	},

	Boolean(options?: SchemaOptions): TSchema<boolean> {
		return withOptions({ type: "boolean" }, options) as unknown as TSchema<boolean>;
	},

	Literal<const T extends string | number | boolean | null>(value: T): TSchema<T> {
		return {
			const: value,
			type: literalType(value),
		} as unknown as TSchema<T>;
	},

	Array<T extends TSchema<any, any>>(item: T, options?: SchemaOptions): TSchema<Static<T>[]> {
		return withOptions({ type: "array", items: item }, options) as unknown as TSchema<Static<T>[]>;
	},

	Union<T extends readonly TSchema<any, any>[]>(members: T, options?: SchemaOptions): TSchema<Static<T[number]>> {
		return withOptions({ anyOf: [...members] }, options) as unknown as TSchema<Static<T[number]>>;
	},

	Optional<S extends TSchema<any, any>>(schema: S): TSchema<Static<S> | undefined, true> {
		const next: Record<string | symbol, unknown> = {
			...(schema as unknown as Record<string | symbol, unknown>),
			[OPTIONAL]: true,
		};
		return next as unknown as TSchema<Static<S> | undefined, true>;
	},

	Object<P extends Record<string, TSchema<any, any>>>(
		properties: P,
		options?: SchemaOptions,
	): TSchema<ObjectProperties<P>> {
		const required: string[] = [];
		for (const key of Object.keys(properties)) {
			if (!isOptionalSchema(properties[key])) required.push(key);
		}
		const base: Record<string, unknown> = {
			type: "object",
			properties: { ...properties },
			required,
		};
		return withOptions(base, options) as unknown as TSchema<ObjectProperties<P>>;
	},
};

export default Type;
