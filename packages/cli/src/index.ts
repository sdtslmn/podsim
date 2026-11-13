#!/usr/bin/env node
// k8s-sim terminal: a kubectl practice shell on a simulated cluster,
// with guided labs and automatic checks.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cluster, Shell, LabSession, MemoryFS, parseLab, K8S_VERSION, type IO, type Lab } from "@k8s-sim/core";
import { NodeFS } from "./nodefs.js";

const VERSION = "0.1.0";
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- colours

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");

/** Show `code` from lab text in cyan. */
const md = (s: string) => s.replace(/`([^`]+)`/g, (_, c) => cyan(c));

function reflowText(s: string): string {
  // Join hard-wrapped lines into paragraphs, keep indented example lines and list items as they are.
  const out: string[] = [];
  for (const line of s.split("\n")) {
    const prev = out[out.length - 1];
    const plain = (l: string) => l.trim() !== "" && !/^\s/.test(l) && !/^- /.test(l);
    if (prev !== undefined && plain(prev) && plain(line)) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join("\n");
}

function wrap(text: string, width = Math.min(process.stdout.columns || 90, 100) - 4): string {
  return reflowText(text)
    .split("\n")
    .map((line) => {
      if (line.startsWith("  ") || line.length <= width) return line;
      const words = line.split(" ");
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > width) {
          lines.push(cur);
          cur = w;
        } else cur = (cur + " " + w).trim();
      }
      if (cur) lines.push(cur);
      return lines.join("\n");
    })
    .join("\n");
}

// ---------------------------------------------------------------- args

interface Options {
  labsDir: string;
  workDir: string;
  exec?: string;
  command?: string;
  labArg?: string;
}

function parseCli(argv: string[]): Options {
  const opts: Options = {
    labsDir: process.env.K8S_SIM_LABS ?? findLabsDir(),
    workDir: process.env.K8S_SIM_WORKDIR ?? path.resolve(process.cwd(), "k8s-sim-work"),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--labs") opts.labsDir = path.resolve(argv[++i]);
    else if (a === "--workdir") opts.workDir = path.resolve(argv[++i]);
    else if (a === "-c" || a === "--exec") opts.exec = argv[++i];
    else if (a === "-v" || a === "--version") {
      console.log(`k8s-sim ${VERSION} (simulated Kubernetes ${K8S_VERSION})`);
      process.exit(0);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else rest.push(a);
  }
  opts.command = rest[0];
  opts.labArg = rest[1];
  return opts;
}

function findLabsDir(): string {
  const candidates = [path.resolve(here, "..", "..", "..", "labs"), path.resolve(here, "..", "labs"), path.resolve(process.cwd(), "labs")];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

function printUsage(): void {
  console.log(`k8s-sim ${VERSION}: Kubernetes training simulator

Usage:
  k8s-sim                     open the practice shell (free sandbox)
  k8s-sim labs                list the labs
  k8s-sim lab <id|number>     start a lab, e.g. k8s-sim lab 1
  k8s-sim validate-labs       check that every lab is solved by its own solution
  k8s-sim -c "<command>"      run one command on a fresh cluster and exit

