// Registry of the resource types the simulator knows about.

export interface KindInfo {
  /** Custom resource kinds come from a CustomResourceDefinition. */
  custom?: { printerColumns: { name: string; type: string; jsonPath: string; priority?: number }[]; schema?: Record<string, unknown>; version: string; versions: string[] };
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
  { kind: "PersistentVolume", plural: "persistentvolumes", singular: "persistentvolume", shortNames: ["pv"], apiVersion: "v1", namespaced: false },
  { kind: "StorageClass", plural: "storageclasses", singular: "storageclass", shortNames: ["sc"], apiVersion: "storage.k8s.io/v1", namespaced: false },
  { kind: "Job", plural: "jobs", singular: "job", shortNames: [], apiVersion: "batch/v1", namespaced: true },
  { kind: "CronJob", plural: "cronjobs", singular: "cronjob", shortNames: ["cj"], apiVersion: "batch/v1", namespaced: true },
  { kind: "DaemonSet", plural: "daemonsets", singular: "daemonset", shortNames: ["ds"], apiVersion: "apps/v1", namespaced: true },
  { kind: "StatefulSet", plural: "statefulsets", singular: "statefulset", shortNames: ["sts"], apiVersion: "apps/v1", namespaced: true },
  { kind: "HorizontalPodAutoscaler", plural: "horizontalpodautoscalers", singular: "horizontalpodautoscaler", shortNames: ["hpa"], apiVersion: "autoscaling/v2", namespaced: true },
  { kind: "ResourceQuota", plural: "resourcequotas", singular: "resourcequota", shortNames: ["quota"], apiVersion: "v1", namespaced: true },
  { kind: "LimitRange", plural: "limitranges", singular: "limitrange", shortNames: ["limits"], apiVersion: "v1", namespaced: true },
  { kind: "IngressClass", plural: "ingressclasses", singular: "ingressclass", shortNames: [], apiVersion: "networking.k8s.io/v1", namespaced: false },
  { kind: "PodDisruptionBudget", plural: "poddisruptionbudgets", singular: "poddisruptionbudget", shortNames: ["pdb"], apiVersion: "policy/v1", namespaced: true, storageOnly: true },
  { kind: "PriorityClass", plural: "priorityclasses", singular: "priorityclass", shortNames: ["pc"], apiVersion: "scheduling.k8s.io/v1", namespaced: false, storageOnly: true },
  { kind: "CustomResourceDefinition", plural: "customresourcedefinitions", singular: "customresourcedefinition", shortNames: ["crd", "crds"], apiVersion: "apiextensions.k8s.io/v1", namespaced: false },
];

/** Kinds learners will ask for that are planned but not simulated yet. */
export const PLANNED_KINDS: Record<string, string> = {};

const byName = new Map<string, KindInfo>();
for (const k of KINDS) {
  byName.set(k.kind.toLowerCase(), k);
  byName.set(k.plural, k);
  byName.set(k.singular, k);
  for (const s of k.shortNames) byName.set(s, k);
}

// Custom resource kinds of the cluster currently being worked on. Each Cluster
// keeps its own map and makes it current before it is used, so CRDs created
// in one simulated cluster never leak into another.
let custom = new Map<string, KindInfo>();
let customList: KindInfo[] = [];

export function useCustomKinds(byKey: Map<string, KindInfo>, list: KindInfo[]): void {
  custom = byKey;
  customList = list;
}

/** Every kind the current cluster serves: built-in kinds plus custom resources. */
export function allKinds(): KindInfo[] {
  return [...KINDS, ...customList];
}

/** Resolve "po", "pods", "Pod", "deployments.apps", "crontabs.stable.example.com" to a kind. */
export function resolveKind(name: string): KindInfo | undefined {
  const lower = name.toLowerCase();
  const base = lower.split(".")[0];
  const group = lower.split(".").slice(1).join(".");
  const fromCustom = custom.get(lower) ?? (group ? customList.find((k) => k.plural === base && k.apiVersion.startsWith(group + "/")) : custom.get(base));
  if (group && fromCustom) return fromCustom;
  return byName.get(lower) ?? byName.get(base) ?? fromCustom;
}

export function kindInfo(kind: string): KindInfo {
  const info = byName.get(kind.toLowerCase()) ?? custom.get(kind.toLowerCase());
  if (!info) throw new Error(`unknown kind ${kind}`);
  return info;
}

export function isKnownKind(kind: string): boolean {
  return byName.has(kind.toLowerCase()) || custom.has(kind.toLowerCase());
}
