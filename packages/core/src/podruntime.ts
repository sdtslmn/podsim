// Glue between the cluster and simulated processes: what a container sees
// (environment, files, mounted volumes, its user and capabilities), which
// image runs what by default, and the pod network (DNS, HTTP, TCP).

import type { Cluster } from "./cluster.js";
import { fromBase64 } from "./cluster.js";
import type { ContainerSpec, KObject } from "./types.js";
import { parseImage, builtImage } from "./images.js";
import { matchMap } from "./util.js";
import { DIR, DELETED, normalizePath, Proc, execNow, formatDate, nginxPorts, setPortChecker, type Fs, type Host, type NetResult, type Server } from "./runtime.js";
import { quoteArgv } from "./shparse.js";
import { apiGet, identityFromToken } from "./apiserver.js";
import type { ContainerSim, PodSim } from "./controllers/index.js";

export type Store = Map<string, string>;

// ------------------------------------------------------------------ environment

/** Resolve env and envFrom the way the kubelet does, or report the error it would raise. */
export function resolveEnv(cluster: Cluster, pod: KObject, c: ContainerSpec): { env: Record<string, string>; error?: string } {
  const ns = pod.metadata.namespace ?? "default";
  const env: Record<string, string> = {};
  for (const from of c.envFrom ?? []) {
    const f = from as { configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean }; prefix?: string };
    if (f.configMapRef) {
      const cm = cluster.get("ConfigMap", f.configMapRef.name, ns);
      if (!cm) {
        if (f.configMapRef.optional) continue;
        return { env, error: `configmap "${f.configMapRef.name}" not found` };
      }
      for (const [k, v] of Object.entries((cm.data as Record<string, string>) ?? {})) env[(f.prefix ?? "") + k] = String(v);
    }
    if (f.secretRef) {
      const sec = cluster.get("Secret", f.secretRef.name, ns);
      if (!sec) {
        if (f.secretRef.optional) continue;
        return { env, error: `secret "${f.secretRef.name}" not found` };
      }
      for (const [k, v] of Object.entries((sec.data as Record<string, string>) ?? {})) env[(f.prefix ?? "") + k] = fromBase64(String(v));
    }
  }
  for (const e of c.env ?? []) {
    if (e.value !== undefined) {
      env[e.name] = String(e.value).replace(/\$\(([A-Za-z_]\w*)\)/g, (m, k) => env[k] ?? m);
      continue;
    }
    const vf = e.valueFrom as
      | {
          configMapKeyRef?: { name: string; key: string; optional?: boolean };
          secretKeyRef?: { name: string; key: string; optional?: boolean };
          fieldRef?: { fieldPath: string };
          resourceFieldRef?: { resource: string; containerName?: string; divisor?: string };
        }
      | undefined;
    if (!vf) {
      env[e.name] = "";
      continue;
    }
    if (vf.configMapKeyRef) {
      const ref = vf.configMapKeyRef;
      const cm = cluster.get("ConfigMap", ref.name, ns);
      if (!cm) {
        if (ref.optional) continue;
        return { env, error: `configmap "${ref.name}" not found` };
      }
      const data = (cm.data as Record<string, string>) ?? {};
      if (!(ref.key in data)) {
        if (ref.optional) continue;
        return { env, error: `couldn't find key ${ref.key} in ConfigMap ${ns}/${ref.name}` };
      }
      env[e.name] = String(data[ref.key]);
    } else if (vf.secretKeyRef) {
      const ref = vf.secretKeyRef;
      const sec = cluster.get("Secret", ref.name, ns);
      if (!sec) {
        if (ref.optional) continue;
        return { env, error: `secret "${ref.name}" not found` };
      }
      const data = (sec.data as Record<string, string>) ?? {};
      if (!(ref.key in data)) {
        if (ref.optional) continue;
        return { env, error: `couldn't find key ${ref.key} in Secret ${ns}/${ref.name}` };
      }
      env[e.name] = fromBase64(String(data[ref.key]));
    } else if (vf.fieldRef) {
      env[e.name] = fieldValue(pod, vf.fieldRef.fieldPath);
    } else if (vf.resourceFieldRef) {
      env[e.name] = resourceValue(pod, vf.resourceFieldRef.containerName ?? c.name, vf.resourceFieldRef.resource);
    }
  }
  return { env };
}

function fieldValue(pod: KObject, path: string): string {
  const m = path.match(/^metadata\.(labels|annotations)\['(.+)'\]$/);
  if (m) return String((pod.metadata[m[1]] as Record<string, string> | undefined)?.[m[2]] ?? "");
  const fields: Record<string, string | undefined> = {
    "metadata.name": pod.metadata.name,
    "metadata.namespace": pod.metadata.namespace ?? "default",
    "metadata.uid": pod.metadata.uid,
    "spec.nodeName": pod.spec?.nodeName,
    "spec.serviceAccountName": pod.spec?.serviceAccountName,
    "status.podIP": pod.status?.podIP,
    "status.hostIP": pod.status?.hostIP,
    "status.podIPs": pod.status?.podIP,
    "status.hostIPs": pod.status?.hostIP,
  };
  if (path === "metadata.labels" || path === "metadata.annotations") {
    const map = (pod.metadata[path.split(".")[1]] as Record<string, string> | undefined) ?? {};
    return Object.entries(map).map(([k, v]) => `${k}="${v}"`).join("\n");
  }
  return fields[path] ?? "";
}

function resourceValue(pod: KObject, container: string, resource: string): string {
  const c = (pod.spec?.containers ?? []).find((x: ContainerSpec) => x.name === container);
  const [section, name] = resource.split(".");
  const v = c?.resources?.[section]?.[name];
  if (v === undefined) return name === "cpu" ? "2" : "4101726208";
  if (name === "cpu") return String(Math.ceil(parseFloat(String(v)) / (String(v).endsWith("m") ? 1000 : 1)));
  const m = String(v).match(/^(\d+)(Ki|Mi|Gi|K|M|G)?$/);
  if (!m) return String(v);
  const mult: Record<string, number> = { Ki: 1024, Mi: 1048576, Gi: 1073741824, K: 1000, M: 1e6, G: 1e9 };
  return String(parseInt(m[1], 10) * (mult[m[2] ?? ""] ?? 1));
}

function serviceEnv(cluster: Cluster, ns: string): Record<string, string> {
  const env: Record<string, string> = {
    KUBERNETES_SERVICE_HOST: "10.96.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    KUBERNETES_SERVICE_PORT_HTTPS: "443",
    KUBERNETES_PORT: "tcp://10.96.0.1:443",
    KUBERNETES_PORT_443_TCP: "tcp://10.96.0.1:443",
    KUBERNETES_PORT_443_TCP_PROTO: "tcp",
    KUBERNETES_PORT_443_TCP_PORT: "443",
    KUBERNETES_PORT_443_TCP_ADDR: "10.96.0.1",
  };
  for (const svc of cluster.list("Service", ns)) {
    if (svc.metadata.name === "kubernetes" || !svc.spec?.clusterIP || svc.spec.clusterIP === "None") continue;
    const p = (svc.spec.ports ?? [])[0];
    if (!p) continue;
    const n = svc.metadata.name.toUpperCase().replace(/-/g, "_");
    const proto = (p.protocol ?? "TCP").toLowerCase();
    env[`${n}_SERVICE_HOST`] = svc.spec.clusterIP;
    env[`${n}_SERVICE_PORT`] = String(p.port);
    env[`${n}_PORT`] = `${proto}://${svc.spec.clusterIP}:${p.port}`;
  }
  return env;
}

// ------------------------------------------------------------------ images

interface ImageInfo {
  tools: string[];
  user: number;
  memMi: number;
  files?: Record<string, string>;
  dirs?: string[];
  /** From a Dockerfile: ENTRYPOINT, CMD, ENV and WORKDIR. */
  entrypoint?: string[];
  cmd?: string[];
  env?: Record<string, string>;
  workdir?: string;
  /** Script run when the pod gives no command or args. */
  defaultScript?: (c: ContainerSpec, env: Record<string, string>) => string;
  shell: boolean;
}

const BUSYBOX_TOOLS = ["sh", "ash", "echo", "cat", "ls", "env", "printenv", "hostname", "date", "sleep", "id", "whoami", "ps", "true", "false", "uname", "touch", "rm", "mkdir", "cp", "mv", "tee", "head", "tail", "wc", "grep", "sort", "uniq", "tr", "cut", "sed", "awk", "seq", "expr", "basename", "dirname", "base64", "chmod", "chown", "find", "df", "free", "kill", "wget", "nslookup", "nc", "ping", "telnet", "traceroute", "httpd", "ip", "ifconfig", "nproc", "printf", "test", "["];
const DEBIAN_TOOLS = ["sh", "bash", "echo", "cat", "ls", "env", "printenv", "hostname", "date", "sleep", "id", "whoami", "true", "false", "uname", "touch", "rm", "mkdir", "cp", "mv", "tee", "head", "tail", "wc", "grep", "sort", "uniq", "tr", "cut", "sed", "awk", "seq", "expr", "basename", "dirname", "base64", "chmod", "chown", "find", "df", "nproc", "printf", "test", "["];

const NGINX_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

const nginxConf = (port: number) => `server {
    listen       ${port};
    listen  [::]:${port};
    server_name  localhost;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
`;

const NGINX_MAIN = `user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    access_log  /var/log/nginx/access.log  main;
    sendfile        on;
    keepalive_timeout  65;
    include /etc/nginx/conf.d/*.conf;
}
`;

const echoLines = (lines: string[]) => lines.map((l) => `echo ${quoteArgv([l])}`).join("; ");

