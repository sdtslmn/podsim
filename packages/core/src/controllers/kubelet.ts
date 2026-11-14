// Kubelet simulation. For every scheduled pod it runs init containers in
// order, starts native sidecars, then walks each app container through
// ContainerCreating -> (ErrImagePull | CreateContainerConfigError | Running)
// -> exit -> CrashLoopBackOff -> Running ... Containers run simulated
// processes (see runtime.ts), so probes, logs, files and servers behave
// like the real thing. The pod status it writes matches a real kubelet's.

import type { Cluster } from "../cluster.js";
import { K8S_VERSION } from "../version.js";
import type { ContainerSpec, KObject } from "../types.js";
import { containerBehavior, parseImage } from "../images.js";
import { fnv1a, isoTime, parseMemory, stableStringify } from "../util.js";
import type { ContainerSim, PodSim, ProbeState } from "./index.js";
import { resolveEnv, identityFor, startProcess, execInContainer, podListener, serveHttp, memoryUsageMi } from "../podruntime.js";

export { resolveEnv };

const SRC = (host: string) => ({ component: "kubelet", host });

type Kind = "init" | "sidecar" | "app" | "ephemeral";

function simFor(cluster: Cluster, pod: KObject): PodSim {
  const uid = pod.metadata.uid!;
  let s = cluster.podSims.get(uid);
  if (!s) {
    s = { containers: {} };
    cluster.podSims.set(uid, s);
  }
  s.emitted = s.emitted ?? {};
  return s;
}

