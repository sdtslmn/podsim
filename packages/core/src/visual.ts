// A read-only view of the cluster for the visualizer: nodes with their Pods,
// Services with their endpoints, Ingress routes and what NetworkPolicies
// select. The web front end draws it; nothing here changes the cluster.

import type { Cluster } from "./cluster.js";
import type { KObject } from "./types.js";
import { matchLabelSelector, matchMap, parseCpu, parseMemory } from "./util.js";
import { podStatus } from "./kubectl/printers.js";

export type PodState = "running" | "notready" | "pending" | "failed" | "done" | "terminating";

export interface PodView {
  uid: string;
  name: string;
  ns: string;
  node?: string;
  status: string;
  state: PodState;
  ready: string;
  restarts: number;
  ip?: string;
  owner?: { kind: string; name: string };
  labels: Record<string, string>;
  images: string[];
  /** Selected by a NetworkPolicy that restricts ingress or egress. */
  ingressPolicy: boolean;
  egressPolicy: boolean;
}

export interface NodeView {
  name: string;
  roles: string[];
  ready: boolean;
  unschedulable: boolean;
  taints: string[];
  labels: string[];
  cpuPercent: number;
  memoryPercent: number;
}

export interface ServiceView {
  uid: string;
  name: string;
  ns: string;
  type: string;
  clusterIP?: string;
  ports: string[];
  nodePorts: number[];
  selector: Record<string, string>;
  /** Pods the selector matches that are ready (in the endpoints) and that are not. */
  ready: string[];
  notReady: string[];
  externalName?: string;
}

export interface IngressRoute {
  host: string;
  path: string;
  service: string;
  port: string;
}

export interface IngressView {
  uid: string;
  name: string;
  ns: string;
  className?: string;
  routes: IngressRoute[];
}

export interface PolicyView {
  uid: string;
  name: string;
  ns: string;
  types: string[];
  pods: string[];
  rules: string[];
}

export interface ClusterView {
  namespaces: string[];
  nodes: NodeView[];
  pods: PodView[];
  services: ServiceView[];
  ingresses: IngressView[];
  policies: PolicyView[];
}

export const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease", "ingress-nginx"];

function stateOf(pod: KObject, status: string): PodState {
  if (pod.metadata.deletionTimestamp || status === "Terminating") return "terminating";
  if (status === "Completed" || status === "Succeeded") return "done";
  if (status === "Running") {
    const all = (pod.status?.containerStatuses ?? []) as { ready?: boolean }[];
    return all.length && all.every((c) => c.ready) ? "running" : "notready";
  }
  if (status === "NotReady") return "notready";
  if (status === "Pending" || status === "ContainerCreating" || status === "PodInitializing" || /^Init:\d+\/\d+$/.test(status)) return "pending";
  return "failed";
}

function ownerOf(cluster: Cluster, pod: KObject): { kind: string; name: string } | undefined {
  const ref = (pod.metadata.ownerReferences ?? [])[0] as { kind: string; name: string } | undefined;
  if (!ref) return undefined;
  if (ref.kind === "ReplicaSet") {
    const rs = cluster.get("ReplicaSet", ref.name, pod.metadata.namespace);
    const dep = (rs?.metadata.ownerReferences ?? [])[0] as { kind: string; name: string } | undefined;
    if (dep?.kind === "Deployment") return { kind: "Deployment", name: dep.name };
  }
  if (ref.kind === "Job") {
    const job = cluster.get("Job", ref.name, pod.metadata.namespace);
    const cj = (job?.metadata.ownerReferences ?? [])[0] as { kind: string; name: string } | undefined;
    if (cj?.kind === "CronJob") return { kind: "CronJob", name: cj.name };
  }
  return { kind: ref.kind, name: ref.name };
}

function peerText(p: Record<string, unknown>): string {
  const sel = (s: unknown) => {
    const m = (s as { matchLabels?: Record<string, string> } | undefined)?.matchLabels ?? {};
    const e = Object.entries(m).map(([k, v]) => `${k}=${v}`);
    return e.length ? e.join(",") : "all";
  };
  if (p.ipBlock) return `IPs ${(p.ipBlock as { cidr: string }).cidr}`;
  const parts: string[] = [];
  if (p.namespaceSelector) parts.push(`namespaces ${sel(p.namespaceSelector)}`);
  if (p.podSelector) parts.push(`pods ${sel(p.podSelector)}`);
  return parts.join(" + ") || "anywhere";
}

