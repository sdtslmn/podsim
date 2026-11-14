// The simulated cluster: an in-memory API server plus controllers that
// move objects through their lifecycle on a virtual clock.

import { kindInfo, isKnownKind, useCustomKinds, type KindInfo } from "./kinds.js";
import { crdToKind, validateCRD, validateCustom } from "./crd.js";
import type { KObject } from "./types.js";
import { KubeError } from "./types.js";
import {
  Random,
  deepClone,
  isoTime,
  validateName,
  isValidQuantity,
  matchLabelSelector,
  stableStringify,
  parseCpu,
} from "./util.js";
import { defaultPullPolicy, useRegistry, type BuiltImage } from "./images.js";
import { runControllers, type PodSim } from "./controllers/index.js";
import { parseSchedule } from "./cron.js";
import { admitPod, admitObject, templateWarnings } from "./admission.js";
import "./netpol.js";

export interface ClusterOptions {
  /** Wall clock in ms. Defaults to Date.now. Tests pass a fake clock. */
  clock?: () => number;
  /** Seed for generated names and IPs. */
  seed?: number;
  /** Worker node names. Defaults to node01 and node02. */
  workers?: string[];
}

export interface EventSource {
  component: string;
  host?: string;
}

const NODE_IPS = ["192.168.56.10", "192.168.56.11", "192.168.56.12", "192.168.56.13", "192.168.56.14"];

export const K8S_VERSION = "v1.34.1";

