import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLab } from "../src/labs/schema.js";
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

describe("labs", () => {
  const files = labFiles();
  it("has the beginner set", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
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
