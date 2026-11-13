// A simplified kube-scheduler: filters nodes the way the real one does
// (unschedulable, taints, node selector and affinity, resources) and
// produces the same style of FailedScheduling message.

import type { Cluster } from "../cluster.js";
import type { KObject } from "../types.js";
import { parseCpu, parseMemory, isoTime } from "../util.js";
import type { PodSim } from "./index.js";

interface Taint {
  key: string;
  value?: string;
  effect: string;
}
interface Toleration {
  key?: string;
  operator?: string;
  value?: string;
  effect?: string;
}

export function tolerates(tolerations: Toleration[] | undefined, taint: Taint): boolean {
  return (tolerations ?? []).some((tol) => {
    if (tol.effect && tol.effect !== taint.effect) return false;
    if (tol.operator === "Exists") return !tol.key || tol.key === taint.key;
    return tol.key === taint.key && (tol.value ?? "") === (taint.value ?? "");
  });
}

function matchNodeSelectorTerm(labels: Record<string, string>, term: { matchExpressions?: { key: string; operator: string; values?: string[] }[] }): boolean {
  return (term.matchExpressions ?? []).every((e) => {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const v = labels[e.key];
    switch (e.operator) {
      case "In":
        return has && (e.values ?? []).includes(v);
      case "NotIn":
        return !has || !(e.values ?? []).includes(v);
      case "Exists":
        return has;
      case "DoesNotExist":
        return !has;
      case "Gt":
        return has && Number(v) > Number(e.values?.[0]);
      case "Lt":
        return has && Number(v) < Number(e.values?.[0]);
      default:
        return false;
    }
  });
}

export function podRequests(pod: KObject): { cpu: number; memory: number } {
  let cpu = 0;
  let memory = 0;
  for (const c of pod.spec?.containers ?? []) {
    cpu += parseCpu(c.resources?.requests?.cpu ?? c.resources?.limits?.cpu);
    memory += parseMemory(c.resources?.requests?.memory ?? c.resources?.limits?.memory) || 0;
  }
  return { cpu, memory };
}

function isActive(pod: KObject): boolean {
  return pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed";
}

function sim(cluster: Cluster, pod: KObject): PodSim {
  const uid = pod.metadata.uid!;
  let s = cluster.podSims.get(uid);
  if (!s) {
    s = { containers: {} };
    cluster.podSims.set(uid, s);
  }
  return s;
}

/** Return the node name for the pod, or a reason string explaining why none fits. */
export function findNode(cluster: Cluster, pod: KObject): { node?: string; message?: string } {
  const nodes = cluster.list("Node");
  const pods = cluster.list("Pod").filter((p) => p.spec?.nodeName && isActive(p));
  const reasons = new Map<string, number>();
  const add = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);
  const req = podRequests(pod);
  const candidates: { name: string; count: number }[] = [];

  // Volume claims are checked before any node.
  for (const v of pod.spec?.volumes ?? []) {
    const claim = v.persistentVolumeClaim?.claimName;
    if (!claim) continue;
    const pvc = cluster.get("PersistentVolumeClaim", claim, pod.metadata.namespace);
    if (!pvc) return { message: `0/${nodes.length} nodes are available: persistentvolumeclaim "${claim}" not found. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.` };
    if (pvc.status?.phase !== "Bound") return { message: `0/${nodes.length} nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.` };
  }

  for (const node of nodes) {
    const labels = node.metadata.labels ?? {};
    if (node.spec?.unschedulable) {
      add("node(s) were unschedulable");
      continue;
    }
    const ready = (node.status?.conditions ?? []).find((c: { type: string }) => c.type === "Ready");
    if (ready?.status !== "True") {
      add("node(s) had untolerated taint {node.kubernetes.io/not-ready: }");
      continue;
    }
    const blocking = ((node.spec?.taints ?? []) as Taint[]).find(
      (taint) => (taint.effect === "NoSchedule" || taint.effect === "NoExecute") && !tolerates(pod.spec?.tolerations, taint),
    );
    if (blocking) {
      add(`node(s) had untolerated taint {${blocking.key}: ${blocking.value ?? ""}}`);
      continue;
    }
    const sel = pod.spec?.nodeSelector ?? {};
    const selOk = Object.entries(sel).every(([k, v]) => labels[k] === v);
    const terms = pod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
    const affOk = !terms || terms.some((term: { matchExpressions?: { key: string; operator: string; values?: string[] }[] }) => matchNodeSelectorTerm(labels, term));
    if (!selOk || !affOk) {
      add("node(s) didn't match Pod's node affinity/selector");
      continue;
    }
    const onNode = pods.filter((p) => p.spec.nodeName === node.metadata.name && p.metadata.uid !== pod.metadata.uid);
    const used = onNode.reduce(
      (acc, p) => {
        const r = podRequests(p);
        return { cpu: acc.cpu + r.cpu, memory: acc.memory + r.memory };
      },
      { cpu: 0, memory: 0 },
    );
    const alloc = node.status?.allocatable ?? {};
    if (onNode.length + 1 > Number(alloc.pods ?? 110)) {
      add("Too many pods");
      continue;
    }
    if (req.cpu > 0 && used.cpu + req.cpu > parseCpu(alloc.cpu)) {
      add("Insufficient cpu");
      continue;
    }
    if (req.memory > 0 && used.memory + req.memory > parseMemory(alloc.memory)) {
      add("Insufficient memory");
      continue;
    }
    candidates.push({ name: node.metadata.name, count: onNode.length });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
    return { node: candidates[0].name };
  }
  const parts = [...reasons.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${n} ${r}`);
  const preemptNote = `preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.`;
  return { message: `0/${nodes.length} nodes are available: ${parts.join(", ")}. ${preemptNote}` };
}

export function schedulePods(cluster: Cluster, t: number): void {
  for (const pod of cluster.list("Pod")) {
    if (pod.spec?.nodeName || !isActive(pod) || pod.metadata.deletionTimestamp) continue;
    const s = sim(cluster, pod);
    const result = findNode(cluster, pod);
    const conditions = (pod.status.conditions ?? []).filter((c: { type: string }) => c.type !== "PodScheduled");
    if (result.node) {
      pod.spec.nodeName = result.node;
      s.scheduledAt = t;
      pod.status.conditions = [...conditions, { type: "PodScheduled", status: "True", lastProbeTime: null, lastTransitionTime: isoTime(t) }];
      cluster.recordEvent(pod, "Normal", "Scheduled", `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${result.node}`, { component: "default-scheduler" }, t);
      cluster.put(pod);
    } else {
      const message = result.message!;
      const changed = s.lastScheduleFailure?.message !== message;
      if (changed || t - (s.lastScheduleFailure?.at ?? 0) > 60000) {
        s.lastScheduleFailure = { message, at: t };
        pod.status.conditions = [
          ...conditions,
          { type: "PodScheduled", status: "False", reason: "Unschedulable", message, lastProbeTime: null, lastTransitionTime: isoTime(t) },
        ];
        cluster.recordEvent(pod, "Warning", "FailedScheduling", message, { component: "default-scheduler" }, t);
        cluster.put(pod);
      }
    }
  }
}
