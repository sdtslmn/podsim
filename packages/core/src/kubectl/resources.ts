// get, describe, apply, create -f, replace, delete, patch, label, annotate.

import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { KINDS, kindInfo, resolveKind, type KindInfo } from "../kinds.js";
import { deepClone, stableStringify } from "../util.js";
import { validateFields } from "../schema.js";
import { parse as parseYaml } from "yaml";
import type { Flags } from "./flags.js";
import {
  type Ctx,
  out,
  err,
  nsOf,
  parseTargets,
  selectorFilter,
  fieldSelectorFilter,
  notFoundError,
  ref,
  quotedRef,
  dryRun,
  kindOrThrow,
} from "./common.js";
import { authorize } from "./common.js";
import { printTable, renderStructured, toYaml } from "./printers.js";
import { describe } from "./describe.js";
import { evalPath } from "./jsonpath.js";
import { loadFiles } from "./manifest.js";
import { kustomize } from "./kustomize.js";

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

// ------------------------------------------------------------------ get

export async function cmdGet(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  let targets: { info: KindInfo; names: string[]; nsOf?: Record<string, string> }[] = parseTargets(f.args);
  const files = f.all("filename");
  if (files.length || f.all("kustomize").length) {
    const loaded = loadInputs(ctx, f);
    targets = [];
    for (const l of loaded) {
      const info = kindOrThrow(l.obj.kind);
      let t = targets.find((x) => x.info.kind === info.kind);
      if (!t) targets.push((t = { info, names: [], nsOf: {} }));
      t.names.push(l.obj.metadata?.name);
      if (l.obj.metadata?.namespace && !f.str("namespace")) t.nsOf![l.obj.metadata.name] = l.obj.metadata.namespace;
    }
  }
  if (targets.length === 0) {
    throw new KubeError(
      'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples',
    );
  }
  const allNs = f.bool("all-namespaces");
  const ns = nsOf(ctx, f);
  const output = f.str("output") ?? "";
  const sel = selectorFilter(f);
  const fsel = fieldSelectorFilter(f);
  const sortBy = f.str("sort-by");
  const errors: string[] = [];
  const groups: { info: KindInfo; objects: KObject[] }[] = [];
  let namedRequest = false;

  for (const t of targets) {
    let objs: KObject[];
    if (t.names.length) {
      namedRequest = true;
      objs = [];
      for (const n of t.names) {
        const o = cluster.get(t.info.kind, n, t.info.namespaced ? t.nsOf?.[n] ?? ns : undefined);
        if (o) objs.push(o);
        else errors.push(notFoundError(t.info, n).message);
      }
    } else {
      objs = cluster.list(t.info.kind, t.info.namespaced ? (allNs ? undefined : ns) : undefined);
      if (t.info.kind === "Event") objs.sort((a, b) => cluster.compareEvents(a, b));
    }
    if (sel) objs = objs.filter(sel);
    if (fsel) objs = objs.filter(fsel);
    if (sortBy) {
      const path = sortBy.replace(/^\{|\}$/g, "");
      const key = (o: KObject) => evalPath(o, path.startsWith(".") ? path : "." + path)[0];
      objs = [...objs].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        if (typeof x === "number" && typeof y === "number") return x - y;
        return String(x ?? "").localeCompare(String(y ?? ""));
      });
    }
    groups.push({ info: t.info, objects: objs });
  }

  const all = groups.flatMap((g) => g.objects);
  if (output && output !== "wide") {
    const single = namedRequest && targets.length === 1 && targets[0].names.length === 1;
    if (all.length > 0 || !single) {
      const text = renderStructured(all, output, single, f.bool("no-headers"));
      if (text !== undefined && (all.length > 0 || output === "yaml" || output === "json")) {
        // Like the real kubectl, jsonpath output has no trailing newline.
        if (output.startsWith("jsonpath")) ctx.io.stdout(text);
        else out(ctx, text);
      }
    }
  } else {
    const multi = groups.length > 1 || (f.args[0] ?? "").split(",").includes("all");
    const nonEmpty = groups.filter((g) => g.objects.length > 0);
    const chunks = nonEmpty.map((g) =>
      printTable(cluster, g.info.kind, g.objects, {
        wide: output === "wide",
        showNamespace: allNs && g.info.namespaced,
        showLabels: f.bool("show-labels"),
        noHeaders: f.bool("no-headers"),
        withKindPrefix: multi,
      }),
    );
    if (chunks.length) out(ctx, chunks.join("\n\n"));
  }

  for (const e of errors) err(ctx, e);
  if (all.length === 0 && errors.length === 0) {
    const clusterScoped = groups.every((g) => !g.info.namespaced);
    err(ctx, allNs || clusterScoped ? "No resources found" : `No resources found in ${ns} namespace.`);
  }
  if (f.bool("watch")) err(ctx, "(podsim) --watch is not simulated yet. Run the command again to see the latest state.");
  return errors.length ? 1 : 0;
}

