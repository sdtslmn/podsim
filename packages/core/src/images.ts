// A small catalog of container images and how they behave when "run".
// No containers ever run: we only decide what a real one would do,
// so the simulator can show Running, Completed, CrashLoopBackOff or
// ImagePullBackOff and produce believable logs.

import type { ContainerSpec } from "./types.js";

export interface ParsedImage {
  registry: string;
  repository: string;
  tag: string;
  digest?: string;
}

export type Behavior =
  | { type: "server"; logs: (elapsedMs: number) => string[] }
  | { type: "exit"; code: number; afterMs: number; logs: (elapsedMs: number) => string[] }
  | { type: "pullError"; message: string };

const TAG_RE =
  /^(latest|stable|mainline|alpine|slim|perl|bookworm|bullseye|jammy|noble|lts|\d+(\.\d+){0,2}(-(alpine|slim|perl|bookworm|bullseye|jammy|noble|otel)[0-9.]*)?)$/;

export function parseImage(image: string): ParsedImage {
  let rest = image.trim();
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let registry = "docker.io";
  const firstSlash = rest.indexOf("/");
  if (firstSlash > 0) {
    const first = rest.slice(0, firstSlash);
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first;
      rest = rest.slice(firstSlash + 1);
    }
  }
  let tag = "latest";
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (registry === "docker.io" && rest.startsWith("library/")) rest = rest.slice("library/".length);
  return { registry, repository: rest, tag, digest };
}

const SHELL_IMAGES = new Set(["busybox", "alpine", "ubuntu", "debian", "centos", "fedora", "python", "node", "golang", "curlimages/curl", "nicolaka/netshoot", "polinux/stress"]);

interface ServerImage {
  logs: (env: Record<string, string>) => string[];
  requiredEnv?: { anyOf: string[]; failLogs: string[] };
}

const nginxLogs = () => [
  "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
  "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
  "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
  "10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf",
  "/docker-entrypoint.sh: Configuration complete; ready for start up",
  "[notice] 1#1: using the \"epoll\" event method",
  "[notice] 1#1: start worker processes",
];

