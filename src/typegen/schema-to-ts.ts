/**
 * Deterministic JSON Schema → TypeScript type conversion for Orch8 step
 * contracts. Supports the draft 2020-12 / draft-07 subset used for sequence
 * `input_schema` and step `output_schema`: type (incl. arrays of types),
 * enum, const, properties/required, additionalProperties, patternProperties,
 * items/prefixItems, anyOf/oneOf, allOf, nullable, and local `$ref`s into
 * `$defs`/`definitions`. Anything else degrades to `unknown`, never `any`.
 * Object keys are emitted sorted, so key order in the source never matters.
 */

export type JsonSchema = boolean | { [key: string]: unknown };

const MAX_DEPTH = 32;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOCAL_REF = /^#\/(\$defs|definitions)\/(.+)$/;

export function pascalCase(input: string): string {
  const words = input.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!joined) return "Unnamed";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

export function propertyKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "unknown";
}

export function jsdoc(schema: Record<string, unknown>, indent: string): string {
  const parts: string[] = [];
  if (typeof schema.title === "string") parts.push(schema.title);
  if (typeof schema.description === "string") parts.push(schema.description);
  if (schema.deprecated === true) parts.push("@deprecated");
  if (parts.length === 0) return "";
  const lines = parts.join("\n\n").replace(/\*\//g, "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
}

function unionOf(members: string[]): string {
  const unique = [...new Set(members)];
  if (unique.includes("unknown")) return "unknown";
  if (unique.length === 0) return "never";
  return unique.length === 1 ? unique[0] : unique.join(" | ");
}

/** Parenthesize compound types before using them as array/intersection operands. */
function operand(t: string): string {
  if (t.startsWith("{") || t.startsWith("[")) return t;
  return /[|&]/.test(t) ? `(${t})` : t;
}

/** Converts one root schema, collecting `$defs` aliases it references. */
export class SchemaConverter {
  /** Named aliases produced for `$ref` targets, in first-use order. */
  readonly definitions = new Map<string, string>();
  private readonly refNames = new Map<string, string>();

  constructor(
    private readonly root: JsonSchema,
    private readonly namePrefix: string,
    private readonly takenNames: Set<string>,
  ) {}

  convert(schema: JsonSchema | undefined = this.root, indent = "", depth = 0): string {
    if (depth > MAX_DEPTH) return "unknown";
    if (schema === true || schema === undefined) return "unknown";
    if (schema === false) return "never";
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "unknown";
    const s = schema as Record<string, unknown>;

    if (typeof s.$ref === "string") return this.ref(s.$ref, depth);

    let result: string;
    if ("const" in s) result = literal(s.const);
    else if (Array.isArray(s.enum)) result = unionOf(s.enum.map(literal));
    else result = this.byType(s, indent, depth);

    const intersect: string[] = result === "unknown" ? [] : [result];
    for (const key of ["anyOf", "oneOf"] as const) {
      const list = s[key];
      if (Array.isArray(list) && list.length > 0) {
        const u = unionOf(list.map((sub) => this.convert(sub as JsonSchema, indent, depth + 1)));
        if (u !== "unknown") intersect.push(u);
      }
    }
    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) {
        const t = this.convert(sub as JsonSchema, indent, depth + 1);
        if (t !== "unknown") intersect.push(t);
      }
    }
    if (intersect.length === 0) result = "unknown";
    else if (intersect.length === 1) result = intersect[0];
    else result = intersect.map(operand).join(" & ");

    if (s.nullable === true && result !== "unknown" && !/(^|\| )null( \||$)/.test(result)) {
      result = `${result} | null`;
    }
    return result;
  }

  private byType(s: Record<string, unknown>, indent: string, depth: number): string {
    const declared = s.type;
    const types = Array.isArray(declared)
      ? declared.filter((t): t is string => typeof t === "string")
      : typeof declared === "string"
        ? [declared]
        : inferTypes(s);
    if (types.length === 0) return "unknown";
    return unionOf(types.map((t) => this.single(t, s, indent, depth)));
  }

  private single(type: string, s: Record<string, unknown>, indent: string, depth: number): string {
    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return this.array(s, indent, depth);
      case "object":
        return this.object(s, indent, depth);
      default:
        return "unknown";
    }
  }

  private array(s: Record<string, unknown>, indent: string, depth: number): string {
    const tupleSource = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : undefined;
    if (tupleSource) {
      const tuple = tupleSource.map((sub) => this.convert(sub as JsonSchema, indent, depth + 1));
      const restSchema = Array.isArray(s.prefixItems) ? s.items : s.additionalItems;
      const rest = restSchema === false
        ? ""
        : `, ...${operand(this.convert(restSchema as JsonSchema | undefined, indent, depth + 1))}[]`;
      return `[${tuple.join(", ")}${rest}]`;
    }
    const item = this.convert(s.items as JsonSchema | undefined, indent, depth + 1);
    return `${operand(item)}[]`;
  }

  private object(s: Record<string, unknown>, indent: string, depth: number): string {
    const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, JsonSchema>;
    const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : []);
    const inner = `${indent}  `;
    const lines: string[] = [];
    for (const key of Object.keys(props).sort()) {
      const sub = props[key];
      const doc = sub && typeof sub === "object" ? jsdoc(sub as Record<string, unknown>, inner) : "";
      const optional = required.has(key) ? "" : "?";
      lines.push(`${doc}${inner}${propertyKey(key)}${optional}: ${this.convert(sub, inner, depth + 1)};`);
    }
    for (const key of [...required].filter((k) => !(k in props)).sort()) {
      lines.push(`${inner}${propertyKey(key)}: unknown;`);
    }
    const extra: string[] = [];
    if (s.patternProperties && typeof s.patternProperties === "object") {
      const pattern = s.patternProperties as Record<string, JsonSchema>;
      for (const key of Object.keys(pattern).sort()) extra.push(this.convert(pattern[key], inner, depth + 1));
    }
    const additional = s.additionalProperties;
    if (additional === undefined || additional === true) {
      extra.push("unknown");
    } else if (additional !== false) {
      extra.push(this.convert(additional as JsonSchema, inner, depth + 1));
    }
    if (lines.length === 0) {
      return extra.length > 0 ? `Record<string, ${unionOf(extra)}>` : "Record<string, never>";
    }
    // An index signature must admit every declared property, so open objects
    // keep a permissive `unknown` signature.
    if (extra.length > 0) lines.push(`${inner}[key: string]: unknown;`);
    return `{\n${lines.join("\n")}\n${indent}}`;
  }

  private ref(ref: string, depth: number): string {
    const existing = this.refNames.get(ref);
    if (existing) return existing;
    const match = ref.match(LOCAL_REF);
    if (!match || typeof this.root !== "object") return "unknown";
    const defs = this.root[match[1]] as Record<string, JsonSchema> | undefined;
    const key = decodeURIComponent(match[2].replace(/~1/g, "/").replace(/~0/g, "~"));
    const target = defs?.[key];
    if (target === undefined) return "unknown";
    const base = `${this.namePrefix}${pascalCase(key)}`;
    let name = base;
    for (let i = 2; this.takenNames.has(name); i += 1) name = `${base}${i}`;
    this.takenNames.add(name);
    this.refNames.set(ref, name); // registered first so recursive refs terminate
    this.definitions.set(name, "unknown");
    this.definitions.set(name, this.convert(target, "", depth + 1));
    return name;
  }
}

function inferTypes(s: Record<string, unknown>): string[] {
  if (s.properties || s.additionalProperties !== undefined || s.required || s.patternProperties) return ["object"];
  if (s.items !== undefined || s.prefixItems !== undefined) return ["array"];
  return [];
}