// ------------------------------------------------------------------ describe

export async function cmdDescribe(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const targets = parseTargets(f.args);
  if (targets.length === 0) {
    throw new KubeError('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
  }
  const ns = nsOf(ctx, f);
  const allNs = f.bool("all-namespaces");
  const sel = selectorFilter(f);
  const docs: string[] = [];
  let code = 0;
  for (const t of targets) {
    const scope = t.info.namespaced ? (allNs ? undefined : ns) : undefined;
    let objs: KObject[] = [];
    if (t.names.length) {
      for (const n of t.names) {
        const exact = cluster.get(t.info.kind, n, t.info.namespaced ? ns : undefined);
        if (exact) objs.push(exact);
        else {
          // kubectl describe falls back to a prefix match.
          const prefixed = cluster.list(t.info.kind, scope).filter((o) => o.metadata.name.startsWith(n));
          if (prefixed.length) objs.push(...prefixed);
          else {
            err(ctx, notFoundError(t.info, n).message);
            code = 1;
          }
        }
      }
    } else {
      objs = cluster.list(t.info.kind, scope);
    }
    if (sel) objs = objs.filter(sel);
    for (const o of objs) docs.push(describe(cluster, o));
  }
  if (docs.length) out(ctx, docs.join("\n\n\n"));
  else if (code === 0) err(ctx, `No resources found in ${ns} namespace.`);
  return code;
}

// ------------------------------------------------------------------ apply / create -f / replace

function threeWayMerge(live: unknown, last: unknown, desired: unknown): unknown {
  const isObj = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (isObj(desired) && isObj(live)) {
    const result: Record<string, unknown> = { ...(live as Record<string, unknown>) };
    for (const [k, v] of Object.entries(desired as Record<string, unknown>)) {
      result[k] = threeWayMerge((live as Record<string, unknown>)[k], isObj(last) ? (last as Record<string, unknown>)[k] : undefined, v);
    }
    if (isObj(last)) {
      for (const k of Object.keys(last as object)) if (!(k in (desired as object))) delete result[k];
    }
    return result;
  }
  return deepClone(desired);
}

function comparable(o: KObject): string {
  const c = deepClone(o);
  delete c.metadata.resourceVersion;
  delete c.metadata.generation;
  delete c.status;
  if (c.metadata.annotations) {
    delete c.metadata.annotations[LAST_APPLIED];
    delete c.metadata.annotations["deployment.kubernetes.io/revision"];
    if (Object.keys(c.metadata.annotations).length === 0) delete c.metadata.annotations;
  }
  return stableStringify(c);
}

function prepareNamespace(ctx: Ctx, f: Flags, obj: KObject, info: KindInfo): void {
  obj.metadata = obj.metadata ?? ({} as KObject["metadata"]);
  if (!info.namespaced) return;
  const flagNs = f.str("namespace");
  if (obj.metadata.namespace && flagNs && obj.metadata.namespace !== flagNs) {
    throw new KubeError(
      `error: the namespace from the provided object "${obj.metadata.namespace}" does not match the namespace "${flagNs}". You must pass '--namespace=${obj.metadata.namespace}' to perform this operation.`,
    );
  }
  obj.metadata.namespace = obj.metadata.namespace ?? flagNs ?? ctx.state.namespace;
}

/** The kind of an object read from a file, with kubectl's error for unknown kinds. */
export function kindFromFile(raw: KObject, source: string): KindInfo {
  if (!raw?.kind || !resolveKind(raw.kind)) {
    throw new KubeError(`error: resource mapping not found for name: "${raw?.metadata?.name ?? ""}" namespace: "${raw?.metadata?.namespace ?? ""}" from "${source}": no matches for kind "${raw?.kind ?? ""}" in version "${raw?.apiVersion ?? ""}"\nensure CRDs are installed first`);
  }
  return kindOrThrow(raw.kind);
}

const ALT_VERSIONS: Record<string, string[]> = { HorizontalPodAutoscaler: ["autoscaling/v1", "autoscaling/v2"] };

/** kubectl looks up kind and apiVersion before sending anything: removed or wrong versions fail here. */
export function checkApiVersion(obj: KObject, info: KindInfo, source: string): void {
  const v = obj.apiVersion;
  if (!v) return;
  const ok = info.custom
    ? info.custom.versions.some((x) => `${info.apiVersion.split("/")[0]}/${x}` === v)
    : v === info.apiVersion || (ALT_VERSIONS[info.kind] ?? []).includes(v);
  if (!ok) {
    throw new KubeError(`error: resource mapping not found for name: "${obj.metadata?.name ?? ""}" namespace: "${obj.metadata?.namespace ?? ""}" from "${source}": no matches for kind "${obj.kind}" in version "${v}"\nensure CRDs are installed first`);
  }
}

/** Server errors for objects from files name the file, like kubectl does. */
function withSource<T>(fn: () => T, source: string, verb: "creating" | "applying"): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KubeError && e.message.startsWith("Error from server (Forbidden): ") && !e.message.includes("error when")) {
      throw new KubeError(e.message.replace("Error from server (Forbidden): ", `Error from server (Forbidden): error when ${verb} "${source}": `));
    }
    throw e;
  }
}

