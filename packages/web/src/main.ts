// Browser front end: lab panel on the left, terminal on the right.
// Everything runs client-side on the same engine as the CLI.

import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Cluster, Shell, LabSession, MemoryFS, parseLab, parseExam, ExamSession, K8S_VERSION, type IO, type Lab, type CheckResult, type Exam, type ExamResult } from "@podsim/core";
import { LineEditor } from "./line-editor";

const REPO_URL: string = import.meta.env.VITE_REPO_URL ?? "https://github.com/sdtslmn/podsim";

// ---------------------------------------------------------------- labs

const rawLabs = import.meta.glob("../../../labs/**/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const LEVELS = { beginner: 0, intermediate: 1, advanced: 2 };
const labs: Lab[] = Object.entries(rawLabs)
  .map(([file, text]) => {
    try {
      return parseLab(text, file);
    } catch (e) {
      console.warn(`Skipping ${file}: ${(e as Error).message}`);
      return undefined;
    }
  })
  .filter((l): l is Lab => !!l)
  .sort((a, b) => LEVELS[a.level] - LEVELS[b.level] || a.id.localeCompare(b.id));

const rawExams = import.meta.glob("../../../exams/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const exams: Exam[] = Object.entries(rawExams)
  .map(([file, text]) => {
    try {
      return parseExam(text, file);
    } catch (e) {
      console.warn(`Skipping ${file}: ${(e as Error).message}`);
      return undefined;
    }
  })
  .filter((e): e is Exam => !!e);

const PROGRESS_KEY = "podsim.progress";
function loadProgress(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveProgress(done: Set<string>): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...done]));
  } catch {
    /* storage may be unavailable, progress is then per tab */
  }
}

