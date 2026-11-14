// The Kubernetes API as seen from inside a pod: curl to
// https://kubernetes.default.svc with a ServiceAccount token. Supports
// GET for lists and single objects, with RBAC, which is what CKAD tasks
// about ServiceAccounts usually need.

import type { Cluster } from "./cluster.js";
import { K8S_VERSION } from "./cluster.js";
import { allKinds, type KindInfo } from "./kinds.js";
import { canI, type Identity } from "./kubectl/rbac.js";
import { cleanForOutput } from "./kubectl/printers.js";

export interface ApiResponse {
  status: number;
  body: string;
}

const json = (status: number, value: unknown): ApiResponse => ({ status, body: JSON.stringify(value, null, 2) + "\n" });

function statusBody(code: number, reason: string, message: string, details?: Record<string, unknown>): ApiResponse {
  return json(code, { kind: "Status", apiVersion: "v1", metadata: {}, status: "Failure", message, reason, ...(details ? { details } : {}), code });
}

/** Who a bearer token belongs to. Tokens are the simulator's own unsigned JWTs. */
export function identityFromToken(token: string | undefined): Identity {
  if (!token) return { user: "system:anonymous", groups: ["system:unauthenticated"] };
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const sub = String(payload.sub ?? "");
    const m = sub.match(/^system:serviceaccount:([^:]+):(.+)$/);
    if (m) return { user: sub, groups: ["system:serviceaccounts", `system:serviceaccounts:${m[1]}`, "system:authenticated"] };
    return { user: sub || "system:anonymous", groups: ["system:authenticated"] };
  } catch {
    return { user: "system:anonymous", groups: ["system:unauthenticated"] };
  }
}

function findKind(group: string, version: string, plural: string): KindInfo | undefined {
  return allKinds().find((k) => {
    const [g, v] = k.apiVersion.includes("/") ? k.apiVersion.split("/") : ["", k.apiVersion];
    return k.plural === plural && g === group && (v === version || !version);
  });
}

/** Handle one GET request to the API server. */
export function apiGet(cluster: Cluster, id: Identity, rawPath: string): ApiResponse {
  const path = rawPath.split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/healthz" || path === "/livez" || path === "/readyz") return { status: 200, body: "ok" };
  if (path === "/version") {
    const [maj, min] = K8S_VERSION.slice(1).split(".");
    return json(200, { major: maj, minor: min, gitVersion: K8S_VERSION, platform: "linux/amd64" });
  }
  if (id.user === "system:anonymous" && path !== "/" && path !== "/api" && path !== "/apis") {
    // Anonymous users are forbidden everywhere except discovery.
  }
  if (path === "/" || path === "/api") {
    if (id.user === "system:anonymous") return statusBody(403, "Forbidden", `forbidden: User "system:anonymous" cannot get path "${path}"`, {});
    if (path === "/") return json(200, { paths: ["/api", "/api/v1", "/apis", "/healthz", "/version"] });
    return json(200, { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [{ clientCIDR: "0.0.0.0/0", serverAddress: "192.168.56.10:6443" }] });
  }
  const parts = path.split("/").filter(Boolean);
  let group = "";
  let version = "";
  let rest: string[];
  if (parts[0] === "api") {
    version = parts[1] ?? "";
    rest = parts.slice(2);
  } else if (parts[0] === "apis") {
    group = parts[1] ?? "";
    version = parts[2] ?? "";
    rest = parts.slice(3);
  } else return statusBody(404, "NotFound", "the server could not find the requested resource", {});
  let ns: string | undefined;
  if (rest[0] === "namespaces" && rest.length >= 3) {
    ns = rest[1];
    rest = rest.slice(2);
  }
  const [plural, name, sub] = rest;
  if (!plural) return json(200, { kind: "APIResourceList", groupVersion: group ? `${group}/${version}` : version, resources: allKinds().filter((k) => findKind(group, version, k.plural)).map((k) => ({ name: k.plural, namespaced: k.namespaced, kind: k.kind, verbs: ["get", "list"] })) });
  const info = findKind(group, version, plural);
  if (!info) return statusBody(404, "NotFound", "the server could not find the requested resource", {});
  const verb = name ? "get" : "list";
  const resource = sub ? `${info.plural}/${sub}` : info.plural;
  if (!canI(cluster, id, verb, resource, info.namespaced ? ns : undefined, name)) {
    const where = info.namespaced && ns ? `in the namespace "${ns}"` : "at the cluster scope";
    const subject = `${info.plural}${group ? "." + group : ""}${name ? ` "${name}"` : ""}`;
    return statusBody(403, "Forbidden", `${subject} is forbidden: User "${id.user}" cannot ${verb} resource "${resource}" in API group "${group}" ${where}`, { ...(name ? { name } : {}), ...(group ? { group } : {}), kind: info.plural });
  }
  if (name) {
    const obj = cluster.get(info.kind, name, ns);
    if (!obj) return statusBody(404, "NotFound", `${info.plural}${group ? "." + group : ""} "${name}" not found`, { name, ...(group ? { group } : {}), kind: info.plural });
    return json(200, cleanForOutput(obj));
  }
  const items = cluster.list(info.kind, info.namespaced ? ns : undefined).map((o) => cleanForOutput(o));
  return json(200, { kind: `${info.kind}List`, apiVersion: info.apiVersion, metadata: { resourceVersion: String(1000 + items.length) }, items });
}
