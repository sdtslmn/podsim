// What happens when you run a command inside a simulated container
// (kubectl exec, kubectl run -- CMD). Commands run through the same
// process simulation the container itself uses, so files written by the
// container, mounted ConfigMaps and Secrets, cluster DNS and HTTP between
// pods all behave consistently.

import type { Cluster } from "../cluster.js";
import type { ContainerSpec, KObject } from "../types.js";
import { execInContainer, imageInfo } from "../podruntime.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  blocked?: string;
}

function notFound(cmd: string): ExecResult {
  return {
    stdout: "",
    stderr: `error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "simulated": OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown`,
    exitCode: 127,
  };
}

/** Run argv inside a container of a running pod. */
export function runInContainer(cluster: Cluster, pod: KObject, c: ContainerSpec, argv: string[], stdin = ""): ExecResult {
  if (argv.length === 0) return { stdout: "", stderr: "error: you must specify at least one command for the container", exitCode: 1 };
  const cs = cluster.podSims.get(pod.metadata.uid!)?.containers[c.name];
  if (!cs) return { stdout: "", stderr: `error: unable to upgrade connection: container not found ("${c.name}")`, exitCode: 1 };
  // Images without a shell (scratch and distroless images) cannot run sh, bash or ash.
  const tools = imageInfo(c.image)?.tools;
  const bin = argv[0].replace(/^.*\//, "");
  if (tools && ["sh", "bash", "ash"].includes(bin) && !tools.includes(bin) && !(bin === "sh" && tools.includes("bash"))) return notFound(argv[0]);
  const r = execInContainer(cluster, pod, c, cs, argv, stdin);
  // A command that is not in the image fails before any shell runs.
  if (r.code === 127 && r.stderr === `sh: ${argv[0].replace(/^.*\//, "")}: not found\n` && !argv[0].includes(" ")) return notFound(argv[0]);
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, blocked: r.blocked };
}

/** Split a command string into words, respecting quotes. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < s.length) cur += s[++i];
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