// ---------------------------------------------------------------- helpers

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function reflowText(s: string): string {
  // Join hard-wrapped lines into paragraphs, keep indented example lines and list items as they are.
  const out: string[] = [];
  for (const line of s.split("\n")) {
    const prev = out[out.length - 1];
    const plain = (l: string) => l.trim() !== "" && !/^\s/.test(l) && !/^- /.test(l);
    if (prev !== undefined && plain(prev) && plain(line)) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join("\n");
}
const md = (s: string) => esc(reflowText(s)).replace(/`([^`]+)`/g, "<code>$1</code>");
const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
const termMd = (s: string) => s.replace(/`([^`]+)`/g, (_, c) => C.cyan(c));

// ---------------------------------------------------------------- state

type View = "labs" | "lab" | "sandbox" | "files" | "exam-intro" | "exam" | "exam-result";

const panel = document.getElementById("panel")!;
const done = loadProgress();
let view: View = "labs";
let lab: Lab | undefined;
let session: LabSession | undefined;
let fs = new MemoryFS();
let cluster: Cluster;
let shell: Shell;
let lastResults: CheckResult[] | undefined;
let notice: { text: string; success?: boolean } | undefined;
let editingFile: string | undefined;
let aborted = false;
let pending = "";
let exam: ExamSession | undefined;
let examPick: Exam | undefined = exams[0];
let examTask = 1;
let examResult: { exam: Exam; result: ExamResult } | undefined;
let examTimer: ReturnType<typeof setInterval> | undefined;

(document.getElementById("nav-repo") as HTMLAnchorElement).href = REPO_URL;

// ---------------------------------------------------------------- terminal

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: '"Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: { background: "#1e1e1e" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
fit.fit();
new ResizeObserver(() => fit.fit()).observe(document.getElementById("terminal")!);

const print = (s = "") => term.write(s + "\n");

const io: IO = {
  stdout: (t) => term.write(t),
  stderr: (t) => term.write(t.startsWith("(podsim)") ? C.yellow(t) : t),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  aborted: () => aborted,
};

const prompt = () => {
  if (exam) {
    const p = exam.prompt();
    return p.startsWith("candidate@") ? `${C.green(p.slice(0, p.indexOf(":")))}:${C.cyan("~")}$ ` : p;
  }
  return shell.sessionPrompt() ?? `${lab ? C.yellow(`[${lab.id.startsWith("ckad-") ? lab.id.split("-").slice(0, 2).join("-") : lab.id.split("-")[0]}] `) : ""}${C.green("controlplane")}:${C.cyan("~")}$ `;
};
const activeCluster = () => (exam ? exam.cluster : cluster);
const activeShell = () => (exam ? exam.shell : shell);
const activeFs = () => (exam ? (exam.shell?.fs as MemoryFS | undefined) : fs);

const KUBECTL_VERBS = ["get", "describe", "create", "apply", "delete", "run", "expose", "scale", "set", "rollout", "logs", "exec", "label", "annotate", "patch", "replace", "cordon", "uncordon", "drain", "taint", "config", "auth", "wait", "api-resources", "cluster-info", "version"];
const RESOURCES = ["pods", "deployments", "replicasets", "services", "endpoints", "configmaps", "secrets", "namespaces", "nodes", "events", "serviceaccounts", "all"];

const editor = new LineEditor(term, {
  prompt,
  continuation: "> ",
  onInterrupt: () => {
    aborted = true;
    pending = "";
  },
  complete: (line) => {
    const words = line.split(/\s+/);
    const last = words[words.length - 1];
    let candidates: string[] = [];
    if (words.length === 1) candidates = exam ? ["kubectl", "ssh", "exit", "helm", "cat", "ls", "clear"] : ["kubectl", "check", "hint", "task", "solution", "reset", "next", "labs", "lab", "help", "clear", "cat", "ls"];
    else if (exam && words[0] === "ssh") candidates = exam.exam.tasks.map((t) => t.host);
    else if (words[0] === "kubectl" || words[0] === "k") {
      if (words.length === 2) candidates = KUBECTL_VERBS;
      else if (words.length === 3 && ["get", "describe", "delete", "label"].includes(words[1])) candidates = RESOURCES;
      else if (words.length === 3 && ["logs", "exec"].includes(words[1])) candidates = activeCluster()?.list("Pod", activeShell()?.kubectl.state.namespace).map((p) => p.metadata.name) ?? [];
    }
    return candidates.filter((c) => c.startsWith(last));
  },
  onLine: async (line) => {
    pending = pending ? pending + "\n" + line : line;
    if (exam ? exam.needsMoreInput(pending) : shell.needsMoreInput(pending)) {
      editor.showPrompt(true);
      return;
    }
    const input = pending;
    pending = "";
    if (input.trim()) {
      aborted = false;
      try {
        if (exam) {
          if (exam.remainingMs() === 0) await finishExam();
          else {
            const before = exam.host;
            await exam.exec(input, io);
            if (exam.host !== before) {
              const t = exam.taskOnHost();
              if (t) examTask = t.n;
              if (view === "exam") renderPanel();
            }
          }
        } else await shell.exec(input, io);
      } catch (e) {
        print(C.red(`internal error: ${(e as Error).message}`));
      }
      if (view === "files") renderPanel();
    }
    editor.showPrompt(false);
  },
});

// ---------------------------------------------------------------- sessions

function newShell(nextFs: MemoryFS, c: Cluster, s?: Shell): void {
  fs = nextFs;
  cluster = c;
  shell = s ?? new Shell(cluster, fs);
  registerCommands();
}

function startSandbox(announce = true): void {
  lab = undefined;
  session = undefined;
  lastResults = undefined;
  notice = undefined;
  const c = new Cluster();
  const f = new MemoryFS();
  newShell(f, c, new Shell(c, f, { openEditor }));
  view = "sandbox";
  renderPanel();
  if (announce) {
    print("");
    print(C.dim("Free sandbox on a fresh cluster. Use kubectl as you like. Type labs to see the guided labs."));
    editor.showPrompt();
  }
}

async function startLab(next: Lab, showIntro = true): Promise<void> {
  lab = next;
  lastResults = undefined;
  notice = undefined;
  const labFs = new MemoryFS();
  session = new LabSession(next, labFs, {}, { openEditor });
  newShell(labFs, session.cluster, session.shell);
  view = "lab";
  renderPanel();
  term.write("\r\x1b[K" + C.dim("Preparing the cluster...") + "\n");
  const errors = await session.setup();
  for (const e of errors) print(C.yellow(`setup warning: ${e}`));
  if (showIntro) {
    print("");
    print(C.bold(`Lab ${next.id}: ${next.title}`));
    next.tasks.forEach((t, i) => print(`  ${i + 1}. ${termMd(t)}`));
    print(C.dim("The full instructions are in the panel on the left. Type check when you are done."));
  }
  editor.showPrompt();
}

function nextLab(): Lab | undefined {
  if (!lab) return labs[0];
  return labs[labs.findIndex((l) => l.id === lab!.id) + 1];
}

async function runCheck(fromButton: boolean): Promise<void> {
  if (!session || !lab) return;
  const results = await session.check();
  lastResults = results;
  const passed = results.filter((r) => r.passed).length;
  if (fromButton) print("");
  for (const r of results) print(r.passed ? `${C.green("✔")} ${r.name}` : `${C.red("✘")} ${r.name}${r.detail ? C.dim(`  (${r.detail})`) : ""}`);
  if (passed === results.length) {
    print(C.green(C.bold("All checks passed. Lab complete!")));
    done.add(lab.id);
    saveProgress(done);
    notice = { text: `Lab complete!\n\n${lab.learned ?? ""}`.trim(), success: true };
  } else {
    print(`${passed} of ${results.length} checks passed. Type hint if you are stuck.`);
    notice = undefined;
  }
  renderPanel();
  if (fromButton) editor.showPrompt();
}

function showHint(fromButton: boolean): void {
  const h = session?.nextHint();
  if (!h) return;
  notice = { text: `Hint ${h.index}/${h.total}: ${h.text}` };
  if (fromButton) print("");
  print(`${C.yellow(`Hint ${h.index}/${h.total}:`)} ${termMd(h.text)}`);
  renderPanel();
  if (fromButton) editor.showPrompt();
}

function showSolution(fromButton: boolean): void {
  if (!lab) return;
  notice = { text: `One way to solve it:\n\n${lab.solution.join("\n")}` };
  if (fromButton) print("");
  print(C.yellow("One way to solve it (try on your own first, you learn more that way):"));
  for (const step of lab.solution) print(step.split("\n").map((l) => "  " + C.cyan(l)).join("\n"));
  renderPanel();
  if (fromButton) editor.showPrompt();
}

function openEditor(file: string): boolean {
  const f = activeFs() ?? fs;
  if (!f.exists(file)) f.writeFile(file, "");
  editingFile = file;
  view = "files";
  renderPanel();
  print(C.dim(`Opened ${file} in the Files panel. Save it there, then continue here.`));
  return true;
}

// ---------------------------------------------------------------- exam

const fmtClock = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};

