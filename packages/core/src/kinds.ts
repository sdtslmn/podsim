// Registry of the resource types the simulator knows about.

export interface KindInfo {
  kind: string;
  plural: string;
  singular: string;
  shortNames: string[];
  apiVersion: string;
  namespaced: boolean;
  /** Stored and shown, but no controller acts on it yet. */
  storageOnly?: boolean;
}

export const KINDS: KindInfo[] = [
  { kind: "Pod", plural: "pods", singular: "pod", shortNames: ["po"], apiVersion: "v1", namespaced: true },
  { kind: "Deployment", plural: "deployments", singular: "deployment", shortNames: ["deploy"], apiVersion: "apps/v1", namespaced: true },
  { kind: "ReplicaSet", plural: "replicasets", singular: "replicaset", shortNames: ["rs"], apiVersion: "apps/v1", namespaced: true },
  { kind: "Service", plural: "services", singular: "service", shortNames: ["svc"], apiVersion: "v1", namespaced: true },
  { kind: "Endpoints", plural: "endpoints", singular: "endpoints", shortNames: ["ep"], apiVersion: "v1", namespaced: true },
  { kind: "ConfigMap", plural: "configmaps", singular: "configmap", shortNames: ["cm"], apiVersion: "v1", namespaced: true },
  { kind: "Secret", plural: "secrets", singular: "secret", shortNames: [], apiVersion: "v1", namespaced: true },
  { kind: "ServiceAccount", plural: "serviceaccounts", singular: "serviceaccount", shortNames: ["sa"], apiVersion: "v1", namespaced: true },
  { kind: "Event", plural: "events", singular: "event", shortNames: ["ev"], apiVersion: "v1", namespaced: true },
  { kind: "Namespace", plural: "namespaces", singular: "namespace", shortNames: ["ns"], apiVersion: "v1", namespaced: false },
  { kind: "Node", plural: "nodes", singular: "node", shortNames: ["no"], apiVersion: "v1", namespaced: false },
  { kind: "Role", plural: "roles", singular: "role", shortNames: [], apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true, storageOnly: true },
  { kind: "RoleBinding", plural: "rolebindings", singular: "rolebinding", shortNames: [], apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true, storageOnly: true },
  { kind: "ClusterRole", plural: "clusterroles", singular: "clusterrole", shortNames: [], apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false, storageOnly: true },
  { kind: "ClusterRoleBinding", plural: "clusterrolebindings", singular: "clusterrolebinding", shortNames: [], apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false, storageOnly: true },
  { kind: "NetworkPolicy", plural: "networkpolicies", singular: "networkpolicy", shortNames: ["netpol"], apiVersion: "networking.k8s.io/v1", namespaced: true, storageOnly: true },
  { kind: "Ingress", plural: "ingresses", singular: "ingress", shortNames: ["ing"], apiVersion: "networking.k8s.io/v1", namespaced: true, storageOnly: true },
  { kind: "PersistentVolumeClaim", plural: "persistentvolumeclaims", singular: "persistentvolumeclaim", shortNames: ["pvc"], apiVersion: "v1", namespaced: true },
];

/** Kinds learners will ask for that are planned but not simulated yet. */
export const PLANNED_KINDS: Record<string, string> = {
  jobs: "Job",
  job: "Job",
  cronjobs: "CronJob",
  cronjob: "CronJob",
  cj: "CronJob",
  daemonsets: "DaemonSet",
  daemonset: "DaemonSet",
  ds: "DaemonSet",
  statefulsets: "StatefulSet",
  statefulset: "StatefulSet",
  sts: "StatefulSet",
  persistentvolumes: "PersistentVolume",
  pv: "PersistentVolume",
  storageclasses: "StorageClass",
  sc: "StorageClass",
  horizontalpodautoscalers: "HorizontalPodAutoscaler",
  hpa: "HorizontalPodAutoscaler",
};

const byName = new Map<string, KindInfo>();
for (const k of KINDS) {
  byName.set(k.kind.toLowerCase(), k);
  byName.set(k.plural, k);
  byName.set(k.singular, k);
  for (const s of k.shortNames) byName.set(s, k);
}

/** Resolve "po", "pods", "Pod", "deployments.apps" to a kind. */
export function resolveKind(name: string): KindInfo | undefined {
  const lower = name.toLowerCase();
  const base = lower.split(".")[0];
  return byName.get(lower) ?? byName.get(base);
}

export function kindInfo(kind: string): KindInfo {
  const info = byName.get(kind.toLowerCase());
  if (!info) throw new Error(`unknown kind ${kind}`);
  return info;
}

export function isKnownKind(kind: string): boolean {
  return byName.has(kind.toLowerCase());
}