Options:
  --labs <dir>      folder with lab YAML files (default: the repo's labs folder)
  --workdir <dir>   where your files go (default: ./k8s-sim-work)
  -v, --version     print the version`);
}

// ---------------------------------------------------------------- labs

function loadLabs(dir: string): Lab[] {
  const labs: Lab[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(entry.name)) {
        try {
          labs.push(parseLab(fs.readFileSync(p, "utf8"), p));
        } catch (e) {
          console.error(yellow(`warning: skipping ${p}: ${(e as Error).message}`));
        }
      }
    }
  };
  walk(dir);
  const order = { beginner: 0, intermediate: 1, advanced: 2 };
  return labs.sort((a, b) => order[a.level] - order[b.level] || a.id.localeCompare(b.id));
}

function findLab(labs: Lab[], arg: string): Lab | undefined {
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    return labs.find((l) => parseInt(l.id, 10) === n) ?? labs[n - 1];
  }
  return labs.find((l) => l.id === arg || l.id.endsWith(arg) || l.id.includes(arg));
}

function progressFile(workDir: string): string {
  return path.join(workDir, ".progress.json");
}

function loadProgress(workDir: string): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(progressFile(workDir), "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveProgress(workDir: string, done: Set<string>): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(progressFile(workDir), JSON.stringify([...done], null, 2));
}

function listLabs(labs: Lab[], done: Set<string>): string {
  if (labs.length === 0) return "No labs found.";
  const lines = [bold("Labs")];
  let level = "";
  for (const l of labs) {
    if (l.level !== level) {
      level = l.level;
      lines.push("", dim(`  ${level}`));
    }
    const mark = done.has(l.id) ? green("✔") : " ";
    lines.push(`  ${mark} ${cyan(l.id.padEnd(22))} ${l.title}  ${dim(`(${l.minutes} min, ${l.topic})`)}`);
  }
  lines.push("", `Start one with ${cyan("lab <number>")}, for example ${cyan("lab 1")}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- validate-labs

async function validateLabs(labs: Lab[]): Promise<number> {
  let failures = 0;
  for (const lab of labs) {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const session = new LabSession(lab, new MemoryFS(), { clock: () => now, seed: 7 });
    const problems: string[] = [];
    const setupErrors = await session.setup();
    problems.push(...setupErrors.map((e) => `setup: ${e}`));
    const before = await session.check();
    if (before.every((r) => r.passed)) problems.push("all checks already pass before the learner does anything");
    let log = "";
    const io: IO = { stdout: (t) => (log += t), stderr: (t) => (log += t), sleep: async (ms) => void (now += ms) };
    for (const step of lab.solution) {
      const code = await session.shell.exec(step, io);
      if (code !== 0) problems.push(`solution step failed: ${step.split("\n")[0]}\n${log.trim()}`);
    }
    now += 30000;
    const after = await session.check();
    for (const r of after.filter((x) => !x.passed)) problems.push(`check failed after solution: ${r.name} (${r.detail})`);
    if (problems.length) {
      failures++;
      console.log(`${red("✘")} ${lab.id}`);
      for (const p of problems) console.log(`    ${p}`);
    } else console.log(`${green("✔")} ${lab.id}`);
  }
  console.log(failures ? red(`\n${failures} lab(s) have problems.`) : green(`\nAll ${labs.length} labs are valid.`));
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------- REPL

const KUBECTL_VERBS = ["get", "describe", "create", "apply", "delete", "run", "expose", "scale", "set", "rollout", "logs", "exec", "label", "annotate", "patch", "replace", "edit", "cordon", "uncordon", "drain", "taint", "config", "auth", "wait", "explain", "api-resources", "cluster-info", "version", "top"];
const RESOURCES = ["pods", "deployments", "replicasets", "services", "endpoints", "configmaps", "secrets", "namespaces", "nodes", "events", "serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings", "networkpolicies", "ingresses", "persistentvolumeclaims", "all", "po", "deploy", "rs", "svc", "cm", "ns", "sa", "pvc"];
const LAB_COMMANDS = ["labs", "lab", "task", "check", "hint", "solution", "reset", "next", "sandbox", "help", "exit", "quit"];

class Repl {
  private labs: Lab[];
  private done: Set<string>;
  private lab?: Lab;
  private session?: LabSession;
  private shell!: Shell;
  private cluster!: Cluster;
  private rl!: readline.Interface;
  private buffer = "";
  private busy = false;
  private aborted = false;
  private lastChar = "\n";

  constructor(private opts: Options) {
    this.labs = loadLabs(opts.labsDir);
    this.done = loadProgress(opts.workDir);
  }

  private write(text: string): void {
    if (!text) return;
    process.stdout.write(text);
    this.lastChar = text[text.length - 1];
  }

  private print(text = ""): void {
    this.write(text + "\n");
  }

  private workFolder(name: string, clean: boolean): NodeFS {
    const dir = path.join(this.opts.workDir, name);
    if (clean && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return new NodeFS(dir);
  }

  private shellOptions(nodefs: NodeFS) {
    return {
      openEditor: (file: string) => {
        const editor = process.env.K8S_SIM_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR;
        if (!editor) return false;
        const target = nodefs.absolute(file);
        if (!fs.existsSync(target)) fs.writeFileSync(target, "");
        spawnSync(editor, [target], { stdio: "inherit", shell: true });
        return true;
      },
    };
  }

  private startSandbox(): void {
    this.lab = undefined;
    this.session = undefined;
    const nodefs = this.workFolder("sandbox", false);
    this.cluster = new Cluster();
    this.shell = new Shell(this.cluster, nodefs, this.shellOptions(nodefs));
    this.registerLabCommands();
  }

  private async startLab(lab: Lab, intro = true): Promise<void> {
    const nodefs = this.workFolder(lab.id, true);
    this.lab = lab;
    this.session = new LabSession(lab, nodefs, {}, this.shellOptions(nodefs));
    this.cluster = this.session.cluster;
    this.shell = this.session.shell;
    this.registerLabCommands();
    this.print(dim("Preparing the cluster..."));
    const errors = await this.session.setup();
    for (const e of errors) this.print(yellow(`setup warning: ${e}`));
    if (intro) this.showLab();
  }

  private showLab(): void {
    const lab = this.lab!;
    this.print("");
    this.print(bold(`Lab ${lab.id}: ${lab.title}`) + dim(`  (${lab.level}, about ${lab.minutes} min, ${lab.topic})`));
    this.print("");
    this.print(wrap(md(lab.intro)));
    this.print("");
    this.showTasks();
    this.print(dim(`Your files for this lab are in ${path.join(this.opts.workDir, lab.id)}`));
    this.print(dim("Lab commands: task, check, hint, solution, reset, next, labs, exit"));
  }

  private showTasks(): void {
    this.print(bold("Tasks:"));
    this.lab!.tasks.forEach((t, i) => this.print(wrap(`  ${i + 1}. ${md(t)}`)));
    this.print("");
  }

  private registerLabCommands(): void {
    const needLab = (io: IO): boolean => {
      if (this.lab) return true;
      io.stderr(`You are in the free sandbox. Start a lab first, e.g. ${cyan("lab 1")}. Type ${cyan("labs")} to see them all.\n`);
      return false;
    };
    const s = this.shell;
    s.registerCommand("labs", () => {
      this.print(listLabs(this.labs, this.done));
      return 0;
    });
    s.registerCommand("lab", async (args, io) => {
      if (!args[0]) {
        if (this.lab) this.showLab();
        else this.print(listLabs(this.labs, this.done));
        return 0;
      }
      const lab = findLab(this.labs, args[0]);
      if (!lab) {
        io.stderr(`No lab matches "${args[0]}". Type ${cyan("labs")} to see them.\n`);
        return 1;
      }
      await this.startLab(lab);
      return 0;
    });
    s.registerCommand("task", (_a, io) => {
      if (!needLab(io)) return 1;
      this.showTasks();
      return 0;
    });
    s.registerCommand("tasks", (_a, io) => {
      if (!needLab(io)) return 1;
      this.showTasks();
      return 0;
    });
    s.registerCommand("check", async (_a, io) => {
      if (!needLab(io)) return 1;
      const results = await this.session!.check();
      for (const r of results) this.print(r.passed ? `${green("✔")} ${r.name}` : `${red("✘")} ${r.name}${r.detail ? dim(`  (${r.detail})`) : ""}`);
      const passed = results.filter((r) => r.passed).length;
      this.print("");
      if (passed === results.length) {
        this.print(green(bold("All checks passed. Lab complete!")));
        if (this.lab!.learned) this.print("\n" + wrap(md(this.lab!.learned)));
        this.done.add(this.lab!.id);
        saveProgress(this.opts.workDir, this.done);
        const next = this.nextLab();
        this.print(next ? `\nType ${cyan("next")} to start: ${next.title}` : "\nYou finished the last lab in this set. Nice work.");
        return 0;
      }
      this.print(`${passed} of ${results.length} checks passed. Type ${cyan("hint")} if you are stuck.`);
      return 1;
    });
    s.registerCommand("hint", (_a, io) => {
      if (!needLab(io)) return 1;
      const h = this.session!.nextHint();
      if (!h) this.print("This lab has no hints.");
      else this.print(`${yellow(`Hint ${h.index}/${h.total}:`)} ${md(h.text)}`);
      return 0;
    });
    s.registerCommand("solution", (_a, io) => {
      if (!needLab(io)) return 1;
      this.print(yellow("One way to solve it (try on your own first, you learn more that way):"));
      for (const step of this.lab!.solution) this.print(step.split("\n").map((l) => "  " + cyan(l)).join("\n"));
      return 0;
    });
    s.registerCommand("reset", async (_a, io) => {
      if (!this.lab) {
        this.startSandbox();
        this.print("Sandbox reset to a fresh cluster.");
        return 0;
      }
      void io;
      await this.startLab(this.lab, false);
      this.print("Lab reset. The cluster and your lab files are back to the starting point.");
      return 0;
    });
    s.registerCommand("next", async (_a, io) => {
      const next = this.nextLab();
      if (!next) {
        io.stderr("There is no next lab.\n");
        return 1;
      }
      await this.startLab(next);
      return 0;
    });
    s.registerCommand("sandbox", () => {
      this.startSandbox();
      this.print("Free sandbox on a fresh cluster. Type labs to go back to the labs.");
      return 0;
    });
    s.registerCommand("help", () => {
      this.print(`${bold("k8s-sim help")}
  kubectl ... (or k ...)   run kubectl against the simulated cluster
  labs                     list the labs          lab <n>    start lab n
  task                     show the tasks again   check      check your work
  hint                     show the next hint     solution   show a solution
  reset                    restart the lab        next       go to the next lab
  sandbox                  free practice cluster  exit       leave

Shell features: pipes (| grep, awk, wc, head, base64 -d ...), > and >> redirects,
heredocs (cat <<EOF > file.yaml), export VAR=value, alias, cat, ls, rm.
Files live in ${this.shell.fs.cwd()}. Edit them with your own editor, or set
EDITOR (e.g. EDITOR="code --wait") to open them with vi/nano/code from here.`);
      return 0;
    });
  }

  private nextLab(): Lab | undefined {
    if (!this.lab) return this.labs[0];
    const i = this.labs.findIndex((l) => l.id === this.lab!.id);
    return this.labs[i + 1];
  }

  private prompt(): string {
    const tag = this.lab ? yellow(`[${this.lab.id.split("-")[0]}] `) : "";
    return `${tag}${green("controlplane")}:${cyan("~")}$ `;
  }

  private completer = (line: string): [string[], string] => {
    const words = line.split(/\s+/);
    const last = words[words.length - 1];
    let candidates: string[] = [];
    if (words.length === 1) candidates = ["kubectl", "k", ...LAB_COMMANDS, "cat", "ls", "clear"];
    else if (words[0] === "lab") candidates = this.labs.map((l) => l.id);
    else if (words[0] === "kubectl" || words[0] === "k") {
      const verb = words[1];
      if (words.length === 2) candidates = KUBECTL_VERBS;
      else if (words.length === 3 && ["get", "describe", "delete", "label", "annotate", "edit", "patch", "explain"].includes(verb)) candidates = RESOURCES;
      else if (words.length === 3 && ["scale", "expose", "rollout", "set"].includes(verb)) candidates = verb === "rollout" ? ["status", "history", "undo", "restart", "pause", "resume"] : verb === "set" ? ["image", "env", "resources", "serviceaccount"] : ["deployment", "replicaset", "pod", "service"];
      else if (words.length === 3 && ["logs", "exec"].includes(verb)) candidates = this.names("Pod");
      else if (words.length === 4 && ["get", "describe", "delete", "label", "annotate", "scale", "expose"].includes(verb)) {
        try {
          candidates = this.names(words[2]);
        } catch {
          candidates = [];
        }
      }
    }
    const hits = candidates.filter((c) => c.startsWith(last));
    return [hits.length ? hits : [], last];
  };

  private names(kind: string): string[] {
    const map: Record<string, string> = { po: "Pod", pod: "Pod", pods: "Pod", deploy: "Deployment", deployment: "Deployment", deployments: "Deployment", svc: "Service", service: "Service", services: "Service", rs: "ReplicaSet", replicaset: "ReplicaSet", replicasets: "ReplicaSet", ns: "Namespace", namespace: "Namespace", namespaces: "Namespace", no: "Node", node: "Node", nodes: "Node", cm: "ConfigMap", configmap: "ConfigMap", configmaps: "ConfigMap", secret: "Secret", secrets: "Secret" };
    const k = map[kind] ?? kind;
    const scoped = ["Namespace", "Node"].includes(k);
    return this.cluster.list(k, scoped ? undefined : this.shell.kubectl.state.namespace).map((o) => o.metadata.name);
  }

  async run(firstLab?: string): Promise<void> {
    this.startSandbox();
    this.print(`${bold("k8s-sim")} ${VERSION}  ${dim("Kubernetes training simulator. Nothing here runs real containers.")}`);
    this.print(dim(`Simulated cluster: controlplane, node01, node02 (Kubernetes ${K8S_VERSION})`));
    if (firstLab) {
      const lab = findLab(this.labs, firstLab);
      if (lab) await this.startLab(lab);
      else this.print(red(`No lab matches "${firstLab}".`));
    } else {
      this.print("");
      this.print(`Type ${cyan("labs")} to see the labs, ${cyan("lab 1")} to start the first one, or just use ${cyan("kubectl")}.`);
      this.print(`Type ${cyan("help")} for all commands.`);
    }
    this.print("");

    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: this.completer, historySize: 1000, terminal: true });
    this.rl.on("SIGINT", () => {
      if (this.busy) {
        this.aborted = true;
        this.print("^C");
        return;
      }
      this.buffer = "";
      this.print("^C" + dim("  (type exit to leave)"));
      this.rl.setPrompt(this.prompt());
      this.rl.prompt();
    });
    this.rl.on("close", () => {
      this.print("");
      process.exit(0);
    });
    this.rl.setPrompt(this.prompt());
    this.rl.prompt();
    this.rl.on("line", (line) => void this.onLine(line));
  }

  private async onLine(line: string): Promise<void> {
    if (this.busy) return;
    this.buffer = this.buffer ? this.buffer + "\n" + line : line;
    if (this.shell.needsMoreInput(this.buffer)) {
      this.rl.setPrompt("> ");
      this.rl.prompt();
      return;
    }
    const input = this.buffer;
    this.buffer = "";
    const trimmed = input.trim();
    if (trimmed === "exit" || trimmed === "quit" || trimmed === "logout") {
      this.rl.close();
      return;
    }
    if (trimmed) {
      this.busy = true;
      this.aborted = false;
      const io: IO = {
        stdout: (t) => this.write(t),
        stderr: (t) => this.write(t.startsWith("(k8s-sim)") ? yellow(t) : t),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        aborted: () => this.aborted,
      };
      try {
        await this.shell.exec(input, io);
      } catch (e) {
        this.print(red(`internal error: ${(e as Error).message}`));
        this.print(dim("Please report this at the project's GitHub issues page with the command you ran."));
      }
      this.busy = false;
    }
    if (this.lastChar !== "\n") this.write("\n");
    this.rl.setPrompt(this.prompt());
    this.rl.prompt();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.exec) {
    const cluster = new Cluster();
    const shell = new Shell(cluster, new NodeFS(path.join(opts.workDir, "sandbox")));
    const code = await shell.exec(opts.exec, {
      stdout: (t) => process.stdout.write(t),
      stderr: (t) => process.stderr.write(t),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    process.exit(code);
  }
  switch (opts.command) {
    case undefined:
    case "shell":
      await new Repl(opts).run();
      return;
    case "labs":
      console.log(listLabs(loadLabs(opts.labsDir), loadProgress(opts.workDir)));
      return;
    case "lab":
      if (!opts.labArg) {
        console.error("Usage: k8s-sim lab <id|number>");
        process.exit(1);
      }
      await new Repl(opts).run(opts.labArg);
      return;
    case "validate-labs":
      process.exit(await validateLabs(loadLabs(opts.labsDir)));
      return;
    default:
      console.error(`Unknown command "${opts.command}". Run k8s-sim --help.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
