// run, create <subcommand>, expose, scale, set, rollout.

import type { KObject } from "../types.js";
import { KubeError } from "../types.js";
import { kindInfo } from "../kinds.js";
import { parseImage } from "../images.js";
import { deepClone, isoTime, stableStringify } from "../util.js";
import { toBase64 } from "../cluster.js";
import { CHANGE_CAUSE, REVISION, deploymentReplicaSets, templateWithoutHash } from "../controllers/deployment.js";
import { revisionsOf } from "../controllers/workloads.js";
import type { Flags } from "./flags.js";
import { type Ctx, out, err, nsOf, ref, dryRun, singleTarget, notFoundError, kindOrThrow } from "./common.js";
import { createFromFiles, printDryRun } from "./resources.js";
import { buildRole } from "./rbac.js";
import { runInContainer } from "./container.js";
import { rfc1123 } from "./describe.js";
import { renderStructured } from "./printers.js";

function parseKV(items: string[], flagName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    for (const part of flagName === "labels" ? item.split(",") : [item]) {
      const idx = part.indexOf("=");
      if (idx <= 0) throw new KubeError(`error: invalid ${flagName} "${part}": must be key=value`);
      out[part.slice(0, idx)] = part.slice(idx + 1);
    }
  }
  return out;
}

function containerNameFromImage(image: string): string {
  const repo = parseImage(image).repository;
  return repo.split("/").pop()!.replace(/[^a-z0-9-]/g, "-");
}

function recordCause(ctx: Ctx, f: Flags, obj: KObject): void {
  if (f.bool("record")) {
    err(ctx, "Flag --record has been deprecated, --record will be removed in the future");
    obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), [CHANGE_CAUSE]: ctx.raw };
  }
}

// ------------------------------------------------------------------ run

export async function cmdRun(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  const name = f.args[0];
  if (!name) throw new KubeError("error: NAME is required for run\nSee 'kubectl run -h' for help and examples");
  const image = f.str("image");
  if (!image) throw new KubeError("error: required flag(s) \"image\" not set");
  const ns = nsOf(ctx, f);
  const restart = f.str("restart") ?? "Always";
  if (!["Always", "OnFailure", "Never"].includes(restart)) throw new KubeError(`error: invalid restart policy: ${restart}`);
  const labels = f.has("labels", "l") ? parseKV(f.all("labels"), "labels") : { run: name };
  const container: Record<string, unknown> = { image, name };
  const extra = [...f.args.slice(1), ...f.rest];
  if (extra.length) {
    if (f.bool("command")) container.command = extra;
    else container.args = extra;
  }
  const port = f.str("port");
  if (port) container.ports = [{ containerPort: parseInt(port, 10) }];
  const env = f.all("env");
  if (env.length) {
    container.env = env.map((e) => {
      const idx = e.indexOf("=");
      return { name: e.slice(0, idx), value: e.slice(idx + 1) };
    });
  }
  container.resources = {};
  const interactive = f.bool("i") || f.bool("stdin") || f.bool("it") || f.bool("t") || f.bool("tty") || f.bool("ti");
  if (interactive) {
    container.stdin = true;
    container.stdinOnce = true;
    container.tty = true;
  }
  const pod: KObject = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { labels, name, ...(f.str("namespace") ? { namespace: ns } : {}) },
    spec: { containers: [container], dnsPolicy: "ClusterFirst", restartPolicy: restart },
    status: {},
  };
  const anns = f.all("annotations");
  if (anns.length) pod.metadata.annotations = parseKV(anns, "annotations");
  const overrides = f.str("overrides");
  if (overrides) {
    let patch: unknown;
    try {
      patch = JSON.parse(overrides);
    } catch (e) {
      throw new KubeError(`error: Invalid JSON Patch: ${(e as Error).message}`);
    }
    const merge = (target: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> => {
      for (const [k, v] of Object.entries(p)) {
        if (v === null) delete target[k];
        else if (typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] && !Array.isArray(target[k])) target[k] = merge({ ...(target[k] as Record<string, unknown>) }, v as Record<string, unknown>);
        else target[k] = v;
      }
      return target;
    };
    Object.assign(pod, merge(pod as unknown as Record<string, unknown>, patch as Record<string, unknown>));
  }
  if (f.bool("privileged")) (container as { securityContext?: unknown }).securityContext = { privileged: true };

  if (dryRun(f)) {
    printDryRun(ctx, pod, f.str("output"), kindInfo("Pod"));
    return 0;
  }
  cluster.advance();
  pod.metadata.namespace = ns;
  const created = cluster.create(pod);
  for (const w of cluster.takeWarnings()) err(ctx, `Warning: ${w}`);
  cluster.advance();

  if (!interactive && !f.bool("rm")) {
    out(ctx, `pod/${created.metadata.name} created`);
    return 0;
  }
  const shellSession = interactive && (!extra.length || (extra.length === 1 && /^(\/bin\/)?(sh|bash|ash)$/.test(extra[0])));
  // Wait for the pod to start (real time, a few seconds), then run the command in it.
  let started = false;
  for (let i = 0; i < 20 && !ctx.io.aborted?.(); i++) {
    cluster.advance();
    const p = cluster.get("Pod", name, ns);
    const cs = p?.status?.containerStatuses?.[0];
    if (cs?.state?.running || cs?.state?.terminated || cs?.lastState?.terminated) {
      started = true;
      break;
    }
    if (cs?.state?.waiting?.reason && /ErrImagePull|ImagePullBackOff|CreateContainerConfigError/.test(cs.state.waiting.reason)) break;
    await ctx.io.sleep(500);
  }
  let code = 0;
  if (!started) {
    err(ctx, `error: timed out waiting for the condition`);
    code = 1;
  } else if (shellSession) {
    const p = cluster.get("Pod", name, ns)!;
    out(ctx, "If you don't see a command prompt, try pressing enter.");
    ctx.state.session = { pod: name, namespace: ns, container: p.spec.containers[0].name, remove: f.bool("rm"), vars: { PWD: "/" }, bash: extra[0]?.endsWith("bash") ?? false };
    return 0;
  } else {
    const p = cluster.get("Pod", name, ns)!;
    const r = runInContainer(cluster, p, p.spec.containers[0], f.bool("command") ? extra : extra);
    if (r.stdout) out(ctx, r.stdout.replace(/\n$/, ""));
    if (r.stderr) err(ctx, r.stderr.replace(/\n$/, ""));
    code = r.exitCode;
    if (code !== 0 && !f.bool("rm")) err(ctx, `pod ${ns}/${name} terminated (Error)`);
  }
  if (f.bool("rm")) {
    cluster.remove("Pod", name, ns);
    out(ctx, `pod "${name}" deleted`);
  }
  cluster.advance();
  return code;
}