function startExam(e: Exam): void {
  lab = undefined;
  session = undefined;
  examResult = undefined;
  exam = new ExamSession(e, { shell: { openEditor } });
  examTask = 1;
  view = "exam";
  renderPanel();
  if (examTimer) clearInterval(examTimer);
  examTimer = setInterval(() => {
    if (!exam) return;
    const left = exam.remainingMs();
    const el = document.getElementById("exam-timer");
    if (el) {
      el.textContent = fmtClock(left);
      el.classList.toggle("low", left < 10 * 60000);
    }
    if (left === 0) void finishExam();
  }, 1000);
  term.write("\r\x1b[K");
  print("");
  print(C.bold(`${e.title} started.`) + C.dim(` ${e.tasks.length} tasks, ${e.minutes} minutes.`));
  print(C.dim("You are on the base node. Each task names its host: connect with ssh HOST, return with exit."));
  print(`Task 1 is on ${C.cyan(e.tasks[0].host)}: ${C.cyan(`ssh ${e.tasks[0].host}`)}`);
  editor.showPrompt();
}

async function finishExam(): Promise<void> {
  if (!exam) return;
  const ex = exam;
  if (examTimer) clearInterval(examTimer);
  examTimer = undefined;
  term.write("\r\x1b[K" + C.dim("Scoring your exam...") + "\n");
  const result = await ex.grade();
  examResult = { exam: ex.exam, result };
  exam = undefined;
  print(`${C.bold(`Score: ${result.percent}%`)} ${result.passed ? C.green("PASS") : C.red("NOT PASSED")} ${C.dim(`(pass at ${ex.exam.passPercent}%, time used ${fmtClock(result.usedMs)})`)}`);
  print(C.dim("The breakdown and solutions are in the panel. The terminal is back on a free sandbox."));
  startSandbox(false);
  view = "exam-result";
  renderPanel();
  editor.showPrompt();
}

