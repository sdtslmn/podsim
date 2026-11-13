// Runs a lab: prepares the cluster, then evaluates the checks on demand.

import { Cluster, type ClusterOptions } from "../cluster.js";
import type { FileSystem } from "../fs.js";
import type { IO } from "../kubectl/index.js";
import { Shell, type ShellOptions } from "../shell.js";
import type { KObject } from "../types.js";
import { evalPath } from "../kubectl/jsonpath.js";
import { matchRequirements, parseSelector } from "../util.js";
import { isPodReady } from "../controllers/deployment.js";
import type { Lab, LabCheck } from "./schema.js";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const silentIO = (sleep: (ms: number) => Promise<void>): IO => ({ stdout: () => {}, stderr: () => {}, sleep });

export class LabSession {
  readonly cluster: Cluster;
  readonly shell: Shell;
  private hintIndex = 0;

  constructor(
    readonly lab: Lab,
    readonly fs: FileSystem,
    clusterOptions: ClusterOptions = {},
    shellOptions: ShellOptions = {},
  ) {
    this.cluster = new Cluster(clusterOptions);
    this.shell = new Shell(this.cluster, fs, shellOptions);
  }

  /** Write lab files, run setup commands quietly and let the cluster settle. */
  async setup(): Promise<string[]> {
    const errors: string[] = [];
    for (const [name, content] of Object.entries(this.lab.files)) this.fs.writeFile(name, content);
    for (const cmd of this.lab.setup) {
      let errText = "";
      const io: IO = { stdout: () => {}, stderr: (t) => (errText += t), sleep: async (ms) => this.cluster.settle(ms / 1000) };
      const code = await this.shell.exec(cmd, io);
      if (code !== 0) errors.push(`${cmd}: ${errText.trim()}`);
    }
    this.cluster.settle(this.lab.settle);
    // Setup should not leave the learner in another namespace.
    this.shell.kubectl.state.namespace = "default";
    return errors;
  }

  nextHint(): { text: string; index: number; total: number } | undefined {
    if (this.lab.hints.length === 0) return undefined;
    const i = Math.min(this.hintIndex, this.lab.hints.length - 1);
    this.hintIndex++;
    return { text: this.lab.hints[i], index: i + 1, total: this.lab.hints.length };
  }

  async check(): Promise<CheckResult[]> {
    this.cluster.advance();
    const results: CheckResult[] = [];
    for (const c of this.lab.checks) results.push(await this.evaluate(c));
    return results;
  }

  private async evaluate(c: LabCheck): Promise<CheckResult> {
    const fail = (detail: string): CheckResult => ({ name: c.name, passed: false, detail });
    const pass = (): CheckResult => ({ name: c.name, passed: true });

    if (c.command) {
      let out = "";
      // Waits inside checks move the virtual clock instead of real time.
      const io: IO = { ...silentIO(async (ms) => this.cluster.settle(ms / 1000)), stdout: (t) => (out += t), stderr: (t) => (out += t) };
      const code = await this.shell.exec(c.command, io);
      if (c.exitCode !== undefined && code !== c.exitCode) return fail(`exit code ${code}`);
      if (c.outputMatches && !new RegExp(c.outputMatches, "m").test(out)) return fail(`output was: ${out.trim().split("\n")[0] ?? ""}`);
      return pass();
    }

    const kind = c.kind!;
    const ns = c.namespace ?? "default";

    if (c.count) {
      let objs = this.cluster.list(kind, ns);
      if (c.count.selector) {
        const reqs = parseSelector(c.count.selector);
        objs = objs.filter((o) => matchRequirements(o.metadata.labels, reqs));
      }
      if (c.count.phase) objs = objs.filter((o) => o.status?.phase === c.count!.phase);
      if (c.count.ready) objs = objs.filter((o) => isPodReady(o));
      const n = objs.length;
      if (c.count.equals !== undefined && n !== c.count.equals) return fail(`found ${n}, expected ${c.count.equals}`);
      if (c.count.gte !== undefined && n < c.count.gte) return fail(`found ${n}, expected at least ${c.count.gte}`);
      return pass();
    }

    const obj: KObject | undefined = c.resource ? this.cluster.get(kind, c.resource, ns) : undefined;
    if (c.expect === "absent") return obj ? fail(`${kind.toLowerCase()} ${c.resource} still exists`) : pass();
    if (!obj) return fail(`${kind.toLowerCase()} "${c.resource}" not found in namespace ${ns}`);
    if (c.expect === "exists" && !c.path) return pass();
    if (!c.path) return pass();

    const values = evalPath(obj, c.path.startsWith(".") ? c.path : "." + c.path);
    const v = values[0];
    const shown = v === undefined ? "<not set>" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (c.equals !== undefined && String(v) !== String(c.equals)) return fail(`${c.path} is ${shown}`);
    if (c.matches && !new RegExp(c.matches).test(String(v ?? ""))) return fail(`${c.path} is ${shown}`);
    if (c.contains !== undefined) {
      const hay = values.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ");
      if (!hay.includes(String(c.contains))) return fail(`${c.path} does not contain ${c.contains}`);
    }
    if (c.gte !== undefined && !(Number(v) >= c.gte)) return fail(`${c.path} is ${shown}`);
    if (c.lte !== undefined && !(Number(v) <= c.lte)) return fail(`${c.path} is ${shown}`);
    if (v === undefined && c.equals === undefined && !c.matches && c.contains === undefined) return fail(`${c.path} is not set`);
    return pass();
  }
}
