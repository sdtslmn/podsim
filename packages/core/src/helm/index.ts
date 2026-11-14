// A simulated Helm 3 client: repositories, install, upgrade, rollback,
// uninstall, list, history, get, show, template, pull and create. Releases
// are tracked like real Helm (one Secret per revision) and their objects go
// through the simulated API server like anything else.

import { parse as parseYaml, parseAllDocuments, stringify } from "yaml";
import type { Cluster } from "../cluster.js";
import { toBase64 } from "../cluster.js";
import type { FileSystem } from "../fs.js";
import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { kindInfo, resolveKind } from "../kinds.js";
import { deepClone, isoTime } from "../util.js";
import { REPOS, scaffold, type ChartFiles } from "./charts.js";
import { collectDefines, renderString, TemplateError } from "./template.js";

export const HELM_VERSION = "v3.19.0";

interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface Chart {
  name: string;
  version: string;
  appVersion: string;
  description: string;
  files: ChartFiles;
}

interface Revision {
  revision: number;
  chart: Chart;
  userValues: Record<string, unknown>;
  values: Record<string, unknown>;
  manifest: string;
  notes: string;
  status: "deployed" | "superseded" | "failed" | "uninstalled" | "pending-install";
  updated: number;
  description: string;
}

interface Release {
  name: string;
  namespace: string;
  revisions: Revision[];
}

interface HelmState {
  repos: Map<string, string>;
  releases: Map<string, Release>;
}

function state(cluster: Cluster): HelmState {
  let s = cluster.scratch.get("helm") as HelmState | undefined;
  if (!s) {
    s = { repos: new Map(), releases: new Map() };
    cluster.scratch.set("helm", s);
  }
  return s;
}

// ------------------------------------------------------------------ args

interface Args {
  pos: string[];
  flags: Map<string, string[]>;
}

const BOOL = new Set(["create-namespace", "dry-run", "all", "all-namespaces", "A", "a", "untar", "install", "reuse-values", "reset-values", "generate-name", "keep-history", "wait", "atomic", "debug", "short", "versions", "devel", "force", "help", "h", "no-hooks", "deployed", "failed", "pending", "uninstalled", "superseded", "q", "date", "r", "reverse"]);

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) add(k, a.slice(eq + 1));
      else if (BOOL.has(k)) add(k, "true");
      else add(k, argv[++i] ?? "");
    } else if (a.startsWith("-") && a.length > 1) {
      const k = a.slice(1);
      const map: Record<string, string> = { n: "namespace", f: "values", o: "output", A: "all-namespaces", a: "all", q: "short" };
      const name = map[k] ?? k;
      if (BOOL.has(k) || BOOL.has(name)) add(name, "true");
      else add(name, argv[++i] ?? "");
    } else pos.push(a);
  }
  return { pos, flags };
}

const one = (a: Args, k: string) => a.flags.get(k)?.slice(-1)[0];
const has = (a: Args, k: string) => a.flags.get(k)?.some((v) => v !== "false") ?? false;

// ------------------------------------------------------------------ values

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = deepClone(base ?? {});
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = deepClone(v);
  }
  return out;
}

function typed(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v) && v.length < 16) return parseInt(v, 10);
  return v;
}

/** --set a.b=c,d[0]=e */
export function parseSet(expr: string, asString = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "\\" && expr[i + 1] === ",") {
      cur += ",";
      i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) throw new KubeError(`Error: failed parsing --set data: key "${p}" has no value`);
    const key = p.slice(0, eq);
    const raw = p.slice(eq + 1);
    const value = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1).split(",").map((x) => (asString ? x : typed(x))) : asString ? raw : typed(raw);
    const path = key.split(".").flatMap((seg) => {
      const m = seg.match(/^([^[]+)((\[\d+\])*)$/);
      if (!m) return [seg];
      return [m[1], ...[...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))];
    });
    let node: Record<string, unknown> | unknown[] = out;
    path.forEach((seg, i) => {
      const last = i === path.length - 1;
      const nextIsIndex = typeof path[i + 1] === "number";
      const container = node as Record<string | number, unknown>;
      if (last) container[seg as string] = value;
      else {
        if (container[seg as string] === undefined) container[seg as string] = nextIsIndex ? [] : {};
        node = container[seg as string] as Record<string, unknown>;
      }
    });
  }
  return out;
}

