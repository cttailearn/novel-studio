/**
 * Turning a domain tool description into a DSH `ToolDefinition`.
 *
 * Kept apart from `tools.js` so the adaptation tools can register the same way
 * without importing the whole writing tool set.
 *
 * Two facts about the host shape everything here:
 *
 *  - `parameters` is the **property-map** form: each property is a value schema,
 *    and requiredness is `required: true` on the property itself. The host wraps
 *    the map into `{ type: 'object', properties, required }`.
 *  - `output.render(args, value)` is what the model finally reads. The value
 *    `execute` returns is unconstrained JSON, so one annotation-only schema
 *    covers every tool here.
 */

/**
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters?: Record<string, unknown>,
 *   card?: string,
 *   kind?: 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other',
 *   run: (args: Record<string, unknown>) => Promise<{ text: string, details?: unknown }>,
 * }} spec
 */
export function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? {},
    output: {
      // Annotation-only schema: the value is unconstrained JSON, which is what
      // every one of these tools returns.
      schema: { description: '工具结果' },
      render(_args, value) {
        const text = value && typeof value === 'object' && typeof value.text === 'string' ? value.text : '';
        return [{ type: 'text', text }];
      },
    },
    async execute(args) {
      const value = await spec.run(args ?? {});
      return { text: value.text, details: value.details ?? null };
    },
    presentCall(args) {
      return { card: 'generic', title: spec.card ?? spec.name, kind: spec.kind ?? 'other', rawInput: args };
    },
  };
}

export const text = (description) => ({ type: 'string', description });
export const requiredText = (description) => ({ type: 'string', description, required: true });
export const optionalNumber = (description) => ({ type: 'number', description });
export const optionalBool = (description) => ({ type: 'boolean', description });
export const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });
export const choice = (values, description) => ({ type: 'string', enum: values, description });

/** Clamp a numeric argument into range, falling back when it is not a number. */
export function clamp(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