function renderExamIntro(): void {
  if (!exams.length) {
    panel.innerHTML = `<h2>Mock exam</h2><p class="meta">No mock exams are bundled with this build.</p>`;
    return;
  }
  const e = examPick ?? exams[0];
  const byDomain = new Map<string, number>();
  for (const t of e.tasks) byDomain.set(t.domain, (byDomain.get(t.domain) ?? 0) + t.weight);
  panel.innerHTML = `<h2>${esc(e.title)}</h2>
  <p class="meta">${e.tasks.length} tasks · ${e.minutes} minutes · pass at ${e.passPercent}%</p>
  <div class="intro">${md(e.intro)}</div>
  <h3>Domains</h3>
  <ul>${[...byDomain].map(([d, w]) => `<li>${esc(d)}: ${w}%</li>`).join("")}</ul>
  <h3>How it works</h3>
  <ul>
    <li>The timer runs in real time and the exam is scored automatically when it ends.</li>
    <li>You start on the base node. Connect to each task's host with <code>ssh HOST</code> and return with <code>exit</code>.</li>
    <li><code>kubectl</code> (alias <code>k</code>), <code>helm</code>, <code>docker</code>, <code>podman</code> and the usual shell tools are available on every host. No hints, no checks until the end.</li>
    <li>The Kubernetes docs at kubernetes.io are allowed during the real exam, so feel free to keep them open here too.</li>
  </ul>
  ${exams.length > 1 ? `<p><select id="exam-pick">${exams.map((x) => `<option value="${esc(x.id)}"${x === e ? " selected" : ""}>${esc(x.title)}</option>`).join("")}</select></p>` : ""}
  <div class="actions"><button class="btn primary" id="exam-start">Start the exam</button></div>`;
  panel.querySelector("#exam-pick")?.addEventListener("change", (ev) => {
    examPick = exams.find((x) => x.id === (ev.target as HTMLSelectElement).value);
    renderExamIntro();
  });
  panel.querySelector("#exam-start")?.addEventListener("click", () => startExam(e));
}

