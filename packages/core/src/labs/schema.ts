// Lab definition format. A lab is a YAML file with a short intro, an
// optional setup (shell commands and files), tasks for the learner,
// automatic checks, hints and a reference solution.

import { parse } from "yaml";

export interface LabCheck {
  /** Shown to the learner, e.g. "Pod web is Running". */
  name: string;
  kind?: string;
  /** Object name. */
  resource?: string;
  namespace?: string;
  /** exists | absent */
  expect?: "exists" | "absent";
  /** JSONPath-like path into the object, e.g. .spec.containers[0].image */
  path?: string;
  equals?: string | number | boolean;
  matches?: string;
  contains?: string;
  gte?: number;
  lte?: number;
  /** Count objects of `kind` matching `selector` (and `phase` / `ready`). */
  count?: { selector?: string; phase?: string; ready?: boolean; equals?: number; gte?: number };
  /** Run a read-only shell command and match its output. */
  command?: string;
  outputMatches?: string;
  exitCode?: number;
}

export interface Lab {
  id: string;
  title: string;
  level: "beginner" | "intermediate" | "advanced";
  minutes: number;
  tracks: string[];
  topic: string;
  intro: string;
  setup: string[];
  files: Record<string, string>;
  settle: number;
  tasks: string[];
  checks: LabCheck[];
  hints: string[];
  solution: string[];
  /** Short recap shown when every check passes. */
  learned?: string;
}

export class LabFormatError extends Error {}

function str(v: unknown, field: string, id: string): string {
  if (typeof v !== "string" || !v.trim()) throw new LabFormatError(`lab ${id}: "${field}" must be a non-empty string`);
  return v;
}

function list(v: unknown, field: string, id: string, required = false): string[] {
  if (v === undefined || v === null) {
    if (required) throw new LabFormatError(`lab ${id}: "${field}" is required`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new LabFormatError(`lab ${id}: "${field}" must be a list of strings`);
  return v as string[];
}

export function parseLab(text: string, source = "lab"): Lab {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new LabFormatError(`${source}: not a YAML object`);
  const id = str(raw.id, "id", source);
  const level = (raw.level ?? "beginner") as Lab["level"];
  if (!["beginner", "intermediate", "advanced"].includes(level)) throw new LabFormatError(`lab ${id}: level must be beginner, intermediate or advanced`);
  const checks = raw.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new LabFormatError(`lab ${id}: "checks" must be a non-empty list`);
  for (const [i, c] of (checks as LabCheck[]).entries()) {
    if (!c || typeof c !== "object" || !c.name) throw new LabFormatError(`lab ${id}: check ${i + 1} needs a "name"`);
    if (!c.command && !c.kind) throw new LabFormatError(`lab ${id}: check "${c.name}" needs "kind" or "command"`);
  }
  const files = (raw.files ?? {}) as Record<string, string>;
  if (typeof files !== "object" || Array.isArray(files)) throw new LabFormatError(`lab ${id}: "files" must be a map of file name to content`);
  return {
    id,
    title: str(raw.title, "title", id),
    level,
    minutes: typeof raw.minutes === "number" ? raw.minutes : 10,
    tracks: list(raw.tracks, "tracks", id),
    topic: typeof raw.topic === "string" ? raw.topic : "General",
    intro: str(raw.intro, "intro", id).trim(),
    setup: list(raw.setup, "setup", id),
    files,
    settle: typeof raw.settle === "number" ? raw.settle : 20,
    tasks: list(raw.tasks, "tasks", id, true),
    checks: checks as LabCheck[],
    hints: list(raw.hints, "hints", id),
    solution: list(raw.solution, "solution", id, true),
    learned: typeof raw.learned === "string" ? raw.learned.trim() : undefined,
  };
}
