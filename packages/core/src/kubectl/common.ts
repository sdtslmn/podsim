// Shared plumbing for kubectl commands.

import type { Cluster } from "../cluster.js";
import type { FileSystem } from "../fs.js";
import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { KINDS, PLANNED_KINDS, resolveKind, type KindInfo } from "../kinds.js";
import { matchRequirements, parseSelector } from "../util.js";
import { evalPath } from "./jsonpath.js";
import type { Flags } from "./flags.js";

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Text piped in or provided through a heredoc. */
  stdin?: string;
  /** Wait in real time (used by rollout status, wait, run --rm). */
  sleep(ms: number): Promise<void>;
  /** True once the user pressed Ctrl+C. */
  aborted?(): boolean;
}

export interface KubectlState {
  namespace: string;
}

export interface Ctx {
  cluster: Cluster;
  fs: FileSystem;
  state: KubectlState;
  io: IO;
  /** The full command line, for --record. */
  raw: string;
}

export function out(ctx: Ctx, text: string): void {
  ctx.io.stdout(text.endsWith("\n") || text === "" ? text : text + "\n");
}

export function err(ctx: Ctx, text: string): void {
  ctx.io.stderr(text.endsWith("\n") ? text : text + "\n");
}

export function nsOf(ctx: Ctx, f: Flags): string {
  return f.str("namespace") ?? ctx.state.namespace;
}

export function plannedError(name: string): KubeError {
  const kind = PLANNED_KINDS[name.toLowerCase()];
  return new KubeError(`(k8s-sim) ${kind} resources are not simulated yet. They are on the roadmap.`);
}

export function kindOrThrow(name: string): KindInfo {
  const info = resolveKind(name);
  if (!info) {
    if (PLANNED_KINDS[name.toLowerCase()] || PLANNED_KINDS[name.toLowerCase().split(".")[0]]) throw plannedError(name.split(".")[0]);
    throw new KubeError(`error: the server doesn't have a resource type "${name}"`);
  }
  return info;
}

export interface Target {
  info: KindInfo;
  names: string[];
}

const ALL_KINDS = ["Pod", "Service", "Deployment", "ReplicaSet"];

/**
 * Parse resource arguments: "pods", "pod web api", "pod/web svc/x",
 * "pods,svc", "all". Returns one entry per kind, in order.
 */
export function parseTargets(args: string[]): Target[] {
  if (args.length === 0) return [];
  const targets: Target[] = [];
  const push = (info: KindInfo, name?: string) => {
    let t = targets.find((x) => x.info.kind === info.kind);
    if (!t) {
      t = { info, names: [] };
      targets.push(t);
    }
    if (name) t.names.push(name);
  };
  if (args.some((a) => a.includes("/"))) {
    for (const a of args) {
      const idx = a.indexOf("/");
      if (idx < 0) throw new KubeError(`error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>'`);
      push(kindOrThrow(a.slice(0, idx)), a.slice(idx + 1));
    }
    return targets;
  }
  const [types, ...names] = args;
  for (const t of types.split(",")) {
    if (t === "all") {
      for (const k of ALL_KINDS) push(KINDS.find((x) => x.kind === k)!);
      continue;
    }
    push(kindOrThrow(t));
  }
  if (names.length) {
    if (targets.length > 1) throw new KubeError("error: you may only specify a single resource type");
    for (const n of names) targets[0].names.push(n);
  }
  return targets;
}

export function selectorFilter(f: Flags): ((o: KObject) => boolean) | undefined {
  const sel = f.str("selector");
  if (!sel) return undefined;
  const reqs = parseSelector(sel);
  return (o) => matchRequirements(o.metadata.labels, reqs);
}

export function fieldSelectorFilter(f: Flags): ((o: KObject) => boolean) | undefined {
  const fs = f.str("field-selector");
  if (!fs) return undefined;
  const parts = fs.split(",").map((p) => {
    const m = p.match(/^([\w.]+)\s*(==|!=|=)\s*(.*)$/);
    if (!m) throw new KubeError(`error: invalid field selector: '${p}'`);
    return { path: m[1], neg: m[2] === "!=", value: m[3] };
  });
  return (o) =>
    parts.every((p) => {
      const v = evalPath(o, "." + p.path)[0];
      const s = v === undefined || v === null ? "" : String(v);
      return p.neg ? s !== p.value : s === p.value;
    });
}

export function notFoundError(info: KindInfo, name: string): KubeError {
  const group = info.apiVersion.includes("/") && !info.apiVersion.startsWith("v1") ? `.${info.apiVersion.split("/")[0]}` : "";
  return new KubeError(`Error from server (NotFound): ${info.plural}${group} "${name}" not found`);
}

export function getOne(ctx: Ctx, info: KindInfo, name: string, ns: string): KObject {
  ctx.cluster.advance();
  const obj = ctx.cluster.get(info.kind, name, info.namespaced ? ns : undefined);
  if (!obj) throw notFoundError(info, name);
  return obj;
}

/** Display name like deployment.apps/web or pod/web. */
export function ref(info: KindInfo, name: string): string {
  const group = info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : "";
  return `${info.singular}${group}/${name}`;
}

/** Quoted form used in delete messages: deployment.apps "web". */
export function quotedRef(info: KindInfo, name: string): string {
  const group = info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : "";
  return `${info.singular}${group} "${name}"`;
}

export function dryRun(f: Flags): boolean {
  const v = f.str("dry-run");
  if (v === undefined) return false;
  if (v === "server") return true;
  if (v === "client" || v === "true" || v === "") return true;
  if (v === "none" || v === "false") return false;
  throw new KubeError(`error: Invalid dry-run value (${v}). Must be "none", "server", or "client".`);
}

/** Split "TYPE/NAME" or "TYPE NAME" into a single target, used by scale/expose/set/rollout. */
export function singleTarget(args: string[], what: string): { info: KindInfo; name: string; rest: string[] } {
  if (args.length === 0) throw new KubeError(`error: required resource not specified`);
  if (args[0].includes("/")) {
    const [t, n] = args[0].split("/");
    return { info: kindOrThrow(t), name: n, rest: args.slice(1) };
  }
  if (args.length < 2) throw new KubeError(`error: you must specify the name of the resource to ${what}`);
  return { info: kindOrThrow(args[0]), name: args[1], rest: args.slice(2) };
}

export function stripGenerated(obj: KObject): KObject {
  const o = JSON.parse(JSON.stringify(obj)) as KObject;
  return o;
}
