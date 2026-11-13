// Kubelet simulation. For every scheduled pod it walks each container
// through: ContainerCreating -> (ErrImagePull | CreateContainerConfigError
// | Running) -> exit -> CrashLoopBackOff -> Running ... and writes a pod
// status that matches what a real kubelet would report.

import type { Cluster } from "../cluster.js";
import { fromBase64 } from "../cluster.js";
import type { ContainerSpec, KObject } from "../types.js";
import { containerBehavior, parseImage, type Behavior } from "../images.js";
import { fnv1a, isoTime, stableStringify } from "../util.js";
import type { ContainerSim, PodSim } from "./index.js";

const SRC = (host: string) => ({ component: "kubelet", host });

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

/** Resolve env and envFrom the way the kubelet does, or report the error it would raise. */
export function resolveEnv(cluster: Cluster, pod: KObject, c: ContainerSpec): { env: Record<string, string>; error?: string } {
  const ns = pod.metadata.namespace ?? "default";
  const env: Record<string, string> = {};
  for (const from of c.envFrom ?? []) {
    const f = from as { configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean }; prefix?: string };
    if (f.configMapRef) {
      const cm = cluster.get("ConfigMap", f.configMapRef.name, ns);
      if (!cm) {
        if (f.configMapRef.optional) continue;
        return { env, error: `configmap "${f.configMapRef.name}" not found` };
      }
      for (const [k, v] of Object.entries((cm.data as Record<string, string>) ?? {})) env[(f.prefix ?? "") + k] = String(v);
    }
    if (f.secretRef) {
      const sec = cluster.get("Secret", f.secretRef.name, ns);
      if (!sec) {
        if (f.secretRef.optional) continue;
        return { env, error: `secret "${f.secretRef.name}" not found` };
      }
      for (const [k, v] of Object.entries((sec.data as Record<string, string>) ?? {})) env[(f.prefix ?? "") + k] = fromBase64(String(v));
    }
  }
  for (const e of c.env ?? []) {
    if (e.value !== undefined) {
      env[e.name] = String(e.value);
      continue;
    }
    const vf = e.valueFrom as
      | {
          configMapKeyRef?: { name: string; key: string; optional?: boolean };
          secretKeyRef?: { name: string; key: string; optional?: boolean };
          fieldRef?: { fieldPath: string };
        }
      | undefined;
    if (!vf) {
      env[e.name] = "";
      continue;
    }
    if (vf.configMapKeyRef) {
      const ref = vf.configMapKeyRef;
      const cm = cluster.get("ConfigMap", ref.name, ns);
      if (!cm) {
        if (ref.optional) continue;
        return { env, error: `configmap "${ref.name}" not found` };
      }
      const data = (cm.data as Record<string, string>) ?? {};
      if (!(ref.key in data)) {
        if (ref.optional) continue;
        return { env, error: `couldn't find key ${ref.key} in ConfigMap ${ns}/${ref.name}` };
      }
      env[e.name] = String(data[ref.key]);
    } else if (vf.secretKeyRef) {
      const ref = vf.secretKeyRef;
      const sec = cluster.get("Secret", ref.name, ns);
      if (!sec) {
        if (ref.optional) continue;
        return { env, error: `secret "${ref.name}" not found` };
      }
      const data = (sec.data as Record<string, string>) ?? {};
      if (!(ref.key in data)) {
        if (ref.optional) continue;
        return { env, error: `couldn't find key ${ref.key} in Secret ${ns}/${ref.name}` };
      }
      env[e.name] = fromBase64(String(data[ref.key]));
    } else if (vf.fieldRef) {
      const fields: Record<string, string | undefined> = {
        "metadata.name": pod.metadata.name,
        "metadata.namespace": ns,
        "metadata.uid": pod.metadata.uid,
        "spec.nodeName": pod.spec?.nodeName,
        "spec.serviceAccountName": pod.spec?.serviceAccountName,
        "status.podIP": pod.status?.podIP,
        "status.hostIP": pod.status?.hostIP,
      };
      env[e.name] = fields[vf.fieldRef.fieldPath] ?? "";
    }
  }
  return { env };
}