function renderExam(): void {
  const ex = exam!;
  const t = ex.task(examTask) ?? ex.exam.tasks[0];
  const left = ex.remainingMs();
  panel.innerHTML = `<div class="exam-head"><strong>${esc(ex.exam.title)}</strong><span id="exam-timer" class="timer${left < 600000 ? " low" : ""}">${fmtClock(left)}</span></div>
  <div class="task-grid">${ex.exam.tasks.map((x) => `<button data-task="${x.n}" class="${x.n === t.n ? "current " : ""}${ex.visited(x.n) ? "visited " : ""}${ex.flagged.has(x.n) ? "flagged" : ""}" title="${esc(x.title)} (${x.weight}%)">${x.n}</button>`).join("")}</div>
  <p class="meta">Task ${t.n} of ${ex.exam.tasks.length} · weight ${t.weight}% · ${esc(t.domain)}${ex.flagged.has(t.n) ? " · flagged" : ""}</p>
  <h2>${esc(t.title)}</h2>
  <div class="host">You must connect to the correct host. Failure to do so may result in a zero score.<br><code>ssh ${esc(t.host)}</code> <button class="link" id="exam-copy">copy</button>${ex.host === t.host ? " · you are on this host" : ""}</div>
  <div class="intro">${md(t.text)}</div>
  <div class="actions">
    <button class="btn" id="exam-prev"${t.n === 1 ? " disabled" : ""}>Previous</button>
    <button class="btn" id="exam-next"${t.n === ex.exam.tasks.length ? " disabled" : ""}>Next</button>
    <button class="btn" id="exam-flag">${ex.flagged.has(t.n) ? "Unflag" : "Flag for review"}</button>
    <button class="btn primary" id="exam-end">End exam and score</button>
  </div>`;
  panel.querySelectorAll<HTMLButtonElement>("[data-task]").forEach((b) =>
    b.addEventListener("click", () => {
      examTask = parseInt(b.dataset.task!, 10);
      renderExam();
    }),
  );
  const on = (id: string, fn: () => void) => panel.querySelector(`#${id}`)?.addEventListener("click", fn);
  on("exam-prev", () => ((examTask = Math.max(1, t.n - 1)), renderExam()));
  on("exam-next", () => ((examTask = Math.min(ex.exam.tasks.length, t.n + 1)), renderExam()));
  on("exam-flag", () => {
    if (ex.flagged.has(t.n)) ex.flagged.delete(t.n);
    else ex.flagged.add(t.n);
    renderExam();
  });
  on("exam-copy", () => void navigator.clipboard?.writeText(`ssh ${t.host}`).catch(() => undefined));
  on("exam-end", () => {
    const btn = panel.querySelector<HTMLButtonElement>("#exam-end")!;
    if (btn.dataset.confirm !== "1") {
      btn.dataset.confirm = "1";
      btn.textContent = "Click again to end the exam";
      return;
    }
    void finishExam();
  });
}

function renderExamResult(): void {
  const { exam: e, result: r } = examResult!;
  panel.innerHTML = `<h2>${esc(e.title)}: results</h2>
  <p><span class="big-score ${r.passed ? "pass" : "fail"}">${r.percent}%</span> <strong>${r.passed ? "Pass" : "Not passed"}</strong> <span class="meta">pass at ${e.passPercent}% · time used ${fmtClock(r.usedMs)}</span></p>
  <table class="score-table">${r.tasks
    .map(
      (t) => `<tr><td>${t.task.n}.</td><td><strong>${esc(t.task.title)}</strong> <span class="meta">${esc(t.task.domain)}</span>
      ${t.checks.filter((c) => !c.passed).map((c) => `<div class="fail">✘ ${esc(c.name)}${c.detail ? ` (${esc(c.detail)})` : ""}</div>`).join("")}
      <details><summary class="meta">Solution</summary><pre>${esc(t.task.solution.join("\n"))}</pre></details></td>
      <td class="num">${t.score.toFixed(1)} / ${t.task.weight}</td></tr>`,
    )
    .join("")}</table>
  <div class="actions"><button class="btn primary" id="exam-again">Try again</button><button class="btn" id="exam-labs">Back to the labs</button></div>`;
  panel.querySelector("#exam-again")?.addEventListener("click", () => {
    view = "exam-intro";
    renderPanel();
  });
  panel.querySelector("#exam-labs")?.addEventListener("click", () => {
    view = "labs";
    renderPanel();
  });
}

