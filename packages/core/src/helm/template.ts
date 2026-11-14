// A small Go text/template engine with the Sprig functions charts use most:
// {{ .Values.x }}, pipelines, if/else, range, with, define/include,
// variables, whitespace trimming, default, quote, toYaml, nindent and more.

import { stringify } from "yaml";

type Node =
  | { t: "text"; s: string }
  | { t: "out"; expr: string }
  | { t: "if"; branches: { cond: string; body: Node[] }[]; otherwise?: Node[] }
  | { t: "range"; expr: string; vars: string[]; body: Node[]; otherwise?: Node[] }
  | { t: "with"; expr: string; body: Node[]; otherwise?: Node[] }
  | { t: "define"; name: string; body: Node[] }
  | { t: "assign"; name: string; expr: string; declare: boolean };

export class TemplateError extends Error {}

function lex(src: string): { kind: "text" | "action"; s: string }[] {
  const out: { kind: "text" | "action"; s: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) {
      out.push({ kind: "text", s: src.slice(i) });
      break;
    }
    let text = src.slice(i, open);
    let start = open + 2;
    if (src[start] === "-" && /\s/.test(src[start + 1] ?? "")) {
      text = text.replace(/\s+$/, "");
      start++;
    }
    out.push({ kind: "text", s: text });
    let close = src.indexOf("}}", start);
    // Skip "}}" inside quoted strings.
    let q: string | null = null;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (q) {
        if (c === "\\") j++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "`") q = c;
      else if (c === "}" && src[j + 1] === "}") {
        close = j;
        break;
      }
    }
    if (close < 0) throw new TemplateError("unclosed action");
    let body = src.slice(start, close);
    let next = close + 2;
    if (/\s-$/.test(body)) {
      body = body.slice(0, -1);
      while (next < src.length && /\s/.test(src[next])) next++;
    }
    out.push({ kind: "action", s: body.trim() });
    i = next;
  }
  return out;
}

function parse(src: string): Node[] {
  const toks = lex(src);
  let pos = 0;
  const block = (stops: string[]): { nodes: Node[]; stop: string } => {
    const nodes: Node[] = [];
    while (pos < toks.length) {
      const t = toks[pos++];
      if (t.kind === "text") {
        if (t.s) nodes.push({ t: "text", s: t.s });
        continue;
      }
      const a = t.s;
      if (a.startsWith("/*")) continue;
      const word = a.split(/\s+/)[0];
      if (stops.includes(word) || (word === "else" && stops.includes("else"))) return { nodes, stop: a };
      if (word === "if") {
        const branches: { cond: string; body: Node[] }[] = [];
        let cond = a.slice(2).trim();
        let otherwise: Node[] | undefined;
        for (;;) {
          const r = block(["else", "end"]);
          branches.push({ cond, body: r.nodes });
          if (r.stop.startsWith("else if")) {
            cond = r.stop.slice(7).trim();
            continue;
          }
          if (r.stop === "else") otherwise = block(["end"]).nodes;
          break;
        }
        nodes.push({ t: "if", branches, otherwise });
      } else if (word === "range") {
        let expr = a.slice(5).trim();
        let vars: string[] = [];
        const m = expr.match(/^(\$\w+)(?:\s*,\s*(\$\w+))?\s*:=\s*(.+)$/);
        if (m) {
          vars = m[2] ? [m[1], m[2]] : [m[1]];
          expr = m[3];
        }
        const r = block(["else", "end"]);
        nodes.push({ t: "range", expr, vars, body: r.nodes, otherwise: r.stop === "else" ? block(["end"]).nodes : undefined });
      } else if (word === "with") {
        const r = block(["else", "end"]);
        nodes.push({ t: "with", expr: a.slice(4).trim(), body: r.nodes, otherwise: r.stop === "else" ? block(["end"]).nodes : undefined });
      } else if (word === "define") {
        const name = a.slice(6).trim().replace(/^"|"$/g, "");
        nodes.push({ t: "define", name, body: block(["end"]).nodes });
      } else if (/^\$\w+\s*:?=/.test(a)) {
        const m = a.match(/^(\$\w+)\s*(:?=)\s*(.+)$/)!;
        nodes.push({ t: "assign", name: m[1], expr: m[3], declare: m[2] === ":=" });
      } else nodes.push({ t: "out", expr: a });
    }
    return { nodes, stop: "" };
  };
  return block([]).nodes;
}

// ------------------------------------------------------------------ evaluation

