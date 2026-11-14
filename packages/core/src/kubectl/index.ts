// kubectl entry point: parse the command line and dispatch.

import type { Cluster } from "../cluster.js";
import type { FileSystem } from "../fs.js";
import { KubeError } from "../types.js";
import { Flags, parseArgs } from "./flags.js";
import type { Ctx, IO, KubectlState } from "./common.js";
import { cmdGet, cmdDescribe, cmdApply, cmdDelete, cmdReplace, cmdLabel, cmdAnnotate, cmdPatch } from "./resources.js";
import { cmdRun, cmdCreate, cmdExpose, cmdScale, cmdSet, cmdRollout } from "./workloads.js";
import {
  cmdLogs,
  cmdExec,
  cmdCordon,
  cmdDrain,
  cmdTaint,
  cmdConfig,
  cmdAuth,
  cmdWait,
  cmdVersion,
  cmdClusterInfo,
  cmdApiResources,
  cmdTop,
  cmdExplain,
  cmdEdit,
  notSimulated,
} from "./ops.js";

export type { IO, KubectlState } from "./common.js";

const HELP = `kubectl controls the (simulated) Kubernetes cluster manager.

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a deployment, pod or service and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects (image, env, resources, serviceaccount)

Basic Commands (Intermediate):
  get             Display one or many resources
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource (status, history, undo, restart, pause, resume)
  scale           Set a new size for a deployment or replica set

Cluster Management Commands:
  cluster-info    Display cluster information
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  exec            Execute a command in a container
  auth            Inspect authorization (can-i, whoami)
  wait            Wait for a specific condition on one or many resources

Advanced Commands:
  apply           Apply a configuration to a resource by file name or stdin
  patch           Update fields of a resource
  replace         Replace a resource by file name or stdin

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource

Other Commands:
  api-resources   Print the supported API resources on the server
  config          Modify kubeconfig files (current-context, get-contexts, set-context --current --namespace)
  version         Print the client and server version information

Usage:
  kubectl [flags] [options]`;

export class Kubectl {
  readonly state: KubectlState = { namespace: "default" };
  constructor(
    readonly cluster: Cluster,
    readonly fs: FileSystem,
  ) {}

  /** Run kubectl with argv (without the leading "kubectl"). Returns the exit code. */
  async run(argv: string[], io: IO, raw = ""): Promise<number> {
    const ctx: Ctx = { cluster: this.cluster, fs: this.fs, state: this.state, io, raw: raw || `kubectl ${argv.join(" ")}` };
    try {
      return await this.dispatch(ctx, argv);
    } catch (e) {
      if (e instanceof KubeError) {
        io.stderr(e.message.endsWith("\n") ? e.message : e.message + "\n");
        return e.exitCode;
      }
      throw e;
    }
  }

  private async dispatch(ctx: Ctx, argv: string[]): Promise<number> {
    // Global flags may come before the command: kubectl -n dev get pods
    let i = 0;
    const lead: string[] = [];
    while (i < argv.length && argv[i].startsWith("-")) {
      lead.push(argv[i]);
      if (!argv[i].includes("=") && ["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server"].includes(argv[i])) lead.push(argv[++i]);
      i++;
    }
    const cmd = argv[i];
    const rest = [...lead, ...argv.slice(i + 1)];
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
      ctx.io.stdout(HELP + "\n");
      return 0;
    }
    const f = new Flags(parseArgs(rest));
    if (f.bool("help")) {
      ctx.io.stdout(`(podsim) Help for "kubectl ${cmd}" is not included. See https://kubernetes.io/docs/reference/kubectl/generated/kubectl_${cmd}/\n`);
      return 0;
    }
    switch (cmd) {
      case "get":
        return cmdGet(ctx, f);
      case "describe":
        return cmdDescribe(ctx, f);
      case "apply":
        return cmdApply(ctx, f);
      case "create":
        return cmdCreate(ctx, f);
      case "delete":
        return cmdDelete(ctx, f);
      case "replace":
        return cmdReplace(ctx, f);
      case "patch":
        return cmdPatch(ctx, f);
      case "label":
        return cmdLabel(ctx, f);
      case "annotate":
        return cmdAnnotate(ctx, f);
      case "run":
        return cmdRun(ctx, f);
      case "expose":
        return cmdExpose(ctx, f);
      case "scale":
        return cmdScale(ctx, f);
      case "set":
        return cmdSet(ctx, f);
      case "rollout":
        return cmdRollout(ctx, f);
      case "logs":
        return cmdLogs(ctx, f);
      case "exec":
        return cmdExec(ctx, f);
      case "cordon":
        return cmdCordon(ctx, f, true);
      case "uncordon":
        return cmdCordon(ctx, f, false);
      case "drain":
        return cmdDrain(ctx, f);
      case "taint":
        return cmdTaint(ctx, f);
      case "config":
        return cmdConfig(ctx, f);
      case "auth":
        return cmdAuth(ctx, f);
      case "wait":
        return cmdWait(ctx, f);
      case "version":
        return cmdVersion(ctx, f);
      case "cluster-info":
        return cmdClusterInfo(ctx);
      case "api-resources":
        return cmdApiResources(ctx, f);
      case "top":
        return cmdTop(ctx);
      case "explain":
        return cmdExplain(ctx, f);
      case "edit":
        return cmdEdit(ctx, f);
      case "completion":
        return 0;
      case "port-forward":
      case "proxy":
      case "cp":
      case "attach":
      case "debug":
      case "certificate":
      case "kustomize":
      case "plugin":
      case "events":
      case "diff":
      case "autoscale":
        return notSimulated(ctx, cmd);
      default:
        ctx.io.stderr(`error: unknown command "${cmd}" for "kubectl"\n\nDid you mean this?\n\t${suggest(cmd)}\n\nRun 'kubectl --help' for usage.\n`);
        return 1;
    }
  }
}

const COMMANDS = ["get", "describe", "apply", "create", "delete", "replace", "patch", "label", "annotate", "run", "expose", "scale", "set", "rollout", "logs", "exec", "cordon", "uncordon", "drain", "taint", "config", "auth", "wait", "version", "cluster-info", "api-resources", "top", "explain", "edit"];

function suggest(cmd: string): string {
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  return COMMANDS.reduce((best, c) => (dist(cmd, c) < dist(cmd, best) ? c : best), COMMANDS[0]);
}