function volumeError(cluster: Cluster, pod: KObject): string | undefined {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (v.configMap && !v.configMap.optional && !cluster.get("ConfigMap", v.configMap.name, ns)) {
      return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
    }
    if (v.secret && !v.secret.optional && !cluster.get("Secret", v.secret.secretName, ns)) {
      return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
    }
  }
  const names = new Set((pod.spec?.volumes ?? []).map((v: { name: string }) => v.name));
  for (const c of pod.spec?.containers ?? []) {
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

function step(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, s: PodSim, t: number, createDelay: number, volErr: string | undefined): void {
  const host = pod.spec.nodeName;
  const rp = pod.spec.restartPolicy ?? "Always";
  const once = (key: string, fn: () => void) => {
    const k = `${key}@${cs.createdAt}`;
    if (!s.emitted![k]) {
      s.emitted![k] = true;
      fn();
    }
  };
  const start = (at: number) => {
    cs.phase = "running";
    cs.runStartedAt = at;
    cs.firstStartedAt = cs.firstStartedAt ?? at;
    cs.containerId = `containerd://${hex(cluster, 64)}`;
    cluster.recordEvent(pod, "Normal", "Created", `Created container: ${c.name}`, SRC(host), at);
    cluster.recordEvent(pod, "Normal", "Started", `Started container ${c.name}`, SRC(host), at);
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
          cluster.recordEvent(pod, "Normal", "Pulled", `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${48000000 + (fnv1a(c.image) % 60000000)} bytes.`, SRC(host), readyAt);
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
        if (envRes.error) {
          cs.message = envRes.error;
          cluster.recordEvent(pod, "Warning", "Failed", `Error: ${envRes.error}`, SRC(host), t, 30000);
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
        const b = containerBehavior(c, resolveEnv(cluster, pod, c).env);
        if (b.type === "exit" && t >= cs.runStartedAt! + b.afterMs) {
          cs.phase = "exited";
          cs.exitAt = cs.runStartedAt! + b.afterMs;
          cs.exitCode = b.code;
          continue;
        }
        return;
      }
      case "exited": {
        const code = cs.exitCode ?? 0;
        if (rp === "Never" || (rp === "OnFailure" && code === 0)) {
          cs.phase = "terminated";
          return;
        }
        cs.lastTerminated = { exitCode: code, reason: code === 0 ? "Completed" : "Error", startedAt: cs.runStartedAt!, finishedAt: cs.exitAt! };
        const delay = backoffDelay(cs.restarts);
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

function imageRef(image: string): string {
  const p = parseImage(image);
  return p.registry === "docker.io" ? `docker.io/library/${p.repository}:${p.tag}` : `${p.registry}/${p.repository}:${p.tag}`;
}

function containerStatus(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, t: number): Record<string, unknown> {
  const started = ["running"].includes(cs.phase);
  let state: Record<string, unknown>;
  switch (cs.phase) {
    case "creating":
      state = { waiting: { reason: "ContainerCreating" } };
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
          : { terminated: { exitCode: cs.exitCode, reason: cs.exitCode === 0 ? "Completed" : "Error", startedAt: isoTime(cs.runStartedAt!), finishedAt: isoTime(cs.exitAt!) } };
      break;
    }
    case "exited":
    case "terminated":
      state = {
        terminated: {
          exitCode: cs.exitCode,
          reason: cs.exitCode === 0 ? "Completed" : "Error",
          startedAt: isoTime(cs.runStartedAt!),
          finishedAt: isoTime(cs.exitAt!),
          containerID: cs.containerId,
        },
      };
      break;
  }
  const pulled = cs.firstStartedAt !== undefined || cs.phase === "configError";
  const out: Record<string, unknown> = {
    name: c.name,
    image: imageRef(c.image),
    imageID: pulled ? `${imageRef(c.image).replace(/:[^:/]+$/, "")}@sha256:${digest(c.image)}` : "",
    ready: started,
    started,
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
  if (cs.containerId && cs.phase !== "creating" && cs.phase !== "pullError" && cs.phase !== "configError") out.containerID = cs.containerId;
  return out;
}

function condition(existing: { type: string; status: string; lastTransitionTime?: string }[] | undefined, type: string, status: string, t: number, extra: Record<string, unknown> = {}) {
  const old = (existing ?? []).find((c) => c.type === type);
  const lastTransitionTime = old && old.status === status ? old.lastTransitionTime : isoTime(t);
  return { type, status, lastProbeTime: null, lastTransitionTime, ...extra };
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
    const createDelay = 1500 + (fnv1a(pod.metadata.uid ?? pod.metadata.name) % 2000);
    const volErr = volumeError(cluster, pod);
    const before = stableStringify(pod.status);

    for (const c of pod.spec.containers as ContainerSpec[]) {
      let cs = s.containers[c.name];
      if (!cs) {
        cs = { image: c.image, createdAt: s.scheduledAt, phase: "creating", restarts: 0 };
        s.containers[c.name] = cs;
      }
      if (cs.image !== c.image) {
        if (cs.phase === "running") {
          cluster.recordEvent(pod, "Normal", "Killing", `Container ${c.name} definition changed, will be restarted`, SRC(nodeName), t);
          cs.lastTerminated = { exitCode: 0, reason: "Completed", startedAt: cs.runStartedAt!, finishedAt: t };
          cs.restarts++;
        }
        cs.image = c.image;
        cs.createdAt = t;
        cs.phase = "creating";
      }
      step(cluster, pod, c, cs, s, t, createDelay, volErr);
    }

    // Pod IP is assigned once the sandbox exists.
    const hostIP = node.status.addresses.find((a: { type: string }) => a.type === "InternalIP")?.address;
    if (!s.fixedIp && t >= s.scheduledAt + 500 && !volErr) s.fixedIp = cluster.nextPodIp(nodeName);

    const css = (pod.spec.containers as ContainerSpec[]).map((c) => s.containers[c.name]);
    const statuses = (pod.spec.containers as ContainerSpec[]).map((c, i) => containerStatus(cluster, pod, c, css[i], t));
    const everStarted = css.some((cs) => cs.firstStartedAt !== undefined);
    const allTerminated = css.every((cs) => cs.phase === "terminated");
    let phase = "Pending";
    if (allTerminated) phase = css.every((cs) => cs.exitCode === 0) ? "Succeeded" : "Failed";
    else if (everStarted && css.every((cs) => cs.firstStartedAt !== undefined || cs.phase === "running")) phase = "Running";
    else if (everStarted && css.some((cs) => cs.phase === "running" || cs.phase === "backoff")) phase = "Running";

    const ready = css.every((cs) => cs.phase === "running");
    const notReady = (pod.spec.containers as ContainerSpec[]).filter((_, i) => css[i].phase !== "running").map((c) => c.name);
    const terminalReason = phase === "Succeeded" || phase === "Failed" ? "PodCompleted" : "ContainersNotReady";
    const readyExtra = ready ? {} : { reason: terminalReason, message: terminalReason === "ContainersNotReady" ? `containers with unready status: [${notReady.join(" ")}]` : undefined };
    const existing = pod.status?.conditions;
    const conditions = [
      condition(existing, "PodReadyToStartContainers", s.fixedIp ? "True" : "False", t),
      condition(existing, "Initialized", "True", t),
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
      containerStatuses: statuses,
      qosClass: pod.status?.qosClass ?? "BestEffort",
    };
    pod.status = JSON.parse(JSON.stringify(pod.status));
    if (stableStringify(pod.status) !== before) cluster.put(pod);
  }
}

/** Logs for one container, or the error kubectl would print. */
export function containerLogs(cluster: Cluster, pod: KObject, name: string, previous: boolean): { lines?: string[]; error?: string } {
  const s = cluster.podSims.get(pod.metadata.uid!);
  const cs = s?.containers[name];
  const c = (pod.spec.containers as ContainerSpec[]).find((x) => x.name === name)!;
  const waiting = (reason: string) => ({
    error: `Error from server (BadRequest): container "${name}" in pod "${pod.metadata.name}" is waiting to start: ${reason}`,
  });
  if (previous) {
    if (!cs?.lastTerminated) {
      return { error: `Error from server (BadRequest): previous terminated container "${name}" in pod "${pod.metadata.name}" not found` };
    }
    const b = containerBehavior(c, resolveEnv(cluster, pod, c).env);
    return { lines: logsOf(b, cs.lastTerminated.finishedAt - cs.lastTerminated.startedAt) };
  }
  if (!cs || cs.phase === "creating") return waiting("ContainerCreating");
  if (cs.phase === "pullError") return waiting("trying and failing to pull image");
  if (cs.phase === "configError") return waiting("CreateContainerConfigError");
  const b = containerBehavior(c, resolveEnv(cluster, pod, c).env);
  if (cs.phase === "running") return { lines: logsOf(b, cluster.now() - cs.runStartedAt!) };
  return { lines: logsOf(b, (cs.exitAt ?? cluster.now()) - (cs.runStartedAt ?? cluster.now())) };
}

function logsOf(b: Behavior, elapsed: number): string[] {
  if (b.type === "pullError") return [];
  return b.logs(Math.max(0, elapsed));
}
