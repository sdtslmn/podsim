// What happens when you run a command inside a simulated container:
// a handful of shell builtins, cluster DNS (nslookup) and HTTP (wget,
// curl) against Services and Pods, and files from mounted ConfigMaps
// and Secrets. Enough to practice service discovery and debugging.

import type { Cluster } from "../cluster.js";
import { fromBase64 } from "../cluster.js";
import type { ContainerSpec, KObject } from "../types.js";
import { parseImage } from "../images.js";
import { resolveEnv } from "../controllers/kubelet.js";
import { isPodReady } from "../controllers/deployment.js";
import { matchMap } from "../util.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: "", stderr, exitCode });

/** Which tools each image family ships with. */
function toolsFor(image: string): Set<string> {
  const repo = parseImage(image).repository;
  const busybox = ["wget", "nslookup", "nc", "ping", "sh", "ls", "cat", "env", "printenv", "hostname", "echo", "date", "sleep", "id", "whoami", "ps", "true", "false", "uname"];
  if (repo === "busybox" || repo === "alpine") return new Set(busybox);
  if (repo === "nicolaka/netshoot") return new Set([...busybox, "curl", "dig", "host", "bash"]);
  if (repo === "curlimages/curl") return new Set(["curl", "sh", "ls", "cat", "env", "printenv", "hostname", "echo", "sleep", "id", "whoami", "true", "false"]);
  if (repo === "nginx" || repo === "httpd" || repo === "postgres" || repo === "redis" || repo === "mysql" || repo === "mariadb") {
    const base = ["sh", "bash", "ls", "cat", "env", "printenv", "hostname", "echo", "date", "sleep", "id", "whoami", "true", "false", "uname"];
    if (repo === "nginx") base.push("curl");
    return new Set(base);
  }
  return new Set(["sh", "bash", "ls", "cat", "env", "printenv", "hostname", "echo", "date", "sleep", "id", "whoami", "true", "false", "uname"]);
}

const LISTEN_PORTS: Record<string, number> = {
  nginx: 80,
  httpd: 80,
  "traefik/whoami": 80,
  "hashicorp/http-echo": 5678,
  redis: 6379,
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongo: 27017,
  memcached: 11211,
  rabbitmq: 5672,
  "nginxinc/nginx-unprivileged": 8080,
};

const NGINX_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;

function listeningPort(pod: KObject): { port: number; container: ContainerSpec } | undefined {
  for (const c of pod.spec?.containers ?? []) {
    if (c.command?.length || c.args?.length) {
      const repo = parseImage(c.image).repository;
      if (repo !== "hashicorp/http-echo") continue;
    }
    const port = LISTEN_PORTS[parseImage(c.image).repository];
    if (port) {
      if (parseImage(c.image).repository === "hashicorp/http-echo") {
        const listen = [...(c.args ?? [])].find((a: string) => a.startsWith("-listen="));
        if (listen) return { port: parseInt(listen.split(":").pop() ?? "5678", 10), container: c };
      }
      return { port, container: c };
    }
  }
  return undefined;
}