function key(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${namespace ?? ""}/${name}`;
}

export class Cluster {
  readonly version = K8S_VERSION;
  readonly random: Random;
  private objects = new Map<string, KObject>();
  private rv = 1000;
  private clockFn: () => number;
  private offset = 0;
  private lastT: number;
  private podIpCounters = new Map<string, number>();
  private usedServiceIps = new Set<string>();
  private usedNodePorts = new Set<number>();
  private eventIndex = new Map<string, string>();
  private eventSeq = new Map<string, number>();
  private eventCounter = 0;
  /** Runtime state the kubelet simulation keeps per pod uid (not part of the API object). */
  readonly podSims = new Map<string, PodSim>();
  /** Last time each controller made progress, used for progress deadlines. */
  readonly controllerState = new Map<string, number>();
  /** Free-form memory for controllers (e.g. which finished jobs a CronJob already reported). */
  readonly scratch = new Map<string, unknown>();
  /** Kinds served through CustomResourceDefinitions in this cluster. */
  private customByKey = new Map<string, KindInfo>();
  private customKinds: KindInfo[] = [];

  /** Make this cluster's custom kinds the current ones (see kinds.ts). */
  activate(): void {
    useCustomKinds(this.customByKey, this.customKinds);
    useRegistry(this.scratch.get("registry") as Map<string, BuiltImage> | undefined);
  }

  private registerCRD(crd: KObject): void {
    const { info, keys } = crdToKind(crd);
    this.unregisterCRD(crd.metadata.name, false);
    this.customKinds.push(info);
    for (const k of keys) this.customByKey.set(k, info);
    this.customByKey.set(`crd:${crd.metadata.name}`, info);
  }

  private unregisterCRD(name: string, deleteObjects: boolean): void {
    const info = this.customByKey.get(`crd:${name}`);
    if (!info) return;
    if (deleteObjects) for (const [k, o] of [...this.objects.entries()]) if (o.kind === info.kind && o.apiVersion.split("/")[0] === info.apiVersion.split("/")[0]) this.objects.delete(k);
    for (const [k, v] of [...this.customByKey.entries()]) if (v === info) this.customByKey.delete(k);
    const i = this.customKinds.indexOf(info);
    if (i >= 0) this.customKinds.splice(i, 1);
  }

  /** Admission warnings from the last create, for kubectl to print. */
  private warnings: string[] = [];

  takeWarnings(): string[] {
    const w = this.warnings;
    this.warnings = [];
    return w;
  }

  constructor(opts: ClusterOptions = {}) {
    this.clockFn = opts.clock ?? (() => Date.now());
    this.random = new Random(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.lastT = this.clockFn();
    this.bootstrap(opts.workers ?? ["node01", "node02"]);
  }

  // ---------------------------------------------------------------- time

  now(): number {
    return this.clockFn() + this.offset;
  }

  /** Run the controllers forward to the current time, in steps, so state changes in order. */
  advance(): void {
    this.activate();
    const target = this.now();
    const gap = target - this.lastT;
    if (gap <= 0) {
      runControllers(this, target);
      return;
    }
    const steps = Math.min(600, Math.max(1, Math.ceil(gap / 1000)));
    const size = gap / steps;
    for (let i = 1; i <= steps; i++) runControllers(this, Math.round(this.lastT + size * i));
    this.lastT = target;
  }

  /** Jump the virtual clock forward without waiting, e.g. to let a lab's setup settle. */
  settle(seconds: number): void {
    this.advance();
    this.offset += seconds * 1000;
    this.advance();
  }

  // ---------------------------------------------------------------- store

  get(kind: string, name: string, namespace?: string): KObject | undefined {
    this.activate();
    const info = kindInfo(kind);
    const obj = this.objects.get(key(info.kind, info.namespaced ? namespace ?? "default" : undefined, name));
    return obj;
  }

  /** List objects of a kind. namespace undefined means all namespaces. */
  list(kind: string, namespace?: string): KObject[] {
    this.activate();
    const info = kindInfo(kind);
    const out: KObject[] = [];
    for (const obj of this.objects.values()) {
      if (obj.kind !== info.kind) continue;
      if (info.namespaced && namespace !== undefined && obj.metadata.namespace !== namespace) continue;
      out.push(obj);
    }
    return out.sort(
      (a, b) =>
        (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") ||
        a.metadata.name.localeCompare(b.metadata.name),
    );
  }

  /** Controllers write through here: no validation, bumps resourceVersion. */
  put(obj: KObject): KObject {
    this.activate();
    const info = kindInfo(obj.kind);
    obj.metadata.resourceVersion = String(++this.rv);
    this.objects.set(key(info.kind, info.namespaced ? obj.metadata.namespace : undefined, obj.metadata.name), obj);
    return obj;
  }

  /** Remove an object and let garbage collection handle its dependents. */
  remove(kind: string, name: string, namespace?: string): KObject {
    this.activate();
    const info = kindInfo(kind);
    const ns = info.namespaced ? namespace ?? "default" : undefined;
    const k = key(info.kind, ns, name);
    const obj = this.objects.get(k);
    if (!obj) throw notFound(info.plural, name);
    if (info.kind === "Namespace") {
      if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(name)) {
        throw new KubeError(`Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`);
      }
      for (const [k2, o] of [...this.objects.entries()]) {
        if (o.metadata.namespace === name) {
          this.objects.delete(k2);
          if (o.kind === "Pod" && o.metadata.uid) this.podSims.delete(o.metadata.uid);
        }
      }
    }
    if (info.kind === "Pod" && obj.metadata.uid) this.releasePodSim(obj);
    if (info.kind === "CustomResourceDefinition") this.unregisterCRD(name, true);
    if (info.kind === "Service") {
      this.usedServiceIps.delete(obj.spec?.clusterIP);
      for (const p of obj.spec?.ports ?? []) if (p.nodePort) this.usedNodePorts.delete(p.nodePort);
      this.objects.delete(key("Endpoints", ns, name));
    }
    this.objects.delete(k);
    return obj;
  }

  private releasePodSim(pod: KObject): void {
    if (pod.metadata.uid) this.podSims.delete(pod.metadata.uid);
  }

  // ---------------------------------------------------------------- API with validation

  /** Create an object as the API server would: validate, default, store. */
  create(input: KObject, opts: { dryRun?: boolean; at?: number } = {}): KObject {
    this.activate();
    if (!input || typeof input !== "object" || !input.kind) {
      throw new KubeError("error: error validating data: [apiVersion not set, kind not set]");
    }
    if (!isKnownKind(input.kind)) {
      throw new KubeError(
        `error: resource mapping not found for name: "${input.metadata?.name ?? ""}" namespace: "" from "STDIN": no matches for kind "${input.kind}" in version "${input.apiVersion}"`,
      );
    }
    const info = kindInfo(input.kind);
    const obj = deepClone(input);
    obj.kind = info.kind;
    obj.apiVersion = obj.apiVersion || info.apiVersion;
    obj.metadata = obj.metadata ?? ({} as KObject["metadata"]);
    if (!obj.metadata.name && obj.metadata.generateName) {
      obj.metadata.name = obj.metadata.generateName + this.random.suffix(5);
    }
    const nameErr = validateName(obj.metadata.name, info.kind === "Namespace" || info.kind === "Service");
    if (nameErr) throw invalid(info.kind, obj.metadata.name ?? "", `metadata.name: Invalid value: "${obj.metadata.name ?? ""}": ${nameErr}`);

    if (info.namespaced) {
      obj.metadata.namespace = obj.metadata.namespace || "default";
      if (!this.get("Namespace", obj.metadata.namespace)) {
        throw new KubeError(`Error from server (NotFound): namespaces "${obj.metadata.namespace}" not found`);
      }
      const ns = this.get("Namespace", obj.metadata.namespace)!;
      if (ns.status?.phase === "Terminating") {
        throw new KubeError(`Error from server (Forbidden): ${info.plural} "${obj.metadata.name}" is forbidden: unable to create new content in namespace ${obj.metadata.namespace} because it is being terminated`);
      }
    } else {
      delete obj.metadata.namespace;
    }
    if (this.get(info.kind, obj.metadata.name, obj.metadata.namespace)) {
      throw new KubeError(`Error from server (AlreadyExists): ${info.plural}${info.apiVersion.includes("/") ? "." + info.apiVersion.split("/")[0] : ""} "${obj.metadata.name}" already exists`);
    }

    this.validate(obj);
    this.applyDefaults(obj);
    if (!opts.dryRun && !opts.at) {
      if (info.kind === "Pod") {
        this.warnings.push(...admitPod(this, obj));
        obj.status.qosClass = qosClass(obj.spec);
      } else {
        admitObject(this, obj);
        this.warnings.push(...templateWarnings(this, obj));
      }
    }

    const now = opts.at ?? this.now();
    obj.metadata.uid = this.random.uid();
    obj.metadata.creationTimestamp = isoTime(now);
    if (obj.spec !== undefined && GENERATION_KINDS.includes(info.kind)) obj.metadata.generation = 1;
    if (info.kind === "Job") jobSelector(obj);
    if (opts.dryRun) return obj;

    this.allocate(obj);
    if (info.kind === "CustomResourceDefinition") {
      obj.status = {
        conditions: [
          { type: "NamesAccepted", status: "True", reason: "NoConflicts", message: "no conflicts found", lastTransitionTime: isoTime(now) },
          { type: "Established", status: "True", reason: "InitialNamesAccepted", message: "the initial names have been accepted", lastTransitionTime: isoTime(now) },
        ],
        acceptedNames: obj.spec.names,
        storedVersions: [(obj.spec.versions ?? []).find((v: { storage?: boolean }) => v.storage)?.name ?? "v1"],
      };
      this.registerCRD(obj);
    }
    this.put(obj);
    return obj;
  }

  /** Replace an existing object (apply, edit, scale, set image). Enforces immutable fields. */
  replace(input: KObject): KObject {
    this.activate();
    const info = kindInfo(input.kind);
    const ns = info.namespaced ? input.metadata.namespace ?? "default" : undefined;
    const existing = this.get(info.kind, input.metadata.name, ns);
    if (!existing) throw notFound(info.plural, input.metadata.name);
    const obj = deepClone(input);
    obj.kind = info.kind;
    obj.apiVersion = obj.apiVersion || existing.apiVersion;
    obj.metadata = { ...obj.metadata, namespace: ns };
    this.validate(obj);
    this.applyDefaults(obj);

    // Keep server-owned metadata.
    obj.metadata.uid = existing.metadata.uid;
    obj.metadata.creationTimestamp = existing.metadata.creationTimestamp;
    obj.metadata.ownerReferences = obj.metadata.ownerReferences ?? existing.metadata.ownerReferences;
    if (!obj.metadata.namespace) delete obj.metadata.namespace;

    if (info.kind === "Pod") {
      obj.spec.nodeName = obj.spec.nodeName ?? existing.spec.nodeName;
      const strip = (spec: KObject["spec"]) => {
        const s = deepClone(spec);
        for (const c of s.containers ?? []) delete c.image;
        for (const c of s.initContainers ?? []) delete c.image;
        delete s.tolerations;
        delete s.activeDeadlineSeconds;
        return stableStringify(s);
      };
      if (strip(obj.spec) !== strip(existing.spec)) {
        throw invalid(
          "Pod",
          obj.metadata.name,
          "spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`,`spec.initContainers[*].image`,`spec.activeDeadlineSeconds`,`spec.tolerations` (only additions to existing tolerations),`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)",
        );
      }
      obj.status = existing.status;
    }
    if (info.kind === "Job") {
      obj.spec.selector = obj.spec.selector ?? existing.spec.selector;
      const tplLabels = { ...(existing.spec.template?.metadata?.labels ?? {}) };
      obj.spec.template.metadata = { ...(obj.spec.template.metadata ?? {}), labels: { ...tplLabels, ...(obj.spec.template.metadata?.labels ?? {}) } };
      if (stableStringify(obj.spec.template) !== stableStringify(existing.spec.template)) {
        throw invalid("Job", obj.metadata.name, "spec.template: Invalid value: core.PodTemplateSpec{...}: field is immutable");
      }
      if (stableStringify(obj.spec.selector) !== stableStringify(existing.spec.selector)) {
        throw invalid("Job", obj.metadata.name, `spec.selector: Invalid value: ${describeSelector(obj.spec.selector)}: field is immutable`);
      }
      if ((obj.spec.completions ?? null) !== (existing.spec.completions ?? null)) {
        throw invalid("Job", obj.metadata.name, `spec.completions: Invalid value: ${obj.spec.completions}: field is immutable`);
      }
      obj.status = existing.status;
    }
    if (info.kind === "StatefulSet") {
      const editable = ["replicas", "ordinals", "template", "updateStrategy", "persistentVolumeClaimRetentionPolicy", "minReadySeconds"];
      const rest = (spec: Record<string, unknown>) => stableStringify(Object.fromEntries(Object.entries(spec).filter(([k]) => !editable.includes(k))));
      if (rest(obj.spec) !== rest(existing.spec)) {
        throw invalid("StatefulSet", obj.metadata.name, "spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden");
      }
    }
    if (["StatefulSet", "DaemonSet", "CronJob", "Job"].includes(info.kind)) {
      obj.status = existing.status;
      const changed = stableStringify(obj.spec) !== stableStringify(existing.spec);
      obj.metadata.generation = (existing.metadata.generation ?? 1) + (changed ? 1 : 0);
    }
    if (info.kind === "Deployment" || info.kind === "ReplicaSet" || info.kind === "DaemonSet") {
      if (stableStringify(obj.spec.selector) !== stableStringify(existing.spec.selector)) {
        throw invalid(info.kind, obj.metadata.name, `spec.selector: Invalid value: ${describeSelector(obj.spec.selector)}: field is immutable`);
      }
      obj.status = existing.status;
      const changed = stableStringify(obj.spec) !== stableStringify(existing.spec);
      obj.metadata.generation = (existing.metadata.generation ?? 1) + (changed ? 1 : 0);
    }
    if (info.kind === "Service") {
      obj.spec.clusterIP = existing.spec.clusterIP;
      obj.spec.clusterIPs = existing.spec.clusterIPs;
      for (const p of obj.spec.ports ?? []) {
        const old = (existing.spec.ports ?? []).find((x: { port: number }) => x.port === p.port);
        if (!p.nodePort && old?.nodePort && obj.spec.type !== "ClusterIP") p.nodePort = old.nodePort;
      }
      this.allocate(obj);
      obj.status = existing.status;
    }
    if (info.kind === "Node" || info.kind === "Namespace") obj.status = obj.status ?? existing.status;
    if (info.kind === "CustomResourceDefinition") {
      obj.status = existing.status;
      this.registerCRD(obj);
    }
    if ((info.kind === "ConfigMap" || info.kind === "Secret") && existing.immutable === true) {
      if (stableStringify({ d: obj.data, b: obj.binaryData }) !== stableStringify({ d: existing.data, b: existing.binaryData })) {
        throw invalid(info.kind, obj.metadata.name, "data: Forbidden: field is immutable when `immutable` is set");
      }
      if (obj.immutable !== true) throw invalid(info.kind, obj.metadata.name, "immutable: Forbidden: field is immutable when `immutable` is set");
    }
    if (info.kind === "PersistentVolumeClaim" && existing.status?.phase === "Bound") {
      const keep = (spec: Record<string, any>) => stableStringify({ ...spec, resources: undefined, volumeName: undefined, storageClassName: undefined, volumeMode: undefined });
      if (keep(obj.spec ?? {}) !== keep(existing.spec ?? {})) throw invalid("PersistentVolumeClaim", obj.metadata.name, "spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims");
      obj.spec.volumeName = existing.spec.volumeName;
      obj.spec.storageClassName = existing.spec.storageClassName;
      obj.status = existing.status;
    }
    this.put(obj);
    return obj;
  }

  // ---------------------------------------------------------------- validation and defaults

  private validate(obj: KObject): void {
    const name = obj.metadata.name;
    const info = kindInfo(obj.kind);
    if (info.custom) validateCustom(obj, info);
    switch (obj.kind) {
      case "CustomResourceDefinition":
        validateCRD(obj, (d) => invalid("CustomResourceDefinition", name, d));
        break;
      case "Pod":
        validatePodSpec("Pod", name, obj.spec, "spec");
        break;
      case "Deployment":
      case "ReplicaSet": {
        const spec = obj.spec;
        if (!spec) throw invalid(obj.kind, name, "spec: Required value");
        if (!spec.selector) throw invalid(obj.kind, name, "spec.selector: Required value");
        if (spec.replicas !== undefined && (typeof spec.replicas !== "number" || spec.replicas < 0)) {
          throw invalid(obj.kind, name, `spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`);
        }
        const labels = spec.template?.metadata?.labels;
        if (!matchLabelSelector(labels, spec.selector)) {
          throw invalid(
            obj.kind,
            name,
            `spec.template.metadata.labels: Invalid value: ${goMap(labels)}: \`selector\` does not match template \`labels\``,
          );
        }
        validatePodSpec(obj.kind, name, spec.template?.spec, "spec.template.spec");
        break;
      }
      case "Service": {
        const spec = obj.spec ?? {};
        const type = spec.type ?? "ClusterIP";
        if (!["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"].includes(type)) {
          throw invalid("Service", name, `spec.type: Unsupported value: "${type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
        }
        if (type !== "ExternalName" && (!Array.isArray(spec.ports) || spec.ports.length === 0)) {
          throw invalid("Service", name, "spec.ports: Required value");
        }
        (spec.ports ?? []).forEach((p: { port?: number; nodePort?: number }, i: number) => {
          if (typeof p.port !== "number" || p.port < 1 || p.port > 65535) {
            throw invalid("Service", name, `spec.ports[${i}].port: Invalid value: ${p.port}: must be between 1 and 65535, inclusive`);
          }
          if (p.nodePort !== undefined && (p.nodePort < 30000 || p.nodePort > 32767)) {
            throw invalid("Service", name, `spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
          }
        });
        break;
      }
      case "DaemonSet":
      case "StatefulSet": {
        const spec = obj.spec;
        if (!spec) throw invalid(obj.kind, name, "spec: Required value");
        if (!spec.selector) throw invalid(obj.kind, name, "spec.selector: Required value");
        const labels = spec.template?.metadata?.labels;
        if (!matchLabelSelector(labels, spec.selector)) {
          throw invalid(obj.kind, name, `spec.template.metadata.labels: Invalid value: ${goMap(labels)}: \`selector\` does not match template \`labels\``);
        }
        validatePodSpec(obj.kind, name, spec.template?.spec, "spec.template.spec");
        const rp = spec.template?.spec?.restartPolicy;
        if (rp !== undefined && rp !== "Always") {
          throw invalid(obj.kind, name, `spec.template.spec.restartPolicy: Unsupported value: "${rp}": supported values: "Always"`);
        }
        if (obj.kind === "StatefulSet" && spec.replicas !== undefined && (typeof spec.replicas !== "number" || spec.replicas < 0)) {
          throw invalid(obj.kind, name, `spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`);
        }
        break;
      }
      case "Job":
        validateJobSpec("Job", name, obj.spec, "spec");
        break;
      case "Ingress": {
        const rules = (obj.spec?.rules ?? []) as Record<string, any>[];
        if (!rules.length && !obj.spec?.defaultBackend) throw invalid("Ingress", name, "spec: Invalid value: field must be specified: either `defaultBackend` or `rules` must be specified");
        rules.forEach((r, i) => {
          (r.http?.paths ?? []).forEach((p: Record<string, any>, j: number) => {
            const base = `spec.rules[${i}].http.paths[${j}]`;
            if (!p.pathType) throw invalid("Ingress", name, `${base}.pathType: Required value: pathType must be specified`);
            if (!["Exact", "Prefix", "ImplementationSpecific"].includes(p.pathType)) throw invalid("Ingress", name, `${base}.pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
            if (p.pathType !== "ImplementationSpecific" && !String(p.path ?? "").startsWith("/")) throw invalid("Ingress", name, `${base}.path: Invalid value: "${p.path ?? ""}": must be an absolute path`);
            if (!p.backend?.service?.name && !p.backend?.resource) throw invalid("Ingress", name, `${base}.backend: Invalid value: "": resource or service backend is required`);
            const port = p.backend?.service?.port;
            if (p.backend?.service && (!port || (port.number === undefined && port.name === undefined))) throw invalid("Ingress", name, `${base}.backend.service.port: Invalid value: "": port name or number is required`);
          });
          if (r.host && /^\d+\.\d+\.\d+\.\d+$/.test(r.host)) throw invalid("Ingress", name, `spec.rules[${i}].host: Invalid value: "${r.host}": must be a DNS name, not an IP address`);
        });
        break;
      }
      case "NetworkPolicy":
        if (obj.spec?.podSelector === undefined) throw invalid("NetworkPolicy", name, "spec.podSelector: Required value");
        break;
      case "CronJob": {
        const spec = obj.spec;
        if (!spec) throw invalid("CronJob", name, "spec: Required value");
        if (!spec.schedule) throw invalid("CronJob", name, "spec.schedule: Required value");
        try {
          parseSchedule(String(spec.schedule));
        } catch (e) {
          throw invalid("CronJob", name, `spec.schedule: Invalid value: "${spec.schedule}": ${(e as Error).message}`);
        }
        if (name.length > 52) throw invalid("CronJob", name, `metadata.name: Invalid value: "${name}": must be no more than 52 characters`);
        if (spec.concurrencyPolicy !== undefined && !["Allow", "Forbid", "Replace"].includes(spec.concurrencyPolicy)) {
          throw invalid("CronJob", name, `spec.concurrencyPolicy: Unsupported value: "${spec.concurrencyPolicy}": supported values: "Allow", "Forbid", "Replace"`);
        }
        validateJobSpec("CronJob", name, spec.jobTemplate?.spec, "spec.jobTemplate.spec");
        break;
      }
      case "ConfigMap":
      case "Secret": {
        for (const k of Object.keys({ ...(obj.data as object), ...((obj as { stringData?: object }).stringData ?? {}) })) {
          if (!/^[-._a-zA-Z0-9]+$/.test(k)) {
            throw invalid(obj.kind, name, `data[${k}]: Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.'`);
          }
        }
        break;
      }
    }
  }

  private applyDefaults(obj: KObject): void {
    switch (obj.kind) {
      case "Pod":
        defaultPodSpec(obj.spec);
        obj.status = obj.status ?? { phase: "Pending", qosClass: qosClass(obj.spec) };
        break;
      case "Deployment":
        obj.spec.replicas = obj.spec.replicas ?? 1;
        obj.spec.revisionHistoryLimit = obj.spec.revisionHistoryLimit ?? 10;
        obj.spec.progressDeadlineSeconds = obj.spec.progressDeadlineSeconds ?? 600;
        obj.spec.strategy = obj.spec.strategy ?? { type: "RollingUpdate" };
        if (obj.spec.strategy.type === "RollingUpdate") {
          obj.spec.strategy.rollingUpdate = { maxSurge: "25%", maxUnavailable: "25%", ...(obj.spec.strategy.rollingUpdate ?? {}) };
        }
        obj.spec.template.metadata = obj.spec.template.metadata ?? {};
        defaultPodSpec(obj.spec.template.spec);
        obj.status = obj.status ?? {};
        break;
      case "ReplicaSet":
        obj.spec.replicas = obj.spec.replicas ?? 1;
        defaultPodSpec(obj.spec.template.spec);
        obj.status = obj.status ?? { replicas: 0 };
        break;
      case "Service": {
        const spec = obj.spec;
        spec.type = spec.type ?? "ClusterIP";
        spec.sessionAffinity = spec.sessionAffinity ?? "None";
        if (spec.type !== "ExternalName") {
          spec.ipFamilies = spec.ipFamilies ?? ["IPv4"];
          spec.ipFamilyPolicy = spec.ipFamilyPolicy ?? "SingleStack";
          spec.internalTrafficPolicy = spec.internalTrafficPolicy ?? "Cluster";
        }
        if (spec.type === "NodePort" || spec.type === "LoadBalancer") spec.externalTrafficPolicy = spec.externalTrafficPolicy ?? "Cluster";
        for (const p of spec.ports ?? []) {
          p.protocol = p.protocol ?? "TCP";
          p.targetPort = p.targetPort ?? p.port;
        }
        obj.status = obj.status ?? { loadBalancer: {} };
        break;
      }
      case "Secret": {
        obj.type = obj.type ?? "Opaque";
        const stringData = (obj as { stringData?: Record<string, string> }).stringData;
        if (stringData) {
          obj.data = { ...((obj.data as object) ?? {}) };
          for (const [k, v] of Object.entries(stringData)) (obj.data as Record<string, string>)[k] = toBase64(String(v));
          delete (obj as { stringData?: unknown }).stringData;
        }
        break;
      }
      case "Namespace":
        obj.metadata.labels = { "kubernetes.io/metadata.name": obj.metadata.name, ...(obj.metadata.labels ?? {}) };
        obj.spec = obj.spec ?? { finalizers: ["kubernetes"] };
        obj.status = obj.status ?? { phase: "Active" };
        break;
      case "PersistentVolume":
        obj.spec = obj.spec ?? {};
        obj.spec.persistentVolumeReclaimPolicy = obj.spec.persistentVolumeReclaimPolicy ?? "Retain";
        obj.spec.volumeMode = obj.spec.volumeMode ?? "Filesystem";
        obj.status = obj.status ?? { phase: "Available" };
        break;
      case "StorageClass":
        obj.reclaimPolicy = obj.reclaimPolicy ?? "Delete";
        obj.volumeBindingMode = obj.volumeBindingMode ?? "Immediate";
        break;
      case "PersistentVolumeClaim":
        obj.spec = obj.spec ?? {};
        obj.spec.volumeMode = obj.spec.volumeMode ?? "Filesystem";
        obj.status = obj.status ?? { phase: "Pending" };
        break;
      case "Job":
        defaultJobSpec(obj.spec);
        obj.status = obj.status ?? {};
        break;
      case "CronJob":
        obj.spec.concurrencyPolicy = obj.spec.concurrencyPolicy ?? "Allow";
        obj.spec.suspend = obj.spec.suspend ?? false;
        obj.spec.successfulJobsHistoryLimit = obj.spec.successfulJobsHistoryLimit ?? 3;
        obj.spec.failedJobsHistoryLimit = obj.spec.failedJobsHistoryLimit ?? 1;
        obj.spec.jobTemplate = obj.spec.jobTemplate ?? {};
        obj.spec.jobTemplate.metadata = obj.spec.jobTemplate.metadata ?? {};
        defaultJobSpec(obj.spec.jobTemplate.spec, true);
        obj.status = obj.status ?? {};
        break;
      case "DaemonSet":
        obj.spec.updateStrategy = obj.spec.updateStrategy ?? { type: "RollingUpdate" };
        if (obj.spec.updateStrategy.type === "RollingUpdate") {
          obj.spec.updateStrategy.rollingUpdate = { maxSurge: 0, maxUnavailable: 1, ...(obj.spec.updateStrategy.rollingUpdate ?? {}) };
        }
        obj.spec.revisionHistoryLimit = obj.spec.revisionHistoryLimit ?? 10;
        obj.spec.template.metadata = obj.spec.template.metadata ?? {};
        defaultPodSpec(obj.spec.template.spec);
        obj.status = obj.status ?? { currentNumberScheduled: 0, desiredNumberScheduled: 0, numberMisscheduled: 0, numberReady: 0 };
        break;
      case "StatefulSet":
        obj.spec.replicas = obj.spec.replicas ?? 1;
        obj.spec.podManagementPolicy = obj.spec.podManagementPolicy ?? "OrderedReady";
        obj.spec.updateStrategy = obj.spec.updateStrategy ?? { type: "RollingUpdate" };
        if (obj.spec.updateStrategy.type === "RollingUpdate") {
          obj.spec.updateStrategy.rollingUpdate = { partition: 0, ...(obj.spec.updateStrategy.rollingUpdate ?? {}) };
        }
        obj.spec.revisionHistoryLimit = obj.spec.revisionHistoryLimit ?? 10;
        obj.spec.persistentVolumeClaimRetentionPolicy = obj.spec.persistentVolumeClaimRetentionPolicy ?? { whenDeleted: "Retain", whenScaled: "Retain" };
        obj.spec.template.metadata = obj.spec.template.metadata ?? {};
        defaultPodSpec(obj.spec.template.spec);
        for (const vct of obj.spec.volumeClaimTemplates ?? []) {
          vct.apiVersion = vct.apiVersion ?? "v1";
          vct.kind = vct.kind ?? "PersistentVolumeClaim";
          vct.spec = vct.spec ?? {};
          vct.spec.volumeMode = vct.spec.volumeMode ?? "Filesystem";
          vct.status = vct.status ?? { phase: "Pending" };
        }
        obj.status = obj.status ?? { replicas: 0, availableReplicas: 0 };
        break;
    }
  }

  /** Assign cluster IPs and node ports. */
  private allocate(obj: KObject): void {
    if (obj.kind !== "Service") return;
    const spec = obj.spec;
    if (spec.type === "ExternalName") return;
    if (!spec.clusterIP) {
      let ip = "";
      do ip = `10.${96 + this.random.int(16)}.${this.random.int(256)}.${1 + this.random.int(254)}`;
      while (this.usedServiceIps.has(ip));
      spec.clusterIP = ip;
    }
    this.usedServiceIps.add(spec.clusterIP);
    spec.clusterIPs = spec.clusterIPs ?? [spec.clusterIP];
    if (spec.type === "NodePort" || spec.type === "LoadBalancer") {
      for (const p of spec.ports) {
        if (!p.nodePort) {
          let port = 0;
          do port = 30000 + this.random.int(2768);
          while (this.usedNodePorts.has(port));
          p.nodePort = port;
        }
        this.usedNodePorts.add(p.nodePort);
      }
    } else {
      for (const p of spec.ports ?? []) delete p.nodePort;
    }
  }

  nextPodIp(nodeName: string): string {
    const nodes = this.list("Node").map((n) => n.metadata.name);
    const idx = Math.max(0, nodes.indexOf(nodeName));
    const n = (this.podIpCounters.get(nodeName) ?? 1) + 1;
    this.podIpCounters.set(nodeName, n);
    return `10.244.${idx}.${n}`;
  }

  // ---------------------------------------------------------------- events

  /**
   * Record an Event. Identical events are folded into one with a count, as the
   * real event recorder does. throttleMs skips repeats that come too quickly.
   */
  recordEvent(
    involved: KObject,
    type: "Normal" | "Warning",
    reason: string,
    message: string,
    source: EventSource,
    t = this.now(),
    throttleMs = 0,
  ): void {
    const ns = involved.metadata.namespace ?? "default";
    const dedupe = `${involved.metadata.uid}|${reason}|${message}`;
    const existingName = this.eventIndex.get(dedupe);
    const ts = isoTime(t);
    if (existingName) {
      const ev = this.get("Event", existingName, ns);
      if (ev) {
        if (throttleMs > 0 && t - Date.parse(String(ev.lastTimestamp)) < throttleMs) return;
        ev.count = ((ev.count as number) ?? 1) + 1;
        ev.lastTimestamp = ts;
        this.put(ev);
        return;
      }
    }
    const name = `${involved.metadata.name}.${(this.random.int(0xffffffff) >>> 0).toString(16).padStart(8, "0")}${this.random.int(0xffff).toString(16).padStart(4, "0")}`;
    const ev: KObject = {
      apiVersion: "v1",
      kind: "Event",
      metadata: { name, namespace: ns, uid: this.random.uid(), creationTimestamp: ts },
      involvedObject: {
        apiVersion: involved.apiVersion,
        kind: involved.kind,
        name: involved.metadata.name,
        namespace: involved.metadata.namespace,
        uid: involved.metadata.uid,
      },
      reason,
      message,
      source,
      type,
      count: 1,
      firstTimestamp: ts,
      lastTimestamp: ts,
      reportingComponent: source.component,
      reportingInstance: source.host ?? "",
    };
    this.eventIndex.set(dedupe, name);
    this.eventSeq.set(name, ++this.eventCounter);
    this.put(ev);
  }

  eventsFor(obj: KObject): KObject[] {
    return this.list("Event", obj.metadata.namespace ?? "default")
      .filter((e) => (e.involvedObject as { uid?: string }).uid === obj.metadata.uid)
      .sort((a, b) => this.compareEvents(a, b));
  }

  /** Order events by last occurrence, then by the order they were first recorded. */
  compareEvents(a: KObject, b: KObject): number {
    return (
      String(a.lastTimestamp).localeCompare(String(b.lastTimestamp)) ||
      (this.eventSeq.get(a.metadata.name) ?? 0) - (this.eventSeq.get(b.metadata.name) ?? 0)
    );
  }

  // ---------------------------------------------------------------- bootstrap

  private bootstrap(workers: string[]): void {
    const start = this.now() - 15 * 60 * 1000;
    const created = isoTime(start);
    const mk = (obj: KObject): KObject => {
      obj.metadata.uid = this.random.uid();
      obj.metadata.creationTimestamp = created;
      return this.put(obj);
    };
    for (const ns of ["default", "kube-system", "kube-public", "kube-node-lease"]) {
      mk({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: ns, labels: { "kubernetes.io/metadata.name": ns } },
        spec: { finalizers: ["kubernetes"] },
        status: { phase: "Active" },
      });
    }
    const nodeNames = ["controlplane", ...workers];
    nodeNames.forEach((name, i) => {
      const cp = i === 0;
      mk({
        apiVersion: "v1",
        kind: "Node",
        metadata: {
          name,
          labels: {
            "beta.kubernetes.io/arch": "amd64",
            "beta.kubernetes.io/os": "linux",
            "kubernetes.io/arch": "amd64",
            "kubernetes.io/hostname": name,
            "kubernetes.io/os": "linux",
            ...(cp ? { "node-role.kubernetes.io/control-plane": "" } : {}),
          },
          annotations: { "node.alpha.kubernetes.io/ttl": "0" },
        },
        spec: {
          podCIDR: `10.244.${i}.0/24`,
          podCIDRs: [`10.244.${i}.0/24`],
          ...(cp ? { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] } : {}),
        },
        status: {
          capacity: { cpu: "2", "ephemeral-storage": "20134592Ki", memory: "4005592Ki", pods: "110" },
          allocatable: { cpu: "2", "ephemeral-storage": "19586931083", memory: "3903192Ki", pods: "110" },
          conditions: [
            { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", message: "kubelet has sufficient memory available", lastHeartbeatTime: created, lastTransitionTime: created },
            { type: "DiskPressure", status: "False", reason: "KubeletHasNoDiskPressure", message: "kubelet has no disk pressure", lastHeartbeatTime: created, lastTransitionTime: created },
            { type: "PIDPressure", status: "False", reason: "KubeletHasSufficientPID", message: "kubelet has sufficient PID available", lastHeartbeatTime: created, lastTransitionTime: created },
            { type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status", lastHeartbeatTime: created, lastTransitionTime: created },
          ],
          addresses: [
            { type: "InternalIP", address: NODE_IPS[i] ?? `192.168.56.${10 + i}` },
            { type: "Hostname", address: name },
          ],
          nodeInfo: {
            architecture: "amd64",
            containerRuntimeVersion: "containerd://2.1.4",
            kernelVersion: "6.8.0-79-generic",
            kubeProxyVersion: "",
            kubeletVersion: K8S_VERSION,
            operatingSystem: "linux",
            osImage: "Ubuntu 24.04.3 LTS",
          },
        },
      });
    });

    // The "kubernetes" service in default.
    const k8sSvc = mk({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "kubernetes", namespace: "default", labels: { component: "apiserver", provider: "kubernetes" } },
      spec: {
        clusterIP: "10.96.0.1",
        clusterIPs: ["10.96.0.1"],
        internalTrafficPolicy: "Cluster",
        ipFamilies: ["IPv4"],
        ipFamilyPolicy: "SingleStack",
        ports: [{ name: "https", port: 443, protocol: "TCP", targetPort: 6443 }],
        sessionAffinity: "None",
        type: "ClusterIP",
      },
      status: { loadBalancer: {} },
    });
    this.usedServiceIps.add("10.96.0.1");
    mk({
      apiVersion: "v1",
      kind: "Endpoints",
      metadata: { name: "kubernetes", namespace: "default", labels: { "endpointslice.kubernetes.io/skip-mirror": "true" } },
      subsets: [{ addresses: [{ ip: NODE_IPS[0] }], ports: [{ name: "https", port: 6443, protocol: "TCP" }] }],
    });
    void k8sSvc;

    // Control plane static pods and system workloads, already running.
    const sys = (name: string, image: string, node: string, labels: Record<string, string>, hostNetwork: boolean, owner?: KObject) => {
      const pod = mk({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name,
          namespace: "kube-system",
          labels,
          ...(owner
            ? { ownerReferences: [{ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid!, controller: true, blockOwnerDeletion: true }] }
            : {}),
        },
        spec: {
          containers: [{ name: labels.component ?? labels["k8s-app"] ?? name, image }],
          nodeName: node,
          priorityClassName: "system-node-critical",
          priority: 2000001000,
          hostNetwork,
          tolerations: [{ operator: "Exists", effect: "NoExecute" }, { operator: "Exists", effect: "NoSchedule" }],
        },
        status: { phase: "Pending" },
      });
      defaultPodSpec(pod.spec);
      const nodeIp = this.get("Node", node)!.status.addresses[0].address;
      pod.status = {
        phase: "Pending",
        qosClass: "Burstable",
        hostIP: nodeIp,
        podIP: hostNetwork ? nodeIp : undefined,
      };
      this.podSims.set(pod.metadata.uid!, { scheduledAt: start, fixedIp: hostNetwork ? nodeIp : undefined, containers: {} });
      return pod;
    };
    const cpLabel = (component: string) => ({ component, tier: "control-plane" });
    sys("etcd-controlplane", "registry.k8s.io/etcd:3.6.4-0", "controlplane", cpLabel("etcd"), true);
    sys("kube-apiserver-controlplane", `registry.k8s.io/kube-apiserver:${K8S_VERSION}`, "controlplane", cpLabel("kube-apiserver"), true);
    sys("kube-controller-manager-controlplane", `registry.k8s.io/kube-controller-manager:${K8S_VERSION}`, "controlplane", cpLabel("kube-controller-manager"), true);
    sys("kube-scheduler-controlplane", `registry.k8s.io/kube-scheduler:${K8S_VERSION}`, "controlplane", cpLabel("kube-scheduler"), true);
    nodeNames.forEach((n) => {
      sys(`kube-proxy-${this.random.suffix(5)}`, `registry.k8s.io/kube-proxy:${K8S_VERSION}`, n, { "k8s-app": "kube-proxy" }, true);
    });

    // CoreDNS as a real Deployment so it shows up in `get deploy -A`.
    const coredns = this.create(
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "coredns", namespace: "kube-system", labels: { "k8s-app": "kube-dns" } },
        spec: {
          replicas: 2,
          selector: { matchLabels: { "k8s-app": "kube-dns" } },
          template: {
            metadata: { labels: { "k8s-app": "kube-dns" } },
            spec: {
              containers: [{ name: "coredns", image: "registry.k8s.io/coredns/coredns:v1.12.1", ports: [{ containerPort: 53, name: "dns", protocol: "UDP" }] }],
              tolerations: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }],
              nodeSelector: { "kubernetes.io/os": "linux" },
              priorityClassName: "system-cluster-critical",
            },
          },
        },
      },
    );
    coredns.metadata.creationTimestamp = created;
    this.create({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "kube-dns", namespace: "kube-system", labels: { "k8s-app": "kube-dns", "kubernetes.io/name": "CoreDNS" } },
      spec: {
        clusterIP: "10.96.0.10",
        selector: { "k8s-app": "kube-dns" },
        ports: [
          { name: "dns", port: 53, protocol: "UDP", targetPort: 53 },
          { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
          { name: "metrics", port: 9153, protocol: "TCP", targetPort: 9153 },
        ],
      },
    }).metadata.creationTimestamp = created;

    // Default ClusterRoles that bindings commonly reference.
    const readVerbs = ["get", "list", "watch"];
    const writeVerbs = ["create", "delete", "deletecollection", "patch", "update"];
    const core = ["pods", "pods/log", "services", "endpoints", "configmaps", "persistentvolumeclaims", "serviceaccounts", "events", "replicationcontrollers"];
    const apps = ["deployments", "replicasets", "statefulsets", "daemonsets", "deployments/scale", "replicasets/scale"];
    const roles: [string, unknown[]][] = [
      ["cluster-admin", [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }, { nonResourceURLs: ["*"], verbs: ["*"] }]],
      ["view", [{ apiGroups: [""], resources: core, verbs: readVerbs }, { apiGroups: ["apps"], resources: apps, verbs: readVerbs }]],
      [
        "edit",
        [
          { apiGroups: [""], resources: [...core, "secrets", "pods/exec"], verbs: [...readVerbs, ...writeVerbs] },
          { apiGroups: ["apps"], resources: apps, verbs: [...readVerbs, ...writeVerbs] },
        ],
      ],
      [
        "admin",
        [
          { apiGroups: [""], resources: [...core, "secrets", "pods/exec"], verbs: [...readVerbs, ...writeVerbs] },
          { apiGroups: ["apps"], resources: apps, verbs: [...readVerbs, ...writeVerbs] },
          { apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles", "rolebindings"], verbs: [...readVerbs, ...writeVerbs] },
        ],
      ],
    ];
    for (const [name, rules] of roles) {
      mk({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name, labels: { "kubernetes.io/bootstrapping": "rbac-defaults" } }, rules });
    }
    mk({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "cluster-admin", labels: { "kubernetes.io/bootstrapping": "rbac-defaults" } },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" },
      subjects: [{ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: "system:masters" }],
    });

    // The ingress-nginx controller, reachable on every node at NodePort 30080 (http) and 30443 (https).
    mk({ apiVersion: "v1", kind: "Namespace", metadata: { name: "ingress-nginx", labels: { "kubernetes.io/metadata.name": "ingress-nginx", "app.kubernetes.io/name": "ingress-nginx" } }, spec: { finalizers: ["kubernetes"] }, status: { phase: "Active" } });
    mk({
      apiVersion: "networking.k8s.io/v1",
      kind: "IngressClass",
      metadata: { name: "nginx", labels: { "app.kubernetes.io/name": "ingress-nginx", "app.kubernetes.io/component": "controller" }, annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } },
      spec: { controller: "k8s.io/ingress-nginx" },
    });
    const ingLabels = { "app.kubernetes.io/name": "ingress-nginx", "app.kubernetes.io/instance": "ingress-nginx", "app.kubernetes.io/component": "controller" };
    this.create({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "ingress-nginx-controller", namespace: "ingress-nginx", labels: { ...ingLabels } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { ...ingLabels } },
        template: {
          metadata: { labels: { ...ingLabels } },
          spec: {
            containers: [
              {
                name: "controller",
                image: "registry.k8s.io/ingress-nginx/controller:v1.14.0",
                ports: [{ name: "http", containerPort: 80 }, { name: "https", containerPort: 443 }],
                securityContext: { runAsUser: 101, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] } },
              },
            ],
            nodeSelector: { "kubernetes.io/os": "linux" },
          },
        },
      },
    }).metadata.creationTimestamp = created;
    this.create({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "ingress-nginx-controller", namespace: "ingress-nginx", labels: { ...ingLabels } },
      spec: {
        type: "NodePort",
        selector: { ...ingLabels },
        ports: [
          { name: "http", port: 80, targetPort: "http", nodePort: 30080, protocol: "TCP", appProtocol: "http" },
          { name: "https", port: 443, targetPort: "https", nodePort: 30443, protocol: "TCP", appProtocol: "https" },
        ],
      },
    }).metadata.creationTimestamp = created;

    mk({
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: { name: "standard", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
      provisioner: "rancher.io/local-path",
      reclaimPolicy: "Delete",
      volumeBindingMode: "Immediate",
    });

    // Let everything settle as if the cluster had been up for a while.
    this.lastT = start;
    this.advance();
    for (const o of this.objects.values()) {
      if ((o.metadata.namespace === "kube-system" || o.metadata.namespace === "ingress-nginx") && parseTimeSafe(o.metadata.creationTimestamp) > start) {
        o.metadata.creationTimestamp = created;
      }
    }
  }
}