function dbImage(port: number, name: string, ready: string[], needs: string[] | undefined, fail: string[], mem: number): ImageInfo {
  return {
    tools: [...DEBIAN_TOOLS, name === "postgres" ? "pg_isready" : name === "mysql" || name === "mariadb" ? "mysqladmin" : name],
    user: 0,
    memMi: mem,
    shell: false,
    defaultScript: (c, env) => (needs && !needs.some((k) => env[k]) ? `${echoLines(fail)}; exit 1` : `${echoLines(ready)}; __serve tcp ${port} ${name}`),
  };
}

const IMAGES: Record<string, ImageInfo> = {
  busybox: { tools: BUSYBOX_TOOLS, user: 0, memMi: 1, shell: true },
  alpine: { tools: [...BUSYBOX_TOOLS, "apk"], user: 0, memMi: 1, shell: true },
  ubuntu: { tools: DEBIAN_TOOLS, user: 0, memMi: 2, shell: true },
  debian: { tools: DEBIAN_TOOLS, user: 0, memMi: 2, shell: true },
  centos: { tools: DEBIAN_TOOLS, user: 0, memMi: 2, shell: true },
  fedora: { tools: DEBIAN_TOOLS, user: 0, memMi: 2, shell: true },
  python: { tools: [...DEBIAN_TOOLS, "python", "python3", "pip"], user: 0, memMi: 10, shell: true },
  node: { tools: [...DEBIAN_TOOLS, "node", "npm"], user: 0, memMi: 12, shell: true },
  golang: { tools: [...DEBIAN_TOOLS, "go"], user: 0, memMi: 3, shell: true },
  "curlimages/curl": { tools: ["sh", "curl", "echo", "cat", "ls", "env", "printenv", "hostname", "sleep", "id", "whoami", "true", "false", "date", "touch", "rm", "mkdir", "grep", "head", "tail"], user: 100, memMi: 1, shell: true },
  "nicolaka/netshoot": { tools: [...BUSYBOX_TOOLS, "bash", "curl", "dig", "host"], user: 0, memMi: 3, shell: true },
  "polinux/stress": { tools: [...BUSYBOX_TOOLS, "stress"], user: 0, memMi: 1, shell: true },
  nginx: {
    tools: [...DEBIAN_TOOLS, "nginx", "nginx-debug", "curl"],
    user: 0,
    memMi: 4,
    shell: false,
    files: { "/usr/share/nginx/html/index.html": NGINX_PAGE, "/usr/share/nginx/html/50x.html": "<!DOCTYPE html>\n<html><body><h1>An error occurred.</h1></body></html>\n", "/etc/nginx/nginx.conf": NGINX_MAIN, "/etc/nginx/conf.d/default.conf": nginxConf(80) },
    dirs: ["/var/cache/nginx", "/var/log/nginx", "/etc/nginx", "/etc/nginx/conf.d", "/usr/share/nginx", "/usr/share/nginx/html", "/docker-entrypoint.d"],
    defaultScript: () => "nginx -g 'daemon off;'",
  },
  "nginxinc/nginx-unprivileged": {
    tools: [...DEBIAN_TOOLS, "nginx", "curl"],
    user: 101,
    memMi: 4,
    shell: false,
    files: { "/usr/share/nginx/html/index.html": NGINX_PAGE, "/etc/nginx/nginx.conf": NGINX_MAIN, "/etc/nginx/conf.d/default.conf": nginxConf(8080) },
    dirs: ["/var/cache/nginx", "/var/log/nginx", "/etc/nginx", "/etc/nginx/conf.d", "/usr/share/nginx/html"],
    defaultScript: () => "nginx -g 'daemon off;'",
  },
  httpd: {
    tools: [...DEBIAN_TOOLS, "httpd", "httpd-foreground", "apachectl"],
    user: 0,
    memMi: 6,
    shell: false,
    files: { "/usr/local/apache2/htdocs/index.html": "<html><body><h1>It works!</h1></body></html>\n" },
    dirs: ["/usr/local/apache2", "/usr/local/apache2/htdocs"],
    defaultScript: () =>
      `echo "AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using 127.0.0.1. Set the 'ServerName' directive globally to suppress this message"; httpd-foreground`,
  },
  redis: dbImage(6379, "redis-cli", ["1:C * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo", "1:M * Running mode=standalone, port=6379.", "1:M * Server initialized", "1:M * Ready to accept connections tcp"], undefined, [], 3),
  memcached: dbImage(11211, "memcached", [], undefined, [], 2),
  mongo: dbImage(27017, "mongosh", ['{"t":{"$date":"2026-11-14T10:00:00.000+00:00"},"s":"I","c":"NETWORK","id":23016,"ctx":"listener","msg":"Waiting for connections","attr":{"port":27017,"ssl":"off"}}'], undefined, [], 80),
  rabbitmq: dbImage(5672, "rabbitmqctl", ["Server startup complete; 0 plugins started."], undefined, [], 90),
  postgres: dbImage(
    5432,
    "postgres",
    ["PostgreSQL init process complete; ready for start up.", 'LOG:  listening on IPv4 address "0.0.0.0", port 5432', "LOG:  database system is ready to accept connections"],
    ["POSTGRES_PASSWORD", "POSTGRES_HOST_AUTH_METHOD"],
    ["Error: Database is uninitialized and superuser password is not specified.", "       You must specify POSTGRES_PASSWORD to a non-empty value for the", '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".'],
    30,
  ),
  mysql: dbImage(
    3306,
    "mysql",
    ["[System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.7'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL."],
    ["MYSQL_ROOT_PASSWORD", "MYSQL_ALLOW_EMPTY_PASSWORD", "MYSQL_RANDOM_ROOT_PASSWORD"],
    ["[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified", "    You need to specify one of the following as an environment variable:", "    - MYSQL_ROOT_PASSWORD", "    - MYSQL_ALLOW_EMPTY_PASSWORD", "    - MYSQL_RANDOM_ROOT_PASSWORD"],
    380,
  ),
  mariadb: dbImage(
    3306,
    "mariadb",
    ["[Note] mariadbd: ready for connections."],
    ["MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "MARIADB_RANDOM_ROOT_PASSWORD"],
    ["[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified"],
    90,
  ),
  "bitnami/nginx": {
    tools: [...DEBIAN_TOOLS, "nginx", "curl"],
    user: 1001,
    memMi: 5,
    shell: false,
    files: { "/app/index.html": NGINX_PAGE, "/opt/bitnami/nginx/html/index.html": NGINX_PAGE, "/etc/nginx/nginx.conf": NGINX_MAIN.replace("user  nginx;\n", ""), "/etc/nginx/conf.d/default.conf": nginxConf(8080).replace("/usr/share/nginx/html", "/app") },
    dirs: ["/app", "/var/cache/nginx", "/etc/nginx", "/etc/nginx/conf.d", "/opt/bitnami", "/opt/bitnami/nginx", "/opt/bitnami/nginx/html"],
    defaultScript: () => `echo "nginx 10:00:00.00 INFO  ==> Welcome to the Bitnami nginx container"; echo "nginx 10:00:01.00 INFO  ==> ** Starting NGINX **"; nginx -g 'daemon off;'`,
  },
  "bitnami/apache": {
    tools: [...DEBIAN_TOOLS, "httpd", "curl"],
    user: 1001,
    memMi: 8,
    shell: false,
    files: { "/app/index.html": "<html><body><h1>It works!</h1></body></html>\n" },
    dirs: ["/app", "/opt/bitnami", "/opt/bitnami/apache"],
    defaultScript: () => `echo "apache 10:00:00.00 INFO  ==> Welcome to the Bitnami apache container"; echo "apache 10:00:01.00 INFO  ==> ** Starting Apache **"; __serve static 8080 /app`,
  },
  "bitnami/redis": dbImage(6379, "redis-cli", ["redis 10:00:00.00 INFO  ==> ** Starting Redis **", "1:M * Ready to accept connections tcp"], ["REDIS_PASSWORD", "ALLOW_EMPTY_PASSWORD"], ["redis 10:00:00.00 ERROR ==> The REDIS_PASSWORD environment variable is empty or not set. Set the environment variable ALLOW_EMPTY_PASSWORD=yes to allow the container to be started with blank passwords. This is recommended only for development."], 4),
  "traefik/whoami": {
    tools: [],
    user: 0,
    memMi: 2,
    shell: false,
    defaultScript: (c) => {
      const port = [...(c.args ?? []), ...(c.command ?? [])].map((a) => a.match(/^--port=(\d+)$/)?.[1]).find(Boolean) ?? "80";
      return `echo "Starting up on port ${port}"; __serve whoami ${port}`;
    },
  },
  "hashicorp/http-echo": {
    tools: [],
    user: 65534,
    memMi: 2,
    shell: false,
    defaultScript: (c) => {
      const all = [...(c.command ?? []), ...(c.args ?? [])];
      const listen = all.find((a) => a.startsWith("-listen="))?.split(":").pop() ?? "5678";
      const text = all.find((a) => a.startsWith("-text="))?.slice(6).replace(/^["']|["']$/g, "") ?? "hello-world";
      return `echo "[INFO] server is listening on :${listen}"; __serve text ${listen} ${quoteArgv([text])}`;
    },
  },
};

export function imageInfo(image: string): ImageInfo | undefined {
  const built = builtImage(image);
  if (built) {
    const base = imageInfo(built.base) ?? IMAGES.busybox;
    const own = built.entrypoint.length || built.cmd.length;
    return {
      ...base,
      user: built.user ?? base.user,
      files: { ...(base.files ?? {}), ...built.files },
      dirs: [...(base.dirs ?? []), built.workdir],
      env: { ...(base.env ?? {}), ...built.env },
      workdir: built.workdir,
      entrypoint: own ? built.entrypoint : base.entrypoint,
      cmd: own ? built.cmd : base.cmd,
      defaultScript: own ? undefined : base.defaultScript,
    };
  }
  const p = parseImage(image);
  if (p.registry === "registry.k8s.io" && p.repository === "ingress-nginx/controller") {
    return {
      tools: BUSYBOX_TOOLS,
      user: 101,
      memMi: 90,
      shell: false,
      defaultScript: () =>
        `echo "-------------------------------------------------------------------------------"; echo "NGINX Ingress controller"; echo "  Release:       v1.14.0"; echo "-------------------------------------------------------------------------------"; echo 'I1114 10:00:01.000000       7 main.go:205] "Creating API client" host="https://10.96.0.1:443"'; echo 'I1114 10:00:02.000000       7 nginx.go:273] "Starting NGINX Ingress controller"'; __serve ingress 80,443`,
    };
  }
  if (p.registry === "registry.k8s.io" || p.registry === "k8s.gcr.io" || p.registry === "quay.io") {
    return { tools: BUSYBOX_TOOLS, user: 0, memMi: 15, shell: false, defaultScript: () => "sleep infinity" };
  }
  return IMAGES[p.repository];
}

/** What a container runs: its command and args, or the image default. */
export function processFor(c: ContainerSpec, env: Record<string, string>): { argv: string[] } | { script: string } {
  const info = imageInfo(c.image);
  // Like Kubernetes: command replaces ENTRYPOINT, args replaces CMD.
  const fromImage = info?.entrypoint?.length || info?.cmd?.length ? [...(c.command ?? info.entrypoint ?? []), ...(c.args ?? (c.command ? [] : info.cmd ?? []))] : [...(c.command ?? []), ...(c.args ?? [])];
  const argv = fromImage.map((a) => a.replace(/\$\(([A-Za-z_]\w*)\)/g, (m, k) => env[k] ?? m));
  // An interactive shell (kubectl run -it) waits for input instead of exiting.
  const shellOnly = argv.length === 0 ? !!info?.shell : argv.length === 1 && /^(\/bin\/)?(sh|bash|ash)$/.test(argv[0]);
  if (c.stdin && shellOnly) return { script: "sleep infinity" };
  if (argv.length) {
    const repo = parseImage(c.image).repository;
    const binary = repo === "hashicorp/http-echo" ? /^\/?(http-echo)$/ : repo === "traefik/whoami" ? /^\/?(whoami)$/ : undefined;
    if (binary && info?.defaultScript && (binary.test(argv[0]) || argv[0].startsWith("-"))) return { script: info.defaultScript({ ...c, command: [], args: argv.filter((a) => !binary.test(a)) }, env) };
    return { argv };
  }
  if (info?.defaultScript) return { script: info.defaultScript(c, env) };
  return { argv: [] };
}

/** Memory (in MiB) a container would use, for OOM kills and kubectl top. */
export function memoryUsageMi(c: ContainerSpec): number {
  const info = imageInfo(c.image);
  const all = [...(c.command ?? []), ...(c.args ?? [])].join(" ");
  const vm = all.match(/--vm-bytes\s+(\d+)([MG])/i);
  if (vm) return parseInt(vm[1], 10) * (vm[2].toUpperCase() === "G" ? 1024 : 1) + 1;
  return info?.memMi ?? 2;
}

// ------------------------------------------------------------------ security

export interface Identity {
  uid: number;
  gid: number;
  groups: number[];
  readOnlyRoot: boolean;
  caps: Set<string>;
  error?: string;
}

const DEFAULT_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "NET_BIND_SERVICE", "NET_RAW", "SYS_CHROOT", "MKNOD", "AUDIT_WRITE", "SETFCAP"];

/** The user, groups and capabilities a container runs with, or the config error the kubelet reports. */
export function identityFor(pod: KObject, c: ContainerSpec): Identity {
  const psc = pod.spec?.securityContext ?? {};
  const csc = (c.securityContext as Record<string, unknown> | undefined) ?? {};
  const info = imageInfo(c.image);
  const uid = (csc.runAsUser as number | undefined) ?? (psc.runAsUser as number | undefined) ?? info?.user ?? 0;
  const gid = (csc.runAsGroup as number | undefined) ?? (psc.runAsGroup as number | undefined) ?? (uid === 0 ? 0 : uid);
  const groups = [...((psc.supplementalGroups as number[] | undefined) ?? []), ...(psc.fsGroup !== undefined ? [psc.fsGroup as number] : [])];
  const nonRoot = (csc.runAsNonRoot as boolean | undefined) ?? (psc.runAsNonRoot as boolean | undefined);
  let error: string | undefined;
  if (nonRoot && uid === 0) {
    const explicit = (csc.runAsUser as number | undefined) ?? (psc.runAsUser as number | undefined);
    error = explicit === 0 ? "container's runAsUser breaks non-root policy" : `container has runAsNonRoot and image will run as root (pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${c.name})`;
  }
  const caps = new Set(csc.privileged ? [...DEFAULT_CAPS, "NET_ADMIN", "SYS_ADMIN", "SYS_TIME"] : DEFAULT_CAPS);
  const capSpec = (csc.capabilities as { add?: string[]; drop?: string[] } | undefined) ?? {};
  for (const d of capSpec.drop ?? []) {
    if (d.toUpperCase() === "ALL") caps.clear();
    else caps.delete(d.toUpperCase().replace(/^CAP_/, ""));
  }
  for (const a of capSpec.add ?? []) caps.add(a.toUpperCase().replace(/^CAP_/, ""));
  if (uid !== 0 && !csc.privileged) {
    caps.clear();
    for (const a of capSpec.add ?? []) caps.add(a.toUpperCase().replace(/^CAP_/, ""));
  }
  return { uid, gid, groups, readOnlyRoot: !!csc.readOnlyRootFilesystem, caps, error };
}

// ------------------------------------------------------------------ filesystem

interface Mount {
  path: string;
  readOnly: boolean;
  store?: Store;
  view?: () => Map<string, string>;
  subPath?: string;
}

const BASE_DIRS = ["/", "/bin", "/dev", "/etc", "/home", "/lib", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin", "/usr/sbin", "/usr/share", "/var", "/var/log", "/var/run", "/var/tmp", "/var/cache", "/var/lib"];

class ContainerFs implements Fs {
  private baseFiles: Map<string, string>;
  private baseDirs: Set<string>;
  constructor(
    private mounts: Mount[],
    private overlay: Store,
    base: Map<string, string>,
    dirs: string[],
    private uid: number,
    private readOnlyRoot: boolean,
    private writable: string[],
  ) {
    this.baseFiles = base;
    this.baseDirs = new Set(dirs);
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  private locate(path: string): { mount?: Mount; rel: string } {
    for (const m of this.mounts) {
      if (path === m.path || path.startsWith(m.path === "/" ? "/" : m.path + "/")) {
        let rel = path.slice(m.path.length) || "";
        if (m.subPath) rel = "/" + m.subPath + rel;
        return { mount: m, rel: normalizePath(rel || "/") };
      }
    }
    return { rel: path };
  }

  private mountRead(m: Mount, rel: string): string | undefined {
    if (m.view) {
      const v = m.view().get(rel);
      return v;
    }
    const v = m.store!.get(rel);
    return v === DIR || v === DELETED ? undefined : v;
  }

  private mountIsDir(m: Mount, rel: string): boolean {
    if (rel === "/" && !m.subPath) return true;
    const keys = m.view ? [...m.view().keys()] : [...m.store!.keys()];
    if (!m.view && m.store!.get(rel) === DIR) return true;
    if (m.view && rel === "/" ) return true;
    return keys.some((k) => k.startsWith(rel === "/" ? "/" : rel + "/") && (m.view || m.store!.get(k) !== DELETED));
  }

  read(path: string): string | undefined {
    path = normalizePath(path);
    const { mount, rel } = this.locate(path);
    if (mount) return this.mountRead(mount, rel);
    const o = this.overlay.get(path);
    if (o === DELETED || o === DIR) return undefined;
    if (o !== undefined) return o;
    return this.baseFiles.get(path);
  }

  isDir(path: string): boolean {
    path = normalizePath(path);
    const { mount, rel } = this.locate(path);
    if (mount) return this.mountIsDir(mount, rel);
    if (this.overlay.get(path) === DELETED) return false;
    if (this.overlay.get(path) === DIR || this.baseDirs.has(path)) return true;
    if (this.mounts.some((m) => m.path.startsWith(path === "/" ? "/" : path + "/"))) return true;
    const prefix = path === "/" ? "/" : path + "/";
    for (const [k, v] of this.overlay) if (k.startsWith(prefix) && v !== DELETED) return true;
    for (const k of this.baseFiles.keys()) if (k.startsWith(prefix) && this.overlay.get(k) !== DELETED) return true;
    return false;
  }

  list(dir: string): string[] | undefined {
    dir = normalizePath(dir);
    if (!this.isDir(dir)) return undefined;
    const names = new Set<string>();
    const add = (full: string, prefix: string) => {
      if (!full.startsWith(prefix) || full === prefix.replace(/\/$/, "")) return;
      const n = full.slice(prefix.length).split("/")[0];
      if (n) names.add(n);
    };
    const { mount, rel } = this.locate(dir);
    if (mount) {
      const prefix = rel === "/" ? "/" : rel + "/";
      const keys = mount.view ? [...mount.view().keys()] : [...mount.store!.entries()].filter(([, v]) => v !== DELETED).map(([k]) => k);
      for (const k of keys) add(k, prefix);
    } else {
      const prefix = dir === "/" ? "/" : dir + "/";
      for (const d of this.baseDirs) add(d, prefix);
      for (const k of this.baseFiles.keys()) if (this.overlay.get(k) !== DELETED) add(k, prefix);
      for (const [k, v] of this.overlay) if (v !== DELETED) add(k, prefix);
    }
    for (const m of this.mounts) add(m.path, dir === "/" ? "/" : dir + "/");
    return [...names].sort();
  }

  private writeCheck(path: string): { mount?: Mount; rel: string; error?: string } {
    const loc = this.locate(path);
    if (loc.mount) {
      if (loc.mount.readOnly || loc.mount.view) return { ...loc, error: "Read-only file system" };
      return loc;
    }
    if (this.readOnlyRoot) return { ...loc, error: "Read-only file system" };
    if (this.uid !== 0 && !this.writable.some((w) => path === w || path.startsWith(w + "/"))) return { ...loc, error: "Permission denied" };
    return loc;
  }

  write(path: string, data: string, append: boolean): string | undefined {
    path = normalizePath(path);
    if (this.isDir(path)) return "Is a directory";
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!this.isDir(parent)) return "No such file or directory";
    const w = this.writeCheck(path);
    if (w.error) return w.error;
    if (w.mount) {
      const old = this.mountRead(w.mount, w.rel) ?? "";
      w.mount.store!.set(w.rel, append ? old + data : data);
      return undefined;
    }
    const old = this.read(path) ?? "";
    this.overlay.set(path, append ? old + data : data);
    return undefined;
  }

  remove(path: string, recursive: boolean): string | undefined {
    path = normalizePath(path);
    const w = this.writeCheck(path);
    if (w.error) return w.error;
    if (this.mounts.some((m) => m.path === path)) return "Resource busy";
    if (w.mount) {
      const store = w.mount.store!;
      store.delete(w.rel);
      if (recursive) for (const k of [...store.keys()]) if (k.startsWith(w.rel + "/")) store.delete(k);
      return undefined;
    }
    this.overlay.set(path, DELETED);
    if (recursive) {
      const prefix = path + "/";
      for (const k of [...this.overlay.keys()]) if (k.startsWith(prefix)) this.overlay.set(k, DELETED);
      for (const k of this.baseFiles.keys()) if (k.startsWith(prefix)) this.overlay.set(k, DELETED);
    }
    return undefined;
  }

  mkdir(path: string, parents: boolean): string | undefined {
    path = normalizePath(path);
    if (this.isDir(path)) return parents ? undefined : "File exists";
    if (this.read(path) !== undefined) return "File exists";
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!this.isDir(parent)) {
      if (!parents) return "No such file or directory";
      const e = this.mkdir(parent, true);
      if (e) return e;
    }
    const w = this.writeCheck(path);
    if (w.error) return w.error;
    if (w.mount) w.mount.store!.set(w.rel, DIR);
    else this.overlay.set(path, DIR);
    return undefined;
  }
}

function persistentStore(cluster: Cluster, key: string): Store {
  let s = cluster.scratch.get(key) as Store | undefined;
  if (!s) {
    s = new Map();
    cluster.scratch.set(key, s);
  }
  return s;
}

function viewOf(cluster: Cluster, pod: KObject, v: Record<string, any>): (() => Map<string, string>) | undefined {
  const ns = pod.metadata.namespace ?? "default";
  const cmView = (src: { name: string; items?: { key: string; path: string }[] }) => () => {
    const cm = cluster.get("ConfigMap", src.name, ns);
    const data = { ...((cm?.data as Record<string, string>) ?? {}) };
    const out = new Map<string, string>();
    if (src.items) for (const it of src.items) out.set("/" + it.path, data[it.key] ?? "");
    else for (const [k, val] of Object.entries(data)) out.set("/" + k, String(val));
    return out;
  };
  const secretView = (src: { secretName?: string; name?: string; items?: { key: string; path: string }[] }) => () => {
    const s = cluster.get("Secret", src.secretName ?? src.name ?? "", ns);
    const data = (s?.data as Record<string, string>) ?? {};
    const out = new Map<string, string>();
    if (src.items) for (const it of src.items) out.set("/" + it.path, fromBase64(data[it.key] ?? ""));
    else for (const [k, val] of Object.entries(data)) out.set("/" + k, fromBase64(String(val)));
    return out;
  };
  const downwardView = (src: { items?: { path: string; fieldRef?: { fieldPath: string }; resourceFieldRef?: { resource: string; containerName?: string } }[] }) => () => {
    const out = new Map<string, string>();
    for (const it of src.items ?? []) {
      if (it.fieldRef) out.set("/" + it.path, fieldValue(pod, it.fieldRef.fieldPath));
      else if (it.resourceFieldRef) out.set("/" + it.path, resourceValue(pod, it.resourceFieldRef.containerName ?? "", it.resourceFieldRef.resource));
    }
    return out;
  };
  if (v.configMap) return cmView(v.configMap);
  if (v.secret) return secretView(v.secret);
  if (v.downwardAPI) return downwardView(v.downwardAPI);
  if (v.projected) {
    const parts = (v.projected.sources ?? []).map((src: Record<string, any>) => {
      if (src.configMap) return cmView(src.configMap);
      if (src.secret) return secretView(src.secret);
      if (src.downwardAPI) return downwardView(src.downwardAPI);
      if (src.serviceAccountToken) return () => new Map([["/" + (src.serviceAccountToken.path ?? "token"), saToken(pod, src.serviceAccountToken.audience)]]);
      return () => new Map<string, string>();
    });
    return () => {
      const out = new Map<string, string>();
      for (const p of parts) for (const [k, val] of p()) out.set(k, val);
      return out;
    };
  }
  return undefined;
}

function saToken(pod: KObject, audience?: string): string {
  const header = btoa(JSON.stringify({ alg: "RS256", kid: "podsim" })).replace(/=+$/, "");
  const payload = btoa(
    JSON.stringify({
      aud: [audience ?? "https://kubernetes.default.svc.cluster.local"],
      iss: "https://kubernetes.default.svc.cluster.local",
      sub: `system:serviceaccount:${pod.metadata.namespace ?? "default"}:${pod.spec?.serviceAccountName ?? "default"}`,
      "kubernetes.io": { namespace: pod.metadata.namespace ?? "default", pod: { name: pod.metadata.name }, serviceaccount: { name: pod.spec?.serviceAccountName ?? "default" } },
    }),
  ).replace(/=+$/, "");
  return `${header}.${payload}.c2ltdWxhdGVkLXNpZ25hdHVyZQ`;
}

const ROOT_CA = "-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIk8sim0k8sim0wDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\n...simulated certificate, not a real key...\n-----END CERTIFICATE-----\n";

function automount(cluster: Cluster, pod: KObject): boolean {
  if (pod.spec?.automountServiceAccountToken !== undefined) return !!pod.spec.automountServiceAccountToken;
  const sa = cluster.get("ServiceAccount", pod.spec?.serviceAccountName ?? "default", pod.metadata.namespace);
  if (sa && sa.automountServiceAccountToken !== undefined) return !!sa.automountServiceAccountToken;
  return true;
}

/** Build the filesystem a container sees. `overlay` holds its own writes and lives as long as the container. */
export function containerFs(cluster: Cluster, pod: KObject, c: ContainerSpec, sim: PodSim, overlay: Store, id: Identity): ContainerFs {
  const ns = pod.metadata.namespace ?? "default";
  const vols = new Map<string, Record<string, any>>((pod.spec?.volumes ?? []).map((v: { name: string }) => [v.name, v]));
  const mounts: Mount[] = [];
  sim.emptyDirs = sim.emptyDirs ?? {};
  for (const vm of (c.volumeMounts ?? []) as { name: string; mountPath: string; readOnly?: boolean; subPath?: string }[]) {
    const v = vols.get(vm.name);
    if (!v) continue;
    const path = normalizePath(vm.mountPath);
    const view = viewOf(cluster, pod, v);
    if (view) {
      mounts.push({ path, readOnly: true, view, subPath: vm.subPath });
      continue;
    }
    let store: Store;
    if (v.persistentVolumeClaim) {
      const claim = cluster.get("PersistentVolumeClaim", v.persistentVolumeClaim.claimName, ns);
      store = persistentStore(cluster, claim?.spec?.volumeName ? `pv/${claim.spec.volumeName}` : `pvc/${ns}/${v.persistentVolumeClaim.claimName}`);
    }
    else if (v.hostPath) {
      const node = pod.spec?.nodeName ?? "node";
      const all = persistentStore(cluster, `hostpath/${node}`);
      const base = normalizePath(v.hostPath.path ?? "/");
      store = new Proxy(all, {
        get(target, prop) {
          if (prop === "get") return (k: string) => target.get(normalizePath(base + k));
          if (prop === "set") return (k: string, val: string) => target.set(normalizePath(base + k), val);
          if (prop === "delete") return (k: string) => target.delete(normalizePath(base + k));
          if (prop === "keys") return () => [...target.keys()].filter((k) => k.startsWith(base)).map((k) => k.slice(base.length) || "/")[Symbol.iterator]();
          if (prop === "entries") return () => [...target.entries()].filter(([k]) => k.startsWith(base)).map(([k, val]) => [k.slice(base.length) || "/", val])[Symbol.iterator]();
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Store;
    } else {
      sim.emptyDirs[vm.name] = sim.emptyDirs[vm.name] ?? new Map();
      store = sim.emptyDirs[vm.name];
    }
    if (vm.subPath && !store.has("/" + vm.subPath)) store.set("/" + vm.subPath, DIR);
    mounts.push({ path, readOnly: !!vm.readOnly, store, subPath: vm.subPath });
  }
  if (automount(cluster, pod) && !mounts.some((m) => m.path === "/var/run/secrets/kubernetes.io/serviceaccount")) {
    mounts.push({
      path: "/var/run/secrets/kubernetes.io/serviceaccount",
      readOnly: true,
      view: () =>
        new Map([
          ["/token", saToken(pod)],
          ["/ca.crt", ROOT_CA],
          ["/namespace", ns],
        ]),
    });
  }
  const info = imageInfo(c.image);
  const base = new Map<string, string>(Object.entries(info?.files ?? {}));
  base.set("/etc/hostname", (pod.spec?.hostname ?? pod.metadata.name) + "\n");
  base.set("/etc/hosts", `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${pod.status?.podIP ?? ""}\t${pod.spec?.hostname ? `${pod.spec.hostname}.${pod.spec.subdomain}.${ns}.svc.cluster.local\t${pod.spec.hostname}` : pod.metadata.name}\n`);
  base.set("/etc/resolv.conf", `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
  base.set("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/home:/bin/false\n");
  base.set("/etc/group", "root:x:0:\nnobody:x:65534:\n");
  base.set("/etc/os-release", info?.shell && parseImage(c.image).repository === "busybox" ? 'NAME="BusyBox"\n' : 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\n');
  base.set("/proc/version", "Linux version 6.8.0-79-generic (simulated)\n");
  const dirs = [...BASE_DIRS, ...(info?.dirs ?? [])];
  if (pod.spec?.nodeName) base.set("/etc/podsim-node", pod.spec.nodeName);
  const writable = ["/tmp", "/var/tmp", "/dev/shm", "/home"];
  if (parseImage(c.image).repository === "nginxinc/nginx-unprivileged") writable.push("/var/cache/nginx", "/run", "/etc/nginx/conf.d");
  if (parseImage(c.image).repository.startsWith("bitnami/")) writable.push("/var/cache/nginx", "/app", "/opt/bitnami", "/tmp");
  return new ContainerFs(mounts, overlay, base, dirs, id.uid, id.readOnlyRoot, writable);
}

// ------------------------------------------------------------------ process host

export function toolsFor(image: string): Set<string> | null {
  const info = imageInfo(image);
  if (!info) return new Set(BUSYBOX_TOOLS);
  return new Set(info.tools);
}

/** Everything a process in this container needs to run. */
export function hostFor(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim): Host {
  const sim = cluster.podSims.get(pod.metadata.uid!) ?? ({ containers: {} } as PodSim);
  cs.overlay = cs.overlay ?? new Map();
  const id = identityFor(pod, c);
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(imageInfo(c.image)?.env ?? {}),
    ...serviceEnv(cluster, pod.metadata.namespace ?? "default"),
    ...resolveEnv(cluster, pod, c).env,
    HOSTNAME: pod.spec?.hostname ?? pod.metadata.name,
    HOME: id.uid === 0 ? "/root" : "/",
  };
  const fsRef = containerFs(cluster, pod, c, sim, cs.overlay, id);
  return {
    now: () => cluster.now(),
    fs: fsRef,
    tools: toolsFor(c.image),
    env,
    hostname: pod.spec?.hostname ?? pod.metadata.name,
    podIP: pod.status?.podIP ?? sim.fixedIp ?? "",
    uid: id.uid,
    gid: id.gid,
    groups: id.groups,
    caps: id.caps,
    image: parseImage(c.image).repository,
    net: (cmd, args, stdin, at) => netCommand(cluster, pod, cmd, args, stdin, at, fsRef),
  };
}

/** Start the container's main process at virtual time `at`. */
export function startProcess(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, at: number): Proc {
  cs.overlay = new Map();
  const host = hostFor(cluster, pod, c, cs);
  const what = processFor(c, host.env);
  const proc = new Proc(host, "argv" in what ? what.argv : what, at, (c.command ?? c.args ?? ["sh"])[0] ?? "sh");
  const wd = (c.workingDir as string | undefined) ?? imageInfo(c.image)?.workdir;
  if (wd) proc.x.vars.PWD = wd;
  return proc;
}

setPortChecker((x, port) => {
  void x;
  void port;
  return false;
});

/** Run a command in a running container right now (kubectl exec, exec probes). */
export function execInContainer(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, argv: string[] | { script: string }, stdin = "", vars?: Record<string, string>): { stdout: string; stderr: string; code: number; blocked?: string; vars?: Record<string, string>; exited?: boolean } {
  const host = hostFor(cluster, pod, c, cs);
  return execNow(host, argv, { stdin, vars });
}

// ------------------------------------------------------------------ network

export interface Target {
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
    const pod = cluster.list("Pod").find((p) => p.status?.podIP === h && !p.spec?.hostNetwork);
    return { ip: h, pod };
  }
  if (h === "localhost") return { ip: "127.0.0.1" };
  const parts = h.replace(/\.cluster\.local$/, "").split(".");
  // <hostname>.<headless-service>[.<namespace>[.svc]] resolves to one pod, as for StatefulSets.
  if (parts.length >= 2 && parts[1] !== "svc") {
    const podNs = parts.length >= 3 && parts[2] !== "svc" ? parts[2] : ns;
    const headless = cluster.get("Service", parts[1], podNs);
    if (headless && headless.spec?.clusterIP === "None" && (parts.length < 4 || parts[3] === "svc")) {
      const pod = cluster.list("Pod", podNs).find((p) => p.spec?.hostname === parts[0] && p.spec?.subdomain === parts[1] && p.status?.podIP);
      if (pod) return { ip: pod.status.podIP, fqdn: `${parts[0]}.${parts[1]}.${podNs}.svc.cluster.local`, pod };
    }
  }
  // <a-b-c-d>.<namespace>.pod
  if (parts.length === 3 && parts[2] === "pod" && /^\d+-\d+-\d+-\d+$/.test(parts[0])) {
    const ip = parts[0].replace(/-/g, ".");
    const pod = cluster.list("Pod", parts[1]).find((p) => p.status?.podIP === ip);
    return { ip, pod };
  }
  const svcName = parts[0];
  let svcNs = ns;
  if (parts.length >= 2 && parts[1] !== "svc") svcNs = parts[1];
  if (parts.length >= 3 && parts[2] !== "svc") return undefined;
  if (parts.length === 2 && parts[1] === "svc") return undefined;
  if (!svcName) return undefined;
  const svc = cluster.get("Service", svcName, svcNs);
  if (!svc || !cluster.get("Namespace", svcNs)) return undefined;
  if (svc.spec?.type === "ExternalName") return { ip: "", fqdn: svc.spec.externalName, service: svc };
  if (svc.spec?.clusterIP === "None") {
    const pod = cluster.list("Pod", svcNs).find((p) => matchMap(p.metadata.labels, svc.spec.selector) && p.status?.podIP && isReady(p));
    return { ip: pod?.status?.podIP ?? "", fqdn: `${svcName}.${svcNs}.svc.cluster.local`, service: svc, pod };
  }
  return { ip: svc.spec.clusterIP, fqdn: `${svcName}.${svcNs}.svc.cluster.local`, service: svc };
}

function isReady(p: KObject): boolean {
  return (p.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True");
}

/** Hook for NetworkPolicy: may traffic from `from` reach `to` on `port`? */
let policyCheck: (cluster: Cluster, from: KObject | undefined, to: KObject, port: number, protocol: string) => boolean = () => true;
let egressCheck: (cluster: Cluster, from: KObject | undefined, toIp: string, port: number, protocol: string, to?: KObject) => boolean = () => true;
let dnsCheck: (cluster: Cluster, from: KObject | undefined) => boolean = () => true;
export function setPolicyChecks(ingress: typeof policyCheck, egress: typeof egressCheck, dns?: typeof dnsCheck): void {
  policyCheck = ingress;
  egressCheck = egress;
  if (dns) dnsCheck = dns;
}

const NODE_NAMES = ["controlplane", "node01", "node02", "node03", "node04"];

/** The node an address or name refers to, if any. */
function nodeFor(cluster: Cluster, host: string, from: KObject | undefined): KObject | undefined {
  const h = host.toLowerCase();
  if ((h === "localhost" || h === "127.0.0.1") && !from) return cluster.get("Node", "controlplane");
  return cluster.list("Node").find((n) => n.metadata.name === h || (n.status?.addresses ?? []).some((a: { address: string }) => a.address === h));
}

export type Conn =
  | { ok: true; pod: KObject; container: ContainerSpec; cs: ContainerSim; server: Server; port: number }
  | { ok: false; error: "refused" | "timeout" | "unresolved" | "noendpoints" };

/** Find which container (if any) accepts a connection on pod:port. */
export function podListener(cluster: Cluster, pod: KObject, port: number): { container: ContainerSpec; cs: ContainerSim; server: Server } | undefined {
  const sim = cluster.podSims.get(pod.metadata.uid!);
  if (!sim) return undefined;
  for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])] as ContainerSpec[]) {
    const cs = sim.containers[c.name];
    if (!cs || cs.phase !== "running" || !cs.proc) continue;
    const server = cs.proc.listens.get(port);
    if (server) return { container: c, cs, server };
  }
  return undefined;
}

/** Open a connection from `from` (a pod, or undefined for a node) to host:port, following Services. */
export function connect(cluster: Cluster, from: KObject | undefined, ns: string, host: string, port: number, protocol = "TCP"): { conn: Conn; target?: Target } {
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (!from && (host === "localhost" || host === "127.0.0.1")) {
    const fwd = (cluster.scratch.get("portforwards") as Record<number, { pod: string; ns: string; port: number }> | undefined)?.[port];
    if (fwd) {
      const pod = cluster.get("Pod", fwd.pod, fwd.ns);
      const l = pod ? podListener(cluster, pod, fwd.port) : undefined;
      return { conn: pod && l ? { ok: true, pod, port: fwd.port, ...l } : { ok: false, error: "refused" }, target: { ip: "127.0.0.1", pod } };
    }
  }
  const node = nodeFor(cluster, host, from);
  if (node && (isIp || NODE_NAMES.includes(host.toLowerCase()) || host === "localhost" || host === "127.0.0.1")) {
    const nodeIp = (node.status?.addresses ?? []).find((a: { type: string }) => a.type === "InternalIP")?.address ?? host;
    const svc = cluster.list("Service").find((sv) => (sv.spec?.ports ?? []).some((p: { nodePort?: number }) => p.nodePort === port));
    if (!svc) return { conn: { ok: false, error: "refused" }, target: { ip: nodeIp } };
    const sp = svc.spec.ports.find((p: { nodePort?: number }) => p.nodePort === port);
    return connect(cluster, from, svc.metadata.namespace ?? "default", svc.spec.clusterIP, sp.port, protocol);
  }
  if (!isIp && host !== "localhost" && !dnsCheck(cluster, from)) return { conn: { ok: false, error: "unresolved" } };
  if (!from && !isIp && host !== "localhost") return { conn: { ok: false, error: "unresolved" } };
  const target = resolveHost(cluster, ns, host);
  if (!target) return { conn: { ok: false, error: "unresolved" } };
  if (target.ip === "127.0.0.1" && from) {
    const l = podListener(cluster, from, port);
    return { conn: l ? { ok: true, pod: from, port, ...l } : { ok: false, error: "refused" }, target };
  }
  let pod = target.pod;
  let podPort = port;
  if (target.service && target.service.spec?.clusterIP !== "None") {
    const svc = target.service;
    if (svc.spec?.type === "ExternalName") return { conn: { ok: false, error: "timeout" }, target };
    const sp = (svc.spec.ports ?? []).find((p: { port: number }) => p.port === port);
    if (!sp) return { conn: { ok: false, error: "timeout" }, target };
    if (!egressCheck(cluster, from, svc.spec.clusterIP, port, protocol)) return { conn: { ok: false, error: "timeout" }, target };
    const ready = cluster.list("Pod", svc.metadata.namespace).filter((p) => svc.spec.selector && matchMap(p.metadata.labels, svc.spec.selector) && isReady(p) && p.status?.podIP);
    if (ready.length === 0) return { conn: { ok: false, error: "refused" }, target };
    const key = `rr/${svc.metadata.uid}`;
    const n = ((cluster.scratch.get(key) as number | undefined) ?? 0) + 1;
    cluster.scratch.set(key, n);
    pod = ready[n % ready.length];
    const tp = sp.targetPort;
    if (typeof tp === "number") podPort = tp;
    else if (/^\d+$/.test(String(tp))) podPort = parseInt(String(tp), 10);
    else {
      const named = (pod.spec.containers ?? []).flatMap((c: ContainerSpec) => c.ports ?? []).find((p: { name?: string }) => p.name === tp);
      podPort = named?.containerPort ?? -1;
    }
  } else if (target.service && target.service.spec?.clusterIP === "None" && !pod) {
    return { conn: { ok: false, error: "unresolved" }, target };
  }
  if (!pod) return { conn: { ok: false, error: "timeout" }, target };
  if (!egressCheck(cluster, from, pod.status?.podIP ?? "", podPort, protocol, pod)) return { conn: { ok: false, error: "timeout" }, target };
  if (!policyCheck(cluster, from, pod, podPort, protocol)) return { conn: { ok: false, error: "timeout" }, target };
  const l = podListener(cluster, pod, podPort);
  if (!l) return { conn: { ok: false, error: "refused" }, target };
  return { conn: { ok: true, pod, port: podPort, ...l }, target };
}

export interface HttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 301: "Moved Permanently", 302: "Found", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Temporarily Unavailable", 504: "Gateway Time-out" };
export const statusText = (n: number) => STATUS_TEXT[n] ?? "";

function nginxErrorPage(code: number): string {
  return `<html>\n<head><title>${code} ${statusText(code)}</title></head>\n<body>\n<center><h1>${code} ${statusText(code)}</h1></center>\n<hr><center>nginx/1.29.3</center>\n</body>\n</html>\n`;
}

/** Handle an HTTP GET in a container that is listening with `server`. */
export function serveHttp(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim, server: Server, path: string, client: { ip: string; agent: string }, hostHeader = ""): HttpResponse | undefined {
  const host = hostFor(cluster, pod, c, cs);
  const fs = host.fs;
  path = path.split("?")[0] || "/";
  let res: HttpResponse | undefined;
  switch (server.kind) {
    case "tcp":
      return undefined;
    case "ingress":
      return ingressRoute(cluster, pod, hostHeader, path, client);
    case "text":
      res = { status: 200, body: server.body.endsWith("\n") ? server.body : server.body + "\n" };
      break;
    case "whoami":
      res = { status: 200, body: `Hostname: ${pod.metadata.name}\nIP: 127.0.0.1\nIP: ${pod.status?.podIP}\nRemoteAddr: ${client.ip}:41234\nGET ${path} HTTP/1.1\nHost: ${hostHeader || pod.status?.podIP}\nUser-Agent: ${client.agent}\nAccept: */*\n` };
      break;
    case "nginx": {
      const conf = [...(fs.list("/etc/nginx/conf.d") ?? []).filter((n) => n.endsWith(".conf")).map((n) => fs.read(`/etc/nginx/conf.d/${n}`) ?? ""), fs.read("/etc/nginx/nginx.conf") ?? ""].join("\n");
      const ret = [...conf.matchAll(/location\s+(=\s*)?(\S+)\s*\{([^}]*)\}/g)]
        .map((m) => ({ exact: !!m[1], loc: m[2], body: m[3] }))
        .filter((l) => (l.exact ? path === l.loc : path.startsWith(l.loc)))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || b.loc.length - a.loc.length)[0];
      const retMatch = ret?.body.match(/return\s+(\d+)(?:\s+(?:"([^"]*)"|'([^']*)'|([^;\s]+)))?\s*;/);
      if (retMatch) {
        const code = parseInt(retMatch[1], 10);
        res = { status: code, body: (retMatch[2] ?? retMatch[3] ?? retMatch[4] ?? "").replace(/\\n/g, "\n") };
        break;
      }
      const root = (ret?.body.match(/root\s+([^;]+);/)?.[1] ?? conf.match(/root\s+([^;]+);/)?.[1] ?? "/usr/share/nginx/html").trim();
      res = staticFile(fs, root, path, "nginx");
      break;
    }
    case "static":
      res = staticFile(fs, server.root, path, server.style);
      break;
  }
  if (res && server.kind === "nginx" && cs.proc) {
    const ts = formatDate(cluster.now(), "%d/%b/%Y:%H:%M:%S +0000");
    cs.proc.write(`${client.ip} - - [${ts}] "GET ${path} HTTP/1.1" ${res.status} ${res.body.length} "-" "${client.agent}" "-"\n`);
  }
  return res;
}

function staticFile(fs: Fs, root: string, path: string, style: "nginx" | "busybox" | "python"): HttpResponse {
  const full = normalizePath(`${root}/${path}`);
  if (fs.isDir(full)) {
    const idx = fs.read(`${full}/index.html`) ?? fs.read(`${full}/index.htm`);
    if (idx !== undefined) return { status: 200, body: idx };
    if (style === "python") {
      const items = (fs.list(full) ?? []).map((n) => `<li><a href="${n}">${n}</a></li>`).join("\n");
      return { status: 200, body: `<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<title>Directory listing for ${path}</title>\n</head>\n<body>\n<h1>Directory listing for ${path}</h1>\n<hr>\n<ul>\n${items}\n</ul>\n<hr>\n</body>\n</html>\n` };
    }
    return style === "nginx" ? { status: 403, body: nginxErrorPage(403) } : { status: 404, body: "<HTML><HEAD><TITLE>404 Not Found</TITLE></HEAD>\n<BODY><H1>404 Not Found</H1>\nThe requested URL was not found\n</BODY></HTML>\n" };
  }
  const f = fs.read(full);
  if (f !== undefined) return { status: 200, body: f };
  return style === "nginx" ? { status: 404, body: nginxErrorPage(404) } : { status: 404, body: "<HTML><HEAD><TITLE>404 Not Found</TITLE></HEAD>\n<BODY><H1>404 Not Found</H1>\nThe requested URL was not found\n</BODY></HTML>\n" };
}

/** One HTTP request from a pod (or a node when `from` is undefined). */
/** The ingress-nginx controller: pick an Ingress rule by host and path and proxy to its Service. */
function ingressRoute(cluster: Cluster, controller: KObject, hostHeader: string, path: string, client: { ip: string; agent: string }): HttpResponse {
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  const classes = cluster.list("IngressClass").filter((c) => c.spec?.controller === "k8s.io/ingress-nginx");
  const defaultClass = classes.find((c) => c.metadata.annotations?.["ingressclass.kubernetes.io/is-default-class"] === "true")?.metadata.name;
  const mine = new Set(classes.map((c) => c.metadata.name));
  const notFound = (): HttpResponse => ({ status: 404, body: nginxErrorPage(404) });
  type Cand = { ing: KObject; rule: Record<string, any>; p: Record<string, any>; score: number };
  const cands: Cand[] = [];
  for (const ing of cluster.list("Ingress")) {
    const cls = ing.spec?.ingressClassName ?? ing.metadata.annotations?.["kubernetes.io/ingress.class"] ?? defaultClass;
    if (!cls || !mine.has(cls)) continue;
    const regex = ing.metadata.annotations?.["nginx.ingress.kubernetes.io/use-regex"] === "true";
    for (const rule of (ing.spec?.rules ?? []) as Record<string, any>[]) {
      const rh = (rule.host ?? "").toLowerCase();
      const hostOk = !rh || rh === host || (rh.startsWith("*.") && host.endsWith(rh.slice(1)) && host.split(".").length === rh.split(".").length);
      if (!hostOk) continue;
      for (const p of rule.http?.paths ?? []) {
        const pp: string = p.path ?? "/";
        let ok = false;
        if (regex || /[()$^*]/.test(pp)) {
          try {
            ok = new RegExp("^" + pp).test(path);
          } catch {
            ok = false;
          }
        } else if (p.pathType === "Exact") ok = path === pp;
        else ok = pp === "/" || path === pp || path.startsWith(pp.replace(/\/$/, "") + "/");
        if (ok) cands.push({ ing, rule, p, score: (rh ? 1000 : 0) + pp.length + (p.pathType === "Exact" ? 500 : 0) });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const hit = cands[0];
  let backend = hit?.p.backend;
  let ing = hit?.ing;
  if (!hit) {
    const def = cluster.list("Ingress").find((i) => i.spec?.defaultBackend && mine.has(i.spec?.ingressClassName ?? defaultClass ?? ""));
    if (!def) return notFound();
    backend = def.spec.defaultBackend;
    ing = def;
  }
  const svcName = backend?.service?.name;
  const svc = svcName ? cluster.get("Service", svcName, ing!.metadata.namespace) : undefined;
  if (!svc) return { status: 503, body: nginxErrorPage(503) };
  const portSpec = backend.service.port ?? {};
  const sp = (svc.spec.ports ?? []).find((x: { port: number; name?: string }) => (portSpec.number !== undefined ? x.port === portSpec.number : x.name === portSpec.name));
  if (!sp) return { status: 503, body: nginxErrorPage(503) };
  let upstreamPath = path;
  const rewrite = ing!.metadata.annotations?.["nginx.ingress.kubernetes.io/rewrite-target"];
  if (rewrite && hit) {
    const pp: string = hit.p.path ?? "/";
    const m = path.match(new RegExp("^" + (/[()]/.test(pp) ? pp : pp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(.*)")));
    upstreamPath = m ? rewrite.replace(/\$(\d)/g, (_: string, n: string) => m[parseInt(n, 10)] ?? "") : rewrite;
    if (!/[()]/.test(pp) && rewrite === "/") upstreamPath = "/" + (m?.[1] ?? "").replace(/^\//, "");
    if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;
  }
  const { conn } = connect(cluster, controller, svc.metadata.namespace ?? "default", svc.spec.clusterIP, sp.port);
  if (!conn.ok) return { status: conn.error === "refused" && !cluster.list("Pod", svc.metadata.namespace).some((p) => svc.spec.selector && matchMap(p.metadata.labels, svc.spec.selector) && isReady(p)) ? 503 : 502, body: nginxErrorPage(conn.error === "refused" ? 503 : 504) };
  const res = serveHttp(cluster, conn.pod, conn.container, conn.cs, conn.server, upstreamPath, { ip: controller.status?.podIP ?? "", agent: client.agent }, hostHeader);
  return res ?? { status: 502, body: nginxErrorPage(502) };
}

export function httpRequest(cluster: Cluster, from: KObject | undefined, ns: string, url: string, agent: string, hostHeader?: string): { res?: HttpResponse; error?: string; host: string; port: number; ip?: string } {
  const m = url.match(/^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return { error: "unresolved", host: url, port: 80 };
  const host = m[2];
  const port = m[3] ? parseInt(m[3], 10) : m[1] === "https" ? 443 : 80;
  const path = m[4] ?? "/";
  if (m[1] === "https" && !(port === 443 || port === 30443)) return { error: "tls", host, port };
  const { conn, target } = connect(cluster, from, ns, host, port);
  if (!conn.ok) return { error: conn.error, host, port, ip: target?.ip };
  const res = serveHttp(cluster, conn.pod, conn.container, conn.cs, conn.server, path, { ip: from?.status?.podIP ?? "10.244.0.1", agent }, hostHeader ?? host);
  if (!res) return { error: "reset", host, port, ip: target?.ip };
  return { res, host, port, ip: target?.ip };
}

// ------------------------------------------------------------------ network commands

function wget(cluster: Cluster, from: KObject | undefined, ns: string, args: string[]): NetResult {
  let quiet = false;
  let toStdout = false;
  let spider = false;
  let outFile: string | undefined;
  let url = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-q" || a === "--quiet") quiet = true;
    else if (/^-q?O-?$/.test(a) || a === "-qO-" || a === "-Oq-" || a === "-O-") {
      if (a.includes("q")) quiet = true;
      if (a.endsWith("-")) toStdout = true;
      else {
        const next = args[++i];
        if (next === "-") toStdout = true;
        else outFile = next;
      }
    } else if (a === "--spider") spider = true;
    else if (a === "-T" || a === "--timeout" || a === "-U" || a === "--header") i++;
    else if (a.startsWith("--timeout=") || /^-T\d+$/.test(a) || a.startsWith("--header=")) continue;
    else if (!a.startsWith("-")) url = a;
  }
  if (!url) return { stdout: "", stderr: "BusyBox v1.37.0 (2024-09-26 21:31:42 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-T SEC] URL...\n", code: 1 };
  const r = httpRequest(cluster, from, ns, url, "Wget");
  const hp = `${r.host}${r.port !== 80 ? ":" + r.port : ""}`;
  const connecting = quiet ? "" : `Connecting to ${hp} (${r.ip}:${r.port})\n`;
  if (r.error) {
    if (r.error === "unresolved") return { stdout: "", stderr: `wget: bad address '${r.host}'\n`, code: 1 };
    if (r.error === "refused") return { stdout: "", stderr: `${connecting}wget: can't connect to remote host (${r.ip}): Connection refused\n`, code: 1 };
    if (r.error === "reset") return { stdout: "", stderr: `${connecting}wget: error getting response: Connection reset by peer\n`, code: 1 };
    if (r.error === "tls") return { stdout: "", stderr: `${connecting}wget: error getting response: Connection reset by peer\n`, code: 1 };
    return { stdout: "", stderr: `${connecting}wget: download timed out\n`, code: 1 };
  }
  const res = r.res!;
  if (res.status >= 400) return { stdout: "", stderr: `${connecting}wget: server returned error: HTTP/1.1 ${res.status} ${statusText(res.status)}\n`, code: 1 };
  if (spider) return { stdout: "", stderr: quiet ? "" : `${connecting}remote file exists\n`, code: 0 };
  if (toStdout) return { stdout: res.body, stderr: quiet ? "" : `${connecting}writing to stdout\n-                    100% |********************************|   ${res.body.length}  0:00:00 ETA\nwritten to stdout\n`, code: 0 };
  const name = outFile ?? (url.split("?")[0].replace(/\/$/, "").split("/").length > 3 ? url.split("/").pop() || "index.html" : "index.html");
  return { stdout: "", stderr: quiet ? "" : `${connecting}saving to '${name}'\n${name.padEnd(20)} 100% |********************************|   ${res.body.length}  0:00:00 ETA\n'${name}' saved\n`, code: 0, saveAs: { name, body: res.body } } as NetResult;
}

function isApiServer(cluster: Cluster, ns: string, host: string, port: number): boolean {
  const t = resolveHost(cluster, ns, host);
  if (t?.service && t.service.metadata.name === "kubernetes" && t.service.metadata.namespace === "default" && port === 443) return true;
  return port === 6443 && (host === "192.168.56.10" || host === "controlplane");
}

function curlApi(cluster: Cluster, url: string, headers: string[], insecure: boolean, cacert: string | undefined, fs: Fs | undefined, wo: (code: string) => string, head: boolean, include: boolean): NetResult {
  if (!insecure && !(cacert && fs?.read(cacert)?.includes("BEGIN CERTIFICATE"))) {
    return { stdout: wo("000"), stderr: "curl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the webpage mentioned above.\n", code: 60 };
  }
  const auth = headers.find((h) => /^authorization:/i.test(h));
  const token = auth?.match(/bearer\s+(\S+)/i)?.[1];
  const path = url.replace(/^https:\/\/[^/]+/, "") || "/";
  const res = apiGet(cluster, identityFromToken(token), path);
  const hdr = `HTTP/2 ${res.status} \ncontent-type: application/json\ncontent-length: ${res.body.length}\n\n`;
  return { stdout: (head ? hdr : include ? hdr + res.body : res.body) + wo(String(res.status)), stderr: "", code: 0 };
}

function curl(cluster: Cluster, from: KObject | undefined, ns: string, args: string[], fs?: Fs): NetResult {
  let head = false;
  const headers: string[] = [];
  let insecure = false;
  let cacert: string | undefined;
  let include = false;
  let writeOut: string | undefined;
  let outFile: string | undefined;
  let silent = false;
  let failOnError = false;
  let url = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-I" || a === "--head") head = true;
    else if (a === "-i" || a === "--include") include = true;
    else if (a === "-w" || a === "--write-out") writeOut = args[++i];
    else if (a === "-o" || a === "--output") outFile = args[++i];
    else if (a === "-f" || a === "--fail") failOnError = true;
    else if (a === "-H" || a === "--header") headers.push(args[++i] ?? "");
    else if (a === "-k" || a === "--insecure") insecure = true;
    else if (a === "--cacert") cacert = args[++i];
    else if (["-m", "--max-time", "--connect-timeout", "-X", "-d", "--data", "-A", "--user-agent", "-u", "--retry"].includes(a)) i++;
    else if (a.startsWith("-") && !a.startsWith("--")) {
      if (a.includes("s")) silent = true;
      if (a.includes("I")) head = true;
      if (a.includes("f")) failOnError = true;
      if (a.includes("i")) include = true;
      if (a.includes("k")) insecure = true;
    } else if (!a.startsWith("-")) url = a;
  }
  void silent;
  if (!url) return { stdout: "", stderr: "curl: try 'curl --help' or 'curl --manual' for more information\n", code: 2 };
  const wo = (code: string) => (writeOut ? writeOut.replace("%{http_code}", code).replace(/\\n/g, "\n") : "");
  const um = url.match(/^https:\/\/([^/:]+)(?::(\d+))?/);
  if (um && isApiServer(cluster, ns, um[1], um[2] ? parseInt(um[2], 10) : 443)) return curlApi(cluster, url, headers, insecure, cacert, fs, wo, head, include);
  const hostHeader = headers.find((h) => /^host:/i.test(h))?.replace(/^host:\s*/i, "");
  const resolveArg = args[args.indexOf("--resolve") + 1];
  let target = url;
  if (args.includes("--resolve") && resolveArg) {
    const [rh, rp, rip] = resolveArg.split(":");
    target = url.replace(new RegExp(`//${rh}(:${rp})?`), `//${rip}:${rp}`);
  }
  const r = httpRequest(cluster, from, ns, target, "curl/8.17.0", hostHeader ?? (target !== url ? url.match(/\/\/([^/:]+)/)?.[1] : undefined));
  if (r.error) {
    const msg =
      r.error === "unresolved"
        ? [`curl: (6) Could not resolve host: ${r.host}`, 6]
        : r.error === "refused"
          ? [`curl: (7) Failed to connect to ${r.host} port ${r.port} after 0 ms: Could not connect to server`, 7]
          : r.error === "reset" || r.error === "tls"
            ? ["curl: (56) Recv failure: Connection reset by peer", 56]
            : [`curl: (28) Failed to connect to ${r.host} port ${r.port} after 10002 ms: Timeout was reached`, 28];
    return { stdout: wo("000"), stderr: msg[0] + "\n", code: msg[1] as number };
  }
  const res = r.res!;
  if (failOnError && res.status >= 400) return { stdout: wo(String(res.status)), stderr: `curl: (22) The requested URL returned error: ${res.status}\n`, code: 22 };
  const respHeaders = `HTTP/1.1 ${res.status} ${statusText(res.status)}\nServer: ${res.body.includes("nginx") || res.status >= 400 ? "nginx/1.29.3" : "podsim"}\nContent-Type: text/html\nContent-Length: ${res.body.length}\n\n`;
  let out = "";
  if (head) out = respHeaders;
  else {
    if (include) out += respHeaders;
    if (!outFile) out += res.body;
  }
  return { stdout: out + wo(String(res.status)), stderr: "", code: 0 };
}

function nslookup(cluster: Cluster, ns: string, args: string[], cmd: string, from?: KObject): NetResult {
  const name = args.filter((a) => !a.startsWith("-") && !a.startsWith("+"))[0];
  if (!name) return { stdout: "", stderr: "Usage: nslookup [-type=QUERY_TYPE] [-debug] HOST [DNS_SERVER]\n", code: 1 };
  if (!dnsCheck(cluster, from)) return { stdout: ";; connection timed out; no servers could be reached\n\n", stderr: "", code: 1 };
  const header = "Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n";
  const t = resolveHost(cluster, ns, name);
  const fq = name.includes(".") ? name : `${name}.${ns}.svc.cluster.local`;
  if (cmd === "dig" || cmd === "host") {
    if (!t || !t.ip) return { stdout: cmd === "host" ? `Host ${name} not found: 3(NXDOMAIN)\n` : "", stderr: "", code: 1 };
    return { stdout: cmd === "host" ? `${t.fqdn ?? name} has address ${t.ip}\n` : `${t.fqdn ?? name}.\t\t30\tIN\tA\t${t.ip}\n`, stderr: "", code: 0 };
  }
  if (!t || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    if (t?.service) return { stdout: `${header}${name.split(".").reverse().join(".")}.in-addr.arpa\tname = ${t.service.metadata.name}.${t.service.metadata.namespace}.svc.cluster.local\n`, stderr: "", code: 0 };
    if (t?.pod) return { stdout: `${header}${name.split(".").reverse().join(".")}.in-addr.arpa\tname = ${name.replace(/\./g, "-")}.${t.pod.metadata.namespace}.pod.cluster.local\n`, stderr: "", code: 0 };
    return { stdout: header, stderr: `** server can't find ${fq}: NXDOMAIN\n\n** server can't find ${fq}: NXDOMAIN\n\n`, code: 1 };
  }
  if (t.service?.spec?.type === "ExternalName") return { stdout: `${header}${t.fqdn}\tcanonical name = ${t.service.spec.externalName}\n`, stderr: "", code: 0 };
  if (t.service?.spec?.clusterIP === "None" && !t.pod?.spec?.hostname?.length) {
    const pods = cluster.list("Pod", t.service.metadata.namespace).filter((p) => matchMap(p.metadata.labels, t.service!.spec.selector) && p.status?.podIP && isReady(p));
    if (!pods.length) return { stdout: header, stderr: `** server can't find ${fq}: NXDOMAIN\n\n`, code: 1 };
    return { stdout: header + pods.map((p) => `Name:\t${t.fqdn}\nAddress: ${p.status.podIP}\n`).join("\n"), stderr: "", code: 0 };
  }
  if (!t.ip) return { stdout: header, stderr: `** server can't find ${fq}: NXDOMAIN\n\n`, code: 1 };
  return { stdout: `${header}Name:\t${t.fqdn}\nAddress: ${t.ip}\n`, stderr: "", code: 0 };
}

function nc(cluster: Cluster, from: KObject, ns: string, args: string[], stdin: string): NetResult {
  const words = args.filter((a) => !a.startsWith("-"));
  const timeoutIdx = args.findIndex((a) => a === "-w");
  const hostArg = words.filter((w, i) => !(timeoutIdx >= 0 && args[timeoutIdx + 1] === w && i === 0))[0];
  const portArg = words[words.length - 1];
  if (!hostArg || !portArg || hostArg === portArg) return { stdout: "", stderr: "BusyBox v1.37.0 multi-call binary.\n\nUsage: nc [OPTIONS] HOST PORT  - connect\n", code: 1 };
  const port = parseInt(portArg, 10);
  const { conn, target } = connect(cluster, from, ns, hostArg, port);
  const verbose = args.some((a) => /^-[a-zA-Z]*v/.test(a));
  if (!conn.ok) {
    if (conn.error === "unresolved") return { stdout: "", stderr: `nc: bad address '${hostArg}'\n`, code: 1 };
    if (conn.error === "timeout") return { stdout: "", stderr: verbose ? `nc: ${hostArg} (${target?.ip}:${port}): Connection timed out\n` : "", code: 1 };
    return { stdout: "", stderr: verbose ? `nc: ${hostArg} (${target?.ip}:${port}): Connection refused\n` : "", code: 1 };
  }
  const zero = args.some((a) => /^-[a-zA-Z]*z/.test(a));
  if (zero) return { stdout: "", stderr: verbose ? `${hostArg} (${target?.ip}:${port}) open\n` : "", code: 0 };
  if (conn.server.kind === "text") return { stdout: conn.server.body, stderr: "", code: 0 };
  if (stdin.startsWith("GET ")) {
    const res = serveHttp(cluster, conn.pod, conn.container, conn.cs, conn.server, stdin.split(" ")[1] ?? "/", { ip: from.status?.podIP ?? "", agent: "nc" });
    if (res) return { stdout: `HTTP/1.1 ${res.status} ${statusText(res.status)}\r\n\r\n${res.body}`, stderr: "", code: 0 };
  }
  return { stdout: "", stderr: "", code: 0 };
}

function ping(cluster: Cluster, ns: string, args: string[]): NetResult {
  const host = args.filter((a, i) => !a.startsWith("-") && !["-c", "-W", "-w", "-i"].includes(args[i - 1] ?? ""))[0];
  if (!host) return { stdout: "", stderr: "ping: usage error: Destination address required\n", code: 1 };
  const t = resolveHost(cluster, ns, host);
  if (!t) return { stdout: "", stderr: `ping: bad address '${host}'\n`, code: 1 };
  const count = parseInt(args[args.indexOf("-c") + 1] ?? "4", 10) || 4;
  if (t.service && t.service.spec?.clusterIP !== "None") {
    return { stdout: `PING ${host} (${t.ip}): 56 data bytes\n\n--- ${host} ping statistics ---\n${count} packets transmitted, 0 packets received, 100% packet loss\n`, stderr: "", code: 1 };
  }
  const lines = Array.from({ length: Math.min(count, 10) }, (_, i) => `64 bytes from ${t.ip}: seq=${i} ttl=63 time=0.${100 + i * 7} ms`).join("\n");
  return { stdout: `PING ${host} (${t.ip}): 56 data bytes\n${lines}\n\n--- ${host} ping statistics ---\n${count} packets transmitted, ${count} packets received, 0% packet loss\nround-trip min/avg/max = 0.100/0.121/0.163 ms\n`, stderr: "", code: 0 };
}

/** Network tools called from inside a container. */
export function netCommand(cluster: Cluster, pod: KObject, cmd: string, args: string[], stdin: string, at: number, fs?: Fs): NetResult {
  void at;
  const ns = pod.metadata.namespace ?? "default";
  switch (cmd) {
    case "wget":
      return wget(cluster, pod, ns, args);
    case "curl":
      return curl(cluster, pod, ns, args, fs);
    case "nslookup":
    case "host":
    case "dig":
      return nslookup(cluster, ns, args, cmd, pod);
    case "nc":
    case "telnet":
      return nc(cluster, pod, ns, args, stdin);
    case "ping":
      return ping(cluster, ns, args);
    default:
      return { stdout: "", stderr: `${cmd}: not simulated\n`, code: 1 };
  }
}

/** curl and wget run on the simulator host (a node): NodePorts, pod and Service IPs, port-forwards. */
export function hostNet(cluster: Cluster, cmd: "curl" | "wget", args: string[]): NetResult {
  return cmd === "curl" ? curl(cluster, undefined, "default", args) : wget(cluster, undefined, "default", args);
}

export function nginxListenPorts(cluster: Cluster, pod: KObject, c: ContainerSpec, cs: ContainerSim): number[] {
  return nginxPorts(hostFor(cluster, pod, c, cs).fs);
}