export interface Ctx {
  dot: unknown;
  root: unknown;
  vars: Record<string, unknown>;
  defines: Map<string, Node[]>;
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function field(v: unknown, path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function tokenizeExpr(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" && c === '"' ? 2 : 1;
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "|") {
      out.push(c);
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s()|]/.test(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function toYaml(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return Array.isArray(v) ? "[]" : "{}";
  return stringify(v, { lineWidth: 0 }).replace(/\n$/, "");
}

function indent(n: number, s: string): string {
  const pad = " ".repeat(n);
  return String(s).split("\n").map((l) => pad + l).join("\n");
}

const FUNCS: Record<string, (ctx: Ctx, ...a: unknown[]) => unknown> = {
  default: (c, d, v) => (truthy(v) ? v : d),
  quote: (c, ...v) => v.map((x) => JSON.stringify(x === undefined || x === null ? "" : String(x))).join(" "),
  squote: (c, ...v) => v.map((x) => `'${x ?? ""}'`).join(" "),
  upper: (c, v) => String(v ?? "").toUpperCase(),
  lower: (c, v) => String(v ?? "").toLowerCase(),
  title: (c, v) => String(v ?? "").replace(/\b\w/g, (m) => m.toUpperCase()),
  trim: (c, v) => String(v ?? "").trim(),
  toYaml: (c, v) => toYaml(v),
  toJson: (c, v) => JSON.stringify(v ?? null),
  toString: (c: Ctx, v: unknown) => String(v ?? ""),
  int: (c, v) => parseInt(String(v), 10) || 0,
  nindent: (c, n, v) => "\n" + indent(Number(n), String(v ?? "")),
  indent: (c, n, v) => indent(Number(n), String(v ?? "")),
  trunc: (c, n, v) => String(v ?? "").slice(0, Number(n)),
  trimSuffix: (c, suf, v) => (String(v).endsWith(String(suf)) ? String(v).slice(0, -String(suf).length) : String(v)),
  trimPrefix: (c, pre, v) => (String(v).startsWith(String(pre)) ? String(v).slice(String(pre).length) : String(v)),
  replace: (c, a, b, v) => String(v ?? "").split(String(a)).join(String(b)),
  contains: (c, sub, v) => String(v ?? "").includes(String(sub)),
  hasPrefix: (c, pre, v) => String(v ?? "").startsWith(String(pre)),
  hasSuffix: (c, suf, v) => String(v ?? "").endsWith(String(suf)),
  printf: (c, fmt, ...args) => {
    let i = 0;
    return String(fmt).replace(/%[-0-9.]*[sdvqf%]/g, (m) => (m === "%%" ? "%" : m.endsWith("q") ? JSON.stringify(String(args[i++] ?? "")) : String(args[i++] ?? "")));
  },
  eq: (c, a, ...b) => b.some((x) => x === a || String(x) === String(a)),
  ne: (c, a, b) => a !== b && String(a) !== String(b),
  lt: (c, a, b) => Number(a) < Number(b),
  le: (c, a, b) => Number(a) <= Number(b),
  gt: (c, a, b) => Number(a) > Number(b),
  ge: (c, a, b) => Number(a) >= Number(b),
  and: (c, ...a) => a.reduce((x, y) => (truthy(x) ? y : x)),
  or: (c, ...a) => a.find(truthy) ?? a[a.length - 1],
  not: (c, a) => !truthy(a),
  empty: (c, a) => !truthy(a),
  len: (c, a) => (Array.isArray(a) || typeof a === "string" ? a.length : a && typeof a === "object" ? Object.keys(a).length : 0),
  hasKey: (c, m, k) => !!m && typeof m === "object" && String(k) in (m as object),
  list: (c, ...a) => a,
  dict: (c, ...a) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i + 1 < a.length; i += 2) o[String(a[i])] = a[i + 1];
    return o;
  },
  b64enc: (c, v) => btoa(String(v ?? "")),
  b64dec: (c, v) => atob(String(v ?? "")),
  required: (c, msg, v) => {
    if (!truthy(v) && v !== false && v !== 0) throw new TemplateError(String(msg));
    return v;
  },
  fail: (c, msg) => {
    throw new TemplateError(String(msg));
  },
  include: (c, name, dot) => render(c.defines.get(String(name)) ?? [], { ...c, dot, vars: { $: c.root } }),
  template: (c, name, dot) => render(c.defines.get(String(name)) ?? [], { ...c, dot, vars: { $: c.root } }),
  tpl: (c, text, dot) => renderString(String(text), dot, c.defines),
  semverCompare: () => true,
  randAlphaNum: (c, n) => "x7k2m9q4p1w8z3n6v5b0".slice(0, Number(n)),
  sha256sum: (c, v) => {
    let h = 2166136261;
    for (const ch of String(v ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h.toString(16).padStart(8, "0").repeat(8);
  },
  lookup: () => ({}),
  kindIs: (c, k, v) => (k === "map" ? !!v && typeof v === "object" && !Array.isArray(v) : k === "slice" ? Array.isArray(v) : k === "string" ? typeof v === "string" : false),
  ternary: (c, a, b, cond) => (truthy(cond) ? a : b),
  coalesce: (c, ...a) => a.find(truthy),
  splitList: (c, sep, v) => String(v ?? "").split(String(sep)),
  join: (c, sep, v) => (Array.isArray(v) ? v.join(String(sep)) : String(v ?? "")),
};

function evalTokens(tokens: string[], ctx: Ctx, piped?: { value: unknown }): unknown {
  // Group parenthesised sub-expressions into values.
  const values: unknown[] = [];
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "(") {
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j] === "(") depth++;
        else if (tokens[j] === ")" && --depth === 0) break;
      }
      values.push({ sub: evalPipeline(tokens.slice(i + 1, j), ctx) });
      words.push("\u0000sub" + (values.length - 1));
      i = j;
      continue;
    }
    words.push(t);
  }
  const value = (w: string): unknown => {
    if (w.startsWith("\u0000sub")) return (values[parseInt(w.slice(4), 10)] as { sub: unknown }).sub;
    if (w.startsWith('"')) return JSON.parse(w);
    if (w.startsWith("`")) return w.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(w)) return Number(w);
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "nil") return null;
    if (w === ".") return ctx.dot;
    if (w.startsWith("$")) {
      const [v, ...path] = w.split(".");
      return field(v === "$" ? ctx.root : ctx.vars[v], path);
    }
    if (w.startsWith(".")) return field(ctx.dot, w.slice(1).split("."));
    if (w.startsWith("\u0000")) return undefined;
    throw new TemplateError(`function "${w}" not defined`);
  };
  const [head, ...rest] = words;
  if (head !== undefined && FUNCS[head]) {
    const args = rest.map(value);
    if (piped) args.push(piped.value);
    return FUNCS[head](ctx, ...args);
  }
  if (words.length === 1 && !piped) return value(head);
  if (piped && words.length === 0) return piped.value;
  throw new TemplateError(`can't evaluate "${tokens.join(" ")}"`);
}