const GENERATION_KINDS = ["Deployment", "ReplicaSet", "Pod", "Job", "CronJob", "DaemonSet", "StatefulSet"];

function validateJobSpec(kind: string, name: string, spec: KObject["spec"], path: string): void {
  if (!spec) throw invalid(kind, name, `${path}: Required value`);
  validatePodSpec(kind, name, spec.template?.spec, `${path}.template.spec`);
  const rp = spec.template?.spec?.restartPolicy;
  if (rp !== "OnFailure" && rp !== "Never") {
    throw invalid(kind, name, rp === undefined || rp === "Always"
      ? `${path}.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"`
      : `${path}.template.spec.restartPolicy: Unsupported value: "${rp}": supported values: "OnFailure", "Never"`);
  }
  for (const f of ["completions", "parallelism", "backoffLimit", "activeDeadlineSeconds", "ttlSecondsAfterFinished"]) {
    const v = spec[f];
    if (v !== undefined && (typeof v !== "number" || v < (f === "activeDeadlineSeconds" ? 1 : 0))) {
      throw invalid(kind, name, `${path}.${f}: Invalid value: ${v}: must be greater than or equal to ${f === "activeDeadlineSeconds" ? 1 : 0}`);
    }
  }
}

function defaultJobSpec(spec: KObject["spec"], inTemplate = false): void {
  if (!spec) return;
  if (spec.completions === undefined && spec.parallelism === undefined) {
    spec.completions = 1;
    spec.parallelism = 1;
  }
  spec.parallelism = spec.parallelism ?? 1;
  spec.backoffLimit = spec.backoffLimit ?? 6;
  spec.completionMode = spec.completionMode ?? "NonIndexed";
  spec.suspend = spec.suspend ?? false;
  spec.podReplacementPolicy = spec.podReplacementPolicy ?? "TerminatingOrFailed";
  spec.template = spec.template ?? {};
  spec.template.metadata = spec.template.metadata ?? {};
  defaultPodSpec(spec.template.spec);
  void inTemplate;
}

