// RBAC evaluation for `kubectl auth can-i`. Follows the real rules:
// RoleBindings grant within their namespace, ClusterRoleBindings grant
// everywhere, rules match on apiGroups, resources, verbs and resourceNames.

import type { Cluster } from "../cluster.js";
import type { KObject } from "../types.js";
import { resolveKind } from "../kinds.js";

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

interface Subject {
  kind: string;
  name: string;
  namespace?: string;
}

export interface Identity {
  user: string;
  groups: string[];
}

export function parseAs(as: string | undefined, groups: string[] = []): Identity | undefined {
  if (!as) return undefined;
  const sa = as.match(/^system:serviceaccount:([^:]+):(.+)$/);
  const g = [...groups, "system:authenticated"];
  if (sa) g.push("system:serviceaccounts", `system:serviceaccounts:${sa[1]}`);
  return { user: as, groups: g };
}

function subjectMatches(s: Subject, id: Identity, bindingNs?: string): boolean {
  if (s.kind === "User") return s.name === id.user;
  if (s.kind === "Group") return id.groups.includes(s.name);
  if (s.kind === "ServiceAccount") return id.user === `system:serviceaccount:${s.namespace ?? bindingNs}:${s.name}`;
  return false;
}

function ruleMatches(rule: Rule, verb: string, resource: string, group: string, sub: string | undefined, name: string | undefined): boolean {
  const verbs = rule.verbs ?? [];
  if (!verbs.includes("*") && !verbs.includes(verb)) return false;
  const groups = rule.apiGroups ?? [];
  if (!groups.includes("*") && !groups.includes(group)) return false;
  const full = sub ? `${resource}/${sub}` : resource;
  const resources = rule.resources ?? [];
  if (!resources.includes("*") && !resources.includes(full) && !(sub && resources.includes(`*/${sub}`))) return false;
  if (rule.resourceNames?.length) {
    if (!name || !rule.resourceNames.includes(name)) return false;
  }
  return true;
}

function rulesOf(cluster: Cluster, ref: { kind: string; name: string }, ns?: string): Rule[] {
  const role = ref.kind === "ClusterRole" ? cluster.get("ClusterRole", ref.name) : cluster.get("Role", ref.name, ns);
  return ((role?.rules as Rule[]) ?? []).slice();
}

/** Decide whether an identity can perform verb on resource in namespace. */
export function canI(cluster: Cluster, id: Identity, verb: string, resourceArg: string, ns: string | undefined, name?: string): boolean {
  if (id.user === "kubernetes-admin" || id.groups.includes("system:masters") || id.groups.includes("kubeadm:cluster-admins")) return true;
  const [resPart, sub] = resourceArg.split("/");
  const info = resolveKind(resPart);
  const resource = info ? info.plural : resPart.split(".")[0];
  const group = info ? (info.apiVersion.includes("/") ? info.apiVersion.split("/")[0] : "") : resPart.split(".").slice(1).join(".");
  const check = (rules: Rule[]) => rules.some((r) => ruleMatches(r, verb, resource, group, sub, name));

  for (const b of cluster.list("ClusterRoleBinding")) {
    const subjects = (b.subjects as Subject[]) ?? [];
    if (subjects.some((s) => subjectMatches(s, id)) && check(rulesOf(cluster, b.roleRef as { kind: string; name: string }))) return true;
  }
  if (ns) {
    for (const b of cluster.list("RoleBinding", ns)) {
      const subjects = (b.subjects as Subject[]) ?? [];
      if (subjects.some((s) => subjectMatches(s, id, ns)) && check(rulesOf(cluster, b.roleRef as { kind: string; name: string }, ns))) return true;
    }
  }
  return false;
}

export function buildRole(kind: "Role" | "ClusterRole", name: string, ns: string | undefined, verbs: string[], resources: string[], resourceNames: string[]): KObject {
  const byGroup = new Map<string, string[]>();
  for (const r of resources) {
    const [base, sub] = r.split("/");
    const info = resolveKind(base);
    const group = info ? (info.apiVersion.includes("/") ? info.apiVersion.split("/")[0] : "") : base.split(".").slice(1).join(".");
    const plural = (info ? info.plural : base.split(".")[0]) + (sub ? `/${sub}` : "");
    const list = byGroup.get(group) ?? [];
    list.push(plural);
    byGroup.set(group, list);
  }
  const rules = [...byGroup.entries()].map(([group, res]) => ({
    apiGroups: [group],
    resources: res,
    ...(resourceNames.length ? { resourceNames } : {}),
    verbs,
  }));
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind,
    metadata: { name, ...(ns ? { namespace: ns } : {}) },
    rules,
  };
}
