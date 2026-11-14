// Controllers for Jobs, CronJobs, DaemonSets and StatefulSets. Each one
// follows the real controller's rules closely enough that the pods,
// statuses and events look the same as on a real cluster.

import type { Cluster } from "../cluster.js";
import { defaultPodSpec } from "../cluster.js";
import type { KObject } from "../types.js";
import { deepClone, isoTime, parseTime, stableStringify } from "../util.js";
import { isPodReady, ownedBy, templateHash } from "./deployment.js";
import { matchNodeSelectorTerm, tolerates, type NodeSelectorTerm } from "./scheduler.js";
import { parseSchedule, lastRunBetween } from "../cron.js";

const isActive = (p: KObject) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed" && !p.metadata.deletionTimestamp;
const isRunningReady = (p: KObject) => p.status?.phase === "Running" && isPodReady(p);

function ownerRef(owner: KObject) {
  return { apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid!, controller: true, blockOwnerDeletion: true };
}

function setStatus(cluster: Cluster, obj: KObject, status: Record<string, unknown>): void {
  for (const k of Object.keys(status)) if (status[k] === undefined) delete status[k];
  if (stableStringify(status) !== stableStringify(obj.status)) {
    obj.status = status;
    cluster.put(obj);
  }
}

/** Build a pod from a template, owned by `owner`. */
export function podFromTemplate(cluster: Cluster, owner: KObject, template: KObject["spec"], name: string, t: number, extraLabels: Record<string, string> = {}, generateName?: string): KObject {
  const tpl = deepClone(template ?? {});
  const spec = tpl.spec ?? {};
  defaultPodSpec(spec);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      ...(generateName ? { generateName } : {}),
      namespace: owner.metadata.namespace,
      uid: cluster.random.uid(),
      creationTimestamp: isoTime(t),
      generation: 1,
      labels: { ...(tpl.metadata?.labels ?? {}), ...extraLabels },
      ...(tpl.metadata?.annotations ? { annotations: { ...tpl.metadata.annotations } } : {}),
      ownerReferences: [ownerRef(owner)],
    },
    spec,
    status: { phase: "Pending", qosClass: "BestEffort" },
  };
}

function finishedAt(pod: KObject): number {
  let last = parseTime(pod.metadata.creationTimestamp);
  for (const cs of pod.status?.containerStatuses ?? []) {
    const f = parseTime(cs.state?.terminated?.finishedAt);
    if (f > last) last = f;
  }
  return last;
}

function cond(type: string, status: string, reason: string, message: string, t: number) {
  return { type, status, reason, message, lastProbeTime: isoTime(t), lastTransitionTime: isoTime(t) };
}

// ------------------------------------------------------------------ Job

export function jobFinished(job: KObject): "Complete" | "Failed" | undefined {
  for (const c of job.status?.conditions ?? []) {
    if (c.status === "True" && (c.type === "Complete" || c.type === "Failed")) return c.type;
  }
  return undefined;
}

