// Kustomize as built into kubectl (kubectl kustomize, apply -k): resources
// and bases, ConfigMap and Secret generators with hash suffixes, namespace,
// name prefix and suffix with reference updates, labels, annotations,
// images, replicas, and strategic merge and JSON 6902 patches.

import { parse as parseYaml } from "yaml";
import type { FileSystem } from "../fs.js";
import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { resolveKind } from "../kinds.js";
import { deepClone, fnv1a, safeEncode, stableStringify, matchLabelSelector, parseSelector, matchRequirements } from "../util.js";
import { toBase64 } from "../cluster.js";
import { parseManifests } from "./manifest.js";
import { strategicPatch, jsonPatch } from "./resources.js";

type K = Record<string, any>;

const ORDER = ["Namespace", "ResourceQuota", "StorageClass", "CustomResourceDefinition", "ServiceAccount", "PodSecurityPolicy", "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding", "ConfigMap", "Secret", "Endpoints", "Service", "LimitRange", "PriorityClass", "PersistentVolume", "PersistentVolumeClaim", "Deployment", "StatefulSet", "CronJob", "PodDisruptionBudget"];
const LAST = ["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"];

function join(dir: string, p: string): string {
  if (p.startsWith("/")) return p;
  const parts = `${dir}/${p}`.split("/");
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/") || ".";
}

function readKustomization(fs: FileSystem, dir: string): K {
  for (const name of ["kustomization.yaml", "kustomization.yml", "Kustomization"]) {
    const p = join(dir, name);
    if (fs.exists(p) && !fs.isDirectory(p)) {
      try {
        return (parseYaml(fs.readFile(p)) as K) ?? {};
      } catch (e) {
        throw new KubeError(`error: invalid Kustomization: ${(e as Error).message}`);
      }
    }
  }
  throw new KubeError(`error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${fs.cwd()}/${dir === "." ? "" : dir}'`.replace(/\/'$/, "'"));
}

function hashOf(obj: K): string {
  return safeEncode(fnv1a(stableStringify({ kind: obj.kind, data: obj.data ?? {}, binaryData: obj.binaryData ?? {}, type: obj.type })), 10);
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function generate(fs: FileSystem, dir: string, spec: K, kind: "ConfigMap" | "Secret", options: K): K {
  const data: Record<string, string> = {};
  for (const lit of spec.literals ?? []) {
    const i = String(lit).indexOf("=");
    if (i <= 0) throw new KubeError(`error: invalid literal source ${lit}, expected key=value`);
    data[String(lit).slice(0, i)] = String(lit).slice(i + 1);
  }
  for (const f of spec.files ?? []) {
    const [key, path] = String(f).includes("=") ? String(f).split("=") : [String(f).split("/").pop()!, String(f)];
    const full = join(dir, path);
    if (!fs.exists(full)) throw new KubeError(`error: evalsymlink failure on '${fs.cwd()}/${full}' : lstat ${fs.cwd()}/${full}: no such file or directory`);
    data[key] = fs.readFile(full);
  }
  for (const e of [...(spec.envs ?? []), ...(spec.env ? [spec.env] : [])]) {
    const full = join(dir, String(e));
    if (!fs.exists(full)) throw new KubeError(`error: evalsymlink failure on '${fs.cwd()}/${full}' : lstat ${fs.cwd()}/${full}: no such file or directory`);
    Object.assign(data, parseEnvFile(fs.readFile(full)));
  }
  const opts = { ...options, ...(spec.options ?? {}) };
  const obj: K = {
    apiVersion: "v1",
    kind,
    metadata: { name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), ...(opts.labels ? { labels: { ...opts.labels } } : {}), ...(opts.annotations ? { annotations: { ...opts.annotations } } : {}) },
  };
  if (kind === "Secret") {
    obj.type = spec.type ?? "Opaque";
    obj.data = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toBase64(v)]));
  } else obj.data = data;
  obj.__generated = { behavior: spec.behavior ?? "create", hash: !opts.disableNameSuffixHash };
  return obj;
}

function matchesTarget(o: K, t: K | undefined): boolean {
  if (!t) return true;
  if (t.kind && t.kind !== o.kind) return false;
  if (t.name && !new RegExp(`^${t.name}$`).test(o.metadata?.name ?? "")) return false;
  if (t.namespace && t.namespace !== (o.metadata?.namespace ?? "")) return false;
  if (t.group !== undefined && t.group !== (o.apiVersion.includes("/") ? o.apiVersion.split("/")[0] : "")) return false;
  if (t.labelSelector && !matchRequirements(o.metadata?.labels, parseSelector(t.labelSelector))) return false;
  if (t.annotationSelector && !matchRequirements(o.metadata?.annotations, parseSelector(t.annotationSelector))) return false;
  return true;
}

