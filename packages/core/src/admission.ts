// Admission control: what the API server checks and changes before it
// stores an object. ServiceAccount lookup, LimitRange defaults and limits,
// ResourceQuota, and Pod Security Admission (baseline and restricted).

import type { Cluster } from "./cluster.js";
import type { KObject } from "./types.js";
import { KubeError } from "./types.js";
import { kindInfo } from "./kinds.js";
import { parseCpu, parseMemory } from "./util.js";

export class AdmissionError extends KubeError {
  constructor(public detail: string) {
    super(`Error from server (Forbidden): ${detail}`);
  }
}

// ------------------------------------------------------------------ quantities

function cpuMilli(q: unknown): number {
  return Math.round(parseCpu(q as string));
}

function memBytes(q: unknown): number {
  const v = parseMemory(q as string);
  return Number.isNaN(v) ? 0 : v;
}

export function formatCpu(milli: number): string {
  return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
}

export function formatMem(bytes: number): string {
  if (bytes === 0) return "0";
  const units: [string, number][] = [["Gi", 1024 ** 3], ["Mi", 1024 ** 2], ["Ki", 1024]];
  for (const [u, n] of units) if (bytes % n === 0) return `${bytes / n}${u}`;
  for (const [u, n] of [["G", 1e9], ["M", 1e6], ["k", 1e3]] as [string, number][]) if (bytes % n === 0) return `${bytes / n}${u}`;
  return String(bytes);
}

const isCpu = (res: string) => res === "cpu" || res.endsWith(".cpu");
const quantity = (res: string, v: unknown) => (isCpu(res) ? cpuMilli(v) : res.includes("memory") || res.includes("storage") ? memBytes(v) : Number(v) || 0);
const show = (res: string, n: number) => (isCpu(res) ? formatCpu(n) : res.includes("memory") || res.includes("storage") ? formatMem(n) : String(n));

// ------------------------------------------------------------------ LimitRange

