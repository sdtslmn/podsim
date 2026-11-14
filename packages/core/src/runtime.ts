// Simulated processes. A container's command runs through a small shell
// interpreter on the virtual clock: `sleep` waits, files are written to
// the container's filesystem, servers start listening on ports and output
// becomes the container log. The interpreter is written as generators so a
// long-running script (a loop with sleep) can pause and resume as virtual
// time passes, reading the cluster state at the moment each line runs.

import { parseScript, ParseError, type Node, type Word, type Redir } from "./shparse.js";

// ------------------------------------------------------------------ host interfaces

export const DIR = "\u0000dir";
export const DELETED = "\u0000deleted";

export interface Fs {
  read(path: string): string | undefined;
  isDir(path: string): boolean;
  list(dir: string): string[] | undefined;
  write(path: string, data: string, append: boolean): string | undefined;
  remove(path: string, recursive: boolean): string | undefined;
  mkdir(path: string, parents: boolean): string | undefined;
}

export interface NetResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Server =
  | { kind: "nginx" }
  | { kind: "static"; root: string; style: "busybox" | "python" }
  | { kind: "text"; body: string }
  | { kind: "whoami" }
  | { kind: "tcp"; name: string }
  | { kind: "ingress" };

export interface Host {
  /** Absolute virtual time, used only for exec mode. Processes use their own cursor. */
  now(): number;
  fs: Fs;
  /** Commands available in the image, or null for "everything". */
  tools: Set<string> | null;
  env: Record<string, string>;
  hostname: string;
  podIP: string;
  uid: number;
  gid: number;
  groups: number[];
  caps: Set<string>;
  /** Network tools (wget, curl, nslookup, nc -z, ping). */
  net(cmd: string, args: string[], stdin: string, at: number): NetResult;
  /** Called when a request is served, for access logs. */
  image: string;
}

export interface Line {
  t: number;
  text: string;
  err?: boolean;
}

type Y = { sleep: number } | { block: string };
type G = Generator<Y, number, void>;

interface IO {
  stdin: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

class ExitSignal {
  constructor(public code: number) {}
}
class ReturnSignal {
  constructor(public code: number) {}
}
class LoopSignal {
  constructor(public kind: "break" | "continue", public levels: number) {}
}

const MAX_LINES = 4000;

// ------------------------------------------------------------------ Proc

interface Job {
  gen: G;
  wakeAt: number;
  blocked?: string;
  done?: boolean;
}

/** A running process tree: the main shell plus any background jobs. */
export class Proc {
  cursor: number;
  readonly startedAt: number;
  lines: Line[] = [];
  dropped = 0;
  private partial: { out: string; err: string } = { out: "", err: "" };
  exited = false;
  exitCode = 0;
  exitAt = 0;
  readonly listens = new Map<number, Server>();
  readonly follows: string[] = [];
  private jobs: Job[] = [];
  private ops = 0;
  readonly x: Exec;

  constructor(public host: Host, argv: string[] | { script: string }, at: number, name = "sh") {
    this.cursor = at;
    this.startedAt = at;
    this.x = new Exec(this, host, { ...host.env, HOSTNAME: host.hostname, PWD: "/", "0": name });
    const main = this.x.mainGen(argv);
    this.jobs.push({ gen: main, wakeAt: at });
  }

  spawn(gen: G): void {
    this.jobs.push({ gen, wakeAt: this.cursor });
  }

  /** Advance to virtual time t, running every job whose wake-up time has come. */
  advance(t: number): void {
    for (let guard = 0; guard < 200000 && !this.exited; guard++) {
      const next = this.jobs.filter((j) => !j.done && !j.blocked).sort((a, b) => a.wakeAt - b.wakeAt)[0];
      if (!next || next.wakeAt > t) break;
      this.cursor = Math.max(this.cursor, next.wakeAt);
      this.ops = 0;
      let r: IteratorResult<Y, number>;
      try {
        r = next.gen.next();
      } catch (e) {
        r = { done: true, value: e instanceof ExitSignal ? e.code : 2 };
        if (!(e instanceof ExitSignal)) this.write(`sh: ${(e as Error).message ?? e}\n`, true);
      }
      if (r.done) {
        next.done = true;
        if (next === this.jobs[0]) {
          this.flush();
          this.exited = true;
          this.exitCode = r.value;
          this.exitAt = this.cursor;
        }
      } else if ("sleep" in r.value) next.wakeAt = this.cursor + r.value.sleep;
      else next.blocked = r.value.block;
    }
  }

  /** True once the main job is blocked forever (a server or `sleep infinity`). */
  get blocked(): string | undefined {
    return this.jobs[0]?.blocked;
  }

  tick(): Y | undefined {
    this.ops++;
    if (this.ops > 3000) {
      this.ops = 0;
      return { sleep: 1000 };
    }
    return undefined;
  }

  write(text: string, err = false): void {
    const key = err ? "err" : "out";
    const buf = this.partial[key] + text;
    const parts = buf.split("\n");
    this.partial[key] = parts.pop() ?? "";
    for (const p of parts) this.lines.push({ t: this.cursor, text: p, err });
    if (this.lines.length > MAX_LINES) {
      const n = this.lines.length - MAX_LINES;
      this.lines.splice(0, n);
      this.dropped += n;
    }
  }

  flush(): void {
    for (const key of ["out", "err"] as const) {
      if (this.partial[key]) {
        this.lines.push({ t: this.cursor, text: this.partial[key], err: key === "err" });
        this.partial[key] = "";
      }
    }
  }

  /** Log lines, including lines of files followed with `tail -f`. */
  logLines(): Line[] {
    const extra: Line[] = [];
    for (const f of this.follows) {
      const content = this.host.fs.read(f);
      if (content) for (const l of content.replace(/\n$/, "").split("\n")) extra.push({ t: this.cursor, text: l });
    }
    const pending = this.partial.out ? [{ t: this.cursor, text: this.partial.out }] : [];
    return [...this.lines, ...pending, ...extra.slice(-MAX_LINES)];
  }
}

/** Run a command to completion right now (kubectl exec, probes, $(...)). Sleeps are skipped. */
export function execNow(host: Host, argv: string[] | { script: string }, opts: { stdin?: string; maxMs?: number; vars?: Record<string, string> } = {}): { stdout: string; stderr: string; code: number; blocked?: string; vars?: Record<string, string> } {
  const at = host.now();
  const proc = new Proc(host, argv, at);
  if (opts.vars) Object.assign(proc.x.vars, opts.vars);
  const done = <T extends object>(r: T) => ({ ...r, vars: proc.x.vars });
  let stdout = "";
  let stderr = "";
  proc.x.sink = { out: (s) => (stdout += s), err: (s) => (stderr += s) };
  proc.x.stdin = opts.stdin ?? "";
  const gen = (proc as unknown as { jobs: Job[] }).jobs[0].gen;
  let budget = opts.maxMs ?? 60000;
  for (let i = 0; i < 100000; i++) {
    let r: IteratorResult<Y, number>;
    try {
      r = gen.next();
    } catch (e) {
      if (e instanceof ExitSignal) return done({ stdout, stderr, code: e.code, exited: true });
      return done({ stdout, stderr: stderr + `sh: ${(e as Error).message}\n`, code: 2 });
    }
    if (r.done) return done({ stdout, stderr, code: r.value });
    if ("block" in r.value) return done({ stdout, stderr, code: 0, blocked: r.value.block });
    budget -= r.value.sleep;
    proc.cursor += r.value.sleep;
    if (budget < 0) return done({ stdout, stderr, code: 0, blocked: "timeout" });
  }
  return done({ stdout, stderr, code: 0, blocked: "timeout" });
}

// ------------------------------------------------------------------ interpreter

const SHELL_BUILTINS = new Set([
  ":", "true", "false", "echo", "printf", "exit", "return", "break", "continue", "export", "local", "readonly", "unset", "set", "shift",
  "trap", "cd", "pwd", "ulimit", "umask", "wait", "read", "test", "[", "[[", "sh", "bash", "ash", "exec", "eval", ".", "source", "type", "command", "let", "times", "alias", "__serve",
]);

export class Exec {
  funcs = new Map<string, Node>();
  last = 0;
  sink?: { out: (s: string) => void; err: (s: string) => void };
  stdin = "";
  depth = 0;
  seed = 4242;

