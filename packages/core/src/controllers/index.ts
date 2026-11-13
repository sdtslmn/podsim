import type { Cluster } from "../cluster.js";
import { garbageCollect } from "./gc.js";
import { reconcileDeployments } from "./deployment.js";
import { reconcileReplicaSets } from "./replicaset.js";
import { schedulePods } from "./scheduler.js";
import { runKubelet } from "./kubelet.js";
import { reconcileEndpoints } from "./endpoints.js";
import { reconcileNamespaces, reconcileVolumeClaims } from "./misc.js";

export interface ContainerSim {
  image: string;
  createdAt: number;
  phase: "creating" | "configError" | "pullError" | "running" | "exited" | "backoff" | "terminated";
  runStartedAt?: number;
  firstStartedAt?: number;
  exitAt?: number;
  exitCode?: number;
  backoffUntil?: number;
  restarts: number;
  pullFailedAt?: number;
  message?: string;
  lastTerminated?: { exitCode: number; reason: string; startedAt: number; finishedAt: number };
  containerId?: string;
}

export interface PodSim {
  scheduledAt?: number;
  fixedIp?: string;
  containers: Record<string, ContainerSim>;
  emitted?: Record<string, boolean>;
  lastScheduleFailure?: { message: string; at: number };
}

/** One pass of every controller at virtual time t. Two passes let chains settle in a single step. */
export function runControllers(cluster: Cluster, t: number): void {
  for (let pass = 0; pass < 2; pass++) {
    reconcileNamespaces(cluster, t);
    garbageCollect(cluster);
    reconcileDeployments(cluster, t);
    reconcileReplicaSets(cluster, t);
    reconcileVolumeClaims(cluster, t);
    schedulePods(cluster, t);
    runKubelet(cluster, t);
    reconcileEndpoints(cluster);
  }
}
