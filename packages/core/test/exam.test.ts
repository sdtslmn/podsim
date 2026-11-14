import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseExam, ExamSession, examTaskLabs } from "../src/labs/exam.js";
import { LabSession } from "../src/labs/session.js";
import { MemoryFS } from "../src/fs.js";
import type { IO } from "../src/kubectl/index.js";

const EXAMS_DIR = join(__dirname, "..", "..", "..", "exams");
const exams = readdirSync(EXAMS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parseExam(readFileSync(join(EXAMS_DIR, f), "utf8"), f));

function clock(start = Date.parse("2026-11-14T10:00:00Z")) {
  let now = start;
  return { now: () => now, tick: (ms: number) => (now += ms) };
}

function capture(c: { tick: (ms: number) => void }) {
  let out = "";
  let err = "";
  const io: IO = { stdout: (t) => (out += t), stderr: (t) => (err += t), sleep: async (ms) => void c.tick(ms) };
  return { io, take: () => ({ out, err, all: out + err }), reset: () => ((out = ""), (err = "")) };
}

describe("mock exams", () => {
  it("has a CKAD exam with weights adding up to 100", () => {
    const ckad = exams.find((e) => e.track === "ckad")!;
    expect(ckad.tasks.length).toBeGreaterThanOrEqual(15);
    expect(ckad.tasks.reduce((s, t) => s + t.weight, 0)).toBe(100);
    const domains = new Set(ckad.tasks.map((t) => t.domain));
    expect(domains.size).toBe(5);
  });

  for (const exam of exams) {
    for (const lab of examTaskLabs(exam)) {
      it(`${lab.id}: starts unsolved and is solved by its own solution`, async () => {
        const c = clock();
        const session = new LabSession(lab, new MemoryFS(), { clock: c.now, seed: 13 });
        expect(await session.setup()).toEqual([]);
        expect((await session.check()).some((r) => !r.passed)).toBe(true);
        const cap = capture(c);
        for (const step of lab.solution) expect(await session.shell.exec(step, cap.io), `${step}\n${cap.take().all}`).toBe(0);
        c.tick(30000);
        const failed = (await session.check()).filter((r) => !r.passed);
        expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      });
    }
  }
});

describe("exam session", () => {
  it("works like the exam environment: base node, ssh to hosts, grading", async () => {
    const exam = exams[0];
    const c = clock();
    let real = 0;
    const ex = new ExamSession(exam, { cluster: () => ({ clock: c.now, seed: 5 }), now: () => real });
    const cap = capture(c);
    expect(ex.prompt()).toBe("candidate@base:~$ ");
    expect(await ex.exec("kubectl get pods", cap.io)).toBe(1);
    expect(cap.take().err).toMatch(/The connection to the server localhost:8080 was refused/);
    cap.reset();
    expect(await ex.exec("ssh nowhere", cap.io)).toBe(255);
    expect(cap.take().err).toMatch(/Could not resolve hostname nowhere/);

    const t1 = exam.tasks[0];
    expect(await ex.exec(`ssh ${t1.host}`, cap.io)).toBe(0);
    expect(ex.prompt()).toBe(`candidate@${t1.host}:~$ `);
    for (const step of t1.solution) expect(await ex.exec(step, cap.io)).toBe(0);
    cap.reset();
    await ex.exec("exit", cap.io);
    expect(cap.take().out).toContain(`Connection to ${t1.host} closed.`);
    expect(ex.host).toBe("base");

    // A second task that was opened but not solved.
    const t2 = exam.tasks[1];
    await ex.exec(`ssh ${t2.host}`, cap.io);
    await ex.exec("exit", cap.io);

    real += 30 * 60000;
    expect(ex.remainingMs()).toBe(90 * 60000);
    const r = await ex.grade();
    expect(r.tasks[0].score).toBe(t1.weight);
    expect(r.tasks[1].visited).toBe(true);
    expect(r.tasks[1].score).toBe(0);
    expect(r.tasks[2].checks[0].detail).toBe("not attempted");
    expect(r.percent).toBe(Math.round((t1.weight / r.total) * 100));
    expect(r.passed).toBe(false);
    expect(r.usedMs).toBe(30 * 60000);
  });
});