  constructor(public proc: Proc, public host: Host, public vars: Record<string, string>) {}

  get time(): number {
    return this.proc.cursor;
  }

  rootIO(): IO {
    return {
      stdin: this.stdin,
      out: (s) => (this.sink ? this.sink.out(s) : this.proc.write(s)),
      err: (s) => (this.sink ? this.sink.err(s) : this.proc.write(s, true)),
    };
  }

  *mainGen(argv: string[] | { script: string }): G {
    const io = this.rootIO();
    try {
      if ("script" in argv) return yield* this.runScript(argv.script, io);
      if (argv.length === 0) return 0;
      return yield* this.runArgv(argv, io);
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    }
  }

  *runScript(script: string, io: IO): G {
    let node: Node;
    try {
      node = parseScript(script);
    } catch (e) {
      if (e instanceof ParseError) {
        io.err(`sh: ${e.message}\n`);
        return 2;
      }
      throw e;
    }
    return yield* this.run(node, io);
  }

  *run(node: Node, io: IO): G {
    const t = this.proc.tick();
    if (t) yield t;
    switch (node.type) {
      case "cmd":
        return (this.last = yield* this.runCmd(node, io));
      case "pipe": {
        let input = io.stdin;
        let code = 0;
        for (let i = 0; i < node.cmds.length; i++) {
          const lastCmd = i === node.cmds.length - 1;
          let captured = "";
          const sub: IO = { stdin: input, out: lastCmd ? io.out : (s) => (captured += s), err: io.err };
          code = yield* this.run(node.cmds[i], sub);
          input = captured;
        }
        if (node.negate) code = code === 0 ? 1 : 0;
        return (this.last = code);
      }
      case "and": {
        const l = yield* this.run(node.left, io);
        return (this.last = l === 0 ? yield* this.run(node.right, io) : l);
      }
      case "or": {
        const l = yield* this.run(node.left, io);
        return (this.last = l !== 0 ? yield* this.run(node.right, io) : l);
      }
      case "list": {
        let code = 0;
        for (const item of node.items) code = yield* this.run(item, io);
        return code;
      }
      case "bg": {
        const child = new Exec(this.proc, this.host, { ...this.vars });
        child.funcs = this.funcs;
        child.sink = this.sink;
        const gen = (function* (): G {
          try {
            return yield* child.run(node.node, io);
          } catch (e) {
            if (e instanceof ExitSignal) return e.code;
            throw e;
          }
        })();
        this.proc.spawn(gen);
        this.vars["!"] = String(1000 + Math.floor(this.time % 1000));
        return 0;
      }
      case "loop": {
        let code = 0;
        const lio = yield* this.redirectIO(node.redirs, io);
        if (!lio) return 1;
        for (let i = 0; ; i++) {
          const c = yield* this.run(node.cond, lio);
          if ((c === 0) === node.until) break;
          try {
            code = yield* this.run(node.body, lio);
          } catch (e) {
            if (e instanceof LoopSignal) {
              if (e.levels > 1) throw new LoopSignal(e.kind, e.levels - 1);
              if (e.kind === "break") break;
              continue;
            }
            throw e;
          }
        }
        return code;
      }
      case "for": {
        const items = node.words ? yield* this.expandWords(node.words) : (this.vars["@"] ?? "").split(" ").filter(Boolean);
        let code = 0;
        for (const it of items) {
          this.vars[node.name] = it;
          try {
            code = yield* this.run(node.body, io);
          } catch (e) {
            if (e instanceof LoopSignal) {
              if (e.levels > 1) throw new LoopSignal(e.kind, e.levels - 1);
              if (e.kind === "break") break;
              continue;
            }
            throw e;
          }
        }
        return code;
      }
      case "if": {
        for (const b of node.branches) {
          const c = yield* this.run(b.cond, io);
          if (c === 0) return yield* this.run(b.body, io);
        }
        return node.otherwise ? yield* this.run(node.otherwise, io) : 0;
      }
      case "case": {
        const value = (yield* this.expandWord(node.word)).join(" ");
        for (const arm of node.arms) {
          for (const p of arm.patterns) {
            const pat = (yield* this.expandWord(p, false)).join(" ");
            if (globMatch(pat, value)) return yield* this.run(arm.body, io);
          }
        }
        return 0;
      }
      case "group": {
        const gio = yield* this.redirectIO(node.redirs, io);
        if (!gio) return 1;
        if (!node.subshell) return yield* this.run(node.body, gio);
        const saved = { ...this.vars };
        try {
          return yield* this.run(node.body, gio);
        } catch (e) {
          if (e instanceof ExitSignal) return e.code;
          throw e;
        } finally {
          this.vars = saved;
        }
      }
      case "func":
        this.funcs.set(node.name, node.body);
        return 0;
    }
  }

  /** Apply redirections; returns undefined (after printing an error) if a file can't be opened. */
  *redirectIO(redirs: Redir[], io: IO): Generator<Y, IO | undefined, void> {
    let out = io.out;
    let err = io.err;
    let stdin = io.stdin;
    for (const r of redirs) {
      if (r.op === "2>&1") {
        err = out;
        continue;
      }
      if (r.op === ">&2") {
        out = err;
        continue;
      }
      if (r.op === "<<") {
        stdin = yield* this.expandHeredoc(r.heredoc ?? "");
        continue;
      }
      const target = (yield* this.expandWord(r.target ?? [])).join(" ");
      const path = this.abs(target);
      if (r.op === "<") {
        const content = this.host.fs.read(path);
        if (content === undefined) {
          io.err(`sh: can't open '${target}': No such file or directory\n`);
          return undefined;
        }
        stdin = content;
        continue;
      }
      if (path === "/dev/null") {
        if (r.op === "2>" || r.op === "2>>") err = () => {};
        else if (r.op === "&>") (out = () => {}), (err = () => {});
        else out = () => {};
        continue;
      }
      if (path === "/dev/stdout" || path === "/proc/1/fd/1") continue;
      if (path === "/dev/stderr" || path === "/proc/1/fd/2") {
        out = err;
        continue;
      }
      const append = r.op === ">>" || r.op === "2>>";
      if (!append) {
        const e = this.host.fs.write(path, "", false);
        if (e) {
          io.err(`sh: can't create ${target}: ${e}\n`);
          return undefined;
        }
      } else {
        const e = this.host.fs.write(path, "", true);
        if (e) {
          io.err(`sh: can't create ${target}: ${e}\n`);
          return undefined;
        }
      }
      const writer = (s: string) => {
        this.host.fs.write(path, s, true);
      };
      if (r.op === "2>" || r.op === "2>>") err = writer;
      else if (r.op === "&>") (out = writer), (err = writer);
      else out = writer;
    }
    return { stdin, out, err };
  }

  abs(p: string): string {
    if (!p) return this.vars.PWD ?? "/";
    const base = p.startsWith("/") ? p : `${this.vars.PWD ?? "/"}/${p}`;
    return normalizePath(base);
  }

  *runCmd(node: Extract<Node, { type: "cmd" }>, io: IO): G {
    const argv = yield* this.expandWords(node.words);
    const assigned: [string, string][] = [];
    for (const [name, w] of node.assigns) assigned.push([name, (yield* this.expandWord(w, false)).join(" ")]);
    const cio = yield* this.redirectIO(node.redirs, io);
    if (!cio) return 1;
    if (argv.length === 0) {
      for (const [k, v] of assigned) this.vars[k] = v;
      return 0;
    }
    const saved: [string, string | undefined][] = assigned.map(([k]) => [k, this.vars[k]]);
    for (const [k, v] of assigned) this.vars[k] = v;
    try {
      return yield* this.runArgv(argv, cio);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete this.vars[k];
        else this.vars[k] = v;
      }
    }
  }