/** Jobs get a selector on their own uid, and their pod template gets matching labels. */
function jobSelector(job: KObject): void {
  if (job.spec.manualSelector && job.spec.selector) return;
  const uid = job.metadata.uid!;
  const name = job.metadata.name;
  job.spec.selector = { matchLabels: { "batch.kubernetes.io/controller-uid": uid } };
  job.spec.template.metadata.labels = {
    ...(job.spec.template.metadata.labels ?? {}),
    "batch.kubernetes.io/controller-uid": uid,
    "batch.kubernetes.io/job-name": name,
    "controller-uid": uid,
    "job-name": name,
  };
  job.metadata.labels = { "batch.kubernetes.io/controller-uid": uid, "batch.kubernetes.io/job-name": name, "controller-uid": uid, "job-name": name, ...(job.metadata.labels ?? {}) };
}

function parseTimeSafe(iso: string | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

// ---------------------------------------------------------------- helpers

export function notFound(plural: string, name: string): KubeError {
  const group = plural === "deployments" || plural === "replicasets" ? `${plural}.apps` : plural;
  return new KubeError(`Error from server (NotFound): ${group} "${name}" not found`);
}

export function invalid(kind: string, name: string, detail: string): KubeError {
  return new KubeError(`The ${kind} "${name}" is invalid: ${detail}`);
}

function goMap(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {})
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(", ");
  return `map[string]string{${entries}}`;
}