// ------------------------------------------------------------------ create <sub>

export async function cmdCreate(ctx: Ctx, f: Flags): Promise<number> {
  if (f.all("filename").length || f.all("kustomize").length) return createFromFiles(ctx, f);
  const [sub, ...rest] = f.args;
  if (!sub) throw new KubeError("error: must specify one of -f and -k");
  const ns = nsOf(ctx, f);
  const output = f.str("output");
  const isDry = dryRun(f);
  const nsMeta = f.str("namespace") ? { namespace: ns } : {};
  let obj: KObject;

  switch (sub) {
    case "deployment":
    case "deploy": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const images = f.all("image");
      if (images.length === 0) throw new KubeError('error: required flag(s) "image" not set');
      const replicas = f.int("replicas") ?? 1;
      const port = f.str("port");
      const containers = images.map((image) => {
        const c: Record<string, unknown> = { image, name: containerNameFromImage(image) };
        if (port) c.ports = [{ containerPort: parseInt(port, 10) }];
        if (f.rest.length) c.command = f.rest;
        c.resources = {};
        return c;
      });
      obj = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { labels: { app: name }, name, ...nsMeta },
        spec: {
          replicas,
          selector: { matchLabels: { app: name } },
          strategy: {},
          template: { metadata: { labels: { app: name } }, spec: { containers } },
        },
        status: {},
      };
      break;
    }
    case "namespace":
    case "ns": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      obj = { apiVersion: "v1", kind: "Namespace", metadata: { name }, spec: {}, status: {} };
      break;
    }
    case "configmap":
    case "cm": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const data: Record<string, string> = {};
      for (const lit of f.all("from-literal")) {
        const idx = lit.indexOf("=");
        if (idx <= 0) throw new KubeError(`error: invalid literal source ${lit}, expected key=value`);
        data[lit.slice(0, idx)] = lit.slice(idx + 1);
      }
      for (const file of f.all("from-file")) {
        const [k, p] = file.includes("=") ? file.split("=") : [file.split(/[\\/]/).pop()!, file];
        if (!ctx.fs.exists(p)) throw new KubeError(`error: stat ${p}: no such file or directory`);
        data[k] = ctx.fs.readFile(p);
      }
      for (const file of f.all("from-env-file")) {
        if (!ctx.fs.exists(file)) throw new KubeError(`error: open ${file}: no such file or directory`);
        for (const line of ctx.fs.readFile(file).split(/\r?\n/)) {
          if (!line.trim() || line.startsWith("#")) continue;
          const idx = line.indexOf("=");
          if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1);
        }
      }
      obj = { apiVersion: "v1", kind: "ConfigMap", metadata: { name, ...nsMeta }, data };
      break;
    }
    case "secret": {
      const [type, name] = rest;
      if (type !== "generic" && type !== "tls" && type !== "docker-registry") {
        throw new KubeError(`error: Unknown subcommand: ${type ?? ""}. Use one of: docker-registry, generic, tls`);
      }
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const data: Record<string, string> = {};
      let secretType = f.str("type") ?? "Opaque";
      if (type === "generic") {
        for (const lit of f.all("from-literal")) {
          const idx = lit.indexOf("=");
          if (idx <= 0) throw new KubeError(`error: invalid literal source ${lit}, expected key=value`);
          data[lit.slice(0, idx)] = toBase64(lit.slice(idx + 1));
        }
        for (const file of f.all("from-file")) {
          const [k, p] = file.includes("=") ? file.split("=") : [file.split(/[\\/]/).pop()!, file];
          if (!ctx.fs.exists(p)) throw new KubeError(`error: stat ${p}: no such file or directory`);
          data[k] = toBase64(ctx.fs.readFile(p));
        }
      } else if (type === "tls") {
        const cert = f.str("cert");
        const key = f.str("key");
        if (!cert || !key) throw new KubeError('error: required flag(s) "cert", "key" not set');
        for (const p of [cert, key]) if (!ctx.fs.exists(p)) throw new KubeError(`error: open ${p}: no such file or directory`);
        data["tls.crt"] = toBase64(ctx.fs.readFile(cert));
        data["tls.key"] = toBase64(ctx.fs.readFile(key));
        secretType = "kubernetes.io/tls";
      } else {
        const server = f.str("docker-server") ?? "https://index.docker.io/v1/";
        const user = f.str("docker-username") ?? "";
        const pass = f.str("docker-password") ?? "";
        const auth = toBase64(`${user}:${pass}`);
        data[".dockerconfigjson"] = toBase64(JSON.stringify({ auths: { [server]: { username: user, password: pass, auth } } }));
        secretType = "kubernetes.io/dockerconfigjson";
      }
      obj = { apiVersion: "v1", kind: "Secret", metadata: { name, ...nsMeta }, data, type: secretType };
      break;
    }
    case "service":
    case "svc": {
      const [type, name] = rest;
      const types: Record<string, string> = { clusterip: "ClusterIP", nodeport: "NodePort", loadbalancer: "LoadBalancer", externalname: "ExternalName" };
      if (!types[type ?? ""]) throw new KubeError(`error: Unknown subcommand: ${type ?? ""}. Use one of: clusterip, externalname, loadbalancer, nodeport`);
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const ports = f.all("tcp").map((spec) => {
        const [p, t] = spec.split(":");
        const port = parseInt(p, 10);
        return { name: `${p}-${t ?? p}`, port, protocol: "TCP", targetPort: parseInt(t ?? p, 10), ...(types[type] === "NodePort" && f.int("node-port") ? { nodePort: f.int("node-port") } : {}) };
      });
      obj = {
        apiVersion: "v1",
        kind: "Service",
        metadata: { labels: { app: name }, name, ...nsMeta },
        spec: {
          ...(types[type] === "ExternalName" ? { externalName: f.str("external-name") } : { ports, selector: { app: name } }),
          type: types[type],
          ...(f.str("clusterip") ? { clusterIP: f.str("clusterip") } : {}),
        },
        status: { loadBalancer: {} },
      };
      if (types[type] !== "ExternalName" && ports.length === 0) throw new KubeError("error: at least one tcp port specifier must be provided");
      break;
    }
    case "serviceaccount":
    case "sa": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      obj = { apiVersion: "v1", kind: "ServiceAccount", metadata: { name, ...nsMeta } };
      break;
    }
    case "quota":
    case "resourcequota": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const hard: Record<string, string> = {};
      for (const part of (f.str("hard") ?? "").split(",").filter(Boolean)) {
        const [k, v] = part.split("=");
        if (!k || v === undefined) throw new KubeError(`error: invalid argument "${part}" for "--hard" flag`);
        hard[k] = v;
      }
      const scopes = (f.str("scopes") ?? "").split(",").filter(Boolean);
      obj = { apiVersion: "v1", kind: "ResourceQuota", metadata: { name, ...nsMeta }, spec: { hard, ...(scopes.length ? { scopes } : {}) }, status: {} };
      break;
    }
    case "token": {
      const sa = rest[0];
      if (!sa) throw new KubeError("error: exactly one NAME is required, got 0");
      if (!ctx.cluster.get("ServiceAccount", sa, ns)) throw new KubeError(`error: failed to create token: serviceaccounts "${sa}" not found`);
      const dur = f.str("duration") ?? "1h";
      const header = btoa(JSON.stringify({ alg: "RS256", kid: "podsim" })).replace(/=+$/, "");
      const now = Math.floor(ctx.cluster.now() / 1000);
      const m = dur.match(/^(\d+)(s|m|h)$/);
      const secs = m ? parseInt(m[1], 10) * ({ s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"]) : 3600;
      const payload = btoa(JSON.stringify({ aud: [f.str("audience") ?? "https://kubernetes.default.svc.cluster.local"], exp: now + secs, iat: now, iss: "https://kubernetes.default.svc.cluster.local", sub: `system:serviceaccount:${ns}:${sa}`, "kubernetes.io": { namespace: ns, serviceaccount: { name: sa } } })).replace(/=+$/, "");
      out(ctx, `${header}.${payload}.c2ltdWxhdGVkLXNpZ25hdHVyZQ`);
      return 0;
    }
    case "priorityclass":
    case "pc": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      obj = { apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass", metadata: { name }, value: f.int("value") ?? 0, globalDefault: f.bool("global-default"), description: f.str("description") ?? "", preemptionPolicy: f.str("preemption-policy") ?? "PreemptLowerPriority" };
      break;
    }
    case "poddisruptionbudget":
    case "pdb": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const sel = f.str("selector") ?? "";
      const matchLabels = Object.fromEntries(sel.split(",").filter(Boolean).map((p) => p.split("=")));
      const spec: Record<string, unknown> = { selector: { matchLabels } };
      const minA = f.str("min-available");
      const maxU = f.str("max-unavailable");
      if (minA) spec.minAvailable = /^\d+$/.test(minA) ? parseInt(minA, 10) : minA;
      if (maxU) spec.maxUnavailable = /^\d+$/.test(maxU) ? parseInt(maxU, 10) : maxU;
      obj = { apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name, ...nsMeta }, spec, status: {} };
      break;
    }
    case "role":
    case "clusterrole": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const verbs = f.all("verb").flatMap((v) => v.split(","));
      const resources = f.all("resource").flatMap((v) => v.split(","));
      if (verbs.length === 0) throw new KubeError("error: at least one verb must be specified");
      if (resources.length === 0) throw new KubeError("error: at least one resource must be specified");
      const names = f.all("resource-name").flatMap((v) => v.split(","));
      obj = buildRole(sub === "role" ? "Role" : "ClusterRole", name, sub === "role" ? (f.str("namespace") ? ns : undefined) : undefined, verbs, resources, names);
      break;
    }
    case "rolebinding":
    case "clusterrolebinding": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const role = f.str("role");
      const clusterrole = f.str("clusterrole");
      if (!role && !clusterrole) throw new KubeError("error: exactly one of clusterrole or role must be specified");
      if (sub === "clusterrolebinding" && role) throw new KubeError("error: unknown flag: --role");
      const subjects = [
        ...f.all("user").map((u) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "User", name: u })),
        ...f.all("group").map((g) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: g })),
        ...f.all("serviceaccount").map((s) => {
          const [sns, sname] = s.split(":");
          if (!sname) throw new KubeError(`error: serviceaccount must be <namespace>:<name>`);
          return { kind: "ServiceAccount", name: sname, namespace: sns };
        }),
      ];
      obj = {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: sub === "rolebinding" ? "RoleBinding" : "ClusterRoleBinding",
        metadata: { name, ...(sub === "rolebinding" ? nsMeta : {}) },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: role ? "Role" : "ClusterRole", name: role ?? clusterrole },
        subjects,
      };
      break;
    }
    case "job": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const from = f.str("from");
      if (from) {
        const [type, src] = from.split("/");
        if (!src || !["cronjob", "cronjobs", "cj", "cronjob.batch", "cronjobs.batch"].includes(type.toLowerCase())) {
          throw new KubeError(`error: from must be an existing cronjob: no kind "${type}" is registered for version`);
        }
        const cj = ctx.cluster.get("CronJob", src, ns);
        if (!cj) throw new KubeError(`Error from server (NotFound): cronjobs.batch "${src}" not found`);
        const tpl = deepClone(cj.spec.jobTemplate ?? {});
        obj = {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name,
            ...nsMeta,
            labels: tpl.metadata?.labels,
            annotations: { "cronjob.kubernetes.io/instantiate": "manual", ...(tpl.metadata?.annotations ?? {}) },
            ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: cj.metadata.name, uid: cj.metadata.uid!, controller: true }],
          },
          spec: tpl.spec,
        };
        if (!obj.metadata.labels) delete obj.metadata.labels;
        break;
      }
      const image = f.str("image");
      if (!image) throw new KubeError('error: required flag(s) "image" not set');
      const container: Record<string, unknown> = { image, name, resources: {} };
      if (f.rest.length) container.command = f.rest;
      obj = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, ...nsMeta },
        spec: { template: { metadata: {}, spec: { containers: [container], restartPolicy: "Never" } } },
        status: {},
      };
      break;
    }
    case "cronjob":
    case "cj": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const image = f.str("image");
      if (!image) throw new KubeError('error: required flag(s) "image" not set');
      const schedule = f.str("schedule");
      if (!schedule) throw new KubeError('error: required flag(s) "schedule" not set');
      const restart = f.str("restart") ?? "OnFailure";
      if (!["OnFailure", "Never"].includes(restart)) throw new KubeError(`error: invalid restart policy: ${restart}`);
      const container: Record<string, unknown> = { image, name, resources: {} };
      if (f.rest.length) container.command = f.rest;
      obj = {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name, ...nsMeta },
        spec: {
          jobTemplate: { metadata: { name }, spec: { template: { metadata: {}, spec: { containers: [container], restartPolicy: restart } } } },
          schedule,
        },
        status: {},
      };
      break;
    }
    case "daemonset":
    case "statefulset":
      throw new KubeError(`error: Unexpected args: [${sub}]\nSee 'kubectl create -h' for help and examples. (Write a ${sub === "daemonset" ? "DaemonSet" : "StatefulSet"} manifest: a quick start is kubectl create deployment NAME --image=IMAGE --dry-run=client -o yaml, then change the kind.)`);
    case "ingress":
    case "ing": {
      const name = rest[0];
      if (!name) throw new KubeError("error: exactly one NAME is required, got 0");
      const rules: Record<string, any>[] = [];
      const tls: Record<string, any>[] = [];
      const backendOf = (target: string) => {
        const [svc, port] = target.split(":");
        if (!svc || !port) throw new KubeError(`error: rule ${target} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
        return { service: { name: svc, port: /^\d+$/.test(port) ? { number: parseInt(port, 10) } : { name: port } } };
      };
      for (const r of f.all("rule")) {
        const [main, ...opts] = r.split(",");
        const eq = main.indexOf("=");
        if (eq < 0) throw new KubeError(`error: rule ${r} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
        const hostPath = main.slice(0, eq);
        const slash = hostPath.indexOf("/");
        const host = slash >= 0 ? hostPath.slice(0, slash) : hostPath;
        let path = slash >= 0 ? hostPath.slice(slash) : "/";
        let pathType = "Exact";
        if (path.endsWith("*")) {
          path = path.slice(0, -1) || "/";
          pathType = "Prefix";
        }
        const entry = { path, pathType, backend: backendOf(main.slice(eq + 1)) };
        const existing = rules.find((x) => (x.host ?? "") === host);
        if (existing) existing.http.paths.push(entry);
        else rules.push({ ...(host ? { host } : {}), http: { paths: [entry] } });
        for (const o of opts) {
          if (o.startsWith("tls")) {
            const secret = o.includes("=") ? o.split("=")[1] : undefined;
            tls.push({ ...(host ? { hosts: [host] } : {}), ...(secret ? { secretName: secret } : {}) });
          }
        }
      }
      const spec: Record<string, unknown> = {};
      const cls = f.str("class");
      if (cls) spec.ingressClassName = cls;
      const def = f.str("default-backend");
      if (def) spec.defaultBackend = backendOf(def);
      if (rules.length) spec.rules = rules;
      if (tls.length) spec.tls = tls;
      const annotations = f.all("annotation");
      obj = {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { name, ...nsMeta, ...(annotations.length ? { annotations: parseKV(annotations, "annotation") } : {}) },
        spec,
        status: { loadBalancer: {} },
      };
      break;
    }
    default:
      throw new KubeError(`error: Unexpected args: [${sub}]\nSee 'kubectl create -h' for help and examples`);
  }

  const info = kindInfo(obj.kind);
  if (isDry) {
    printDryRun(ctx, obj, output, info);
    return 0;
  }
  ctx.cluster.advance();
  if (info.namespaced) obj.metadata.namespace = ns;
  const created = ctx.cluster.create(obj);
  for (const w of ctx.cluster.takeWarnings()) err(ctx, `Warning: ${w}`);
  ctx.cluster.advance();
  if (output) {
    const text = renderStructured([created], output, true);
    if (text) out(ctx, text);
  } else out(ctx, `${ref(info, created.metadata.name)} created`);
  return 0;
}

