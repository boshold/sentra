import { typedAttributeSchema } from "#src/normalize/schemas.js";

export function flattenAttributes(input: unknown): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return result;
  }
  for (const [key, raw] of Object.entries(input)) {
    const parsed = typedAttributeSchema.safeParse(raw);
    if (parsed.success && parsed.data.value !== undefined) {
      result[key] = parsed.data.value;
    }
  }
  return result;
}