function registerCommands(): void {
  const needLab = (out: IO): boolean => {
    if (lab) return true;
    out.stderr("You are in the free sandbox. Start a lab first, e.g. lab 1. Type labs to see them all.\n");
    return false;
  };
  shell.registerCommand("labs", () => {
    view = "labs";
    renderPanel();
    labs.forEach((l, i) => print(`  ${done.has(l.id) ? C.green("✔") : " "} ${String(i + 1).padStart(2)}  ${l.title}`));
    print(C.dim("Start one with lab <number>, or click it in the panel."));
    return 0;
  });
  shell.registerCommand("lab", async (args, out) => {
    const arg = args[0];
    const found = arg ? (/^\d+$/.test(arg) ? labs.find((l) => parseInt(l.id, 10) === parseInt(arg, 10)) : labs.find((l) => l.id.includes(arg))) : lab;
    if (!found) {
      out.stderr(`No lab matches "${arg ?? ""}". Type labs to see them.\n`);
      return 1;
    }
    if (found === lab && !arg) {
      view = "lab";
      renderPanel();
      return 0;
    }
    await startLab(found);
    return 0;
  });
  shell.registerCommand("check", async (_a, out) => {
    if (!needLab(out)) return 1;
    await runCheck(false);
    return lastResults?.every((r) => r.passed) ? 0 : 1;
  });
  shell.registerCommand("hint", (_a, out) => {
    if (!needLab(out)) return 1;
    showHint(false);
    return 0;
  });
  shell.registerCommand("solution", (_a, out) => {
    if (!needLab(out)) return 1;
    showSolution(false);
    return 0;
  });
  shell.registerCommand("task", (_a, out) => {
    if (!needLab(out)) return 1;
    lab!.tasks.forEach((t, i) => print(`  ${i + 1}. ${termMd(t)}`));
    return 0;
  });
  shell.registerCommand("reset", async () => {
    if (lab) await startLab(lab, false);
    else startSandbox(false);
    print("Reset to a fresh cluster.");
    return 0;
  });
  shell.registerCommand("next", async (_a, out) => {
    const n = nextLab();
    if (!n) {
      out.stderr("There is no next lab.\n");
      return 1;
    }
    await startLab(n);
    return 0;
  });
  shell.registerCommand("sandbox", () => {
    startSandbox(false);
    print("Free sandbox on a fresh cluster.");
    return 0;
  });
  shell.registerCommand("help", () => {
    print(`${C.bold("PodSim help")}
  kubectl ... (or k ...)   run kubectl against the simulated cluster
  labs / lab <n>           list labs / start lab n
  task, check, hint        show tasks, check your work, get a hint
  solution, reset, next    show a solution, restart the lab, next lab
  sandbox                  free practice cluster
Shell: pipes (| grep, awk, wc, head, base64 -d), > and >> redirects,
heredocs (cat <<EOF > file.yaml), export VAR=value, cat, ls, rm.
Edit files in the Files panel, or with: vi file.yaml`);
    return 0;
  });
}

// ---------------------------------------------------------------- panel

function setNav(): void {
  for (const id of ["labs", "sandbox", "files", "exam"]) {
    document.getElementById(`nav-${id}`)!.classList.toggle("active", view === id || (id === "labs" && view === "lab") || (id === "exam" && view.startsWith("exam")));
  }
}

function renderPanel(): void {
  setNav();
  if (view === "files") return renderFiles();
  if (view === "exam" && exam) return renderExam();
  if (view === "exam-result" && examResult) return renderExamResult();
  if (view === "exam-intro" || view === "exam") return renderExamIntro();
  if (view === "lab" && lab) return renderLab();
  if (view === "sandbox") return renderSandbox();
  return renderLabList();
}

function renderLabList(): void {
  let html = `<h2>Kubernetes labs</h2>
  <p class="meta">Short, guided exercises on a simulated cluster. Each lab checks your work automatically. Your progress is saved in this browser.</p>`;
  let level = "";
  for (const l of labs) {
    const group = l.id.startsWith("ckad-") ? `CKAD · ${l.topic}` : l.level;
    if (group !== level) {
      if (level) html += "</ul>";
      level = group;
      html += `<h3>${esc(level)}</h3><ul class="lab-list">`;
    }
    html += `<li data-lab="${esc(l.id)}"><span class="${done.has(l.id) ? "done" : ""}">${esc(l.title)}</span><span class="meta">${l.minutes} min</span></li>`;
  }
  html += "</ul>";
  if (exams.length) html += `<h3>Mock exam</h3><p>Ready for a full run? ${exams.map((e) => `<button class="btn" data-exam="${esc(e.id)}">${esc(e.title)}</button>`).join(" ")} <span class="meta">${exams[0].tasks.length} tasks, ${exams[0].minutes} minutes, scored automatically.</span></p>`;
  html += `<h3>Free practice</h3><p>Prefer to explore? <button class="btn" id="go-sandbox">Open the sandbox</button></p>`;
  panel.innerHTML = html;
  panel.querySelectorAll<HTMLLIElement>("li[data-lab]").forEach((li) =>
    li.addEventListener("click", () => {
      const l = labs.find((x) => x.id === li.dataset.lab);
      if (l) {
        term.write("\r\x1b[K");
        void startLab(l);
      }
    }),
  );
  panel.querySelectorAll<HTMLButtonElement>("button[data-exam]").forEach((b) =>
    b.addEventListener("click", () => {
      examPick = exams.find((e) => e.id === b.dataset.exam);
      view = exam ? "exam" : "exam-intro";
      renderPanel();
    }),
  );
  panel.querySelector("#go-sandbox")?.addEventListener("click", () => {
    term.write("\r\x1b[K");
    startSandbox();
  });
}

