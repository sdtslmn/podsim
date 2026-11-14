// A small POSIX-ish shell parser for the scripts people put in container
// command/args and run with kubectl exec. It understands lists, && and ||,
// pipes, redirects, background jobs, while/until/for/if/case, groups,
// variable assignments, quotes, $VAR, ${VAR}, $(...), `...` and $((...)).

export interface Part {
  /** 0 = unquoted, 1 = single quoted, 2 = double quoted */
  q: 0 | 1 | 2;
  s: string;
}
export type Word = Part[];

export interface Redir {
  op: ">" | ">>" | "<" | "2>" | "2>>" | "&>" | "2>&1" | ">&2" | "<<";
  target?: Word;
  heredoc?: string;
}

export type Node =
  | { type: "cmd"; words: Word[]; redirs: Redir[]; assigns: [string, Word][] }
  | { type: "pipe"; cmds: Node[]; negate?: boolean }
  | { type: "and" | "or"; left: Node; right: Node }
  | { type: "list"; items: Node[] }
  | { type: "loop"; until: boolean; cond: Node; body: Node; redirs: Redir[] }
  | { type: "for"; name: string; words: Word[] | null; body: Node }
  | { type: "if"; branches: { cond: Node; body: Node }[]; otherwise?: Node }
  | { type: "case"; word: Word; arms: { patterns: Word[]; body: Node }[] }
  | { type: "group"; body: Node; subshell: boolean; redirs: Redir[] }
  | { type: "bg"; node: Node }
  | { type: "func"; name: string; body: Node };

type Tok = { t: "w"; w: Word; raw: string } | { t: "op"; v: string };

export class ParseError extends Error {}

