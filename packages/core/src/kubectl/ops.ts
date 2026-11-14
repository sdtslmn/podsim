// logs, exec, node operations, config, auth, wait and informational commands.

import type { KObject, ContainerSpec } from "../types.js";
import { KubeError } from "../types.js";
import { KINDS } from "../kinds.js";
import { K8S_VERSION } from "../cluster.js";
import { deepClone, matchMap, table, parseSelector, matchRequirements } from "../util.js";
import { containerLogs } from "../controllers/kubelet.js";
import { isPodReady, deploymentPods } from "../controllers/deployment.js";
import type { Flags } from "./flags.js";
import { type Ctx, out, err, nsOf, notFoundError, singleTarget, kindOrThrow, ref, parseTargets } from "./common.js";
import { runInContainer } from "./container.js";
import { canI, parseAs } from "./rbac.js";
import { toYaml } from "./printers.js";

/** Resolve "pod-name", "pod/x", "deploy/x", "svc/x" to a concrete pod. */
function podFor(ctx: Ctx, arg: string, ns: string, purpose: string): KObject {
  const { cluster } = ctx;
  if (arg.includes("/")) {
    const [t, name] = arg.split("/");
    const info = kindOrThrow(t);
    const obj = cluster.get(info.kind, name, info.namespaced ? ns : undefined);
    if (!obj) throw notFoundError(info, name);
    if (info.kind === "Pod") return obj;
    let pods: KObject[] = [];
    if (info.kind === "Deployment" || info.kind === "ReplicaSet") pods = deploymentPods(cluster, obj);
    else if (info.kind === "Service") pods = cluster.list("Pod", ns).filter((p) => matchMap(p.metadata.labels, obj.spec?.selector));
    else throw new KubeError(`error: cannot ${purpose} ${info.plural}`);
    pods = pods.filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
    if (pods.length === 0) throw new KubeError(`error: timed out waiting for the condition`);
    pods.sort((a, b) => Number(isPodReady(b)) - Number(isPodReady(a)) || a.metadata.name.localeCompare(b.metadata.name));
    if (pods.length > 1 && purpose === "logs") err(ctx, `Found ${pods.length} pods, using pod/${pods[0].metadata.name}`);
    return pods[0];
  }
  const pod = cluster.get("Pod", arg, ns);
  if (!pod) throw notFoundError(kindOrThrow("pods"), arg);
  return pod;
}

function pickContainer(ctx: Ctx, pod: KObject, name: string | undefined): ContainerSpec {
  const cs = pod.spec.containers as ContainerSpec[];
  if (name) {
    const c = cs.find((x) => x.name === name);
    if (!c) throw new KubeError(`error: container ${name} is not valid for pod ${pod.metadata.name}`);
    return c;
  }
  if (cs.length > 1) err(ctx, `Defaulted container "${cs[0].name}" out of: ${cs.map((c) => c.name).join(", ")}`);
  return cs[0];
}

// ------------------------------------------------------------------ logs

export async function cmdLogs(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  let args = f.args;
  let follow = f.bool("follow");
  // "-f" is parsed as --filename elsewhere; for logs it means --follow.
  const fname = f.str("filename");
  if (fname) {
    follow = true;
    if (fname !== "true") args = [fname, ...args];
  }
  const tail = f.int("tail");
  const previous = f.bool("previous");
  const sel = f.str("selector");
  let pods: KObject[];
  if (sel) {
    const reqs = parseSelector(sel);
    pods = cluster.list("Pod", ns).filter((p) => matchRequirements(p.metadata.labels, reqs));
    if (pods.length === 0) {
      err(ctx, `No resources found in ${ns} namespace.`);
      return 0;
    }
  } else {
    if (!args[0]) throw new KubeError("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee 'kubectl logs -h' for help and examples");
    pods = [podFor(ctx, args[0], ns, "logs")];
  }
  let code = 0;
  for (const pod of pods) {
    const containerArg = f.str("container") ?? args[1];
    const containers = f.bool("all-containers") ? (pod.spec.containers as ContainerSpec[]) : [pickContainer(ctx, pod, containerArg)];
    for (const c of containers) {
      const r = containerLogs(cluster, pod, c.name, previous);
      if (r.error) {
        err(ctx, r.error);
        code = 1;
        continue;
      }
      let lines = r.lines ?? [];
      if (tail !== undefined && tail >= 0) lines = lines.slice(-tail);
      const prefix = f.bool("prefix") ? `[pod/${pod.metadata.name}/${c.name}] ` : "";
      if (lines.length) out(ctx, lines.map((l) => prefix + l).join("\n"));
    }
  }
  if (follow) err(ctx, "(podsim) --follow is not simulated yet; showing the logs collected so far.");
  return code;
}