// ------------------------------------------------------------------ expose

export async function cmdExpose(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const { info, name } = singleTarget(f.args, "expose");
  const src = cluster.get(info.kind, name, info.namespaced ? ns : undefined);
  if (!src) throw notFoundError(info, name);
  let selector: Record<string, string> | undefined;
  let containerPorts: { containerPort: number; protocol?: string }[] = [];
  switch (info.kind) {
    case "Deployment":
    case "ReplicaSet":
      selector = src.spec.selector?.matchLabels;
      containerPorts = (src.spec.template.spec.containers ?? []).flatMap((c: { ports?: [] }) => c.ports ?? []);
      break;
    case "Pod":
      selector = src.metadata.labels;
      containerPorts = (src.spec.containers ?? []).flatMap((c: { ports?: [] }) => c.ports ?? []);
      break;
    case "Service":
      selector = src.spec.selector;
      containerPorts = (src.spec.ports ?? []).map((p: { port: number; protocol?: string }) => ({ containerPort: p.port, protocol: p.protocol }));
      break;
    default:
      throw new KubeError(`error: cannot expose a ${info.kind}`);
  }
  const selFlag = f.str("selector");
  if (selFlag) selector = Object.fromEntries(selFlag.split(",").map((p) => p.split("=") as [string, string]));
  if (!selector || Object.keys(selector).length === 0) {
    throw new KubeError(`error: couldn't retrieve selectors via --selector flag or introspection: the ${info.singular} has no labels and cannot be exposed`);
  }
  const portFlag = f.str("port");
  let ports: { port: number; protocol: string; targetPort: number | string; name?: string; nodePort?: number }[];
  const protocol = f.str("protocol") ?? "TCP";
  const target = f.str("target-port");
  const targetPort = target === undefined ? undefined : /^\d+$/.test(target) ? parseInt(target, 10) : target;
  if (portFlag) {
    const p = parseInt(portFlag, 10);
    ports = [{ port: p, protocol, targetPort: targetPort ?? p }];
  } else if (containerPorts.length) {
    ports = containerPorts.map((c, i) => ({
      port: c.containerPort,
      protocol: c.protocol ?? protocol,
      targetPort: targetPort ?? c.containerPort,
      ...(containerPorts.length > 1 ? { name: `port-${i + 1}` } : {}),
    }));
  } else {
    throw new KubeError("error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples");
  }
  const type = f.str("type") ?? "ClusterIP";
  const svcName = f.str("name") ?? name;
  const svc: KObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: svcName, labels: f.str("labels") ? parseKV([f.str("labels")!], "labels") : { ...(src.metadata.labels ?? selector) }, namespace: ns },
    spec: { ports, selector, type },
    status: { loadBalancer: {} },
  };
  if (dryRun(f)) {
    delete svc.metadata.namespace;
    printDryRun(ctx, svc, f.str("output"), kindInfo("Service"));
    return 0;
  }
  cluster.create(svc);
  cluster.advance();
  out(ctx, `service/${svcName} exposed`);
  return 0;
}