function describeSelector(sel: unknown): string {
  return `v1.LabelSelector{MatchLabels:${goMap((sel as { matchLabels?: Record<string, string> })?.matchLabels)}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}`;
}

function validatePodSpec(kind: string, name: string, spec: KObject["spec"], path: string): void {
  if (!spec) throw invalid(kind, name, `${path}: Required value`);
  const containers = spec.containers;
  if (!Array.isArray(containers) || containers.length === 0) throw invalid(kind, name, `${path}.containers: Required value`);
  const seen = new Set<string>();
  containers.forEach((c: { name?: string; image?: string; ports?: { containerPort?: unknown }[]; resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } }, i: number) => {
    const p = `${path}.containers[${i}]`;
    if (!c.name) throw invalid(kind, name, `${p}.name: Required value`);
    const nameErr = validateName(c.name, true);
    if (nameErr) throw invalid(kind, name, `${p}.name: Invalid value: "${c.name}": ${nameErr}`);
    if (seen.has(c.name)) throw invalid(kind, name, `${p}.name: Duplicate value: "${c.name}"`);
    seen.add(c.name);
    if (!c.image) throw invalid(kind, name, `${p}.image: Required value`);
    (c.ports ?? []).forEach((port, j) => {
      const cp = port.containerPort;
      if (typeof cp !== "number" || cp < 1 || cp > 65535) {
        throw invalid(kind, name, `${p}.ports[${j}].containerPort: Invalid value: ${cp}: must be between 1 and 65535, inclusive`);
      }
    });
    for (const section of ["requests", "limits"] as const) {
      for (const [res, q] of Object.entries(c.resources?.[section] ?? {})) {
        if (!isValidQuantity(q)) {
          throw invalid(kind, name, `${p}.resources.${section}[${res}]: Invalid value: "${q}": must match the regex ^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$`);
        }
      }
    }
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    if (req.cpu && lim.cpu && parseCpu(req.cpu as string) > parseCpu(lim.cpu as string)) {
      throw invalid(kind, name, `${p}.resources.requests: Invalid value: "${req.cpu}": must be less than or equal to cpu limit of ${lim.cpu}`);
    }
  });
  const rp = spec.restartPolicy;
  if (rp !== undefined && !["Always", "OnFailure", "Never"].includes(rp)) {
    throw invalid(kind, name, `${path}.restartPolicy: Unsupported value: "${rp}": supported values: "Always", "OnFailure", "Never"`);
  }
}