/** Objects named by -f or -k. */
export function loadInputs(ctx: Ctx, f: Flags): { obj: KObject; source: string }[] {
  const dirs = f.all("kustomize");
  if (dirs.length) return dirs.flatMap((d) => kustomize(ctx.fs, d).map((obj) => ({ obj, source: d })));
  const files = f.all("filename");
  if (files.length === 0) throw new KubeError("error: must specify one of -f and -k");
  return loadFiles(ctx.fs, files, ctx.io.stdin, f.bool("recursive"));
}

export async function cmdApply(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const loaded = loadInputs(ctx, f);
  const isDry = dryRun(f);
  const output = f.str("output");
  let code = 0;
  const printed: KObject[] = [];
  for (const { obj: raw, source } of loaded) {
    try {
      const info = kindFromFile(raw, source);
      const obj = deepClone(raw);
      checkApiVersion(raw, info, source);
      prepareNamespace(ctx, f, obj, info);
      if (!obj.metadata.name) throw new KubeError(`error: error when retrieving current configuration of:\nResource: "${info.plural}", GroupVersionKind: "${info.apiVersion}, Kind=${info.kind}"\nName: "", Namespace: "${obj.metadata.namespace ?? ""}"\nfrom server for: "${source}": resource name may not be empty`);
      const existing = cluster.get(info.kind, obj.metadata.name, obj.metadata.namespace);
      authorize(ctx, existing ? "patch" : "create", info, obj.metadata.namespace, existing ? obj.metadata.name : undefined);
      validateFields(obj as unknown as Record<string, unknown>, existing ? "applying" : "creating", source);
      const lastApplied = JSON.stringify(raw);
      obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), [LAST_APPLIED]: lastApplied };
      if (!existing) {
        const created = withSource(() => cluster.create(obj, { dryRun: isDry }), source, "creating");
        for (const w of cluster.takeWarnings()) err(ctx, `Warning: ${w}`);
        printed.push(created);
        if (!output) out(ctx, `${ref(info, created.metadata.name)} created${isDry ? " (dry run)" : ""}`);
      } else {
        let last: unknown;
        try {
          last = JSON.parse(existing.metadata.annotations?.[LAST_APPLIED] ?? "null");
        } catch {
          last = null;
        }
        const live = deepClone(existing);
        delete live.status;
        const merged = threeWayMerge(live, last, obj) as KObject;
        merged.metadata.annotations = { ...(merged.metadata.annotations ?? {}), [LAST_APPLIED]: lastApplied };
        const before = comparable(existing);
        if (isDry) {
          printed.push(merged);
          if (!output) out(ctx, `${ref(info, existing.metadata.name)} configured (dry run)`);
          continue;
        }
        const updated = cluster.replace(merged);
        printed.push(updated);
        const same = before === comparable(updated);
        if (!output) out(ctx, `${ref(info, updated.metadata.name)} ${same ? "unchanged" : "configured"}`);
      }
    } catch (e) {
      if (e instanceof KubeError) {
        err(ctx, e.message);
        code = 1;
      } else throw e;
    }
  }
  if (output && printed.length) {
    const text = renderStructured(printed, output, printed.length === 1);
    if (text) out(ctx, text);
  }
  cluster.advance();
  return code;
}

