// Parse kubectl style arguments: positional args, --flag=value,
// --flag value, -n value, -oyaml, repeated flags and everything after "--".

import { KubeError } from "../types.js";

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set([
  "A",
  "all-namespaces",
  "show-labels",
  "all",
  "force",
  "overwrite",
  "previous",
  "i",
  "t",
  "it",
  "ti",
  "stdin",
  "tty",
  "rm",
  "command",
  "no-headers",
  "record",
  "w",
  "watch",
  "R",
  "recursive",
  "h",
  "help",
  "q",
  "quiet",
  "ignore-daemonsets",
  "delete-emptydir-data",
  "delete-local-data",
  "current",
  "client",
  "f-follow",
  "wait",
  "list",
  "local",
  "raw",
  "minify",
]);

const SHORT_ALIASES: Record<string, string> = {
  n: "namespace",
  o: "output",
  l: "selector",
  f: "filename",
  c: "container",
  p: "previous",
  A: "all-namespaces",
  w: "watch",
  R: "recursive",
  h: "help",
  q: "quiet",
  k: "kustomize",
};

export interface ParsedArgs {
  args: string[];
  flags: Map<string, string[]>;
  /** Arguments after a bare "--". */
  rest: string[];
  hasDoubleDash: boolean;
}

export function parseArgs(argv: string[], booleanExtra: string[] = []): ParsedArgs {
  const flags = new Map<string, string[]>();
  const args: string[] = [];
  const bools = new Set([...BOOLEAN_FLAGS, ...booleanExtra]);
  const add = (k: string, v: string) => {
    const list = flags.get(k) ?? [];
    list.push(v);
    flags.set(k, list);
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      return { args, flags, rest: argv.slice(i + 1), hasDoubleDash: true };
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        add(body.slice(0, eq), body.slice(eq + 1));
      } else if (bools.has(body)) {
        add(body, "true");
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        add(body, argv[++i]);
      } else {
        add(body, "true");
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const body = a.slice(1);
      // Combined boolean shorts such as -it.
      if (bools.has(body) && !SHORT_ALIASES[body]) {
        add(body, "true");
        if (body === "it" || body === "ti") {
          add("i", "true");
          add("t", "true");
        }
        continue;
      }
      const letter = body[0];
      const long = SHORT_ALIASES[letter] ?? letter;
      const inline = body.slice(1);
      if (inline) {
        add(long, inline.startsWith("=") ? inline.slice(1) : inline);
      } else if (bools.has(letter) || bools.has(long)) {
        add(long, "true");
      } else if (i + 1 < argv.length) {
        add(long, argv[++i]);
      } else {
        throw new KubeError(`error: flag needs an argument: '${letter}' in -${letter}`);
      }
      continue;
    }
    args.push(a);
  }
  return { args, flags, rest: [], hasDoubleDash: false };
}

export class Flags {
  constructor(private p: ParsedArgs) {}
  get args(): string[] {
    return this.p.args;
  }
  get rest(): string[] {
    return this.p.rest;
  }
  get hasDoubleDash(): boolean {
    return this.p.hasDoubleDash;
  }
  has(...names: string[]): boolean {
    return names.some((n) => this.p.flags.has(n));
  }
  str(...names: string[]): string | undefined {
    for (const n of names) {
      const v = this.p.flags.get(n);
      if (v && v.length) return v[v.length - 1];
    }
    return undefined;
  }
  all(...names: string[]): string[] {
    return names.flatMap((n) => this.p.flags.get(n) ?? []);
  }
  bool(...names: string[]): boolean {
    const v = this.str(...names);
    return v !== undefined && v !== "false";
  }
  int(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new KubeError(`error: invalid argument "${v}" for "--${name}" flag: strconv.ParseInt: parsing "${v}": invalid syntax`);
    return n;
  }
  names(): string[] {
    return [...this.p.flags.keys()];
  }
}