function userValues(fs: FileSystem, a: Args): Record<string, unknown> {
  let v: Record<string, unknown> = {};
  for (const f of a.flags.get("values") ?? []) {
    if (!fs.exists(f)) throw new KubeError(`Error: open ${f}: no such file or directory`);
    v = deepMerge(v, (parseYaml(fs.readFile(f)) as Record<string, unknown>) ?? {});
  }
  for (const s of a.flags.get("set") ?? []) v = deepMerge(v, parseSet(s));
  for (const s of a.flags.get("set-string") ?? []) v = deepMerge(v, parseSet(s, true));
  return v;
}

// ------------------------------------------------------------------ charts

function chartFromFiles(files: ChartFiles, where: string): Chart {
  if (!files["Chart.yaml"]) throw new KubeError(`Error: INSTALLATION FAILED: Chart.yaml file is missing`);
  const meta = (parseYaml(files["Chart.yaml"]) as Record<string, string>) ?? {};
  if (!meta.name) throw new KubeError(`Error: validation: chart.metadata.name is required (${where})`);
  return { name: meta.name, version: String(meta.version ?? "0.1.0"), appVersion: String(meta.appVersion ?? ""), description: meta.description ?? "", files };
}

function readDir(fs: FileSystem, dir: string, prefix = ""): ChartFiles {
  const out: ChartFiles = {};
  for (const name of fs.list(dir)) {
    if (name === ".keep") continue;
    const p = `${dir}/${name}`;
    if (fs.isDirectory(p)) Object.assign(out, readDir(fs, p, `${prefix}${name}/`));
    else if (fs.exists(p)) out[`${prefix}${name}`] = fs.readFile(p);
  }
  return out;
}

function resolveChart(cluster: Cluster, fs: FileSystem, ref: string, version?: string): Chart {
  if (ref.startsWith("./") || ref.startsWith("/") || ref.startsWith("../") || (fs.exists(ref) && !ref.includes("/")) || fs.isDirectory(ref)) {
    const tgz = ref.match(/([a-z0-9-]+)-(\d+\.\d+\.\d+)\.tgz$/);
    if (tgz && fs.exists(ref)) {
      const c = Object.values(REPOS).flatMap((r) => r.charts).find((x) => x.name === tgz[1] && x.version === tgz[2]);
      if (c) return { ...c };
    }
    if (!fs.isDirectory(ref) && !fs.exists(`${ref}/Chart.yaml`)) throw new KubeError(`Error: INSTALLATION FAILED: path "${ref}" not found`);
    return chartFromFiles(readDir(fs, ref.replace(/\/$/, "")), ref);
  }
  const st = state(cluster);
  let repoName: string;
  let chartName: string;
  if (ref.startsWith("oci://")) {
    const idx = ref.lastIndexOf("/");
    const url = ref.slice(0, idx);
    chartName = ref.slice(idx + 1);
    const repo = REPOS[url];
    const c = repo?.charts.find((x) => x.name === chartName);
    if (!c) throw new KubeError(`Error: INSTALLATION FAILED: ${ref}:latest: not found`);
    return { ...c };
  }
  if (!ref.includes("/")) throw new KubeError(`Error: INSTALLATION FAILED: repo ${ref} not found`);
  [repoName, chartName] = ref.split("/");
  const url = st.repos.get(repoName);
  if (!url) throw new KubeError(`Error: INSTALLATION FAILED: repo ${repoName} not found`);
  const repo = REPOS[url];
  const c = repo?.charts.find((x) => x.name === chartName && (!version || x.version === version));
  if (!c) throw new KubeError(version ? `Error: INSTALLATION FAILED: chart "${chartName}" matching ${version} not found in ${repoName} index. (try 'helm repo update'): no chart version found for ${chartName}-${version}` : `Error: INSTALLATION FAILED: chart "${chartName}" not found in ${repoName} index. (try 'helm repo update'): no chart name found`);
  return { ...c };
}

function chartValues(chart: Chart): Record<string, unknown> {
  return (parseYaml(chart.files["values.yaml"] ?? "") as Record<string, unknown>) ?? {};
}

