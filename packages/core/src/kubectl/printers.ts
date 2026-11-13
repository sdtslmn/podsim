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

/** The STATUS column for pods, following kubectl's printPod logic. */
export function podStatus(pod: KObject): string {
  let reason: string = pod.status?.reason ?? pod.status?.phase ?? "Unknown";
  let hasRunning = false;
  const statuses: { state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number; signal?: number } }; ready?: boolean }[] = pod.status?.containerStatuses ?? [];
  for (let i = statuses.length - 1; i >= 0; i--) {
    const st = statuses[i].state ?? {};
    if (st.waiting?.reason) reason = st.waiting.reason;
    else if (st.terminated?.reason) reason = st.terminated.reason;
    else if (st.terminated) reason = st.terminated.signal ? `Signal:${st.terminated.signal}` : `ExitCode:${st.terminated.exitCode}`;
    else if (statuses[i].ready && "running" in st) hasRunning = true;
  }
  if (reason === "Completed" && hasRunning) reason = "Running";
  if (pod.metadata.deletionTimestamp) reason = "Terminating";
  return reason;
}

function podReady(pod: KObject): string {
  const total = pod.spec?.containers?.length ?? 0;
  const ready = (pod.status?.containerStatuses ?? []).filter((c: { ready?: boolean }) => c.ready).length;
  return `${ready}/${total}`;
}

function podRestarts(cluster: Cluster, pod: KObject): string {
  let restarts = 0;
  let last = 0;
  for (const c of pod.status?.containerStatuses ?? []) {
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
          ((p.status?.accessModes ?? []) as string[]).map((m) => ({ ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" })[m] ?? m).join(","),
          p.spec?.storageClassName ?? "<unset>",
          "<unset>",
          age(cluster, p.metadata.creationTimestamp),
        ],
      };
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
