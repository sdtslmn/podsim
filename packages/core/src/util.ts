// Small helpers shared by the engine and the kubectl layer.
// Everything here must stay browser-safe: no Node APIs.

/** Alphabet Kubernetes uses for generated name suffixes (no vowels, no confusable digits). */
const SAFE_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";

export function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** FNV-1a 32-bit hash. Stable across runs, good enough for template hashes. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Encode a number with the Kubernetes safe alphabet, e.g. for pod-template-hash. */
export function safeEncode(num: number, length = 10): string {
  let n = num >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SAFE_ALPHABET[n % SAFE_ALPHABET.length];
    n = Math.floor(n / SAFE_ALPHABET.length) ^ fnv1a(out + i);
    n = n >>> 0;
  }
  return out;
}

/** Stable JSON: object keys sorted, so equal objects hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Seeded PRNG (mulberry32) so tests and replays are deterministic. */
export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  suffix(length = 5): string {
    let out = "";
    for (let i = 0; i < length; i++) out += SAFE_ALPHABET[this.int(SAFE_ALPHABET.length)];
    return out;
  }
  uid(): string {
    const hex = () => this.int(16).toString(16);
    const part = (n: number) => Array.from({ length: n }, hex).join("");
    return `${part(8)}-${part(4)}-4${part(3)}-${"89ab"[this.int(4)]}${part(3)}-${part(12)}`;
  }
}

export function isoTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function parseTime(iso: string | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

/**
 * Human readable age, following the rules kubectl uses
 * (k8s.io/apimachinery/pkg/util/duration.HumanDuration).
 */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60 * 2) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    const s = seconds % 60;
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`;
  }
  if (minutes < 60 * 3) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) {
    const m = minutes % 60;
    return m === 0 ? `${hours}h` : `${hours}h${m}m`;
  }
  if (hours < 48) return `${hours}h`;
  if (hours < 24 * 8) {
    const h = hours % 24;
    const d = Math.floor(hours / 24);
    return h === 0 ? `${d}d` : `${d}d${h}h`;
  }
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24)}d`;
  return `${Math.floor(hours / 24 / 365)}y`;
}

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function validateName(name: string, label = false): string | undefined {
  if (!name) return "name or generateName is required";
  const max = label ? 63 : 253;
  if (name.length > max) return `must be no more than ${max} characters`;
  const re = label ? DNS1123_LABEL : DNS1123_SUBDOMAIN;
  if (!re.test(name)) {
    return label
      ? "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')"
      : "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')";
  }
  return undefined;
}

// ---------- labels and selectors ----------

export type Labels = Record<string, string>;

export interface Requirement {
  key: string;
  op: "=" | "!=" | "in" | "notin" | "exists" | "!exists";
  values: string[];
}

/** Parse a label selector string such as "app=web,tier!=db,env in (prod,dev),!legacy". */
export function parseSelector(input: string): Requirement[] {
  const reqs: Requirement[] = [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/))) {
      reqs.push({ key: m[1], op: m[2] as "in" | "notin", values: m[3].split(",").map((v) => v.trim()) });
    } else if ((m = part.match(/^([\w./-]+)\s*!=\s*([\w.-]*)$/))) {
      reqs.push({ key: m[1], op: "!=", values: [m[2]] });
    } else if ((m = part.match(/^([\w./-]+)\s*==?\s*([\w.-]*)$/))) {
      reqs.push({ key: m[1], op: "=", values: [m[2]] });
    } else if ((m = part.match(/^!([\w./-]+)$/))) {
      reqs.push({ key: m[1], op: "!exists", values: [] });
    } else if ((m = part.match(/^([\w./-]+)$/))) {
      reqs.push({ key: m[1], op: "exists", values: [] });
    } else {
      throw new Error(`unable to parse requirement: ${part}`);
    }
  }
  return reqs;
}

export function matchRequirements(labels: Labels | undefined, reqs: Requirement[]): boolean {
  const l = labels ?? {};
  return reqs.every((r) => {
    const has = Object.prototype.hasOwnProperty.call(l, r.key);
    switch (r.op) {
      case "=":
        return has && l[r.key] === r.values[0];
      case "!=":
        return !has || l[r.key] !== r.values[0];
      case "in":
        return has && r.values.includes(l[r.key]);
      case "notin":
        return !has || !r.values.includes(l[r.key]);
      case "exists":
        return has;
      case "!exists":
        return !has;
    }
  });
}

export interface LabelSelector {
  matchLabels?: Labels;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/** Match a structured selector (spec.selector of a Deployment or ReplicaSet). */
export function matchLabelSelector(labels: Labels | undefined, selector: LabelSelector | undefined): boolean {
  if (!selector) return false;
  const reqs: Requirement[] = [];
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) reqs.push({ key: k, op: "=", values: [v] });
  for (const e of selector.matchExpressions ?? []) {
    const op = e.operator.toLowerCase();
    if (op === "in") reqs.push({ key: e.key, op: "in", values: e.values ?? [] });
    else if (op === "notin") reqs.push({ key: e.key, op: "notin", values: e.values ?? [] });
    else if (op === "exists") reqs.push({ key: e.key, op: "exists", values: [] });
    else if (op === "doesnotexist") reqs.push({ key: e.key, op: "!exists", values: [] });
  }
  if (reqs.length === 0) return false;
  return matchRequirements(labels, reqs);
}

/** Match a plain map selector (spec.selector of a Service, nodeSelector). */
export function matchMap(labels: Labels | undefined, selector: Labels | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  const l = labels ?? {};
  return Object.entries(selector).every(([k, v]) => l[k] === v);
}

export function formatLabels(labels: Labels | undefined): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return "<none>";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

// ---------- resource quantities ----------

/** CPU quantity to millicores ("500m" -> 500, "2" -> 2000). */
export function parseCpu(q: string | number | undefined): number {
  if (q === undefined || q === "") return 0;
  const s = String(q);
  if (s.endsWith("m")) return parseFloat(s);
  return Math.round(parseFloat(s) * 1000);
}

const MEM_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** Memory quantity to bytes ("128Mi" -> 134217728). */
export function parseMemory(q: string | number | undefined): number {
  if (q === undefined || q === "") return 0;
  const m = String(q).match(/^([0-9.]+)([a-zA-Z]*)$/);
  if (!m) return NaN;
  const unit = MEM_UNITS[m[2]];
  if (unit === undefined) return NaN;
  return Math.round(parseFloat(m[1]) * unit);
}

export function isValidQuantity(q: unknown): boolean {
  if (typeof q === "number") return q >= 0;
  if (typeof q !== "string") return false;
  return /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.test(q);
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Render rows as a kubectl-style table: columns separated by 3 spaces, left aligned. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c ?? "", widths[i] + 3)))
      .join("")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
