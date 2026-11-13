// Endpoints controller: one Endpoints object per Service with a selector,
// listing ready pod IPs and resolving named target ports.

import type { Cluster } from "../cluster.js";
import type { KObject } from "../types.js";
import { isoTime, matchMap, stableStringify } from "../util.js";
import { isPodReady } from "./deployment.js";

function resolveTargetPort(pod: KObject, target: number | string): number | undefined {
  if (typeof target === "number") return target;
  if (/^\d+$/.test(target)) return parseInt(target, 10);
  for (const c of pod.spec?.containers ?? []) {
    for (const p of c.ports ?? []) if (p.name === target) return p.containerPort;
  }
  return undefined;
}

export function reconcileEndpoints(cluster: Cluster): void {
  for (const svc of cluster.list("Service")) {
    const selector = svc.spec?.selector;
    if (!selector || Object.keys(selector).length === 0) continue;
    const ns = svc.metadata.namespace!;
    const pods = cluster
      .list("Pod", ns)
      .filter((p) => matchMap(p.metadata.labels, selector) && p.status?.podIP && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
    const ports = (svc.spec.ports ?? []) as { name?: string; port: number; targetPort: number | string; protocol: string }[];

    const subsets: { addresses?: unknown[]; notReadyAddresses?: unknown[]; ports: unknown[] }[] = [];
    // Group by resolved port set (named ports can resolve differently per pod).
    const groups = new Map<string, { ready: KObject[]; notReady: KObject[]; ports: unknown[] }>();
    for (const pod of pods) {
      const resolved = ports
        .map((p) => {
          const port = resolveTargetPort(pod, p.targetPort);
          return port === undefined ? undefined : { ...(p.name ? { name: p.name } : {}), port, protocol: p.protocol };
        })
        .filter(Boolean);
      if (resolved.length === 0) continue;
      const key = JSON.stringify(resolved);
      const g = groups.get(key) ?? { ready: [], notReady: [], ports: resolved };
      (isPodReady(pod) ? g.ready : g.notReady).push(pod);
      groups.set(key, g);
    }
    const addr = (p: KObject) => ({
      ip: p.status.podIP,
      nodeName: p.spec.nodeName,
      targetRef: { kind: "Pod", name: p.metadata.name, namespace: ns, uid: p.metadata.uid },
    });
    for (const g of groups.values()) {
      const subset: { addresses?: unknown[]; notReadyAddresses?: unknown[]; ports: unknown[] } = { ports: g.ports };
      if (g.ready.length) subset.addresses = g.ready.map(addr);
      if (g.notReady.length) subset.notReadyAddresses = g.notReady.map(addr);
      subsets.push(subset);
    }

    const existing = cluster.get("Endpoints", svc.metadata.name, ns);
    const ep: KObject = existing ?? {
      apiVersion: "v1",
      kind: "Endpoints",
      metadata: {
        name: svc.metadata.name,
        namespace: ns,
        uid: cluster.random.uid(),
        creationTimestamp: isoTime(cluster.now()),
        labels: { ...(svc.metadata.labels ?? {}) },
      },
    };
    const next = subsets.length ? subsets : undefined;
    if (!existing || stableStringify(existing.subsets) !== stableStringify(next)) {
      if (next) ep.subsets = next;
      else delete ep.subsets;
      cluster.put(ep);
    }
  }
}