interface Containerish {
  name: string;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

/** Apply LimitRange defaults to a pod and enforce min, max and ratio. Returns the annotation text, if any. */
function applyLimitRanges(cluster: Cluster, pod: KObject): void {
  const ns = pod.metadata.namespace ?? "default";
  const ranges = cluster.list("LimitRange", ns);
  if (!ranges.length) return;
  const setReq: string[] = [];
  const setLim: string[] = [];
  const all = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])] as Containerish[];
  for (const lr of ranges) {
    for (const item of (lr.spec?.limits ?? []) as Record<string, any>[]) {
      if (item.type !== "Container") continue;
      for (const c of all) {
        c.resources = c.resources ?? {};
        for (const res of ["cpu", "memory", "ephemeral-storage"]) {
          const lim = item.default?.[res];
          const req = item.defaultRequest?.[res];
          if (lim !== undefined && c.resources.limits?.[res] === undefined) {
            c.resources.limits = { ...(c.resources.limits ?? {}), [res]: String(lim) };
            setLim.push(`${res}|${c.name}`);
          }
          if (c.resources.requests?.[res] === undefined) {
            const value = req ?? c.resources.limits?.[res];
            if (value !== undefined) {
              c.resources.requests = { ...(c.resources.requests ?? {}), [res]: String(value) };
              setReq.push(`${res}|${c.name}`);
            }
          }
        }
      }
    }
  }
  if (setReq.length || setLim.length) {
    const group = (list: string[], what: string) => {
      const byC = new Map<string, string[]>();
      for (const x of list) {
        const [res, c] = x.split("|");
        byC.set(c, [...(byC.get(c) ?? []), res]);
      }
      return [...byC.entries()].map(([c, rs]) => `${rs.join(", ")} ${what} for container ${c}`);
    };
    pod.metadata.annotations = { ...(pod.metadata.annotations ?? {}), "kubernetes.io/limit-ranger": `LimitRanger plugin set: ${[...group(setReq, "request"), ...group(setLim, "limit")].join("; ")}` };
  }
  // Validation after defaults.
  const kind = "pods";
  for (const lr of ranges) {
    for (const item of (lr.spec?.limits ?? []) as Record<string, any>[]) {
      if (item.type === "Container") {
        for (const c of all) {
          for (const res of ["cpu", "memory"]) {
            const req = c.resources?.requests?.[res];
            const lim = c.resources?.limits?.[res];
            const max = item.max?.[res];
            const min = item.min?.[res];
            if (max !== undefined) {
              if (lim === undefined) throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: maximum ${res} usage per Container is ${max}.  No limit is specified`);
              if (quantity(res, lim) > quantity(res, max)) throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: maximum ${res} usage per Container is ${max}, but limit is ${lim}`);
            }
            if (min !== undefined) {
              if (req === undefined) throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: minimum ${res} usage per Container is ${min}.  No request is specified`);
              if (quantity(res, req) < quantity(res, min)) throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: minimum ${res} usage per Container is ${min}, but request is ${req}`);
            }
            const ratio = item.maxLimitRequestRatio?.[res];
            if (ratio !== undefined && req !== undefined && lim !== undefined && quantity(res, lim) / quantity(res, req) > Number(ratio)) {
              throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: ${res} max limit to request ratio per Container is ${ratio}, but provided ratio is ${(quantity(res, lim) / quantity(res, req)).toFixed(6)}`);
            }
          }
        }
      }
      if (item.type === "Pod") {
        for (const res of ["cpu", "memory"]) {
          const max = item.max?.[res];
          if (max === undefined) continue;
          const sum = all.reduce((n, c) => n + quantity(res, c.resources?.limits?.[res] ?? 0), 0);
          if (sum > quantity(res, max)) throw new AdmissionError(`${kind} "${pod.metadata.name}" is forbidden: maximum ${res} usage per Pod is ${max}, but limit is ${show(res, sum)}`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ ResourceQuota

function podUsage(pod: KObject): Record<string, number> {
  const out: Record<string, number> = { pods: 1 };
  const cs = (pod.spec?.containers ?? []) as Containerish[];
  for (const res of ["cpu", "memory"]) {
    const req = cs.reduce((n, c) => n + quantity(res, c.resources?.requests?.[res] ?? 0), 0);
    const lim = cs.reduce((n, c) => n + quantity(res, c.resources?.limits?.[res] ?? 0), 0);
    out[`requests.${res}`] = req;
    out[res] = req;
    out[`limits.${res}`] = lim;
  }
  return out;
}

function isTerminal(p: KObject): boolean {
  return p.status?.phase === "Succeeded" || p.status?.phase === "Failed";
}

const COUNTED: Record<string, string> = {
  services: "Service",
  configmaps: "ConfigMap",
  secrets: "Secret",
  persistentvolumeclaims: "PersistentVolumeClaim",
  replicationcontrollers: "ReplicationController",
  resourcequotas: "ResourceQuota",
};

/** Current usage in a namespace for the resources a quota tracks. */
export function quotaUsage(cluster: Cluster, ns: string, hard: Record<string, unknown>): Record<string, string> {
  const used: Record<string, number> = {};
  const pods = cluster.list("Pod", ns).filter((p) => !isTerminal(p));
  for (const key of Object.keys(hard)) {
    if (key === "pods" || key === "count/pods") used[key] = pods.length;
    else if (["cpu", "memory", "requests.cpu", "requests.memory", "limits.cpu", "limits.memory"].includes(key)) used[key] = pods.reduce((n, p) => n + (podUsage(p)[key] ?? 0), 0);
    else if (COUNTED[key]) used[key] = COUNTED[key] === "ReplicationController" ? 0 : cluster.list(COUNTED[key], ns).length;
    else if (key === "services.nodeports") used[key] = cluster.list("Service", ns).filter((s) => s.spec?.type === "NodePort" || s.spec?.type === "LoadBalancer").length;
    else if (key === "services.loadbalancers") used[key] = cluster.list("Service", ns).filter((s) => s.spec?.type === "LoadBalancer").length;
    else if (key === "requests.storage") used[key] = cluster.list("PersistentVolumeClaim", ns).reduce((n, c) => n + memBytes(c.spec?.resources?.requests?.storage ?? 0), 0);
    else if (key.startsWith("count/")) {
      const [res] = key.slice(6).split(".");
      try {
        used[key] = cluster.list(kindInfo(res).kind, ns).length;
      } catch {
        used[key] = 0;
      }
    } else used[key] = 0;
  }
  return Object.fromEntries(Object.entries(used).map(([k, v]) => [k, show(k, v)]));
}

function checkQuota(cluster: Cluster, obj: KObject, adding: Record<string, number>, needSpec: (res: string) => string[] | undefined): void {
  const ns = obj.metadata.namespace ?? "default";
  const info = kindInfo(obj.kind);
  const plural = info.plural + (info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : "");
  for (const q of cluster.list("ResourceQuota", ns)) {
    const hard = (q.spec?.hard ?? {}) as Record<string, unknown>;
    const missing: string[] = [];
    for (const res of Object.keys(hard)) {
      const m = needSpec(res);
      if (m) missing.push(...m.map((c) => `${res} for: ${c}`));
    }
    if (missing.length) {
      const byRes = new Map<string, string[]>();
      for (const m of missing) {
        const [res, c] = m.split(" for: ");
        byRes.set(res, [...(byRes.get(res) ?? []), c]);
      }
      throw new AdmissionError(`${info.plural} "${obj.metadata.name}" is forbidden: failed quota: ${q.metadata.name}: must specify ${[...byRes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([r, cs]) => `${r} for: ${cs.join(",")}`).join("; ")}`);
    }
    const used = quotaUsage(cluster, ns, hard);
    const over: string[] = [];
    for (const [res, add] of Object.entries(adding)) {
      if (!(res in hard) || add === 0) continue;
      const u = quantity(res, used[res] ?? 0);
      if (u + add > quantity(res, hard[res])) over.push(res);
    }
    if (over.length) {
      over.sort();
      const fmt = (f: (r: string) => string) => over.map((r) => `${r}=${f(r)}`).join(",");
      throw new AdmissionError(
        `${plural === "pods" ? "pods" : plural} "${obj.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${fmt((r) => show(r, adding[r]))}, used: ${fmt((r) => String(used[r] ?? "0"))}, limited: ${fmt((r) => show(r, quantity(r, hard[r])))}`,
      );
    }
  }
}