// ------------------------------------------------------------------ scale

export async function cmdScale(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const ns = nsOf(ctx, f);
  const replicas = f.int("replicas");
  if (replicas === undefined) throw new KubeError("error: required flag(s) \"replicas\" not set");
  if (replicas < 0) throw new KubeError("error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0");
  const { info, name } = singleTarget(f.args, "scale");
  if (!["Deployment", "ReplicaSet", "StatefulSet"].includes(info.kind)) {
    if (info.kind === "Pod") throw new KubeError(`error: no scaler has been implemented for {"" "Pod"}`);
    throw new KubeError(`error: no scaler has been implemented for {"" "${info.kind}"}`);
  }
  const obj = cluster.get(info.kind, name, ns);
  if (!obj) throw notFoundError(info, name);
  const current = f.int("current-replicas");
  if (current !== undefined && current !== obj.spec.replicas) {
    throw new KubeError(`error: Expected replicas to be ${current}, was ${obj.spec.replicas}`);
  }
  const copy = deepClone(obj);
  copy.spec.replicas = replicas;
  recordCause(ctx, f, copy);
  cluster.replace(copy);
  cluster.advance();
  out(ctx, `${ref(info, name)} scaled`);
  return 0;
}

// ------------------------------------------------------------------ set

function containersOf(obj: KObject): Record<string, unknown>[] {
  if (obj.kind === "Pod") return obj.spec.containers;
  if (obj.kind === "CronJob") return obj.spec.jobTemplate.spec.template.spec.containers;
  return obj.spec.template.spec.containers;
}