function volumeError(cluster: Cluster, pod: KObject): string | undefined {
  const ns = pod.metadata.namespace ?? "default";
  const missing = (kind: "ConfigMap" | "Secret", name: string, optional?: boolean) => !optional && !cluster.get(kind, name, ns);
  for (const v of pod.spec?.volumes ?? []) {
    if (v.configMap && missing("ConfigMap", v.configMap.name, v.configMap.optional)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
    if (v.secret && missing("Secret", v.secret.secretName, v.secret.optional)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
    for (const src of v.projected?.sources ?? []) {
      if (src.configMap && missing("ConfigMap", src.configMap.name, src.configMap.optional)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${src.configMap.name}" not found`;
      if (src.secret && missing("Secret", src.secret.name, src.secret.optional)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${src.secret.name}" not found`;
    }
  }
  const names = new Set((pod.spec?.volumes ?? []).map((v: { name: string }) => v.name));
  for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
    for (const m of c.volumeMounts ?? []) {
      if (!names.has(m.name)) return `Error: cannot find volume "${m.name}" to mount into container "${c.name}"`;
    }
  }
  return undefined;
}

function backoffDelay(restarts: number): number {
  return restarts === 0 ? 0 : Math.min(300000, 10000 * 2 ** (restarts - 1));
}

function hex(cluster: Cluster, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += cluster.random.int(16).toString(16);
  return out;
}

function digest(image: string): string {
  let out = "";
  for (let i = 0; out.length < 64; i++) out += fnv1a(`${image}#${i}`).toString(16).padStart(8, "0");
  return out.slice(0, 64);
}

function pullSeconds(image: string): string {
  return (0.8 + (fnv1a(image) % 2400) / 1000).toFixed(3);
}

function restartPolicyFor(pod: KObject, kind: Kind): string {
  if (kind === "sidecar") return "Always";
  if (kind === "ephemeral") return "Never";
  const rp = pod.spec.restartPolicy ?? "Always";
  if (kind === "init") return rp === "Never" ? "Never" : "OnFailure";
  return rp;
}

// ------------------------------------------------------------------ probes

interface ProbeSpec {
  exec?: { command: string[] };
  httpGet?: { path?: string; port: number | string; scheme?: string; host?: string };
  tcpSocket?: { port: number | string };
  grpc?: { port: number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
  timeoutSeconds?: number;
}

function probeOf(c: ContainerSpec, which: "startup" | "liveness" | "readiness"): ProbeSpec | undefined {
  return c[`${which}Probe`] as ProbeSpec | undefined;
}

function initProbes(c: ContainerSpec, at: number): ContainerSim["probes"] {
  const mk = (p: ProbeSpec | undefined): ProbeState | undefined => (p ? { next: at + (p.initialDelaySeconds ?? 0) * 1000, failures: 0, successes: 0, ok: false } : undefined);
  return { startup: mk(probeOf(c, "startup")), liveness: mk(probeOf(c, "liveness")), readiness: mk(probeOf(c, "readiness")) };
}

function resolvePort(c: ContainerSpec, port: number | string): number {
  if (typeof port === "number") return port;
  if (/^\d+$/.test(port)) return parseInt(port, 10);
  return (c.ports ?? []).find((p) => p.name === port)?.containerPort ?? -1;
}

function runProbe(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, p: ProbeSpec): { ok: boolean; message: string } {
  const ip = pod.status?.podIP ?? "";
  if (p.exec) {
    const r = execInContainer(cluster, pod, c, cs, p.exec.command ?? []);
    const output = (r.stdout + r.stderr).trim();
    if (r.code === 0) return { ok: true, message: "" };
    if (r.code === 127 && /not found/.test(output)) {
      return { ok: false, message: `rpc error: code = Unknown desc = failed to exec in container: failed to start exec "simulated": OCI runtime exec failed: exec failed: unable to start container process: exec: "${p.exec.command?.[0]}": executable file not found in $PATH: unknown` };
    }
    return { ok: false, message: output || `command ${JSON.stringify(p.exec.command)} exited with ${r.code}` };
  }
  if (p.httpGet) {
    const port = resolvePort(c, p.httpGet.port);
    const path = p.httpGet.path ?? "/";
    const scheme = (p.httpGet.scheme ?? "HTTP").toLowerCase();
    const url = `${scheme}://${p.httpGet.host ?? ip}:${port}${path}`;
    const l = podListener(cluster, pod, port);
    if (!l) return { ok: false, message: `Get "${url}": dial tcp ${ip}:${port}: connect: connection refused` };
    if (scheme === "https") return { ok: false, message: `Get "${url}": http: server gave HTTP response to HTTPS client` };
    const res = serveHttp(cluster, pod, l.container, l.cs, l.server, path, { ip: pod.status?.hostIP ?? "192.168.56.11", agent: `kube-probe/${K8S_VERSION.slice(1).split(".").slice(0, 2).join(".")}` });
    if (!res) return { ok: false, message: `Get "${url}": read tcp ${pod.status?.hostIP ?? "192.168.56.11"}:52344->${ip}:${port}: read: connection reset by peer` };
    if (res.status >= 200 && res.status < 400) return { ok: true, message: "" };
    return { ok: false, message: `HTTP probe failed with statuscode: ${res.status}` };
  }
  if (p.tcpSocket) {
    const port = resolvePort(c, p.tcpSocket.port);
    return podListener(cluster, pod, port) ? { ok: true, message: "" } : { ok: false, message: `dial tcp ${ip}:${port}: connect: connection refused` };
  }
  if (p.grpc) {
    return podListener(cluster, pod, p.grpc.port) ? { ok: true, message: "" } : { ok: false, message: `timeout: failed to connect service ":${p.grpc.port}" within 1s: context deadline exceeded` };
  }
  return { ok: true, message: "" };
}

const LABEL: Record<string, string> = { startup: "Startup", liveness: "Liveness", readiness: "Readiness" };

/** Run due probes. Returns a kill reason when a liveness or startup probe gives up on the container. */
function stepProbes(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, t: number): string | undefined {
  const host = pod.spec.nodeName;
  const probes = cs.probes ?? {};
  const startupDone = !probes.startup || probes.startup.ok;
  for (const which of ["startup", "liveness", "readiness"] as const) {
    const ps = probes[which];
    const spec = probeOf(c, which);
    if (!ps || !spec) continue;
    if (which === "startup" && ps.ok) continue;
    if (which !== "startup" && !startupDone) {
      ps.next = Math.max(ps.next, t);
      continue;
    }
    for (let n = 0; n < 3 && ps.next <= t; n++) {
      const period = (spec.periodSeconds ?? 10) * 1000;
      const at = ps.next;
      ps.next += period;
      const r = runProbe(cluster, pod, c, cs, spec);
      if (r.ok) {
        ps.failures = 0;
        ps.successes++;
        if (ps.successes >= (which === "readiness" ? spec.successThreshold ?? 1 : 1)) ps.ok = true;
        if (which === "startup" && ps.ok) {
          if (probes.liveness) probes.liveness.next = Math.max(probes.liveness.next, at);
          if (probes.readiness) probes.readiness.next = Math.max(probes.readiness.next, at);
          break;
        }
        continue;
      }
      ps.successes = 0;
      ps.failures++;
      ps.lastMessage = r.message;
      cluster.recordEvent(pod, "Warning", "Unhealthy", `${LABEL[which]} probe failed: ${r.message}`, SRC(host), at);
      const threshold = spec.failureThreshold ?? 3;
      if (ps.failures >= threshold) {
        ps.ok = false;
        if (which === "liveness" || which === "startup") {
          cluster.recordEvent(pod, "Normal", "Killing", `Container ${c.name} failed ${which} probe, will be restarted`, SRC(host), at);
          return which;
        }
      }
    }
  }
  return undefined;
}

function containerReady(c: ContainerSpec, cs: ContainerSim): boolean {
  if (cs.phase !== "running") return false;
  const p = cs.probes ?? {};
  if (p.startup && !p.startup.ok) return false;
  if (p.readiness && !p.readiness.ok) return false;
  void c;
  return true;
}

function containerStarted(cs: ContainerSim): boolean {
  if (cs.phase !== "running") return false;
  const p = cs.probes ?? {};
  return !p.startup || p.startup.ok;
}

// ------------------------------------------------------------------ container lifecycle

function killCode(cs: ContainerSim): number {
  for (const s of cs.proc?.listens.values() ?? []) if (s.kind === "nginx" || s.kind === "static") return 0;
  return 137;
}

function step(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, s: PodSim, t: number, createDelay: number, volErr: string | undefined, kind: Kind): void {
  const host = pod.spec.nodeName;
  const rp = restartPolicyFor(pod, kind);
  const once = (key: string, fn: () => void) => {
    const k = `${c.name}/${key}@${cs.createdAt}`;
    if (!s.emitted![k]) {
      s.emitted![k] = true;
      fn();
    }
  };
  const start = (at: number) => {
    const id = identityFor(pod, c);
    if (id.error) {
      cs.phase = "configError";
      cs.message = id.error;
      cluster.recordEvent(pod, "Warning", "Failed", `Error: ${id.error}`, SRC(host), at);
      return;
    }
    cs.phase = "running";
    cs.runStartedAt = at;
    cs.firstStartedAt = cs.firstStartedAt ?? at;
    cs.containerId = `containerd://${hex(cluster, 64)}`;
    cs.exitReason = undefined;
    cs.proc = startProcess(cluster, pod, c, cs, at);
    cs.probes = initProbes(c, at);
    const limit = parseMemory((c.resources?.limits as Record<string, string> | undefined)?.memory);
    cs.oomAt = limit > 0 && memoryUsageMi(c) * 1048576 > limit ? at + 1200 : undefined;
    cluster.recordEvent(pod, "Normal", "Created", `Created container: ${c.name}`, SRC(host), at);
    cluster.recordEvent(pod, "Normal", "Started", `Started container ${c.name}`, SRC(host), at);
    const post = (c.lifecycle as { postStart?: { exec?: { command: string[] } } } | undefined)?.postStart?.exec?.command;
    if (post) {
      cs.proc.advance(at);
      const r = execInContainer(cluster, pod, c, cs, post);
      if (r.code !== 0) {
        cluster.recordEvent(pod, "Warning", "FailedPostStartHook", `PostStartHook failed`, SRC(host), at);
        cs.phase = "exited";
        cs.exitAt = at;
        cs.exitCode = 137;
        cs.exitReason = "Error";
      }
    }
  };

  for (let guard = 0; guard < 20; guard++) {
    switch (cs.phase) {
      case "creating": {
        if (volErr) {
          cluster.recordEvent(pod, "Warning", "FailedMount", volErr, SRC(host), t, 60000);
          return;
        }
        if (t < cs.createdAt + 300) return;
        once("pulling", () => cluster.recordEvent(pod, "Normal", "Pulling", `Pulling image "${c.image}"`, SRC(host), cs.createdAt + 300));
        const probe = containerBehavior(c, {});
        if (probe.type === "pullError") {
          if (t < cs.createdAt + 1500) return;
          cs.phase = "pullError";
          cs.pullFailedAt = cs.createdAt + 1500;
          cs.message = probe.message;
          cluster.recordEvent(pod, "Warning", "Failed", probe.message, SRC(host), cs.pullFailedAt);
          cluster.recordEvent(pod, "Warning", "Failed", "Error: ErrImagePull", SRC(host), cs.pullFailedAt);
          continue;
        }
        const readyAt = cs.createdAt + createDelay;
        if (t < readyAt) return;
        once("pulled", () => {
          const secs = pullSeconds(c.image);
          const cached = (c.imagePullPolicy ?? "IfNotPresent") !== "Always" && pulledBefore(cluster, host, c.image, cs.createdAt);
          cluster.recordEvent(
            pod,
            "Normal",
            "Pulled",
            cached ? `Container image "${c.image}" already present on machine and can be accessed by the pod` : `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${48000000 + (fnv1a(c.image) % 60000000)} bytes.`,
            SRC(host),
            readyAt,
          );
        });
        const envRes = resolveEnv(cluster, pod, c);
        if (envRes.error) {
          cs.phase = "configError";
          cs.message = envRes.error;
          cluster.recordEvent(pod, "Warning", "Failed", `Error: ${envRes.error}`, SRC(host), readyAt);
          continue;
        }
        start(readyAt);
        continue;
      }
      case "configError": {
        const envRes = resolveEnv(cluster, pod, c);
        const id = identityFor(pod, c);
        const error = envRes.error ?? id.error;
        if (error) {
          cs.message = error;
          cluster.recordEvent(pod, "Warning", "Failed", `Error: ${error}`, SRC(host), t, 30000);
          return;
        }
        start(t);
        continue;
      }
      case "pullError": {
        cluster.recordEvent(pod, "Normal", "BackOff", `Back-off pulling image "${c.image}"`, SRC(host), t, 30000);
        cluster.recordEvent(pod, "Warning", "Failed", "Error: ImagePullBackOff", SRC(host), t, 30000);
        return;
      }
      case "running": {
        const proc = cs.proc!;
        const until = cs.oomAt !== undefined ? Math.min(t, cs.oomAt) : t;
        proc.advance(until);
        if (proc.exited && proc.exitAt <= until) {
          cs.phase = "exited";
          cs.exitAt = proc.exitAt;
          cs.exitCode = proc.exitCode;
          cs.exitReason = proc.exitCode === 0 ? "Completed" : "Error";
          continue;
        }
        if (cs.oomAt !== undefined && t >= cs.oomAt) {
          cs.phase = "exited";
          cs.exitAt = cs.oomAt;
          cs.exitCode = 137;
          cs.exitReason = "OOMKilled";
          continue;
        }
        const killed = stepProbes(cluster, pod, c, cs, t);
        if (killed) {
          cs.phase = "exited";
          cs.exitAt = t;
          cs.exitCode = killCode(cs);
          cs.exitReason = cs.exitCode === 0 ? "Completed" : "Error";
          cs.killedBy = killed;
          continue;
        }
        return;
      }
      case "exited": {
        const code = cs.exitCode ?? 0;
        cs.prevLines = (cs.proc?.logLines() ?? []).map((l) => l.text);
        if (rp === "Never" || (rp === "OnFailure" && code === 0)) {
          cs.phase = "terminated";
          return;
        }
        cs.lastTerminated = { exitCode: code, reason: cs.exitReason ?? (code === 0 ? "Completed" : "Error"), startedAt: cs.runStartedAt!, finishedAt: cs.exitAt! };
        const delay = cs.killedBy ? 0 : backoffDelay(cs.restarts);
        cs.killedBy = undefined;
        cs.restarts++;
        cs.backoffUntil = cs.exitAt! + delay;
        cs.phase = "backoff";
        if (delay > 0) {
          cluster.recordEvent(pod, "Warning", "BackOff", `Back-off restarting failed container ${c.name} in pod ${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`, SRC(host), cs.exitAt!);
        }
        continue;
      }
      case "backoff": {
        if (t >= cs.backoffUntil!) {
          start(cs.backoffUntil!);
          continue;
        }
        return;
      }
      case "terminated":
        return;
    }
  }
}

function pulledBefore(cluster: Cluster, node: string, image: string, at: number): boolean {
  const key = `img/${node}/${image}`;
  const first = cluster.scratch.get(key) as number | undefined;
  if (first === undefined) {
    cluster.scratch.set(key, at);
    return false;
  }
  return first < at;
}

function imageRef(image: string): string {
  const p = parseImage(image);
  return p.registry === "docker.io" ? `docker.io/library/${p.repository}:${p.tag}` : `${p.registry}/${p.repository}:${p.tag}`;
}

function containerStatus(pod: KObject, c: ContainerSpec, cs: ContainerSim | undefined, t: number, kind: Kind): Record<string, unknown> {
  if (!cs) {
    return { name: c.name, image: imageRef(c.image), imageID: "", ready: false, started: false, restartCount: 0, state: { waiting: { reason: "PodInitializing" } }, lastState: {} };
  }
  let state: Record<string, unknown>;
  switch (cs.phase) {
    case "creating":
      state = { waiting: { reason: kind === "app" ? "ContainerCreating" : "PodInitializing" } };
      if (kind === "app") state = { waiting: { reason: "ContainerCreating" } };
      break;
    case "configError":
      state = { waiting: { reason: "CreateContainerConfigError", message: cs.message } };
      break;
    case "pullError":
      state =
        t - (cs.pullFailedAt ?? t) < 5000
          ? { waiting: { reason: "ErrImagePull", message: cs.message } }
          : { waiting: { reason: "ImagePullBackOff", message: `Back-off pulling image "${c.image}": ErrImagePull: ${cs.message}` } };
      break;
    case "running":
      state = { running: { startedAt: isoTime(cs.runStartedAt!) } };
      break;
    case "backoff": {
      const delay = Math.round((cs.backoffUntil! - cs.exitAt!) / 1000);
      state =
        delay > 0
          ? { waiting: { reason: "CrashLoopBackOff", message: `back-off ${delay}s restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})` } }
          : { terminated: { exitCode: cs.exitCode, reason: cs.exitReason ?? (cs.exitCode === 0 ? "Completed" : "Error"), startedAt: isoTime(cs.runStartedAt!), finishedAt: isoTime(cs.exitAt!) } };
      break;
    }
    case "exited":
    case "terminated":
      state = {
        terminated: {
          exitCode: cs.exitCode,
          reason: cs.exitReason ?? (cs.exitCode === 0 ? "Completed" : "Error"),
          startedAt: isoTime(cs.runStartedAt ?? t),
          finishedAt: isoTime(cs.exitAt ?? t),
          containerID: cs.containerId,
        },
      };
      break;
  }
  const pulled = cs.firstStartedAt !== undefined || cs.phase === "configError";
  const ready = kind === "init" ? cs.phase === "terminated" && cs.exitCode === 0 : containerReady(c, cs);
  const out: Record<string, unknown> = {
    name: c.name,
    image: imageRef(c.image),
    imageID: pulled ? `${imageRef(c.image).replace(/:[^:/]+$/, "")}@sha256:${digest(c.image)}` : "",
    ready,
    started: kind === "init" ? cs.phase === "running" : containerStarted(cs),
    restartCount: cs.restarts,
    state,
    lastState: cs.lastTerminated
      ? {
          terminated: {
            exitCode: cs.lastTerminated.exitCode,
            reason: cs.lastTerminated.reason,
            startedAt: isoTime(cs.lastTerminated.startedAt),
            finishedAt: isoTime(cs.lastTerminated.finishedAt),
          },
        }
      : {},
  };
  if (kind === "sidecar") out.restartPolicy = "Always";
  if (cs.containerId && cs.phase !== "creating" && cs.phase !== "pullError" && cs.phase !== "configError") out.containerID = cs.containerId;
  return out;
}

function condition(existing: { type: string; status: string; lastTransitionTime?: string }[] | undefined, type: string, status: string, t: number, extra: Record<string, unknown> = {}) {
  const old = (existing ?? []).find((c) => c.type === type);
  const lastTransitionTime = old && old.status === status ? old.lastTransitionTime : isoTime(t);
  return { type, status, lastProbeTime: null, lastTransitionTime, ...extra };
}

function ensure(s: PodSim, c: ContainerSpec, at: number): ContainerSim {
  let cs = s.containers[c.name];
  if (!cs) {
    cs = { image: c.image, createdAt: at, phase: "creating", restarts: 0 };
    s.containers[c.name] = cs;
  }
  return cs;
}

export function runKubelet(cluster: Cluster, t: number): void {
  for (const pod of cluster.list("Pod")) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue;
    const node = cluster.get("Node", nodeName);
    if (!node) continue;
    const s = simFor(cluster, pod);
    if (s.scheduledAt === undefined) s.scheduledAt = t;
    if (t < s.scheduledAt) continue;
    const terminal = pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed";
    if (terminal && s.containers && Object.keys(s.containers).length && !pod.metadata.deletionTimestamp) {
      // Finished pods keep their final status.
      continue;
    }
    const createDelay = 1500 + (fnv1a(pod.metadata.uid ?? pod.metadata.name) % 2000);
    const volErr = volumeError(cluster, pod);
    const before = stableStringify(pod.status);

    // Pod IP is assigned once the sandbox exists.
    const hostIP = node.status.addresses.find((a: { type: string }) => a.type === "InternalIP")?.address;
    if (!s.fixedIp && t >= s.scheduledAt + 500 && !volErr) s.fixedIp = cluster.nextPodIp(nodeName);
    if (s.fixedIp && !pod.status?.podIP) pod.status = { ...(pod.status ?? {}), podIP: s.fixedIp, hostIP };

    // Init containers, in order. Native sidecars (restartPolicy: Always) keep running.
    const inits = (pod.spec.initContainers ?? []) as ContainerSpec[];
    let initDone = true;
    let initFailed = false;
    let createAt = s.scheduledAt;
    for (const ic of inits) {
      const kind: Kind = ic.restartPolicy === "Always" ? "sidecar" : "init";
      const cs = ensure(s, ic, createAt);
      if (cs.image !== ic.image && kind === "sidecar") {
        cs.image = ic.image;
        cs.createdAt = t;
        cs.phase = "creating";
      }
      step(cluster, pod, ic, cs, s, t, createDelay, volErr, kind);
      if (kind === "init") {
        if (cs.phase === "terminated" && cs.exitCode === 0) {
          createAt = cs.exitAt ?? t;
          continue;
        }
        if (cs.phase === "terminated") initFailed = true;
        initDone = false;
        break;
      }
      if (containerStarted(cs)) {
        createAt = Math.max(createAt, cs.runStartedAt ?? t);
        continue;
      }
      initDone = false;
      break;
    }

    const apps = pod.spec.containers as ContainerSpec[];
    if (initDone && !initFailed) {
      for (const c of apps) {
        const cs = ensure(s, c, inits.length ? Math.max(createAt, t - 1000) : s.scheduledAt);
        if (cs.image !== c.image) {
          if (cs.phase === "running") {
            cluster.recordEvent(pod, "Normal", "Killing", `Container ${c.name} definition changed, will be restarted`, SRC(nodeName), t);
            cs.lastTerminated = { exitCode: 0, reason: "Completed", startedAt: cs.runStartedAt!, finishedAt: t };
            cs.prevLines = (cs.proc?.logLines() ?? []).map((l) => l.text);
            cs.restarts++;
          }
          cs.image = c.image;
          cs.createdAt = t;
          cs.phase = "creating";
        }
        step(cluster, pod, c, cs, s, t, createDelay, volErr, "app");
      }
    }

    // Ephemeral containers (kubectl debug) start as soon as they are added.
    const ephemeral = (pod.spec.ephemeralContainers ?? []) as ContainerSpec[];
    for (const ec of ephemeral) {
      const cs = ensure(s, ec, Math.max(s.scheduledAt, t - 1000));
      step(cluster, pod, ec, cs, s, t, 800, undefined, "ephemeral");
    }

    const appSims = apps.map((c) => s.containers[c.name]);
    const sidecars = inits.filter((ic) => ic.restartPolicy === "Always");
    let phase = "Pending";
    if (initFailed) phase = "Failed";
    else if (initDone && appSims.every(Boolean)) {
      const css = appSims as ContainerSim[];
      const everStarted = css.some((cs) => cs.firstStartedAt !== undefined);
      const allTerminated = css.every((cs) => cs.phase === "terminated");
      if (allTerminated) phase = css.every((cs) => cs.exitCode === 0) ? "Succeeded" : "Failed";
      else if (everStarted && css.some((cs) => cs.phase === "running" || cs.phase === "backoff" || cs.phase === "exited" || cs.firstStartedAt !== undefined)) phase = "Running";
    }
    if (phase === "Succeeded" || phase === "Failed") {
      for (const sc of sidecars) {
        const cs = s.containers[sc.name];
        if (cs && cs.phase !== "terminated") {
          cs.phase = "terminated";
          cs.exitAt = t;
          cs.exitCode = 0;
          cs.exitReason = "Completed";
        }
      }
    }

    const statuses = apps.map((c) => containerStatus(pod, c, s.containers[c.name], t, "app"));
    const initStatuses = inits.map((ic) => containerStatus(pod, ic, s.containers[ic.name], t, ic.restartPolicy === "Always" ? "sidecar" : "init"));
    const readyApps = apps.every((c) => s.containers[c.name] && containerReady(c, s.containers[c.name]));
    const readySidecars = sidecars.every((c) => s.containers[c.name] && containerReady(c, s.containers[c.name]));
    const ready = initDone && readyApps && readySidecars && phase === "Running";
    const notReady = [...sidecars, ...apps].filter((c) => !(s.containers[c.name] && containerReady(c, s.containers[c.name]))).map((c) => c.name);
    const terminalReason = phase === "Succeeded" || phase === "Failed" ? "PodCompleted" : "ContainersNotReady";
    const readyExtra = ready ? {} : { reason: terminalReason, message: terminalReason === "ContainersNotReady" ? `containers with unready status: [${notReady.join(" ")}]` : undefined };
    const incomplete = inits.filter((ic) => {
      const cs = s.containers[ic.name];
      if (!cs) return true;
      return ic.restartPolicy === "Always" ? !containerStarted(cs) : !(cs.phase === "terminated" && cs.exitCode === 0);
    });
    const existing = pod.status?.conditions;
    const conditions = [
      condition(existing, "PodReadyToStartContainers", s.fixedIp ? "True" : "False", t),
      condition(existing, "Initialized", initDone ? "True" : "False", t, initDone ? {} : { reason: "ContainersNotInitialized", message: `containers with incomplete status: [${incomplete.map((c) => c.name).join(" ")}]` }),
      condition(existing, "Ready", ready ? "True" : "False", t, readyExtra),
      condition(existing, "ContainersReady", ready ? "True" : "False", t, readyExtra),
      condition(existing, "PodScheduled", "True", t),
    ].map((c) => JSON.parse(JSON.stringify(c)));

    pod.status = {
      phase,
      conditions,
      hostIP,
      hostIPs: hostIP ? [{ ip: hostIP }] : undefined,
      podIP: s.fixedIp,
      podIPs: s.fixedIp ? [{ ip: s.fixedIp }] : undefined,
      startTime: isoTime(s.scheduledAt),
      ...(inits.length ? { initContainerStatuses: initStatuses } : {}),
      containerStatuses: statuses,
      ...(ephemeral.length ? { ephemeralContainerStatuses: ephemeral.map((ec) => containerStatus(pod, ec, s.containers[ec.name], t, "ephemeral")) } : {}),
      qosClass: pod.status?.qosClass ?? "BestEffort",
    };
    pod.status = JSON.parse(JSON.stringify(pod.status));
    if (stableStringify(pod.status) !== before) cluster.put(pod);
  }
}

/** Logs for one container, or the error kubectl would print. */
export function containerLogs(cluster: Cluster, pod: KObject, name: string, previous: boolean): { lines?: string[]; times?: number[]; error?: string } {
  const s = cluster.podSims.get(pod.metadata.uid!);
  const cs = s?.containers[name];
  const waiting = (reason: string) => ({
    error: `Error from server (BadRequest): container "${name}" in pod "${pod.metadata.name}" is waiting to start: ${reason}`,
  });
  if (previous) {
    if (!cs?.lastTerminated) {
      return { error: `Error from server (BadRequest): previous terminated container "${name}" in pod "${pod.metadata.name}" not found` };
    }
    return { lines: cs.prevLines ?? [] };
  }
  const isInit = (pod.spec.initContainers ?? []).some((c: ContainerSpec) => c.name === name);
  if (!cs) return waiting(isInit ? "PodInitializing" : "PodInitializing");
  if (cs.phase === "creating") return waiting("ContainerCreating");
  if (cs.phase === "pullError") return waiting("trying and failing to pull image");
  if (cs.phase === "configError") return waiting("CreateContainerConfigError");
  if (cs.phase === "backoff" && cs.prevLines) return { lines: cs.prevLines };
  const lines = cs.proc?.logLines() ?? [];
  return { lines: lines.map((l) => l.text), times: lines.map((l) => l.t) };
}
