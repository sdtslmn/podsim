// A subset of kubectl's JSONPath: fields, [*], [n], slices, filters,
// range/end blocks and string literals. Enough for the forms used in
// the CKA/CKAD curriculum and the Kubernetes docs.

import { KubeError } from "../types.js";

type Step =
  | { type: "field"; name: string }
  | { type: "wildcard" }
  | { type: "index"; index: number }
  | { type: "slice"; start?: number; end?: number }
  | { type: "filter"; path: Step[]; op?: string; value?: string | number | boolean }
  | { type: "recursive"; name: string };

function parsePath(expr: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  const s = expr.trim().replace(/^@/, "").replace(/^\$/, "");
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      if (s[i + 1] === ".") {
        i += 2;
        const m = s.slice(i).match(/^[\w-]+/);
        steps.push({ type: "recursive", name: m ? m[0] : "" });
        i += m ? m[0].length : 0;
        continue;
      }
      i++;
      if (s[i] === "*") {
        steps.push({ type: "wildcard" });
        i++;
        continue;
      }
      const m = s.slice(i).match(/^[^.[\]]+/);
      if (m) {
        steps.push({ type: "field", name: m[0] });
        i += m[0].length;
      }
      continue;
    }
    if (ch === "[") {
      const close = findClose(s, i);
      const inner = s.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === "*") steps.push({ type: "wildcard" });
      else if (/^-?\d+$/.test(inner)) steps.push({ type: "index", index: parseInt(inner, 10) });
      else if (/^-?\d*:-?\d*$/.test(inner)) {
        const [a, b] = inner.split(":");
        steps.push({ type: "slice", start: a ? parseInt(a, 10) : undefined, end: b ? parseInt(b, 10) : undefined });
      } else if (/^['"].*['"]$/.test(inner)) steps.push({ type: "field", name: inner.slice(1, -1) });
      else if (inner.startsWith("?(")) {
        const body = inner.slice(2, -1).trim();
        const m = body.match(/^(@[\w.\-[\]'"]*)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
        if (m) {
          let raw = m[3].trim();
          let value: string | number | boolean;
          if (/^['"].*['"]$/.test(raw)) value = raw.slice(1, -1);
          else if (raw === "true" || raw === "false") value = raw === "true";
          else value = Number(raw);
          raw = "";
          steps.push({ type: "filter", path: parsePath(m[1]), op: m[2], value });
        } else {
          steps.push({ type: "filter", path: parsePath(body) });
        }
      } else {
        throw new KubeError(`error: error parsing jsonpath ${expr}, unrecognized character in action: U+005B '['`);
      }
      continue;
    }
    // Bare field at the start, e.g. "metadata.name".
    const m = s.slice(i).match(/^[^.[\]]+/);
    if (m) {
      steps.push({ type: "field", name: m[0] });
      i += m[0].length;
      continue;
    }
    i++;
  }
  return steps;
}

function findClose(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") {
      depth--;
      if (depth === 0 && c === "]") return i;
    }
  }
  throw new KubeError(`error: error parsing jsonpath, unclosed [`);
}

function applyStep(values: unknown[], step: Step): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    switch (step.type) {
      case "field":
        if (typeof v === "object" && !Array.isArray(v) && step.name in (v as object)) out.push((v as Record<string, unknown>)[step.name]);
        break;
      case "wildcard":
        if (Array.isArray(v)) out.push(...v);
        else if (typeof v === "object") out.push(...Object.values(v as object));
        break;
      case "index":
        if (Array.isArray(v)) {
          const idx = step.index < 0 ? v.length + step.index : step.index;
          if (idx >= 0 && idx < v.length) out.push(v[idx]);
          else throw new KubeError(`error: error executing jsonpath: array index out of bounds: index ${step.index}, length ${v.length}`);
        }
        break;
      case "slice":
        if (Array.isArray(v)) out.push(...v.slice(step.start ?? 0, step.end ?? v.length));
        break;
      case "filter": {
        const items = Array.isArray(v) ? v : [v];
        for (const item of items) {
          const got = evalSteps([item], step.path);
          if (step.op === undefined) {
            if (got.length > 0 && got[0] !== false && got[0] !== null) out.push(item);
            continue;
          }
          const left = got[0];
          const right = step.value;
          let ok = false;
          switch (step.op) {
            case "==":
              ok = left == right; // eslint-disable-line eqeqeq
              break;
            case "!=":
              ok = left != right; // eslint-disable-line eqeqeq
              break;
            case "<":
              ok = Number(left) < Number(right);
              break;
            case ">":
              ok = Number(left) > Number(right);
              break;
            case "<=":
              ok = Number(left) <= Number(right);
              break;
            case ">=":
              ok = Number(left) >= Number(right);
              break;
          }
          if (ok) out.push(item);
        }
        break;
      }
      case "recursive": {
        const walk = (x: unknown) => {
          if (x && typeof x === "object") {
            if (!Array.isArray(x) && step.name in (x as object)) out.push((x as Record<string, unknown>)[step.name]);
            for (const child of Object.values(x as object)) walk(child);
          }
        };
        walk(v);
        break;
      }
    }
  }
  return out;
}

function evalSteps(root: unknown[], steps: Step[]): unknown[] {
  return steps.reduce((vals, st) => applyStep(vals, st), root);
}

export function evalPath(obj: unknown, expr: string): unknown[] {
  return evalSteps([obj], parsePath(expr));
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Node = { kind: "text"; text: string } | { kind: "expr"; expr: string } | { kind: "range"; expr: string; body: Node[] };

function tokenize(template: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  const ranges: { expr: string; body: Node[] }[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      stack[stack.length - 1].push({ kind: "text", text: template.slice(i) });
      break;
    }
    if (open > i) stack[stack.length - 1].push({ kind: "text", text: template.slice(i, open) });
    let depth = 0;
    let close = -1;
    let quote: string | null = null;
    for (let j = open; j < template.length; j++) {
      const c = template[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) throw new KubeError(`error: error parsing jsonpath ${template}, unclosed action`);
    const action = template.slice(open + 1, close).trim();
    i = close + 1;
    if (action.startsWith("range ")) {
      const body: Node[] = [];
      const node = { kind: "range" as const, expr: action.slice(6).trim(), body };
      stack[stack.length - 1].push(node);
      stack.push(body);
      ranges.push(node);
    } else if (action === "end") {
      if (stack.length === 1) throw new KubeError("error: error parsing jsonpath, not in range, nothing to end");
      stack.pop();
      ranges.pop();
    } else if (/^["'].*["']$/s.test(action)) {
      const text = action
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
      stack[stack.length - 1].push({ kind: "text", text });
    } else {
      stack[stack.length - 1].push({ kind: "expr", expr: action });
    }
  }
  return root;
}

function render(nodes: Node[], ctx: unknown): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "expr") out += evalPath(ctx, n.expr).map(fmt).join(" ");
    else for (const item of evalPath(ctx, n.expr)) out += render(n.body, item);
  }
  return out;
}

/** Render a kubectl -o jsonpath template. A bare path without braces is accepted too. */
export function renderJsonPath(template: string, data: unknown): string {
  let t = template.trim();
  if (/^['"].*['"]$/s.test(t)) t = t.slice(1, -1);
  if (!t.includes("{")) t = `{${t}}`;
  return render(tokenize(t), data);
}