const OPS = ["&&", "||", ";;", ">>", "2>&1", ">&2", "1>&2", "2>>", "2>", "&>", "<<", "|", "&", ";", "(", ")", ">", "<", "\n"];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const heredocs: { delim: string; redirIndex: number }[] = [];
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(src[i - 1]))) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" && heredocs.length) {
      // Read heredoc bodies after the newline.
      i++;
      for (const h of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < n) {
          let end = src.indexOf("\n", i);
          if (end < 0) end = n;
          const line = src.slice(i, end);
          i = end + 1;
          if (line.trim() === h.delim) break;
          lines.push(line);
        }
        const tok = toks[h.redirIndex] as { t: "op"; v: string; body?: string };
        tok.body = lines.join("\n") + "\n";
      }
      toks.push({ t: "op", v: "\n" });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op && !(op === "2>" || op === "2>>" || op === "2>&1") || (op && (i === 0 || /[\s;&|()]/.test(src[i - 1])))) {
      if (op === "<<") {
        i += 2;
        while (src[i] === " " || src[i] === "-") i++;
        let delim = "";
        while (i < n && !/\s/.test(src[i])) delim += src[i++];
        delim = delim.replace(/^['"]|['"]$/g, "");
        toks.push({ t: "op", v: "<<" });
        heredocs.push({ delim, redirIndex: toks.length - 1 });
        continue;
      }
      toks.push({ t: "op", v: op === "1>&2" ? ">&2" : op });
      i += op.length;
      continue;
    }
    // A word.
    const word: Word = [];
    let raw = "";
    let cur = "";
    const flush = () => {
      if (cur) word.push({ q: 0, s: cur });
      cur = "";
    };
    while (i < n) {
      const c = src[i];
      if (/[\s;&|()<>]/.test(c)) {
        if ((c === "<" || c === ">") && cur === "" && word.length === 0) break;
        if (c === ">" && /^\d$/.test(cur) === false) break;
        if (c === "<" || c === ">") break;
        break;
      }
      if (c === "'") {
        flush();
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ParseError("unterminated quoted string");
        word.push({ q: 1, s: src.slice(i + 1, end) });
        raw += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        flush();
        let j = i + 1;
        let s = "";
        while (j < n && src[j] !== '"') {
          if (src[j] === "\\" && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
            if (src[j + 1] !== "\n") s += src[j + 1] === "$" || src[j + 1] === "`" ? "\\" + src[j + 1] : src[j + 1];
            j += 2;
            continue;
          }
          if (src[j] === "$" && src[j + 1] === "(") {
            const end = matchParen(src, j + 1);
            s += src.slice(j, end + 1);
            j = end + 1;
            continue;
          }
          s += src[j++];
        }
        if (j >= n) throw new ParseError("unterminated quoted string");
        word.push({ q: 2, s });
        raw += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        flush();
        word.push({ q: 1, s: src[i + 1] });
        raw += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "(") {
        const end = matchParen(src, i + 1);
        cur += src.slice(i, end + 1);
        raw += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        const end = src.indexOf("}", i);
        if (end < 0) throw new ParseError("bad substitution");
        cur += src.slice(i, end + 1);
        raw += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === "`") {
        const end = src.indexOf("`", i + 1);
        if (end < 0) throw new ParseError("unterminated backquote");
        cur += "$(" + src.slice(i + 1, end) + ")";
        raw += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      cur += c;
      raw += c;
      i++;
    }
    flush();
    if (word.length) toks.push({ t: "w", w: word, raw });
  }
  return toks;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "'") {
      j = src.indexOf("'", j + 1);
      if (j < 0) break;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new ParseError("unexpected end of file (expecting \")\")");
}

const KEYWORDS = new Set(["do", "done", "then", "elif", "else", "fi", "esac", "}", "in"]);

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isWord(v: string, tok = this.peek()): boolean {
    return !!tok && tok.t === "w" && tok.raw === v;
  }
  isOp(v: string, tok = this.peek()): boolean {
    return !!tok && tok.t === "op" && tok.v === v;
  }
  skipNewlines(): void {
    while (this.isOp("\n") || this.isOp(";")) this.i++;
  }
  expectWord(v: string): void {
    this.skipNewlines();
    if (!this.isWord(v)) {
      const t = this.peek();
      throw new ParseError(`syntax error: unexpected ${t ? (t.t === "w" ? `"${t.raw}"` : t.v === "\n" ? "newline" : `"${t.v}"`) : "end of file"} (expecting "${v}")`);
    }
    this.i++;
  }

  parseList(stop: string[] = []): Node {
    const items: Node[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (!t) break;
      if (t.t === "w" && stop.includes(t.raw)) break;
      if (t.t === "op" && (t.v === ")" || t.v === ";;") && (stop.includes(t.v) || stop.length)) break;
      let node = this.parseAndOr(stop);
      if (this.isOp("&")) {
        this.i++;
        node = { type: "bg", node };
      }
      items.push(node);
      if (this.isOp(";") || this.isOp("\n")) {
        this.i++;
        continue;
      }
      if (node.type === "bg") continue;
      break;
    }
    return items.length === 1 ? items[0] : { type: "list", items };
  }

  parseAndOr(stop: string[]): Node {
    let left = this.parsePipeline(stop);
    for (;;) {
      if (this.isOp("&&") || this.isOp("||")) {
        const op = (this.peek() as { v: string }).v;
        this.i++;
        this.skipNewlinesOnly();
        const right = this.parsePipeline(stop);
        left = { type: op === "&&" ? "and" : "or", left, right };
        continue;
      }
      return left;
    }
  }

  skipNewlinesOnly(): void {
    while (this.isOp("\n")) this.i++;
  }

  parsePipeline(stop: string[]): Node {
    let negate = false;
    if (this.isWord("!")) {
      negate = true;
      this.i++;
    }
    const cmds = [this.parseCommand(stop)];
    while (this.isOp("|")) {
      this.i++;
      this.skipNewlinesOnly();
      cmds.push(this.parseCommand(stop));
    }
    if (cmds.length === 1 && !negate) return cmds[0];
    return { type: "pipe", cmds, negate };
  }

  parseRedirs(): Redir[] {
    const redirs: Redir[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.t !== "op") break;
      if (t.v === "2>&1" || t.v === ">&2") {
        redirs.push({ op: t.v });
        this.i++;
        continue;
      }
      if ([">", ">>", "<", "2>", "2>>", "&>"].includes(t.v)) {
        this.i++;
        const target = this.peek();
        if (target?.t !== "w") throw new ParseError("syntax error: unexpected redirection");
        this.i++;
        redirs.push({ op: t.v as Redir["op"], target: target.w });
        continue;
      }
      if (t.v === "<<") {
        this.i++;
        redirs.push({ op: "<<", heredoc: (t as unknown as { body?: string }).body ?? "" });
        continue;
      }
      break;
    }
    return redirs;
  }

  parseCommand(stop: string[]): Node {
    const t = this.peek();
    if (!t) throw new ParseError("syntax error: unexpected end of file");
    if (t.t === "op" && t.v === "(") {
      this.i++;
      const body = this.parseList([")"]);
      if (!this.isOp(")")) throw new ParseError('syntax error: unexpected end of file (expecting ")")');
      this.i++;
      return { type: "group", body, subshell: true, redirs: this.parseRedirs() };
    }
    if (t.t === "w") {
      switch (t.raw) {
        case "{": {
          this.i++;
          const body = this.parseList(["}"]);
          this.expectWord("}");
          return { type: "group", body, subshell: false, redirs: this.parseRedirs() };
        }
        case "while":
        case "until": {
          this.i++;
          const cond = this.parseList(["do"]);
          this.expectWord("do");
          const body = this.parseList(["done"]);
          this.expectWord("done");
          return { type: "loop", until: t.raw === "until", cond, body, redirs: this.parseRedirs() };
        }
        case "for": {
          this.i++;
          const nameTok = this.peek();
          if (nameTok?.t !== "w") throw new ParseError("syntax error: bad for loop variable");
          this.i++;
          let words: Word[] | null = null;
          this.skipNewlinesOnly();
          if (this.isWord("in")) {
            this.i++;
            words = [];
            while (this.peek()?.t === "w" && !this.isWord("do")) {
              words.push((this.peek() as { w: Word }).w);
              this.i++;
            }
          }
          this.expectWord("do");
          const body = this.parseList(["done"]);
          this.expectWord("done");
          return { type: "for", name: nameTok.raw, words, body };
        }
        case "if": {
          this.i++;
          const branches: { cond: Node; body: Node }[] = [];
          let otherwise: Node | undefined;
          const cond = this.parseList(["then"]);
          this.expectWord("then");
          branches.push({ cond, body: this.parseList(["elif", "else", "fi"]) });
          for (;;) {
            this.skipNewlines();
            if (this.isWord("elif")) {
              this.i++;
              const c = this.parseList(["then"]);
              this.expectWord("then");
              branches.push({ cond: c, body: this.parseList(["elif", "else", "fi"]) });
              continue;
            }
            if (this.isWord("else")) {
              this.i++;
              otherwise = this.parseList(["fi"]);
            }
            break;
          }
          this.expectWord("fi");
          return { type: "if", branches, otherwise };
        }
        case "case": {
          this.i++;
          const w = this.peek();
          if (w?.t !== "w") throw new ParseError("syntax error: bad case");
          this.i++;
          this.expectWord("in");
          const arms: { patterns: Word[]; body: Node }[] = [];
          for (;;) {
            this.skipNewlines();
            if (this.isWord("esac")) {
              this.i++;
              break;
            }
            if (this.isOp("(")) this.i++;
            const patterns: Word[] = [];
            while (this.peek()?.t === "w") {
              patterns.push((this.peek() as { w: Word }).w);
              this.i++;
              if (this.isOp("|")) this.i++;
              else break;
            }
            if (!this.isOp(")")) throw new ParseError("syntax error: expecting )");
            this.i++;
            const body = this.parseList(["esac", ";;"]);
            if (this.isOp(";;")) this.i++;
            arms.push({ patterns, body });
          }
          return { type: "case", word: w.w, arms };
        }
      }
      if (KEYWORDS.has(t.raw) && stop.includes(t.raw)) throw new ParseError(`syntax error: unexpected "${t.raw}"`);
      // name() { ... }
      const next = this.toks[this.i + 1];
      const after = this.toks[this.i + 2];
      if (next && after && this.isOp("(", next) && this.isOp(")", after) && /^[A-Za-z_][\w-]*$/.test(t.raw)) {
        this.i += 3;
        this.skipNewlinesOnly();
        const body = this.parseCommand(stop);
        return { type: "func", name: t.raw, body };
      }
    }
    return this.parseSimple();
  }

  parseSimple(): Node {
    const words: Word[] = [];
    const redirs: Redir[] = [];
    const assigns: [string, Word][] = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === "op") {
        const r = this.parseRedirs();
        if (r.length === 0) break;
        redirs.push(...r);
        continue;
      }
      if (words.length === 0 && t.w[0]?.q === 0 && /^[A-Za-z_]\w*=/.test(t.w[0].s)) {
        const first = t.w[0].s;
        const eq = first.indexOf("=");
        const name = first.slice(0, eq);
        const rest: Word = ([{ q: 0, s: first.slice(eq + 1) }, ...t.w.slice(1)] as Word).filter((p) => p.s !== "" || p.q !== 0);
        assigns.push([name, rest]);
        this.i++;
        continue;
      }
      words.push(t.w);
      this.i++;
    }
    if (words.length === 0 && redirs.length === 0 && assigns.length === 0) {
      const t = this.peek();
      throw new ParseError(`syntax error: unexpected ${t ? (t.t === "w" ? `"${t.raw}"` : t.v === "\n" ? "newline" : `"${t.v}"`) : "end of file"}`);
    }
    return { type: "cmd", words, redirs, assigns };
  }
}

/** Parse a script into a tree. Throws ParseError on syntax errors. */
export function parseScript(src: string): Node {
  const toks = tokenize(src);
  const p = new Parser(toks);
  const node = p.parseList();
  p.skipNewlines();
  const rest = p.peek();
  if (rest) throw new ParseError(`syntax error: unexpected ${rest.t === "w" ? `"${rest.raw}"` : `"${rest.v}"`}`);
  return node;
}

/** Turn an argv array into a script line, quoting as needed. */
export function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
