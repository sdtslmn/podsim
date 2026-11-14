// A tiny shell around kubectl: variables, aliases, pipes, redirects,
// heredocs and the handful of Unix tools people pipe kubectl output into
// (grep, head, tail, wc, awk, cut, sort, base64, xargs ...). It runs the
// same in Node and in the browser.

import type { FileSystem } from "./fs.js";
import type { Cluster } from "./cluster.js";
import { execInContainer, identityFor, hostNet } from "./podruntime.js";
import { execNow, hasBuiltin, normalizePath, type Fs, type Host } from "./runtime.js";
import { parseImage } from "./images.js";
import { helm } from "./helm/index.js";
import { containerTool } from "./containertool.js";
import { Kubectl, type IO } from "./kubectl/index.js";
import { toBase64, fromBase64 } from "./cluster.js";

export type ExtraCommand = (args: string[], io: IO) => Promise<number> | number;

interface Word {
  text: string;
}
type Token = { type: "word"; value: string } | { type: "op"; value: string };

export interface ShellOptions {
  /** Extra commands such as lab helpers (check, hint, ...). */
  commands?: Record<string, ExtraCommand>;
  /** Called for vi/vim/nano/code. Return true if the host handled it. */
  openEditor?: (path: string) => Promise<boolean> | boolean;
}

const NOOP_COMMANDS = new Set(["source", ".", "complete", "set", "shopt", "bind", "history", "unset", "hash", "type"]);

export class Shell {
  readonly kubectl: Kubectl;
  readonly vars = new Map<string, string>();
  readonly aliases = new Map<string, string>([["k", "kubectl"]]);
  private commands: Record<string, ExtraCommand>;

  constructor(
    readonly cluster: Cluster,
    readonly fs: FileSystem,
    private opts: ShellOptions = {},
  ) {
    this.kubectl = new Kubectl(cluster, fs);
    this.commands = opts.commands ?? {};
    this.vars.set("HOME", "/root");
    this.vars.set("USER", "root");
  }

  registerCommand(name: string, fn: ExtraCommand): void {
    this.commands[name] = fn;
  }