function renderLab(): void {
  const l = lab!;
  const complete = lastResults?.length && lastResults.every((r) => r.passed);
  let html = `<p class="meta">${esc(l.level)} · about ${l.minutes} min · ${esc(l.topic)}${done.has(l.id) ? " · completed" : ""}</p>
  <h2>${esc(l.title)}</h2>
  <div class="intro">${md(l.intro)}</div>
  <h3>Tasks</h3><ol class="tasks">${l.tasks.map((t) => `<li>${md(t)}</li>`).join("")}</ol>
  <div class="actions">
    <button class="btn primary" id="act-check">Check my work</button>
    <button class="btn" id="act-hint">Hint</button>
    <button class="btn" id="act-solution">Solution</button>
    <button class="btn" id="act-reset">Reset lab</button>
    ${complete && nextLab() ? `<button class="btn primary" id="act-next">Next lab</button>` : ""}
  </div>`;
  if (lastResults) {
    html += `<ul class="results">${lastResults.map((r) => `<li class="${r.passed ? "ok" : "bad"}">${esc(r.name)}${!r.passed && r.detail ? `<span class="detail">${esc(r.detail)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  if (notice) html += `<div class="notice ${notice.success ? "success" : ""}">${md(notice.text)}</div>`;
  html += `<p class="meta" style="margin-top:20px"><button class="link" id="act-back">← All labs</button></p>`;
  panel.innerHTML = html;
  const on = (id: string, fn: () => void) => panel.querySelector(`#${id}`)?.addEventListener("click", fn);
  on("act-check", () => void runCheck(true));
  on("act-hint", () => showHint(true));
  on("act-solution", () => showSolution(true));
  on("act-reset", () => {
    term.write("\r\x1b[K");
    void startLab(l, false).then(() => undefined);
  });
  on("act-next", () => {
    const n = nextLab();
    if (n) {
      term.write("\r\x1b[K");
      void startLab(n);
    }
  });
  on("act-back", () => {
    view = "labs";
    renderPanel();
  });
}

function renderSandbox(): void {
  panel.innerHTML = `<h2>Free sandbox</h2>
  <p>A fresh simulated cluster with one control plane node and two workers (Kubernetes ${esc(K8S_VERSION)}). Nothing real runs: the simulator models how Kubernetes objects behave, including scheduling, rollouts, crash loops and image pull errors.</p>
  <h3>Things to try</h3>
  <ul>
    <li><code>kubectl get nodes -o wide</code></li>
    <li><code>kubectl create deployment web --image=nginx --replicas=3</code></li>
    <li><code>kubectl expose deployment web --port=80</code></li>
    <li><code>kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- http://web</code></li>
    <li><code>kubectl set image deployment/web nginx=nginx:1.27</code> then <code>kubectl rollout status deployment/web</code></li>
    <li><code>kubectl run broken --image=ngnix</code> then <code>kubectl describe pod broken</code></li>
  </ul>
  <p class="meta">Type <code>reset</code> for a fresh cluster or <code>labs</code> for guided exercises.</p>`;
}

function renderFiles(): void {
  const fs = activeFs() ?? new MemoryFS();
  const files = fs.list("").filter((f) => f !== ".keep");
  let html = `<h2>Files</h2><p class="meta">Files in the simulator's work folder. Use them with <code>kubectl apply -f NAME</code>.</p>`;
  html += files.length ? `<ul class="files-list">${files.map((f) => `<li data-file="${esc(f)}">${esc(f)}</li>`).join("")}</ul>` : `<p class="meta">No files yet. Create one below, or in the terminal with <code>kubectl run web --image=nginx --dry-run=client -o yaml &gt; pod.yaml</code>.</p>`;
  const content = editingFile && fs.exists(editingFile) ? fs.readFile(editingFile) : "";
  html += `<h3>${editingFile ? "Edit" : "New file"}</h3>
    <input class="filename" id="file-name" placeholder="pod.yaml" value="${esc(editingFile ?? "")}" />
    <textarea class="editor" id="file-body" spellcheck="false">${esc(content)}</textarea>
    <div class="actions"><button class="btn primary" id="file-save">Save</button>${editingFile ? `<button class="btn" id="file-new">New file</button>` : ""}${lab || exam ? `<button class="btn" id="file-back">Back to the ${exam ? "exam" : "lab"}</button>` : ""}</div>`;
  panel.innerHTML = html;
  panel.querySelectorAll<HTMLLIElement>("li[data-file]").forEach((li) =>
    li.addEventListener("click", () => {
      editingFile = li.dataset.file;
      renderFiles();
    }),
  );
  const body = panel.querySelector<HTMLTextAreaElement>("#file-body")!;
  body.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = body.selectionStart;
      body.value = body.value.slice(0, s) + "  " + body.value.slice(body.selectionEnd);
      body.selectionStart = body.selectionEnd = s + 2;
    }
  });
  panel.querySelector("#file-save")?.addEventListener("click", () => {
    const name = (panel.querySelector<HTMLInputElement>("#file-name")!.value || "").trim();
    if (!name) return;
    fs.writeFile(name, body.value.endsWith("\n") ? body.value : body.value + "\n");
    editingFile = name;
    renderFiles();
    term.write("\r\x1b[K" + C.dim(`Saved ${name}.`) + "\n");
    editor.showPrompt();
  });
  panel.querySelector("#file-new")?.addEventListener("click", () => {
    editingFile = undefined;
    renderFiles();
  });
  panel.querySelector("#file-back")?.addEventListener("click", () => {
    view = exam ? "exam" : "lab";
    renderPanel();
  });
}