export function reconcileJobs(cluster: Cluster, t: number): void {
  for (const job of cluster.list("Job")) {
    const ns = job.metadata.namespace!;
    const spec = job.spec;
    const pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, job));
    const finished = jobFinished(job);
    if (finished) {
      const ttl = spec.ttlSecondsAfterFinished;
      const doneAt = parseTime(job.status?.completionTime) || parseTime(job.status?.conditions?.find((c: { type: string }) => c.type === finished)?.lastTransitionTime);
      if (ttl !== undefined && t >= doneAt + ttl * 1000) cluster.remove("Job", job.metadata.name, ns);
      continue;
    }
    const status: Record<string, unknown> = { ...(job.status ?? {}) };
    if (spec.suspend) {
      for (const p of pods.filter(isActive)) cluster.remove("Pod", p.metadata.name, ns);
      setStatus(cluster, job, { ...status, active: undefined, conditions: [cond("Suspended", "True", "JobSuspended", "Job suspended", t)] });
      continue;
    }
    if (!status.startTime) status.startTime = isoTime(t);
    const succeededPods = pods.filter((p) => p.status?.phase === "Succeeded");
    const failedPods = pods.filter((p) => p.status?.phase === "Failed");
    const active = pods.filter(isActive);
    const restarts = spec.template?.spec?.restartPolicy === "OnFailure" ? pods.reduce((n, p) => n + (p.status?.containerStatuses ?? []).reduce((m: number, c: { restartCount?: number }) => m + (c.restartCount ?? 0), 0), 0) : 0;
    const failures = failedPods.length + restarts;
    const completions: number | undefined = spec.completions ?? undefined;
    const parallelism: number = spec.parallelism ?? 1;
    const backoffLimit: number = spec.backoffLimit ?? 6;
    const succeeded = succeededPods.length;
    const ready = active.filter(isPodReady).length;

    const finish = (type: "Complete" | "Failed", reason: string, message: string) => {
      for (const p of active) cluster.remove("Pod", p.metadata.name, ns);
      const conditions =
        type === "Complete"
          ? [cond("SuccessCriteriaMet", "True", reason, message, t), cond("Complete", "True", reason, message, t)]
          : [cond("FailureTarget", "True", reason, message, t), cond("Failed", "True", reason, message, t)];
      setStatus(cluster, job, {
        ...status,
        active: undefined,
        ready: 0,
        terminating: 0,
        succeeded: succeeded || undefined,
        failed: failures || undefined,
        completionTime: type === "Complete" ? isoTime(t) : undefined,
        conditions,
        uncountedTerminatedPods: {},
      });
      if (type === "Complete") cluster.recordEvent(job, "Normal", "Completed", "Job completed", { component: "job-controller" }, t);
      else cluster.recordEvent(job, "Warning", reason, message, { component: "job-controller" }, t);
    };

    const target = completions ?? 1;
    const workQueueDone = completions === undefined && succeeded > 0 && active.length === 0;
    if ((completions !== undefined && succeeded >= target) || (completions === undefined && parallelism <= 1 && succeeded >= 1) || workQueueDone) {
      finish("Complete", "CompletionsReached", "Reached expected number of succeeded pods");
      continue;
    }
    if (failures > backoffLimit) {
      finish("Failed", "BackoffLimitExceeded", "Job has reached the specified backoff limit");
      continue;
    }
    if (spec.activeDeadlineSeconds !== undefined && t - parseTime(String(status.startTime)) >= spec.activeDeadlineSeconds * 1000) {
      finish("Failed", "DeadlineExceeded", "Job was active longer than specified deadline");
      continue;
    }

    // Create pods up to parallelism, respecting the failure backoff.
    const remaining = completions !== undefined ? target - succeeded - active.length : succeeded > 0 ? 0 : parallelism - active.length;
    const want = Math.max(0, Math.min(parallelism - active.length, remaining));
    let canCreateAt = 0;
    if (failedPods.length > 0) {
      const lastFail = Math.max(...failedPods.map(finishedAt));
      canCreateAt = lastFail + Math.min(360000, 10000 * 2 ** (failedPods.length - 1));
    }
    if (want > 0 && t >= canCreateAt) {
      const indexed = spec.completionMode === "Indexed";
      const used = new Set([...succeededPods, ...active].map((p) => p.metadata.annotations?.["batch.kubernetes.io/job-completion-index"]));
      for (let i = 0; i < want; i++) {
        let index: number | undefined;
        if (indexed) {
          for (let k = 0; k < target; k++) if (!used.has(String(k))) {
            index = k;
            used.add(String(k));
            break;
          }
          if (index === undefined) break;
        }
        const name = `${job.metadata.name}-${indexed ? `${index}-` : ""}${cluster.random.suffix(5)}`;
        const pod = podFromTemplate(cluster, job, spec.template, name, t, {}, `${job.metadata.name}-${indexed ? `${index}-` : ""}`);
        if (indexed) {
          pod.metadata.annotations = { ...(pod.metadata.annotations ?? {}), "batch.kubernetes.io/job-completion-index": String(index) };
          pod.metadata.labels = { ...pod.metadata.labels, "batch.kubernetes.io/job-completion-index": String(index) };
          for (const c of pod.spec.containers) c.env = [...(c.env ?? []), { name: "JOB_COMPLETION_INDEX", valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } }];
          pod.spec.hostname = name.replace(/-[a-z0-9]{5}$/, "");
        }
        cluster.put(pod);
        cluster.recordEvent(job, "Normal", "SuccessfulCreate", `Created pod: ${name}`, { component: "job-controller" }, t);
      }
    }
    const nowActive = cluster.list("Pod", ns).filter((p) => ownedBy(p, job) && isActive(p)).length;
    setStatus(cluster, job, {
      ...status,
      active: nowActive || undefined,
      ready,
      terminating: 0,
      succeeded: succeeded || undefined,
      failed: failures || undefined,
      conditions: undefined,
      uncountedTerminatedPods: {},
    });
  }
}