function quotaPod(cluster: Cluster, pod: KObject): void {
  const cs = (pod.spec?.containers ?? []) as Containerish[];
  const usage = podUsage(pod);
  const adding: Record<string, number> = { ...usage, "count/pods": 1 };
  checkQuota(cluster, pod, adding, (res) => {
    const m = res.match(/^(requests|limits)\.(cpu|memory)$|^(cpu|memory)$/);
    if (!m) return undefined;
    const section = m[1] ?? "requests";
    const name = m[2] ?? m[3];
    const lacking = cs.filter((c) => c.resources?.[section as "requests" | "limits"]?.[name] === undefined).map((c) => c.name);
    return lacking.length ? lacking : undefined;
  });
}

/** Quota checks for objects other than pods (counts, NodePorts, storage). */
export function admitObject(cluster: Cluster, obj: KObject): void {
  const info = kindInfo(obj.kind);
  if (!info.namespaced || obj.kind === "Pod" || obj.kind === "Event") return;
  const group = info.apiVersion.includes("/") ? info.apiVersion.split("/")[0] : "";
  const adding: Record<string, number> = { [`count/${info.plural}${group ? "." + group : ""}`]: 1 };
  const plain = Object.entries(COUNTED).find(([, k]) => k === obj.kind)?.[0];
  if (plain) adding[plain] = 1;
  if (obj.kind === "Service" && (obj.spec?.type === "NodePort" || obj.spec?.type === "LoadBalancer")) adding["services.nodeports"] = 1;
  if (obj.kind === "Service" && obj.spec?.type === "LoadBalancer") adding["services.loadbalancers"] = 1;
  if (obj.kind === "PersistentVolumeClaim") adding["requests.storage"] = memBytes(obj.spec?.resources?.requests?.storage ?? 0);
  checkQuota(cluster, obj, adding, () => undefined);
}

// ------------------------------------------------------------------ Pod Security