// ------------------------------------------------------------------ exec

export async function cmdExec(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  if (!f.args[0]) throw new KubeError("error: pod, type/name or --filename must be specified");
  if (!f.hasDoubleDash) {
    if (f.args.length > 1) throw new KubeError("error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples");
    throw new KubeError("error: you must specify at least one command for the container");
  }
  const pod = podFor(ctx, f.args[0], ns, "exec into");
  const c = pickContainer(ctx, pod, f.str("container"));
  const st = (pod.status?.containerStatuses ?? []).find((s: { name: string }) => s.name === c.name);
  if (!st?.state?.running) {
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") throw new KubeError(`error: cannot exec into a container in a completed pod; current phase is ${pod.status.phase}`);
    throw new KubeError(`error: unable to upgrade connection: container not found ("${c.name}")`);
  }
  const r = runInContainer(cluster, pod, c, f.rest);
  if (r.stdout) ctx.io.stdout(r.stdout);
  if (r.stderr) err(ctx, r.stderr.replace(/\n$/, ""));
  if (r.exitCode !== 0 && !r.stderr.startsWith("error:") && !r.stderr.startsWith("(podsim)")) err(ctx, `command terminated with exit code ${r.exitCode}`);
  return r.exitCode;
}

// ------------------------------------------------------------------ nodes

function getNode(ctx: Ctx, name: string): KObject {
  const n = ctx.cluster.get("Node", name);
  if (!n) throw new KubeError(`Error from server (NotFound): nodes "${name}" not found`);
  return n;
}