// ------------------------------------------------------------------ CronJob

export function reconcileCronJobs(cluster: Cluster, t: number): void {
  for (const cj of cluster.list("CronJob")) {
    const ns = cj.metadata.namespace!;
    const spec = cj.spec;
    const jobs = cluster.list("Job", ns).filter((j) => ownedBy(j, cj));
    const status: Record<string, unknown> = { ...(cj.status ?? {}) };
    const src = { component: "cronjob-controller" };

    // Notice finished jobs.
    const seenKey = `cj-seen/${cj.metadata.uid}`;
    const seen = (cluster.scratch.get(seenKey) as Set<string> | undefined) ?? new Set<string>();
    for (const j of jobs) {
      const fin = jobFinished(j);
      if (fin && !seen.has(j.metadata.uid!)) {
        seen.add(j.metadata.uid!);
        cluster.recordEvent(cj, "Normal", "SawCompletedJob", `Saw completed job: ${j.metadata.name}, condition: ${fin}`, src, t);
        if (fin === "Complete") status.lastSuccessfulTime = j.status?.completionTime ?? isoTime(t);
      }
    }
    cluster.scratch.set(seenKey, seen);

    // History limits.
    const byStart = (a: KObject, b: KObject) => String(a.metadata.creationTimestamp).localeCompare(String(b.metadata.creationTimestamp));
    const succeeded = jobs.filter((j) => jobFinished(j) === "Complete").sort(byStart);
    const failed = jobs.filter((j) => jobFinished(j) === "Failed").sort(byStart);
    const prune = (list: KObject[], keep: number) => {
      for (const j of list.slice(0, Math.max(0, list.length - keep))) {
        cluster.remove("Job", j.metadata.name, ns);
        cluster.recordEvent(cj, "Normal", "SuccessfulDelete", `Deleted job ${j.metadata.name}`, src, t);
      }
    };
    prune(succeeded, spec.successfulJobsHistoryLimit ?? 3);
    prune(failed, spec.failedJobsHistoryLimit ?? 1);

    let active = cluster.list("Job", ns).filter((j) => ownedBy(j, cj) && !jobFinished(j));
    if (!spec.suspend) {
      let schedule;
      try {
        schedule = parseSchedule(spec.schedule);
      } catch {
        schedule = undefined;
      }
      const since = parseTime(String(status.lastScheduleTime ?? "")) || parseTime(cj.metadata.creationTimestamp);
      const due = schedule ? lastRunBetween(schedule, since, t) : { missed: 0 };
      if (due.time !== undefined) {
        const late = t - due.time;
        const deadline = spec.startingDeadlineSeconds;
        if (deadline !== undefined && late > deadline * 1000) {
          status.lastScheduleTime = isoTime(due.time);
          cluster.recordEvent(cj, "Warning", "MissSchedule", `Missed scheduled time to start a job: ${isoTime(due.time)}`, src, t);
        } else if (spec.concurrencyPolicy === "Forbid" && active.length > 0) {
          cluster.recordEvent(cj, "Normal", "JobAlreadyActive", "Not starting job because prior execution is running and concurrency policy is Forbid", src, t, 60000);
        } else {
          if (spec.concurrencyPolicy === "Replace") {
            for (const j of active) {
              cluster.remove("Job", j.metadata.name, ns);
              cluster.recordEvent(cj, "Normal", "SuccessfulDelete", `Deleted job ${j.metadata.name}`, src, t);
            }
            active = [];
          }
          const name = `${cj.metadata.name}-${Math.floor(due.time / 60000)}`;
          if (!cluster.get("Job", name, ns)) {
            const tpl = deepClone(spec.jobTemplate ?? {});
            const job = cluster.create({
              apiVersion: "batch/v1",
              kind: "Job",
              metadata: {
                name,
                namespace: ns,
                labels: { ...(tpl.metadata?.labels ?? {}) },
                annotations: { ...(tpl.metadata?.annotations ?? {}), "batch.kubernetes.io/cronjob-scheduled-timestamp": isoTime(due.time) },
                ownerReferences: [ownerRef(cj)],
              },
              spec: tpl.spec,
            }, { at: t });
            active.push(job);
            cluster.recordEvent(cj, "Normal", "SuccessfulCreate", `Created job ${name}`, src, t);
          }
          status.lastScheduleTime = isoTime(due.time);
        }
      }
    }
    setStatus(cluster, cj, {
      ...status,
      active: active.length ? active.map((j) => ({ apiVersion: "batch/v1", kind: "Job", name: j.metadata.name, namespace: ns, resourceVersion: j.metadata.resourceVersion, uid: j.metadata.uid })) : undefined,
    });
  }
}