export async function createFromFiles(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const loaded = loadInputs(ctx, f);
  const isDry = dryRun(f);
  const output = f.str("output");
  let code = 0;
  const printed: KObject[] = [];
  for (const { obj: raw, source } of loaded) {
    try {
      const info = kindFromFile(raw, source);
      const obj = deepClone(raw);
      checkApiVersion(raw, info, source);
      prepareNamespace(ctx, f, obj, info);
      authorize(ctx, "create", info, obj.metadata.namespace);
      validateFields(obj as unknown as Record<string, unknown>, "creating", source);
      if (obj.metadata.name && cluster.get(info.kind, obj.metadata.name, obj.metadata.namespace)) {
        throw new KubeError(`Error from server (AlreadyExists): error when creating "${source}": ${info.plural}${info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : ""} "${obj.metadata.name}" already exists`);
      }
      const created = withSource(() => cluster.create(obj, { dryRun: isDry }), source, "creating");
      for (const w of cluster.takeWarnings()) err(ctx, `Warning: ${w}`);
      printed.push(created);
      if (!output) out(ctx, `${ref(info, created.metadata.name)} created${isDry ? " (dry run)" : ""}`);
    } catch (e) {
      if (e instanceof KubeError) {
        err(ctx, e.message);
        code = 1;
      } else throw e;
    }
  }
  if (output && printed.length) {
    const text = renderStructured(printed, output, printed.length === 1);
    if (text) out(ctx, text);
  }
  cluster.advance();
  return code;
}

export async function cmdReplace(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  const files = f.all("filename");
  if (files.length === 0) throw new KubeError("error: must specify --filename to replace");
  cluster.advance();
  const loaded = loadFiles(ctx.fs, files, ctx.io.stdin, f.bool("recursive"));
  let code = 0;
  for (const { obj: raw, source } of loaded) {
    try {
      const info = kindFromFile(raw, source);
      const obj = deepClone(raw);
      prepareNamespace(ctx, f, obj, info);
      validateFields(obj as unknown as Record<string, unknown>, "replacing", source);
      const existing = cluster.get(info.kind, obj.metadata.name, obj.metadata.namespace);
      if (f.bool("force")) {
        if (existing) {
          cluster.remove(info.kind, obj.metadata.name, obj.metadata.namespace);
          cluster.advance();
          out(ctx, `${quotedRef(info, obj.metadata.name)} deleted`);
        }
        const created = cluster.create(obj);
        out(ctx, `${ref(info, created.metadata.name)} replaced`);
        continue;
      }
      if (!existing) throw new KubeError(`Error from server (NotFound): error when replacing "${source}": ${info.plural} "${obj.metadata.name}" not found`);
      cluster.replace(obj);
      out(ctx, `${ref(info, obj.metadata.name)} replaced`);
    } catch (e) {
      if (e instanceof KubeError) {
        err(ctx, e.message);
        code = 1;
      } else throw e;
    }
  }
  cluster.advance();
  return code;
}

// ------------------------------------------------------------------ delete