function applyPatchText(objs: K[], text: string, target: K | undefined, where: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new KubeError(`error: trouble configuring builtin PatchTransformer with config: ${(e as Error).message}`);
  }
  if (Array.isArray(parsed)) {
    if (!target) throw new KubeError(`error: trouble configuring builtin PatchTransformer: must specify a target for JSON patch ${where}`);
    let hit = false;
    for (let i = 0; i < objs.length; i++) {
      if (!matchesTarget(objs[i], target)) continue;
      objs[i] = jsonPatch(objs[i], parsed as { op: string; path: string; value?: unknown }[]) as K;
      hit = true;
    }
    if (!hit) throw new KubeError(`error: no resource matches the target of patch ${where}`);
    return;
  }
  const p = parsed as K;
  if (!p || typeof p !== "object") return;
  let hit = false;
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const t = target ?? { kind: p.kind, name: p.metadata?.name };
    if (!matchesTarget(o, target ? t : { kind: p.kind })) continue;
    if (!target && p.metadata?.name && o.metadata?.name !== p.metadata.name) continue;
    const patch = deepClone(p);
    if (target) {
      delete patch.metadata?.name;
      delete patch.kind;
      delete patch.apiVersion;
    }
    objs[i] = strategicPatch(o, patch) as K;
    hit = true;
  }
  if (!hit) throw new KubeError(`error: failed to find unique target for patch ${p.kind ?? ""} ${p.metadata?.name ?? ""}`.trim());
}

function podSpecs(o: K): K[] {
  if (o.kind === "Pod") return [o.spec];
  if (o.kind === "CronJob") return [o.spec?.jobTemplate?.spec?.template?.spec];
  return [o.spec?.template?.spec];
}

