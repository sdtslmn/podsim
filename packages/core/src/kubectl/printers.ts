// Table printers that mirror kubectl's default and wide columns per kind,
// plus YAML, JSON, name, jsonpath and custom-columns output.

import { stringify, Scalar } from "yaml";
import type { Cluster } from "../cluster.js";
import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { kindInfo } from "../kinds.js";
import { formatLabels, humanDuration, parseTime, table } from "../util.js";
import { evalPath, renderJsonPath } from "./jsonpath.js";

export interface PrintOptions {
  output?: string;
  wide: boolean;
  showNamespace: boolean;
  showLabels: boolean;
  noHeaders: boolean;
  withKindPrefix: boolean;
}

function age(cluster: Cluster, iso: string | undefined): string {
  if (!iso) return "<unknown>";
  return humanDuration(cluster.now() - parseTime(iso));
}

type CStatus = { name?: string; state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number; signal?: number }; running?: unknown }; ready?: boolean; started?: boolean; restartCount?: number; lastState?: { terminated?: { finishedAt?: string } } };

function isSidecar(pod: KObject, name: string | undefined): boolean {
  return (pod.spec?.initContainers ?? []).some((c: { name: string; restartPolicy?: string }) => c.name === name && c.restartPolicy === "Always");
}

/** The STATUS column for pods, following kubectl's printPod logic. */
export function podStatus(pod: KObject): string {
  let reason: string = pod.status?.reason ?? pod.status?.phase ?? "Unknown";
  const inits: CStatus[] = pod.status?.initContainerStatuses ?? [];
  const initCount = (pod.spec?.initContainers ?? []).length;
  let initializing = false;
  for (let i = 0; i < inits.length; i++) {
    const c = inits[i];
    const st = c.state ?? {};
    if (st.terminated && st.terminated.exitCode === 0) continue;
    if (isSidecar(pod, c.name) && c.started) continue;
    if (st.terminated) {
      reason = st.terminated.reason ? `Init:${st.terminated.reason}` : st.terminated.signal ? `Init:Signal:${st.terminated.signal}` : `Init:ExitCode:${st.terminated.exitCode}`;
    } else if (st.waiting?.reason && st.waiting.reason !== "PodInitializing") reason = `Init:${st.waiting.reason}`;
    else reason = `Init:${i}/${initCount}`;
    initializing = true;
    break;
  }
  const initialized = (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Initialized" && c.status === "True");
  if (!initializing || initialized) {
    let hasRunning = false;
    const statuses: CStatus[] = pod.status?.containerStatuses ?? [];
    for (let i = statuses.length - 1; i >= 0; i--) {
      const st = statuses[i].state ?? {};
      if (st.waiting?.reason) reason = st.waiting.reason;
      else if (st.terminated?.reason) reason = st.terminated.reason;
      else if (st.terminated) reason = st.terminated.signal ? `Signal:${st.terminated.signal}` : `ExitCode:${st.terminated.exitCode}`;
      else if (statuses[i].ready && "running" in st) hasRunning = true;
    }
    if (reason === "Completed" && hasRunning) reason = (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True") ? "Running" : "NotReady";
  }
  if (pod.metadata.deletionTimestamp) reason = "Terminating";
  return reason;
}

function podReady(pod: KObject): string {
  const sidecars = (pod.status?.initContainerStatuses ?? []).filter((c: CStatus) => isSidecar(pod, c.name));
  const total = (pod.spec?.containers?.length ?? 0) + (pod.spec?.initContainers ?? []).filter((c: { restartPolicy?: string }) => c.restartPolicy === "Always").length;
  const ready = (pod.status?.containerStatuses ?? []).filter((c: CStatus) => c.ready).length + sidecars.filter((c: CStatus) => c.ready && c.started).length;
  return `${ready}/${total}`;
}

function podRestarts(cluster: Cluster, pod: KObject): string {
  let restarts = 0;
  let last = 0;
  const initialized = (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Initialized" && c.status === "True");
  const all: CStatus[] = [...(pod.status?.initContainerStatuses ?? []).filter((c: CStatus) => !initialized || isSidecar(pod, c.name)), ...(pod.status?.containerStatuses ?? [])];
  for (const c of all) {
    restarts += c.restartCount ?? 0;
    const fin = parseTime(c.lastState?.terminated?.finishedAt);
    if (fin > last) last = fin;
  }
  if (restarts > 0 && last > 0) return `${restarts} (${humanDuration(cluster.now() - last)} ago)`;
  return String(restarts);
}

function servicePorts(svc: KObject): string {
  const ports = (svc.spec?.ports ?? []) as { port: number; nodePort?: number; protocol?: string }[];
  if (ports.length === 0) return "<none>";
  return ports.map((p) => (p.nodePort ? `${p.port}:${p.nodePort}/${p.protocol ?? "TCP"}` : `${p.port}/${p.protocol ?? "TCP"}`)).join(",");
}

function serviceExternalIp(svc: KObject): string {
  const type = svc.spec?.type;
  if (type === "ExternalName") return svc.spec.externalName ?? "<none>";
  const lb = svc.status?.loadBalancer?.ingress;
  if (type === "LoadBalancer") return lb?.length ? lb.map((x: { ip?: string; hostname?: string }) => x.ip ?? x.hostname).join(",") : "<pending>";
  if (svc.spec?.externalIPs?.length) return svc.spec.externalIPs.join(",");
  return "<none>";
}

export function endpointsList(ep: KObject | undefined): string {
  const subsets = (ep?.subsets ?? []) as { addresses?: { ip: string }[]; ports?: { port: number }[] }[];
  const items: string[] = [];
  for (const s of subsets) {
    for (const a of s.addresses ?? []) {
      if (!s.ports || s.ports.length === 0) items.push(a.ip);
      else for (const p of s.ports) items.push(`${a.ip}:${p.port}`);
    }
  }
  if (items.length === 0) return "<none>";
  if (items.length > 3) return `${items.slice(0, 3).join(",")} + ${items.length - 3} more...`;
  return items.join(",");
}

function selectorString(sel: { matchLabels?: Record<string, string>; matchExpressions?: { key: string; operator: string; values?: string[] }[] } | undefined): string {
  if (!sel) return "<none>";
  const parts = Object.entries(sel.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    const op = e.operator.toLowerCase();
    if (op === "in" || op === "notin") parts.push(`${e.key} ${op} (${(e.values ?? []).join(",")})`);
    else if (op === "exists") parts.push(e.key);
    else parts.push(`!${e.key}`);
  }
  return parts.join(",") || "<none>";
}

function accessModes(modes: string[] | undefined): string {
  return (modes ?? []).map((m) => ({ ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" })[m] ?? m).join(",");
}

export function jobStatus(j: KObject): string {
  for (const c of j.status?.conditions ?? []) {
    if (c.status !== "True") continue;
    if (c.type === "Complete") return "Complete";
    if (c.type === "Failed") return "Failed";
    if (c.type === "Suspended") return "Suspended";
  }
  for (const c of j.status?.conditions ?? []) if (c.status === "True" && c.type === "FailureTarget") return "FailureTarget";
  return "Running";
}

function jobCompletions(j: KObject): string {
  const done = j.status?.succeeded ?? 0;
  if (j.spec?.completions !== undefined && j.spec?.completions !== null) return `${done}/${j.spec.completions}`;
  return `${done}/1 of ${j.spec?.parallelism ?? 1}`;
}

function jobDuration(cluster: Cluster, j: KObject): string {
  const start = parseTime(j.status?.startTime);
  if (!start) return "";
  const end = parseTime(j.status?.completionTime) || cluster.now();
  return humanDuration(end - start);
}

function containersOf(spec: KObject["spec"]): { names: string; images: string } {
  const cs = (spec?.containers ?? []) as { name: string; image: string }[];
  return { names: cs.map((c) => c.name).join(","), images: cs.map((c) => c.image).join(",") };
}

function nodeRoles(node: KObject): string {
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.slice("node-role.kubernetes.io/".length));
  return roles.length ? roles.join(",") : "<none>";
}

function nodeStatus(node: KObject): string {
  const ready = (node.status?.conditions ?? []).find((c: { type: string }) => c.type === "Ready");
  let s = ready?.status === "True" ? "Ready" : "NotReady";
  if (node.spec?.unschedulable) s += ",SchedulingDisabled";
  return s;
}

interface Columns {
  headers: string[];
  wide?: string[];
  row: (o: KObject) => string[];
  wideRow?: (o: KObject) => string[];
}

function columnsFor(cluster: Cluster, kind: string): Columns {
  switch (kind) {
    case "Pod":
      return {
        headers: ["NAME", "READY", "STATUS", "RESTARTS", "AGE"],
        wide: ["IP", "NODE", "NOMINATED NODE", "READINESS GATES"],
        row: (p) => [p.metadata.name, podReady(p), podStatus(p), podRestarts(cluster, p), age(cluster, p.metadata.creationTimestamp)],
        wideRow: (p) => [p.status?.podIP ?? "<none>", p.spec?.nodeName ?? "<none>", "<none>", "<none>"],
      };
    case "Deployment":
      return {
        headers: ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"],
        wide: ["CONTAINERS", "IMAGES", "SELECTOR"],
        row: (d) => [
          d.metadata.name,
          `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
          String(d.status?.updatedReplicas ?? 0),
          String(d.status?.availableReplicas ?? 0),
          age(cluster, d.metadata.creationTimestamp),
        ],
        wideRow: (d) => {
          const c = containersOf(d.spec?.template?.spec);
          return [c.names, c.images, selectorString(d.spec?.selector)];
        },
      };
    case "ReplicaSet":
      return {
        headers: ["NAME", "DESIRED", "CURRENT", "READY", "AGE"],
        wide: ["CONTAINERS", "IMAGES", "SELECTOR"],
        row: (r) => [r.metadata.name, String(r.spec?.replicas ?? 0), String(r.status?.replicas ?? 0), String(r.status?.readyReplicas ?? 0), age(cluster, r.metadata.creationTimestamp)],
        wideRow: (r) => {
          const c = containersOf(r.spec?.template?.spec);
          return [c.names, c.images, selectorString(r.spec?.selector)];
        },
      };
    case "Service":
      return {
        headers: ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"],
        wide: ["SELECTOR"],
        row: (s) => [s.metadata.name, s.spec?.type ?? "ClusterIP", s.spec?.clusterIP ?? "<none>", serviceExternalIp(s), servicePorts(s), age(cluster, s.metadata.creationTimestamp)],
        wideRow: (s) => [s.spec?.selector ? formatLabels(s.spec.selector) : "<none>"],
      };
    case "Endpoints":
      return { headers: ["NAME", "ENDPOINTS", "AGE"], row: (e) => [e.metadata.name, endpointsList(e), age(cluster, e.metadata.creationTimestamp)] };
    case "Node":
      return {
        headers: ["NAME", "STATUS", "ROLES", "AGE", "VERSION"],
        wide: ["INTERNAL-IP", "EXTERNAL-IP", "OS-IMAGE", "KERNEL-VERSION", "CONTAINER-RUNTIME"],
        row: (n) => [n.metadata.name, nodeStatus(n), nodeRoles(n), age(cluster, n.metadata.creationTimestamp), n.status?.nodeInfo?.kubeletVersion ?? ""],
        wideRow: (n) => [
          (n.status?.addresses ?? []).find((a: { type: string }) => a.type === "InternalIP")?.address ?? "<none>",
          "<none>",
          n.status?.nodeInfo?.osImage ?? "",
          n.status?.nodeInfo?.kernelVersion ?? "",
          n.status?.nodeInfo?.containerRuntimeVersion ?? "",
        ],
      };
    case "Namespace":
      return { headers: ["NAME", "STATUS", "AGE"], row: (n) => [n.metadata.name, n.status?.phase ?? "Active", age(cluster, n.metadata.creationTimestamp)] };
    case "ConfigMap":
      return { headers: ["NAME", "DATA", "AGE"], row: (c) => [c.metadata.name, String(Object.keys({ ...((c.data as object) ?? {}), ...((c.binaryData as object) ?? {}) }).length), age(cluster, c.metadata.creationTimestamp)] };
    case "Secret":
      return { headers: ["NAME", "TYPE", "DATA", "AGE"], row: (s) => [s.metadata.name, String(s.type ?? "Opaque"), String(Object.keys((s.data as object) ?? {}).length), age(cluster, s.metadata.creationTimestamp)] };
    case "ServiceAccount":
      return { headers: ["NAME", "SECRETS", "AGE"], row: (s) => [s.metadata.name, String(((s.secrets as unknown[]) ?? []).length), age(cluster, s.metadata.creationTimestamp)] };
    case "Event":
      return {
        headers: ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"],
        row: (e) => {
          const io = e.involvedObject as { kind: string; name: string };
          return [age(cluster, e.lastTimestamp as string), String(e.type), String(e.reason), `${io.kind.toLowerCase()}/${io.name}`, String(e.message)];
        },
      };
    case "Role":
    case "ClusterRole":
      return { headers: ["NAME", "CREATED AT"], row: (r) => [r.metadata.name, r.metadata.creationTimestamp ?? ""] };
    case "RoleBinding":
    case "ClusterRoleBinding":
      return {
        headers: ["NAME", "ROLE", "AGE"],
        row: (b) => {
          const ref = b.roleRef as { kind?: string; name?: string } | undefined;
          return [b.metadata.name, ref ? `${ref.kind}/${ref.name}` : "<none>", age(cluster, b.metadata.creationTimestamp)];
        },
      };
    case "NetworkPolicy":
      return {
        headers: ["NAME", "POD-SELECTOR", "AGE"],
        row: (n) => [n.metadata.name, n.spec?.podSelector ? selectorString(n.spec.podSelector).replace("<none>", "<none>") : "<none>", age(cluster, n.metadata.creationTimestamp)],
      };
    case "Ingress":
      return {
        headers: ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"],
        row: (i) => [
          i.metadata.name,
          i.spec?.ingressClassName ?? "<none>",
          ((i.spec?.rules ?? []) as { host?: string }[]).map((r) => r.host ?? "*").join(",") || "*",
          "",
          i.spec?.tls ? "80, 443" : "80",
          age(cluster, i.metadata.creationTimestamp),
        ],
      };
    case "PersistentVolumeClaim":
      return {
        headers: ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE"],
        row: (p) => [
          p.metadata.name,
          p.status?.phase ?? "Pending",
          p.spec?.volumeName ?? "",
          p.status?.capacity?.storage ?? "",
          accessModes(p.status?.accessModes),
          p.spec?.storageClassName ?? "<unset>",
          "<unset>",
          age(cluster, p.metadata.creationTimestamp),
        ],
      };
    case "Job":
      return {
        headers: ["NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE"],
        wide: ["CONTAINERS", "IMAGES", "SELECTOR"],
        row: (j) => [j.metadata.name, jobStatus(j), jobCompletions(j), jobDuration(cluster, j), age(cluster, j.metadata.creationTimestamp)],
        wideRow: (j) => {
          const c = containersOf(j.spec?.template?.spec);
          return [c.names, c.images, selectorString(j.spec?.selector)];
        },
      };
    case "CronJob":
      return {
        headers: ["NAME", "SCHEDULE", "TIMEZONE", "SUSPEND", "ACTIVE", "LAST SCHEDULE", "AGE"],
        wide: ["CONTAINERS", "IMAGES", "SELECTOR"],
        row: (c) => [
          c.metadata.name,
          String(c.spec?.schedule ?? ""),
          c.spec?.timeZone ?? "<none>",
          c.spec?.suspend ? "True" : "False",
          String((c.status?.active ?? []).length),
          c.status?.lastScheduleTime ? age(cluster, c.status.lastScheduleTime) : "<none>",
          age(cluster, c.metadata.creationTimestamp),
        ],
        wideRow: (c) => {
          const k = containersOf(c.spec?.jobTemplate?.spec?.template?.spec);
          return [k.names, k.images, selectorString(c.spec?.jobTemplate?.spec?.selector)];
        },
      };
    case "DaemonSet":
      return {
        headers: ["NAME", "DESIRED", "CURRENT", "READY", "UP-TO-DATE", "AVAILABLE", "NODE SELECTOR", "AGE"],
        wide: ["CONTAINERS", "IMAGES", "SELECTOR"],
        row: (d) => [
          d.metadata.name,
          String(d.status?.desiredNumberScheduled ?? 0),
          String(d.status?.currentNumberScheduled ?? 0),
          String(d.status?.numberReady ?? 0),
          String(d.status?.updatedNumberScheduled ?? 0),
          String(d.status?.numberAvailable ?? 0),
          d.spec?.template?.spec?.nodeSelector ? formatLabels(d.spec.template.spec.nodeSelector) : "<none>",
          age(cluster, d.metadata.creationTimestamp),
        ],
        wideRow: (d) => {
          const c = containersOf(d.spec?.template?.spec);
          return [c.names, c.images, selectorString(d.spec?.selector)];
        },
      };
    case "StatefulSet":
      return {
        headers: ["NAME", "READY", "AGE"],
        wide: ["CONTAINERS", "IMAGES"],
        row: (s) => [s.metadata.name, `${s.status?.readyReplicas ?? 0}/${s.spec?.replicas ?? 0}`, age(cluster, s.metadata.creationTimestamp)],
        wideRow: (s) => {
          const c = containersOf(s.spec?.template?.spec);
          return [c.names, c.images];
        },
      };
    case "PersistentVolume":
      return {
        headers: ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "REASON", "AGE"],
        wide: ["VOLUMEMODE"],
        row: (v) => [
          v.metadata.name,
          v.spec?.capacity?.storage ?? "",
          accessModes(v.spec?.accessModes),
          v.spec?.persistentVolumeReclaimPolicy ?? "Retain",
          v.status?.phase ?? "Pending",
          v.spec?.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : "",
          v.spec?.storageClassName ?? "",
          "<unset>",
          v.status?.reason ?? "",
          age(cluster, v.metadata.creationTimestamp),
        ],
        wideRow: (v) => [v.spec?.volumeMode ?? "Filesystem"],
      };
    case "StorageClass":
      return {
        headers: ["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE", "ALLOWVOLUMEEXPANSION", "AGE"],
        row: (c) => [
          c.metadata.name + (c.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? " (default)" : ""),
          String(c.provisioner ?? ""),
          String(c.reclaimPolicy ?? "Delete"),
          String(c.volumeBindingMode ?? "Immediate"),
          c.allowVolumeExpansion ? "true" : "false",
          age(cluster, c.metadata.creationTimestamp),
        ],
      };
    case "HorizontalPodAutoscaler":
      return {
        headers: ["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"],
        row: (h) => {
          const ref = h.spec?.scaleTargetRef ?? {};
          const metric = (h.spec?.metrics ?? [])[0]?.resource;
          const cur = (h.status?.currentMetrics ?? [])[0]?.resource?.current?.averageUtilization;
          const targets = metric ? `${metric.name}: ${cur === undefined ? "<unknown>" : cur + "%"}/${metric.target?.averageUtilization ?? "?"}%` : "<none>";
          return [h.metadata.name, `${ref.kind}/${ref.name}`, targets, String(h.spec?.minReplicas ?? 1), String(h.spec?.maxReplicas ?? ""), String(h.status?.currentReplicas ?? 0), age(cluster, h.metadata.creationTimestamp)];
        },
      };
    case "ResourceQuota":
      return {
        headers: ["NAME", "AGE", "REQUEST", "LIMIT"],
        row: (q) => {
          const hard = (q.status?.hard ?? q.spec?.hard ?? {}) as Record<string, string>;
          const used = (q.status?.used ?? {}) as Record<string, string>;
          const fmt = (keys: string[]) => keys.map((k) => `${k}: ${used[k] ?? "0"}/${hard[k]}`).join(", ");
          const limits = Object.keys(hard).filter((k) => k.startsWith("limits."));
          const requests = Object.keys(hard).filter((k) => !k.startsWith("limits.")).sort();
          return [q.metadata.name, age(cluster, q.metadata.creationTimestamp), fmt(requests), fmt(limits)];
        },
      };
    case "LimitRange":
    case "CustomResourceDefinition":
      return { headers: ["NAME", "CREATED AT"], row: (r) => [r.metadata.name, r.metadata.creationTimestamp ?? ""] };
    case "IngressClass":
      return { headers: ["NAME", "CONTROLLER", "PARAMETERS", "AGE"], row: (c) => [c.metadata.name, c.spec?.controller ?? "", c.spec?.parameters ? `${c.spec.parameters.kind}/${c.spec.parameters.name}` : "<none>", age(cluster, c.metadata.creationTimestamp)] };
    case "PodDisruptionBudget":
      return {
        headers: ["NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED DISRUPTIONS", "AGE"],
        row: (d) => [d.metadata.name, d.spec?.minAvailable !== undefined ? String(d.spec.minAvailable) : "N/A", d.spec?.maxUnavailable !== undefined ? String(d.spec.maxUnavailable) : "N/A", String(d.status?.disruptionsAllowed ?? 0), age(cluster, d.metadata.creationTimestamp)],
      };
    case "PriorityClass":
      return { headers: ["NAME", "VALUE", "GLOBAL-DEFAULT", "AGE", "PREEMPTIONPOLICY"], row: (c) => [c.metadata.name, String(c.value ?? 0), c.globalDefault ? "true" : "false", age(cluster, c.metadata.creationTimestamp), String(c.preemptionPolicy ?? "PreemptLowerPriority")] };
    default:
      return { headers: ["NAME", "AGE"], row: (o) => [o.metadata.name, age(cluster, o.metadata.creationTimestamp)] };
  }
}

export function kindPrefix(kind: string): string {
  const info = kindInfo(kind);
  const group = info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : "";
  return `${info.singular}${group}`;
}

/** Print a homogeneous list of objects of one kind as a table. */
export function printTable(cluster: Cluster, kind: string, objects: KObject[], opts: PrintOptions): string {
  const cols = columnsFor(cluster, kind);
  const headers = [...cols.headers];
  if (opts.wide && cols.wide) headers.push(...cols.wide);
  if (opts.showLabels) headers.push("LABELS");
  if (opts.showNamespace) headers.unshift("NAMESPACE");
  const rows = objects.map((o) => {
    const r = cols.row(o);
    if (opts.withKindPrefix) r[kind === "Event" ? 3 : 0] = kind === "Event" ? r[3] : `${kindPrefix(kind)}/${r[0]}`;
    if (opts.wide && cols.wideRow) r.push(...cols.wideRow(o));
    if (opts.showLabels) r.push(formatLabels(o.metadata.labels));
    if (opts.showNamespace) r.unshift(o.metadata.namespace ?? "");
    return r;
  });
  const text = table(headers, rows);
  if (opts.noHeaders) return text.split("\n").slice(1).join("\n");
  return text;
}

/** Strip runtime-only noise the real API never returns. */
export function cleanForOutput(obj: KObject): KObject {
  const o = JSON.parse(JSON.stringify(obj)) as KObject;
  if (o.metadata) {
    if (o.metadata.generateName === undefined) delete o.metadata.generateName;
  }
  return o;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** kubectl quotes timestamps in YAML output; the yaml library would not. */
function quoteTimestamps(value: unknown): unknown {
  if (typeof value === "string" && ISO_TIME.test(value)) {
    const s = new Scalar(value);
    s.type = Scalar.QUOTE_DOUBLE;
    return s;
  }
  if (Array.isArray(value)) return value.map(quoteTimestamps);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = quoteTimestamps(v);
    return out;
  }
  return value;
}

export function toYaml(value: unknown): string {
  return stringify(quoteTimestamps(value), { sortMapEntries: true, indentSeq: false, lineWidth: 0, nullStr: "null" });
}

export function toList(items: KObject[]): Record<string, unknown> {
  return { apiVersion: "v1", items: items.map(cleanForOutput), kind: "List", metadata: { resourceVersion: "" } };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 4);
}

/** Render objects for -o yaml|json|name|jsonpath|custom-columns. Returns undefined for table output. */
export function renderStructured(objects: KObject[], output: string, single: boolean, noHeaders = false): string | undefined {
  const data = single && objects.length === 1 ? cleanForOutput(objects[0]) : toList(objects);
  if (output === "yaml") return toYaml(data).trimEnd();
  if (output === "json") return toJson(data);
  if (output === "name") return objects.map((o) => `${kindPrefix(o.kind)}/${o.metadata.name}`).join("\n");
  if (output.startsWith("jsonpath=") || output.startsWith("jsonpath-as-json=")) {
    const tpl = output.slice(output.indexOf("=") + 1);
    return renderJsonPath(tpl, data);
  }
  if (output.startsWith("custom-columns=")) {
    const spec = output.slice("custom-columns=".length);
    const cols = spec.split(",").map((c) => {
      const idx = c.indexOf(":");
      if (idx < 0) throw new KubeError(`error: expected <header>:<json-path-expr>, got ${c}`);
      return { header: c.slice(0, idx), path: c.slice(idx + 1) };
    });
    const rows = objects.map((o) =>
      cols.map((c) => {
        const vals = evalPath(o, c.path.replace(/^\{|\}$/g, ""));
        if (vals.length === 0) return "<none>";
        return vals.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(",");
      }),
    );
    const t = table(
      cols.map((c) => c.header),
      rows,
    );
    return noHeaders ? t.split("\n").slice(1).join("\n") : t;
  }
  if (output === "wide" || output === "") return undefined;
  throw new KubeError(
    `error: unable to match a printer suitable for the output format "${output}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`,
  );
}
