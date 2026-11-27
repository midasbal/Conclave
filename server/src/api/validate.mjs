// A small validator for the subset of JSON Schema that schema.mjs uses, so the server checks request bodies against the SAME definitions the contract is made of, with no dependency. The tests check it against ajv
// (a complete validator) on every response and many bad inputs, and require the two to agree.
import { defs } from "./schema.mjs";
const typeOk = (t, v) => t === "string" ? typeof v === "string" : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "boolean" ? typeof v === "boolean" : t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : false;
/** returns the first violation as `path: what`, or null if the value conforms */
export function check(schema, v, at = "$") {
  if (schema.$ref) { const n = schema.$ref.replace("#/$defs/", ""); if (!defs[n]) throw new Error("unknown definition " + n); return check(defs[n], v, at); }
  if (schema.anyOf) { const errs = []; for (const s of schema.anyOf) { const e = check(s, v, at); if (!e) return null; errs.push(e); } return `${at}: matches none of the allowed shapes (${errs.join("; ")})`; }
  if (schema.const !== undefined && v !== schema.const) return `${at}: must be ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at}: must be one of ${schema.enum.join(", ")}`;
  if (schema.type && !typeOk(schema.type, v)) return `${at}: must be ${schema.type}`;
  if (typeof v === "string") { if (schema.minLength !== undefined && v.length < schema.minLength) return `${at}: too short`; if (schema.maxLength !== undefined && v.length > schema.maxLength) return `${at}: too long`; if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${at}: not in the expected form`; }
  if (typeof v === "number") { if (schema.minimum !== undefined && v < schema.minimum) return `${at}: below ${schema.minimum}`; if (schema.maximum !== undefined && v > schema.maximum) return `${at}: above ${schema.maximum}`; }
  if (Array.isArray(v) && schema.items) for (const [i, x] of v.entries()) { const e = check(schema.items, x, `${at}[${i}]`); if (e) return e; }
  if (schema.type === "object" && typeOk("object", v)) {
    for (const k of schema.required ?? []) if (!(k in v)) return `${at}: ${k} is required`;
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties ?? {}))) return `${at}: ${k} is not a field of this object`;
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) { const e = check(s, v[k], `${at}.${k}`); if (e) return e; }
  }
  return null;
}
export const validateAgainst = (defName, v) => check({ $ref: `#/$defs/${defName}` }, v);