/** Rename references from workloads, bindings and ingresses after names changed. */
function updateRefs(objs: K[], renamed: Map<string, string>): void {
  const map = (kind: string, name: string | undefined) => {
    let cur = name;
    for (let i = 0; cur && i < 5; i++) {
      const next = renamed.get(`${kind}/${cur}`);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  for (const o of objs) {
    for (const spec of podSpecs(o)) {
      if (!spec) continue;
      if (spec.serviceAccountName) spec.serviceAccountName = map("ServiceAccount", spec.serviceAccountName);
      for (const v of spec.volumes ?? []) {
        if (v.configMap) v.configMap.name = map("ConfigMap", v.configMap.name);
        if (v.secret) v.secret.secretName = map("Secret", v.secret.secretName);
        if (v.persistentVolumeClaim) v.persistentVolumeClaim.claimName = map("PersistentVolumeClaim", v.persistentVolumeClaim.claimName);
        for (const src of v.projected?.sources ?? []) {
          if (src.configMap) src.configMap.name = map("ConfigMap", src.configMap.name);
          if (src.secret) src.secret.name = map("Secret", src.secret.name);
        }
      }
      for (const s of spec.imagePullSecrets ?? []) s.name = map("Secret", s.name);
      for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        for (const ef of c.envFrom ?? []) {
          if (ef.configMapRef) ef.configMapRef.name = map("ConfigMap", ef.configMapRef.name);
          if (ef.secretRef) ef.secretRef.name = map("Secret", ef.secretRef.name);
        }
        for (const e of c.env ?? []) {
          if (e.valueFrom?.configMapKeyRef) e.valueFrom.configMapKeyRef.name = map("ConfigMap", e.valueFrom.configMapKeyRef.name);
          if (e.valueFrom?.secretKeyRef) e.valueFrom.secretKeyRef.name = map("Secret", e.valueFrom.secretKeyRef.name);
        }
      }
    }
    if (o.kind === "StatefulSet" && o.spec?.serviceName) o.spec.serviceName = map("Service", o.spec.serviceName);
    if (o.kind === "Ingress") {
      const fix = (b: K | undefined) => b?.service && (b.service.name = map("Service", b.service.name));
      fix(o.spec?.defaultBackend);
      for (const r of o.spec?.rules ?? []) for (const p of r.http?.paths ?? []) fix(p.backend);
    }
    if (o.kind === "RoleBinding" || o.kind === "ClusterRoleBinding") {
      if (o.roleRef) o.roleRef.name = map(o.roleRef.kind, o.roleRef.name);
      for (const sub of o.subjects ?? []) if (sub.kind === "ServiceAccount") sub.name = map("ServiceAccount", sub.name);
    }
    if (o.kind === "HorizontalPodAutoscaler" && o.spec?.scaleTargetRef) o.spec.scaleTargetRef.name = map(o.spec.scaleTargetRef.kind, o.spec.scaleTargetRef.name);
  }
}

function addLabels(o: K, labels: Record<string, string>, selectors: boolean, templates: boolean): void {
  o.metadata = o.metadata ?? {};
  o.metadata.labels = { ...(o.metadata.labels ?? {}), ...labels };
  const workload = ["Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job"].includes(o.kind);
  if ((selectors || templates) && workload && o.spec?.template) {
    o.spec.template.metadata = o.spec.template.metadata ?? {};
    o.spec.template.metadata.labels = { ...(o.spec.template.metadata.labels ?? {}), ...labels };
  }
  if (o.kind === "CronJob" && (selectors || templates) && o.spec?.jobTemplate?.spec?.template) {
    const tpl = o.spec.jobTemplate.spec.template;
    tpl.metadata = { ...(tpl.metadata ?? {}), labels: { ...(tpl.metadata?.labels ?? {}), ...labels } };
  }
  if (!selectors) return;
  if (workload && o.kind !== "Job") o.spec.selector = { ...(o.spec.selector ?? {}), matchLabels: { ...(o.spec.selector?.matchLabels ?? {}), ...labels } };
  if (o.kind === "Service" && o.spec) o.spec.selector = { ...(o.spec.selector ?? {}), ...labels };
  if (o.kind === "NetworkPolicy" && o.spec?.podSelector) o.spec.podSelector.matchLabels = { ...(o.spec.podSelector.matchLabels ?? {}), ...labels };
  if (o.kind === "PodDisruptionBudget" && o.spec?.selector) o.spec.selector.matchLabels = { ...(o.spec.selector.matchLabels ?? {}), ...labels };
}

/** Build a kustomization directory into a list of objects. */
export function kustomize(fs: FileSystem, dir: string, depth = 0): KObject[] {
  if (depth > 10) throw new KubeError("error: kustomization nesting too deep");
  dir = dir.replace(/\/$/, "") || ".";
  if (!fs.exists(dir)) throw new KubeError(`error: must build at directory: not a valid directory: evalsymlink failure on '${fs.cwd()}/${dir}' : lstat ${fs.cwd()}/${dir}: no such file or directory`);
  const k = readKustomization(fs, dir);
  let objs: K[] = [];
  for (const r of [...(k.resources ?? []), ...(k.bases ?? [])]) {
    const p = join(dir, String(r));
    if (/^https?:\/\//.test(String(r)) || String(r).startsWith("github.com/")) throw new KubeError(`error: accumulating resources: accumulation err='accumulating resources from '${r}': (podsim) remote resources are not available in the simulator'`);
    if (!fs.exists(p)) throw new KubeError(`error: accumulating resources: accumulation err='accumulating resources from '${r}': evalsymlink failure on '${fs.cwd()}/${p}' : lstat ${fs.cwd()}/${p}: no such file or directory'`);
    if (fs.isDirectory(p)) objs.push(...(kustomize(fs, p, depth + 1) as K[]));
    else objs.push(...parseManifests(fs.readFile(p), p).map((x) => x.obj as K));
  }
  // Generators.
  const genOpts = k.generatorOptions ?? {};
  for (const [field, kind] of [["configMapGenerator", "ConfigMap"], ["secretGenerator", "Secret"]] as const) {
    for (const spec of k[field] ?? []) {
      const g = generate(fs, dir, spec, kind, genOpts);
      const behavior = g.__generated.behavior;
      if (behavior === "merge" || behavior === "replace") {
        const i = objs.findIndex((o) => o.kind === kind && (o.__origName ?? o.metadata?.name) === spec.name);
        if (i < 0) throw new KubeError(`error: merging from generator: cannot find resource ${kind} ${spec.name} to ${behavior}`);
        const base = objs[i];
        const data = behavior === "merge" ? { ...(base.data ?? {}), ...g.data } : g.data;
        objs[i] = { ...base, data };
        continue;
      }
      objs.push(g);
    }
  }
  // Patches (by original names).
  for (const p of k.patchesStrategicMerge ?? []) {
    const text = typeof p === "string" && !p.includes("\n") && fs.exists(join(dir, p)) ? fs.readFile(join(dir, p)) : String(p);
    for (const doc of text.split(/^---\s*$/m)) if (doc.trim()) applyPatchText(objs, doc, undefined, String(p));
  }
  for (const p of [...(k.patches ?? []), ...(k.patchesJson6902 ?? [])]) {
    const text = p.path ? fs.readFile(join(dir, p.path)) : String(p.patch ?? "");
    if (!text.trim()) continue;
    applyPatchText(objs, text, p.target, p.path ?? "inline");
  }
  // Namespace.
  if (k.namespace) {
    for (const o of objs) {
      const info = resolveKind(o.kind);
      if (info?.namespaced !== false) o.metadata = { ...(o.metadata ?? {}), namespace: k.namespace };
      if (o.kind === "RoleBinding" || o.kind === "ClusterRoleBinding") for (const s of o.subjects ?? []) if (s.kind === "ServiceAccount") s.namespace = k.namespace;
    }
  }
  // Names: prefix, suffix and generator hashes, then fix references.
  const renamed = new Map<string, string>();
  for (const o of objs) {
    if (!o.metadata?.name) continue;
    const orig = o.__origName ?? o.metadata.name;
    let name = o.metadata.name;
    if (o.kind !== "Namespace" && o.kind !== "CustomResourceDefinition") name = `${k.namePrefix ?? ""}${name}${k.nameSuffix ?? ""}`;
    if (name !== o.metadata.name) {
      renamed.set(`${o.kind}/${o.metadata.name}`, name);
      o.metadata.name = name;
    }
    o.__origName = orig;
  }
  // Labels and annotations.
  if (k.commonLabels) for (const o of objs) addLabels(o, k.commonLabels, true, true);
  for (const l of k.labels ?? []) for (const o of objs) addLabels(o, l.pairs ?? {}, !!l.includeSelectors, !!l.includeTemplates || !!l.includeSelectors);
  if (k.commonAnnotations) {
    for (const o of objs) {
      o.metadata.annotations = { ...(o.metadata.annotations ?? {}), ...k.commonAnnotations };
      for (const spec of [o.spec?.template, o.spec?.jobTemplate?.spec?.template]) if (spec) spec.metadata = { ...(spec.metadata ?? {}), annotations: { ...(spec.metadata?.annotations ?? {}), ...k.commonAnnotations } };
    }
  }
  // Generated names get a content hash (after labels, like kustomize).
  for (const o of objs) {
    if (!o.__generated || depth > 0) continue;
    if (o.__generated.hash) {
      const name = `${o.metadata.name}-${hashOf(o)}`;
      renamed.set(`${o.kind}/${o.__origName}`, name);
      renamed.set(`${o.kind}/${o.metadata.name}`, name);
      o.metadata.name = name;
    }
  }
  updateRefs(objs, renamed);
  // Images.
  for (const img of k.images ?? []) {
    for (const o of objs) {
      for (const spec of podSpecs(o)) {
        for (const c of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) {
          const ref = String(c.image ?? "");
          const at = ref.indexOf("@");
          const base = at >= 0 ? ref.slice(0, at) : ref.replace(/:([^:/]+)$/, "");
          if (base !== img.name) continue;
          const tag = img.digest ? `@${img.digest}` : img.newTag !== undefined ? `:${img.newTag}` : at >= 0 ? ref.slice(at) : ref.slice(base.length);
          c.image = `${img.newName ?? base}${tag}`;
        }
      }
    }
  }
  // Replicas.
  for (const r of k.replicas ?? []) {
    for (const o of objs) if ((o.__origName === r.name || o.metadata.name === r.name) && ["Deployment", "StatefulSet", "ReplicaSet"].includes(o.kind)) o.spec.replicas = r.count;
  }
  if (depth > 0) return objs as KObject[];
  const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : LAST.includes(kind) ? 1000 + LAST.indexOf(kind) : ORDER.length);
  objs.sort((a, b) => rank(a.kind) - rank(b.kind) || (rank(a.kind) === ORDER.length ? a.kind.localeCompare(b.kind) : 0) || String(a.metadata?.name).localeCompare(String(b.metadata?.name)));
  for (const o of objs) {
    delete o.__generated;
    delete o.__origName;
  }
  void matchLabelSelector;
  return objs as KObject[];
}