// ------------------------------------------------------------------ revisions

export interface Revision {
  revision: number;
  hash: string;
  template: KObject["spec"];
  cause?: string;
}

/** Revision history for DaemonSets and StatefulSets (what ControllerRevisions hold). */
export function revisionsOf(cluster: Cluster, obj: KObject): Revision[] {
  return ((cluster.scratch.get(`rev/${obj.metadata.uid}`) as Revision[] | undefined) ?? []).slice().sort((a, b) => a.revision - b.revision);
}

function recordRevision(cluster: Cluster, obj: KObject, hash: string): void {
  const key = `rev/${obj.metadata.uid}`;
  const list = (cluster.scratch.get(key) as Revision[] | undefined) ?? [];
  const max = list.reduce((m, r) => Math.max(m, r.revision), 0);
  const found = list.find((r) => r.hash === hash);
  if (found) {
    if (found.revision !== max) found.revision = max + 1;
  } else {
    list.push({ revision: max + 1, hash, template: deepClone(obj.spec.template), cause: obj.metadata.annotations?.["kubernetes.io/change-cause"] });
    while (list.length > (obj.spec.revisionHistoryLimit ?? 10) + 1) list.splice(list.findIndex((r) => r.revision === Math.min(...list.map((x) => x.revision))), 1);
  }
  cluster.scratch.set(key, list);
}

// ------------------------------------------------------------------ DaemonSet

export const DAEMON_TOLERATIONS = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute" },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute" },
  { key: "node.kubernetes.io/disk-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/memory-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/pid-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/unschedulable", operator: "Exists", effect: "NoSchedule" },
];

function nodeShouldRun(node: KObject, podSpec: KObject["spec"]): boolean {
  const labels = node.metadata.labels ?? {};
  const sel = podSpec?.nodeSelector ?? {};
  if (!Object.entries(sel).every(([k, v]) => labels[k] === v)) return false;
  const terms: NodeSelectorTerm[] | undefined = podSpec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms && !terms.some((term) => matchNodeSelectorTerm(labels, term, node.metadata.name))) return false;
  const tols = [...(podSpec?.tolerations ?? []), ...DAEMON_TOLERATIONS];
  for (const taint of node.spec?.taints ?? []) {
    if ((taint.effect === "NoSchedule" || taint.effect === "NoExecute") && !tolerates(tols, taint)) return false;
  }
  return true;
}

function podNode(p: KObject): string | undefined {
  if (p.spec?.nodeName) return p.spec.nodeName;
  const terms = p.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  for (const term of terms) for (const f of term.matchFields ?? []) if (f.key === "metadata.name") return f.values?.[0];
  return undefined;
}

export function dsRevision(ds: KObject): string {
  return templateHash(ds.spec.template);
}

