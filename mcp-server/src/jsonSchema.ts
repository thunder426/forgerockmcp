import { z, ZodTypeAny } from "zod";

/**
 * Minimal Zod -> JSON Schema converter. We only need the subset the MCP
 * spec actually consumes: object, string, number, boolean, optional, default,
 * descriptions. A full converter (e.g. zod-to-json-schema) would be overkill
 * and pulls in a lot of dependency surface.
 */
export function zodToJsonSchema(schema: ZodTypeAny): object {
  return walk(schema);
}

function walk(schema: ZodTypeAny): any {
  const def = (schema as any)._def;
  const description = def.description as string | undefined;

  // Unwrap optionals — JSON Schema represents optional fields via `required`, not the schema itself.
  if (def.typeName === "ZodOptional") {
    const inner = walk(def.innerType);
    return description ? { ...inner, description } : inner;
  }
  if (def.typeName === "ZodDefault") {
    const inner = walk(def.innerType);
    return description ? { ...inner, description, default: def.defaultValue() } : { ...inner, default: def.defaultValue() };
  }

  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as ZodTypeAny;
        properties[key] = walk(v);
        if (!isOptional(v)) required.push(key);
      }
      const out: any = { type: "object", properties };
      if (required.length > 0) out.required = required;
      if (description) out.description = description;
      return out;
    }
    case "ZodString":
      return description ? { type: "string", description } : { type: "string" };
    case "ZodNumber":
      return description ? { type: "number", description } : { type: "number" };
    case "ZodBoolean":
      return description ? { type: "boolean", description } : { type: "boolean" };
    case "ZodArray":
      return {
        type: "array",
        items: walk(def.type),
        ...(description ? { description } : {}),
      };
    case "ZodEnum":
      return {
        type: "string",
        enum: def.values,
        ...(description ? { description } : {}),
      };
    case "ZodLiteral":
      return { const: def.value, ...(description ? { description } : {}) };
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: walk(def.valueType),
        ...(description ? { description } : {}),
      };
    case "ZodAny":
    case "ZodUnknown":
      return description ? { description } : {};
    default:
      // Fallback to permissive object so tool calls don't crash.
      return description ? { description } : {};
  }
}

function isOptional(s: ZodTypeAny): boolean {
  const tn = (s as any)._def.typeName;
  return tn === "ZodOptional" || tn === "ZodDefault";
}