/** Render a chart into manifests (with # Source headers) and notes. */
function renderChart(chart: Chart, release: string, namespace: string, values: Record<string, unknown>, revision: number, isUpgrade: boolean): { manifest: string; notes: string } {
  const templates = Object.entries(chart.files).filter(([p]) => p.startsWith("templates/"));
  const defines = collectDefines(templates.filter(([p]) => p.endsWith(".tpl")).map(([, s]) => s).concat(templates.map(([, s]) => s)));
  const root = {
    Values: values,
    Release: { Name: release, Namespace: namespace, Service: "Helm", Revision: revision, IsInstall: !isUpgrade, IsUpgrade: isUpgrade },
    Chart: { Name: chart.name, Version: chart.version, AppVersion: chart.appVersion, Description: chart.description },
    Capabilities: { KubeVersion: { Version: "v1.34.1", Major: "1", Minor: "34" }, APIVersions: { Has: () => true } },
    Template: { BasePath: `${chart.name}/templates` },
  };
  let manifest = "";
  let notes = "";
  for (const [path, src] of templates.sort(([a], [b]) => a.localeCompare(b))) {
    if (path.endsWith(".tpl") || path.split("/").pop()!.startsWith("_")) continue;
    let out: string;
    try {
      out = renderString(src, { ...root, Template: { ...root.Template, Name: `${chart.name}/${path}` } }, defines);
    } catch (e) {
      if (e instanceof TemplateError) throw new KubeError(`Error: INSTALLATION FAILED: template: ${chart.name}/${path}: ${e.message}`);
      throw e;
    }
    if (path.endsWith("NOTES.txt")) {
      notes = out;
      continue;
    }
    for (const doc of out.split(/^---\s*$/m)) {
      if (!doc.trim() || !doc.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) continue;
      manifest += `---\n# Source: ${chart.name}/${path}\n${doc.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
    }
  }
  return { manifest, notes };
}

function objectsOf(manifest: string, namespace: string): KObject[] {
  const out: KObject[] = [];
  for (const d of parseAllDocuments(manifest)) {
    if (d.errors.length) throw new KubeError(`Error: INSTALLATION FAILED: YAML parse error: ${d.errors[0].message}`);
    const o = d.toJSON() as KObject | null;
    if (!o || typeof o !== "object") continue;
    o.metadata = o.metadata ?? ({} as KObject["metadata"]);
    const info = resolveKind(o.kind);
    if (!info) throw new KubeError(`Error: INSTALLATION FAILED: unable to build kubernetes objects from release manifest: resource mapping not found for name: "${o.metadata.name}" namespace: "" from "": no matches for kind "${o.kind}" in version "${o.apiVersion}"`);
    if (info.namespaced) o.metadata.namespace = o.metadata.namespace ?? namespace;
    out.push(o);
  }
  return out;
}

function stamp(o: KObject, release: string, ns: string): KObject {
  const c = deepClone(o);
  c.metadata.labels = { ...(c.metadata.labels ?? {}), "app.kubernetes.io/managed-by": "Helm" };
  c.metadata.annotations = { ...(c.metadata.annotations ?? {}), "meta.helm.sh/release-name": release, "meta.helm.sh/release-namespace": ns };
  return c;
}

const keyOf = (o: KObject) => `${o.kind}/${o.metadata.namespace ?? ""}/${o.metadata.name}`;

/** Make the cluster match a manifest: create new objects, update changed ones, delete removed ones. */
function applyRelease(cluster: Cluster, release: string, ns: string, manifest: string, previous: string | undefined, verb: string): void {
  const want = objectsOf(manifest, ns).map((o) => stamp(o, release, ns));
  const before = previous ? objectsOf(previous, ns) : [];
  for (const o of want) {
    const existing = cluster.get(o.kind, o.metadata.name, o.metadata.namespace);
    if (existing && existing.metadata.annotations?.["meta.helm.sh/release-name"] !== release) {
      throw new KubeError(
        `Error: ${verb} FAILED: Unable to continue with ${verb === "INSTALLATION" ? "install" : "update"}: ${o.kind} "${o.metadata.name}" in namespace "${o.metadata.namespace ?? ""}" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "${release}"; annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "${ns}"`,
      );
    }
  }
  for (const o of want) {
    const existing = cluster.get(o.kind, o.metadata.name, o.metadata.namespace);
    try {
      if (existing) {
        const merged = deepClone(o);
        merged.metadata = { ...existing.metadata, labels: o.metadata.labels, annotations: o.metadata.annotations };
        if (existing.status) merged.status = existing.status;
        cluster.replace(merged);
      } else cluster.create(o);
    } catch (e) {
      if (e instanceof KubeError) throw new KubeError(`Error: ${verb} FAILED: ${e.message.replace(/^Error from server \([A-Za-z]+\): /, "")}`);
      throw e;
    }
  }
  const wanted = new Set(want.map(keyOf));
  for (const o of before) {
    if (wanted.has(keyOf(o))) continue;
    if (cluster.get(o.kind, o.metadata.name, o.metadata.namespace)) cluster.remove(o.kind, o.metadata.name, o.metadata.namespace);
  }
}

function releaseSecret(cluster: Cluster, rel: Release, rev: Revision): void {
  const name = `sh.helm.release.v1.${rel.name}.v${rev.revision}`;
  const obj: KObject = {
    apiVersion: "v1",
    kind: "Secret",
    type: "helm.sh/release.v1",
    metadata: { name, namespace: rel.namespace, labels: { name: rel.name, owner: "helm", status: rev.status, version: String(rev.revision) } },
    data: { release: toBase64(`H4sIAAAAAAAC/simulated-release-${rel.name}-${rev.revision}`) },
  };
  if (cluster.get("Secret", name, rel.namespace)) {
    const ex = cluster.get("Secret", name, rel.namespace)!;
    cluster.replace({ ...ex, metadata: { ...ex.metadata, labels: obj.metadata.labels } });
  } else cluster.create(obj);
}

function fmtTime(ms: number, long = true): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  if (!long) return d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}${"000000".slice(0, 6)} +0000 UTC`;
}

function tabTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]) + "\t")).join("");
  return [line(headers), ...rows.map(line)].join("\n") + "\n";
}