export async function cmdDelete(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const isDry = dryRun(f);
  const victims: { info: KindInfo; obj: KObject }[] = [];
  const errors: string[] = [];
  const files = f.all("filename");
  if (files.length || f.all("kustomize").length) {
    for (const { obj } of loadInputs(ctx, f)) {
      const info = kindOrThrow(obj.kind);
      const n = obj.metadata?.namespace ?? ns;
      const o = cluster.get(info.kind, obj.metadata.name, info.namespaced ? n : undefined);
      if (o) victims.push({ info, obj: o });
      else errors.push(`Error from server (NotFound): error when deleting "${files[0]}": ${notFoundError(info, obj.metadata.name).message.replace("Error from server (NotFound): ", "")}`);
    }
  } else {
    const targets = parseTargets(f.args);
    if (targets.length === 0) throw new KubeError("error: You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   '-f rsrc.yaml'\n   '--filename=rsrc.json'\n   '<resource> <name>'\n   '<resource>'");
    const sel = selectorFilter(f);
    for (const t of targets) {
      if (t.names.length) {
        for (const n of t.names) {
          const o = cluster.get(t.info.kind, n, t.info.namespaced ? ns : undefined);
          if (o) victims.push({ info: t.info, obj: o });
          else errors.push(notFoundError(t.info, n).message);
        }
      } else if (f.bool("all") || sel) {
        let objs = cluster.list(t.info.kind, t.info.namespaced ? (f.bool("all-namespaces") ? undefined : ns) : undefined);
        if (sel) objs = objs.filter(sel);
        if (t.info.kind === "Service") objs = objs.filter((o) => !(o.metadata.name === "kubernetes" && o.metadata.namespace === "default"));
        for (const o of objs) victims.push({ info: t.info, obj: o });
      } else {
        throw new KubeError("error: resource(s) were provided, but no name was specified");
      }
    }
  }
  if (f.bool("force") && f.str("grace-period") === "0") {
    err(ctx, "Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
  }
  if (victims.length === 0 && errors.length === 0) err(ctx, `No resources found`);
  for (const v of victims) {
    if (!isDry) cluster.remove(v.info.kind, v.obj.metadata.name, v.obj.metadata.namespace);
    out(ctx, `${quotedRef(v.info, v.obj.metadata.name)} deleted${isDry ? " (dry run)" : ""}`);
  }
  for (const e of errors) err(ctx, e);
  cluster.advance();
  return errors.length ? 1 : 0;
}

// ------------------------------------------------------------------ label / annotate

async function labelLike(ctx: Ctx, f: Flags, field: "labels" | "annotations"): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const args = f.args;
  const pairs = args.filter((a) => /^[^=/]+(\/[^=]+)?=.*$/.test(a) || /^[\w./-]+-$/.test(a));
  const resArgs = args.filter((a) => !pairs.includes(a));
  const targets = parseTargets(resArgs);
  if (targets.length === 0) throw new KubeError(`error: one or more resources must be specified as <resource> <name> or <resource>/<name>`);
  if (pairs.length === 0) throw new KubeError(`error: at least one ${field === "labels" ? "label" : "annotation"} update is required`);
  const sel = selectorFilter(f);
  let code = 0;
  for (const t of targets) {
    let objs: KObject[] = [];
    if (t.names.length) {
      for (const n of t.names) {
        const o = cluster.get(t.info.kind, n, t.info.namespaced ? ns : undefined);
        if (!o) {
          err(ctx, notFoundError(t.info, n).message);
          code = 1;
        } else objs.push(o);
      }
    } else if (f.bool("all") || sel) {
      objs = cluster.list(t.info.kind, t.info.namespaced ? ns : undefined);
      if (sel) objs = objs.filter(sel);
    } else throw new KubeError("error: resource(s) were provided, but no name was specified");
    for (const o of objs) {
      const copy = deepClone(o);
      const map: Record<string, string> = { ...((copy.metadata[field] as Record<string, string>) ?? {}) };
      let changed = false;
      let removedOnly = true;
      for (const p of pairs) {
        if (p.endsWith("-") && !p.includes("=")) {
          const k = p.slice(0, -1);
          if (k in map) {
            delete map[k];
            changed = true;
          }
          continue;
        }
        removedOnly = false;
        const idx = p.indexOf("=");
        const k = p.slice(0, idx);
        const v = p.slice(idx + 1);
        if (field === "labels" && v && !/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(v)) {
          throw new KubeError(`error: invalid label value: "${p}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
        }
        if (k in map && map[k] !== v && !f.bool("overwrite")) {
          throw new KubeError(`error: '${k}' already has a value (${map[k]}), and --overwrite is false`);
        }
        if (map[k] !== v) changed = true;
        map[k] = v;
      }
      copy.metadata[field] = map;
      if (changed) cluster.replace(copy);
      const verb = field === "labels" ? (removedOnly ? "unlabeled" : "labeled") : "annotated";
      out(ctx, `${ref(t.info, o.metadata.name)} ${changed ? verb : field === "labels" ? "not labeled" : "annotated"}`);
    }
  }
  cluster.advance();
  return code;
}

export const cmdLabel = (ctx: Ctx, f: Flags) => labelLike(ctx, f, "labels");
export const cmdAnnotate = (ctx: Ctx, f: Flags) => labelLike(ctx, f, "annotations");

// ------------------------------------------------------------------ patch

function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return deepClone(patch);
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

/** Strategic merge: like merge patch, but lists of objects with a "name" are merged by name. */
export function strategicPatch(target: unknown, patch: unknown): unknown {
  if (Array.isArray(patch) && Array.isArray(target) && patch.every((p) => p && typeof p === "object" && "name" in p)) {
    const result = deepClone(target) as Record<string, unknown>[];
    for (const p of patch as Record<string, unknown>[]) {
      const idx = result.findIndex((x) => x && x.name === p.name);
      if (idx >= 0) result[idx] = strategicPatch(result[idx], p) as Record<string, unknown>;
      else result.push(deepClone(p));
    }
    return result;
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return deepClone(patch);
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = strategicPatch(base[k], v);
  }
  return base;
}

export function jsonPatch(target: unknown, ops: { op: string; path: string; value?: unknown; from?: string }[]): unknown {
  const doc = deepClone(target) as Record<string, unknown>;
  const parts = (p: string) => p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const op of ops) {
    const segs = parts(op.path);
    const last = segs.pop()!;
    let parent: Record<string, unknown> | unknown[] = doc;
    for (const s of segs) {
      parent = (Array.isArray(parent) ? parent[Number(s)] : parent[s]) as Record<string, unknown>;
      if (parent === undefined) throw new KubeError(`The request is invalid: the server rejected our request due to an error in our request`);
    }
    if (op.op === "add" || op.op === "replace") {
      if (Array.isArray(parent)) {
        if (last === "-") parent.push(op.value);
        else if (op.op === "add") parent.splice(Number(last), 0, op.value);
        else parent[Number(last)] = op.value;
      } else parent[last] = op.value;
    } else if (op.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
    } else throw new KubeError(`error: unable to parse patch: unsupported op "${op.op}"`);
  }
  return doc;
}

export async function cmdPatch(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  let patchText = f.str("patch");
  const args = [...f.args];
  if (!patchText && f.bool("previous")) {
    // "-p" is parsed as --previous for logs; for patch it carries the patch.
    const idx = args.findIndex((a) => /^\s*[{[]/.test(a) || a.includes(":"));
    if (idx >= 0) patchText = args.splice(idx, 1)[0];
  }
  if (!patchText) throw new KubeError("error: must specify --patch or --patch-file containing the contents of the patch");
  const targets = parseTargets(args);
  if (targets.length !== 1 || targets[0].names.length !== 1) throw new KubeError("error: resource(s) were provided, but no name was specified");
  const t = targets[0];
  const live = cluster.get(t.info.kind, t.names[0], t.info.namespaced ? ns : undefined);
  if (!live) throw notFoundError(t.info, t.names[0]);
  let patch: unknown;
  try {
    patch = parseYaml(patchText);
  } catch (e) {
    throw new KubeError(`error: unable to parse "${patchText}": ${(e as Error).message.split("\n")[0]}`);
  }
  const type = f.str("type") ?? "strategic";
  const base = deepClone(live);
  delete base.status;
  let next: KObject;
  if (type === "json") next = jsonPatch(base, patch as { op: string; path: string; value?: unknown }[]) as KObject;
  else if (type === "merge") next = mergePatch(base, patch) as KObject;
  else next = strategicPatch(base, patch) as KObject;
  validateFields(next as unknown as Record<string, unknown>, "applying", "patch");
  const before = stableStringify(base);
  if (stableStringify(next) === before) {
    out(ctx, `${ref(t.info, t.names[0])} patched (no change)`);
    return 0;
  }
  cluster.replace(next);
  out(ctx, `${ref(t.info, t.names[0])} patched`);
  cluster.advance();
  return 0;
}

export function printDryRun(ctx: Ctx, obj: KObject, output: string | undefined, info: KindInfo): void {
  if (output) {
    const text = renderStructured([obj], output, true);
    if (text) out(ctx, text);
  } else out(ctx, `${ref(info, obj.metadata.name)} created (dry run)`);
}

export function kindFor(name: string): KindInfo {
  return kindInfo(name);
}

export { toYaml, KINDS };
