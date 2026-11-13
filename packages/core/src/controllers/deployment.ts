// Deployment controller: owns ReplicaSets, performs RollingUpdate and
// Recreate rollouts, tracks revisions for rollout history and undo.

import type { Cluster } from "../cluster.js";
import type { KObject } from "../types.js";
import { deepClone, fnv1a, isoTime, safeEncode, stableStringify, matchLabelSelector } from "../util.js";

export const REVISION = "deployment.kubernetes.io/revision";
export const CHANGE_CAUSE = "kubernetes.io/change-cause";

export function templateHash(template: unknown): string {
  return safeEncode(fnv1a(stableStringify(template)), 10);
}

/** The pod template of a ReplicaSet without the pod-template-hash label, for comparison. */
export function templateWithoutHash(rs: KObject): unknown {
  const tpl = deepClone(rs.spec.template);
  if (tpl?.metadata?.labels) delete tpl.metadata.labels["pod-template-hash"];
  return tpl;
}

export function ownedBy(obj: KObject, owner: KObject): boolean {
  return !!obj.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid && r.controller);
}

export function isPodReady(pod: KObject): boolean {
  return (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True");
}

function isPodActive(pod: KObject): boolean {
  return pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed" && !pod.metadata.deletionTimestamp;
}

function resolvePercent(value: string | number | undefined, total: number, roundUp: boolean): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return value;
  if (value.endsWith("%")) {
    const raw = (parseFloat(value) / 100) * total;
    return roundUp ? Math.ceil(raw) : Math.floor(raw);
  }
  return parseInt(value, 10) || 0;
}

export function deploymentReplicaSets(cluster: Cluster, deploy: KObject): KObject[] {
  return cluster.list("ReplicaSet", deploy.metadata.namespace).filter((rs) => ownedBy(rs, deploy));
}

function setReplicas(cluster: Cluster, rs: KObject, n: number, deploy: KObject, t: number): void {
  if (rs.spec.replicas === n) return;
  const from = rs.spec.replicas;
  rs.spec.replicas = n;
  rs.metadata.annotations = { ...(rs.metadata.annotations ?? {}), "deployment.kubernetes.io/desired-replicas": String(deploy.spec.replicas) };
  rs.metadata.generation = (rs.metadata.generation ?? 1) + 1;
  cluster.put(rs);
  const verb = n > from ? "up" : "down";
  cluster.recordEvent(deploy, "Normal", "ScalingReplicaSet", `Scaled ${verb} replica set ${rs.metadata.name} from ${from} to ${n}`, { component: "deployment-controller" }, t);
}