  *runArgv(argv: string[], io: IO): G {
    const name = argv[0].replace(/^\/(usr\/)?(local\/)?(s)?bin\//, "");
    const args = argv.slice(1);
    const fn = this.funcs.get(name);
    if (fn) {
      const saved = { ...this.vars };
      args.forEach((a, i) => (this.vars[String(i + 1)] = a));
      this.vars["@"] = args.join(" ");
      this.vars["#"] = String(args.length);
      try {
        return yield* this.run(fn, io);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.code;
        throw e;
      } finally {
        for (const k of Object.keys(this.vars)) if (/^\d+$/.test(k) || k === "@" || k === "#") delete this.vars[k];
        for (const k of Object.keys(saved)) if (/^\d+$/.test(k) || k === "@" || k === "#") this.vars[k] = saved[k];
      }
    }
    const tools = this.host.tools;
    if (tools && !tools.has(name) && !SHELL_BUILTINS.has(name) && !(name === "[" || name === "test")) {
      if (argv[0].startsWith("/") || argv[0].startsWith("./")) {
        const content = this.host.fs.read(this.abs(argv[0]));
        if (content !== undefined) return yield* this.runScript(content, io);
        io.err(`sh: ${argv[0]}: not found\n`);
        return 127;
      }
      io.err(`sh: ${name}: not found\n`);
      return 127;
    }
    const builtin = BUILTINS[name];
    if (!builtin) {
      io.err(`sh: ${name}: not found\n`);
      return 127;
    }
    return yield* builtin(this, args, io, name);
  }

  // ---------------------------------------------------------------- expansion

  *expandWords(words: Word[]): Generator<Y, string[], void> {
    const out: string[] = [];
    for (const w of words) out.push(...(yield* this.expandWord(w)));
    return out;
  }

  /** Expand one word. Unquoted expansions are split on whitespace when `split` is true. */
  *expandWord(word: Word, split = true): Generator<Y, string[], void> {
    const fields: string[] = [];
    let cur = "";
    let hasQuoted = false;
    for (const part of word) {
      if (part.q === 1) {
        cur += part.s;
        hasQuoted = true;
        continue;
      }
      const expanded = yield* this.expandText(part.s);
      if (part.q === 2) {
        cur += expanded;
        hasQuoted = true;
        continue;
      }
      if (!split) {
        cur += expanded;
        continue;
      }
      // Unquoted: split the expanded text on whitespace (only text produced by expansion really, but close enough).
      const pieces = expanded.split(/[ \t\n]+/);
      if (pieces.length === 1) {
        cur += pieces[0];
        continue;
      }
      cur += pieces[0];
      if (cur || hasQuoted) fields.push(cur);
      for (let i = 1; i < pieces.length - 1; i++) if (pieces[i]) fields.push(pieces[i]);
      cur = pieces[pieces.length - 1];
      hasQuoted = false;
    }
    if (cur || hasQuoted) fields.push(cur);
    if (split && word.length === 1 && word[0].q === 0 && /[*?]/.test(word[0].s) && !word[0].s.includes("$")) return this.glob(fields);
    return fields;
  }

  glob(fields: string[]): string[] {
    const out: string[] = [];
    for (const f of fields) {
      if (!/[*?]/.test(f)) {
        out.push(f);
        continue;
      }
      const absPat = this.abs(f);
      const dir = absPat.slice(0, absPat.lastIndexOf("/")) || "/";
      const pat = absPat.slice(absPat.lastIndexOf("/") + 1);
      const names = (this.host.fs.list(dir) ?? []).filter((n) => globMatch(pat, n)).sort();
      if (names.length === 0) out.push(f);
      else for (const n of names) out.push(f.includes("/") ? `${dir === "/" ? "" : dir}/${n}` : n);
    }
    return out;
  }

  *expandHeredoc(text: string): Generator<Y, string, void> {
    return yield* this.expandText(text);
  }

  *expandText(s: string): Generator<Y, string, void> {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && (s[i + 1] === "$" || s[i + 1] === "`")) {
        out += s[i + 1];
        i++;
        continue;
      }
      if (c !== "$") {
        out += c;
        continue;
      }
      const next = s[i + 1];
      if (next === "(" && s[i + 2] === "(") {
        const end = findClose(s, i + 1);
        const expr = s.slice(i + 3, end - 1);
        out += String(arith(yield* this.expandText(expr), this.vars));
        i = end;
        continue;
      }
      if (next === "(") {
        const end = findClose(s, i + 1);
        const inner = s.slice(i + 2, end);
        let captured = "";
        const sub: IO = { stdin: "", out: (x) => (captured += x), err: (x) => this.rootIO().err(x) };
        const saved = { ...this.vars };
        try {
          yield* this.runScript(inner, sub);
        } catch (e) {
          if (!(e instanceof ExitSignal)) throw e;
        }
        this.vars = { ...saved, "?": String(this.last) };
        out += captured.replace(/\n+$/, "");
        i = end;
        continue;
      }
      if (next === "{") {
        const end = s.indexOf("}", i);
        const inner = s.slice(i + 2, end);
        const m = inner.match(/^(#?)([A-Za-z_][\w]*|\d+|[@#?$!])(?:(:?[-=+?])(.*))?$/);
        if (m) {
          const v = this.lookup(m[2]);
          if (m[1] === "#") out += String((v ?? "").length);
          else if (m[3]) {
            const empty = m[3].startsWith(":") ? !v : v === undefined;
            const op = m[3].replace(":", "");
            const word = yield* this.expandText(m[4] ?? "");
            if (op === "-") out += empty ? word : v;
            else if (op === "=") {
              if (empty) this.vars[m[2]] = word;
              out += empty ? word : v;
            } else if (op === "+") out += empty ? "" : word;
            else out += v ?? "";
          } else out += v ?? "";
        }
        i = end;
        continue;
      }
      const m = s.slice(i + 1).match(/^([A-Za-z_]\w*|\d|[@#?$!*])/);
      if (m) {
        out += this.lookup(m[1]) ?? "";
        i += m[1].length;
        continue;
      }
      out += "$";
    }
    return out;
  }

  lookup(name: string): string | undefined {
    if (name === "?") return String(this.last);
    if (name === "$") return "1";
    if (name === "RANDOM") {
      this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
      return String(this.seed % 32768);
    }
    if (name === "SECONDS") return String(Math.floor((this.time - this.proc.startedAt) / 1000));
    if (name === "*") return this.vars["@"];
    return this.vars[name];
  }
}

function findClose(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return s.length - 1;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(value);
}

/** Integer arithmetic for $((...)) and let. */
export function arith(expr: string, vars: Record<string, string>): number {
  const src = expr.replace(/[A-Za-z_]\w*/g, (n) => String(parseInt(vars[n] ?? "0", 10) || 0));
  let i = 0;
  const peek = () => src.slice(i).match(/^\s*(\d+|==|!=|<=|>=|&&|\|\||[-+*/%()<>!])/)?.[1];
  const take = () => {
    const m = src.slice(i).match(/^\s*(\d+|==|!=|<=|>=|&&|\|\||[-+*/%()<>!])/);
    if (!m) throw new Error(`arithmetic syntax error`);
    i += m[0].length;
    return m[1];
  };
  const primary = (): number => {
    const t = take();
    if (t === "(") {
      const v = or();
      take();
      return v;
    }
    if (t === "-") return -primary();
    if (t === "+") return primary();
    if (t === "!") return primary() ? 0 : 1;
    const n = parseInt(t, 10);
    if (Number.isNaN(n)) throw new Error("arithmetic syntax error");
    return n;
  };
  const mul = (): number => {
    let v = primary();
    for (let p = peek(); p === "*" || p === "/" || p === "%"; p = peek()) {
      take();
      const r = primary();
      if ((p === "/" || p === "%") && r === 0) throw new Error("divide by zero");
      v = p === "*" ? v * r : p === "/" ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    for (let p = peek(); p === "+" || p === "-"; p = peek()) {
      take();
      v = p === "+" ? v + mul() : v - mul();
    }
    return v;
  };
  const cmp = (): number => {
    let v = add();
    for (let p = peek(); p && ["<", ">", "<=", ">=", "==", "!="].includes(p); p = peek()) {
      take();
      const r = add();
      v = Number(p === "<" ? v < r : p === ">" ? v > r : p === "<=" ? v <= r : p === ">=" ? v >= r : p === "==" ? v === r : v !== r);
    }
    return v;
  };
  const and = (): number => {
    let v = cmp();
    while (peek() === "&&") {
      take();
      const r = cmp();
      v = Number(!!v && !!r);
    }
    return v;
  };
  const or = (): number => {
    let v = and();
    while (peek() === "||") {
      take();
      const r = and();
      v = Number(!!v || !!r);
    }
    return v;
  };
  if (!src.trim()) return 0;
  return or();
}

// ------------------------------------------------------------------ builtins

type Builtin = (x: Exec, args: string[], io: IO, name: string) => G;

function sync(fn: (x: Exec, args: string[], io: IO, name: string) => number): Builtin {
  return function* (x, args, io, name) {
    return fn(x, args, io, name);
  };
}

function parseSleep(arg: string | undefined): number | "forever" | undefined {
  if (arg === undefined) return undefined;
  if (arg === "infinity" || arg === "inf") return "forever";
  const m = arg.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Math.round(n * ({ "": 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]] ?? 1000));
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDate(ms: number, fmt?: string): string {
  const d = new Date(ms);
  const map: Record<string, string> = {
    Y: String(d.getUTCFullYear()),
    y: pad(d.getUTCFullYear() % 100),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    e: String(d.getUTCDate()).padStart(2, " "),
    H: pad(d.getUTCHours()),
    M: pad(d.getUTCMinutes()),
    S: pad(d.getUTCSeconds()),
    s: String(Math.floor(ms / 1000)),
    N: pad(d.getUTCMilliseconds(), 3) + "000000",
    a: DAY[d.getUTCDay()],
    A: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()],
    b: MON[d.getUTCMonth()],
    h: MON[d.getUTCMonth()],
    Z: "UTC",
    z: "+0000",
    j: pad(Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1, 3),
    "%": "%",
    n: "\n",
    t: "\t",
  };
  map.T = `${map.H}:${map.M}:${map.S}`;
  map.F = `${map.Y}-${map.m}-${map.d}`;
  map.D = `${map.m}/${map.d}/${map.y}`;
  map.R = `${map.H}:${map.M}`;
  map.c = `${map.a} ${map.b} ${map.e} ${map.T} ${map.Y}`;
  if (!fmt) return `${map.a} ${map.b} ${map.e} ${map.T} UTC ${map.Y}`;
  return fmt.replace(/%(.)/g, (_, k) => map[k] ?? `%${k}`);
}

function readInputs(x: Exec, files: string[], io: IO, name: string): string | undefined {
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) return io.stdin;
  let out = "";
  for (const f of files) {
    const p = x.abs(f);
    if (x.host.fs.isDir(p)) {
      io.err(`${name}: read error: Is a directory\n`);
      return undefined;
    }
    const c = x.host.fs.read(p);
    if (c === undefined) {
      io.err(`${name}: can't open '${f}': No such file or directory\n`);
      return undefined;
    }
    out += c;
  }
  return out;
}

function lines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\n$/, "").split("\n");
}

function testExpr(x: Exec, a: string[]): boolean {
  if (a.length === 0) return false;
  if (a[0] === "!") return !testExpr(x, a.slice(1));
  const idxAnd = a.indexOf("-a");
  if (idxAnd > 0) return testExpr(x, a.slice(0, idxAnd)) && testExpr(x, a.slice(idxAnd + 1));
  const idxOr = a.indexOf("-o");
  if (idxOr > 0) return testExpr(x, a.slice(0, idxOr)) || testExpr(x, a.slice(idxOr + 1));
  if (a.length === 1) return a[0] !== "";
  if (a.length === 2) {
    const [op, v] = a;
    const p = x.abs(v);
    switch (op) {
      case "-z":
        return v === "";
      case "-n":
        return v !== "";
      case "-e":
        return x.host.fs.read(p) !== undefined || x.host.fs.isDir(p);
      case "-f":
      case "-r":
      case "-s":
        return x.host.fs.read(p) !== undefined && !x.host.fs.isDir(p) && (op !== "-s" || (x.host.fs.read(p) ?? "").length > 0);
      case "-d":
        return x.host.fs.isDir(p);
      case "-w":
        return x.host.fs.read(p) !== undefined;
      case "-x":
        return x.host.fs.read(p) !== undefined;
      default:
        return false;
    }
  }
  const [l, op, r] = a;
  const ln = parseInt(l, 10);
  const rn = parseInt(r, 10);
  switch (op) {
    case "=":
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    case "-eq":
      return ln === rn;
    case "-ne":
      return ln !== rn;
    case "-lt":
      return ln < rn;
    case "-le":
      return ln <= rn;
    case "-gt":
      return ln > rn;
    case "-ge":
      return ln >= rn;
    default:
      return false;
  }
}

function serveCommand(x: Exec, port: number, server: Server, io: IO, name: string): number | undefined {
  if (x.proc.listens.has(port) || otherListen(x, port)) {
    io.err(name === "nginx" ? `nginx: [emerg] bind() to 0.0.0.0:${port} failed (98: Address in use)\n` : `${name}: bind: Address in use\n`);
    return 1;
  }
  if (port < 1024 && x.host.uid !== 0 && !x.host.caps.has("NET_BIND_SERVICE")) {
    io.err(name === "nginx" ? `nginx: [emerg] bind() to 0.0.0.0:${port} failed (13: Permission denied)\n` : `${name}: bind: Permission denied\n`);
    return 1;
  }
  x.proc.listens.set(port, server);
  return undefined;
}

let otherListen: (x: Exec, port: number) => boolean = () => false;
/** The pod runtime tells the interpreter about ports other containers in the pod already use. */
export function setPortChecker(fn: (x: Exec, port: number) => boolean): void {
  otherListen = fn;
}

export const NGINX_START_LOGS = [
  "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
  "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
  "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
  "10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf",
  "10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf",
  "/docker-entrypoint.sh: Configuration complete; ready for start up",
  "[notice] 1#1: using the \"epoll\" event method",
  "[notice] 1#1: nginx/1.29.3",
  "[notice] 1#1: start worker processes",
];

/** Ports nginx would listen on, from its config files. */
export function nginxPorts(fs: Fs): number[] {
  const conf = [fs.read("/etc/nginx/nginx.conf") ?? "", ...(fs.list("/etc/nginx/conf.d") ?? []).filter((n) => n.endsWith(".conf")).map((n) => fs.read(`/etc/nginx/conf.d/${n}`) ?? "")].join("\n");
  const ports = [...conf.matchAll(/^\s*listen\s+(?:\[::\]:)?(\d+)/gm)].map((m) => parseInt(m[1], 10));
  return [...new Set(ports.length ? ports : [80])];
}

function* startNginx(x: Exec, args: string[], io: IO): G {
  if (args.includes("-t")) {
    io.err("nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n");
    return 0;
  }
  if (x.host.uid !== 0 && x.host.fs.write("/var/cache/nginx/client_temp/.probe", "", false)) {
    io.err(`nginx: [warn] the "user" directive makes sense only if the master process runs with super-user privileges, ignored in /etc/nginx/nginx.conf:2\n`);
    io.err(`nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)\n`);
    return 1;
  }
  for (const port of nginxPorts(x.host.fs)) {
    const e = serveCommand(x, port, { kind: "nginx" }, io, "nginx");
    if (e !== undefined) return e;
  }
  const foreground = args.some((a) => /daemon\s+off/.test(a));
  if (foreground) {
    io.out(NGINX_START_LOGS.map((l) => l + "\n").join(""));
    yield { block: "nginx" };
    return 0;
  }
  return 0;
}

function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (n.length === 2 && args[i].startsWith(n) && args[i].length > 2 && !args[i].startsWith("--")) return args[i].slice(2);
      if (args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

const BUILTINS: Record<string, Builtin> = {
  ":": sync(() => 0),
  true: sync(() => 0),
  false: sync(() => 1),
  echo: sync((x, args, io) => {
    let newline = true;
    let escapes = false;
    while (args[0] && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes("n")) newline = false;
      if (args[0].includes("e")) escapes = true;
      args = args.slice(1);
    }
    let text = args.join(" ");
    if (escapes) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    io.out(text + (newline ? "\n" : ""));
    return 0;
  }),
  printf: sync((x, args, io) => {
    if (!args.length) {
      io.err("printf: usage: printf FORMAT [ARGUMENT]...\n");
      return 1;
    }
    const fmt = args[0].replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    let rest = args.slice(1);
    let out = "";
    do {
      out += fmt.replace(/%(-?\d*)([sdif%])/g, (_, w, k) => {
        if (k === "%") return "%";
        const v = rest.shift() ?? "";
        const s = k === "s" ? v : k === "f" ? (parseFloat(v) || 0).toFixed(6) : String(parseInt(v, 10) || 0);
        const width = parseInt(w, 10);
        return width ? (width < 0 ? s.padEnd(-width) : s.padStart(width)) : s;
      });
    } while (rest.length && /%[sdif]/.test(fmt));
    io.out(out);
    return 0;
  }),
  exit: sync((x, args) => {
    throw new ExitSignal(args[0] !== undefined ? parseInt(args[0], 10) & 255 : x.last);
  }),
  return: sync((x, args) => {
    throw new ReturnSignal(args[0] !== undefined ? parseInt(args[0], 10) : x.last);
  }),
  break: sync((x, args) => {
    throw new LoopSignal("break", parseInt(args[0] ?? "1", 10) || 1);
  }),
  continue: sync((x, args) => {
    throw new LoopSignal("continue", parseInt(args[0] ?? "1", 10) || 1);
  }),
  export: sync((x, args) => {
    for (const a of args) {
      const i = a.indexOf("=");
      if (i > 0) x.vars[a.slice(0, i)] = a.slice(i + 1);
    }
    return 0;
  }),
  unset: sync((x, args) => {
    for (const a of args) delete x.vars[a];
    return 0;
  }),
  set: sync(() => 0),
  shift: sync((x, args) => {
    const n = parseInt(args[0] ?? "1", 10);
    const list = (x.vars["@"] ?? "").split(" ").filter(Boolean).slice(n);
    for (const k of Object.keys(x.vars)) if (/^\d+$/.test(k) && k !== "0") delete x.vars[k];
    list.forEach((v, i) => (x.vars[String(i + 1)] = v));
    x.vars["@"] = list.join(" ");
    x.vars["#"] = String(list.length);
    return 0;
  }),
  trap: sync(() => 0),
  ulimit: sync((x, args, io) => {
    if (!args.length || args.includes("-a")) io.out("unlimited\n");
    return 0;
  }),
  umask: sync(() => 0),
  wait: sync(() => 0),
  alias: sync(() => 0),
  type: sync((x, args, io) => {
    for (const a of args) io.out(`${a} is ${SHELL_BUILTINS.has(a) ? "a shell builtin" : `/bin/${a}`}\n`);
    return 0;
  }),
  command: function* (x, args, io) {
    if (args[0] === "-v") {
      const t = args[1];
      if (t && (!x.host.tools || x.host.tools.has(t) || SHELL_BUILTINS.has(t))) {
        io.out(SHELL_BUILTINS.has(t) ? `${t}\n` : `/bin/${t}\n`);
        return 0;
      }
      return 1;
    }
    return yield* x.runArgv(args, io);
  },
  let: sync((x, args) => {
    let v = 0;
    for (const a of args) {
      const m = a.match(/^([A-Za-z_]\w*)=(.*)$/);
      if (m) {
        v = arith(m[2], x.vars);
        x.vars[m[1]] = String(v);
      } else v = arith(a, x.vars);
    }
    return v === 0 ? 1 : 0;
  }),
  local: sync((x, args) => {
    for (const a of args) {
      const i = a.indexOf("=");
      if (i > 0) x.vars[a.slice(0, i)] = a.slice(i + 1);
    }
    return 0;
  }),
  readonly: sync((x, args) => {
    for (const a of args) {
      const i = a.indexOf("=");
      if (i > 0) x.vars[a.slice(0, i)] = a.slice(i + 1);
    }
    return 0;
  }),
  cd: sync((x, args, io) => {
    const target = x.abs(args[0] ?? x.vars.HOME ?? "/");
    if (!x.host.fs.isDir(target)) {
      io.err(`sh: cd: can't cd to ${args[0]}: No such file or directory\n`);
      return 2;
    }
    x.vars.PWD = target;
    return 0;
  }),
  pwd: sync((x, args, io) => {
    io.out((x.vars.PWD ?? "/") + "\n");
    return 0;
  }),
  read: sync((x, args, io) => {
    const names = args.filter((a) => !a.startsWith("-"));
    if (!io.stdin) return 1;
    const nl = io.stdin.indexOf("\n");
    const line = nl >= 0 ? io.stdin.slice(0, nl) : io.stdin;
    io.stdin = nl >= 0 ? io.stdin.slice(nl + 1) : "";
    const parts = line.split(/\s+/);
    names.forEach((n, i) => (x.vars[n] = i === names.length - 1 ? parts.slice(i).join(" ") : parts[i] ?? ""));
    if (!names.length) x.vars.REPLY = line;
    return 0;
  }),
  test: sync((x, args) => (testExpr(x, args) ? 0 : 1)),
  "[": sync((x, args, io) => {
    if (args[args.length - 1] !== "]") {
      io.err("sh: missing ]\n");
      return 2;
    }
    return testExpr(x, args.slice(0, -1)) ? 0 : 1;
  }),
  "[[": sync((x, args) => (testExpr(x, args.filter((a) => a !== "]]")) ? 0 : 1)),
  eval: function* (x, args, io) {
    return yield* x.runScript(args.join(" "), io);
  },
  ".": function* (x, args, io) {
    const c = x.host.fs.read(x.abs(args[0] ?? ""));
    if (c === undefined) {
      io.err(`sh: .: can't open '${args[0]}': No such file or directory\n`);
      return 2;
    }
    return yield* x.runScript(c, io);
  },
  sh: function* (x, args, io, name) {
    if (args[0] === "-c" || args[0] === "-ec" || args[0] === "-xc" || args[0] === "-euc") {
      if (args[1] === undefined) {
        io.err(`${name}: -c requires an argument\n`);
        return 2;
      }
      const saved = { ...x.vars };
      args.slice(2).forEach((a, i) => (x.vars[String(i)] = a));
      try {
        return yield* x.runScript(args[1], io);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        throw e;
      } finally {
        x.vars = saved;
      }
    }
    if (args[0] && !args[0].startsWith("-")) {
      const c = x.host.fs.read(x.abs(args[0]));
      if (c === undefined) {
        io.err(`${name}: can't open '${args[0]}': No such file or directory\n`);
        return 2;
      }
      try {
        return yield* x.runScript(c, io);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        throw e;
      }
    }
    if (io.stdin) return yield* x.runScript(io.stdin, io);
    return 0;
  },
  exec: function* (x, args, io) {
    if (!args.length) return 0;
    const code = yield* x.runArgv(args, io);
    throw new ExitSignal(code);
  },
  sleep: function* (x, args, io) {
    const ms = parseSleep(args[0]);
    if (ms === undefined) {
      io.err(args[0] === undefined ? "sleep: missing operand\n" : `sleep: invalid number '${args[0]}'\n`);
      return 1;
    }
    if (ms === "forever") {
      yield { block: "sleep" };
      return 0;
    }
    if (ms > 0) yield { sleep: ms };
    return 0;
  },
  date: sync((x, args, io) => {
    if (args.includes("-s") || args.some((a) => a.startsWith("--set"))) {
      if (!x.host.caps.has("SYS_TIME")) {
        io.err("date: can't set date: Operation not permitted\n");
        return 1;
      }
      io.out(formatDate(x.time) + "\n");
      return 0;
    }
    const fmt = args.find((a) => a.startsWith("+"));
    io.out(formatDate(x.time, fmt?.slice(1)) + "\n");
    return 0;
  }),
  hostname: sync((x, args, io) => {
    io.out((args.includes("-i") ? x.host.podIP : x.host.hostname) + "\n");
    return 0;
  }),
  whoami: sync((x, args, io) => {
    if (x.host.uid === 0) io.out("root\n");
    else {
      io.err(`whoami: unknown uid ${x.host.uid}\n`);
      return 1;
    }
    return 0;
  }),
  id: sync((x, args, io) => {
    const u = x.host.uid;
    if (args.includes("-u")) io.out(`${u}\n`);
    else if (args.includes("-g")) io.out(`${x.host.gid}\n`);
    else if (u === 0) io.out(`uid=0(root) gid=0(root) groups=0(root)${x.host.groups.filter((g) => g !== 0).map((g) => `,${g}`).join("")}\n`);
    else io.out(`uid=${u} gid=${x.host.gid} groups=${[...new Set([x.host.gid, ...x.host.groups])].join(",")}\n`);
    return 0;
  }),
  uname: sync((x, args, io) => {
    io.out(args.includes("-a") ? `Linux ${x.host.hostname} 6.8.0-79-generic #79-Ubuntu SMP x86_64 GNU/Linux\n` : args.includes("-r") ? "6.8.0-79-generic\n" : "Linux\n");
    return 0;
  }),
  nproc: sync((x, args, io) => {
    io.out("2\n");
    return 0;
  }),
  env: function* (x, args, io) {
    const assigns = args.filter((a) => /^[A-Za-z_]\w*=/.test(a));
    const cmd = args.filter((a) => !/^[A-Za-z_]\w*=/.test(a) && a !== "-i");
    if (cmd.length) {
      const saved = { ...x.vars };
      for (const a of assigns) x.vars[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
      try {
        return yield* x.runArgv(cmd, io);
      } finally {
        x.vars = saved;
      }
    }
    io.out(exportedEnv(x).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    return 0;
  },
  printenv: sync((x, args, io) => {
    if (args.length) {
      let code = 0;
      for (const a of args) {
        const v = exportedEnv(x).find(([k]) => k === a)?.[1];
        if (v === undefined) code = 1;
        else io.out(v + "\n");
      }
      return code;
    }
    io.out(exportedEnv(x).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    return 0;
  }),
  cat: sync((x, args, io) => {
    const files = args.filter((a) => a === "-" || !a.startsWith("-"));
    if (files.length === 0) {
      io.out(io.stdin);
      return 0;
    }
    let code = 0;
    for (const f of files) {
      if (f === "-") {
        io.out(io.stdin);
        continue;
      }
      const p = x.abs(f);
      if (x.host.fs.isDir(p)) {
        io.err(`cat: read error: Is a directory\n`);
        code = 1;
        continue;
      }
      const c = x.host.fs.read(p);
      if (c === undefined) {
        io.err(`cat: can't open '${f}': No such file or directory\n`);
        code = 1;
        continue;
      }
      io.out(c);
    }
    return code;
  }),
  tee: sync((x, args, io) => {
    const append = args.includes("-a");
    let code = 0;
    for (const f of args.filter((a) => !a.startsWith("-"))) {
      const e = x.host.fs.write(x.abs(f), io.stdin, append);
      if (e) {
        io.err(`tee: ${f}: ${e}\n`);
        code = 1;
      }
    }
    io.out(io.stdin);
    return code;
  }),
  touch: sync((x, args, io) => {
    let code = 0;
    for (const f of args.filter((a) => !a.startsWith("-"))) {
      const p = x.abs(f);
      if (x.host.fs.read(p) !== undefined || x.host.fs.isDir(p)) continue;
      const e = x.host.fs.write(p, "", true);
      if (e) {
        io.err(`touch: ${f}: ${e}\n`);
        code = 1;
      }
    }
    return code;
  }),
  rm: sync((x, args, io) => {
    const force = args.some((a) => /^-[a-z]*f/.test(a));
    const recursive = args.some((a) => /^-[a-z]*[rR]/.test(a));
    let code = 0;
    for (const f of args.filter((a) => !a.startsWith("-"))) {
      const p = x.abs(f);
      if (x.host.fs.isDir(p) && !recursive) {
        io.err(`rm: '${f}' is a directory\n`);
        code = 1;
        continue;
      }
      if (x.host.fs.read(p) === undefined && !x.host.fs.isDir(p)) {
        if (!force) {
          io.err(`rm: can't remove '${f}': No such file or directory\n`);
          code = 1;
        }
        continue;
      }
      const e = x.host.fs.remove(p, recursive);
      if (e) {
        io.err(`rm: can't remove '${f}': ${e}\n`);
        code = 1;
      }
    }
    return code;
  }),
  mkdir: sync((x, args, io) => {
    const parents = args.some((a) => /^-[a-z]*p/.test(a));
    let code = 0;
    for (const f of args.filter((a) => !a.startsWith("-"))) {
      const e = x.host.fs.mkdir(x.abs(f), parents);
      if (e) {
        io.err(`mkdir: can't create directory '${f}': ${e}\n`);
        code = 1;
      }
    }
    return code;
  }),
  cp: sync((x, args, io) => {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length < 2) {
      io.err("cp: missing file operand\n");
      return 1;
    }
    const dest = x.abs(files[files.length - 1]);
    for (const f of files.slice(0, -1)) {
      const c = x.host.fs.read(x.abs(f));
      if (c === undefined) {
        io.err(`cp: can't stat '${f}': No such file or directory\n`);
        return 1;
      }
      const target = x.host.fs.isDir(dest) ? `${dest}/${f.split("/").pop()}` : dest;
      const e = x.host.fs.write(target, c, false);
      if (e) {
        io.err(`cp: can't create '${target}': ${e}\n`);
        return 1;
      }
    }
    return 0;
  }),
  mv: sync((x, args, io) => {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length !== 2) {
      io.err("mv: missing file operand\n");
      return 1;
    }
    const src = x.abs(files[0]);
    const c = x.host.fs.read(src);
    if (c === undefined) {
      io.err(`mv: can't rename '${files[0]}': No such file or directory\n`);
      return 1;
    }
    const dest = x.abs(files[1]);
    const target = x.host.fs.isDir(dest) ? `${dest}/${files[0].split("/").pop()}` : dest;
    const e = x.host.fs.write(target, c, false) ?? x.host.fs.remove(src, false);
    if (e) {
      io.err(`mv: can't rename '${files[0]}': ${e}\n`);
      return 1;
    }
    return 0;
  }),
  ls: sync((x, args, io) => {
    const long = args.some((a) => /^-[a-zA-Z]*l/.test(a));
    const all = args.some((a) => /^-[a-zA-Z]*a/.test(a));
    const targets = args.filter((a) => !a.startsWith("-"));
    let code = 0;
    const show = (names: string[], dir: string) => {
      const visible = names.filter((n) => all || !n.startsWith(".")).sort();
      if (long) io.out(visible.map((n) => lsLong(x, `${dir === "/" ? "" : dir}/${n}`, n)).join("\n") + (visible.length ? "\n" : ""));
      else if (visible.length) io.out(visible.join("\n") + "\n");
    };
    for (const t of targets.length ? targets : ["."]) {
      const p = x.abs(t);
      if (x.host.fs.isDir(p)) {
        if (targets.length > 1) io.out(`${t}:\n`);
        show(x.host.fs.list(p) ?? [], p);
      } else if (x.host.fs.read(p) !== undefined) io.out(long ? lsLong(x, p, t) + "\n" : t + "\n");
      else {
        io.err(`ls: ${t}: No such file or directory\n`);
        code = 1;
      }
    }
    return code;
  }),
  head: sync((x, args, io, name) => {
    const n = parseInt(flag(args, "-n") ?? args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? "10", 10);
    const files = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-n");
    const text = readInputs(x, files, io, name);
    if (text === undefined) return 1;
    const ls = lines(text).slice(0, n);
    if (ls.length) io.out(ls.join("\n") + "\n");
    return 0;
  }),
  tail: function* (x, args, io, name) {
    const follow = args.some((a) => /^-[a-zA-Z]*[fF]/.test(a)) || args.includes("--follow");
    const nArg = flag(args, "-n") ?? args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? "10";
    const n = parseInt(nArg.replace("+", ""), 10);
    const files = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-n");
    if (follow && files.length) {
      const p = x.abs(files[0]);
      if (x.host.fs.read(p) === undefined && !args.includes("-F")) {
        io.err(`tail: can't open '${files[0]}': No such file or directory\n`);
        io.err("tail: no files\n");
        return 1;
      }
      if (x.sink) {
        const c = x.host.fs.read(p) ?? "";
        const ls = lines(c).slice(-n);
        if (ls.length) io.out(ls.join("\n") + "\n");
        yield { block: "tail" };
    return 0;
      }
      x.proc.follows.push(p);
      yield { block: "tail" };
    return 0;
    }
    const text = readInputs(x, files, io, name);
    if (text === undefined) return 1;
    const ls = nArg.startsWith("+") ? lines(text).slice(n - 1) : lines(text).slice(-n);
    if (ls.length) io.out(ls.join("\n") + "\n");
    if (follow) yield { block: "tail" };
    return 0;
    return 0;
  },
  wc: sync((x, args, io, name) => {
    const text = readInputs(x, args.filter((a) => !a.startsWith("-")), io, name);
    if (text === undefined) return 1;
    const l = (text.match(/\n/g) ?? []).length;
    const w = text.split(/\s+/).filter(Boolean).length;
    if (args.includes("-l")) io.out(`${l}\n`);
    else if (args.includes("-w")) io.out(`${w}\n`);
    else if (args.includes("-c")) io.out(`${text.length}\n`);
    else io.out(`${String(l).padStart(7)} ${String(w).padStart(7)} ${String(text.length).padStart(7)}\n`);
    return 0;
  }),
  grep: sync((x, args, io, name) => {
    const opts = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
    const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
    const pattern = rest[0];
    if (pattern === undefined) {
      io.err("Usage: grep [-HhnlLoqvsrRiwFE] PATTERN [FILE]...\n");
      return 2;
    }
    const text = readInputs(x, rest.slice(1), io, name);
    if (text === undefined) return 2;
    let re: RegExp;
    try {
      re = new RegExp(opts.includes("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern.replace(/\\\|/g, "|"), opts.includes("i") ? "i" : "");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const matched = lines(text).filter((l) => re.test(l) !== opts.includes("v"));
    if (opts.includes("c")) io.out(`${matched.length}\n`);
    else if (!opts.includes("q") && matched.length) io.out(matched.join("\n") + "\n");
    return matched.length ? 0 : 1;
  }),
  sort: sync((x, args, io, name) => {
    const text = readInputs(x, args.filter((a) => !a.startsWith("-")), io, name);
    if (text === undefined) return 1;
    let ls = lines(text);
    ls = args.includes("-n") ? ls.sort((a, b) => parseFloat(a) - parseFloat(b)) : ls.sort();
    if (args.includes("-r")) ls.reverse();
    if (args.includes("-u")) ls = [...new Set(ls)];
    if (ls.length) io.out(ls.join("\n") + "\n");
    return 0;
  }),
  uniq: sync((x, args, io, name) => {
    const text = readInputs(x, args.filter((a) => !a.startsWith("-")), io, name);
    if (text === undefined) return 1;
    const ls = lines(text).filter((l, i, all) => i === 0 || l !== all[i - 1]);
    if (ls.length) io.out(ls.join("\n") + "\n");
    return 0;
  }),
  tr: sync((x, args, io) => {
    const [a, b] = args.filter((v) => !v.startsWith("-"));
    if (args.includes("-d")) io.out(io.stdin.split("").filter((c) => !(a ?? "").includes(c)).join(""));
    else {
      const expand = (s: string) => s.replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz").replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ").replace(/(\w)-(\w)/g, (_, p, q) => {
        let r = "";
        for (let c = p.charCodeAt(0); c <= q.charCodeAt(0); c++) r += String.fromCharCode(c);
        return r;
      });
      const from = expand(a ?? "");
      const to = expand(b ?? "");
      io.out(io.stdin.split("").map((c) => (from.includes(c) ? to[Math.min(from.indexOf(c), to.length - 1)] ?? c : c)).join(""));
    }
    return 0;
  }),
  cut: sync((x, args, io, name) => {
    const d = flag(args, "-d") ?? "\t";
    const fields = (flag(args, "-f") ?? "1").split(",").map((n) => parseInt(n, 10) - 1);
    const files = args.filter((a, i) => !a.startsWith("-") && !["-d", "-f"].includes(args[i - 1] ?? ""));
    const text = readInputs(x, files, io, name);
    if (text === undefined) return 1;
    const out = lines(text).map((l) => fields.map((f) => l.split(d)[f] ?? "").join(d));
    if (out.length) io.out(out.join("\n") + "\n");
    return 0;
  }),
  sed: sync((x, args, io, name) => {
    const expr = args.find((a) => /^s(.).*\1.*\1[gi]*$/.test(a));
    const files = args.filter((a) => a !== expr && !a.startsWith("-"));
    const text = readInputs(x, files, io, name);
    if (text === undefined) return 1;
    if (!expr) {
      io.out(text);
      return 0;
    }
    const sep = expr[1];
    const [, from, to, fl] = expr.split(sep);
    const result = text.replace(new RegExp(from, (fl ?? "").includes("g") ? "g" : ""), to ?? "");
    if (args.includes("-i") && files[0]) x.host.fs.write(x.abs(files[0]), result, false);
    else io.out(result);
    return 0;
  }),
  awk: sync((x, args, io, name) => {
    const prog = args.find((a) => a.includes("{")) ?? "";
    const m = prog.match(/print\s+(.+?)\s*\}/);
    const files = args.filter((a) => a !== prog && !a.startsWith("-"));
    const text = readInputs(x, files, io, name);
    if (text === undefined) return 1;
    const sep = flag(args, "-F");
    const out = lines(text).map((l) => {
      const f = sep ? l.split(sep) : l.trim().split(/\s+/);
      if (!m) return l;
      return m[1].split(/\s*,\s*/).map((e) => (e === "$0" ? l : e.startsWith("$") ? f[parseInt(e.slice(1), 10) - 1] ?? "" : e.replace(/"/g, ""))).join(" ");
    });
    if (out.length) io.out(out.join("\n") + "\n");
    return 0;
  }),
  seq: sync((x, args, io) => {
    const n = args.map((a) => parseInt(a, 10));
    const [first, inc, last] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : [n[0], n[1], n[2]];
    const out: number[] = [];
    for (let v = first; inc > 0 ? v <= last : v >= last; v += inc) {
      out.push(v);
      if (out.length > 100000) break;
    }
    if (out.length) io.out(out.join("\n") + "\n");
    return 0;
  }),
  expr: sync((x, args, io) => {
    try {
      const v = arith(args.join(" ").replace(/\\\*/g, "*"), x.vars);
      io.out(`${v}\n`);
      return v === 0 ? 1 : 0;
    } catch {
      io.err("expr: syntax error\n");
      return 2;
    }
  }),
  basename: sync((x, args, io) => {
    io.out((args[0] ?? "").replace(/\/+$/, "").split("/").pop() + "\n");
    return 0;
  }),
  dirname: sync((x, args, io) => {
    const p = (args[0] ?? "").replace(/\/+$/, "");
    io.out((p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : ".") + "\n");
    return 0;
  }),
  base64: sync((x, args, io, name) => {
    const text = readInputs(x, args.filter((a) => !a.startsWith("-")), io, name);
    if (text === undefined) return 1;
    try {
      if (args.includes("-d") || args.includes("--decode")) {
        const bin = atob(text.replace(/\s+/g, ""));
        io.out(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      } else {
        let bin = "";
        for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
        io.out(btoa(bin) + "\n");
      }
    } catch {
      io.err("base64: invalid input\n");
      return 1;
    }
    return 0;
  }),
  chmod: sync(() => 0),
  chown: sync((x, args, io) => {
    if (x.host.uid !== 0) {
      io.err(`chown: ${args[args.length - 1]}: Operation not permitted\n`);
      return 1;
    }
    return 0;
  }),
  find: sync((x, args, io) => {
    const root = x.abs(args.find((a) => !a.startsWith("-")) ?? ".");
    const nameIdx = args.indexOf("-name");
    const pat = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return;
      for (const n of x.host.fs.list(dir) ?? []) {
        const p = `${dir === "/" ? "" : dir}/${n}`;
        if (!pat || globMatch(pat, n)) out.push(p);
        if (x.host.fs.isDir(p)) walk(p, depth + 1);
      }
    };
    if (!pat || globMatch(pat, root.split("/").pop() ?? "")) out.unshift(root);
    walk(root, 0);
    io.out(out.join("\n") + "\n");
    return 0;
  }),
  df: sync((x, args, io) => {
    io.out("Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               19586931   6262428  13308119  32% /\ntmpfs                    65536         0     65536   0% /dev\n");
    return 0;
  }),
  free: sync((x, args, io) => {
    io.out("              total        used        free      shared  buff/cache   available\nMem:        4005592     1201580      812400        4120     1991612     2552208\nSwap:             0           0           0\n");
    return 0;
  }),
  ps: sync((x, args, io) => {
    io.out(`PID   USER     TIME  COMMAND\n    1 ${x.host.uid === 0 ? "root    " : String(x.host.uid).padEnd(8)}  0:00 ${x.vars["0"] ?? "sh"}\n`);
    return 0;
  }),
  kill: sync((x, args, io) => {
    if (args.some((a) => a === "1" || a === "-9")) io.err("sh: can't kill pid 1: Operation not permitted\n");
    return 0;
  }),
  ip: sync((x, args, io) => {
    if (args[0] === "link" && args.some((a) => a === "set" || a === "add") && !x.host.caps.has("NET_ADMIN")) {
      io.err("ip: SIOCSIFFLAGS: Operation not permitted\n");
      return 1;
    }
    io.out(`1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue qlen 1000\n    inet 127.0.0.1/8 scope host lo\n2: eth0@if12: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1450 qdisc noqueue\n    inet ${x.host.podIP}/24 brd ${x.host.podIP.replace(/\.\d+$/, ".255")} scope global eth0\n`);
    return 0;
  }),
  ifconfig: sync((x, args, io) => {
    io.out(`eth0      Link encap:Ethernet  HWaddr 2E:7A:1B:44:9C:01\n          inet addr:${x.host.podIP}  Bcast:0.0.0.0  Mask:255.255.255.0\n\nlo        Link encap:Local Loopback\n          inet addr:127.0.0.1  Mask:255.0.0.0\n`);
    return 0;
  }),
  nginx: function* (x, args, io) {
    return yield* startNginx(x, args, io);
  },
  "nginx-debug": function* (x, args, io) {
    return yield* startNginx(x, args, io);
  },
  "httpd-foreground": function* (x, args, io) {
    const e = serveCommand(x, 80, { kind: "static", root: "/usr/local/apache2/htdocs", style: "busybox" }, io, "httpd");
    if (e !== undefined) return e;
    io.out("[mpm_event:notice] AH00489: Apache/2.4 (Unix) configured -- resuming normal operations\n");
    yield { block: "httpd" };
    return 0;
  },
  httpd: function* (x, args, io) {
    if (x.host.image.startsWith("httpd")) return yield* BUILTINS["httpd-foreground"](x, args, io, "httpd");
    const port = parseInt((flag(args, "-p") ?? "80").split(":").pop() ?? "80", 10);
    const root = x.abs(flag(args, "-h") ?? x.vars.PWD ?? "/");
    const e = serveCommand(x, port, { kind: "static", root, style: "busybox" }, io, "httpd");
    if (e !== undefined) return e;
    if (args.includes("-f")) yield { block: "httpd" };
    return 0;
    return 0;
  },
  python: pythonServer,
  python3: pythonServer,
  nc: function* (x, args, io) {
    if (args.some((a) => /^-[a-zA-Z]*l/.test(a))) {
      const port = parseInt(flag(args, "-p") ?? args.find((a) => /^\d+$/.test(a)) ?? "0", 10);
      if (!port) {
        io.err("nc: bad port\n");
        return 1;
      }
      const body = io.stdin;
      const e = serveCommand(x, port, body ? { kind: "text", body } : { kind: "tcp", name: "nc" }, io, "nc");
      if (e !== undefined) return e;
      yield { block: "nc" };
    return 0;
    }
    const r = x.host.net("nc", args, io.stdin, x.time);
    io.out(r.stdout);
    io.err(r.stderr);
    return r.code;
  },
  "redis-server": tcpServer(6379, "redis"),
  /** Internal: start one of the built-in image servers. __serve KIND PORT [TEXT] */
  __serve: function* (x, args, io) {
    const [kind, portText, ...rest] = args;
    const server: Server =
      kind === "nginx" ? { kind: "nginx" } : kind === "whoami" ? { kind: "whoami" } : kind === "ingress" ? { kind: "ingress" } : kind === "text" ? { kind: "text", body: rest.join(" ") } : kind === "static" ? { kind: "static", root: rest[0] ?? "/", style: "busybox" } : { kind: "tcp", name: rest[0] ?? kind };
    for (const port of (portText ?? "80").split(",").map((n) => parseInt(n, 10))) {
      const e = serveCommand(x, port, server, io, rest[0] ?? kind);
      if (e !== undefined) return e;
    }
    yield { block: kind };
    return 0;
  },
  "docker-entrypoint.sh": function* (x, args, io) {
    if (args.length) return yield* x.runArgv(args, io);
    return 0;
  },
  "/docker-entrypoint.sh": function* (x, args, io) {
    if (args.length) return yield* x.runArgv(args, io);
    return 0;
  },
};

for (const tool of ["wget", "curl", "nslookup", "host", "dig", "ping", "telnet", "traceroute"]) {
  BUILTINS[tool] = sync((x, args, io) => {
    const r = x.host.net(tool, args, io.stdin, x.time) as NetResult & { saveAs?: { name: string; body: string } };
    if (r.saveAs) {
      const e = x.host.fs.write(x.abs(r.saveAs.name), r.saveAs.body, false);
      if (e) {
        io.err(`wget: can't open '${r.saveAs.name}': ${e}\n`);
        return 1;
      }
    }
    io.out(r.stdout);
    io.err(r.stderr);
    return r.code;
  });
}
BUILTINS.bash = BUILTINS.sh;
BUILTINS.ash = BUILTINS.sh;
BUILTINS.source = BUILTINS["."];

function* pythonServer(x: Exec, args: string[], io: IO, name: string): G {
  const mIdx = args.indexOf("-m");
  if (mIdx >= 0 && args[mIdx + 1] === "http.server") {
    const port = parseInt(args[mIdx + 2] ?? "8000", 10) || 8000;
    const e = serveCommand(x, port, { kind: "static", root: x.vars.PWD ?? "/", style: "python" }, io, name);
    if (e !== undefined) return e;
    io.err(`Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...\n`);
    yield { block: "python" };
    return 0;
  }
  if (args[0] === "-c") {
    io.out("");
    return 0;
  }
  io.err(`(podsim) only "python -m http.server" is simulated\n`);
  return 1;
}

function tcpServer(port: number, name: string): Builtin {
  return function* (x, args, io) {
    const p = parseInt(flag(args, "--port") ?? String(port), 10);
    const e = serveCommand(x, p, { kind: "tcp", name }, io, name);
    if (e !== undefined) return e;
    yield { block: name };
    return 0;
  };
}

function exportedEnv(x: Exec): [string, string][] {
  const skip = new Set(["0", "@", "#", "?", "!", "PWD", "REPLY", "OLDPWD"]);
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(x.vars)) {
    if (skip.has(k) || /^\d+$/.test(k)) continue;
    out.push([k, v]);
  }
  if (x.vars.PWD) out.push(["PWD", x.vars.PWD]);
  return out;
}

function lsLong(x: Exec, path: string, name: string): string {
  const dir = x.host.fs.isDir(path);
  const size = dir ? 4096 : (x.host.fs.read(path) ?? "").length;
  const link = path.startsWith("/etc/config") || path.includes("..data") ? "l" : "";
  return `${link || (dir ? "d" : "-")}rw${dir ? "x" : "-"}r-${dir ? "x" : "-"}r-${dir ? "x" : "-"}    ${dir ? 2 : 1} root     root     ${String(size).padStart(9)} ${formatDate(x.time, "%b %e %H:%M")} ${name}`;
}