export async function cmdSet(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const [sub, ...rest] = f.args;
  const ns = nsOf(ctx, f);
  if (!["image", "env", "resources", "serviceaccount", "sa"].includes(sub ?? "")) {
    throw new KubeError(`error: unknown command "${sub ?? ""}" for "kubectl set"\n\nAvailable Commands:\n  env, image, resources, serviceaccount`);
  }
  const { info, name, rest: tail } = singleTarget(rest, "set");
  if (!["Deployment", "ReplicaSet", "Pod", "DaemonSet", "StatefulSet", "Job", "CronJob"].includes(info.kind)) throw new KubeError(`error: ${info.plural} are not supported by set ${sub}`);
  const obj = cluster.get(info.kind, name, ns);
  if (!obj) throw notFoundError(info, name);
  const copy = deepClone(obj);
  const containers = containersOf(copy);
  let verb = "updated";

  if (sub === "image") {
    const pairs = tail.filter((a) => a.includes("="));
    if (pairs.length === 0) throw new KubeError("error: at least one image update is required");
    for (const p of pairs) {
      const [cname, image] = p.split("=");
      if (cname === "*") containers.forEach((c) => (c.image = image));
      else {
        const c = containers.find((x) => x.name === cname);
        if (!c) throw new KubeError(`error: unable to find container named "${cname}"`);
        c.image = image;
      }
    }
    recordCause(ctx, f, copy);
    if (stableStringify(copy.spec) === stableStringify(obj.spec)) return 0;
    cluster.replace(copy);
    out(ctx, `${ref(info, name)} image ${verb}`);
  } else if (sub === "env") {
    const pairs = tail.filter((a) => a.includes("=") || a.endsWith("-"));
    const from = f.str("from");
    const target = f.str("containers", "c");
    const list = target ? containers.filter((c) => c.name === target) : containers;
    for (const c of list) {
      const env = ((c.env as { name: string; value?: string }[]) ?? []).slice();
      for (const p of pairs) {
        if (p.endsWith("-") && !p.includes("=")) {
          const k = p.slice(0, -1);
          const i = env.findIndex((e) => e.name === k);
          if (i >= 0) env.splice(i, 1);
          continue;
        }
        const idx = p.indexOf("=");
        const k = p.slice(0, idx);
        const v = p.slice(idx + 1);
        const e = env.find((x) => x.name === k);
        if (e) e.value = v;
        else env.push({ name: k, value: v });
      }
      if (env.length) c.env = env;
      else delete c.env;
      if (from) {
        const [kind, refName] = from.split("/");
        const k = kindOrThrow(kind).kind;
        const envFrom = ((c.envFrom as unknown[]) ?? []).slice();
        envFrom.push(k === "ConfigMap" ? { configMapRef: { name: refName } } : { secretRef: { name: refName } });
        c.envFrom = envFrom;
      }
    }
    cluster.replace(copy);
    out(ctx, `${ref(info, name)} env updated`);
    verb = "env updated";
  } else if (sub === "resources") {
    const parse = (s: string | undefined) => (s ? Object.fromEntries(s.split(",").map((p) => p.split("=") as [string, string])) : undefined);
    const limits = parse(f.str("limits"));
    const requests = parse(f.str("requests"));
    const target = f.str("containers", "c");
    for (const c of target ? containers.filter((x) => x.name === target) : containers) {
      const r = { ...((c.resources as Record<string, Record<string, string>>) ?? {}) };
      if (limits) r.limits = { ...(r.limits ?? {}), ...limits };
      if (requests) r.requests = { ...(r.requests ?? {}), ...requests };
      c.resources = r;
    }
    cluster.replace(copy);
    out(ctx, `${ref(info, name)} resource requirements updated`);
  } else {
    const sa = tail[0];
    if (!sa) throw new KubeError("error: serviceaccount is required");
    if (copy.kind === "Pod") copy.spec.serviceAccountName = sa;
    else if (copy.kind === "CronJob") copy.spec.jobTemplate.spec.template.spec.serviceAccountName = sa;
    else copy.spec.template.spec.serviceAccountName = sa;
    cluster.replace(copy);
    out(ctx, `${ref(info, name)} serviceaccount updated`);
  }
  cluster.advance();
  return 0;
}

