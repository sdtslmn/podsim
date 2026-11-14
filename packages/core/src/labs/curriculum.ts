// The curriculum groups labs into a learning path (levels made of modules)
// and certification tracks (sections such as exam domains, plus mock exams).
// It lives in labs/curriculum.yaml.

import { parse } from "yaml";
import { LabFormatError, type Lab } from "./schema.js";

export interface Module {
  title: string;
  summary: string;
  labs: string[];
}

export interface Level {
  id: string;
  title: string;
  summary: string;
  modules: Module[];
}

export interface TrackSection {
  title: string;
  /** Exam weight in percent, if the section is an exam domain. */
  weight?: number;
  summary: string;
  labs: string[];
}

export interface Track {
  id: string;
  title: string;
  summary: string;
  sections: TrackSection[];
  exams: string[];
}

export interface Curriculum {
  levels: Level[];
  tracks: Track[];
}

const ids = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new LabFormatError(`curriculum: ${where} must be a list of lab ids`);
  return v as string[];
};

/** Parse labs/curriculum.yaml. With labs given, every referenced lab must exist. */
export function parseCurriculum(text: string, labs?: Lab[], examIds?: string[]): Curriculum {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new LabFormatError("curriculum: not a YAML object");
  const levels = ((raw.levels as Record<string, unknown>[]) ?? []).map((l, i): Level => ({
    id: String(l.id ?? `level-${i + 1}`),
    title: String(l.title ?? l.id ?? ""),
    summary: String(l.summary ?? "").trim(),
    modules: ((l.modules as Record<string, unknown>[]) ?? []).map((m, j) => ({
      title: String(m.title ?? `Module ${j + 1}`),
      summary: String(m.summary ?? "").trim(),
      labs: ids(m.labs ?? [], `levels[${i}].modules[${j}].labs`),
    })),
  }));
  const tracks = ((raw.tracks as Record<string, unknown>[]) ?? []).map((t, i): Track => ({
    id: String(t.id ?? `track-${i + 1}`),
    title: String(t.title ?? t.id ?? ""),
    summary: String(t.summary ?? "").trim(),
    sections: ((t.sections as Record<string, unknown>[]) ?? []).map((s, j) => ({
      title: String(s.title ?? `Section ${j + 1}`),
      weight: typeof s.weight === "number" ? s.weight : undefined,
      summary: String(s.summary ?? "").trim(),
      labs: ids(s.labs ?? [], `tracks[${i}].sections[${j}].labs`),
    })),
    exams: ids(t.exams ?? [], `tracks[${i}].exams`),
  }));
  const c = { levels, tracks };
  if (labs) {
    const known = new Set(labs.map((l) => l.id));
    const pathIds = levels.flatMap((l) => l.modules.flatMap((m) => m.labs));
    const seen = new Set<string>();
    for (const id of pathIds) {
      if (!known.has(id)) throw new LabFormatError(`curriculum: lab "${id}" in the learning path does not exist`);
      if (seen.has(id)) throw new LabFormatError(`curriculum: lab "${id}" appears twice in the learning path`);
      seen.add(id);
    }
    for (const t of tracks) for (const s of t.sections) for (const id of s.labs) if (!known.has(id)) throw new LabFormatError(`curriculum: lab "${id}" in track ${t.id} does not exist`);
    const used = new Set([...pathIds, ...tracks.flatMap((t) => t.sections.flatMap((s) => s.labs))]);
    const orphans = labs.filter((l) => !used.has(l.id)).map((l) => l.id);
    if (orphans.length) throw new LabFormatError(`curriculum: these labs are not in the curriculum: ${orphans.join(", ")}`);
  }
  if (examIds) for (const t of tracks) for (const e of t.exams) if (!examIds.includes(e)) throw new LabFormatError(`curriculum: exam "${e}" in track ${t.id} does not exist`);
  return c;
}

/** Labs in learning-path order, then labs that only appear in tracks. */
export function curriculumOrder(c: Curriculum, labs: Lab[]): Lab[] {
  const byId = new Map(labs.map((l) => [l.id, l]));
  const order = [...c.levels.flatMap((l) => l.modules.flatMap((m) => m.labs)), ...c.tracks.flatMap((t) => t.sections.flatMap((s) => s.labs))];
  const out: Lab[] = [];
  for (const id of order) {
    const l = byId.get(id);
    if (l && !out.includes(l)) out.push(l);
  }
  for (const l of labs) if (!out.includes(l)) out.push(l);
  return out;
}

/** Where a lab sits: level and module titles, and the track sections that use it. */
export function labPlace(c: Curriculum, id: string): { level?: Level; module?: Module; sections: { track: Track; section: TrackSection }[] } {
  let level: Level | undefined;
  let module: Module | undefined;
  for (const l of c.levels) for (const m of l.modules) if (m.labs.includes(id)) ((level = l), (module = m));
  const sections = c.tracks.flatMap((track) => track.sections.filter((s) => s.labs.includes(id)).map((section) => ({ track, section })));
  return { level, module, sections };
}

/** Short code shown in lists and prompts: b01-first-pod → B01. */
export function labCode(id: string): string {
  const m = id.match(/^([a-z])(\d+)-/);
  return m ? `${m[1].toUpperCase()}${m[2]}` : id;
}

/** Find a lab by id, code (b3, B03, i12) or a plain beginner number. */
export function findLabByRef(labs: Lab[], ref: string): Lab | undefined {
  const r = ref.trim().toLowerCase();
  const exact = labs.find((l) => l.id === r);
  if (exact) return exact;
  const code = r.match(/^([a-z])0*(\d+)$/);
  if (code) return labs.find((l) => l.id.match(/^([a-z])(\d+)-/)?.[1] === code[1] && parseInt(l.id.slice(1), 10) === parseInt(code[2], 10));
  if (/^\d+$/.test(r)) return labs.find((l) => l.id.startsWith("b") && parseInt(l.id.slice(1), 10) === parseInt(r, 10));
  return labs.find((l) => l.id.startsWith(r) || l.id.includes(r));
}