  /** True when the text so far opens a heredoc, a quote or ends with a backslash. */
  needsMoreInput(text: string): boolean {
    const lines = text.split("\n");
    if (/\\$/.test(lines[lines.length - 1])) return true;
    let i = 0;
    while (i < lines.length) {
      const h = heredocOf(lines[i]);
      if (h) {
        let j = i + 1;
        while (j < lines.length && (h.strip ? lines[j].replace(/^\t+/, "") : lines[j]) !== h.delim) j++;
        if (j >= lines.length) return true;
        i = j + 1;
        continue;
      }
      i++;
    }
    return unbalancedQuotes(text.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1(\n|$)/g, ""));
  }

  /** The prompt to show while inside a container (kubectl exec -it), or undefined. */
  sessionPrompt(): string | undefined {
    const s = this.kubectl.state.session;
    if (!s) return undefined;
    const pod = this.cluster.get("Pod", s.pod, s.namespace);
    const c = [...(pod?.spec?.containers ?? []), ...(pod?.spec?.initContainers ?? []), ...(pod?.spec?.ephemeralContainers ?? [])].find((x: { name: string }) => x.name === s.container);
    const cwd = s.vars.PWD ?? "/";
    const user = pod && c ? identityFor(pod, c).uid : 0;
    const image = c ? parseImage(c.image).repository : "busybox";
    if (s.bash || !["busybox", "alpine", "curlimages/curl", "nicolaka/netshoot", "polinux/stress"].includes(image)) return user === 0 ? `root@${s.pod}:${cwd}# ` : `I have no name!@${s.pod}:${cwd}$ `;
    return `${cwd === (user === 0 ? "/root" : "") ? "~" : cwd} ${user === 0 ? "#" : "$"} `;
  }

  /** Run one line inside the current container session. */
  private async sessionLine(input: string, io: IO): Promise<number> {
    const s = this.kubectl.state.session!;
    const line = input.trim();
    const end = (code: number) => {
      this.kubectl.state.session = undefined;
      if (s.remove) {
        this.cluster.advance();
        if (this.cluster.get("Pod", s.pod, s.namespace)) this.cluster.remove("Pod", s.pod, s.namespace);
        io.stdout(`pod "${s.pod}" deleted\n`);
      }
      return code;
    };
    const exitMatch = line.match(/^(exit|logout)(\s+(\d+))?$/);
    if (exitMatch) {
      const code = parseInt(exitMatch[3] ?? "0", 10);
      const p = this.cluster.get("Pod", s.pod, s.namespace);
      const eph = (p?.spec?.ephemeralContainers ?? []).some((c: { name: string }) => c.name === s.container);
      if (eph) io.stdout(`Session ended, the ephemeral container will not be restarted but may be reattached using 'kubectl attach ${s.pod} -c ${s.container} -i -t' if it is still running\n`);
      else if (!s.remove && (p?.spec?.containers ?? []).find((c: { name: string; stdin?: boolean }) => c.name === s.container)?.stdin) io.stdout(`Session ended, resume using 'kubectl attach ${s.pod} -c ${s.container} -i -t' command when the pod is running\n`);
      if (code !== 0 && !s.remove) io.stderr(`command terminated with exit code ${code}\n`);
      return end(code);
    }
    if (!line) return 0;
    this.cluster.advance();
    const pod = this.cluster.get("Pod", s.pod, s.namespace);
    const sim = pod ? this.cluster.podSims.get(pod.metadata.uid!) : undefined;
    const cs = sim?.containers[s.container];
    const c = [...(pod?.spec?.containers ?? []), ...(pod?.spec?.initContainers ?? []), ...(pod?.spec?.ephemeralContainers ?? [])].find((x: { name: string }) => x.name === s.container);
    if (!pod || !cs || !c || cs.phase !== "running") {
      io.stderr("command terminated with exit code 137\n");
      return end(137);
    }
    const r = execInContainer(this.cluster, pod, c, cs, { script: input }, "", s.vars);
    if (r.vars) s.vars = Object.fromEntries(Object.entries(r.vars).filter(([k]) => !["0", "@", "#", "?"].includes(k)));
    if (r.stdout) io.stdout(r.stdout);
    if (r.stderr) io.stderr(r.stderr);
    if (r.blocked && r.blocked !== "timeout") io.stderr(`(podsim) "${line.split(/\s/)[0]}" keeps running in a real shell; the simulator shows what it printed and returns. Press Ctrl+C in a real terminal to stop it.\n`);
    if (r.exited) return end(r.code);
    this.cluster.advance();
    return r.code;
  }

  /** Execute one or more lines of input. Returns the exit code of the last command. */
  async exec(input: string, io: IO): Promise<number> {
    if (this.kubectl.state.session) return this.sessionLine(input, io);
    const lines = input.replace(/\r/g, "").split("\n");
    let code = 0;
    let i = 0;
    while (i < lines.length) {
      let line = lines[i++];
      while (line.endsWith("\\") && i < lines.length) line = line.slice(0, -1) + " " + lines[i++];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      let heredoc: string | undefined;
      const h = heredocOf(line);
      if (h) {
        const body: string[] = [];
        while (i < lines.length && (h.strip ? lines[i].replace(/^\t+/, "") : lines[i]) !== h.delim) {
          body.push(h.strip ? lines[i].replace(/^\t+/, "") : lines[i]);
          i++;
        }
        i++;
        heredoc = body.join("\n") + "\n";
        if (!h.quoted) heredoc = this.expandHeredoc(heredoc);
        line = line.replace(/<<-?\s*['"]?\w+['"]?/, "");
      }
      code = await this.runLine(line, io, heredoc);
    }
    return code;
  }

  /** Expand an unquoted heredoc body like bash: $VAR and ${VAR}, with \\$, \\` and \\\\ escapes. */
  private expandHeredoc(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === "$" || next === "`" || next === "\\") {
          out += next;
          i++;
          continue;
        }
        if (next === "\n") {
          i++;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === "$") {
        const m = text.slice(i).match(/^\$\{(\w+)\}|^\$(\w+)/);
        if (m) {
          out += this.vars.get(m[1] ?? m[2]) ?? "";
          i += m[0].length - 1;
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  private expandVars(text: string): string {
    return text.replace(/\$\{(\w+|\?)\}|\$(\w+|\?)/g, (_, a, b) => this.vars.get(a ?? b) ?? "");
  }

  private tokenize(line: string): Token[] {
    const tokens: Token[] = [];
    let cur = "";
    let has = false;
    const push = () => {
      if (cur || has) tokens.push({ type: "word", value: cur });
      cur = "";
      has = false;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        cur += line.slice(i + 1, end < 0 ? undefined : end);
        has = true;
        i = end < 0 ? line.length : end;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let buf = "";
        while (j < line.length && line[j] !== '"') {
          if (line[j] === "\\" && j + 1 < line.length && ['"', "\\", "$"].includes(line[j + 1])) {
            buf += line[j + 1];
            j += 2;
            continue;
          }
          buf += line[j++];
        }
        cur += this.expandVars(buf);
        has = true;
        i = j;
        continue;
      }
      if (ch === "\\" && i + 1 < line.length) {
        cur += line[++i];
        continue;
      }
      if (ch === "$") {
        const m = line.slice(i).match(/^\$\{(\w+|\?)\}|^\$(\w+|\?)/);
        if (m) {
          const value = this.vars.get(m[1] ?? m[2]) ?? "";
          // Unquoted expansion splits on whitespace, like a real shell.
          const parts = value.split(/\s+/);
          parts.forEach((p, idx) => {
            if (idx > 0) push();
            cur += p;
            if (p) has = true;
          });
          i += m[0].length - 1;
          continue;
        }
      }
      if (/\s/.test(ch)) {
        push();
        continue;
      }
      const two = line.slice(i, i + 2);
      const four = line.slice(i, i + 4);
      if (four === "2>&1") {
        push();
        tokens.push({ type: "op", value: "2>&1" });
        i += 3;
        continue;
      }
      if (two === "&&" || two === "||" || two === ">>" || two === "2>") {
        push();
        tokens.push({ type: "op", value: two });
        i++;
        continue;
      }
      if (ch === "|" || ch === ";" || ch === ">" || ch === "<" || ch === "&") {
        push();
        tokens.push({ type: "op", value: ch });
        continue;
      }
      cur += ch;
    }
    push();
    return tokens;
  }

  /** Replace $(...) and `...` (outside single quotes) with the command's output. */
  private async substitute(line: string, io: IO): Promise<string> {
    let out = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        out += c;
        continue;
      }
      if (c === "'" && !quote) {
        quote = "'";
        out += c;
        continue;
      }
      if (c === '"') quote = quote === '"' ? null : '"';
      let inner: string | undefined;
      if (c === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < line.length; j++) {
          if (line[j] === "(") depth++;
          else if (line[j] === ")" && --depth === 0) break;
        }
        inner = line.slice(i + 2, j);
        i = j;
      } else if (c === "`") {
        const j = line.indexOf("`", i + 1);
        if (j > i) {
          inner = line.slice(i + 1, j);
          i = j;
        }
      }
      if (inner === undefined) {
        out += c;
        continue;
      }
      let captured = "";
      await this.exec(inner, { ...io, stdout: (t) => (captured += t) });
      captured = captured.replace(/\n+$/, "");
      out += quote ? captured : captured.replace(/\s+/g, " ");
    }
    return out;
  }

  /** Split a line on top-level ; && || (outside quotes and $(...)), keeping the operators. */
  private splitList(line: string): { text: string; op?: string }[] {
    const out: { text: string; op?: string }[] = [];
    let cur = "";
    let quote: string | null = null;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (c === "\\" && quote === '"') cur += c + (line[++i] ?? "");
        if (c !== "\\" || quote === "'") cur += c;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        cur += c;
        continue;
      }
      if (c === "\\") {
        cur += c + (line[++i] ?? "");
        continue;
      }
      if (c === "$" && line[i + 1] === "(") depth++;
      else if (c === ")" && depth > 0) depth--;
      if (depth === 0) {
        const two = line.slice(i, i + 2);
        if (two === "&&" || two === "||") {
          out.push({ text: cur, op: two });
          cur = "";
          i++;
          continue;
        }
        if (c === ";") {
          out.push({ text: cur, op: ";" });
          cur = "";
          continue;
        }
      }
      cur += c;
    }
    out.push({ text: cur });
    return out;
  }

  private async runLine(line: string, io: IO, heredoc?: string): Promise<number> {
    if (/\$\((?!\()|`/.test(line)) {
      // Substitute each command just before it runs, so earlier commands' effects are visible.
      const parts = this.splitList(line);
      if (parts.length > 1) {
        let code = 0;
        let prevOp: string | undefined;
        for (let k = 0; k < parts.length; k++) {
          if (k > 0 && ((prevOp === "&&" && code !== 0) || (prevOp === "||" && code === 0))) {
            prevOp = parts[k].op;
            continue;
          }
          if (parts[k].text.trim()) code = await this.runLine(parts[k].text, io, k === 0 ? heredoc : undefined);
          prevOp = parts[k].op;
        }
        return code;
      }
      line = await this.substitute(line, io);
    }
    const tokens = this.tokenize(line);
    // Split into command lists by ; && ||
    const lists: { tokens: Token[]; op?: string }[] = [];
    let current: Token[] = [];
    for (const t of tokens) {
      if (t.type === "op" && (t.value === ";" || t.value === "&&" || t.value === "||" || t.value === "&")) {
        lists.push({ tokens: current, op: t.value });
        current = [];
      } else current.push(t);
    }
    lists.push({ tokens: current });
    let code = 0;
    let prevOp: string | undefined;
    let first = true;
    for (const l of lists) {
      if (!first && prevOp === "&&" && code !== 0) {
        prevOp = l.op;
        continue;
      }
      if (!first && prevOp === "||" && code === 0) {
        prevOp = l.op;
        continue;
      }
      if (l.tokens.length) code = await this.runPipeline(l.tokens, io, first ? heredoc : undefined);
      this.vars.set("?", String(code));
      prevOp = l.op;
      first = false;
    }
    return code;
  }

  private async runPipeline(tokens: Token[], io: IO, heredoc?: string): Promise<number> {
    const stages: Token[][] = [[]];
    for (const t of tokens) {
      if (t.type === "op" && t.value === "|") stages.push([]);
      else stages[stages.length - 1].push(t);
    }
    let stdin: string | undefined = heredoc;
    let code = 0;
    for (let s = 0; s < stages.length; s++) {
      const last = s === stages.length - 1;
      const words: string[] = [];
      let outFile: { path: string; append: boolean } | undefined;
      let errMode: "terminal" | "stdout" | "null" = "terminal";
      let errFile: string | undefined;
      const st = stages[s];
      for (let i = 0; i < st.length; i++) {
        const t = st[i];
        if (t.type === "op") {
          const next = st[i + 1];
          if (t.value === ">" || t.value === ">>") {
            if (!next || next.type !== "word") {
              io.stderr("podsim: syntax error near unexpected token `newline'\n");
              return 2;
            }
            outFile = { path: next.value, append: t.value === ">>" };
            i++;
          } else if (t.value === "<") {
            if (next?.type === "word") {
              try {
                stdin = this.fs.readFile(next.value);
              } catch {
                io.stderr(`podsim: ${next.value}: No such file or directory\n`);
                return 1;
              }
              i++;
            }
          } else if (t.value === "2>&1") errMode = "stdout";
          else if (t.value === "2>") {
            if (next?.type === "word") {
              if (next.value === "/dev/null") errMode = "null";
              else errFile = next.value;
              i++;
            }
          }
        } else words.push(t.value);
      }
      if (words.length === 0) continue;

      let captured = "";
      const capture = !last || !!outFile;
      const stageIO: IO = {
        stdout: (text) => {
          if (capture) captured += text;
          else io.stdout(text);
        },
        stderr: (text) => {
          if (errMode === "stdout") stageIO.stdout(text);
          else if (errMode === "null") return;
          else if (errFile) this.fs.appendFile(errFile, text);
          else io.stderr(text);
        },
        stdin,
        sleep: io.sleep,
        aborted: io.aborted,
      };
      code = await this.runCommand(words, stageIO);
      if (outFile) {
        if (outFile.path === "/dev/null") {
          /* discard */
        } else if (outFile.append) this.fs.appendFile(outFile.path, captured);
        else this.fs.writeFile(outFile.path, captured);
        captured = "";
      }
      stdin = captured;
    }
    return code;
  }

  /** Text tools (sed, cut, printf, seq, find...) run on the work folder through the container runtime. */
  private runtimeTool(cmd: string, args: string[], io: IO): number {
    const r = execNow(hostMachine(this.cluster, this.fs, this.vars), [cmd, ...args], { stdin: io.stdin, vars: { PWD: "/" } });
    if (r.stdout) io.stdout(r.stdout);
    if (r.stderr) io.stderr(r.stderr);
    return r.code;
  }

  private async runCommand(words: string[], io: IO): Promise<number> {
    // Variable assignment: FOO=bar
    if (words.length === 1 && /^\w+=/.test(words[0])) {
      const idx = words[0].indexOf("=");
      this.vars.set(words[0].slice(0, idx), words[0].slice(idx + 1));
      return 0;
    }
    let [cmd, ...args] = words;
    const alias = this.aliases.get(cmd);
    if (alias) {
      const parts = alias.split(/\s+/);
      cmd = parts[0];
      args = [...parts.slice(1), ...args];
    }
    if (this.commands[cmd]) return this.commands[cmd](args, io);
    if (cmd === "cut" || ((cmd === "head" || cmd === "tail") && args.some((a) => /^-c/.test(a)))) return this.runtimeTool(cmd, args, io);
    const out = (t: string) => io.stdout(t);
    const lines = (t: string | undefined) => (t ?? "").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
    const emit = (ls: string[]) => {
      if (ls.length) out(ls.join("\n") + "\n");
    };

    switch (cmd) {
      case "kubectl":
        return this.kubectl.run(args, io, words.join(" "));
      case "export": {
        for (const a of args) {
          const idx = a.indexOf("=");
          if (idx > 0) this.vars.set(a.slice(0, idx), a.slice(idx + 1));
        }
        return 0;
      }
      case "alias": {
        if (args.length === 0) {
          emit([...this.aliases.entries()].map(([k, v]) => `alias ${k}='${v}'`));
          return 0;
        }
        for (const a of args) {
          const idx = a.indexOf("=");
          if (idx > 0) this.aliases.set(a.slice(0, idx), a.slice(idx + 1));
        }
        return 0;
      }
      case "unalias":
        for (const a of args) this.aliases.delete(a);
        return 0;
      case "echo": {
        let newline = true;
        let interpret = false;
        while (args[0] === "-n" || args[0] === "-e") {
          if (args[0] === "-n") newline = false;
          if (args[0] === "-e") interpret = true;
          args = args.slice(1);
        }
        let text = args.join(" ");
        if (interpret) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        out(text + (newline ? "\n" : ""));
        return 0;
      }
      case "cat": {
        if (args.length === 0) {
          out(io.stdin ?? "");
          return 0;
        }
        for (const f of args.filter((a) => !a.startsWith("-"))) {
          if (!this.fs.exists(f)) {
            io.stderr(`cat: ${f}: No such file or directory\n`);
            return 1;
          }
          if (this.fs.isDirectory(f)) {
            io.stderr(`cat: ${f}: Is a directory\n`);
            return 1;
          }
          const content = this.fs.readFile(f);
          out(content.endsWith("\n") || content === "" ? content : content + "\n");
        }
        return 0;
      }
      case "ls": {
        const paths = args.filter((a) => !a.startsWith("-"));
        const target = paths[0] ?? ".";
        if (!this.fs.exists(target)) {
          io.stderr(`ls: cannot access '${target}': No such file or directory\n`);
          return 2;
        }
        if (!this.fs.isDirectory(target)) {
          out(target + "\n");
          return 0;
        }
        emit(this.fs.list(target).filter((n) => n !== ".keep"));
        return 0;
      }
      case "pwd":
        out(this.fs.cwd() + "\n");
        return 0;
      case "cd":
        io.stderr(`(podsim) cd is not supported. Your files live in ${this.fs.cwd()}\n`);
        return 1;
      case "mkdir":
        for (const a of args.filter((x) => !x.startsWith("-"))) this.fs.mkdir(a);
        return 0;
      case "touch":
        for (const a of args) if (!this.fs.exists(a)) this.fs.writeFile(a, "");
        return 0;
      case "rm": {
        const force = args.some((a) => /^-\w*f/.test(a));
        for (const a of args.filter((x) => !x.startsWith("-"))) {
          if (!this.fs.exists(a)) {
            if (!force) {
              io.stderr(`rm: cannot remove '${a}': No such file or directory\n`);
              return 1;
            }
            continue;
          }
          this.fs.remove(a);
        }
        return 0;
      }
      case "cp":
      case "mv": {
        const [src, dst] = args.filter((a) => !a.startsWith("-"));
        if (!src || !dst) {
          io.stderr(`${cmd}: missing file operand\n`);
          return 1;
        }
        if (!this.fs.exists(src)) {
          io.stderr(`${cmd}: cannot stat '${src}': No such file or directory\n`);
          return 1;
        }
        this.fs.writeFile(dst, this.fs.readFile(src));
        if (cmd === "mv") this.fs.remove(src);
        return 0;
      }
      case "grep": {
        const flags = new Set<string>();
        const rest: string[] = [];
        let after = 0;
        let before = 0;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          const ctxFlag = a.match(/^-([ABC])(\d*)$/);
          if (ctxFlag) {
            const n = parseInt(ctxFlag[2] || args[++i] || "0", 10);
            if (ctxFlag[1] !== "B") after = n;
            if (ctxFlag[1] !== "A") before = n;
            continue;
          }
          if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
          else rest.push(a);
        }
        const pattern = rest[0] ?? "";
        const input = rest[1] ? (this.fs.exists(rest[1]) ? this.fs.readFile(rest[1]) : "") : io.stdin;
        let re: RegExp;
        try {
          const src = flags.has("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern.replace(/\\\|/g, "|");
          re = new RegExp(flags.has("w") ? `\\b(?:${src})\\b` : src, flags.has("i") ? "i" : "");
        } catch {
          re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags.has("i") ? "i" : "");
        }
        const all = lines(input);
        const hits = all.map((l) => re.test(l) !== flags.has("v"));
        const matched = all.filter((_, i) => hits[i]);
        if (flags.has("c")) out(`${matched.length}\n`);
        else if (after || before) {
          const keep = all.map((_, i) => hits.slice(Math.max(0, i - after), i + before + 1).some(Boolean));
          const outLines: string[] = [];
          all.forEach((l, i) => {
            if (!keep[i]) return;
            if (outLines.length && i > 0 && !keep[i - 1]) outLines.push("--");
            outLines.push(l);
          });
          emit(outLines);
        } else emit(matched);
        return matched.length ? 0 : 1;
      }
      case "head":
      case "tail": {
        let n = 10;
        let fromStart = false;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-n") {
            const v = args[++i] ?? "10";
            fromStart = v.startsWith("+");
            n = parseInt(v.replace("+", ""), 10);
          } else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10);
        }
        const ls = lines(io.stdin);
        if (cmd === "head") emit(ls.slice(0, n));
        else emit(fromStart ? ls.slice(n - 1) : ls.slice(-n));
        return 0;
      }
      case "wc": {
        const text = io.stdin ?? "";
        if (args.includes("-l")) out(`${lines(text).length}\n`);
        else if (args.includes("-w")) out(`${text.split(/\s+/).filter(Boolean).length}\n`);
        else if (args.includes("-c")) out(`${text.length}\n`);
        else out(`${lines(text).length} ${text.split(/\s+/).filter(Boolean).length} ${text.length}\n`);
        return 0;
      }
      case "sort": {
        let ls = lines(io.stdin);
        const kIdx = args.indexOf("-k");
        const key = kIdx >= 0 ? parseInt(args[kIdx + 1], 10) - 1 : -1;
        const val = (l: string) => (key >= 0 ? l.trim().split(/\s+/)[key] ?? "" : l);
        if (args.some((a) => a.includes("n"))) ls = ls.sort((a, b) => parseFloat(val(a)) - parseFloat(val(b)));
        else ls = ls.sort((a, b) => val(a).localeCompare(val(b)));
        if (args.some((a) => /^-\w*r/.test(a))) ls.reverse();
        emit(ls);
        return 0;
      }
      case "uniq": {
        const ls = lines(io.stdin);
        const res: { l: string; c: number }[] = [];
        for (const l of ls) {
          if (res.length && res[res.length - 1].l === l) res[res.length - 1].c++;
          else res.push({ l, c: 1 });
        }
        emit(args.includes("-c") ? res.map((r) => `${String(r.c).padStart(7)} ${r.l}`) : res.map((r) => r.l));
        return 0;
      }
      case "awk": {
        const prog = args.find((a) => a.includes("{")) ?? "";
        const m = prog.match(/^\s*(NR\s*([<>=!]=?|==)\s*(\d+))?\s*\{\s*print\s*(.*?)\s*\}\s*$/);
        if (!m) {
          io.stderr("(podsim) only simple awk programs like '{print $1}' are supported\n");
          return 1;
        }
        const fields = m[4] ? m[4].split(/\s*,\s*|\s+/) : ["$0"];
        const res: string[] = [];
        lines(io.stdin).forEach((l, idx) => {
          const nr = idx + 1;
          if (m[1]) {
            const v = parseInt(m[3], 10);
            const op = m[2];
            const ok = op === ">" ? nr > v : op === "<" ? nr < v : op === ">=" ? nr >= v : op === "<=" ? nr <= v : op === "!=" ? nr !== v : nr === v;
            if (!ok) return;
          }
          const cols = l.trim().split(/\s+/);
          res.push(
            fields
              .map((f) => {
                if (f === "$0") return l;
                if (f === "$NF") return cols[cols.length - 1] ?? "";
                const n = parseInt(f.replace("$", ""), 10);
                return f.startsWith("$") ? cols[n - 1] ?? "" : f.replace(/^"|"$/g, "");
              })
              .join(" "),
          );
        });
        emit(res);
        return 0;
      }
      case "cut": {
        let delim = "\t";
        let fieldsSpec = "";
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-d") delim = args[++i];
          else if (args[i].startsWith("-d")) delim = args[i].slice(2);
          else if (args[i] === "-f") fieldsSpec = args[++i];
          else if (args[i].startsWith("-f")) fieldsSpec = args[i].slice(2);
        }
        const idx = fieldsSpec.split(",").map((x) => parseInt(x, 10) - 1);
        emit(lines(io.stdin).map((l) => idx.map((i) => l.split(delim)[i] ?? "").join(delim)));
        return 0;
      }
      case "tr": {
        const text = io.stdin ?? "";
        const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        if (args[0] === "-d") {
          const set = unescape(args[1] ?? "");
          out([...text].filter((c) => !set.includes(c)).join(""));
        } else {
          const a = unescape(args[0] ?? "");
          const b = unescape(args[1] ?? "");
          out([...text].map((c) => (a.includes(c) ? b[Math.min(a.indexOf(c), b.length - 1)] ?? "" : c)).join(""));
        }
        return 0;
      }
      case "base64": {
        const text = io.stdin ?? (args.find((a) => !a.startsWith("-")) && this.fs.exists(args.find((a) => !a.startsWith("-"))!) ? this.fs.readFile(args.find((a) => !a.startsWith("-"))!) : "");
        if (args.includes("-d") || args.includes("--decode") || args.includes("-D")) out(fromBase64(text.replace(/\s+/g, "")));
        else out(toBase64(text) + (args.includes("-w0") || args.includes("-w") ? "" : "\n"));
        return 0;
      }
      case "tee": {
        const file = args.find((a) => !a.startsWith("-"));
        if (file) {
          if (args.includes("-a")) this.fs.appendFile(file, io.stdin ?? "");
          else this.fs.writeFile(file, io.stdin ?? "");
        }
        out(io.stdin ?? "");
        return 0;
      }
      case "xargs": {
        const items = (io.stdin ?? "").split(/\s+/).filter(Boolean);
        if (args.length === 0) {
          out(items.join(" ") + "\n");
          return 0;
        }
        return this.runCommand([...args, ...items], { ...io, stdin: undefined });
      }
      case "column":
        out(io.stdin ?? "");
        return 0;
      case "sleep": {
        const secs = Math.min(parseFloat(args[0] ?? "0") || 0, 60);
        await io.sleep(secs * 1000);
        return 0;
      }
      case "clear":
        out("\x1b[2J\x1b[H");
        return 0;
      case "which":
        if (args[0] === "kubectl") {
          out("/usr/bin/kubectl\n");
          return 0;
        }
        return 1;
      case "true":
        return 0;
      case "false":
        return 1;
      case "vi":
      case "vim":
      case "nano":
      case "code": {
        const file = args.find((a) => !a.startsWith("-"));
        if (file && this.opts.openEditor && (await this.opts.openEditor(file))) return 0;
        io.stderr(`(podsim) ${cmd} is not available inside the simulator. Edit the file with your own editor (it is in ${this.fs.cwd()}), or write it with a heredoc:\n  cat <<EOF > ${file ?? "pod.yaml"}\n  ...\n  EOF\n`);
        return 1;
      }
      case "watch":
        io.stderr("(podsim) watch is not simulated yet. Run the command again to refresh.\n");
        return 1;
      case "jq":
      case "yq":
      case "crictl":
      case "systemctl":
      case "journalctl":
      case "etcdctl":
      case "kubeadm":
      case "ssh":
        io.stderr(`(podsim) ${cmd} is not available on the simulator host yet. It is on the roadmap.\n`);
        return 127;
      case "helm":
        return helm(this.cluster, this.fs, this.kubectl.state.namespace, args, { stdout: out, stderr: (t) => io.stderr(t) });
      case "docker":
      case "podman":
        this.cluster.advance();
        return containerTool(this.cluster, this.fs, cmd, args, { stdout: out, stderr: (t) => io.stderr(t) });
      case "curl":
      case "wget": {
        this.cluster.advance();
        const r = hostNet(this.cluster, cmd, args);
        if (r.stdout) out(r.stdout);
        if (r.stderr) io.stderr(r.stderr);
        return r.code;
      }
      default: {
        if (NOOP_COMMANDS.has(cmd)) return 0;
        if (HOST_TOOLS.has(cmd) && hasBuiltin(cmd)) return this.runtimeTool(cmd, args, io);
        io.stderr(`podsim: ${cmd}: command not found\n`);
        return 127;
      }
    }
  }
}

