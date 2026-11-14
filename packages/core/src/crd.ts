// CustomResourceDefinitions: turning a CRD into a served kind, and
// validating custom resources against the CRD's OpenAPI v3 schema the way
// the API server does (types, required fields, enums, ranges, unknown fields).

import type { KObject } from "./types.js";
import { KubeError } from "./types.js";
import type { KindInfo } from "./kinds.js";

type Schema = Record<string, any>;

export function crdToKind(crd: KObject): { info: KindInfo; keys: string[] } {
  const spec = crd.spec ?? {};
  const names = spec.names ?? {};
  const versions = (spec.versions ?? []) as Schema[];
  const storage = versions.find((v) => v.storage) ?? versions[0] ?? { name: "v1" };
  const info: KindInfo = {
    kind: names.kind,
    plural: names.plural,
    singular: names.singular ?? String(names.kind).toLowerCase(),
    shortNames: names.shortNames ?? [],
    apiVersion: `${spec.group}/${storage.name}`,
    namespaced: (spec.scope ?? "Namespaced") !== "Cluster",
    custom: {
      printerColumns: storage.additionalPrinterColumns ?? [],
      schema: storage.schema?.openAPIV3Schema,
      version: storage.name,
      versions: versions.filter((v) => v.served !== false).map((v) => v.name),
    },
  };
  const keys = [String(names.kind).toLowerCase(), names.plural, info.singular, ...(names.shortNames ?? []), `${names.plural}.${spec.group}`, `${String(names.kind).toLowerCase()}.${spec.group}`];
  return { info, keys };
}

export function validateCRD(crd: KObject, invalid: (detail: string) => KubeError): void {
  const spec = crd.spec ?? {};
  const name = crd.metadata.name;
  if (!spec.group) throw invalid("spec.group: Required value");
  if (!spec.names?.plural) throw invalid("spec.names.plural: Required value");
  if (!spec.names?.kind) throw invalid("spec.names.kind: Required value");
  if (!spec.scope) throw invalid('spec.scope: Required value, spec.scope: Unsupported value: "": supported values: "Cluster", "Namespaced"');
  if (!["Cluster", "Namespaced"].includes(spec.scope)) throw invalid(`spec.scope: Unsupported value: "${spec.scope}": supported values: "Cluster", "Namespaced"`);
  if (name !== `${spec.names.plural}.${spec.group}`) throw invalid(`metadata.name: Invalid value: "${name}": must be spec.names.plural+"."+spec.group`);
  const versions = (spec.versions ?? []) as Schema[];
  if (!versions.length) throw invalid("spec.versions: Invalid value: []apiextensions.CustomResourceDefinitionVersion(nil): must have exactly one version marked as storage version");
  if (versions.filter((v) => v.storage).length !== 1) throw invalid("spec.versions: Invalid value: ...: must have exactly one version marked as storage version");
  versions.forEach((v, i) => {
    if (!v.schema?.openAPIV3Schema) throw invalid(`spec.versions[${i}].schema.openAPIV3Schema: Required value: schemas are required`);
  });
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  return typeof v;
}

interface Problem {
  kind: "invalid" | "required" | "unknown";
  path: string;
  message: string;
}

function walk(v: unknown, s: Schema | undefined, path: string, out: Problem[]): void {
  if (!s || v === undefined) return;
  if (s["x-kubernetes-int-or-string"]) {
    if (typeof v !== "number" && typeof v !== "string") out.push({ kind: "invalid", path, message: `${path}: Invalid value: "${jsType(v)}": ${path} in body must be of type integer,string: "${jsType(v)}"` });
    return;
  }
  const t = s.type;
  const actual = jsType(v);
  if (t && !(t === actual || (t === "number" && actual === "integer"))) {
    out.push({ kind: "invalid", path, message: `${path}: Invalid value: "${actual}": ${path} in body must be of type ${t}: "${actual}"` });
    return;
  }
  if (s.enum && !s.enum.includes(v)) out.push({ kind: "invalid", path, message: `${path}: Unsupported value: ${JSON.stringify(v)}: supported values: ${s.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}` });
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push({ kind: "invalid", path, message: `${path}: Invalid value: ${v}: ${path} in body should be greater than or equal to ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) out.push({ kind: "invalid", path, message: `${path}: Invalid value: ${v}: ${path} in body should be less than or equal to ${s.maximum}` });
  }
  if (typeof v === "string") {
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push({ kind: "invalid", path, message: `${path}: Invalid value: "${v}": ${path} in body should match '${s.pattern}'` });
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push({ kind: "invalid", path, message: `${path}: Too long: may not be more than ${s.maxLength} bytes` });
    if (s.minLength !== undefined && v.length < s.minLength) out.push({ kind: "invalid", path, message: `${path}: Invalid value: "${v}": ${path} in body should be at least ${s.minLength} chars long` });
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`, out));
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push({ kind: "invalid", path, message: `${path}: Too many: ${v.length}: must have at most ${s.maxItems} items` });
    return;
  }
  if (actual === "object") {
    const obj = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (obj[r] === undefined) out.push({ kind: "required", path: path ? `${path}.${r}` : r, message: `${path ? `${path}.${r}` : r}: Required value` });
    const props = s.properties as Record<string, Schema> | undefined;
    for (const [k, child] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (props && props[k]) walk(child, props[k], p, out);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") walk(child, s.additionalProperties, p, out);
      else if (props && !s["x-kubernetes-preserve-unknown-fields"] && !s.additionalProperties) out.push({ kind: "unknown", path: p, message: `unknown field "${p}"` });
    }
  }
}

/** Validate a custom resource. Throws the API server's error for the first class of problem found. */
export function validateCustom(obj: KObject, info: KindInfo, source = "STDIN"): void {
  const schema = info.custom?.schema;
  if (!schema) return;
  const problems: Problem[] = [];
  const body: Record<string, unknown> = { ...obj };
  delete body.apiVersion;
  delete body.kind;
  delete body.metadata;
  const top: Schema = { ...schema, properties: { ...((schema.properties as Schema | undefined) ?? {}) } };
  delete top.properties.apiVersion;
  delete top.properties.kind;
  delete top.properties.metadata;
  walk(body, { ...top, required: ((schema.required as string[] | undefined) ?? []).filter((r: string) => !["apiVersion", "kind", "metadata"].includes(r)) }, "", problems);
  const unknown = problems.filter((p) => p.kind === "unknown");
  if (unknown.length) {
    const version = info.apiVersion.split("/")[1];
    throw new KubeError(`Error from server (BadRequest): error when creating "${source}": ${info.kind} in version "${version}" cannot be handled as a ${info.kind}: strict decoding error: ${unknown.map((u) => u.message).join(", ")}`);
  }
  const rest = problems.filter((p) => p.kind !== "unknown");
  if (rest.length) throw new KubeError(`The ${info.kind} "${obj.metadata.name}" is invalid: ${rest.length > 1 ? `[${rest.map((p) => p.message).join(", ")}]` : rest[0].message}`);
}
