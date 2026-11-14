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

function probeText(p: Record<string, any>): string {
  const timing = `delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
  if (p.exec) return `exec [${(p.exec.command ?? []).join(" ")}] ${timing}`;
  if (p.httpGet) return `http-get ${(p.httpGet.scheme ?? "HTTP").toLowerCase()}://${p.httpGet.host ?? ""}:${p.httpGet.port}${p.httpGet.path ?? "/"} ${timing}`;
  if (p.tcpSocket) return `tcp-socket :${p.tcpSocket.port} ${timing}`;
  if (p.grpc) return `grpc <pod>:${p.grpc.port} ${p.grpc.service ?? ""} ${timing}`;
  return timing;
}

function containerBlock(pod: KObject, c: Record<string, any>, statuses: Record<string, unknown>[], w: Writer, waitingDefault: string): void {
  const st = statuses.find((s) => s.name === c.name) as
    | { containerID?: string; imageID?: string; state?: Record<string, Record<string, unknown>>; lastState?: Record<string, Record<string, unknown>>; ready?: boolean; restartCount?: number; started?: boolean }
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
  containerState(st?.state ?? { waiting: { reason: waitingDefault } }, w, 4, "State");
  if (st?.lastState && Object.keys(st.lastState).length) containerState(st.lastState, w, 4, "Last State");
  w.kv(4, "Ready", st?.ready ? "True" : "False");
  w.kv(4, "Restart Count", String(st?.restartCount ?? 0));
  if (c.restartPolicy) w.kv(4, "Restart Policy", c.restartPolicy);
  resourcesBlock(c, w, 4);
  if (c.livenessProbe) w.kv(4, "Liveness", probeText(c.livenessProbe));
  if (c.readinessProbe) w.kv(4, "Readiness", probeText(c.readinessProbe));
  if (c.startupProbe) w.kv(4, "Startup", probeText(c.startupProbe));
  envLines(c, w, 4);
  mountsBlock(pod, c, w, 4, true);
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
  const inits = (pod.spec?.initContainers ?? []) as Record<string, any>[];
  if (inits.length) {
    w.head(0, "Init Containers:");
    for (const c of inits) containerBlock(pod, c, (pod.status?.initContainerStatuses ?? []) as Record<string, unknown>[], w, "PodInitializing");
  }
  w.head(0, "Containers:");
  for (const c of pod.spec?.containers ?? []) containerBlock(pod, c, (pod.status?.containerStatuses ?? []) as Record<string, unknown>[], w, "ContainerCreating");
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

function podsStatusLine(pods: KObject[]): string {
  const count = (phase: string) => pods.filter((p) => p.status?.phase === phase).length;
  return `${count("Running")} Active (${pods.filter((p) => p.status?.phase === "Running" && (p.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True")).length} Ready) / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`;
}

function describeJob(cluster: Cluster, j: KObject): string {
  const w = new Writer();
  const pods = cluster.list("Pod", j.metadata.namespace).filter((p) => ownedBy(p, j));
  w.kv(0, "Name", j.metadata.name);
  w.kv(0, "Namespace", j.metadata.namespace);
  w.kv(0, "Selector", selectorText(j.spec?.selector));
  w.kv(0, "Labels", labelsBlock(j.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(j.metadata.annotations));
  const owner = j.metadata.ownerReferences?.find((r) => r.controller);
  if (owner) w.kv(0, "Controlled By", `${owner.kind}/${owner.name}`);
  w.kv(0, "Parallelism", String(j.spec?.parallelism ?? 1));
  w.kv(0, "Completions", j.spec?.completions === undefined ? "<unset>" : String(j.spec.completions));
  w.kv(0, "Completion Mode", j.spec?.completionMode ?? "NonIndexed");
  w.kv(0, "Suspend", j.spec?.suspend ? "true" : "false");
  w.kv(0, "Backoff Limit", String(j.spec?.backoffLimit ?? 6));
  if (j.spec?.activeDeadlineSeconds !== undefined) w.kv(0, "Active Deadline Seconds", `${j.spec.activeDeadlineSeconds}s`);
  if (j.spec?.ttlSecondsAfterFinished !== undefined) w.kv(0, "TTL Seconds After Finished", String(j.spec.ttlSecondsAfterFinished));
  if (j.status?.startTime) w.kv(0, "Start Time", rfc1123(j.status.startTime));
  if (j.status?.completionTime) {
    w.kv(0, "Completed At", rfc1123(j.status.completionTime));
    w.kv(0, "Duration", humanDuration(Date.parse(j.status.completionTime) - Date.parse(j.status.startTime)));
  }
  w.kv(0, "Pods Statuses", `${j.status?.active ?? 0} Active (${j.status?.ready ?? 0} Ready) / ${j.status?.succeeded ?? 0} Succeeded / ${j.status?.failed ?? 0} Failed`);
  void pods;
  podTemplateBlock(j.spec?.template, w);
  eventsSection(cluster, w, j);
  return w.render();
}

function describeCronJob(cluster: Cluster, c: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", c.metadata.name);
  w.kv(0, "Namespace", c.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(c.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(c.metadata.annotations));
  w.kv(0, "Schedule", String(c.spec?.schedule ?? ""));
  w.kv(0, "Concurrency Policy", c.spec?.concurrencyPolicy ?? "Allow");
  w.kv(0, "Suspend", c.spec?.suspend ? "True" : "False");
  w.kv(0, "Successful Job History Limit", String(c.spec?.successfulJobsHistoryLimit ?? 3));
  w.kv(0, "Failed Job History Limit", String(c.spec?.failedJobsHistoryLimit ?? 1));
  w.kv(0, "Starting Deadline Seconds", c.spec?.startingDeadlineSeconds !== undefined ? `${c.spec.startingDeadlineSeconds}s` : "<unset>");
  const js = c.spec?.jobTemplate?.spec ?? {};
  w.kv(0, "Selector", js.selector ? selectorText(js.selector) : "<unset>");
  w.kv(0, "Parallelism", js.parallelism === undefined ? "<unset>" : String(js.parallelism));
  w.kv(0, "Completions", js.completions === undefined ? "<unset>" : String(js.completions));
  if (js.activeDeadlineSeconds !== undefined) w.kv(0, "Active Deadline Seconds", `${js.activeDeadlineSeconds}s`);
  podTemplateBlock(js.template, w);
  w.kv(0, "Last Schedule Time", c.status?.lastScheduleTime ? rfc1123(c.status.lastScheduleTime) : "<unset>");
  const active = (c.status?.active ?? []) as { name: string }[];
  w.kv(0, "Active Jobs", active.length ? active.map((a) => a.name).join(", ") : "<none>");
  eventsSection(cluster, w, c);
  return w.render();
}

function describeDaemonSet(cluster: Cluster, d: KObject): string {
  const w = new Writer();
  const pods = cluster.list("Pod", d.metadata.namespace).filter((p) => ownedBy(p, d));
  const st = d.status ?? {};
  w.kv(0, "Name", d.metadata.name);
  w.kv(0, "Namespace", d.metadata.namespace);
  w.kv(0, "Selector", selectorText(d.spec?.selector));
  w.kv(0, "Node-Selector", d.spec?.template?.spec?.nodeSelector ? formatLabels(d.spec.template.spec.nodeSelector) : "<none>");
  w.kv(0, "Labels", labelsBlock(d.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock({ "deprecated.daemonset.template.generation": String(d.metadata.generation ?? 1), ...(d.metadata.annotations ?? {}) }));
  w.kv(0, "Desired Number of Nodes Scheduled", String(st.desiredNumberScheduled ?? 0));
  w.kv(0, "Current Number of Nodes Scheduled", String(st.currentNumberScheduled ?? 0));
  w.kv(0, "Number of Nodes Scheduled with Up-to-date Pods", String(st.updatedNumberScheduled ?? 0));
  w.kv(0, "Number of Nodes Scheduled with Available Pods", String(st.numberAvailable ?? 0));
  w.kv(0, "Number of Nodes Misscheduled", String(st.numberMisscheduled ?? 0));
  const count = (phase: string) => pods.filter((p) => p.status?.phase === phase).length;
  w.kv(0, "Pods Status", `${count("Running")} Running / ${count("Pending")} Waiting / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`);
  podTemplateBlock(d.spec?.template, w);
  eventsSection(cluster, w, d);
  return w.render();
}

function describeStatefulSet(cluster: Cluster, s: KObject): string {
  const w = new Writer();
  const pods = cluster.list("Pod", s.metadata.namespace).filter((p) => ownedBy(p, s));
  w.kv(0, "Name", s.metadata.name);
  w.kv(0, "Namespace", s.metadata.namespace);
  w.kv(0, "CreationTimestamp", rfc1123(s.metadata.creationTimestamp));
  w.kv(0, "Selector", selectorText(s.spec?.selector));
  w.kv(0, "Labels", labelsBlock(s.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(s.metadata.annotations));
  w.kv(0, "Replicas", `${s.spec?.replicas ?? 1} desired | ${s.status?.replicas ?? 0} total`);
  w.kv(0, "Update Strategy", s.spec?.updateStrategy?.type ?? "RollingUpdate");
  if ((s.spec?.updateStrategy?.type ?? "RollingUpdate") === "RollingUpdate") w.kv(2, "Partition", String(s.spec?.updateStrategy?.rollingUpdate?.partition ?? 0));
  const count = (phase: string) => pods.filter((p) => p.status?.phase === phase).length;
  w.kv(0, "Pods Status", `${count("Running")} Running / ${count("Pending")} Waiting / ${count("Succeeded")} Succeeded / ${count("Failed")} Failed`);
  podTemplateBlock(s.spec?.template, w);
  const vcts = (s.spec?.volumeClaimTemplates ?? []) as KObject[];
  if (vcts.length) {
    w.head(0, "Volume Claims:");
    for (const v of vcts) {
      w.kv(2, "Name", v.metadata?.name);
      w.kv(2, "StorageClass", v.spec?.storageClassName ?? "");
      w.kv(2, "Labels", labelsBlock(v.metadata?.labels));
      w.kv(2, "Annotations", annotationsBlock(v.metadata?.annotations));
      w.kv(2, "Capacity", v.spec?.resources?.requests?.storage ?? "");
      w.kv(2, "Access Modes", (v.spec?.accessModes ?? []).join(","));
    }
  } else w.kv(0, "Volume Claims", "<none>");
  eventsSection(cluster, w, s);
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

function quotaBlock(w: Writer, q: KObject, indent: number): void {
  const hard = (q.status?.hard ?? q.spec?.hard ?? {}) as Record<string, string>;
  const used = (q.status?.used ?? {}) as Record<string, string>;
  w.table(indent, ["Resource", "Used", "Hard"], Object.keys(hard).sort().map((k) => [k, used[k] ?? "0", hard[k]]));
}

function limitRangeRows(lr: KObject): string[][] {
  const rows: string[][] = [];
  for (const item of (lr.spec?.limits ?? []) as Record<string, any>[]) {
    const resources = new Set<string>(["max", "min", "default", "defaultRequest", "maxLimitRequestRatio"].flatMap((k) => Object.keys(item[k] ?? {})));
    for (const r of [...resources].sort()) {
      rows.push([item.type, r, item.min?.[r] ?? "-", item.max?.[r] ?? "-", item.defaultRequest?.[r] ?? "-", item.default?.[r] ?? "-", item.maxLimitRequestRatio?.[r] !== undefined ? String(item.maxLimitRequestRatio[r]) : "-"]);
    }
  }
  return rows;
}

const LR_HEADERS = ["Type", "Resource", "Min", "Max", "Default Request", "Default Limit", "Max Limit/Request Ratio"];

function describeNamespace(cluster: Cluster, ns: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", ns.metadata.name);
  w.kv(0, "Labels", labelsBlock(ns.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(ns.metadata.annotations));
  w.kv(0, "Status", ns.status?.phase ?? "Active");
  w.head(0, "");
  const quotas = cluster.list("ResourceQuota", ns.metadata.name);
  if (!quotas.length) w.head(0, "No resource quota.");
  for (const q of quotas) {
    w.head(0, "Resource Quotas");
    w.kv(2, "Name", q.metadata.name);
    quotaBlock(w, q, 2);
  }
  w.head(0, "");
  const lrs = cluster.list("LimitRange", ns.metadata.name);
  if (!lrs.length) w.head(0, "No LimitRange resource.");
  for (const lr of lrs) {
    w.head(0, "Resource Limits");
    w.table(1, LR_HEADERS, limitRangeRows(lr));
  }
  return w.render();
}

function describeQuota(cluster: Cluster, q: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", q.metadata.name);
  w.kv(0, "Namespace", q.metadata.namespace);
  if (q.spec?.scopes) w.kv(0, "Scopes", (q.spec.scopes as string[]).join(", "));
  quotaBlock(w, q, 0);
  return w.render();
}

function describeLimitRange(cluster: Cluster, lr: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", lr.metadata.name);
  w.kv(0, "Namespace", lr.metadata.namespace);
  w.table(0, LR_HEADERS, limitRangeRows(lr));
  return w.render();
}

function describeServiceAccount(cluster: Cluster, sa: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", sa.metadata.name);
  w.kv(0, "Namespace", sa.metadata.namespace);
  w.kv(0, "Labels", labelsBlock(sa.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(sa.metadata.annotations));
  const pulls = ((sa.imagePullSecrets as { name: string }[]) ?? []).map((x) => x.name);
  w.kv(0, "Image pull secrets", pulls.length ? pulls.join(", ") : "<none>");
  const secrets = ((sa.secrets as { name: string }[]) ?? []).map((x) => x.name);
  w.kv(0, "Mountable secrets", secrets.length ? secrets.join(", ") : "<none>");
  w.kv(0, "Tokens", "<none>");
  eventsSection(cluster, w, sa);
  return w.render();
}

const MODE_SHORT: Record<string, string> = { ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" };

function describePVC(cluster: Cluster, c: KObject): string {
  const w = new Writer();
  const users = cluster.list("Pod", c.metadata.namespace).filter((p) => (p.spec?.volumes ?? []).some((v: { persistentVolumeClaim?: { claimName: string } }) => v.persistentVolumeClaim?.claimName === c.metadata.name)).map((p) => p.metadata.name);
  w.kv(0, "Name", c.metadata.name);
  w.kv(0, "Namespace", c.metadata.namespace);
  w.kv(0, "StorageClass", c.spec?.storageClassName ?? "");
  w.kv(0, "Status", c.status?.phase ?? "Pending");
  w.kv(0, "Volume", c.spec?.volumeName ?? "");
  w.kv(0, "Labels", labelsBlock(c.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(c.metadata.annotations));
  w.kv(0, "Finalizers", "[kubernetes.io/pvc-protection]");
  w.kv(0, "Capacity", c.status?.capacity?.storage ?? "");
  w.kv(0, "Access Modes", ((c.status?.accessModes ?? []) as string[]).map((m) => MODE_SHORT[m] ?? m).join(","));
  w.kv(0, "VolumeMode", c.spec?.volumeMode ?? "Filesystem");
  w.kv(0, "Used By", users.length ? users.join("\n") : "<none>");
  eventsSection(cluster, w, c);
  return w.render();
}

function describePV(cluster: Cluster, v: KObject): string {
  const w = new Writer();
  w.kv(0, "Name", v.metadata.name);
  w.kv(0, "Labels", labelsBlock(v.metadata.labels));
  w.kv(0, "Annotations", annotationsBlock(v.metadata.annotations));
  w.kv(0, "Finalizers", "[kubernetes.io/pv-protection]");
  w.kv(0, "StorageClass", v.spec?.storageClassName ?? "");
  w.kv(0, "Status", v.status?.phase ?? "Available");
  w.kv(0, "Claim", v.spec?.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : "");
  w.kv(0, "Reclaim Policy", v.spec?.persistentVolumeReclaimPolicy ?? "Retain");
  w.kv(0, "Access Modes", ((v.spec?.accessModes ?? []) as string[]).map((m) => MODE_SHORT[m] ?? m).join(","));
  w.kv(0, "VolumeMode", v.spec?.volumeMode ?? "Filesystem");
  w.kv(0, "Capacity", v.spec?.capacity?.storage ?? "");
  w.kv(0, "Node Affinity", "<none>");
  w.kv(0, "Message", "");
  w.head(0, "Source:");
  if (v.spec?.hostPath) {
    w.kv(4, "Type", "HostPath (bare host directory volume)");
    w.kv(4, "Path", v.spec.hostPath.path);
    w.kv(4, "HostPathType", v.spec.hostPath.type ?? "");
  } else if (v.spec?.nfs) {
    w.kv(4, "Type", "NFS (an NFS mount that lasts the lifetime of a pod)");
    w.kv(4, "Server", v.spec.nfs.server);
    w.kv(4, "Path", v.spec.nfs.path);
  } else w.kv(4, "Type", "<unknown>");
  eventsSection(cluster, w, v);
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
    case "ResourceQuota":
      return describeQuota(cluster, obj);
    case "LimitRange":
      return describeLimitRange(cluster, obj);
    case "ServiceAccount":
      return describeServiceAccount(cluster, obj);
    case "PersistentVolumeClaim":
      return describePVC(cluster, obj);
    case "PersistentVolume":
      return describePV(cluster, obj);
    case "Job":
      return describeJob(cluster, obj);
    case "CronJob":
      return describeCronJob(cluster, obj);
    case "DaemonSet":
      return describeDaemonSet(cluster, obj);
    case "StatefulSet":
      return describeStatefulSet(cluster, obj);
    default:
      return describeGeneric(cluster, obj);
  }
}

export { podStatus };
