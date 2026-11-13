// `kubectl describe` output for the main kinds, laid out like the real thing.

import type { Cluster } from "../cluster.js";
import { fromBase64 } from "../cluster.js";
import type { KObject } from "../types.js";
import { formatLabels, humanDuration, parseTime, parseCpu, parseMemory, fnv1a, safeEncode } from "../util.js";
import { deploymentReplicaSets, ownedBy, REVISION } from "../controllers/deployment.js";
import { podRequests } from "../controllers/scheduler.js";
import { endpointsList, podStatus, toYaml } from "./printers.js";

type Line = { indent: number; key?: string; value?: string; raw?: string };

class Writer {
  lines: Line[] = [];
  kv(indent: number, key: string, value: string | number | undefined): void {
    const v = value === undefined || value === "" ? "<none>" : String(value);
    const parts = v.split("\n");
    this.lines.push({ indent, key: key + ":", value: parts[0] });
    // Continuation lines (multi-line values such as labels) align under the value.
    for (const extra of parts.slice(1)) this.lines.push({ indent, key: "", value: extra });
  }
  head(indent: number, text: string): void {
    this.lines.push({ indent, raw: text });
  }
  table(indent: number, headers: string[], rows: string[][]): void {
    const all = [headers, headers.map((h) => "-".repeat(h.length)), ...rows];
    const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
    for (const r of all) {
      const text = r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i] + 2))).join("");
      this.lines.push({ indent, raw: text.trimEnd() });
    }
  }
  render(): string {
    const out: string[] = [];
    let i = 0;
    while (i < this.lines.length) {
      const l = this.lines[i];
      if (l.raw !== undefined) {
        out.push(" ".repeat(l.indent) + l.raw);
        i++;
        continue;
      }
      // Gather a block of consecutive key/value lines and align it.
      let j = i;
      while (j < this.lines.length && this.lines[j].raw === undefined) j++;
      const block = this.lines.slice(i, j);
      const width = Math.max(...block.map((b) => b.indent + (b.key ?? "").length)) + 2;
      for (const b of block) {
        const left = " ".repeat(b.indent) + (b.key ?? "");
        out.push((left.padEnd(width) + (b.value ?? "")).trimEnd());
      }
      i = j;
    }
    return out.join("\n");
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function rfc1123(iso: string | undefined): string {
  if (!iso) return "<unknown>";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function labelsBlock(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "<none>";
  return entries.map(([k, v]) => `${k}=${v}`).join("\n");
}

function annotationsBlock(ann: Record<string, string> | undefined): string {
  const entries = Object.entries(ann ?? {})
    .filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration")
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "<none>";
  return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function eventsSection(cluster: Cluster, w: Writer, obj: KObject): void {
  const events = cluster.eventsFor(obj);
  if (events.length === 0) {
    w.kv(0, "Events", "<none>");
    return;
  }
  w.head(0, "Events:");
  const now = cluster.now();
  const rows = events.map((e) => {
    const last = humanDuration(now - parseTime(e.lastTimestamp as string));
    const count = (e.count as number) ?? 1;
    const ageCol = count > 1 ? `${last} (x${count} over ${humanDuration(now - parseTime(e.firstTimestamp as string))})` : last;
    const src = e.source as { component?: string };
    return [String(e.type), String(e.reason), ageCol, src?.component ?? "", String(e.message)];
  });
  w.table(2, ["Type", "Reason", "Age", "From", "Message"], rows);
}

function tolerationsText(tols: { key?: string; operator?: string; value?: string; effect?: string; tolerationSeconds?: number }[] | undefined): string {
  if (!tols || tols.length === 0) return "<none>";
  return tols
    .map((t) => {
      let s = t.key ?? "";
      if (t.value) s += `=${t.value}`;
      if (t.effect) s += `:${t.effect}`;
      if (t.operator === "Exists" && !t.value) s += " op=Exists";
      if (t.tolerationSeconds !== undefined) s += ` for ${t.tolerationSeconds}s`;
      return s.trim();
    })
    .join("\n");
}

function containerState(state: Record<string, Record<string, unknown>> | undefined, w: Writer, indent: number, label: string): void {
  if (!state || Object.keys(state).length === 0) {
    if (label === "Last State") w.kv(indent, label, "Terminated".length ? "<none>" : "");
    return;
  }
  if (state.running) {
    w.kv(indent, label, "Running");
    w.kv(indent + 2, "Started", rfc1123(state.running.startedAt as string));
  } else if (state.waiting) {
    w.kv(indent, label, "Waiting");
    w.kv(indent + 2, "Reason", String(state.waiting.reason ?? ""));
    if (state.waiting.message && label === "State" && state.waiting.reason !== "ContainerCreating") {
      // kubectl does not print the message for waiting states; keep it short like the real output.
    }
  } else if (state.terminated) {
    w.kv(indent, label, "Terminated");
    w.kv(indent + 2, "Reason", String(state.terminated.reason ?? ""));
    w.kv(indent + 2, "Exit Code", String(state.terminated.exitCode ?? 0));
    w.kv(indent + 2, "Started", rfc1123(state.terminated.startedAt as string));
    w.kv(indent + 2, "Finished", rfc1123(state.terminated.finishedAt as string));
  }
}

function envLines(c: { env?: { name: string; value?: string; valueFrom?: Record<string, { name?: string; key?: string; fieldPath?: string }> }[]; envFrom?: { configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean } }[] }, w: Writer, indent: number): void {
  const envFrom = c.envFrom ?? [];
  if (envFrom.length) {
    w.head(indent, "Environment Variables from:");
    for (const f of envFrom) {
      if (f.configMapRef) w.kv(indent + 2, f.configMapRef.name, `ConfigMap  Optional: ${!!f.configMapRef.optional}`);
      if (f.secretRef) w.kv(indent + 2, f.secretRef.name, `Secret  Optional: ${!!f.secretRef.optional}`);
    }
  }
  const env = c.env ?? [];
  if (env.length === 0) {
    w.kv(indent, "Environment", "<none>");
    return;
  }
  w.head(indent, "Environment:");
  for (const e of env) {
    if (e.value !== undefined) w.kv(indent + 2, e.name, e.value);
    else if (e.valueFrom?.configMapKeyRef) w.kv(indent + 2, e.name, `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: false`);
    else if (e.valueFrom?.secretKeyRef) w.kv(indent + 2, e.name, `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: false`);
    else if (e.valueFrom?.fieldRef) w.kv(indent + 2, e.name, ` (v1:${e.valueFrom.fieldRef.fieldPath})`);
    else w.kv(indent + 2, e.name, "");
  }
}

function apiAccessVolume(pod: KObject): string {
  return `kube-api-access-${safeEncode(fnv1a(pod.metadata.uid ?? pod.metadata.name), 5)}`;
}

function portText(c: { ports?: { containerPort: number; protocol?: string; name?: string }[] }): string {
  const ports = c.ports ?? [];
  if (ports.length === 0) return "<none>";
  return ports.map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`).join(", ");
}

function resourcesBlock(c: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }, w: Writer, indent: number): void {
  for (const section of ["limits", "requests"] as const) {
    const r = c.resources?.[section];
    if (r && Object.keys(r).length) {
      w.head(indent, `${section === "limits" ? "Limits" : "Requests"}:`);
      for (const [k, v] of Object.entries(r)) w.kv(indent + 2, k, v);
    }
  }
}

function mountsBlock(pod: KObject | undefined, c: { volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[] }, w: Writer, indent: number, includeToken: boolean): void {
  const mounts = [...(c.volumeMounts ?? [])].map((m) => `${m.mountPath} from ${m.name} (${m.readOnly ? "ro" : "rw"})`);
  if (includeToken && pod) mounts.push(`/var/run/secrets/kubernetes.io/serviceaccount from ${apiAccessVolume(pod)} (ro)`);
  if (mounts.length === 0) {
    w.kv(indent, "Mounts", "<none>");
    return;
  }
  w.head(indent, "Mounts:");
  for (const m of mounts) w.head(indent + 2, m);
}

function volumesBlock(pod: KObject | undefined, volumes: Record<string, Record<string, unknown>>[], w: Writer, indent: number, includeToken: boolean): void {
  if (volumes.length === 0 && !includeToken) {
    w.kv(indent, "Volumes", "<none>");
    return;
  }
  w.head(indent, "Volumes:");
  for (const v of volumes) {
    w.head(indent + 2, `${v.name}:`);
    if (v.configMap) {
      w.kv(indent + 4, "Type", "ConfigMap (a volume populated by a ConfigMap)");
      w.kv(indent + 4, "Name", String(v.configMap.name));
      w.kv(indent + 4, "Optional", String(!!v.configMap.optional));
    } else if (v.secret) {
      w.kv(indent + 4, "Type", "Secret (a volume populated by a Secret)");
      w.kv(indent + 4, "SecretName", String(v.secret.secretName));
      w.kv(indent + 4, "Optional", String(!!v.secret.optional));
    } else if (v.emptyDir) {
      w.kv(indent + 4, "Type", "EmptyDir (a temporary directory that shares a pod's lifetime)");
      w.kv(indent + 4, "Medium", String(v.emptyDir.medium ?? ""));
      w.kv(indent + 4, "SizeLimit", String(v.emptyDir.sizeLimit ?? "<unset>"));
    } else if (v.persistentVolumeClaim) {
      w.kv(indent + 4, "Type", "PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)");
      w.kv(indent + 4, "ClaimName", String(v.persistentVolumeClaim.claimName));
      w.kv(indent + 4, "ReadOnly", String(!!v.persistentVolumeClaim.readOnly));
    } else if (v.hostPath) {
      w.kv(indent + 4, "Type", "HostPath (bare host directory volume)");
      w.kv(indent + 4, "Path", String(v.hostPath.path));
      w.kv(indent + 4, "HostPathType", String(v.hostPath.type ?? ""));
    } else {
      w.kv(indent + 4, "Type", "Unknown");
    }
  }
  if (includeToken && pod) {
    w.head(indent + 2, `${apiAccessVolume(pod)}:`);
    w.kv(indent + 4, "Type", "Projected (a volume that contains injected data from multiple sources)");
    w.kv(indent + 4, "TokenExpirationSeconds", "3607");
    w.kv(indent + 4, "ConfigMapName", "kube-root-ca.crt");
    w.kv(indent + 4, "Optional", "false");
    w.kv(indent + 4, "DownwardAPI", "true");
  }
}

function describePod(cluster: Cluster, pod: KObject): string {
  const w = new Writer();
  const node = pod.spec?.nodeName ? cluster.get("Node", pod.spec.nodeName) : undefined;
  const nodeIp = node?.status?.addresses?.find((a: { type: string }) => a.type === "InternalIP")?.address;
  w.kv(0, "Name", pod.metadata.name);
  w.kv(0, "Namespace", pod.metadata.namespace);
  w.kv(0, "Priority", String(pod.spec?.priority ?? 0));
  if (pod.spec?.priorityClassName) w.kv(0, "Priority Class Name", pod.spec.priorityClassName);
  w.kv(0, "Service Account", pod.spec?.serviceAccountName ?? "default");
  w.kv(0, "Node", pod.spec?.nodeName ? `${pod.spec.nodeName}/${nodeIp ?? ""}` : "<none>");
  if (pod.status?.startTime) w.kv(0, "Start Time", rfc1123(pod.status.startTime));
  w.kv(0, "Labels", labelsBlock(pod.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(pod.metadata.annotations));
  w.kv(0, "Status", pod.metadata.deletionTimestamp ? "Terminating" : pod.status?.phase ?? "Pending");
  w.kv(0, "IP", pod.status?.podIP ?? "");
  if (pod.status?.podIP) {
    w.head(0, "IPs:");
    w.kv(2, "IP", pod.status.podIP);
  } else w.kv(0, "IPs", "<none>");
  const owner = pod.metadata.ownerReferences?.find((r) => r.controller);
  if (owner) w.kv(0, "Controlled By", `${owner.kind}/${owner.name}`);
  w.head(0, "Containers:");
  const statuses = (pod.status?.containerStatuses ?? []) as Record<string, unknown>[];
  for (const c of pod.spec?.containers ?? []) {
    const st = statuses.find((s) => s.name === c.name) as
      | { containerID?: string; imageID?: string; state?: Record<string, Record<string, unknown>>; lastState?: Record<string, Record<string, unknown>>; ready?: boolean; restartCount?: number }
      | undefined;
    w.head(2, `${c.name}:`);
    if (st?.containerID) w.kv(4, "Container ID", st.containerID);
    w.kv(4, "Image", c.image);
    w.kv(4, "Image ID", st?.imageID || "");
    w.kv(4, "Port", portText(c));
    w.kv(4, "Host Port", (c.ports ?? []).length ? (c.ports ?? []).map((p: { protocol?: string }) => `0/${p.protocol ?? "TCP"}`).join(", ") : "<none>");
    if (c.command) {
      w.head(4, "Command:");
      for (const x of c.command) w.head(6, x);
    }
    if (c.args) {
      w.head(4, "Args:");
      for (const x of c.args) w.head(6, x);
    }
    containerState(st?.state ?? { waiting: { reason: "ContainerCreating" } }, w, 4, "State");
    if (st?.lastState && Object.keys(st.lastState).length) containerState(st.lastState, w, 4, "Last State");
    w.kv(4, "Ready", st?.ready ? "True" : "False");
    w.kv(4, "Restart Count", String(st?.restartCount ?? 0));
    resourcesBlock(c, w, 4);
    envLines(c, w, 4);
    mountsBlock(pod, c, w, 4, true);
  }
  const conds = (pod.status?.conditions ?? []) as { type: string; status: string }[];
  if (conds.length) {
    w.head(0, "Conditions:");
    w.table(2, ["Type", "Status"], conds.map((c) => [c.type, c.status + " "]));
    // The real output has no dashes under these headers.
    const idx = w.lines.length - conds.length - 1;
    w.lines.splice(idx, 1);
  }
  volumesBlock(pod, pod.spec?.volumes ?? [], w, 0, true);
  w.kv(0, "QoS Class", pod.status?.qosClass ?? "BestEffort");
  w.kv(0, "Node-Selectors", pod.spec?.nodeSelector ? formatLabels(pod.spec.nodeSelector).replace(/,/g, "\n") : "<none>");
  w.kv(0, "Tolerations", tolerationsText(pod.spec?.tolerations));
  eventsSection(cluster, w, pod);
  return w.render();
}

function podTemplateBlock(tpl: KObject["spec"], w: Writer): void {
  w.head(0, "Pod Template:");
  w.kv(2, "Labels", labelsBlock(tpl?.metadata?.labels));
  if (tpl?.metadata?.annotations) w.kv(2, "Annotations", annotationsBlock(tpl.metadata.annotations));
  if (tpl?.spec?.serviceAccountName && tpl.spec.serviceAccountName !== "default") w.kv(2, "Service Account", tpl.spec.serviceAccountName);
  w.head(2, "Containers:");
  for (const c of tpl?.spec?.containers ?? []) {
    w.head(3, `${c.name}:`);
    w.kv(4, "Image", c.image);
    w.kv(4, "Port", portText(c));
    w.kv(4, "Host Port", (c.ports ?? []).length ? (c.ports ?? []).map((p: { protocol?: string }) => `0/${p.protocol ?? "TCP"}`).join(", ") : "<none>");
    if (c.command) {
      w.head(4, "Command:");
      for (const x of c.command) w.head(6, x);
    }
    if (c.args) {
      w.head(4, "Args:");
      for (const x of c.args) w.head(6, x);
    }
    resourcesBlock(c, w, 4);
    envLines(c, w, 4);
    mountsBlock(undefined, c, w, 4, false);
  }
  volumesBlock(undefined, tpl?.spec?.volumes ?? [], w, 2, false);
  w.kv(2, "Node-Selectors", tpl?.spec?.nodeSelector ? formatLabels(tpl.spec.nodeSelector) : "<none>");
  const tols = (tpl?.spec?.tolerations ?? []).filter((t: { key?: string }) => !["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"].includes(t.key ?? ""));
  w.kv(2, "Tolerations", tolerationsText(tols));
}

function selectorText(sel: { matchLabels?: Record<string, string> } | undefined): string {
  return Object.entries(sel?.matchLabels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function describeDeployment(cluster: Cluster, d: KObject): string {
  const w = new Writer();
  const desired = d.spec?.replicas ?? 0;
  const st = d.status ?? {};
  w.kv(0, "Name", d.metadata.name);
  w.kv(0, "Namespace", d.metadata.namespace);
  w.kv(0, "CreationTimestamp", rfc1123(d.metadata.creationTimestamp));
  w.kv(0, "Labels", labelsBlock(d.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(d.metadata.annotations));
  w.kv(0, "Selector", selectorText(d.spec?.selector));
  w.kv(
    0,
    "Replicas",
    `${desired} desired | ${st.updatedReplicas ?? 0} updated | ${st.replicas ?? 0} total | ${st.availableReplicas ?? 0} available | ${st.unavailableReplicas ?? Math.max(0, desired - (st.availableReplicas ?? 0))} unavailable`,
  );
  w.kv(0, "StrategyType", d.spec?.strategy?.type ?? "RollingUpdate");
  w.kv(0, "MinReadySeconds", String(d.spec?.minReadySeconds ?? 0));
  if ((d.spec?.strategy?.type ?? "RollingUpdate") === "RollingUpdate") {
    const ru = d.spec?.strategy?.rollingUpdate ?? {};
    w.kv(0, "RollingUpdateStrategy", `${ru.maxUnavailable ?? "25%"} max unavailable, ${ru.maxSurge ?? "25%"} max surge`);
  }
  podTemplateBlock(d.spec?.template, w);
  const conds = (st.conditions ?? []) as { type: string; status: string; reason: string }[];
  if (conds.length) {
    w.head(0, "Conditions:");
    w.table(2, ["Type", "Status", "Reason"], conds.map((c) => [c.type, c.status, c.reason]));
  }
  const rss = deploymentReplicaSets(cluster, d);
  const rev = d.metadata.annotations?.[REVISION];
  const newRS = rss.find((r) => r.metadata.annotations?.[REVISION] === rev);
  const olds = rss.filter((r) => r !== newRS && (r.spec?.replicas ?? 0) > 0);
  const rsText = (r: KObject) => `${r.metadata.name} (${r.status?.replicas ?? 0}/${r.spec?.replicas ?? 0} replicas created)`;
  w.kv(0, "OldReplicaSets", olds.length ? olds.map(rsText).join(", ") : "<none>");
  w.kv(0, "NewReplicaSet", newRS ? rsText(newRS) : "<none>");
  eventsSection(cluster, w, d);
  return w.render();
}

function describeReplicaSet(cluster: Cluster, rs: KObject): string {
  const w = new Writer();
  const pods = cluster.list("Pod", rs.metadata.namespace).filter((p) => ownedBy(p, rs));
  const count = (phase: string) => pods.filter((p) => p.status?.phase === phase).length;
  w.kv(0, "Name", rs.metadata.name);
  w.kv(0, "Namespace", rs.metadata.namespace);
  w.kv(0, "Selector", selectorText(rs.spec?.selector));
  w.kv(0, "Labels", labelsBlock(rs.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(rs.metadata.annotations));
  const owner = rs.metadata.ownerReferences?.find((r) => r.controller);
  if (owner) w.kv(0, "Controlled By", `${owner.kind}/${owner.name}`);
  w.kv(0, "Replicas", `${rs.status?.replicas ?? 0} current / ${rs.spec?.replicas ?? 0} desired`);
  w.kv(0, "Pods Status", `${count("Running")} Running / ${count("Pending")} Waiting / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`);
  podTemplateBlock(rs.spec?.template, w);
  eventsSection(cluster, w, rs);
  return w.render();
}

function describeService(cluster: Cluster, svc: KObject): string {
  const w = new Writer();
  const spec = svc.spec ?? {};
  w.kv(0, "Name", svc.metadata.name);
  w.kv(0, "Namespace", svc.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(svc.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(svc.metadata.annotations));
  w.kv(0, "Selector", spec.selector ? formatLabels(spec.selector) : "<none>");
  w.kv(0, "Type", spec.type ?? "ClusterIP");
  w.kv(0, "IP Family Policy", spec.ipFamilyPolicy ?? "SingleStack");
  w.kv(0, "IP Families", (spec.ipFamilies ?? ["IPv4"]).join(","));
  w.kv(0, "IP", spec.clusterIP ?? "None");
  w.kv(0, "IPs", (spec.clusterIPs ?? [spec.clusterIP]).join(","));
  if (spec.type === "LoadBalancer") w.kv(0, "LoadBalancer Ingress", "");
  const ep = cluster.get("Endpoints", svc.metadata.name, svc.metadata.namespace);
  for (const p of spec.ports ?? []) {
    w.kv(0, "Port", `${p.name ?? "<unset>"}  ${p.port}/${p.protocol ?? "TCP"}`);
    w.kv(0, "TargetPort", `${p.targetPort}/${p.protocol ?? "TCP"}`);
    if (p.nodePort) w.kv(0, "NodePort", `${p.name ?? "<unset>"}  ${p.nodePort}/${p.protocol ?? "TCP"}`);
    w.kv(0, "Endpoints", endpointsList(ep).replace("<none>", ""));
  }
  w.kv(0, "Session Affinity", spec.sessionAffinity ?? "None");
  if (spec.externalTrafficPolicy) w.kv(0, "External Traffic Policy", spec.externalTrafficPolicy);
  w.kv(0, "Internal Traffic Policy", spec.internalTrafficPolicy ?? "Cluster");
  eventsSection(cluster, w, svc);
  return w.render();
}

function describeNode(cluster: Cluster, n: KObject): string {
  const w = new Writer();
  const roles = Object.keys(n.metadata.labels ?? {})
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.split("/")[1]);
  w.kv(0, "Name", n.metadata.name);
  w.kv(0, "Roles", roles.join(",") || "<none>");
  w.kv(0, "Labels", labelsBlock(n.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(n.metadata.annotations));
  w.kv(0, "CreationTimestamp", rfc1123(n.metadata.creationTimestamp));
  const taints = (n.spec?.taints ?? []) as { key: string; value?: string; effect: string }[];
  w.kv(0, "Taints", taints.length ? taints.map((t) => `${t.key}${t.value ? "=" + t.value : ""}:${t.effect}`).join("\n") : "<none>");
  w.kv(0, "Unschedulable", String(!!n.spec?.unschedulable));
  w.head(0, "Conditions:");
  w.table(
    2,
    ["Type", "Status", "LastHeartbeatTime", "LastTransitionTime", "Reason", "Message"],
    ((n.status?.conditions ?? []) as Record<string, string>[]).map((c) => [c.type, c.status, rfc1123(c.lastHeartbeatTime), rfc1123(c.lastTransitionTime), c.reason, c.message]),
  );
  w.head(0, "Addresses:");
  for (const a of n.status?.addresses ?? []) w.kv(2, a.type, a.address);
  for (const [label, key] of [
    ["Capacity", "capacity"],
    ["Allocatable", "allocatable"],
  ]) {
    w.head(0, `${label}:`);
    for (const [k, v] of Object.entries(n.status?.[key] ?? {})) w.kv(2, k, String(v));
  }
  const info = n.status?.nodeInfo ?? {};
  w.head(0, "System Info:");
  w.kv(2, "Kernel Version", info.kernelVersion);
  w.kv(2, "OS Image", info.osImage);
  w.kv(2, "Operating System", info.operatingSystem);
  w.kv(2, "Architecture", info.architecture);
  w.kv(2, "Container Runtime Version", info.containerRuntimeVersion);
  w.kv(2, "Kubelet Version", info.kubeletVersion);
  w.kv(0, "PodCIDR", n.spec?.podCIDR);
  w.kv(0, "PodCIDRs", (n.spec?.podCIDRs ?? []).join(","));
  const pods = cluster.list("Pod").filter((p) => p.spec?.nodeName === n.metadata.name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
  w.head(0, `Non-terminated Pods:          (${pods.length} in total)`);
  const allocCpu = parseCpu(n.status?.allocatable?.cpu);
  const allocMem = parseMemory(n.status?.allocatable?.memory);
  const pct = (v: number, total: number) => (total > 0 ? Math.floor((v / total) * 100) : 0);
  const cpuText = (m: number) => (m === 0 ? "0" : m % 1000 === 0 ? String(m / 1000) : `${m}m`);
  const memText = (b: number) => (b === 0 ? "0" : b % (1024 * 1024) === 0 ? `${b / (1024 * 1024)}Mi` : String(b));
  w.table(
    2,
    ["Namespace", "Name", "CPU Requests", "CPU Limits", "Memory Requests", "Memory Limits", "Age"],
    pods.map((p) => {
      const r = podRequests(p);
      let limCpu = 0;
      let limMem = 0;
      for (const c of p.spec?.containers ?? []) {
        limCpu += parseCpu(c.resources?.limits?.cpu);
        limMem += parseMemory(c.resources?.limits?.memory) || 0;
      }
      return [
        p.metadata.namespace ?? "",
        p.metadata.name,
        `${cpuText(r.cpu)} (${pct(r.cpu, allocCpu)}%)`,
        `${cpuText(limCpu)} (${pct(limCpu, allocCpu)}%)`,
        `${memText(r.memory)} (${pct(r.memory, allocMem)}%)`,
        `${memText(limMem)} (${pct(limMem, allocMem)}%)`,
        humanDuration(cluster.now() - parseTime(p.metadata.creationTimestamp)),
      ];
    }),
  );
  const totals = pods.reduce(
    (acc, p) => {
      const r = podRequests(p);
      return { cpu: acc.cpu + r.cpu, memory: acc.memory + r.memory };
    },
    { cpu: 0, memory: 0 },
  );
  w.head(0, "Allocated resources:");
  w.head(2, "(Total limits may be over 100 percent, i.e., overcommitted.)");
  w.table(
    2,
    ["Resource", "Requests", "Limits"],
    [
      ["cpu", `${cpuText(totals.cpu)} (${pct(totals.cpu, allocCpu)}%)`, "0 (0%)"],
      ["memory", `${memText(totals.memory)} (${pct(totals.memory, allocMem)}%)`, "0 (0%)"],
    ],
  );
  eventsSection(cluster, w, n);
  return w.render();
}

function describeConfigMap(cluster: Cluster, cm: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", cm.metadata.name);
  w.kv(0, "Namespace", cm.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(cm.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(cm.metadata.annotations));
  w.head(0, "");
  w.head(0, "Data");
  w.head(0, "====");
  for (const [k, v] of Object.entries((cm.data as Record<string, string>) ?? {})) {
    w.head(0, `${k}:`);
    w.head(0, "----");
    w.head(0, String(v).replace(/\n$/, ""));
    w.head(0, "");
  }
  w.head(0, "");
  w.head(0, "BinaryData");
  w.head(0, "====");
  w.head(0, "");
  eventsSection(cluster, w, cm);
  return w.render();
}

function describeSecret(cluster: Cluster, s: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", s.metadata.name);
  w.kv(0, "Namespace", s.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(s.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(s.metadata.annotations));
  w.head(0, "");
  w.kv(0, "Type", String(s.type ?? "Opaque"));
  w.head(0, "");
  w.head(0, "Data");
  w.head(0, "====");
  for (const [k, v] of Object.entries((s.data as Record<string, string>) ?? {})) {
    w.kv(0, k, `${new TextEncoder().encode(fromBase64(String(v))).length} bytes`);
  }
  return w.render();
}

function describeNamespace(cluster: Cluster, ns: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", ns.metadata.name);
  w.kv(0, "Labels", labelsBlock(ns.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(ns.metadata.annotations));
  w.kv(0, "Status", ns.status?.phase ?? "Active");
  w.head(0, "");
  w.head(0, "No resource quota.");
  w.head(0, "");
  w.head(0, "No LimitRange resource.");
  return w.render();
}

function describeRole(cluster: Cluster, r: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", r.metadata.name);
  w.kv(0, "Labels", labelsBlock(r.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(r.metadata.annotations));
  w.head(0, "PolicyRule:");
  const rows = ((r.rules as { apiGroups?: string[]; resources?: string[]; resourceNames?: string[]; verbs?: string[]; nonResourceURLs?: string[] }[]) ?? []).flatMap((rule) =>
    (rule.resources ?? rule.nonResourceURLs ?? []).map((res) => {
      const groups = (rule.apiGroups ?? [""]).filter((g) => g !== "");
      const name = groups.length ? `${res}.${groups.join(",")}` : res;
      return [name, rule.nonResourceURLs ? res : "[]", rule.resourceNames?.length ? `[${rule.resourceNames.join(" ")}]` : "[]", `[${(rule.verbs ?? []).join(" ")}]`];
    }),
  );
  w.table(2, ["Resources", "Non-Resource URLs", "Resource Names", "Verbs"], rows);
  return w.render();
}

function describeBinding(cluster: Cluster, b: KObject): string {
  const w = new Writer();
  const ref = b.roleRef as { kind: string; name: string };
  w.kv(0, "Name", b.metadata.name);
  w.kv(0, "Labels", labelsBlock(b.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(b.metadata.annotations));
  w.head(0, "Role:");
  w.kv(2, "Kind", ref?.kind);
  w.kv(2, "Name", ref?.name);
  w.head(0, "Subjects:");
  w.table(
    2,
    ["Kind", "Name", "Namespace"],
    ((b.subjects as { kind: string; name: string; namespace?: string }[]) ?? []).map((s) => [s.kind, s.name, s.namespace ?? ""]),
  );
  return w.render();
}

function describeGeneric(cluster: Cluster, o: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", o.metadata.name);
  if (o.metadata.namespace) w.kv(0, "Namespace", o.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(o.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(o.metadata.annotations));
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!["apiVersion", "kind", "metadata"].includes(k)) body[k] = v;
  for (const line of toYaml(body).trimEnd().split("\n")) w.head(0, line);
  eventsSection(cluster, w, o);
  return w.render();
}

export function describe(cluster: Cluster, obj: KObject): string {
  switch (obj.kind) {
    case "Pod":
      return describePod(cluster, obj);
    case "Deployment":
      return describeDeployment(cluster, obj);
    case "ReplicaSet":
      return describeReplicaSet(cluster, obj);
    case "Service":
      return describeService(cluster, obj);
    case "Node":
      return describeNode(cluster, obj);
    case "ConfigMap":
      return describeConfigMap(cluster, obj);
    case "Secret":
      return describeSecret(cluster, obj);
    case "Namespace":
      return describeNamespace(cluster, obj);
    case "Role":
    case "ClusterRole":
      return describeRole(cluster, obj);
    case "RoleBinding":
    case "ClusterRoleBinding":
      return describeBinding(cluster, obj);
    default:
      return describeGeneric(cluster, obj);
  }
}

export { podStatus };
