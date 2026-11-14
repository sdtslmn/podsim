// docker and podman on the simulator host: build images from a Dockerfile,
// tag, save, load and push them, and run containers locally. Images pushed to
// a registry with a host name (localhost:5000, registry.example.com:5000)
// can then be used by pods.

import type { Cluster } from "./cluster.js";
import type { FileSystem } from "./fs.js";
import { KubeError } from "./types.js";
import { parseImage, imageKey, useRegistry, type BuiltImage } from "./images.js";
import { fnv1a } from "./util.js";
import { imageInfo } from "./podruntime.js";
import { Proc, execNow, normalizePath, DIR, DELETED, type Fs, type Host } from "./runtime.js";
import { splitWords } from "./kubectl/container.js";

interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface HostContainer {
  id: string;
  name: string;
  image: string;
  proc: Proc;
  created: number;
  ports: string;
  removed?: boolean;
}

interface State {
  local: Map<string, BuiltImage>;
  containers: Map<string, HostContainer>;
}

function st(cluster: Cluster): State {
  let s = cluster.scratch.get("containertool") as State | undefined;
  if (!s) {
    s = { local: new Map(), containers: new Map() };
    cluster.scratch.set("containertool", s);
  }
  return s;
}

/** Images in the simulated registries, shared with the kubelet. */
export function registry(cluster: Cluster): Map<string, BuiltImage> {
  let r = cluster.scratch.get("registry") as Map<string, BuiltImage> | undefined;
  if (!r) {
    r = new Map();
    cluster.scratch.set("registry", r);
    useRegistry(r);
  }
  return r;
}

function shortId(seed: string): string {
  let out = "";
  let h = fnv1a(seed);
  for (let i = 0; out.length < 64; i++) {
    h = fnv1a(`${h.toString(36)}:${i}:${seed.length}:${h ^ (i * 2654435761)}`);
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  return `${Math.floor(s / 3600)} hours ago`;
}

function parseDockerfile(text: string): { op: string; args: string; raw: string }[] {
  const out: { op: string; args: string; raw: string }[] = [];
  let buf = "";
  for (const line of text.split(/\r?\n/)) {
    if (!buf && (line.trim().startsWith("#") || !line.trim())) continue;
    if (line.endsWith("\\")) {
      buf += line.slice(0, -1) + " ";
      continue;
    }
    const full = (buf + line).trim();
    buf = "";
    const m = full.match(/^(\w+)\s+([\s\S]*)$/);
    if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim(), raw: full });
  }
  return out;
}

function execForm(args: string): string[] {
  if (args.startsWith("[")) {
    try {
      return JSON.parse(args);
    } catch {
      return ["/bin/sh", "-c", args];
    }
  }
  return ["/bin/sh", "-c", args];
}