function responseBody(pod: KObject, c: ContainerSpec): string {
  const repo = parseImage(c.image).repository;
  if (repo === "nginx" || repo === "nginxinc/nginx-unprivileged") return NGINX_PAGE;
  if (repo === "httpd") return "<html><body><h1>It works!</h1></body></html>";
  if (repo === "traefik/whoami") return `Hostname: ${pod.metadata.name}\nIP: 127.0.0.1\nIP: ${pod.status?.podIP}\nRemoteAddr: 10.244.0.1:41234\nGET / HTTP/1.1\nHost: ${pod.status?.podIP}\nUser-Agent: Wget`;
  if (repo === "hashicorp/http-echo") {
    const text = (c.args ?? []).find((a: string) => a.startsWith("-text="));
    return text ? text.slice(6).replace(/^["']|["']$/g, "") : "hello-world";
  }
  return "";
}

interface Target {
  ip: string;
  fqdn?: string;
  service?: KObject;
  pod?: KObject;
}

/** Resolve a hostname the way cluster DNS would from a pod in `ns`. */
export function resolveHost(cluster: Cluster, ns: string, host: string): Target | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const svc = cluster.list("Service").find((s) => s.spec?.clusterIP === h);
    if (svc) return { ip: h, service: svc };
    const pod = cluster.list("Pod").find((p) => p.status?.podIP === h);
    return { ip: h, pod };
  }
  if (h === "localhost") return { ip: "127.0.0.1" };
  const parts = h.replace(/\.cluster\.local$/, "").split(".");
  let svcName = parts[0];
  let svcNs = ns;
  if (parts.length >= 2 && parts[1] !== "svc") svcNs = parts[1];
  if (parts.length >= 3 && parts[2] !== "svc") return undefined;
  if (parts.length === 2 && parts[1] === "svc") return undefined;
  if (!svcName) return undefined;
  const svc = cluster.get("Service", svcName, svcNs);
  if (!svc || !cluster.get("Namespace", svcNs)) return undefined;
  if (svc.spec?.type === "ExternalName") return { ip: "", fqdn: svc.spec.externalName, service: svc };
  return { ip: svc.spec.clusterIP, fqdn: `${svcName}.${svcNs}.svc.cluster.local`, service: svc };
}

type HttpOutcome = { body: string; status: number } | { error: "refused" | "timeout" | "unresolved" | "reset" };

function httpGet(cluster: Cluster, ns: string, url: string): { target?: Target; port: number; outcome: HttpOutcome; host: string } {
  const m = url.match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return { port: 80, outcome: { error: "unresolved" }, host: url };
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : url.startsWith("https") ? 443 : 80;
  const target = resolveHost(cluster, ns, host);
  if (!target) return { port, outcome: { error: "unresolved" }, host };
  let pod: KObject | undefined = target.pod;
  let podPort = port;
  if (target.service) {
    const svc = target.service;
    const sp = (svc.spec.ports ?? []).find((p: { port: number }) => p.port === port);
    if (!sp) return { target, port, outcome: { error: "timeout" }, host };
    const ready = cluster
      .list("Pod", svc.metadata.namespace)
      .filter((p) => matchMap(p.metadata.labels, svc.spec.selector) && isPodReady(p) && p.status?.podIP);
    if (ready.length === 0) return { target, port, outcome: { error: "refused" }, host };
    pod = ready[0];
    const tp = sp.targetPort;
    if (typeof tp === "number") podPort = tp;
    else if (/^\d+$/.test(String(tp))) podPort = parseInt(String(tp), 10);
    else {
      const named = (pod.spec.containers ?? []).flatMap((c: ContainerSpec) => c.ports ?? []).find((p: { name?: string }) => p.name === tp);
      podPort = named?.containerPort ?? -1;
    }
  }
  if (!pod) return { target, port, outcome: { error: "timeout" }, host };
  if (!isPodReady(pod)) return { target, port, outcome: { error: "refused" }, host };
  const listen = listeningPort(pod);
  if (!listen || listen.port !== podPort) return { target, port, outcome: { error: "refused" }, host };
  const body = responseBody(pod, listen.container);
  if (!body) return { target, port, outcome: { error: "reset" }, host };
  return { target, port, outcome: { body, status: 200 }, host };
}

