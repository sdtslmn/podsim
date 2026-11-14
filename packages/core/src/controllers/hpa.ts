// A simulated metrics-server and the HorizontalPodAutoscaler controller.

import type { Cluster } from "../cluster.js";
import type { KObject, ContainerSpec } from "../types.js";
import { deepClone, fnv1a, isoTime, parseCpu, parseMemory } from "../util.js";
import { cpuUsageMilli, memoryUsageMi } from "../podruntime.js";

export interface ContainerMetrics {
  name: string;
  cpu: number;
  memMi: number;
}

/** What metrics-server reports for a pod, or undefined while it has no sample yet. */
export function podMetrics(cluster: Cluster, pod: KObject): ContainerMetrics[] | undefined {
  if (pod.status?.phase !== "Running") return undefined;
  const sim = cluster.podSims.get(pod.metadata.uid!);
  const out: ContainerMetrics[] = [];
  const all = [...((pod.spec.initContainers ?? []) as ContainerSpec[]).filter((c) => c.restartPolicy === "Always"), ...(pod.spec.containers as ContainerSpec[])];
  for (const c of all) {
    const cs = sim?.containers[c.name];
    if (!cs || cs.phase !== "running" || cs.runStartedAt === undefined) continue;
    // metrics-server scrapes every 15 seconds.
    if (cluster.now() - cs.runStartedAt < 15000) continue;
    const seed = `${pod.metadata.uid}/${c.name}/${Math.floor(cluster.now() / 15000)}`;
    out.push({ name: c.name, cpu: cpuUsageMilli(c, seed), memMi: Math.max(1, Math.round(memoryUsageMi(c) * (0.9 + (fnv1a(seed) % 20) / 100))) });
  }
  return out.length ? out : undefined;
}

const SRC = { component: "horizontal-pod-autoscaler" };