function evalPipeline(tokens: string[], ctx: Ctx): unknown {
  const stages: string[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t === "(") depth++;
    if (t === ")") depth--;
    if (t === "|" && depth === 0) stages.push([]);
    else stages[stages.length - 1].push(t);
  }
  let v: { value: unknown } | undefined;
  for (const st of stages) v = { value: evalTokens(st, ctx, v) };
  return v?.value;
}

function evalExpr(expr: string, ctx: Ctx): unknown {
  return evalPipeline(tokenizeExpr(expr), ctx);
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.join(" ")}]` : `map[${Object.entries(v as object).map(([k, x]) => `${k}:${x}`).join(" ")}]`;
  return String(v);
}

export function render(nodes: Node[], ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        out += n.s;
        break;
      case "out":
        out += str(evalExpr(n.expr, ctx));
        break;
      case "assign":
        ctx.vars[n.name] = evalExpr(n.expr, ctx);
        break;
      case "define":
        break;
      case "if": {
        const b = n.branches.find((x) => truthy(evalExpr(x.cond, ctx)));
        if (b) out += render(b.body, ctx);
        else if (n.otherwise) out += render(n.otherwise, ctx);
        break;
      }
      case "with": {
        const v = evalExpr(n.expr, ctx);
        if (truthy(v)) out += render(n.body, { ...ctx, dot: v });
        else if (n.otherwise) out += render(n.otherwise, ctx);
        break;
      }
      case "range": {
        const v = evalExpr(n.expr, ctx);
        const entries: [unknown, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === "object" ? Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)) : typeof v === "number" ? Array.from({ length: v }, (_, i) => [i, i]) : [];
        if (!entries.length && n.otherwise) out += render(n.otherwise, ctx);
        for (const [k, x] of entries) {
          const vars = { ...ctx.vars };
          if (n.vars.length === 1) vars[n.vars[0]] = x;
          if (n.vars.length === 2) {
            vars[n.vars[0]] = k;
            vars[n.vars[1]] = x;
          }
          out += render(n.body, { ...ctx, dot: x, vars });
        }
        break;
      }
    }
  }
  return out;
}

/** Collect {{ define }} blocks from a set of templates (usually _helpers.tpl). */
export function collectDefines(sources: string[]): Map<string, Node[]> {
  const defines = new Map<string, Node[]>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) if (n.t === "define") defines.set(n.name, n.body);
  };
  for (const s of sources) walk(parse(s));
  return defines;
}

export function renderString(src: string, root: unknown, defines: Map<string, Node[]>): string {
  return render(parse(src), { dot: root, root, vars: { $: root }, defines });
}