const SERVER_IMAGES: Record<string, ServerImage> = {
  nginx: { logs: nginxLogs },
  "nginxinc/nginx-unprivileged": { logs: nginxLogs },
  httpd: {
    logs: () => [
      "AH00558: httpd: Could not reliably determine the server's fully qualified domain name. Set the 'ServerName' directive globally to suppress this message",
      "[mpm_event:notice] AH00489: Apache/2.4 (Unix) configured -- resuming normal operations",
      "[core:notice] AH00094: Command line: 'httpd -D FOREGROUND'",
    ],
  },
  redis: {
    logs: () => [
      "1:C * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo",
      "1:M * monotonic clock: POSIX clock_gettime",
      "1:M * Running mode=standalone, port=6379.",
      "1:M * Server initialized",
      "1:M * Ready to accept connections tcp",
    ],
  },
  memcached: { logs: () => [] },
  mongo: {
    logs: () => [
      '{"t":{"$date":"..."},"s":"I","c":"NETWORK","msg":"Waiting for connections","attr":{"port":27017}}',
    ],
  },
  postgres: {
    logs: () => [
      "PostgreSQL init process complete; ready for start up.",
      "LOG:  listening on IPv4 address \"0.0.0.0\", port 5432",
      "LOG:  database system is ready to accept connections",
    ],
    requiredEnv: {
      anyOf: ["POSTGRES_PASSWORD", "POSTGRES_HOST_AUTH_METHOD"],
      failLogs: [
        "Error: Database is uninitialized and superuser password is not specified.",
        "       You must specify POSTGRES_PASSWORD to a non-empty value for the",
        "       superuser. For example, \"-e POSTGRES_PASSWORD=password\" on \"docker run\".",
      ],
    },
  },
  mysql: {
    logs: () => ["[System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. port: 3306"],
    requiredEnv: {
      anyOf: ["MYSQL_ROOT_PASSWORD", "MYSQL_ALLOW_EMPTY_PASSWORD", "MYSQL_RANDOM_ROOT_PASSWORD"],
      failLogs: [
        "[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified",
        "    You need to specify one of the following as an environment variable:",
        "    - MYSQL_ROOT_PASSWORD",
        "    - MYSQL_ALLOW_EMPTY_PASSWORD",
        "    - MYSQL_RANDOM_ROOT_PASSWORD",
      ],
    },
  },
  mariadb: {
    logs: () => ["[Note] mariadbd: ready for connections."],
    requiredEnv: {
      anyOf: ["MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "MARIADB_RANDOM_ROOT_PASSWORD"],
      failLogs: ["[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified"],
    },
  },
  rabbitmq: { logs: () => ["Server startup complete; 0 plugins started."] },
  "traefik/whoami": { logs: () => ["Starting up on port 80"] },
  "hashicorp/http-echo": { logs: () => ["[INFO] server is listening on :5678"] },
};

function isSystemImage(p: ParsedImage): boolean {
  return p.registry === "registry.k8s.io" || p.registry === "k8s.gcr.io" || p.registry === "quay.io";
}

function pullError(image: string, p: ParsedImage, reason: "repo" | "tag"): Behavior {
  const ref = p.registry === "docker.io" ? `docker.io/library/${p.repository}:${p.tag}` : `${p.registry}/${p.repository}:${p.tag}`;
  const message =
    reason === "tag"
      ? `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": ${ref}: not found`
      : `Failed to pull image "${image}": failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
  return { type: "pullError", message };
}

/** Very small interpreter for the shell scripts learners put in command/args. */
function shellBehavior(script: string): Behavior {
  const s = script.trim();
  if (!s) return { type: "exit", code: 0, afterMs: 300, logs: () => [] };

  const echoes: string[] = [];
  const echoRe = /echo\s+(?:-[ne]\s+)?("([^"]*)"|'([^']*)'|([^;&|\n]+))/g;
  let m: RegExpExecArray | null;
  while ((m = echoRe.exec(s))) echoes.push((m[2] ?? m[3] ?? m[4] ?? "").trim());

  const loop = /while\s+(true|:)/.test(s) || /for\s*\(\(\s*;\s*;\s*\)\)/.test(s);
  if (loop) {
    const sleepMatch = s.match(/sleep\s+(\d+)/);
    const period = sleepMatch ? Math.max(1, parseInt(sleepMatch[1], 10)) * 1000 : 1000;
    return {
      type: "server",
      logs: (elapsed) => {
        const n = Math.min(200, Math.floor(elapsed / period) + 1);
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(...(echoes.length ? echoes : []));
        return out;
      },
    };
  }
  if (/sleep\s+infinity|tail\s+-f\s+\/dev\/null/.test(s)) return { type: "server", logs: () => echoes };

  const sleeps = [...s.matchAll(/sleep\s+(\d+)/g)].reduce((sum, x) => sum + parseInt(x[1], 10), 0);
  const exitMatch = s.match(/exit\s+(\d+)/);
  let code = exitMatch ? parseInt(exitMatch[1], 10) : 0;
  if (/(^|[;&|\s])false(\s|;|$)/.test(s)) code = 1;
  return { type: "exit", code, afterMs: Math.max(300, sleeps * 1000), logs: () => echoes };
}

/**
 * Decide what a container would do. `env` is the resolved environment
 * (env plus envFrom) so images like postgres can fail without a password.
 */
export function containerBehavior(c: ContainerSpec, env: Record<string, string>): Behavior {
  const p = parseImage(c.image);
  const tagOk = !!p.digest || TAG_RE.test(p.tag);

  if (isSystemImage(p)) return { type: "server", logs: () => [] };

  const repo = p.repository;
  const server = SERVER_IMAGES[repo];
  const shell = SHELL_IMAGES.has(repo);
  if (!server && !shell) return pullError(c.image, p, "repo");
  if (!tagOk) return pullError(c.image, p, "tag");

  const script = [...(c.command ?? []), ...(c.args ?? [])]
    .filter((part) => !["sh", "/bin/sh", "bash", "/bin/bash", "-c", "-ec"].includes(part))
    .join(" ");

  if (server) {
    if (c.command?.length || c.args?.length) return shellBehavior(script);
    if (server.requiredEnv && !server.requiredEnv.anyOf.some((k) => env[k])) {
      const fail = server.requiredEnv.failLogs;
      return { type: "exit", code: 1, afterMs: 1500, logs: () => fail };
    }
    return { type: "server", logs: () => server.logs(env) };
  }
  return shellBehavior(script);
}

export function defaultPullPolicy(image: string): string {
  const p = parseImage(image);
  return p.tag === "latest" && !p.digest ? "Always" : "IfNotPresent";
}