function statusText(rel: Release, rev: Revision, showNotes = true): string {
  return [
    `NAME: ${rel.name}`,
    `LAST DEPLOYED: ${fmtTime(rev.updated, false)}`,
    `NAMESPACE: ${rel.namespace}`,
    `STATUS: ${rev.status}`,
    `REVISION: ${rev.revision}`,
    `TEST SUITE: None`,
    ...(showNotes && rev.notes ? ["NOTES:", rev.notes.replace(/\n+$/, "")] : []),
  ].join("\n") + "\n";
}

// ------------------------------------------------------------------ commands

export async function helm(cluster: Cluster, fs: FileSystem, currentNs: string, argv: string[], io: IO): Promise<number> {
  cluster.activate();
  try {
    return run(cluster, fs, currentNs, argv, io);
  } catch (e) {
    if (e instanceof KubeError) {
      io.stderr(e.message.endsWith("\n") ? e.message : e.message + "\n");
      return 1;
    }
    throw e;
  }
}

function run(cluster: Cluster, fs: FileSystem, currentNs: string, argv: string[], io: IO): number {
  const a = parseArgs(argv);
  const [cmd, ...pos] = a.pos;
  const ns = one(a, "namespace") ?? currentNs;
  const st = state(cluster);
  const out = (s: string) => io.stdout(s.endsWith("\n") ? s : s + "\n");
  cluster.advance();
  switch (cmd) {
    case undefined:
    case "help":
      out("The Kubernetes package manager (simulated)\n\nUsage:\n  helm [command]\n\nAvailable Commands:\n  create, get, history, install, lint, list, pull, repo, rollback, search, show, status, template, uninstall, upgrade, version");
      return 0;
    case "version":
      out(has(a, "short") ? `${HELM_VERSION}+g3d8990f` : `version.BuildInfo{Version:"${HELM_VERSION}", GitCommit:"3d8990f0836691f0229297773f3524598f46bda6", GitTreeState:"clean", GoVersion:"go1.24.7"}`);
      return 0;
    case "env":
      out(`HELM_NAMESPACE="${ns}"\nHELM_REPOSITORY_CONFIG="/root/.config/helm/repositories.yaml"\nHELM_CACHE_HOME="/root/.cache/helm"`);
      return 0;
    case "repo": {
      const [sub, name, url] = pos;
      if (sub === "add") {
        if (!name || !url) throw new KubeError(`Error: "helm repo add" requires 2 arguments`);
        if (!REPOS[url.replace(/\/$/, "")]) throw new KubeError(`Error: looks like "${url}" is not a valid chart repository or cannot be reached: failed to fetch ${url.replace(/\/$/, "")}/index.yaml : 404 Not Found`);
        if (st.repos.get(name) === url.replace(/\/$/, "")) {
          out(`"${name}" already exists with the same configuration, skipping`);
          return 0;
        }
        st.repos.set(name, url.replace(/\/$/, ""));
        out(`"${name}" has been added to your repositories`);
        return 0;
      }
      if (sub === "list" || sub === "ls") {
        if (!st.repos.size) throw new KubeError("Error: no repositories to show");
        out(tabTable(["NAME", "URL"], [...st.repos.entries()].map(([n, u]) => [n, u])).trimEnd());
        return 0;
      }
      if (sub === "update" || sub === "up") {
        if (!st.repos.size) throw new KubeError("Error: no repositories found. You must add one before updating");
        out(`Hang tight while we grab the latest from your chart repositories...\n${[...st.repos.keys()].map((n) => `...Successfully got an update from the "${n}" chart repository`).join("\n")}\nUpdate Complete. ⎈Happy Helming!⎈`);
        return 0;
      }
      if (sub === "remove" || sub === "rm") {
        if (!name || !st.repos.has(name)) throw new KubeError(`Error: no repo named "${name ?? ""}" found`);
        st.repos.delete(name);
        out(`"${name}" has been removed from your repositories`);
        return 0;
      }
      throw new KubeError(`Error: unknown command "${sub ?? ""}" for "helm repo"`);
    }
    case "search": {
      const [where, keyword = ""] = pos;
      if (where === "hub") {
        out("URL                                               \tCHART VERSION\tAPP VERSION\tDESCRIPTION\nhttps://artifacthub.io/packages/helm/bitnami/nginx\t22.1.1       \t1.29.3     \tNGINX Open Source is a web server...");
        return 0;
      }
      if (where !== "repo") throw new KubeError(`Error: unknown command "${where ?? ""}" for "helm search"`);
      if (!st.repos.size) throw new KubeError("Error: no repositories configured");
      const rows: string[][] = [];
      for (const [n, u] of st.repos) for (const c of REPOS[u]?.charts ?? []) if (`${n}/${c.name}`.includes(keyword.toLowerCase()) || c.description.toLowerCase().includes(keyword.toLowerCase())) rows.push([`${n}/${c.name}`, c.version, c.appVersion, c.description]);
      if (!rows.length) {
        out("No results found");
        return 0;
      }
      out(tabTable(["NAME", "CHART VERSION", "APP VERSION", "DESCRIPTION"], rows).trimEnd());
      return 0;
    }
    case "show":
    case "inspect": {
      const [what, ref] = pos;
      const chart = resolveChart(cluster, fs, ref ?? "", one(a, "version"));
      if (what === "values") out(chart.files["values.yaml"] ?? "");
      else if (what === "chart") out(chart.files["Chart.yaml"]);
      else if (what === "readme") out(`# ${chart.name}\n\n${chart.description}`);
      else if (what === "all") out(`${chart.files["Chart.yaml"]}---\n${chart.files["values.yaml"] ?? ""}`);
      else throw new KubeError(`Error: unknown command "${what ?? ""}" for "helm show"`);
      return 0;
    }
    case "pull":
    case "fetch": {
      const ref = pos[0];
      if (!ref) throw new KubeError(`Error: "helm pull" requires at least 1 argument`);
      const chart = resolveChart(cluster, fs, ref, one(a, "version"));
      if (has(a, "untar")) {
        const dir = `${one(a, "untardir") ?? "."}/${chart.name}`.replace(/^\.\//, "");
        for (const [p, c] of Object.entries(chart.files)) fs.writeFile(`${dir}/${p}`, c);
      } else fs.writeFile(`${chart.name}-${chart.version}.tgz`, `(podsim) packaged chart ${chart.name}-${chart.version}\n`);
      return 0;
    }
    case "create": {
      const name = pos[0];
      if (!name) throw new KubeError(`Error: "helm create" requires 1 argument`);
      for (const [p, c] of Object.entries(scaffold(name.split("/").pop()!))) fs.writeFile(`${name}/${p}`, c);
      out(`Creating ${name}`);
      return 0;
    }
    case "lint": {
      const ref = pos[0] ?? ".";
      const chart = resolveChart(cluster, fs, ref.startsWith(".") || ref.startsWith("/") ? ref : `./${ref}`);
      renderChart(chart, "release-name", ns, chartValues(chart), 1, false);
      out(`==> Linting ${ref}\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed`);
      return 0;
    }
    case "template": {
      let [name, ref] = pos;
      if (!ref) {
        ref = name;
        name = "release-name";
      }
      const chart = resolveChart(cluster, fs, ref ?? "", one(a, "version"));
      const values = deepMerge(chartValues(chart), userValues(fs, a));
      out(renderChart(chart, name, ns, values, 1, false).manifest);
      return 0;
    }
    case "install":
    case "upgrade": {
      const isUpgrade = cmd === "upgrade";
      let [name, ref] = pos;
      if (cmd === "install" && has(a, "generate-name")) {
        ref = name;
        name = `${(ref ?? "chart").split("/").pop()!.replace(/-\d+\.\d+\.\d+\.tgz$/, "")}-${Math.floor(cluster.now() / 1000)}`;
      }
      if (!name || !ref) throw new KubeError(`Error: "helm ${cmd}" requires 2 arguments\n\nUsage:  helm ${cmd} [NAME] [CHART] [flags]`);
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 53) throw new KubeError(`Error: INSTALLATION FAILED: release name "${name}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53`);
      const key = `${ns}/${name}`;
      let rel = st.releases.get(key);
      const live = rel?.revisions.filter((r) => r.status !== "uninstalled");
      if (isUpgrade && !live?.length && !has(a, "install")) throw new KubeError(`Error: UPGRADE FAILED: "${name}" has no deployed releases`);
      const upgrading = isUpgrade && !!live?.length;
      if (!upgrading && live?.length) throw new KubeError(`Error: INSTALLATION FAILED: cannot re-use a name that is still in use`);
      if (!cluster.get("Namespace", ns)) {
        if (!has(a, "create-namespace")) throw new KubeError(`Error: INSTALLATION FAILED: create: failed to create: namespaces "${ns}" not found`);
        if (!has(a, "dry-run")) cluster.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } });
      }
      const chart = resolveChart(cluster, fs, ref, one(a, "version"));
      const prev = upgrading ? live![live!.length - 1] : undefined;
      let uv = userValues(fs, a);
      if (prev && has(a, "reuse-values")) uv = deepMerge(prev.userValues, uv);
      const values = deepMerge(chartValues(chart), uv);
      const revision = (rel?.revisions.reduce((m, r) => Math.max(m, r.revision), 0) ?? 0) + 1;
      const verb = upgrading ? "UPGRADE" : "INSTALLATION";
      let rendered;
      try {
        rendered = renderChart(chart, name, ns, values, revision, upgrading);
      } catch (e) {
        if (e instanceof KubeError) throw new KubeError(e.message.replace("INSTALLATION FAILED", `${verb} FAILED`));
        throw e;
      }
      const rev: Revision = { revision, chart, userValues: uv, values, manifest: rendered.manifest, notes: rendered.notes, status: "deployed", updated: cluster.now(), description: upgrading ? "Upgrade complete" : "Install complete" };
      if (has(a, "dry-run")) {
        out(statusText({ name, namespace: ns, revisions: [] }, { ...rev, status: "pending-install" }, false) + `HOOKS:\nMANIFEST:\n${rendered.manifest}\nNOTES:\n${rendered.notes}`);
        return 0;
      }
      applyRelease(cluster, name, ns, rendered.manifest, prev?.manifest, verb);
      if (!rel) {
        rel = { name, namespace: ns, revisions: [] };
        st.releases.set(key, rel);
      }
      if (prev) {
        prev.status = "superseded";
        releaseSecret(cluster, rel, prev);
      }
      rel.revisions.push(rev);
      releaseSecret(cluster, rel, rev);
      cluster.advance();
      if (upgrading) out(`Release "${name}" has been upgraded. Happy Helming!`);
      out(statusText(rel, rev));
      return 0;
    }
    case "list":
    case "ls": {
      const all = has(a, "all-namespaces");
      const statuses = has(a, "all") ? null : ["deployed", "failed", "pending-install"];
      const rows: string[][] = [];
      for (const rel of [...st.releases.values()].sort((x, y) => x.name.localeCompare(y.name))) {
        if (!all && rel.namespace !== ns) continue;
        const cur = rel.revisions[rel.revisions.length - 1];
        if (!cur || (statuses && !statuses.includes(cur.status))) continue;
        rows.push([rel.name, rel.namespace, String(cur.revision), fmtTime(cur.updated), cur.status, `${cur.chart.name}-${cur.chart.version}`, cur.chart.appVersion]);
      }
      if (has(a, "short")) {
        if (rows.length) out(rows.map((r) => r[0]).join("\n"));
        return 0;
      }
      out(tabTable(["NAME", "NAMESPACE", "REVISION", "UPDATED", "STATUS", "CHART", "APP VERSION"], rows).trimEnd());
      return 0;
    }
    case "status": {
      const rel = st.releases.get(`${ns}/${pos[0]}`);
      if (!rel) throw new KubeError("Error: release: not found");
      out(statusText(rel, rel.revisions[rel.revisions.length - 1]));
      return 0;
    }
    case "history":
    case "hist": {
      const rel = st.releases.get(`${ns}/${pos[0]}`);
      if (!rel) throw new KubeError("Error: release: not found");
      out(tabTable(["REVISION", "UPDATED", "STATUS", "CHART", "APP VERSION", "DESCRIPTION"], rel.revisions.map((r) => [String(r.revision), fmtTime(r.updated, false), r.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion, r.description])).trimEnd());
      return 0;
    }
    case "get": {
      const [what, name] = pos;
      const rel = st.releases.get(`${ns}/${name}`);
      if (!rel) throw new KubeError("Error: release: not found");
      const r = one(a, "revision") ? rel.revisions.find((x) => x.revision === Number(one(a, "revision"))) : rel.revisions[rel.revisions.length - 1];
      if (!r) throw new KubeError("Error: release: not found");
      if (what === "values") {
        const all = has(a, "all");
        const v = all ? r.values : r.userValues;
        if (one(a, "output") === "json") out(JSON.stringify(v));
        else out(`${all ? "COMPUTED VALUES" : "USER-SUPPLIED VALUES"}:\n${Object.keys(v).length ? stringify(v).trimEnd() : "null"}`);
      } else if (what === "manifest") out(r.manifest);
      else if (what === "notes") out(`NOTES:\n${r.notes}`);
      else if (what === "all") out(statusText(rel, r) + `USER-SUPPLIED VALUES:\n${stringify(r.userValues)}\nMANIFEST:\n${r.manifest}`);
      else throw new KubeError(`Error: unknown command "${what ?? ""}" for "helm get"`);
      return 0;
    }
    case "rollback": {
      const [name, revText] = pos;
      const rel = st.releases.get(`${ns}/${name}`);
      if (!rel) throw new KubeError("Error: release: not found");
      const cur = rel.revisions[rel.revisions.length - 1];
      const target = revText ? rel.revisions.find((r) => r.revision === Number(revText)) : rel.revisions[rel.revisions.length - 2];
      if (!target) throw new KubeError(revText ? `Error: release has no ${revText} version` : "Error: no revision to roll back to");
      applyRelease(cluster, name, ns, target.manifest, cur.manifest, "ROLLBACK");
      cur.status = "superseded";
      releaseSecret(cluster, rel, cur);
      const rev: Revision = { ...target, revision: cur.revision + 1, status: "deployed", updated: cluster.now(), description: `Rollback to ${target.revision}` };
      rel.revisions.push(rev);
      releaseSecret(cluster, rel, rev);
      out("Rollback was a success! Happy Helming!");
      return 0;
    }
    case "uninstall":
    case "delete":
    case "del":
    case "un": {
      let code = 0;
      for (const name of pos) {
        const key = `${ns}/${name}`;
        const rel = st.releases.get(key);
        const cur = rel?.revisions[rel.revisions.length - 1];
        if (!rel || !cur || cur.status === "uninstalled") {
          io.stderr(`Error: uninstall: Release not loaded: ${name}: release: not found\n`);
          code = 1;
          continue;
        }
        for (const o of objectsOf(cur.manifest, ns)) if (cluster.get(o.kind, o.metadata.name, o.metadata.namespace)) cluster.remove(o.kind, o.metadata.name, o.metadata.namespace);
        for (const r of rel.revisions) {
          const sname = `sh.helm.release.v1.${name}.v${r.revision}`;
          if (cluster.get("Secret", sname, ns)) cluster.remove("Secret", sname, ns);
        }
        if (has(a, "keep-history")) {
          cur.status = "uninstalled";
          releaseSecret(cluster, rel, cur);
        } else st.releases.delete(key);
        out(`release "${name}" uninstalled`);
      }
      cluster.advance();
      return code;
    }
    default:
      throw new KubeError(`Error: unknown command "${cmd}" for "helm"\nRun 'helm --help' for usage.`);
  }
}

void kindInfo;
void isoTime;