function setCordon(ctx: Ctx, name: string, on: boolean): boolean {
  const node = deepClone(getNode(ctx, name));
  if (!!node.spec.unschedulable === on) return false;
  const taints = ((node.spec.taints ?? []) as { key: string; effect: string }[]).filter((t) => t.key !== "node.kubernetes.io/unschedulable");
  if (on) {
    node.spec.unschedulable = true;
    taints.push({ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule", timeAdded: new Date(ctx.cluster.now()).toISOString().replace(/\.\d+Z$/, "Z") } as { key: string; effect: string });
  } else delete node.spec.unschedulable;
  if (taints.length) node.spec.taints = taints;
  else delete node.spec.taints;
  ctx.cluster.replace(node);
  return true;
}

export async function cmdCordon(ctx: Ctx, f: Flags, on: boolean): Promise<number> {
  const name = f.args[0];
  if (!name) throw new KubeError("error: USAGE: cordon NODE [flags]");
  ctx.cluster.advance();
  const changed = setCordon(ctx, name, on);
  out(ctx, `node/${name} ${changed ? (on ? "cordoned" : "uncordoned") : on ? "already cordoned" : "already uncordoned"}`);
  ctx.cluster.advance();
  return 0;
}

export async function cmdDrain(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  const name = f.args[0];
  if (!name) throw new KubeError("error: USAGE: drain NODE [flags]");
  cluster.advance();
  getNode(ctx, name);
  const changed = setCordon(ctx, name, true);
  out(ctx, `node/${name} ${changed ? "cordoned" : "already cordoned"}`);
  const pods = cluster.list("Pod").filter((p) => p.spec?.nodeName === name);
  const daemon = pods.filter((p) => p.metadata.labels?.["k8s-app"] === "kube-proxy");
  const mirror = pods.filter((p) => p.metadata.namespace === "kube-system" && p.metadata.labels?.tier === "control-plane");
  const bare = pods.filter((p) => !daemon.includes(p) && !mirror.includes(p) && !p.metadata.ownerReferences?.some((r) => r.controller));
  const problems: string[] = [];
  if (daemon.length && !f.bool("ignore-daemonsets")) problems.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${daemon.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`);
  if (bare.length && !f.bool("force")) problems.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`);
  if (problems.length) {
    err(ctx, `error: unable to drain node "${name}" due to error: ${problems.join(", ")}, continuing command...\nThere are pending nodes to be drained:\n ${name}\n${problems.join("\n")}`);
    return 1;
  }
  const warnings: string[] = [];
  if (daemon.length) warnings.push(`ignoring DaemonSet-managed Pods: ${daemon.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`);
  if (bare.length) warnings.push(`deleting Pods that declare no controller: ${bare.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}`);
  if (warnings.length) err(ctx, `Warning: ${warnings.join("; ")}`);
  const evict = pods.filter((p) => !daemon.includes(p) && !mirror.includes(p));
  for (const p of evict) out(ctx, `evicting pod ${p.metadata.namespace}/${p.metadata.name}`);
  for (const p of evict) {
    cluster.remove("Pod", p.metadata.name, p.metadata.namespace);
    out(ctx, `pod/${p.metadata.name} evicted`);
  }
  cluster.advance();
  out(ctx, `node/${name} drained`);
  return 0;
}

export async function cmdTaint(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const args = [...f.args];
  if (args[0] && ["node", "nodes", "no"].includes(args[0])) args.shift();
  else if (args[0]?.startsWith("node/") || args[0]?.startsWith("nodes/")) args[0] = args[0].split("/")[1];
  else throw new KubeError("error: at least one taint update is required");
  const [name, ...specs] = args;
  if (!name || specs.length === 0) throw new KubeError("error: at least one taint update is required");
  const node = deepClone(getNode(ctx, name));
  let taints = ((node.spec.taints ?? []) as { key: string; value?: string; effect: string }[]).slice();
  let removedOnly = true;
  for (const spec of specs) {
    if (spec.endsWith("-")) {
      const body = spec.slice(0, -1);
      const [kv, effect] = body.split(":");
      const key = kv.split("=")[0];
      const before = taints.length;
      taints = taints.filter((t) => !(t.key === key && (!effect || t.effect === effect)));
      if (taints.length === before) throw new KubeError(`error: taint "${body}" not found`);
      continue;
    }
    removedOnly = false;
    const m = spec.match(/^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/);
    if (!m) throw new KubeError(`error: invalid taint spec: ${spec}, unknown taint effect or missing effect`);
    const [, key, value, effect] = m;
    const existing = taints.find((t) => t.key === key && t.effect === effect);
    if (existing && !f.bool("overwrite")) throw new KubeError(`error: node ${name} already has ${key} taint(s) with same effect(s) and --overwrite is false`);
    taints = taints.filter((t) => !(t.key === key && t.effect === effect));
    taints.push({ key, ...(value ? { value } : {}), effect });
  }
  if (taints.length) node.spec.taints = taints;
  else delete node.spec.taints;
  cluster.replace(node);
  cluster.advance();
  out(ctx, `node/${name} ${removedOnly ? "untainted" : "tainted"}`);
  return 0;
}

// ------------------------------------------------------------------ config

const CONTEXT = "kubernetes-admin@kubernetes";

export async function cmdConfig(ctx: Ctx, f: Flags): Promise<number> {
  const [sub, ...rest] = f.args;
  switch (sub) {
    case "current-context":
      out(ctx, CONTEXT);
      return 0;
    case "get-contexts":
      out(ctx, table(["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], [["*", CONTEXT, "kubernetes", "kubernetes-admin", ctx.state.namespace === "default" ? "" : ctx.state.namespace]]));
      return 0;
    case "get-clusters":
      out(ctx, "NAME\nkubernetes");
      return 0;
    case "get-users":
      out(ctx, "NAME\nkubernetes-admin");
      return 0;
    case "use-context":
      if (rest[0] !== CONTEXT) throw new KubeError(`error: no context exists with the name: "${rest[0] ?? ""}"`);
      out(ctx, `Switched to context "${CONTEXT}".`);
      return 0;
    case "set-context": {
      if (!f.bool("current") && rest[0] !== CONTEXT) throw new KubeError(`(podsim) only the current context "${CONTEXT}" exists in the simulator. Use: kubectl config set-context --current --namespace=NAME`);
      const ns = f.str("namespace");
      if (ns) ctx.state.namespace = ns;
      out(ctx, `Context "${CONTEXT}" modified.`);
      return 0;
    }
    case "view": {
      const cfg = {
        apiVersion: "v1",
        clusters: [{ cluster: { "certificate-authority-data": "DATA+OMITTED", server: "https://192.168.56.10:6443" }, name: "kubernetes" }],
        contexts: [{ context: { cluster: "kubernetes", user: "kubernetes-admin", ...(ctx.state.namespace !== "default" ? { namespace: ctx.state.namespace } : {}) }, name: CONTEXT }],
        "current-context": CONTEXT,
        kind: "Config",
        preferences: {},
        users: [{ name: "kubernetes-admin", user: { "client-certificate-data": "DATA+OMITTED", "client-key-data": "DATA+OMITTED" } }],
      };
      out(ctx, toYaml(cfg).trimEnd());
      return 0;
    }
    default:
      throw new KubeError(`error: unknown command "${sub ?? ""}" for "kubectl config"\nAvailable: current-context, get-contexts, get-clusters, get-users, set-context, use-context, view`);
  }
}

// ------------------------------------------------------------------ auth

export async function cmdAuth(ctx: Ctx, f: Flags): Promise<number> {
  const [sub, ...rest] = f.args;
  ctx.cluster.advance();
  if (sub === "whoami") {
    const id = parseAs(f.str("as"), f.all("as-group"));
    const user = id?.user ?? "kubernetes-admin";
    const groups = id?.groups ?? ["kubeadm:cluster-admins", "system:authenticated"];
    out(ctx, table(["ATTRIBUTE", "VALUE"], [["Username", user], ["Groups", `[${groups.join(" ")}]`]]));
    return 0;
  }
  if (sub !== "can-i") throw new KubeError(`error: unknown command "${sub ?? ""}" for "kubectl auth"\nAvailable Commands: can-i, whoami`);
  if (f.bool("list")) throw new KubeError("(podsim) auth can-i --list is not simulated yet. Ask about one verb and resource at a time.");
  const [verb, resourceArg, maybeName] = rest;
  if (!verb || !resourceArg) throw new KubeError("error: you must specify two arguments: verb resource or a URL path");
  let resource = resourceArg;
  let name = maybeName;
  if (resourceArg.includes("/") && !resourceArg.startsWith("/")) {
    const parts = resourceArg.split("/");
    if (parts.length === 2 && !["log", "status", "scale", "exec", "portforward", "proxy", "binding", "eviction"].includes(parts[1])) {
      resource = parts[0];
      name = parts[1];
    }
  }
  const allNs = f.bool("all-namespaces");
  const ns = allNs ? undefined : nsOf(ctx, f);
  const id = parseAs(f.str("as"), f.all("as-group")) ?? { user: "kubernetes-admin", groups: ["kubeadm:cluster-admins", "system:authenticated"] };
  const yes = canI(ctx.cluster, id, verb, resource, ns, name);
  out(ctx, yes ? "yes" : "no");
  return yes ? 0 : 1;
}

// ------------------------------------------------------------------ wait

export async function cmdWait(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  const ns = nsOf(ctx, f);
  const forArg = f.str("for");
  if (!forArg) throw new KubeError("error: --for must be specified");
  const timeoutStr = f.str("timeout") ?? "30s";
  const m = timeoutStr.match(/^(\d+)(s|m)?$/);
  const timeout = m ? parseInt(m[1], 10) * (m[2] === "m" ? 60000 : 1000) : 30000;
  const targets = parseTargets(f.args);
  const sel = f.str("selector");
  const start = Date.now();
  const resolve = (): { label: string; display: string; obj?: KObject }[] => {
    const list: { label: string; display: string; obj?: KObject }[] = [];
    for (const t of targets) {
      if (t.names.length) for (const n of t.names) list.push({ label: `${t.info.plural}/${n}`, display: ref(t.info, n), obj: cluster.get(t.info.kind, n, t.info.namespaced ? ns : undefined) });
      else {
        let objs = cluster.list(t.info.kind, ns);
        if (sel) {
          const pairs = Object.fromEntries(sel.split(",").map((p) => p.split("=") as [string, string]));
          objs = objs.filter((o) => matchMap(o.metadata.labels, pairs));
        }
        for (const o of objs) list.push({ label: `${t.info.plural}/${o.metadata.name}`, display: ref(t.info, o.metadata.name), obj: o });
      }
    }
    return list;
  };
  const check = (o: KObject | undefined): boolean => {
    if (forArg === "delete") return !o;
    if (!o) return false;
    const cm = forArg.match(/^condition=([\w-]+)(?:=(\w+))?$/i);
    if (cm) {
      const want = (cm[2] ?? "True").toLowerCase();
      return (o.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type.toLowerCase() === cm[1].toLowerCase() && c.status.toLowerCase() === want);
    }
    const jp = forArg.match(/^jsonpath=\{?\.?([^}=]+)\}?=(.+)$/);
    if (jp) {
      const val = jp[1].split(".").reduce((acc: unknown, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);
      return String(val) === jp[2].replace(/^['"]|['"]$/g, "");
    }
    throw new KubeError(`error: unrecognized condition: "${forArg}"`);
  };
  for (;;) {
    cluster.advance();
    const items = resolve();
    if (items.length === 0 && forArg !== "delete") throw new KubeError("error: no matching resources found");
    const pending = items.filter((i) => !check(i.obj));
    if (pending.length === 0) {
      for (const i of items) out(ctx, `${i.display} condition met`);
      return 0;
    }
    if (Date.now() - start > timeout || ctx.io.aborted?.()) {
      err(ctx, `error: timed out waiting for the condition on ${pending[0].label}`);
      return 1;
    }
    await ctx.io.sleep(500);
  }
}

// ------------------------------------------------------------------ informational

export function cmdVersion(ctx: Ctx, f: Flags): number {
  if (f.has("short")) throw new KubeError("error: unknown flag: --short\nSee 'kubectl version --help' for usage.");
  const lines = [`Client Version: ${K8S_VERSION}`, "Kustomize Version: v5.7.1"];
  if (!f.bool("client")) lines.push(`Server Version: ${K8S_VERSION}`);
  out(ctx, lines.join("\n"));
  return 0;
}

export function cmdClusterInfo(ctx: Ctx): number {
  out(
    ctx,
    "Kubernetes control plane is running at https://192.168.56.10:6443\nCoreDNS is running at https://192.168.56.10:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.",
  );
  return 0;
}

export function cmdApiResources(ctx: Ctx, f: Flags): number {
  let kinds = [...KINDS].sort((a, b) => a.plural.localeCompare(b.plural));
  const namespaced = f.str("namespaced");
  if (namespaced !== undefined) kinds = kinds.filter((k) => String(k.namespaced) === namespaced);
  if (f.str("output") === "name") {
    out(ctx, kinds.map((k) => (k.apiVersion.includes("/") ? `${k.plural}.${k.apiVersion.split("/")[0]}` : k.plural)).join("\n"));
    return 0;
  }
  out(
    ctx,
    table(
      ["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"],
      kinds.map((k) => [k.plural, k.shortNames.join(","), k.apiVersion, String(k.namespaced), k.kind]),
    ),
  );
  return 0;
}

export function cmdTop(ctx: Ctx): number {
  err(ctx, "error: Metrics API not available");
  return 1;
}

export function cmdExplain(ctx: Ctx, f: Flags): number {
  const what = f.args[0];
  if (!what) throw new KubeError("error: You must specify the type of resource to explain. Use \"kubectl api-resources\" for a complete list of supported resources.");
  const kind = kindOrThrow(what.split(".")[0]);
  err(ctx, `(podsim) explain is not simulated yet. Field reference for ${kind.kind}: https://kubernetes.io/docs/reference/kubernetes-api/`);
  return 1;
}

export function notSimulated(ctx: Ctx, cmd: string): number {
  err(ctx, `(podsim) "kubectl ${cmd}" is not simulated yet.`);
  return 1;
}

export function cmdEdit(ctx: Ctx, f: Flags): number {
  const target = f.args.join(" ") || "TYPE NAME";
  err(
    ctx,
    `(podsim) kubectl edit needs an interactive editor, which the simulator does not have. Do this instead:\n  kubectl get ${target} -o yaml > obj.yaml\n  # change obj.yaml in your editor\n  kubectl apply -f obj.yaml        (or: kubectl replace --force -f obj.yaml for pods)`,
  );
  return 1;
}

export { singleTarget, ref };