export function reconcileDaemonSets(cluster: Cluster, t: number): void {
  for (const ds of cluster.list("DaemonSet")) {
    const ns = ds.metadata.namespace!;
    const src = { component: "daemonset-controller" };
    const hash = dsRevision(ds);
    recordRevision(cluster, ds, hash);
    const nodes = cluster.list("Node");
    let pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, ds) && !p.metadata.deletionTimestamp);
    const wanted = nodes.filter((n) => nodeShouldRun(n, ds.spec.template?.spec));
    const wantedNames = new Set(wanted.map((n) => n.metadata.name));

    // Remove pods on nodes that should not run one, and failed pods.
    for (const p of pods) {
      const node = podNode(p);
      if (!node || !wantedNames.has(node) || p.status?.phase === "Failed") {
        cluster.remove("Pod", p.metadata.name, ns);
        cluster.recordEvent(ds, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, src, t);
      }
    }
    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, ds));

    // Rolling update: replace out-of-date pods, a few at a time.
    const strategy = ds.spec.updateStrategy?.type ?? "RollingUpdate";
    if (strategy === "RollingUpdate") {
      const maxUnavailableRaw = ds.spec.updateStrategy?.rollingUpdate?.maxUnavailable ?? 1;
      const maxUnavailable = typeof maxUnavailableRaw === "string" && maxUnavailableRaw.endsWith("%") ? Math.max(1, Math.floor((parseFloat(maxUnavailableRaw) / 100) * wanted.length)) : Number(maxUnavailableRaw) || 1;
      const unavailable = wanted.filter((n) => !pods.some((p) => podNode(p) === n.metadata.name && isRunningReady(p))).length;
      let budget = maxUnavailable - unavailable;
      const old = pods.filter((p) => p.metadata.labels?.["controller-revision-hash"] !== hash).sort((a, b) => Number(isRunningReady(a)) - Number(isRunningReady(b)));
      for (const p of old) {
        if (budget <= 0 && isRunningReady(p)) break;
        cluster.remove("Pod", p.metadata.name, ns);
        cluster.recordEvent(ds, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, src, t);
        if (isRunningReady(p)) budget--;
      }
      pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, ds));
    }

    // Create a pod on every wanted node that has none.
    for (const node of wanted) {
      if (pods.some((p) => podNode(p) === node.metadata.name)) continue;
      const name = `${ds.metadata.name}-${cluster.random.suffix(5)}`;
      const pod = podFromTemplate(cluster, ds, ds.spec.template, name, t, { "controller-revision-hash": hash, "pod-template-generation": String(ds.metadata.generation ?? 1) }, `${ds.metadata.name}-`);
      pod.spec.tolerations = [...(ds.spec.template?.spec?.tolerations ?? []), ...DAEMON_TOLERATIONS].filter(
        (x: { key?: string; effect?: string; operator?: string }, i: number, all: { key?: string; effect?: string; operator?: string }[]) =>
          all.findIndex((y) => y.key === x.key && y.effect === x.effect && y.operator === x.operator) === i,
      );
      const userAffinity = deepClone(pod.spec.affinity ?? {});
      userAffinity.nodeAffinity = {
        ...(userAffinity.nodeAffinity ?? {}),
        requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: "metadata.name", operator: "In", values: [node.metadata.name] }] }] },
      };
      pod.spec.affinity = userAffinity;
      cluster.put(pod);
      cluster.recordEvent(ds, "Normal", "SuccessfulCreate", `Created pod: ${name}`, src, t);
    }

    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, ds));
    const scheduled = pods.filter((p) => p.spec?.nodeName && wantedNames.has(p.spec.nodeName));
    const readyCount = scheduled.filter(isRunningReady).length;
    const updated = scheduled.filter((p) => p.metadata.labels?.["controller-revision-hash"] === hash);
    setStatus(cluster, ds, {
      currentNumberScheduled: scheduled.length,
      desiredNumberScheduled: wanted.length,
      numberMisscheduled: 0,
      numberReady: readyCount,
      numberAvailable: readyCount || undefined,
      numberUnavailable: wanted.length - readyCount || undefined,
      updatedNumberScheduled: updated.length,
      observedGeneration: ds.metadata.generation ?? 1,
    });
  }
}

// ------------------------------------------------------------------ StatefulSet

export function stsRevision(sts: KObject): string {
  return `${sts.metadata.name}-${templateHash(sts.spec.template)}`;
}

function ordinalOf(sts: KObject, p: KObject): number {
  const m = p.metadata.name.match(/-(\d+)$/);
  return m && p.metadata.name === `${sts.metadata.name}-${m[1]}` ? parseInt(m[1], 10) : -1;
}

