/**
 * 浏览器端的 JSON Schema 校验器（TypeBox `Compile` / `Value` 的等价实现）。
 *
 * pi-ai 的 `validateToolArguments` 直接 `import { Compile } from "typebox/compile"`
 * 和 `import { Value } from "typebox/value"`，浏览器端通过 import map 把这两个
 * 裸说明符指向本文件（构建产物 vendor/typebox/compile.js 与 vendor/typebox/value.js）。
 *
 * 只支持我们自己真正用到的 JSON Schema 关键字子集；其余关键字（description、
 * title 等注解）一律忽略。
 */

/** 一条校验错误，形状对齐 TypeBox 的 ValueError。 */
export interface ValidationError {
	/** 失败的关键字：type / required / const / enum / minimum / ... */
	keyword: string;
	/** JSON Pointer 风格路径，例如 "/chapterId"；根路径是空字符串。 */
	instancePath: string;
	/** 人类可读的错误描述。 */
	message: string;
	/** 关键字相关参数；required 错误里带 requiredProperties。 */
	params?: Record<string, unknown>;
}

/** 编译后的校验器。 */
export interface Validator<T = unknown> {
	Check(value: unknown): value is T;
	Errors(value: unknown): ValidationError[];
}

/** 内部使用的 JSON Schema 视图。 */
interface JsonSchema {
	readonly [key: string]: unknown;
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema | JsonSchema[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	allOf?: JsonSchema[];
	const?: unknown;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
}

function isSchema(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== typeof right) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	if (isSchema(left) && isSchema(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		return leftKeys.every((key) => deepEqual(left[key], right[key]));
	}
	return false;
}

function join(path: string, key: string | number): string {
	return `${path}/${key}`;
}

/** 校验单个 schema，把错误追加进 errors。 */
function validate(schema: unknown, value: unknown, path: string, errors: ValidationError[]): void {
	if (!isSchema(schema)) return;

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((type) => matchesType(type, value))) {
			errors.push({
				keyword: "type",
				instancePath: path,
				message: `Expected ${types.join(" or ")}`,
				params: { type: schema.type },
			});
			return;
		}
	}

	if (schema.const !== undefined && !deepEqual(value, schema.const)) {
		errors.push({
			keyword: "const",
			instancePath: path,
			message: `Expected ${JSON.stringify(schema.const)}`,
			params: { expectedValue: schema.const },
		});
	}

	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
		errors.push({
			keyword: "enum",
			instancePath: path,
			message: `Expected one of ${JSON.stringify(schema.enum)}`,
			params: { allowedValues: schema.enum },
		});
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push({
				keyword: "minimum",
				instancePath: path,
				message: `Expected value greater than or equal to ${schema.minimum}`,
				params: { minimum: schema.minimum },
			});
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push({
				keyword: "maximum",
				instancePath: path,
				message: `Expected value less than or equal to ${schema.maximum}`,
				params: { maximum: schema.maximum },
			});
		}
	}

	if (typeof value === "string") {
		const length = [...value].length;
		if (typeof schema.minLength === "number" && length < schema.minLength) {
			errors.push({
				keyword: "minLength",
				instancePath: path,
				message: `Expected length greater than or equal to ${schema.minLength}`,
				params: { minLength: schema.minLength },
			});
		}
		if (typeof schema.maxLength === "number" && length > schema.maxLength) {
			errors.push({
				keyword: "maxLength",
				instancePath: path,
				message: `Expected length less than or equal to ${schema.maxLength}`,
				params: { maxLength: schema.maxLength },
			});
		}
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push({
				keyword: "minItems",
				instancePath: path,
				message: `Expected array length greater than or equal to ${schema.minItems}`,
				params: { minItems: schema.minItems },
			});
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			errors.push({
				keyword: "maxItems",
				instancePath: path,
				message: `Expected array length less than or equal to ${schema.maxItems}`,
				params: { maxItems: schema.maxItems },
			});
		}
		if (Array.isArray(schema.items)) {
			schema.items.forEach((itemSchema, index) => {
				const item = value[index];
				if (item === undefined) return;
				validate(itemSchema, item, join(path, index), errors);
			});
		} else if (schema.items !== undefined) {
			value.forEach((item, index) => {
				validate(schema.items, item, join(path, index), errors);
			});
		}
	}

	if (isSchema(value) && !Array.isArray(value)) {
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const key of required) {
			if (!(key in value)) {
				errors.push({
					keyword: "required",
					instancePath: path,
					message: `Missing required property '${key}'`,
					params: { requiredProperties: [key] },
				});
			}
		}
		if (schema.properties) {
			for (const [key, propertySchema] of Object.entries(schema.properties)) {
				if (!(key in value)) continue;
				validate(propertySchema, value[key], join(path, key), errors);
			}
		}
	}

	if (Array.isArray(schema.allOf)) {
		for (const member of schema.allOf) {
			validate(member, value, path, errors);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		const matched = schema.anyOf.some((member) => validateInto(member, value, path).length === 0);
		if (!matched) {
			errors.push({
				keyword: "anyOf",
				instancePath: path,
				message: "Expected value to match at least one of the anyOf schemas",
				params: { schemaCount: schema.anyOf.length },
			});
		}
	}

	if (Array.isArray(schema.oneOf)) {
		const matched = schema.oneOf.filter((member) => validateInto(member, value, path).length === 0).length;
		if (matched !== 1) {
			errors.push({
				keyword: "oneOf",
				instancePath: path,
				message: "Expected value to match exactly one of the oneOf schemas",
				params: { matched, schemaCount: schema.oneOf.length },
			});
		}
	}
}

/** 校验并返回错误列表（不污染外部数组）。 */
function validateInto(schema: unknown, value: unknown, path: string): ValidationError[] {
	const errors: ValidationError[] = [];
	validate(schema, value, path, errors);
	return errors;
}

/**
 * 编译一份 JSON Schema，返回校验器。
 *
 * 对齐 typebox 的 `Compile`：Check 给出布尔结果，Errors 给出错误明细。
 */
export function Compile<T = unknown>(schema: unknown): Validator<T> {
	return {
		Check(value: unknown): value is T {
			return validateInto(schema, value, "").length === 0;
		},
		Errors(value: unknown): ValidationError[] {
			return validateInto(schema, value, "");
		},
	};
}

/**
 * typebox 的 `Value` 门面。
 *
 * `Convert` 在我们这里是一个空操作：pi-ai 的 validateToolArguments 并不使用
 * 它的返回值，真正的类型收敛由它自己的 coerceWithJsonSchema 完成。
 */
export const Value = {
	Check(value: unknown, schema: unknown): boolean {
		return validateInto(schema, value, "").length === 0;
	},

	Errors(value: unknown, schema: unknown): ValidationError[] {
		return validateInto(schema, value, "");
	},

	Convert(schema: unknown, value: unknown): unknown {
		void schema;
		return value;
	},
};