// ------------------------------------------------------------------ rollout

function rolloutMessage(d: KObject): { done: boolean; failed?: boolean; message: string } {
  const name = d.metadata.name;
  const st = d.status ?? {};
  if ((d.metadata.generation ?? 0) > (st.observedGeneration ?? 0)) return { done: false, message: `Waiting for deployment spec update to be observed...` };
  const progressing = (st.conditions ?? []).find((c: { type: string }) => c.type === "Progressing");
  if (progressing?.reason === "ProgressDeadlineExceeded") return { done: true, failed: true, message: `error: deployment "${name}" exceeded its progress deadline` };
  const desired = d.spec.replicas ?? 1;
  const updated = st.updatedReplicas ?? 0;
  const replicas = st.replicas ?? 0;
  const available = st.availableReplicas ?? 0;
  if (updated < desired) return { done: false, message: `Waiting for deployment "${name}" rollout to finish: ${updated} out of ${desired} new replicas have been updated...` };
  if (replicas > updated) return { done: false, message: `Waiting for deployment "${name}" rollout to finish: ${replicas - updated} old replicas are pending termination...` };
  if (available < updated) return { done: false, message: `Waiting for deployment "${name}" rollout to finish: ${available} of ${updated} updated replicas are available...` };
  return { done: true, message: `deployment "${name}" successfully rolled out` };
}

function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new KubeError(`error: invalid argument "${s}" for "--timeout" flag: time: invalid duration "${s}"`);
  const n = parseInt(m[1], 10);
  return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] ?? "s"] ?? 1000);
}