function copyInto(fs: FileSystem, files: Record<string, string>, context: string, src: string, dest: string, workdir: string): string | undefined {
  const absDest = normalizePath(dest.startsWith("/") ? dest : `${workdir}/${dest}`);
  const full = `${context.replace(/\/$/, "")}/${src}`.replace(/^\.\//, "");
  if (src === "." || src === "./") {
    const walk = (dir: string, rel: string) => {
      for (const n of fs.list(dir)) {
        if (n === ".keep" || n === "Dockerfile") continue;
        const p = `${dir}/${n}`;
        if (fs.isDirectory(p)) walk(p, `${rel}/${n}`);
        else files[normalizePath(`${absDest}${rel}/${n}`)] = fs.readFile(p);
      }
    };
    walk(context.replace(/\/$/, "") || ".", "");
    return undefined;
  }
  if (!fs.exists(full)) return `COPY failed: file not found in build context or excluded by .dockerignore: stat ${src}: file does not exist`;
  if (fs.isDirectory(full)) {
    const walk = (dir: string, rel: string) => {
      for (const n of fs.list(dir)) {
        if (n === ".keep") continue;
        const p = `${dir}/${n}`;
        if (fs.isDirectory(p)) walk(p, `${rel}/${n}`);
        else files[normalizePath(`${absDest}${rel}/${n}`)] = fs.readFile(p);
      }
    };
    walk(full, "");
    return undefined;
  }
  const intoDir = dest.endsWith("/") || dest === "." || dest === ".." || Object.keys(files).some((k) => k.startsWith(absDest + "/"));
  const target = intoDir ? `${absDest}/${src.split("/").pop()}` : absDest;
  files[normalizePath(target)] = fs.readFile(full);
  return undefined;
}

function build(cluster: Cluster, fs: FileSystem, tool: "docker" | "podman", args: string[], io: IO): number {
  const tags: string[] = [];
  let file: string | undefined;
  const buildArgs: Record<string, string> = {};
  let context: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" || a === "--tag") tags.push(args[++i]);
    else if (a.startsWith("--tag=") || a.startsWith("-t=")) tags.push(a.split("=")[1]);
    else if (a === "-f" || a === "--file") file = args[++i];
    else if (a === "--build-arg") {
      const [k, v] = args[++i].split("=");
      buildArgs[k] = v ?? "";
    } else if (["--platform", "--format", "--target", "--network", "--layers"].includes(a)) i++;
    else if (!a.startsWith("-")) context = a;
  }
  if (!context) throw new KubeError(tool === "docker" ? 'ERROR: "docker buildx build" requires exactly 1 argument.' : "Error: no context directory and no Containerfile specified");
  if (!fs.exists(context) || !fs.isDirectory(context)) throw new KubeError(tool === "docker" ? `ERROR: unable to prepare context: path "${context}" not found` : `Error: context must be a directory: "${context}"`);
  const dockerfile = file ?? `${context.replace(/\/$/, "")}/${fs.exists(`${context}/Containerfile`) && tool === "podman" ? "Containerfile" : "Dockerfile"}`.replace(/^\.\//, "");
  if (!fs.exists(dockerfile)) throw new KubeError(tool === "docker" ? `ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory` : `Error: no Containerfile or Dockerfile specified or found in context directory, ${fs.cwd()}/${context}: no such file or directory`);
  const steps = parseDockerfile(fs.readFile(dockerfile));
  if (!steps.length || steps[0].op !== "FROM" && steps[0].op !== "ARG") throw new KubeError(`Error: no FROM statement found`);
  const img: BuiltImage = { base: "", files: {}, cmd: [], entrypoint: [], env: {}, workdir: "/", user: undefined, exposed: [], created: cluster.now(), id: "", size: 0 };
  const lines: string[] = [];
  const vars: Record<string, string> = { ...buildArgs };
  const expand = (s: string) => s.replace(/\$\{?(\w+)\}?/g, (m, k) => vars[k] ?? img.env[k] ?? m);
  let n = 0;
  for (const s of steps) {
    n++;
    const label = tool === "podman" ? `STEP ${n}/${steps.length}: ${s.raw}` : ` => [${n}/${steps.length}] ${s.raw}`;
    lines.push(label);
    const a = expand(s.args);
    switch (s.op) {
      case "ARG": {
        const [k, v] = a.split("=");
        if (vars[k] === undefined) vars[k] = v ?? "";
        break;
      }
      case "FROM": {
        const ref = a.split(/\s+/)[0];
        const local = st(cluster).local.get(imageKey(ref, tool)) ?? registry(cluster).get(imageKey(ref, tool));
        if (!local && !imageInfo(ref)) {
          io.stdout(lines.join("\n") + "\n");
          throw new KubeError(
            tool === "podman"
              ? `Error: creating build container: initializing source docker://${ref}: reading manifest ${parseImage(ref).tag} in docker.io/library/${parseImage(ref).repository}: requested access to the resource is denied`
              : `ERROR: failed to solve: ${ref}: failed to resolve source metadata for docker.io/library/${ref}: pull access denied, repository does not exist or may require authorization`,
          );
        }
        img.base = local ? local.base : ref;
        if (local) Object.assign(img, { files: { ...local.files }, cmd: local.cmd, entrypoint: local.entrypoint, env: { ...local.env }, workdir: local.workdir, user: local.user, exposed: [...local.exposed] });
        break;
      }
      case "COPY":
      case "ADD": {
        const parts = splitWords(a).filter((x) => !x.startsWith("--"));
        const dest = parts.pop() ?? "/";
        for (const src of parts) {
          const e = copyInto(fs, img.files, context, src, dest, img.workdir);
          if (e) {
            io.stdout(lines.join("\n") + "\n");
            throw new KubeError(tool === "podman" ? `Error: building at STEP "${s.raw}": checking on sources under "${fs.cwd()}/${context}": copier: stat: "/${src}": no such file or directory` : `ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/${src}": not found`);
          }
        }
        break;
      }
      case "RUN": {
        const m = a.match(/^(?:echo|printf)\s+(['"]?)(.*?)\1\s*>\s*(\S+)$/);
        if (m) img.files[normalizePath(m[3].startsWith("/") ? m[3] : `${img.workdir}/${m[3]}`)] = m[2] + "\n";
        const mk = a.match(/^mkdir\s+(?:-p\s+)?(\S+)/);
        if (mk) img.files[normalizePath(mk[1]) + "/.keep"] = "";
        break;
      }
      case "CMD":
        img.cmd = execForm(a);
        break;
      case "ENTRYPOINT":
        img.entrypoint = execForm(a);
        img.cmd = [];
        break;
      case "ENV": {
        if (a.includes("=")) for (const kv of splitWords(a)) img.env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
        else {
          const [k, ...rest] = a.split(/\s+/);
          img.env[k] = rest.join(" ");
        }
        break;
      }
      case "WORKDIR":
        img.workdir = normalizePath(a.startsWith("/") ? a : `${img.workdir}/${a}`);
        img.files[`${img.workdir}/.keep`] = "";
        break;
      case "USER":
        img.user = /^\d+/.test(a) ? parseInt(a, 10) : a === "root" ? 0 : 1000;
        break;
      case "EXPOSE":
        img.exposed.push(...a.split(/\s+/));
        break;
      case "LABEL":
      case "MAINTAINER":
      case "HEALTHCHECK":
      case "SHELL":
      case "VOLUME":
      case "STOPSIGNAL":
        break;
      default:
        throw new KubeError(`Error: unknown instruction: ${s.op}`);
    }
    if (tool === "podman" && n > 1 && n < steps.length) lines.push(`--> ${shortId(s.raw + n).slice(0, 12)}`);
  }
  img.id = shortId(JSON.stringify(img.files) + img.cmd.join(" ") + img.base + img.created);
  img.size = 40_000_000 + Object.values(img.files).reduce((t, c) => t + c.length, 0);
  const names = tags.length ? tags : [];
  for (const t of names) st(cluster).local.set(imageKey(t, tool), img);
  if (!names.length) st(cluster).local.set(`<none>:${img.id.slice(0, 12)}`, img);
  if (tool === "podman") {
    lines.push(`COMMIT ${names[0] ?? ""}`, `--> ${img.id.slice(0, 12)}`, ...names.map((t) => `Successfully tagged ${imageKey(t, "podman")}`), img.id);
    io.stdout(lines.join("\n") + "\n");
  } else {
    const out = [
      `[+] Building 1.2s (${steps.length + 4}/${steps.length + 4}) FINISHED                                     docker:default`,
      " => [internal] load build definition from Dockerfile                          0.0s",
      ` => [internal] load metadata for docker.io/library/${parseImage(img.base).repository}:${parseImage(img.base).tag}`.padEnd(78) + " 0.6s",
      " => [internal] load .dockerignore                                             0.0s",
      ...lines.map((l) => l.padEnd(78) + " 0.0s"),
      " => exporting to image                                                        0.1s",
      ` => => writing image sha256:${img.id}`,
      ...names.map((t) => ` => => naming to ${imageKey(t, "docker")}`),
    ];
    io.stderr(out.join("\n") + "\n");
  }
  return 0;
}

function findImage(cluster: Cluster, ref: string, tool: "docker" | "podman"): BuiltImage | undefined {
  const s = st(cluster);
  return s.local.get(imageKey(ref, tool)) ?? s.local.get(imageKey(ref, tool === "docker" ? "podman" : "docker")) ?? [...s.local.values()].find((i) => i.id.startsWith(ref));
}

function hostFs(img: BuiltImage | undefined, base: string): Fs {
  const info = imageInfo(base);
  const store = new Map<string, string>(Object.entries({ ...(info?.files ?? {}), ...(img?.files ?? {}) }));
  const dirs = new Set(["/", "/bin", "/etc", "/tmp", "/usr", "/var", "/root", "/app", ...(info?.dirs ?? [])]);
  const isDir = (p: string) => dirs.has(p) || [...store.keys()].some((k) => k.startsWith(p === "/" ? "/" : p + "/") && store.get(k) !== DELETED);
  return {
    read: (p) => {
      const v = store.get(normalizePath(p));
      return v === undefined || v === DIR || v === DELETED ? undefined : v;
    },
    isDir: (p) => isDir(normalizePath(p)),
    list: (d) => {
      d = normalizePath(d);
      if (!isDir(d)) return undefined;
      const pre = d === "/" ? "/" : d + "/";
      const names = new Set<string>();
      for (const k of [...store.keys(), ...dirs]) if (k.startsWith(pre) && store.get(k) !== DELETED) names.add(k.slice(pre.length).split("/")[0]);
      names.delete("");
      names.delete(".keep");
      return [...names].sort();
    },
    write: (p, data, append) => {
      p = normalizePath(p);
      store.set(p, (append ? store.get(p) ?? "" : "") + data);
      return undefined;
    },
    remove: (p) => {
      store.set(normalizePath(p), DELETED);
      return undefined;
    },
    mkdir: (p) => {
      dirs.add(normalizePath(p));
      return undefined;
    },
  };
}

function runContainer(cluster: Cluster, tool: "docker" | "podman", args: string[], io: IO): number {
  let name: string | undefined;
  let detach = false;
  let rm = false;
  const env: Record<string, string> = {};
  let ports = "";
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-d" || a === "--detach") detach = true;
    else if (a === "--rm") rm = true;
    else if (a === "-it" || a === "-ti" || a === "-i" || a === "-t") continue;
    else if (a === "--name") name = args[++i];
    else if (a.startsWith("--name=")) name = a.slice(7);
    else if (a === "-e" || a === "--env") {
      const [k, v] = args[++i].split("=");
      env[k] = v ?? "";
    } else if (a === "-p" || a === "--publish") ports = args[++i];
    else if (a.startsWith("-")) {
      if (["-v", "--volume", "-w", "--workdir", "--network", "-u", "--user"].includes(a)) i++;
    } else break;
  }
  const ref = args[i];
  if (!ref) throw new KubeError(`Error: requires at least 1 arg(s), only received 0`);
  const cmdArgs = args.slice(i + 1);
  const img = findImage(cluster, ref, tool) ?? registry(cluster).get(imageKey(ref, tool));
  const base = img?.base ?? ref;
  if (!img && !imageInfo(ref)) {
    throw new KubeError(tool === "podman" ? `Error: initializing source docker://${ref}: reading manifest ${parseImage(ref).tag} in docker.io/library/${parseImage(ref).repository}: requested access to the resource is denied` : `Unable to find image '${ref}' locally\ndocker: Error response from daemon: pull access denied for ${parseImage(ref).repository}, repository does not exist or may require 'docker login'.`);
  }
  const s = st(cluster);
  const cname = name ?? `${["eager", "brave", "quirky", "nifty"][s.containers.size % 4]}_${["turing", "lovelace", "hopper", "knuth"][s.containers.size % 4]}`;
  if (s.containers.get(cname) && !s.containers.get(cname)!.removed) throw new KubeError(tool === "podman" ? `Error: creating container storage: the container name "${cname}" is already in use by ${s.containers.get(cname)!.id}. You have to remove that container to be able to reuse that name: that name is already in use` : `docker: Error response from daemon: Conflict. The container name "/${cname}" is already in use by container "${s.containers.get(cname)!.id}". You have to remove (or rename) that container to be able to reuse that name.`);
  const info = imageInfo(base);
  const host: Host = {
    now: () => cluster.now(),
    fs: hostFs(img, base),
    tools: null,
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...(img?.env ?? {}), ...env, HOSTNAME: cname.slice(0, 12) },
    hostname: cname.slice(0, 12),
    podIP: "10.88.0." + (2 + s.containers.size),
    uid: img?.user ?? info?.user ?? 0,
    gid: 0,
    groups: [],
    caps: new Set(["NET_BIND_SERVICE", "CHOWN", "SETUID", "SETGID"]),
    image: parseImage(base).repository,
    net: () => ({ stdout: "", stderr: "(podsim) networking from host containers is not simulated\n", code: 1 }),
  };
  const argv = cmdArgs.length ? [...(img?.entrypoint ?? []), ...cmdArgs] : [...(img?.entrypoint ?? []), ...(img?.cmd ?? [])];
  const what = argv.length ? argv : info?.defaultScript ? { script: info.defaultScript({ name: cname, image: base }, host.env) } : [];
  const id = shortId(cname + cluster.now());
  const proc = new Proc(host, what, cluster.now(), argv[0] ?? "sh");
  proc.x.vars.PWD = img?.workdir ?? "/";
  const c: HostContainer = { id, name: cname, image: img ? ref : ref, proc, created: cluster.now(), ports };
  if (!detach) {
    const r = execNow(host, what, { vars: { PWD: img?.workdir ?? "/" } });
    io.stdout(r.stdout);
    io.stderr(r.stderr);
    if (!rm) s.containers.set(cname, c);
    return r.code;
  }
  s.containers.set(cname, c);
  proc.advance(cluster.now());
  io.stdout(id + "\n");
  return 0;
}

export function containerTool(cluster: Cluster, fs: FileSystem, tool: "docker" | "podman", argv: string[], io: IO): number {
  try {
    return dispatch(cluster, fs, tool, argv, io);
  } catch (e) {
    if (e instanceof KubeError) {
      io.stderr(e.message.endsWith("\n") ? e.message : e.message + "\n");
      return tool === "docker" ? 1 : 125;
    }
    throw e;
  }
}

function dispatch(cluster: Cluster, fs: FileSystem, tool: "docker" | "podman", argv: string[], io: IO): number {
  const [cmd0, ...rest] = argv;
  let cmd = cmd0;
  let args = rest;
  if ((cmd === "image" || cmd === "container") && args[0]) {
    cmd = cmd === "image" && args[0] === "ls" ? "images" : cmd === "container" && args[0] === "ls" ? "ps" : args[0];
    args = args.slice(1);
  }
  const s = st(cluster);
  const out = (t: string) => io.stdout(t.endsWith("\n") ? t : t + "\n");
  for (const c of s.containers.values()) c.proc.advance(cluster.now());
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      out(`Usage: ${tool} [OPTIONS] COMMAND\n\nCommands: build, images, tag, save, load, push, pull, rmi, run, ps, logs, exec, stop, rm, inspect, version`);
      return 0;
    case "version":
    case "--version":
      out(tool === "podman" ? "podman version 5.4.2" : "Docker version 28.5.1, build e180ab8");
      return 0;
    case "build":
    case "buildx":
      return build(cluster, fs, tool, cmd === "buildx" ? args.slice(1) : args, io);
    case "images": {
      const rows = [...s.local.entries()].map(([k, img]) => {
        const p = k.startsWith("<none>") ? { repo: "<none>", tag: "<none>" } : { repo: k.slice(0, k.lastIndexOf(":")).replace(/^docker\.io\/library\//, ""), tag: k.slice(k.lastIndexOf(":") + 1) };
        return [p.repo, p.tag, img.id.slice(0, 12), ago(cluster.now() - img.created), `${(img.size / 1e6).toFixed(1)} MB`];
      });
      const headers = ["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"];
      const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      out([headers, ...rows].map((r) => r.map((c, i) => c.padEnd(w[i] + 2)).join("").trimEnd()).join("\n"));
      return 0;
    }
    case "tag": {
      const [src, dst] = args;
      const img = findImage(cluster, src ?? "", tool);
      if (!img) throw new KubeError(tool === "podman" ? `Error: ${src}: image not known` : `Error response from daemon: No such image: ${src}`);
      s.local.set(imageKey(dst, tool), img);
      return 0;
    }
    case "save": {
      let file: string | undefined;
      const refs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-o" || args[i] === "--output") file = args[++i];
        else if (args[i] === "--format") i++;
        else refs.push(args[i]);
      }
      const img = findImage(cluster, refs[0] ?? "", tool);
      if (!img) throw new KubeError(tool === "podman" ? `Error: ${refs[0]}: image not known` : `Error response from daemon: reference does not exist`);
      const content = `podsim-image-archive\n${JSON.stringify({ refs: refs.map((r) => imageKey(r, tool)), image: img })}\n`;
      if (file) fs.writeFile(file, content);
      else io.stdout(content);
      if (tool === "podman" && file) out("Copying blob 5f70bf18a086 done\nCopying config " + img.id.slice(0, 12) + " done\nWriting manifest to image destination");
      return 0;
    }
    case "load": {
      const i = args.findIndex((a) => a === "-i" || a === "--input");
      const file = args[i + 1];
      if (!file || !fs.exists(file)) throw new KubeError(`Error: open ${file}: no such file or directory`);
      const text = fs.readFile(file);
      if (!text.startsWith("podsim-image-archive")) throw new KubeError("Error: payload does not match any of the supported image formats");
      const data = JSON.parse(text.split("\n")[1]) as { refs: string[]; image: BuiltImage };
      for (const r of data.refs) s.local.set(r, data.image);
      out(`Loaded image: ${data.refs.join(", ")}`);
      return 0;
    }
    case "push": {
      const ref = args.filter((a) => !a.startsWith("-"))[0];
      const img = findImage(cluster, ref ?? "", tool);
      if (!img) throw new KubeError(tool === "podman" ? `Error: ${ref}: image not known` : `An image does not exist locally with the tag: ${ref}`);
      const key = imageKey(ref, tool);
      if (key.startsWith("docker.io/") || key.startsWith("localhost/")) {
        throw new KubeError(tool === "podman" ? `Error: trying to reuse blob sha256:5f70bf18a086 at destination: checking whether a blob sha256:5f70bf18a086 exists in ${key.split("/")[0]}: authentication required` : `denied: requested access to the resource is denied`);
      }
      registry(cluster).set(key, img);
      out(tool === "podman" ? `Getting image source signatures\nCopying blob 5f70bf18a086 done\nCopying config ${img.id.slice(0, 12)} done\nWriting manifest to image destination` : `The push refers to repository [${key.slice(0, key.lastIndexOf(":"))}]\n5f70bf18a086: Pushed\n${key.slice(key.lastIndexOf(":") + 1)}: digest: sha256:${img.id} size: 1570`);
      return 0;
    }
    case "pull": {
      const ref = args[0] ?? "";
      if (!imageInfo(ref) && !registry(cluster).get(imageKey(ref, tool))) throw new KubeError(`Error: initializing source docker://${ref}: reading manifest: requested access to the resource is denied`);
      const img: BuiltImage = registry(cluster).get(imageKey(ref, tool)) ?? { base: ref, files: {}, cmd: [], entrypoint: [], env: {}, workdir: "/", exposed: [], created: cluster.now(), id: shortId(ref), size: 50_000_000 };
      s.local.set(imageKey(ref, tool), img);
      out(img.id);
      return 0;
    }
    case "rmi": {
      for (const r of args.filter((a) => !a.startsWith("-"))) {
        const key = imageKey(r, tool);
        if (!s.local.delete(key)) throw new KubeError(tool === "podman" ? `Error: ${r}: image not known` : `Error response from daemon: No such image: ${r}`);
        out(`Untagged: ${key}`);
      }
      return 0;
    }
    case "run":
      return runContainer(cluster, tool, args, io);
    case "ps": {
      const all = args.includes("-a") || args.includes("--all");
      const rows = [...s.containers.values()].filter((c) => !c.removed && (all || !c.proc.exited)).map((c) => [c.id.slice(0, 12), c.image, c.proc.exited ? `Exited (${c.proc.exitCode}) ${ago(cluster.now() - c.proc.exitAt)}` : `Up ${ago(cluster.now() - c.created).replace(" ago", "")}`, c.ports ? `0.0.0.0:${c.ports.replace(":", "->")}/tcp` : "", c.name]);
      const headers = ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"];
      const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      out([headers, ...rows].map((r) => r.map((c, i) => c.padEnd(w[i] + 2)).join("").trimEnd()).join("\n"));
      return 0;
    }
    case "logs": {
      const c = s.containers.get(args.filter((a) => !a.startsWith("-"))[0] ?? "");
      if (!c || c.removed) throw new KubeError(tool === "podman" ? `Error: no container with name or ID "${args[0]}" found: no such container` : `Error response from daemon: No such container: ${args[0]}`);
      const lines = c.proc.logLines().map((l) => l.text);
      if (lines.length) out(lines.join("\n"));
      return 0;
    }
    case "exec": {
      const flags = args.filter((a, i) => a.startsWith("-") && i < 3);
      const rest2 = args.slice(flags.length);
      const c = s.containers.get(rest2[0] ?? "");
      if (!c || c.removed || c.proc.exited) throw new KubeError(`Error: no container with name or ID "${rest2[0]}" found: no such container`);
      const r = execNow(c.proc.host, rest2.slice(1));
      io.stdout(r.stdout);
      io.stderr(r.stderr);
      return r.code;
    }
    case "stop":
    case "kill": {
      for (const n of args.filter((a) => !a.startsWith("-"))) {
        const c = s.containers.get(n);
        if (!c) throw new KubeError(`Error: no container with name or ID "${n}" found: no such container`);
        if (!c.proc.exited) {
          c.proc.exited = true;
          c.proc.exitCode = 137;
          c.proc.exitAt = cluster.now();
        }
        out(n);
      }
      return 0;
    }
    case "rm": {
      for (const n of args.filter((a) => !a.startsWith("-"))) {
        const c = s.containers.get(n);
        if (!c || c.removed) throw new KubeError(`Error: no container with name or ID "${n}" found: no such container`);
        if (!c.proc.exited && !args.includes("-f")) throw new KubeError(`Error: cannot remove container ${c.id} as it is running - running or paused containers cannot be removed without force: container state improper`);
        c.removed = true;
        s.containers.delete(n);
        out(n);
      }
      return 0;
    }
    case "inspect": {
      const img = findImage(cluster, args[0] ?? "", tool);
      if (!img) throw new KubeError(`Error: no such object: "${args[0]}"`);
      out(JSON.stringify([{ Id: `sha256:${img.id}`, RepoTags: [...s.local.entries()].filter(([, v]) => v === img).map(([k]) => k), Config: { Cmd: img.cmd, Entrypoint: img.entrypoint, Env: Object.entries(img.env).map(([k, v]) => `${k}=${v}`), WorkingDir: img.workdir, ExposedPorts: Object.fromEntries(img.exposed.map((p) => [`${p}/tcp`, {}])) }, Size: img.size }], null, 4));
      return 0;
    }
    default:
      throw new KubeError(tool === "podman" ? `Error: unrecognized command \`podman ${cmd}\`` : `docker: '${cmd}' is not a docker command.`);
  }
}