function portsText(ports: unknown): string {
  const list = (ports as { port?: number | string; protocol?: string }[] | undefined) ?? [];
  if (!list.length) return "all ports";
  return list.map((p) => `${p.port ?? "*"}/${p.protocol ?? "TCP"}`).join(", ");
}

function policyRules(np: KObject, types: string[]): string[] {
  const out: string[] = [];
  if (types.includes("Ingress")) {
    const rules = (np.spec?.ingress ?? []) as Record<string, unknown>[];
    if (!rules.length) out.push("Ingress: deny all");
    for (const r of rules) out.push(`Ingress from ${((r.from as Record<string, unknown>[]) ?? []).map(peerText).join(" or ") || "anywhere"} on ${portsText(r.ports)}`);
  }
  if (types.includes("Egress")) {
    const rules = (np.spec?.egress ?? []) as Record<string, unknown>[];
    if (!rules.length) out.push("Egress: deny all");
    for (const r of rules) out.push(`Egress to ${((r.to as Record<string, unknown>[]) ?? []).map(peerText).join(" or ") || "anywhere"} on ${portsText(r.ports)}`);
  }
  return out;
}

function sumRequests(pods: KObject[], res: "cpu" | "memory"): number {
  let total = 0;
  for (const p of pods) {
    for (const c of (p.spec?.containers ?? []) as { resources?: { requests?: Record<string, string> } }[]) {
      const r = c.resources?.requests?.[res];
      if (r) total += res === "cpu" ? parseCpu(r) : parseMemory(r);
    }
  }
  return total;
}

/**
 * Build the view. With a namespace, Pods, Services, Ingresses and policies
 * are limited to it; nodes are always all shown.
 */
