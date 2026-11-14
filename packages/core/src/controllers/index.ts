import type { Cluster } from "../cluster.js";
import type { Proc } from "../runtime.js";
import { garbageCollect } from "./gc.js";
import { reconcileDeployments } from "./deployment.js";
import { reconcileReplicaSets } from "./replicaset.js";
import { schedulePods } from "./scheduler.js";
import { runKubelet } from "./kubelet.js";
import { reconcileEndpoints } from "./endpoints.js";
import { reconcileNamespaces, reconcileVolumeClaims } from "./misc.js";
import { reconcileJobs, reconcileCronJobs, reconcileDaemonSets, reconcileStatefulSets } from "./workloads.js";

export interface ProbeState {
  next: number;
  failures: number;
  successes: number;
  ok: boolean;
  lastMessage?: string;
}

export interface ContainerSim {
  image: string;
  createdAt: number;
  phase: "creating" | "configError" | "pullError" | "running" | "exited" | "backoff" | "terminated";
  /** The simulated main process of the current run. */
  proc?: Proc;
  /** Files the container wrote outside its volumes (lost on restart). */
  overlay?: Map<string, string>;
  probes?: { startup?: ProbeState; liveness?: ProbeState; readiness?: ProbeState };
  /** Log lines of the previous run, for logs --previous. */
  prevLines?: string[];
  exitReason?: string;
  killedBy?: string;
  oomAt?: number;
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
  emptyDirs?: Record<string, Map<string, string>>;
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
    reconcileCronJobs(cluster, t);
    reconcileJobs(cluster, t);
    reconcileDaemonSets(cluster, t);
    reconcileStatefulSets(cluster, t);
    reconcileVolumeClaims(cluster, t);
    schedulePods(cluster, t);
    runKubelet(cluster, t);
    reconcileEndpoints(cluster);
  }
}