export function reconcileDeployments(cluster: Cluster, t: number): void {
  for (const deploy of cluster.list("Deployment")) {
    const ns = deploy.metadata.namespace!;
    const desired: number = deploy.spec.replicas ?? 1;
    const all = deploymentReplicaSets(cluster, deploy);
    const tpl = deploy.spec.template;
    const hash = templateHash(tpl);
    const maxRevision = Math.max(0, ...all.map((rs) => parseInt(rs.metadata.annotations?.[REVISION] ?? "0", 10)));

    let newRS = all.find((rs) => stableStringify(templateWithoutHash(rs)) === stableStringify(tpl));
    const changeCause = deploy.metadata.annotations?.[CHANGE_CAUSE];

    if (!newRS) {
      const name = `${deploy.metadata.name}-${hash}`;
      const labels = { ...(tpl.metadata?.labels ?? {}), "pod-template-hash": hash };
      const rsTemplate = deepClone(tpl);
      rsTemplate.metadata = { ...(rsTemplate.metadata ?? {}), labels };
      const strategy = deploy.spec.strategy?.type ?? "RollingUpdate";
      const oldTotal = all.reduce((sum, rs) => sum + (rs.spec.replicas ?? 0), 0);
      let initial = desired;
      if (all.length > 0) {
        if (strategy === "Recreate") initial = 0;
        else {
          const maxSurge = resolvePercent(deploy.spec.strategy?.rollingUpdate?.maxSurge ?? "25%", desired, true);
          initial = Math.max(0, Math.min(desired, desired + Math.max(maxSurge, 0) - oldTotal));
        }
      }
      const created = {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name,
          namespace: ns,
          uid: cluster.random.uid(),
          creationTimestamp: isoTime(t),
          generation: 1,
          labels,
          annotations: {
            "deployment.kubernetes.io/desired-replicas": String(desired),
            "deployment.kubernetes.io/max-replicas": String(desired + resolvePercent(deploy.spec.strategy?.rollingUpdate?.maxSurge ?? "25%", desired, true)),
            [REVISION]: String(maxRevision + 1),
            ...(changeCause ? { [CHANGE_CAUSE]: changeCause } : {}),
          },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: deploy.metadata.name, uid: deploy.metadata.uid!, controller: true, blockOwnerDeletion: true }],
        },
        spec: {
          replicas: initial,
          selector: { matchLabels: { ...(deploy.spec.selector?.matchLabels ?? {}), "pod-template-hash": hash }, ...(deploy.spec.selector?.matchExpressions ? { matchExpressions: deploy.spec.selector.matchExpressions } : {}) },
          template: rsTemplate,
        },
        status: { replicas: 0 },
      } as KObject;
      newRS = cluster.put(created);
      cluster.recordEvent(deploy, "Normal", "ScalingReplicaSet", `Scaled up replica set ${name} from 0 to ${initial}`, { component: "deployment-controller" }, t);
      cluster.controllerState.set(`progress/${deploy.metadata.uid}`, t);
    } else {
      // A rollback to an older template re-uses that ReplicaSet and bumps its revision.
      const rev = parseInt(newRS.metadata.annotations?.[REVISION] ?? "0", 10);
      if (rev < maxRevision) {
        newRS.metadata.annotations = { ...(newRS.metadata.annotations ?? {}), [REVISION]: String(maxRevision + 1) };
        if (changeCause) newRS.metadata.annotations[CHANGE_CAUSE] = changeCause;
        cluster.put(newRS);
        cluster.controllerState.set(`progress/${deploy.metadata.uid}`, t);
      } else if (changeCause && newRS.metadata.annotations?.[CHANGE_CAUSE] !== changeCause) {
        newRS.metadata.annotations = { ...(newRS.metadata.annotations ?? {}), [CHANGE_CAUSE]: changeCause };
        cluster.put(newRS);
      }
    }

    const olds = all.filter((rs) => rs !== newRS && rs.metadata.uid !== newRS!.metadata.uid);
    const pods = cluster.list("Pod", ns).filter(isPodActive);
    const podsOf = (rs: KObject) => pods.filter((p) => ownedBy(p, rs));
    const readyOf = (rs: KObject) => podsOf(rs).filter(isPodReady).length;

    if (!deploy.spec.paused) {
      if ((deploy.spec.strategy?.type ?? "RollingUpdate") === "Recreate") {
        const oldRunning = olds.reduce((sum, rs) => sum + podsOf(rs).length, 0);
        for (const rs of olds) setReplicas(cluster, rs, 0, deploy, t);
        if (oldRunning === 0) setReplicas(cluster, newRS, desired, deploy, t);
      } else {
        const maxSurge = resolvePercent(deploy.spec.strategy?.rollingUpdate?.maxSurge ?? "25%", desired, true);
        let maxUnavailable = resolvePercent(deploy.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%", desired, false);
        if (maxSurge === 0 && maxUnavailable === 0) maxUnavailable = 1;

        if (olds.length === 0 || olds.every((rs) => (rs.spec.replicas ?? 0) === 0)) {
          // Steady state or plain scaling.
          setReplicas(cluster, newRS, desired, deploy, t);
          for (const rs of olds) setReplicas(cluster, rs, 0, deploy, t);
        } else {
          // Scale up the new ReplicaSet within the surge budget.
          const total = [newRS, ...olds].reduce((sum, rs) => sum + (rs.spec.replicas ?? 0), 0);
          const maxTotal = desired + maxSurge;
          if (total < maxTotal && newRS.spec.replicas < desired) {
            setReplicas(cluster, newRS, Math.min(desired, newRS.spec.replicas + (maxTotal - total)), deploy, t);
          }
          // Scale down old ReplicaSets while keeping enough pods available.
          const minAvailable = desired - maxUnavailable;
          const available = [newRS, ...olds].reduce((sum, rs) => sum + readyOf(rs), 0);
          let budget = available - minAvailable;
          // Unready old pods can always be removed first.
          for (const rs of olds) {
            const unready = podsOf(rs).length - readyOf(rs);
            const spec = rs.spec.replicas ?? 0;
            if (unready > 0 && spec > 0) setReplicas(cluster, rs, Math.max(0, spec - unready), deploy, t);
          }
          for (const rs of olds.sort((a, b) => String(a.metadata.creationTimestamp).localeCompare(String(b.metadata.creationTimestamp)))) {
            if (budget <= 0) break;
            const spec = rs.spec.replicas ?? 0;
            if (spec === 0) continue;
            const down = Math.min(spec, budget);
            setReplicas(cluster, rs, spec - down, deploy, t);
            budget -= down;
          }
        }
      }
    }

    // Clean up old revisions beyond revisionHistoryLimit.
    const limit = deploy.spec.revisionHistoryLimit ?? 10;
    const idle = olds
      .filter((rs) => (rs.spec.replicas ?? 0) === 0 && podsOf(rs).length === 0)
      .sort((a, b) => parseInt(a.metadata.annotations?.[REVISION] ?? "0", 10) - parseInt(b.metadata.annotations?.[REVISION] ?? "0", 10));
    while (idle.length > limit) {
      const rs = idle.shift()!;
      cluster.remove("ReplicaSet", rs.metadata.name, ns);
    }

    // Status.
    const current = deploymentReplicaSets(cluster, deploy);
    const replicas = current.reduce((sum, rs) => sum + podsOf(rs).length, 0);
    const readyReplicas = current.reduce((sum, rs) => sum + readyOf(rs), 0);
    const updatedReplicas = podsOf(newRS).length;
    const maxUnavailable = resolvePercent(deploy.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%", desired, false);
    const availableOk = readyReplicas >= desired - ((deploy.spec.strategy?.type ?? "RollingUpdate") === "Recreate" ? 0 : maxUnavailable);
    const complete = updatedReplicas === desired && readyOf(newRS) === desired && replicas === desired;

    const progressKey = `progress/${deploy.metadata.uid}`;
    const lastReady = cluster.controllerState.get(`ready/${deploy.metadata.uid}`);
    if (lastReady !== readyReplicas + updatedReplicas * 1000) {
      cluster.controllerState.set(`ready/${deploy.metadata.uid}`, readyReplicas + updatedReplicas * 1000);
      cluster.controllerState.set(progressKey, t);
    }
    const lastProgress = cluster.controllerState.get(progressKey) ?? t;
    const deadline = (deploy.spec.progressDeadlineSeconds ?? 600) * 1000;
    const oldConds: { type: string; status: string; reason?: string; lastTransitionTime?: string; lastUpdateTime?: string; message?: string }[] = deploy.status?.conditions ?? [];
    const cond = (type: string, status: string, reason: string, message: string) => {
      const old = oldConds.find((c) => c.type === type);
      const same = old && old.status === status;
      return {
        type,
        status,
        reason,
        message,
        lastUpdateTime: old && old.reason === reason && old.message === message ? old.lastUpdateTime : isoTime(t),
        lastTransitionTime: same ? old!.lastTransitionTime : isoTime(t),
      };
    };
    let progressing;
    if (complete) progressing = cond("Progressing", "True", "NewReplicaSetAvailable", `ReplicaSet "${newRS.metadata.name}" has successfully progressed.`);
    else if (t - lastProgress > deadline) progressing = cond("Progressing", "False", "ProgressDeadlineExceeded", `ReplicaSet "${newRS.metadata.name}" has timed out progressing.`);
    else progressing = cond("Progressing", "True", "ReplicaSetUpdated", `ReplicaSet "${newRS.metadata.name}" is progressing.`);
    const available = availableOk
      ? cond("Available", "True", "MinimumReplicasAvailable", "Deployment has minimum availability.")
      : cond("Available", "False", "MinimumReplicasUnavailable", "Deployment does not have minimum availability.");

    const status: Record<string, unknown> = {
      observedGeneration: deploy.metadata.generation,
      replicas,
      updatedReplicas,
      readyReplicas,
      availableReplicas: readyReplicas,
      unavailableReplicas: Math.max(0, desired - readyReplicas) || undefined,
      conditions: [available, progressing],
    };
    for (const k of Object.keys(status)) if (status[k] === undefined || status[k] === 0) delete status[k];
    status.observedGeneration = deploy.metadata.generation;
    if (replicas === 0) delete status.replicas;
    const revision = newRS.metadata.annotations?.[REVISION];
    const annChanged = deploy.metadata.annotations?.[REVISION] !== revision;
    if (annChanged) deploy.metadata.annotations = { ...(deploy.metadata.annotations ?? {}), [REVISION]: revision! };
    if (annChanged || stableStringify(status) !== stableStringify(deploy.status)) {
      deploy.status = status;
      cluster.put(deploy);
    }
  }
}

/** Pods selected by a deployment, for describe and rollout status. */
export function deploymentPods(cluster: Cluster, deploy: KObject): KObject[] {
  return cluster.list("Pod", deploy.metadata.namespace).filter((p) => matchLabelSelector(p.metadata.labels, deploy.spec.selector));
}