const BASELINE_CAPS = new Set(["AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT"]);
const RESTRICTED_VOLUMES = new Set(["configMap", "csi", "downwardAPI", "emptyDir", "ephemeral", "persistentVolumeClaim", "projected", "secret", "name"]);

function plural(names: string[], noun: string): string {
  return names.length === 1 ? `${noun} "${names[0]}"` : `${noun}s ${names.map((n) => `"${n}"`).join(", ")}`;
}

/** PodSecurity violations of a pod spec for a level. */
export function podSecurityViolations(spec: KObject["spec"], level: string): string[] {
  if (!spec || level === "privileged") return [];
  const out: string[] = [];
  const containers = [...(spec.initContainers ?? []), ...(spec.containers ?? [])] as Record<string, any>[];
  const psc = spec.securityContext ?? {};
  const host = ["hostNetwork", "hostPID", "hostIPC"].filter((k) => spec[k]);
  if (host.length) out.push(`host namespaces (${host.map((k) => `${k}=true`).join(", ")})`);
  const priv = containers.filter((c) => c.securityContext?.privileged).map((c) => c.name);
  if (priv.length) out.push(`privileged (${plural(priv, "container")} must not set securityContext.privileged=true)`);
  const badCaps = containers.flatMap((c) => (c.securityContext?.capabilities?.add ?? []).filter((cap: string) => !BASELINE_CAPS.has(cap.toUpperCase().replace(/^CAP_/, ""))).map((cap: string) => ({ c: c.name, cap })));
  if (badCaps.length && level === "baseline") out.push(`non-default capabilities (${plural([...new Set(badCaps.map((x) => x.c))], "container")} must not include ${badCaps.map((x) => `"${x.cap}"`).join(", ")} in securityContext.capabilities.add)`);
  const hostPath = (spec.volumes ?? []).filter((v: Record<string, unknown>) => v.hostPath).map((v: { name: string }) => v.name);
  if (hostPath.length) out.push(`hostPath volumes (${plural(hostPath, "volume")})`);
  const hostPorts = containers.flatMap((c) => (c.ports ?? []).filter((p: { hostPort?: number }) => p.hostPort).map((p: { hostPort: number }) => ({ c: c.name, p: p.hostPort })));
  if (hostPorts.length) out.push(`hostPort (${plural([...new Set(hostPorts.map((x) => x.c))], "container")} ${hostPorts.length === 1 ? "uses hostPort" : "use hostPorts"} ${hostPorts.map((x) => x.p).join(", ")})`);
  if (level !== "restricted") return out;
  const vols = (spec.volumes ?? []).filter((v: Record<string, unknown>) => Object.keys(v).some((k) => !RESTRICTED_VOLUMES.has(k)));
  if (vols.length) out.push(`restricted volume types (${plural(vols.map((v: { name: string }) => v.name), "volume")} ${vols.length === 1 ? "uses" : "use"} restricted volume type ${[...new Set(vols.map((v: Record<string, unknown>) => `"${Object.keys(v).find((k) => !RESTRICTED_VOLUMES.has(k))}"`))].join(", ")})`);
  const ape = containers.filter((c) => c.securityContext?.allowPrivilegeEscalation !== false).map((c) => c.name);
  if (ape.length) out.push(`allowPrivilegeEscalation != false (${plural(ape, "container")} must set securityContext.allowPrivilegeEscalation=false)`);
  const noDrop = containers.filter((c) => !(c.securityContext?.capabilities?.drop ?? []).some((d: string) => d.toUpperCase() === "ALL")).map((c) => c.name);
  const extraAdd = containers.flatMap((c) => (c.securityContext?.capabilities?.add ?? []).filter((cap: string) => cap.toUpperCase().replace(/^CAP_/, "") !== "NET_BIND_SERVICE").map((cap: string) => ({ c: c.name, cap })));
  if (noDrop.length || extraAdd.length) {
    const parts: string[] = [];
    if (noDrop.length) parts.push(`${plural(noDrop, "container")} must set securityContext.capabilities.drop=["ALL"]`);
    if (extraAdd.length) parts.push(`${plural([...new Set(extraAdd.map((x) => x.c))], "container")} must not include ${extraAdd.map((x) => `"${x.cap}"`).join(", ")} in securityContext.capabilities.add`);
    out.push(`unrestricted capabilities (${parts.join("; ")})`);
  }
  const nonRoot = containers.filter((c) => (c.securityContext?.runAsNonRoot ?? psc.runAsNonRoot) !== true).map((c) => c.name);
  if (nonRoot.length) out.push(`runAsNonRoot != true (${psc.runAsNonRoot === undefined ? `pod or ${plural(nonRoot, "container")}` : plural(nonRoot, "container")} must set securityContext.runAsNonRoot=true)`);
  const root = containers.filter((c) => (c.securityContext?.runAsUser ?? psc.runAsUser) === 0).map((c) => c.name);
  if (root.length) out.push(`runAsUser=0 (${plural(root, "container")} must not set runAsUser=0)`);
  const seccompOk = (sc: Record<string, any> | undefined) => ["RuntimeDefault", "Localhost"].includes(sc?.seccompProfile?.type);
  const noSeccomp = containers.filter((c) => !seccompOk(c.securityContext) && !seccompOk(psc)).map((c) => c.name);
  if (noSeccomp.length) out.push(`seccompProfile (pod or ${plural(noSeccomp, "container")} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")`);
  return out;
}

