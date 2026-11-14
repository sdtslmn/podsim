// NetworkPolicy enforcement for traffic between simulated pods. Follows
// the Kubernetes rules: a pod is isolated for a direction once any policy
// selects it for that direction; traffic is then allowed only if some
// selecting policy has a rule whose peers and ports match.

import type { Cluster } from "./cluster.js";
import type { KObject } from "./types.js";
import { matchLabelSelector } from "./util.js";
import { setPolicyChecks } from "./podruntime.js";

interface Peer {
  podSelector?: Record<string, unknown>;
  namespaceSelector?: Record<string, unknown>;
  ipBlock?: { cidr: string; except?: string[] };
}
interface PortRule {
  port?: number | string;
  endPort?: number;
  protocol?: string;
}
interface Rule {
  from?: Peer[];
  to?: Peer[];
  ports?: PortRule[];
}

/** In NetworkPolicy an empty selector ({}) selects everything. */
function sel(labels: Record<string, string> | undefined, selector: Record<string, any> | undefined): boolean {
  if (!selector) return true;
  if (!Object.keys(selector.matchLabels ?? {}).length && !(selector.matchExpressions ?? []).length) return true;
  return matchLabelSelector(labels, selector);
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [base, bitsText] = cidr.split("/");
  const bits = parseInt(bitsText ?? "32", 10);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

export function policyTypes(np: KObject): string[] {
  if (np.spec?.policyTypes?.length) return np.spec.policyTypes;
  return np.spec?.egress ? ["Ingress", "Egress"] : ["Ingress"];
}

function selects(np: KObject, pod: KObject): boolean {
  return np.metadata.namespace === pod.metadata.namespace && sel(pod.metadata.labels, np.spec?.podSelector);
}

function peerMatches(cluster: Cluster, np: KObject, peer: Peer, other: KObject | undefined, otherIp: string): boolean {
  if (peer.ipBlock) {
    if (!inCidr(otherIp, peer.ipBlock.cidr)) return false;
    return !(peer.ipBlock.except ?? []).some((c) => inCidr(otherIp, c));
  }
  if (!other) return false;
  const nsObj = cluster.get("Namespace", other.metadata.namespace ?? "default");
  if (peer.namespaceSelector) {
    if (!sel(nsObj?.metadata.labels, peer.namespaceSelector)) return false;
  } else if (other.metadata.namespace !== np.metadata.namespace) return false;
  if (peer.podSelector && !sel(other.metadata.labels, peer.podSelector)) return false;
  return true;
}

function portMatches(rule: Rule, port: number, protocol: string, target: KObject | undefined): boolean {
  if (!rule.ports || rule.ports.length === 0) return true;
  return rule.ports.some((p) => {
    if ((p.protocol ?? "TCP").toUpperCase() !== protocol.toUpperCase()) return false;
    if (p.port === undefined) return true;
    let n: number | undefined;
    if (typeof p.port === "number") n = p.port;
    else if (/^\d+$/.test(p.port)) n = parseInt(p.port, 10);
    else n = (target?.spec?.containers ?? []).flatMap((c: { ports?: { name?: string; containerPort: number }[] }) => c.ports ?? []).find((x: { name?: string }) => x.name === p.port)?.containerPort;
    if (n === undefined) return false;
    return p.endPort !== undefined ? port >= n && port <= p.endPort : port === n;
  });
}

/** Is `to` allowed to receive traffic from `from` on port? `from` undefined means a node (kubelet, host). */
export function ingressAllowed(cluster: Cluster, from: KObject | undefined, to: KObject, port: number, protocol = "TCP"): boolean {
  if (!from) return true;
  const policies = cluster.list("NetworkPolicy", to.metadata.namespace).filter((np) => selects(np, to) && policyTypes(np).includes("Ingress"));
  if (policies.length === 0) return true;
  const ip = from.status?.podIP ?? "";
  return policies.some((np) => ((np.spec?.ingress ?? []) as Rule[]).some((r) => (!r.from || r.from.length === 0 || r.from.some((peer) => peerMatches(cluster, np, peer, from, ip))) && portMatches(r, port, protocol, to)));
}

/** Is `from` allowed to send traffic to toIp:port (toPod when the destination is a pod)? */
export function egressAllowed(cluster: Cluster, from: KObject | undefined, toIp: string, port: number, protocol = "TCP", toPod?: KObject): boolean {
  if (!from) return true;
  const policies = cluster.list("NetworkPolicy", from.metadata.namespace).filter((np) => selects(np, from) && policyTypes(np).includes("Egress"));
  if (policies.length === 0) return true;
  // Traffic to a Service IP is checked after it is translated to a pod, so the Service hop itself is allowed.
  if (!toPod && cluster.list("Service").some((s) => s.spec?.clusterIP === toIp)) return true;
  return policies.some((np) => ((np.spec?.egress ?? []) as Rule[]).some((r) => (!r.to || r.to.length === 0 || r.to.some((peer) => peerMatches(cluster, np, peer, toPod, toIp))) && portMatches(r, port, protocol, toPod)));
}

/** Can `from` reach cluster DNS? Without it, names do not resolve. */
export function dnsAllowed(cluster: Cluster, from: KObject | undefined): boolean {
  if (!from) return true;
  const dns = cluster.list("Pod", "kube-system").filter((p) => p.metadata.labels?.["k8s-app"] === "kube-dns" && p.status?.podIP);
  if (dns.length === 0) return false;
  return dns.some((p) => egressAllowed(cluster, from, p.status.podIP, 53, "UDP", p) && ingressAllowed(cluster, from, p, 53, "UDP"));
}

setPolicyChecks(ingressAllowed, egressAllowed, dnsAllowed);