export function defaultPodSpec(spec: KObject["spec"]): void {
  if (!spec) return;
  spec.restartPolicy = spec.restartPolicy ?? "Always";
  spec.dnsPolicy = spec.dnsPolicy ?? "ClusterFirst";
  spec.schedulerName = spec.schedulerName ?? "default-scheduler";
  spec.terminationGracePeriodSeconds = spec.terminationGracePeriodSeconds ?? 30;
  spec.serviceAccountName = spec.serviceAccountName ?? "default";
  spec.securityContext = spec.securityContext ?? {};
  spec.enableServiceLinks = spec.enableServiceLinks ?? true;
  spec.preemptionPolicy = spec.preemptionPolicy ?? "PreemptLowerPriority";
  spec.priority = spec.priority ?? 0;
  spec.tolerations = spec.tolerations ?? [
    { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
    { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
  ];
  for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    c.imagePullPolicy = c.imagePullPolicy ?? defaultPullPolicy(c.image ?? "");
    c.resources = c.resources ?? {};
    c.terminationMessagePath = c.terminationMessagePath ?? "/dev/termination-log";
    c.terminationMessagePolicy = c.terminationMessagePolicy ?? "File";
    for (const p of c.ports ?? []) p.protocol = p.protocol ?? "TCP";
  }
}

function qosClass(spec: KObject["spec"]): string {
  const cs = spec?.containers ?? [];
  const any = cs.some((c: { resources?: { requests?: object; limits?: object } }) => Object.keys(c.resources?.requests ?? {}).length || Object.keys(c.resources?.limits ?? {}).length);
  if (!any) return "BestEffort";
  const guaranteed = cs.every((c: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }) => {
    const l = c.resources?.limits ?? {};
    const r = { ...l, ...(c.resources?.requests ?? {}) };
    return l.cpu && l.memory && r.cpu === l.cpu && r.memory === l.memory;
  });
  return guaranteed ? "Guaranteed" : "Burstable";
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