export async function cmdRollout(ctx: Ctx, f: Flags): Promise<number> {
  const { cluster } = ctx;
  cluster.advance();
  const [sub, ...rest] = f.args;
  const ns = nsOf(ctx, f);
  const subs = ["status", "history", "undo", "restart", "pause", "resume"];
  if (!subs.includes(sub ?? "")) throw new KubeError(`error: unknown command "${sub ?? ""}" for "kubectl rollout"\nAvailable Commands: ${subs.join(", ")}`);
  const { info, name } = singleTarget(rest, `rollout ${sub}`);
  if (info.kind === "DaemonSet" || info.kind === "StatefulSet") return rolloutSet(ctx, f, sub, info, name, ns);
  if (info.kind !== "Deployment") {
    throw new KubeError(`error: no ${sub === "history" ? "history viewer" : sub === "status" ? "status viewer" : "rollbacker"} has been implemented for "${info.kind}"`);
  }
  let d = cluster.get("Deployment", name, ns);
  if (!d) throw notFoundError(info, name);
  const refName = ref(info, name);

  switch (sub) {
    case "status": {
      const watch = f.str("watch") !== "false" && f.str("w") !== "false";
      const timeout = parseDuration(f.str("timeout"), 30000);
      const start = Date.now();
      let last = "";
      for (;;) {
        cluster.advance();
        d = cluster.get("Deployment", name, ns);
        if (!d) throw notFoundError(info, name);
        const m = rolloutMessage(d);
        if (m.message !== last) {
          if (m.failed) err(ctx, m.message);
          else out(ctx, m.message);
          last = m.message;
        }
        if (m.done) return m.failed ? 1 : 0;
        if (!watch) return 0;
        if (ctx.io.aborted?.()) return 130;
        if (Date.now() - start > timeout) {
          if (f.str("timeout")) {
            err(ctx, "error: timed out waiting for the condition");
            return 1;
          }
          err(ctx, `(podsim) stopped waiting after ${Math.round(timeout / 1000)}s. The rollout is still in progress. Check the pods with: kubectl get pods`);
          return 1;
        }
        await ctx.io.sleep(1000);
      }
    }
    case "history": {
      const rss = deploymentReplicaSets(cluster, d).sort((a, b) => parseInt(a.metadata.annotations?.[REVISION] ?? "0", 10) - parseInt(b.metadata.annotations?.[REVISION] ?? "0", 10));
      const revision = f.int("revision");
      if (revision !== undefined && revision > 0) {
        const rs = rss.find((r) => r.metadata.annotations?.[REVISION] === String(revision));
        if (!rs) throw new KubeError(`error: unable to find the specified revision`);
        const tpl = rs.spec.template;
        const lines = [`${refName} with revision #${revision}`, "Pod Template:", `  Labels:\t${Object.entries(tpl.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join("\n\t")}`];
        if (rs.metadata.annotations?.[CHANGE_CAUSE]) lines.push(`  Annotations:\tkubernetes.io/change-cause: ${rs.metadata.annotations[CHANGE_CAUSE]}`);
        lines.push("  Containers:");
        for (const c of tpl.spec.containers) {
          lines.push(`   ${c.name}:`, `    Image:\t${c.image}`, `    Port:\t${c.ports?.length ? c.ports.map((p: { containerPort: number; protocol?: string }) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", ") : "<none>"}`, `    Host Port:\t${c.ports?.length ? "0/TCP" : "<none>"}`, `    Environment:\t<none>`, `    Mounts:\t<none>`);
        }
        lines.push("  Volumes:\t<none>", "  Node-Selectors:\t<none>", "  Tolerations:\t<none>");
        out(ctx, lines.join("\n").replace(/\t/g, "\t"));
        return 0;
      }
      const rows = rss.map((r) => [r.metadata.annotations?.[REVISION] ?? "", r.metadata.annotations?.[CHANGE_CAUSE] ?? "<none>"]);
      const w = Math.max(8, ...rows.map((r) => r[0].length)) + 2;
      out(ctx, `${refName} \n${"REVISION".padEnd(w)}CHANGE-CAUSE\n${rows.map((r) => r[0].padEnd(w) + r[1]).join("\n")}\n`);
      return 0;
    }
    case "undo": {
      const rss = deploymentReplicaSets(cluster, d).sort((a, b) => parseInt(b.metadata.annotations?.[REVISION] ?? "0", 10) - parseInt(a.metadata.annotations?.[REVISION] ?? "0", 10));
      const toRev = f.int("to-revision") ?? 0;
      let target: KObject | undefined;
      if (toRev > 0) {
        target = rss.find((r) => r.metadata.annotations?.[REVISION] === String(toRev));
        if (!target) throw new KubeError(`error: unable to find specified revision ${toRev} in history`);
      } else {
        if (rss.length < 2) throw new KubeError(`error: no rollout history found for deployment "${name}"`);
        target = rss[1];
      }
      const tpl = templateWithoutHash(target) as KObject["spec"];
      if (stableStringify(tpl) === stableStringify(d.spec.template)) {
        out(ctx, `${refName} skipped rollback (current template already matches revision ${target.metadata.annotations?.[REVISION]})`);
        return 0;
      }
      const copy = deepClone(d);
      copy.spec.template = tpl;
      if (dryRun(f)) {
        out(ctx, `${refName} Pod Template:\n  (dry run)`);
        return 0;
      }
      cluster.replace(copy);
      cluster.advance();
      out(ctx, `${refName} rolled back`);
      return 0;
    }
    case "restart": {
      const copy = deepClone(d);
      copy.spec.template.metadata = copy.spec.template.metadata ?? {};
      copy.spec.template.metadata.annotations = { ...(copy.spec.template.metadata.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": isoTime(cluster.now()) };
      cluster.replace(copy);
      cluster.advance();
      out(ctx, `${refName} restarted`);
      return 0;
    }
    case "pause":
    case "resume": {
      const want = sub === "pause";
      if (!!d.spec.paused === want) throw new KubeError(`error: ${sub === "pause" ? "deployments.apps" : "deployments.apps"} "${name}" is ${want ? "already paused" : "not paused"}`);
      const copy = deepClone(d);
      if (want) copy.spec.paused = true;
      else delete copy.spec.paused;
      cluster.replace(copy);
      cluster.advance();
      out(ctx, `${refName} ${want ? "paused" : "resumed"}`);
      return 0;
    }
  }
  return 0;
}

function setRolloutMessage(o: KObject): { done: boolean; message: string } {
  const name = o.metadata.name;
  const st = o.status ?? {};
  if ((o.metadata.generation ?? 0) > (st.observedGeneration ?? 0)) return { done: false, message: `Waiting for ${o.kind === "DaemonSet" ? "daemon set" : "statefulset"} spec update to be observed...` };
  if (o.kind === "DaemonSet") {
    const desired = st.desiredNumberScheduled ?? 0;
    const updated = st.updatedNumberScheduled ?? 0;
    const available = st.numberAvailable ?? 0;
    if (updated < desired) return { done: false, message: `Waiting for daemon set "${name}" rollout to finish: ${updated} out of ${desired} new pods have been updated...` };
    if (available < desired) return { done: false, message: `Waiting for daemon set "${name}" rollout to finish: ${available} of ${desired} updated pods are available...` };
    return { done: true, message: `daemon set "${name}" successfully rolled out` };
  }
  const replicas = o.spec.replicas ?? 1;
  const ready = st.readyReplicas ?? 0;
  if (ready < replicas) return { done: false, message: `Waiting for ${replicas - ready} pods to be ready...` };
  const partition = o.spec.updateStrategy?.rollingUpdate?.partition ?? 0;
  if (partition > 0) {
    const want = replicas - partition;
    if ((st.updatedReplicas ?? 0) < want) return { done: false, message: `Waiting for partitioned roll out to finish: ${st.updatedReplicas ?? 0} out of ${want} new pods have been updated...` };
    return { done: true, message: `partitioned roll out complete: ${st.updatedReplicas ?? 0} new pods have been updated...` };
  }
  if (st.updateRevision !== st.currentRevision) return { done: false, message: `waiting for statefulset rolling update to complete ${st.updatedReplicas ?? 0} pods at revision ${st.updateRevision}...` };
  return { done: true, message: `statefulset rolling update complete ${replicas} pods at revision ${st.currentRevision}...` };
}

async function rolloutSet(ctx: Ctx, f: Flags, sub: string, info: ReturnType<typeof kindOrThrow>, name: string, ns: string): Promise<number> {
  const { cluster } = ctx;
  let o = cluster.get(info.kind, name, ns);
  if (!o) throw notFoundError(info, name);
  const refName = ref(info, name);
  switch (sub) {
    case "status": {
      const watch = f.str("watch") !== "false" && f.str("w") !== "false";
      const timeout = parseDuration(f.str("timeout"), 30000);
      const start = Date.now();
      let last = "";
      for (;;) {
        cluster.advance();
        o = cluster.get(info.kind, name, ns);
        if (!o) throw notFoundError(info, name);
        const m = setRolloutMessage(o);
        if (m.message !== last) {
          out(ctx, m.message);
          last = m.message;
        }
        if (m.done || !watch) return 0;
        if (ctx.io.aborted?.()) return 130;
        if (Date.now() - start > timeout) {
          err(ctx, f.str("timeout") ? "error: timed out waiting for the condition" : `(podsim) stopped waiting after ${Math.round(timeout / 1000)}s. The rollout is still in progress. Check the pods with: kubectl get pods`);
          return 1;
        }
        await ctx.io.sleep(1000);
      }
    }
    case "history": {
      const revs = revisionsOf(cluster, o);
      const revision = f.int("revision");
      if (revision !== undefined && revision > 0) {
        const r = revs.find((x) => x.revision === revision);
        if (!r) throw new KubeError(`error: unable to find the specified revision`);
        const lines = [`${refName} with revision #${revision}`, "Pod Template:", `  Labels:\t${Object.entries(r.template?.metadata?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join("\n\t")}`, "  Containers:"];
        for (const c of r.template?.spec?.containers ?? []) lines.push(`   ${c.name}:`, `    Image:\t${c.image}`);
        out(ctx, lines.join("\n"));
        return 0;
      }
      const rows = revs.map((r) => [String(r.revision), r.cause ?? "<none>"]);
      out(ctx, `${refName} \nREVISION  CHANGE-CAUSE\n${rows.map((r) => r[0].padEnd(10) + r[1]).join("\n")}\n`);
      return 0;
    }
    case "undo": {
      const revs = revisionsOf(cluster, o).sort((a, b) => b.revision - a.revision);
      const toRev = f.int("to-revision") ?? 0;
      const target = toRev > 0 ? revs.find((r) => r.revision === toRev) : revs[1];
      if (!target) throw new KubeError(toRev > 0 ? `error: unable to find specified revision ${toRev} in history` : `error: no rollout history found for ${info.singular} "${name}"`);
      if (stableStringify(target.template) === stableStringify(o.spec.template)) {
        out(ctx, `${refName} skipped rollback (current template already matches revision ${target.revision})`);
        return 0;
      }
      const copy = deepClone(o);
      copy.spec.template = deepClone(target.template);
      cluster.replace(copy);
      cluster.advance();
      out(ctx, `${refName} rolled back`);
      return 0;
    }
    case "restart": {
      const copy = deepClone(o);
      copy.spec.template.metadata = copy.spec.template.metadata ?? {};
      copy.spec.template.metadata.annotations = { ...(copy.spec.template.metadata.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": isoTime(cluster.now()) };
      cluster.replace(copy);
      cluster.advance();
      out(ctx, `${refName} restarted`);
      return 0;
    }
    default:
      throw new KubeError(`error: ${refName} ${sub === "pause" ? "pausing" : "resuming"} is not supported`);
  }
}

export { rfc1123 };