function wget(cluster: Cluster, ns: string, args: string[]): ExecResult {
  let quiet = false;
  let toStdout = false;
  let spider = false;
  let url = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-q" || a === "--quiet") quiet = true;
    else if (a === "-qO-" || a === "-qO" || a === "-Oq-") {
      quiet = true;
      toStdout = true;
      if (a === "-qO") i++;
    } else if (a === "-O-" || (a === "-O" && args[i + 1] === "-")) {
      toStdout = true;
      if (a === "-O") i++;
    } else if (a === "-O") i++;
    else if (a === "--spider") spider = true;
    else if (a === "-T" || a === "--timeout") i++;
    else if (a.startsWith("--timeout=") || a.startsWith("-T")) continue;
    else if (!a.startsWith("-")) url = a;
  }
  if (!url) return fail("BusyBox v1.37.0 (2024-09-26 21:31:42 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-T SEC] URL...", 1);
  const r = httpGet(cluster, ns, url);
  const o = r.outcome;
  if ("error" in o) {
    if (o.error === "unresolved") return fail(`wget: bad address '${r.host}'`);
    if (o.error === "refused") return fail(`${quiet ? "" : `Connecting to ${r.host}${r.port !== 80 ? ":" + r.port : ""} (${r.target?.ip}:${r.port})\n`}wget: can't connect to remote host (${r.target?.ip}): Connection refused`);
    if (o.error === "reset") return fail(`${quiet ? "" : `Connecting to ${r.host} (${r.target?.ip}:${r.port})\n`}wget: error getting response: Connection reset by peer`);
    return fail(`${quiet ? "" : `Connecting to ${r.host} (${r.target?.ip}:${r.port})\n`}wget: download timed out`);
  }
  if (spider) return ok(quiet ? "" : `Connecting to ${r.host} (${r.target?.ip}:${r.port})\nremote file exists\n`);
  if (toStdout) return { stdout: o.body + "\n", stderr: quiet ? "" : `Connecting to ${r.host} (${r.target?.ip}:${r.port})\nwriting to stdout\n-                    100% |********************************|   ${o.body.length}  0:00:00 ETA\nwritten to stdout\n`, exitCode: 0 };
  return ok(quiet ? "" : `Connecting to ${r.host} (${r.target?.ip}:${r.port})\nsaving to 'index.html'\nindex.html           100% |********************************|   ${o.body.length}  0:00:00 ETA\n'index.html' saved\n`);
}

function curl(cluster: Cluster, ns: string, args: string[]): ExecResult {
  let headOnly = false;
  let writeOut: string | undefined;
  let discard = false;
  let url = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-I" || a === "--head") headOnly = true;
    else if (a === "-w" || a === "--write-out") writeOut = args[++i];
    else if (a === "-o") discard = args[++i] === "/dev/null" || true;
    else if (["-m", "--max-time", "--connect-timeout", "-H", "-X", "-d"].includes(a)) i++;
    else if (a.startsWith("-")) continue;
    else url = a;
  }
  if (!url) return fail("curl: try 'curl --help' or 'curl --manual' for more information", 2);
  const r = httpGet(cluster, ns, url);
  const o = r.outcome;
  if ("error" in o) {
    if (o.error === "unresolved") return fail(`curl: (6) Could not resolve host: ${r.host}`, 6);
    if (o.error === "refused") return fail(`curl: (7) Failed to connect to ${r.host} port ${r.port} after 1 ms: Couldn't connect to server`, 7);
    if (o.error === "reset") return fail("curl: (56) Recv failure: Connection reset by peer", 56);
    return fail(`curl: (28) Failed to connect to ${r.host} port ${r.port} after 5002 ms: Timeout was reached`, 28);
  }
  let out = "";
  if (headOnly) out = `HTTP/1.1 200 OK\nServer: simulated\nContent-Type: text/html\nContent-Length: ${o.body.length}\n\n`;
  else if (!discard) out = o.body + "\n";
  if (writeOut) out += writeOut.replace("%{http_code}", "200").replace(/\\n/g, "\n");
  return ok(out);
}

function nslookup(cluster: Cluster, ns: string, args: string[]): ExecResult {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) return fail("Usage: nslookup HOST [DNS_SERVER]");
  const header = "Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n";
  const t = resolveHost(cluster, ns, name);
  if (!t || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    if (t?.service) return ok(`${header}${name.split(".").reverse().join(".")}.in-addr.arpa\tname = ${t.service.metadata.name}.${t.service.metadata.namespace}.svc.cluster.local\n`);
    const fq = name.includes(".") ? name : `${name}.${ns}.svc.cluster.local`;
    return { stdout: header, stderr: `** server can't find ${fq}: NXDOMAIN\n\n** server can't find ${fq}: NXDOMAIN\n`, exitCode: 1 };
  }
  if (t.service?.spec?.type === "ExternalName") return ok(`${header}${t.fqdn}\tcanonical name = ${t.service.spec.externalName}\n`);
  if (t.service?.spec?.clusterIP === "None") {
    const pods = cluster.list("Pod", t.service.metadata.namespace).filter((p) => matchMap(p.metadata.labels, t.service!.spec.selector) && p.status?.podIP);
    return ok(header + pods.map((p) => `Name:\t${t.fqdn}\nAddress: ${p.status.podIP}\n`).join("\n"));
  }
  return ok(`${header}Name:\t${t.fqdn}\nAddress: ${t.ip}\n`);
}