export function clusterView(cluster: Cluster, opts: { namespace?: string; system?: boolean } = {}): ClusterView {
  cluster.activate();
  const inScope = (ns: string | undefined) => (opts.namespace ? (ns ?? "default") === opts.namespace : opts.system || !SYSTEM_NAMESPACES.includes(ns ?? "default"));
  const allPods = cluster.list("Pod");
  const pods = allPods.filter((p) => inScope(p.metadata.namespace));
  const policies = cluster.list("NetworkPolicy").filter((np) => inScope(np.metadata.namespace));
  const policyViews: PolicyView[] = policies.map((np) => {
    const types: string[] = np.spec?.policyTypes ?? ["Ingress", ...(np.spec?.egress ? ["Egress"] : [])];
    const selected = pods.filter((p) => (p.metadata.namespace ?? "default") === (np.metadata.namespace ?? "default") && (Object.keys(np.spec?.podSelector ?? {}).length === 0 || Object.keys(np.spec?.podSelector?.matchLabels ?? {}).length + (np.spec?.podSelector?.matchExpressions ?? []).length === 0 || matchLabelSelector(p.metadata.labels, np.spec.podSelector)));
    return { uid: np.metadata.uid!, name: np.metadata.name, ns: np.metadata.namespace ?? "default", types, pods: selected.map((p) => p.metadata.uid!), rules: policyRules(np, types) };
  });
  const podViews: PodView[] = pods.map((p) => {
    const status = podStatus(p);
    const uid = p.metadata.uid!;
    return {
      uid,
      name: p.metadata.name,
      ns: p.metadata.namespace ?? "default",
      node: p.spec?.nodeName,
      status,
      state: stateOf(p, status),
      ready: `${((p.status?.containerStatuses ?? []) as { ready?: boolean }[]).filter((c) => c.ready).length}/${(p.spec?.containers ?? []).length}`,
      restarts: ((p.status?.containerStatuses ?? []) as { restartCount?: number }[]).reduce((n, c) => n + (c.restartCount ?? 0), 0),
      ip: p.status?.podIP,
      owner: ownerOf(cluster, p),
      labels: { ...(p.metadata.labels ?? {}) },
      images: ((p.spec?.containers ?? []) as { image: string }[]).map((c) => c.image),
      ingressPolicy: policyViews.some((v) => v.types.includes("Ingress") && v.pods.includes(uid)),
      egressPolicy: policyViews.some((v) => v.types.includes("Egress") && v.pods.includes(uid)),
    };
  });
  const nodes: NodeView[] = cluster.list("Node").map((n) => {
    const labels = n.metadata.labels ?? {};
    const onNode = allPods.filter((p) => p.spec?.nodeName === n.metadata.name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
    const cpu = parseCpu(n.status?.allocatable?.cpu ?? "2");
    const mem = parseMemory(n.status?.allocatable?.memory ?? "4Gi");
    return {
      name: n.metadata.name,
      roles: Object.keys(labels).filter((k) => k.startsWith("node-role.kubernetes.io/")).map((k) => k.split("/")[1]),
      ready: ((n.status?.conditions ?? []) as { type: string; status: string }[]).some((c) => c.type === "Ready" && c.status === "True"),
      unschedulable: !!n.spec?.unschedulable,
      taints: ((n.spec?.taints ?? []) as { key: string; value?: string; effect: string }[]).filter((t) => t.key !== "node.kubernetes.io/unschedulable").map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`),
      labels: Object.entries(labels)
        .filter(([k]) => !k.startsWith("kubernetes.io/") && !k.startsWith("node-role.") && !k.startsWith("beta.kubernetes.io/") && !k.startsWith("node.kubernetes.io/"))
        .map(([k, v]) => `${k}=${v}`),
      cpuPercent: Math.round((sumRequests(onNode, "cpu") / cpu) * 100),
      memoryPercent: Math.round((sumRequests(onNode, "memory") / mem) * 100),
    };
  });
  const services: ServiceView[] = cluster
    .list("Service")
    .filter((s) => inScope(s.metadata.namespace) && !(s.metadata.name === "kubernetes" && s.metadata.namespace === "default" && !opts.system))
    .map((s) => {
      const sel = (s.spec?.selector ?? {}) as Record<string, string>;
      const matched = podViews.filter((p) => p.ns === (s.metadata.namespace ?? "default") && matchMap(p.labels, sel));
      return {
        uid: s.metadata.uid!,
        name: s.metadata.name,
        ns: s.metadata.namespace ?? "default",
        type: s.spec?.type ?? "ClusterIP",
        clusterIP: s.spec?.clusterIP,
        ports: ((s.spec?.ports ?? []) as { port: number; targetPort?: number | string; nodePort?: number; protocol?: string }[]).map((p) => `${p.port}${p.targetPort !== undefined && String(p.targetPort) !== String(p.port) ? `→${p.targetPort}` : ""}${p.nodePort ? ` (node ${p.nodePort})` : ""}`),
        nodePorts: ((s.spec?.ports ?? []) as { nodePort?: number }[]).map((p) => p.nodePort).filter((n): n is number => !!n),
        selector: sel,
        ready: matched.filter((p) => p.state === "running").map((p) => p.uid),
        notReady: matched.filter((p) => p.state !== "running" && p.state !== "done").map((p) => p.uid),
        externalName: s.spec?.externalName,
      };
    });
  const ingresses: IngressView[] = cluster
    .list("Ingress")
    .filter((i) => inScope(i.metadata.namespace))
    .map((i) => {
      const routes: IngressRoute[] = [];
      const backend = (b: { service?: { name: string; port?: { number?: number; name?: string } } } | undefined) => ({ service: b?.service?.name ?? "", port: String(b?.service?.port?.number ?? b?.service?.port?.name ?? "") });
      for (const r of (i.spec?.rules ?? []) as { host?: string; http?: { paths?: { path?: string; backend: unknown }[] } }[]) {
        for (const p of r.http?.paths ?? []) routes.push({ host: r.host ?? "*", path: p.path ?? "/", ...backend(p.backend as never) });
      }
      if (i.spec?.defaultBackend) routes.push({ host: "*", path: "(default)", ...backend(i.spec.defaultBackend) });
      return { uid: i.metadata.uid!, name: i.metadata.name, ns: i.metadata.namespace ?? "default", className: i.spec?.ingressClassName, routes };
    });
  return {
    namespaces: cluster.list("Namespace").map((n) => n.metadata.name).sort(),
    nodes,
    pods: podViews,
    services,
    ingresses,
    policies: policyViews,
  };
}