/** Scale the targets of HorizontalPodAutoscalers from simulated metrics, every 15 seconds. */
export function reconcileHPAs(cluster: Cluster, t: number): void {
  const last = (cluster.scratch.get("hpa-sync") as number | undefined) ?? 0;
  if (t - last < 15000) return;
  cluster.scratch.set("hpa-sync", t);
  for (const hpa of cluster.list("HorizontalPodAutoscaler")) {
    const ns = hpa.metadata.namespace ?? "default";
    const ref = hpa.spec?.scaleTargetRef ?? {};
    const target = ref.kind && ref.name ? cluster.get(ref.kind, ref.name, ns) : undefined;
    const before = JSON.stringify(hpa.status ?? {});
    const min = hpa.spec?.minReplicas ?? 1;
    const max = hpa.spec?.maxReplicas ?? 1;
    const ts = isoTime(t);
    const conditions: Record<string, unknown>[] = [];
    const status: Record<string, unknown> = { currentReplicas: target?.status?.replicas ?? 0, desiredReplicas: target?.spec?.replicas ?? 0 };
    if (!target) {
      conditions.push({ type: "AbleToScale", status: "False", reason: "FailedGetScale", message: `the HPA controller was unable to get the target's current scale: ${String(ref.kind ?? "").toLowerCase()}s.apps "${ref.name}" not found`, lastTransitionTime: ts });
      cluster.recordEvent(hpa, "Warning", "FailedGetScale", `${String(ref.kind ?? "").toLowerCase()}s.apps "${ref.name}" not found`, SRC, t, 60000);
    } else {
      const cur = target.spec?.replicas ?? 1;
      const sel = target.spec?.selector?.matchLabels ?? {};
      const pods = cluster.list("Pod", ns).filter((p) => Object.entries(sel).every(([k, v]) => p.metadata.labels?.[k] === v) && !p.metadata.deletionTimestamp);
      const current: Record<string, unknown>[] = [];
      const proposals: number[] = [];
      let failed = false;
      for (const m of (hpa.spec?.metrics ?? []) as { type: string; resource?: { name: string; target?: { averageUtilization?: number } } }[]) {
        if (m.type !== "Resource" || !m.resource) continue;
        const res = m.resource.name;
        const want = m.resource.target?.averageUtilization ?? 80;
        let usage = 0;
        let request = 0;
        let sampled = 0;
        let missing: string | undefined;
        for (const p of pods) {
          const pm = podMetrics(cluster, p);
          if (!pm) continue;
          sampled++;
          for (const c of p.spec.containers as ContainerSpec[]) {
            const r = (c.resources as { requests?: Record<string, string> } | undefined)?.requests?.[res];
            if (!r) missing = missing ?? `missing request for ${res} in container ${c.name} of Pod ${p.metadata.name}`;
            request += res === "cpu" ? parseCpu(r ?? "0") : parseMemory(r ?? "0") / (1024 * 1024);
            const cm = pm.find((x) => x.name === c.name);
            usage += cm ? (res === "cpu" ? cm.cpu : cm.memMi) : 0;
          }
        }
        if (missing || !sampled) {
          failed = true;
          const msg = missing ? `failed to get ${res} utilization: ${missing}` : `failed to get ${res} utilization: unable to get metrics for resource ${res}: no metrics returned from resource metrics API`;
          conditions.push({ type: "ScalingActive", status: "False", reason: "FailedGetResourceMetric", message: `the HPA was unable to compute the replica count: ${msg}`, lastTransitionTime: ts });
          cluster.recordEvent(hpa, "Warning", "FailedGetResourceMetric", msg, SRC, t, 60000);
          cluster.recordEvent(hpa, "Warning", "FailedComputeMetricsReplicas", `invalid metrics (1 invalid out of 1), first error is: ${msg}`, SRC, t, 60000);
          continue;
        }
        const util = Math.round((usage / request) * 100);
        current.push({ type: "Resource", resource: { name: res, current: { averageUtilization: util, averageValue: res === "cpu" ? `${Math.round(usage / sampled)}m` : `${Math.round(usage / sampled)}Mi` } } });
        const ratio = util / want;
        proposals.push(Math.abs(ratio - 1) <= 0.1 ? cur : Math.ceil(sampled * ratio));
      }
      let desired = proposals.length && !failed ? Math.max(...proposals) : cur;
      desired = Math.min(max, Math.max(min, desired));
      // Scale-down stabilization: use the highest recommendation of the last 5 minutes.
      const key = `hpa-rec/${hpa.metadata.uid}`;
      const recs = ((cluster.scratch.get(key) as { t: number; n: number }[] | undefined) ?? []).filter((r) => t - r.t < 300000);
      recs.push({ t, n: desired });
      cluster.scratch.set(key, recs);
      if (desired < cur) desired = Math.min(cur, Math.max(...recs.map((r) => r.n)));
      status.currentMetrics = current.length ? current : null;
      status.desiredReplicas = desired;
      conditions.unshift({ type: "AbleToScale", status: "True", reason: desired === cur ? "ReadyForNewScale" : "SucceededRescale", message: desired === cur ? "recommended size matches current size" : `the HPA controller was able to update the target scale to ${desired}`, lastTransitionTime: ts });
      if (!failed && proposals.length) conditions.push({ type: "ScalingActive", status: "True", reason: "ValidMetricFound", message: "the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)", lastTransitionTime: ts });
      const limited = desired === max || desired === min;
      conditions.push({ type: "ScalingLimited", status: limited && proposals.some((p) => p > max || p < min) ? "True" : "False", reason: proposals.some((p) => p > max) ? "TooManyReplicas" : proposals.some((p) => p < min) ? "TooFewReplicas" : "DesiredWithinRange", message: "the desired count is within the acceptable range", lastTransitionTime: ts });
      if (desired !== cur) {
        const scaled = deepClone(target);
        scaled.spec.replicas = desired;
        cluster.replace(scaled);
        const why = cur < min ? "Current number of replicas below Spec.MinReplicas" : cur > max ? "Current number of replicas above Spec.MaxReplicas" : desired > cur ? `${current[0] ? (current[0].resource as { name: string }).name : "cpu"} resource utilization (percentage of request) above target` : "All metrics below target";
        cluster.recordEvent(hpa, "Normal", "SuccessfulRescale", `New size: ${desired}; reason: ${why}`, SRC, t);
        status.lastScaleTime = ts;
      }
    }
    status.conditions = conditions;
    hpa.status = { ...(hpa.status?.lastScaleTime && !status.lastScaleTime ? { lastScaleTime: hpa.status.lastScaleTime } : {}), ...status };
    if (JSON.stringify(hpa.status) !== before) cluster.put(hpa);
  }
}
