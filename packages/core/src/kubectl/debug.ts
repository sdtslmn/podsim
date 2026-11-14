// Observability and maintenance commands: kubectl top (backed by a simulated
// metrics-server), kubectl events, kubectl debug (ephemeral containers, pod
// copies and node debugging) and kubectl autoscale.

import type { KObject, ContainerSpec } from "../types.js";
import { KubeError } from "../types.js";
import type { Flags } from "./flags.js";
import { type Ctx, out, err, nsOf, kindOrThrow, selectorFilter, authorize } from "./common.js";
import { deepClone, humanDuration, parseCpu, parseMemory, parseTime, table as fullTable, fnv1a, safeEncode } from "../util.js";
import { kindInfo } from "../kinds.js";

import { podMetrics, type ContainerMetrics } from "../controllers/hpa.js";
import { toYaml } from "./printers.js";

const cpuStr = (m: number) => `${Math.round(m)}m`;
const memStr = (mi: number) => `${Math.round(mi)}Mi`;

export function cmdTop(ctx: Ctx, f: Flags): number {
  const { cluster } = ctx;
  const table = (h: string[], rows: string[][]) => (f.bool("no-headers") ? fullTable(h, rows).split("\n").slice(1).join("\n") : fullTable(h, rows));
  cluster.advance();
  const [what, name] = f.args;
  const metricsServer = cluster.list("Deployment", "kube-system").find((d) => d.metadata.name === "metrics-server" && (d.status?.availableReplicas ?? 0) > 0);
  if (!metricsServer) throw new KubeError("error: Metrics API not available");
  if (what === "node" || what === "nodes" || what === "no") {
    const nodes = name ? [cluster.get("Node", name)].filter(Boolean) as KObject[] : cluster.list("Node");
    if (name && !nodes.length) throw new KubeError(`Error from server (NotFound): nodes "${name}" not found`);
    const rows = nodes.map((n) => {
      const pods = cluster.list("Pod").filter((p) => p.spec?.nodeName === n.metadata.name);
      const m = pods.flatMap((p) => podMetrics(cluster, p) ?? []);
      const cpu = 80 + m.reduce((t, x) => t + x.cpu, 0) + (n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? 60 : 0);
      const mem = 600 + m.reduce((t, x) => t + x.memMi, 0) + (n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined ? 700 : 0);
      const capCpu = parseCpu(n.status?.allocatable?.cpu ?? "2");
      const capMem = parseMemory(n.status?.allocatable?.memory ?? "4Gi") / (1024 * 1024);
      return [n.metadata.name, cpuStr(cpu), `${Math.round((cpu / capCpu) * 100)}%`, memStr(mem), `${Math.round((mem / capMem) * 100)}%`];
    });
    out(ctx, table(["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], rows));
    return 0;
  }
  if (what !== "pod" && what !== "pods" && what !== "po") throw new KubeError(`error: unknown command "${what ?? ""}" for "kubectl top"\n\nAvailable Commands:\n  node          Display resource (CPU/memory) usage of nodes\n  pod           Display resource (CPU/memory) usage of pods`);
  const allNs = f.bool("all-namespaces");
  const ns = nsOf(ctx, f);
  let pods = name ? [cluster.get("Pod", name, ns)].filter(Boolean) as KObject[] : cluster.list("Pod", allNs ? undefined : ns);
  if (name && !pods.length) throw new KubeError(`Error from server (NotFound): pods "${name}" not found`);
  const sel = selectorFilter(f);
  if (sel) pods = pods.filter(sel);
  const sampled = pods.map((p) => ({ p, m: podMetrics(cluster, p) })).filter((x) => x.m) as { p: KObject; m: ContainerMetrics[] }[];
  if (name && !sampled.length) throw new KubeError(`error: Metrics not available for pod ${ns}/${name}, age: ${humanDuration(cluster.now() - parseTime(pods[0].metadata.creationTimestamp))}`);
  if (!sampled.length) {
    err(ctx, allNs ? "No resources found" : `No resources found in ${ns} namespace.`);
    return 0;
  }
  const sortBy = f.str("sort-by");
  const total = (m: ContainerMetrics[], k: "cpu" | "memMi") => m.reduce((t, x) => t + x[k], 0);
  if (sortBy === "cpu") sampled.sort((a, b) => total(b.m, "cpu") - total(a.m, "cpu"));
  else if (sortBy === "memory") sampled.sort((a, b) => total(b.m, "memMi") - total(a.m, "memMi"));
  const nsCol = allNs ? ["NAMESPACE"] : [];
  if (f.bool("containers")) {
    const rows = sampled.flatMap(({ p, m }) => m.map((c) => [...(allNs ? [p.metadata.namespace ?? "default"] : []), p.metadata.name, c.name, cpuStr(c.cpu), memStr(c.memMi)]));
    out(ctx, table([...nsCol, "POD", "NAME", "CPU(cores)", "MEMORY(bytes)"], rows));
    return 0;
  }
  const rows = sampled.map(({ p, m }) => [...(allNs ? [p.metadata.namespace ?? "default"] : []), p.metadata.name, cpuStr(total(m, "cpu")), memStr(total(m, "memMi"))]);
  out(ctx, table([...nsCol, "NAME", "CPU(cores)", "MEMORY(bytes)"], rows));
  return 0;
}

// ------------------------------------------------------------------ events

export function cmdEvents(ctx: Ctx, f: Flags): number {
  const { cluster } = ctx;
  cluster.advance();
  const allNs = f.bool("all-namespaces");
  const ns = nsOf(ctx, f);
  let events = cluster.list("Event", allNs ? undefined : ns).sort((a, b) => cluster.compareEvents(a, b));
  const forArg = f.str("for");
  if (forArg) {
    const [t, n] = forArg.includes("/") ? forArg.split("/") : ["pod", forArg];
    const info = kindOrThrow(t);
    events = events.filter((e) => (e.involvedObject as { kind?: string } | undefined)?.kind === info.kind && (e.involvedObject as { name?: string } | undefined)?.name === n);
  }
  const types = f.all("types").flatMap((x) => x.split(","));
  if (types.length) {
    for (const t of types) if (t !== "Normal" && t !== "Warning") throw new KubeError(`error: valid --types are Normal or Warning`);
    events = events.filter((e) => types.includes(String(e.type)));
  }
  if (!events.length) {
    err(ctx, allNs ? "No events found." : `No events found in ${ns} namespace.`);
    return 0;
  }
  const output = f.str("output");
  if (output === "yaml" || output === "json") {
    const list = { apiVersion: "v1", kind: "List", items: events, metadata: { resourceVersion: "" } };
    out(ctx, output === "json" ? JSON.stringify(list, null, 4) : toYaml(list).trimEnd());
    return 0;
  }
  const rows = events.map((e) => {
    const io = (e.involvedObject ?? {}) as { kind?: string; name?: string };
    const lastTs = String(e.lastTimestamp ?? "");
    const seen = humanDuration(cluster.now() - parseTime(lastTs));
    const n = Number(e.count ?? 1);
    const count = n > 1 ? `${seen} (x${n} over ${humanDuration(parseTime(lastTs) - parseTime(String(e.firstTimestamp ?? "")))})` : seen;
    return [...(allNs ? [e.metadata.namespace ?? ""] : []), count, String(e.type), String(e.reason), `${io.kind}/${io.name}`, String(e.message ?? "").replace(/\n/g, " ")];
  });
  out(ctx, fullTable([...(allNs ? ["NAMESPACE"] : []), "LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], rows));
  return 0;
}

// ------------------------------------------------------------------ debug

function suffix(ctx: Ctx, seed: string): string {
  return safeEncode(fnv1a(`${seed}/${ctx.cluster.now()}/${ctx.cluster.list("Pod").length}`), 5);
}

function interactiveFlags(f: Flags): boolean {
  return f.bool("i") || f.bool("stdin") || f.bool("it") || f.bool("ti") || f.bool("tty") || f.bool("t");
}

/** Run the cluster until a container is running, like kubectl attach waiting for it. */
async function waitRunning(ctx: Ctx, pod: () => KObject | undefined, container: string, kind: "containerStatuses" | "ephemeralContainerStatuses"): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const p = pod();
    const st = (p?.status?.[kind] ?? []).find((s: { name: string }) => s.name === container);
    if (st?.state?.running) return true;
    if (st?.state?.terminated || st?.state?.waiting?.reason?.match(/ErrImagePull|ImagePullBackOff|CrashLoopBackOff/)) return false;
    await ctx.io.sleep(1000);
    ctx.cluster.advance();
  }
  return false;
}

export async function cmdDebug(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const target = f.args[0];
  if (!target) throw new KubeError("error: debugging requires at least one argument: TYPE/NAME or NAME\nSee 'kubectl debug -h' for help and examples");
  const image = f.str("image");
  const interactive = interactiveFlags(f);
  const command = f.rest;
  const name = f.str("container");
  const profile = f.str("profile") ?? "legacy";
  if (!["legacy", "general", "baseline", "restricted", "netadmin", "sysadmin"].includes(profile)) throw new KubeError(`error: unknown profile: ${profile}`);

  // kubectl debug node/NAME
  if (target.startsWith("node/") || target.startsWith("nodes/")) {
    const nodeName = target.split("/")[1];
    const node = cluster.get("Node", nodeName);
    if (!node) throw new KubeError(`Error from server (NotFound): nodes "${nodeName}" not found`);
    if (!image) throw new KubeError("error: --image is required for node debugging");
    const podName = `node-debugger-${nodeName}-${suffix(ctx, nodeName)}`;
    authorize(ctx, "create", kindInfo("Pod"), ns);
    const pod: KObject = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: podName, namespace: ns, labels: { "app.kubernetes.io/managed-by": "kubectl-debug" } },
      spec: {
        nodeName,
        hostIPC: true,
        hostNetwork: true,
        hostPID: true,
        restartPolicy: "Never",
        tolerations: [{ operator: "Exists" }],
        volumes: [{ name: "host-root", hostPath: { path: "/" } }],
        containers: [{ name: "debugger", image, stdin: interactive, tty: interactive, ...(command.length ? { command } : {}), volumeMounts: [{ name: "host-root", mountPath: "/host" }], terminationMessagePolicy: "File" }],
      },
    };
    cluster.create(pod);
    out(ctx, `Creating debugging pod ${podName} with container debugger on node ${nodeName}.`);
    if (!interactive) return 0;
    if (!(await waitRunning(ctx, () => cluster.get("Pod", podName, ns), "debugger", "containerStatuses"))) {
      err(ctx, `error: timed out waiting for the debugging pod to start`);
      return 1;
    }
    out(ctx, "If you don't see a command prompt, try pressing enter.");
    ctx.state.session = { pod: podName, namespace: ns, container: "debugger", remove: false, vars: { PWD: "/" }, bash: false };
    return 0;
  }

  const podName = target.startsWith("pod/") || target.startsWith("pods/") || target.startsWith("po/") ? target.split("/")[1] : target;
  if (target.includes("/") && !/^(pod|pods|po)\//.test(target)) throw new KubeError(`error: cannot debug ${target.split("/")[0]}: only pods and nodes can be debugged`);
  const pod = cluster.get("Pod", podName, ns);
  if (!pod) throw new KubeError(`Error from server (NotFound): pods "${podName}" not found`);

  // kubectl debug POD --copy-to=NAME
  const copyTo = f.str("copy-to");
  if (copyTo) {
    const setImages = f.all("set-image").flatMap((s) => s.split(","));
    if (!image && !setImages.length && !f.bool("share-processes") && !command.length && !name) throw new KubeError("error: you must specify --image, --set-image or a command when using --copy-to");
    const copy = deepClone(pod);
    copy.metadata = { name: copyTo, namespace: ns, ...(f.bool("keep-labels") && pod.metadata.labels ? { labels: pod.metadata.labels } : {}), ...(f.bool("keep-annotations") && pod.metadata.annotations ? { annotations: pod.metadata.annotations } : {}) };
    delete copy.status;
    if (!f.bool("same-node")) delete copy.spec.nodeName;
    delete copy.spec.ephemeralContainers;
    copy.spec.restartPolicy = copy.spec.restartPolicy ?? "Always";
    if (f.has("share-processes") ? f.bool("share-processes") : true) copy.spec.shareProcessNamespace = true;
    for (const c of copy.spec.containers as ContainerSpec[]) {
      delete c.livenessProbe;
      delete c.readinessProbe;
      delete c.startupProbe;
    }
    for (const si of setImages) {
      const [cname, img] = si.split("=");
      for (const c of copy.spec.containers as ContainerSpec[]) if (cname === "*" || c.name === cname) c.image = img;
    }
    let debugName = name;
    if (image || command.length) {
      const existing = (copy.spec.containers as ContainerSpec[]).find((c) => c.name === name);
      if (existing) {
        if (image) existing.image = image;
        if (command.length) {
          existing.command = command;
          delete existing.args;
        }
        existing.stdin = interactive;
        existing.tty = interactive;
      } else {
        debugName = name ?? `debugger-${suffix(ctx, podName)}`;
        if (!name) out(ctx, `Defaulting debug container name to ${debugName}.`);
        (copy.spec.containers as ContainerSpec[]).push({ name: debugName, image: image ?? (pod.spec.containers[0].image as string), stdin: interactive, tty: interactive, ...(command.length ? { command } : {}), terminationMessagePolicy: "File", resources: {} } as ContainerSpec);
      }
    }
    if (cluster.get("Pod", copyTo, ns)) {
      if (!f.bool("replace")) throw new KubeError(`Error from server (AlreadyExists): pods "${copyTo}" already exists`);
      cluster.remove("Pod", copyTo, ns);
    }
    cluster.create(copy);
    if (!interactive) return 0;
    const cname = debugName ?? (copy.spec.containers[0].name as string);
    if (!(await waitRunning(ctx, () => cluster.get("Pod", copyTo, ns), cname, "containerStatuses"))) {
      err(ctx, `error: the debug container ${cname} did not start; check kubectl describe pod ${copyTo}`);
      return 1;
    }
    out(ctx, "If you don't see a command prompt, try pressing enter.");
    ctx.state.session = { pod: copyTo, namespace: ns, container: cname, remove: false, vars: { PWD: "/" }, bash: false };
    return 0;
  }

  // Ephemeral container.
  if (!image) throw new KubeError("error: --image is required for ephemeral containers");
  if (pod.status?.phase !== "Running" && pod.status?.phase !== "Pending") throw new KubeError(`error: ephemeral containers are disabled for this cluster (error from server: "pods \\"${podName}\\" is forbidden: cannot add ephemeral container to a pod that has terminated")`);
  const tgt = f.str("target");
  if (tgt && !(pod.spec.containers as ContainerSpec[]).some((c) => c.name === tgt)) throw new KubeError(`error: target container "${tgt}" not found in pod ${podName}`);
  const debugName = name ?? `debugger-${suffix(ctx, podName)}`;
  const all = [...(pod.spec.containers as ContainerSpec[]), ...((pod.spec.initContainers ?? []) as ContainerSpec[]), ...((pod.spec.ephemeralContainers ?? []) as ContainerSpec[])];
  if (all.some((c) => c.name === debugName)) throw new KubeError(`error: ephemeral container "${debugName}" already exists in pod ${podName}`);
  if (!name) out(ctx, `Defaulting debug container name to ${debugName}.`);
  authorize(ctx, "patch", kindInfo("Pod"), ns, podName, "ephemeralcontainers");
  const updated = deepClone(pod);
  const ec: ContainerSpec = { name: debugName, image, stdin: interactive, tty: interactive, ...(command.length ? { command } : {}), ...(tgt ? { targetContainerName: tgt } : {}), terminationMessagePolicy: "File", imagePullPolicy: "IfNotPresent" } as ContainerSpec;
  if (profile === "sysadmin") (ec as Record<string, unknown>).securityContext = { privileged: true };
  if (profile === "netadmin") (ec as Record<string, unknown>).securityContext = { capabilities: { add: ["NET_ADMIN", "NET_RAW"] } };
  if (profile === "restricted") (ec as Record<string, unknown>).securityContext = { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } };
  updated.spec.ephemeralContainers = [...(updated.spec.ephemeralContainers ?? []), ec];
  cluster.put(updated);
  if (tgt) err(ctx, `Targeting container "${tgt}". If you don't see processes from this container it may be because the container runtime doesn't support this feature.`);
  if (!interactive) return 0;
  if (!(await waitRunning(ctx, () => cluster.get("Pod", podName, ns), debugName, "ephemeralContainerStatuses"))) {
    err(ctx, `error: timed out waiting for the condition`);
    return 1;
  }
  out(ctx, "If you don't see a command prompt, try pressing enter.");
  ctx.state.session = { pod: podName, namespace: ns, container: debugName, remove: false, vars: { PWD: "/" }, bash: false };
  return 0;
}

// ------------------------------------------------------------------ autoscale

export function cmdAutoscale(ctx: Ctx, f: Flags): number {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const [t0, n0] = f.args;
  if (!t0) throw new KubeError("error: required resource not specified");
  const [t, n] = t0.includes("/") ? t0.split("/") : [t0, n0];
  const info = kindOrThrow(t);
  if (!["Deployment", "ReplicaSet", "StatefulSet", "ReplicationController"].includes(info.kind)) throw new KubeError(`error: cannot autoscale a ${info.kind}: cannot autoscale a ${info.kind}`);
  const target = cluster.get(info.kind, n, ns);
  if (!target) throw new KubeError(`Error from server (NotFound): ${info.plural}.${info.apiVersion.includes("/") ? info.apiVersion.split("/")[0] : ""} "${n}" not found`.replace(/\.\s"/, ' "').replace('. "', ' "'));
  const max = f.str("max");
  if (!max) throw new KubeError("error: --max=MAXPODS is required and must be at least 1, max: -1");
  const min = f.str("min");
  const cpu = f.str("cpu-percent") ?? f.str("cpu");
  const mem = f.str("memory-percent") ?? f.str("memory");
  const name = f.str("name") ?? n;
  const metrics: Record<string, unknown>[] = [];
  const pct = (v: string) => parseInt(v.replace(/%$/, ""), 10);
  if (cpu) metrics.push({ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: pct(cpu) } } });
  if (mem) metrics.push({ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: pct(mem) } } });
  const hpa: KObject = {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name, namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: target.apiVersion, kind: info.kind, name: n },
      ...(min ? { minReplicas: parseInt(min, 10) } : {}),
      maxReplicas: parseInt(max, 10),
      ...(metrics.length ? { metrics } : {}),
    },
  };
  const output = f.str("output");
  const dry = f.str("dry-run");
  if (dry === "client" || dry === "server" || output) {
    if (output === "yaml" || output === "json") {
      const shown = { ...hpa, metadata: { ...hpa.metadata }, status: { currentMetrics: null, desiredReplicas: 0 } };
      out(ctx, output === "json" ? JSON.stringify(shown, null, 4) : toYaml(shown).trimEnd());
      return 0;
    }
    if (dry) {
      out(ctx, `horizontalpodautoscaler.autoscaling/${name} autoscaled (dry run)`);
      return 0;
    }
  }
  if (cluster.get("HorizontalPodAutoscaler", name, ns)) throw new KubeError(`Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${name}" already exists`);
  cluster.create(hpa);
  out(ctx, `horizontalpodautoscaler.autoscaling/${name} autoscaled`);
  return 0;
}