function files(cluster: Cluster, pod: KObject, c: ContainerSpec): Map<string, string> {
  const ns = pod.metadata.namespace ?? "default";
  const out = new Map<string, string>();
  out.set("/etc/hostname", pod.metadata.name + "\n");
  out.set("/etc/resolv.conf", `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
  out.set("/etc/hosts", `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n${pod.status?.podIP ?? ""}\t${pod.metadata.name}\n`);
  out.set("/var/run/secrets/kubernetes.io/serviceaccount/namespace", ns);
  out.set("/var/run/secrets/kubernetes.io/serviceaccount/token", "eyJhbGciOiJSUzI1NiIsImtpZCI6InNpbXVsYXRlZCJ9.simulated-token.signature");
  const vols = new Map<string, Record<string, Record<string, unknown>>>((pod.spec?.volumes ?? []).map((v: { name: string }) => [v.name, v]));
  for (const m of c.volumeMounts ?? []) {
    const v = vols.get(m.name);
    if (!v) continue;
    const base = m.mountPath.replace(/\/$/, "");
    if (v.configMap) {
      const cm = cluster.get("ConfigMap", String(v.configMap.name), ns);
      const data = (cm?.data as Record<string, string>) ?? {};
      const items = v.configMap.items as { key: string; path: string }[] | undefined;
      if (items) for (const it of items) out.set(`${base}/${it.path}`, data[it.key] ?? "");
      else for (const [k, val] of Object.entries(data)) out.set(`${base}/${k}`, String(val));
    }
    if (v.secret) {
      const s = cluster.get("Secret", String(v.secret.secretName), ns);
      for (const [k, val] of Object.entries((s?.data as Record<string, string>) ?? {})) out.set(`${base}/${k}`, fromBase64(String(val)));
    }
    if (v.emptyDir || v.persistentVolumeClaim) out.set(`${base}/`, "");
  }
  return out;
}

/** Run argv inside a container of a running pod. */
export function runInContainer(cluster: Cluster, pod: KObject, c: ContainerSpec, argv: string[], viaShell = false): ExecResult {
  if (argv.length === 0) return fail("error: you must specify at least one command for the container");
  const tools = toolsFor(c.image);
  let [cmd, ...args] = argv;
  if ((cmd === "sh" || cmd === "/bin/sh" || cmd === "bash" || cmd === "/bin/bash") && args[0] === "-c") {
    if (!tools.has(cmd.replace("/bin/", ""))) return notFound(cmd, false);
    const script = args.slice(1).join(" ");
    let out = "";
    let err = "";
    let code = 0;
    for (const part of script.split(/\s*(?:;|&&)\s*/)) {
      if (!part.trim()) continue;
      const [left, ...filters] = part.split(/\s+\|\s+/);
      const r = runInContainer(cluster, pod, c, splitWords(left), true);
      for (const f of filters) {
        const words = splitWords(f);
        if (words[0] === "grep") {
          const invert = words.includes("-v");
          const icase = words.includes("-i");
          const pat = words.filter((w) => !w.startsWith("-")).slice(1)[0] ?? "";
          const test = (line: string) => (icase ? line.toLowerCase().includes(pat.toLowerCase()) : line.includes(pat));
          const lines = r.stdout.split("\n").filter((l) => l && test(l) !== invert);
          r.stdout = lines.length ? lines.join("\n") + "\n" : "";
          if (!lines.length) r.exitCode = 1;
        }
      }
      out += r.stdout;
      err += r.stderr;
      code = r.exitCode;
      if (code !== 0 && script.includes("&&")) break;
    }
    return { stdout: out, stderr: err, exitCode: code };
  }
  if (cmd === "sh" || cmd === "bash" || cmd === "/bin/sh" || cmd === "/bin/bash") {
    return fail("(k8s-sim) interactive shells are not simulated yet. Pass the command directly, for example:\n  kubectl exec POD -- wget -qO- http://my-service\n  kubectl exec POD -- printenv APP_MODE", 1);
  }
  cmd = cmd.replace(/^\/(usr\/)?(s)?bin\//, "");
  if (!tools.has(cmd)) return notFound(cmd, viaShell);
  const ns = pod.metadata.namespace ?? "default";
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOSTNAME: pod.metadata.name,
    KUBERNETES_SERVICE_HOST: "10.96.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    KUBERNETES_SERVICE_PORT_HTTPS: "443",
    KUBERNETES_PORT: "tcp://10.96.0.1:443",
    ...resolveEnv(cluster, pod, c).env,
    HOME: "/root",
  };
  switch (cmd) {
    case "env":
    case "printenv": {
      if (cmd === "printenv" && args[0]) {
        const v = (env as Record<string, string>)[args[0]];
        return v === undefined ? { stdout: "", stderr: "", exitCode: 1 } : ok(v + "\n");
      }
      return ok(
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") + "\n",
      );
    }
    case "hostname":
      return ok(pod.metadata.name + "\n");
    case "whoami":
      return ok("root\n");
    case "id":
      return ok("uid=0(root) gid=0(root) groups=0(root)\n");
    case "uname":
      return ok(args.includes("-a") ? `Linux ${pod.metadata.name} 6.8.0-79-generic #79-Ubuntu SMP x86_64 GNU/Linux\n` : "Linux\n");
    case "echo":
      return ok(args.join(" ").replace(/\$(\w+)/g, (_, k) => (env as Record<string, string>)[k] ?? "") + "\n");
    case "date":
      return ok(new Date(cluster.now()).toUTCString().replace("GMT", "UTC") + "\n");
    case "sleep":
    case "true":
      return ok();
    case "false":
      return { stdout: "", stderr: "", exitCode: 1 };
    case "cat": {
      const fs = files(cluster, pod, c);
      let out = "";
      for (const f of args) {
        const v = fs.get(f);
        if (v === undefined) return { stdout: out, stderr: `cat: ${f}: No such file or directory\n`, exitCode: 1 };
        out += v;
      }
      return ok(out);
    }
    case "ls": {
      const fs = files(cluster, pod, c);
      const path = (args.find((a) => !a.startsWith("-")) ?? "/").replace(/\/$/, "");
      const children = new Set<string>();
      for (const f of fs.keys()) if (f.startsWith(path + "/")) children.add(f.slice(path.length + 1).split("/")[0]);
      if (children.size === 0 && path !== "") return fail(`ls: ${path}: No such file or directory`);
      if (path === "") return ok("bin\ndev\netc\nhome\nproc\nroot\nsys\ntmp\nusr\nvar\n");
      return ok([...children].filter(Boolean).sort().join("\n") + "\n");
    }
    case "wget":
      return wget(cluster, ns, args);
    case "curl":
      return curl(cluster, ns, args);
    case "nslookup":
    case "host":
    case "dig":
      return nslookup(cluster, ns, args);
    case "ps":
      return ok("PID   USER     TIME  COMMAND\n    1 root      0:00 " + [...(c.command ?? []), ...(c.args ?? [])].join(" ") + "\n");
    default:
      return fail(`(k8s-sim) "${cmd}" is not simulated yet inside containers.`, 127);
  }
}

function notFound(cmd: string, viaShell: boolean): ExecResult {
  if (viaShell) return fail(`sh: ${cmd}: not found`, 127);
  return fail(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "simulated": OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown`, 127);
}

/** Split a command string into words, respecting quotes. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < s.length) cur += s[++i];
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
