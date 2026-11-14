// ReplicaSet controller: keeps the number of owned pods equal to spec.replicas.

import type { Cluster } from "../cluster.js";
import { defaultPodSpec } from "../cluster.js";
import type { KObject } from "../types.js";
import { deepClone, isoTime, matchLabelSelector, stableStringify } from "../util.js";
import { isPodReady, ownedBy } from "./deployment.js";
import { tryAdmitPod } from "../admission.js";

function isActive(pod: KObject): boolean {
  return pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed" && !pod.metadata.deletionTimestamp;
}

/** Deletion order the real controller uses: unscheduled, then not ready, then newest first. */
function deletionRank(pod: KObject): number {
  if (!pod.spec?.nodeName) return 0;
  if (pod.status?.phase === "Pending") return 1;
  if (!isPodReady(pod)) return 2;
  return 3;
}

export function reconcileReplicaSets(cluster: Cluster, t: number): void {
  for (const rs of cluster.list("ReplicaSet")) {
    const ns = rs.metadata.namespace!;
    const desired: number = rs.spec.replicas ?? 1;
    // Adopt orphan pods that match the selector, like the real controller.
    for (const p of cluster.list("Pod", ns)) {
      if (!p.metadata.ownerReferences?.some((r) => r.controller) && isActive(p) && matchLabelSelector(p.metadata.labels, rs.spec.selector)) {
        p.metadata.ownerReferences = [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: rs.metadata.name, uid: rs.metadata.uid!, controller: true, blockOwnerDeletion: true }];
        cluster.put(p);
      }
    }
    const pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, rs) && isActive(p));
    const diff = desired - pods.length;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        const tpl = deepClone(rs.spec.template);
        const name = `${rs.metadata.name}-${cluster.random.suffix(5)}`;
        const spec = tpl.spec;
        defaultPodSpec(spec);
        const pod: KObject = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            generateName: `${rs.metadata.name}-`,
            namespace: ns,
            uid: cluster.random.uid(),
            creationTimestamp: isoTime(t),
            generation: 1,
            labels: { ...(tpl.metadata?.labels ?? {}) },
            ...(tpl.metadata?.annotations ? { annotations: tpl.metadata.annotations } : {}),
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: rs.metadata.name, uid: rs.metadata.uid!, controller: true, blockOwnerDeletion: true }],
          },
          spec,
          status: { phase: "Pending", qosClass: "BestEffort" },
        };
        if (!tryAdmitPod(cluster, rs, pod, t, "replicaset-controller")) break;
        cluster.put(pod);
        cluster.recordEvent(rs, "Normal", "SuccessfulCreate", `Created pod: ${name}`, { component: "replicaset-controller" }, t);
      }
    } else if (diff < 0) {
      const victims = [...pods]
        .sort((a, b) => deletionRank(a) - deletionRank(b) || String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)))
        .slice(0, -diff);
      for (const p of victims) {
        cluster.remove("Pod", p.metadata.name, ns);
        cluster.recordEvent(rs, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, { component: "replicaset-controller" }, t);
      }
    }
    const current = cluster.list("Pod", ns).filter((p) => ownedBy(p, rs) && isActive(p));
    const ready = current.filter(isPodReady).length;
    const status: Record<string, unknown> = {
      replicas: current.length,
      fullyLabeledReplicas: current.length || undefined,
      readyReplicas: ready || undefined,
      availableReplicas: ready || undefined,
      observedGeneration: rs.metadata.generation,
    };
    for (const k of Object.keys(status)) if (status[k] === undefined) delete status[k];
    if (stableStringify(status) !== stableStringify(rs.status)) {
      rs.status = status;
      cluster.put(rs);
    }
  }
}
