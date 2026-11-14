// Timed mock exams in the style of the CKAD: weighted tasks, each on its own
// host reached with ssh from a base node, graded automatically at the end.

import { parse } from "yaml";
import type { ClusterOptions } from "../cluster.js";
import { MemoryFS, type FileSystem } from "../fs.js";
import type { IO } from "../kubectl/index.js";
import type { ShellOptions } from "../shell.js";
import { LabSession, type CheckResult } from "./session.js";
import { LabFormatError, type Lab, type LabCheck } from "./schema.js";

export interface ExamTask {
  /** 1-based question number. */
  n: number;
  host: string;
  weight: number;
  domain: string;
  title: string;
  text: string;
  setup: string[];
  files: Record<string, string>;
  settle: number;
  checks: LabCheck[];
  solution: string[];
}

export interface Exam {
  id: string;
  title: string;
  track: string;
  minutes: number;
  passPercent: number;
  intro: string;
  tasks: ExamTask[];
}

export function parseExam(text: string, source = "exam"): Exam {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new LabFormatError(`${source}: not a YAML object`);
  const id = String(raw.id ?? "");
  if (!id) throw new LabFormatError(`${source}: "id" is required`);
  const tasks = raw.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new LabFormatError(`exam ${id}: "tasks" must be a non-empty list`);
  const hosts = new Set<string>();
  const parsed = (tasks as Record<string, unknown>[]).map((t, i): ExamTask => {
    const where = `exam ${id}, task ${i + 1}`;
    const host = String(t.host ?? "");
    if (!/^[a-z0-9-]+$/.test(host)) throw new LabFormatError(`${where}: "host" must be a host name`);
    if (hosts.has(host)) throw new LabFormatError(`${where}: host ${host} is used by another task`);
    hosts.add(host);
    const checks = t.checks as LabCheck[];
    if (!Array.isArray(checks) || !checks.length) throw new LabFormatError(`${where}: "checks" must be a non-empty list`);
    for (const c of checks) if (!c?.name || (!c.kind && !c.command)) throw new LabFormatError(`${where}: every check needs a name and kind or command`);
    if (typeof t.text !== "string" || !t.text.trim()) throw new LabFormatError(`${where}: "text" is required`);
    if (!Array.isArray(t.solution) || !t.solution.length) throw new LabFormatError(`${where}: "solution" is required`);
    return {
      n: i + 1,
      host,
      weight: typeof t.weight === "number" ? t.weight : 4,
      domain: String(t.domain ?? "General"),
      title: String(t.title ?? `Task ${i + 1}`),
      text: t.text.trim(),
      setup: (t.setup as string[] | undefined) ?? [],
      files: (t.files as Record<string, string> | undefined) ?? {},
      settle: typeof t.settle === "number" ? t.settle : 20,
      checks,
      solution: t.solution as string[],
    };
  });
  return {
    id,
    title: String(raw.title ?? id),
    track: String(raw.track ?? "ckad"),
    minutes: typeof raw.minutes === "number" ? raw.minutes : 120,
    passPercent: typeof raw.passPercent === "number" ? raw.passPercent : 66,
    intro: String(raw.intro ?? "").trim(),
    tasks: parsed,
  };
}

/** Each task as a lab, for validation: setup, checks and solution. */
export function examTaskLabs(exam: Exam): Lab[] {
  return exam.tasks.map((t) => taskLab(exam, t));
}

function taskLab(exam: Exam, t: ExamTask): Lab {
  return {
    id: `${exam.id}-${t.n}`,
    title: t.title,
    level: "advanced",
    minutes: 0,
    tracks: [exam.track],
    topic: t.domain,
    intro: t.text,
    setup: t.setup,
    files: t.files,
    settle: t.settle,
    tasks: [t.text],
    checks: t.checks,
    hints: [],
    solution: t.solution,
  };
}

export interface TaskResult {
  task: ExamTask;
  checks: CheckResult[];
  /** Points earned, out of task.weight. */
  score: number;
  visited: boolean;
}

export interface ExamResult {
  tasks: TaskResult[];
  score: number;
  total: number;
  percent: number;
  passed: boolean;
  usedMs: number;
}

interface Host {
  session: LabSession;
  ready: Promise<string[]>;
}

const BASE = "base";

/**
 * One attempt at an exam. Commands run on the base node until the candidate
 * connects to a task's host with ssh; each host is its own simulated cluster.
 */
export class ExamSession {
  private hosts = new Map<string, Host>();
  private current = BASE;
  readonly startedAt: number;
  readonly flagged = new Set<number>();
  finished?: ExamResult;
  private baseFs: FileSystem = new MemoryFS();