function psaLevels(cluster: Cluster, ns: string): { enforce?: string; warn?: string } {
  const labels = cluster.get("Namespace", ns)?.metadata.labels ?? {};
  return { enforce: labels["pod-security.kubernetes.io/enforce"], warn: labels["pod-security.kubernetes.io/warn"] };
}

/** Warnings for workload templates in a namespace with pod-security labels. */
export function templateWarnings(cluster: Cluster, obj: KObject): string[] {
  const tplSpec = obj.kind === "CronJob" ? obj.spec?.jobTemplate?.spec?.template?.spec : obj.spec?.template?.spec;
  if (!tplSpec) return [];
  const { warn } = psaLevels(cluster, obj.metadata.namespace ?? "default");
  if (!warn) return [];
  const v = podSecurityViolations(tplSpec, warn);
  return v.length ? [`would violate PodSecurity "${warn}:latest": ${v.join(", ")}`] : [];
}

// ------------------------------------------------------------------ entry point

/**
 * Admit a pod: may change it (LimitRange defaults) and throws AdmissionError
 * when it is rejected. Returns warnings the client should print.
 */
export function admitPod(cluster: Cluster, pod: KObject): string[] {
  const ns = pod.metadata.namespace ?? "default";
  const saName = pod.spec?.serviceAccountName ?? "default";
  if (!cluster.get("ServiceAccount", saName, ns) && saName !== "default") {
    throw new AdmissionError(`pods "${pod.metadata.name}" is forbidden: error looking up service account ${ns}/${saName}: serviceaccount "${saName}" not found`);
  }
  const warnings: string[] = [];
  const { enforce, warn } = psaLevels(cluster, ns);
  if (enforce) {
    const v = podSecurityViolations(pod.spec, enforce);
    if (v.length) throw new AdmissionError(`pods "${pod.metadata.name}" is forbidden: violates PodSecurity "${enforce}:latest": ${v.join(", ")}`);
  }
  if (warn) {
    const v = podSecurityViolations(pod.spec, warn);
    if (v.length) warnings.push(`would violate PodSecurity "${warn}:latest": ${v.join(", ")}`);
  }
  applyLimitRanges(cluster, pod);
  quotaPod(cluster, pod);
  return warnings;
}

/** Controllers create pods through this: on rejection they record FailedCreate instead of failing. */
export function tryAdmitPod(cluster: Cluster, owner: KObject, pod: KObject, t: number, component: string): boolean {
  try {
    admitPod(cluster, pod);
    return true;
  } catch (e) {
    if (e instanceof AdmissionError) {
      const key = `failedcreate/${owner.metadata.uid}`;
      const last = cluster.scratch.get(key) as number | undefined;
      if (last === undefined || t - last >= 30000) {
        cluster.scratch.set(key, t);
        cluster.recordEvent(owner, "Warning", "FailedCreate", `Error creating: ${e.detail}`, { component }, t);
      }
      return false;
    }
    throw e;
  }
}