document.getElementById("nav-labs")!.addEventListener("click", () => {
  if (exam) {
    view = "exam";
    renderPanel();
    return;
  }
  view = lab ? "lab" : "labs";
  if (view === "lab" && document.getElementById("nav-labs")!.classList.contains("active")) view = "labs";
  renderPanel();
});
document.getElementById("nav-sandbox")!.addEventListener("click", () => {
  if (exam) {
    view = "exam";
    renderPanel();
    print(C.yellow("The exam is still running. End it in the panel (End exam and score) before opening the sandbox."));
    editor.showPrompt();
    return;
  }
  term.write("\r\x1b[K");
  startSandbox();
});
document.getElementById("nav-exam")!.addEventListener("click", () => {
  view = exam ? "exam" : examResult && view !== "exam-result" ? "exam-result" : "exam-intro";
  renderPanel();
});
document.getElementById("nav-files")!.addEventListener("click", () => {
  view = "files";
  renderPanel();
});

// ---------------------------------------------------------------- start

startSandbox(false);
view = "labs";
renderPanel();
print(C.bold("PodSim") + C.dim("  Kubernetes training simulator. Nothing here runs real containers."));
print(C.dim(`Simulated cluster: controlplane, node01, node02 (Kubernetes ${K8S_VERSION})`));
print("");
print(`Pick a lab on the left, type ${C.cyan("lab 1")}, or just use ${C.cyan("kubectl")}. Type ${C.cyan("help")} for commands.`);
print("");
editor.showPrompt();
term.focus();