  constructor(
    readonly exam: Exam,
    private options: { cluster?: () => ClusterOptions; shell?: ShellOptions; now?: () => number; fsFactory?: (host: string) => FileSystem } = {},
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get host(): string {
    return this.current;
  }

  /** The shell of the host the candidate is on, if not the base node. */
  get shell() {
    return this.hosts.get(this.current)?.session.shell;
  }

  get cluster() {
    return this.hosts.get(this.current)?.session.cluster;
  }

  task(n: number): ExamTask | undefined {
    return this.exam.tasks.find((t) => t.n === n);
  }

  taskOnHost(): ExamTask | undefined {
    return this.exam.tasks.find((t) => t.host === this.current);
  }

  remainingMs(): number {
    return Math.max(0, this.startedAt + this.exam.minutes * 60000 - this.now());
  }

  visited(n: number): boolean {
    const t = this.task(n);
    return !!t && this.hosts.has(t.host);
  }

  /** Prepare a task's host (runs its setup once). */
  prepare(t: ExamTask): Host {
    let h = this.hosts.get(t.host);
    if (!h) {
      const fs = this.options.fsFactory ? this.options.fsFactory(t.host) : new MemoryFS();
      const session = new LabSession(taskLab(this.exam, t), fs, this.options.cluster?.() ?? {}, this.options.shell ?? {});
      h = { session, ready: session.setup() };
      this.hosts.set(t.host, h);
    }
    return h;
  }

  prompt(): string {
    const inner = this.shell?.sessionPrompt();
    if (inner) return inner;
    return `candidate@${this.current}:~$ `;
  }

  needsMoreInput(text: string): boolean {
    return this.shell ? this.shell.needsMoreInput(text) : false;
  }

  async exec(input: string, io: IO): Promise<number> {
    const line = input.trim();
    if (this.finished) {
      io.stderr("The exam has ended. Review your results or start a new attempt.\n");
      return 1;
    }
    const inner = this.shell;
    if (inner?.kubectl.state.session) return inner.exec(input, io);
    const ssh = line.match(/^ssh\s+(?:-\S+\s+)*(?:candidate@)?([\w.-]+)\s*$/);
    if (ssh) {
      const host = ssh[1];
      if (host === this.current) {
        io.stderr(`(podsim) you are already on ${host}.\n`);
        return 0;
      }
      if (this.current !== BASE) {
        io.stderr(`(podsim) you are on ${this.current}. Type exit to return to the base node, then ssh ${host}.\n`);
        return 1;
      }
      const t = this.exam.tasks.find((x) => x.host === host);
      if (!t) {
        io.stderr(`ssh: Could not resolve hostname ${host}: Name or service not known\n`);
        return 255;
      }
      const fresh = !this.hosts.has(host);
      const h = this.prepare(t);
      const errors = await h.ready;
      for (const e of errors) io.stderr(`(podsim) setup warning: ${e}\n`);
      if (fresh) io.stdout(`Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0-79-generic x86_64)\n\n`);
      this.current = host;
      return 0;
    }
    if (this.current !== BASE) {
      if (/^(exit|logout)(\s+\d+)?$/.test(line)) {
        io.stdout(`logout\nConnection to ${this.current} closed.\n`);
        this.current = BASE;
        return 0;
      }
      if (line === "hostname") {
        io.stdout(this.current + "\n");
        return 0;
      }
      return inner!.exec(input, io);
    }
    // Base node: no cluster access, only ssh.
    if (!line) return 0;
    const cmd = line.split(/\s+/)[0];
    if (cmd === "kubectl" || cmd === "k" || cmd === "helm") {
      io.stderr(cmd === "helm" ? "Error: Kubernetes cluster unreachable: Get \"http://localhost:8080/version\": dial tcp 127.0.0.1:8080: connect: connection refused\n" : "E1114 10:00:00.000000    4321 memcache.go:265] couldn't get current server API group list: Get \"http://localhost:8080/api?timeout=32s\": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?\n");
      io.stderr(`(podsim) this is the base node. Each task names the host to work on, for example: ssh ${this.exam.tasks[0].host}\n`);
      return 1;
    }
    if (cmd === "hostname") {
      io.stdout("base\n");
      return 0;
    }
    if (cmd === "exit" || cmd === "logout") {
      io.stderr("(podsim) you are on the base node. Use ssh HOST to work on a task.\n");
      return 0;
    }
    if (cmd === "whoami") {
      io.stdout("candidate\n");
      return 0;
    }
    io.stderr(`(podsim) on the base node only ssh is available. Connect to a task's host, for example: ssh ${this.exam.tasks[0].host}\n`);
    return 1;
  }

  /** Grade every task. Tasks never opened are set up first, so they score zero unless already solved. */
  async grade(): Promise<ExamResult> {
    if (this.finished) return this.finished;
    const results: TaskResult[] = [];
    for (const t of this.exam.tasks) {
      const visited = this.hosts.has(t.host);
      let checks: CheckResult[];
      if (visited) {
        const h = this.hosts.get(t.host)!;
        await h.ready;
        checks = await h.session.check();
      } else checks = t.checks.map((c) => ({ name: c.name, passed: false, detail: "not attempted" }));
      const passed = checks.filter((c) => c.passed).length;
      results.push({ task: t, checks, score: (t.weight * passed) / checks.length, visited });
    }
    const total = this.exam.tasks.reduce((s, t) => s + t.weight, 0);
    const score = results.reduce((s, r) => s + r.score, 0);
    const percent = Math.round((score / total) * 100);
    this.finished = { tasks: results, score, total, percent, passed: percent >= this.exam.passPercent, usedMs: Math.min(this.exam.minutes * 60000, this.now() - this.startedAt) };
    this.current = BASE;
    return this.finished;
  }
}
