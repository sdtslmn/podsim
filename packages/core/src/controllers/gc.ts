// Garbage collector: delete objects whose controlling owner is gone,
// the way background cascading deletion works in a real cluster.

import type { Cluster } from "../cluster.js";

const OWNED_KINDS = ["ReplicaSet", "Pod"];

export function garbageCollect(cluster: Cluster): void {
  const uids = new Set<string>();
  for (const kind of ["Deployment", "ReplicaSet", "Service", "Node"]) {
    for (const o of cluster.list(kind)) if (o.metadata.uid) uids.add(o.metadata.uid);
  }
  for (const kind of OWNED_KINDS) {
    for (const o of cluster.list(kind)) {
      const owner = o.metadata.ownerReferences?.find((r) => r.controller);
      if (owner && !uids.has(owner.uid)) cluster.remove(kind, o.metadata.name, o.metadata.namespace);
    }
  }
}
