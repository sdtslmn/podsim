import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLab } from "../src/labs/schema.js";
import { parseCurriculum, findLabByRef, labCode } from "../src/labs/curriculum.js";
import { parseExam } from "../src/labs/exam.js";
import { LabSession } from "../src/labs/session.js";
import { MemoryFS } from "../src/fs.js";
import type { IO } from "../src/kubectl/index.js";

const LABS_DIR = join(__dirname, "..", "..", "..", "labs");

function labFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(LABS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(LABS_DIR, entry.name);
    for (const f of readdirSync(dir)) if (f.endsWith(".yaml")) out.push(join(dir, f));
  }
  return out.sort();
}

describe("curriculum", () => {
  const labs = labFiles().map((f) => parseLab(readFileSync(f, "utf8"), f));
  const examIds = readdirSync(join(LABS_DIR, "..", "exams")).map((f) => parseExam(readFileSync(join(LABS_DIR, "..", "exams", f), "utf8")).id);
  const c = parseCurriculum(readFileSync(join(LABS_DIR, "curriculum.yaml"), "utf8"), labs, examIds);

  it("covers every lab and exam, from beginner to real-life scenarios", () => {
    expect(c.levels.map((l) => l.id)).toEqual(["beginner", "intermediate", "advanced", "scenarios"]);
    for (const lv of c.levels) {
      const ids = lv.modules.flatMap((m) => m.labs);
      expect(ids.length).toBeGreaterThanOrEqual(5);
      const level = lv.id === "scenarios" ? "scenario" : lv.id;
      for (const id of ids) expect(labs.find((l) => l.id === id)!.level, id).toBe(level);
    }
  });

  it("maps the CKAD track to the five exam domains", () => {
    const ckad = c.tracks.find((t) => t.id === "ckad")!;
    const domains = ckad.sections.filter((s) => s.weight);
    expect(domains.map((d) => d.weight).reduce((a, b) => a! + b!, 0)).toBe(100);
    expect(domains.every((d) => d.labs.length >= 5)).toBe(true);
    expect(ckad.exams.length).toBeGreaterThanOrEqual(2);
  });

  it("finds labs by code", () => {
    expect(findLabByRef(labs, "b1")?.id).toBe("b01-cluster-tour");
    expect(findLabByRef(labs, "S02")?.id).toBe("s02-checkout-outage");
    expect(findLabByRef(labs, "3")?.id).toBe("b03-pod-from-yaml");
    expect(findLabByRef(labs, "i22-kustomize")?.id).toBe("i22-kustomize");
    expect(labCode("a08-kubectl-debug")).toBe("A08");
  });
});

describe("labs", () => {
  const files = labFiles();
  it("has the full learning path", () => {
    expect(files.length).toBeGreaterThanOrEqual(55);
  });

  for (const file of files) {
    const lab = parseLab(readFileSync(file, "utf8"), file);
    it(`${lab.id}: starts unsolved and is solved by its own solution`, async () => {
      let now = Date.parse("2026-11-14T10:00:00Z");
      const fs = new MemoryFS();
      const session = new LabSession(lab, fs, { clock: () => now, seed: 11 });
      const setupErrors = await session.setup();
      expect(setupErrors).toEqual([]);

      const before = await session.check();
      expect(before.some((r) => !r.passed), `${lab.id} should not pass before the learner acts`).toBe(true);

      let output = "";
      const io: IO = {
        stdout: (t) => (output += t),
        stderr: (t) => (output += t),
        sleep: async (ms) => {
          now += ms;
        },
      };
      for (const step of lab.solution) {
        const code = await session.shell.exec(step, io);
        expect(code, `solution step failed: ${step}\n${output}`).toBe(0);
      }
      now += 30000;
      const after = await session.check();
      const failed = after.filter((r) => !r.passed);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    });
  }
});