const HOST_TOOLS = new Set(["cut", "sed", "printf", "seq", "find", "date", "env", "printenv", "id", "whoami", "basename", "dirname", "expr", "nl", "diff", "rev", "fold", "yes", "hostname", "uname", "test", "["]);

/** The simulator host as a runtime Host, with the work folder at /. */
function hostMachine(cluster: Cluster, fs: FileSystem, vars: Map<string, string>): Host {
  const rel = (p: string) => normalizePath(p).replace(/^\/+/, "");
  const hostFs: Fs = {
    read: (p) => {
      const r = rel(p);
      return r && fs.exists(r) && !fs.isDirectory(r) ? fs.readFile(r) : undefined;
    },
    isDir: (p) => rel(p) === "" || fs.isDirectory(rel(p)),
    list: (p) => (rel(p) === "" || fs.isDirectory(rel(p)) ? fs.list(rel(p)).filter((n) => n !== ".keep") : undefined),
    write: (p, data, append) => {
      if (append) fs.appendFile(rel(p), data);
      else fs.writeFile(rel(p), data);
      return undefined;
    },
    remove: (p) => {
      fs.remove(rel(p));
      return undefined;
    },
    mkdir: (p) => {
      fs.mkdir(rel(p));
      return undefined;
    },
  };
  return {
    now: () => cluster.now(),
    fs: hostFs,
    tools: null,
    env: { HOME: "/root", USER: "root", ...Object.fromEntries(vars) },
    hostname: "controlplane",
    podIP: "192.168.56.10",
    uid: 0,
    gid: 0,
    groups: [],
    caps: new Set(["CHOWN", "DAC_OVERRIDE", "NET_BIND_SERVICE", "SYS_ADMIN"]),
    image: "ubuntu",
    net: () => ({ stdout: "", stderr: "", code: 1 }),
  };
}

function heredocOf(line: string): { delim: string; strip: boolean; quoted: boolean } | undefined {
  // Ignore << inside quotes.
  let quote: string | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "<" && line[i + 1] === "<") {
      const m = line.slice(i).match(/^<<(-?)\s*(['"]?)(\w+)\2/);
      if (m) return { delim: m[3], strip: m[1] === "-", quoted: !!m[2] };
    }
  }
  return undefined;
}

function unbalancedQuotes(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
  }
  return quote !== null;
}

export type { Word };