export function reconcileStatefulSets(cluster: Cluster, t: number): void {
  for (const sts of cluster.list("StatefulSet")) {
    const ns = sts.metadata.namespace!;
    const src = { component: "statefulset-controller" };
    const replicas: number = sts.spec.replicas ?? 1;
    const parallel = sts.spec.podManagementPolicy === "Parallel";
    const revision = stsRevision(sts);
    recordRevision(cluster, sts, revision);
    const start = sts.spec.ordinals?.start ?? 0;
    let pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, sts));

    // Failed pods are deleted and recreated with the same name.
    for (const p of pods) {
      if (p.status?.phase === "Failed" || p.status?.phase === "Succeeded") {
        cluster.remove("Pod", p.metadata.name, ns);
        cluster.recordEvent(sts, "Normal", "SuccessfulDelete", `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`, src, t);
      }
    }
    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, sts));
    const byOrdinal = new Map(pods.map((p) => [ordinalOf(sts, p), p]));

    // Scale up in order.
    let blocked = false;
    for (let i = start; i < start + replicas; i++) {
      const existing = byOrdinal.get(i);
      if (existing) {
        if (!parallel && !isRunningReady(existing)) blocked = true;
        continue;
      }
      if (blocked && !parallel) break;
      const name = `${sts.metadata.name}-${i}`;
      const pod = podFromTemplate(cluster, sts, sts.spec.template, name, t, {
        "apps.kubernetes.io/pod-index": String(i),
        "controller-revision-hash": revision,
        "statefulset.kubernetes.io/pod-name": name,
      });
      pod.spec.hostname = name;
      if (sts.spec.serviceName) pod.spec.subdomain = sts.spec.serviceName;
      for (const vct of sts.spec.volumeClaimTemplates ?? []) {
        const claimName = `${vct.metadata?.name}-${name}`;
        if (!cluster.get("PersistentVolumeClaim", claimName, ns)) {
          cluster.create({
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: claimName, namespace: ns, labels: { ...(vct.metadata?.labels ?? {}), ...(sts.spec.selector?.matchLabels ?? {}) } },
            spec: deepClone(vct.spec ?? {}),
          }, { at: t });
          cluster.recordEvent(sts, "Normal", "SuccessfulCreate", `create Claim ${claimName} Pod ${name} in StatefulSet ${sts.metadata.name} success`, src, t);
        }
        const vols = (pod.spec.volumes ?? []).filter((v: { name: string }) => v.name !== vct.metadata?.name);
        pod.spec.volumes = [...vols, { name: vct.metadata?.name, persistentVolumeClaim: { claimName } }];
      }
      cluster.put(pod);
      cluster.recordEvent(sts, "Normal", "SuccessfulCreate", `create Pod ${name} in StatefulSet ${sts.metadata.name} successful`, src, t);
      if (!parallel) blocked = true;
    }

    // Scale down from the highest ordinal.
    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, sts));
    const extra = pods.filter((p) => ordinalOf(sts, p) >= start + replicas || ordinalOf(sts, p) < start).sort((a, b) => ordinalOf(sts, b) - ordinalOf(sts, a));
    const allReady = pods.every(isRunningReady);
    for (const p of extra) {
      if (!parallel && !allReady) break;
      cluster.remove("Pod", p.metadata.name, ns);
      cluster.recordEvent(sts, "Normal", "SuccessfulDelete", `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`, src, t);
      if (!parallel) break;
    }

    // Rolling update from the highest ordinal down to the partition.
    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, sts));
    if ((sts.spec.updateStrategy?.type ?? "RollingUpdate") === "RollingUpdate" && pods.length === replicas && pods.every(isRunningReady)) {
      const partition = sts.spec.updateStrategy?.rollingUpdate?.partition ?? 0;
      const stale = pods
        .filter((p) => p.metadata.labels?.["controller-revision-hash"] !== revision && ordinalOf(sts, p) >= start + partition)
        .sort((a, b) => ordinalOf(sts, b) - ordinalOf(sts, a));
      if (stale[0]) {
        cluster.remove("Pod", stale[0].metadata.name, ns);
        cluster.recordEvent(sts, "Normal", "SuccessfulDelete", `delete Pod ${stale[0].metadata.name} in StatefulSet ${sts.metadata.name} successful`, src, t);
      }
    }

    pods = cluster.list("Pod", ns).filter((p) => ownedBy(p, sts));
    const ready = pods.filter(isRunningReady).length;
    const updated = pods.filter((p) => p.metadata.labels?.["controller-revision-hash"] === revision).length;
    const prevCurrent = (sts.status?.currentRevision as string | undefined) ?? revision;
    const current = updated === replicas && pods.length === replicas ? revision : prevCurrent;
    setStatus(cluster, sts, {
      replicas: pods.length,
      readyReplicas: ready || undefined,
      currentReplicas: current === revision ? updated : pods.length - updated,
      updatedReplicas: updated || undefined,
      availableReplicas: ready,
      currentRevision: current,
      updateRevision: revision,
      collisionCount: 0,
      observedGeneration: sts.metadata.generation ?? 1,
    });
  }
}
