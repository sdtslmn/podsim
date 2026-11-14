// Strict field validation for manifests, like the API server's
// server-side field validation. Catches typos ("imagee"), wrong types
// ("replicas: '3'") and unquoted label values ("version: 1.0"), which
// are among the most common mistakes new learners make.

import { KubeError } from "./types.js";

type T =
  | { t: "string" }
  | { t: "int" }
  | { t: "bool" }
  | { t: "intOrString" }
  | { t: "any" }
  | { t: "map"; value: "string" | "any" }
  | { t: "array"; of: T }
  | { t: "object"; go: string; fields: Record<string, T>; open?: boolean };

const S: T = { t: "string" };
const I: T = { t: "int" };
const B: T = { t: "bool" };
const IS: T = { t: "intOrString" };
const A: T = { t: "any" };
const SMAP: T = { t: "map", value: "string" };
const AMAP: T = { t: "map", value: "any" };
const arr = (of: T): T => ({ t: "array", of });
const obj = (go: string, fields: Record<string, T>, open = false): T => ({ t: "object", go, fields, open });

const ObjectMeta = obj("ObjectMeta", {
  name: S,
  generateName: S,
  namespace: S,
  labels: SMAP,
  annotations: SMAP,
  ownerReferences: A,
  finalizers: arr(S),
  uid: S,
  resourceVersion: S,
  generation: I,
  creationTimestamp: A,
  deletionTimestamp: A,
  deletionGracePeriodSeconds: I,
  managedFields: A,
  selfLink: S,
});

const keyRef = (go: string) => obj(go, { name: S, key: S, optional: B });
const EnvVar = obj("EnvVar", {
  name: S,
  value: S,
  valueFrom: obj("EnvVarSource", {
    configMapKeyRef: keyRef("ConfigMapKeySelector"),
    secretKeyRef: keyRef("SecretKeySelector"),
    fieldRef: obj("ObjectFieldSelector", { fieldPath: S, apiVersion: S }),
    resourceFieldRef: A,
    fileKeyRef: A,
  }),
});
const EnvFrom = obj("EnvFromSource", {
  configMapRef: obj("ConfigMapEnvSource", { name: S, optional: B }),
  secretRef: obj("SecretEnvSource", { name: S, optional: B }),
  prefix: S,
});
const ContainerPort = obj("ContainerPort", { containerPort: I, name: S, protocol: S, hostPort: I, hostIP: S });
const VolumeMount = obj("VolumeMount", { name: S, mountPath: S, readOnly: B, subPath: S, subPathExpr: S, mountPropagation: S, recursiveReadOnly: S });
const Resources = obj("ResourceRequirements", { requests: AMAP, limits: AMAP, claims: A });

const Container = obj("Container", {
  name: S,
  image: S,
  command: arr(S),
  args: arr(S),
  workingDir: S,
  ports: arr(ContainerPort),
  env: arr(EnvVar),
  envFrom: arr(EnvFrom),
  resources: Resources,
  resizePolicy: A,
  restartPolicy: S,
  volumeMounts: arr(VolumeMount),
  volumeDevices: A,
  livenessProbe: A,
  readinessProbe: A,
  startupProbe: A,
  lifecycle: A,
  terminationMessagePath: S,
  terminationMessagePolicy: S,
  imagePullPolicy: S,
  securityContext: A,
  stdin: B,
  stdinOnce: B,
  tty: B,
});

const Volume = obj("Volume", { name: S }, true);

const PodSpec = obj("PodSpec", {
  volumes: arr(Volume),
  initContainers: arr(Container),
  containers: arr(Container),
  ephemeralContainers: A,
  restartPolicy: S,
  terminationGracePeriodSeconds: I,
  activeDeadlineSeconds: I,
  dnsPolicy: S,
  nodeSelector: SMAP,
  serviceAccountName: S,
  serviceAccount: S,
  automountServiceAccountToken: B,
  nodeName: S,
  hostNetwork: B,
  hostPID: B,
  hostIPC: B,
  shareProcessNamespace: B,
  securityContext: A,
  imagePullSecrets: A,
  hostname: S,
  subdomain: S,
  affinity: A,
  schedulerName: S,
  tolerations: A,
  hostAliases: A,
  priorityClassName: S,
  priority: I,
  dnsConfig: A,
  readinessGates: A,
  runtimeClassName: S,
  enableServiceLinks: B,
  preemptionPolicy: S,
  overhead: A,
  topologySpreadConstraints: A,
  setHostnameAsFQDN: B,
  os: A,
  hostUsers: B,
  schedulingGates: A,
  resourceClaims: A,
  resources: A,
});

const PodTemplate = obj("PodTemplateSpec", { metadata: ObjectMeta, spec: PodSpec });

const ServicePort = obj("ServicePort", { name: S, protocol: S, appProtocol: S, port: I, targetPort: IS, nodePort: I });

const top = (kind: string, fields: Record<string, T>) => obj(kind, { apiVersion: S, kind: S, metadata: ObjectMeta, ...fields });

const LabelSelector = obj("LabelSelector", { matchLabels: SMAP, matchExpressions: arr(obj("LabelSelectorRequirement", { key: S, operator: S, values: arr(S) })) });
const NPPeer = obj("NetworkPolicyPeer", { podSelector: LabelSelector, namespaceSelector: LabelSelector, ipBlock: obj("IPBlock", { cidr: S, except: arr(S) }) });
const NPPort = obj("NetworkPolicyPort", { protocol: S, port: IS, endPort: I });
const IngressBackend = obj("IngressBackend", { service: obj("IngressServiceBackend", { name: S, port: obj("ServiceBackendPort", { name: S, number: I }) }), resource: A });

const JobSpec = obj("JobSpec", {
  parallelism: I,
  completions: I,
  activeDeadlineSeconds: I,
  podFailurePolicy: A,
  successPolicy: A,
  backoffLimit: I,
  backoffLimitPerIndex: I,
  maxFailedIndexes: I,
  selector: A,
  manualSelector: B,
  template: PodTemplate,
  ttlSecondsAfterFinished: I,
  completionMode: S,
  suspend: B,
  podReplacementPolicy: S,
  managedBy: S,
});

const PVCSpec = obj("PersistentVolumeClaimSpec", {
  accessModes: arr(S),
  selector: A,
  resources: obj("VolumeResourceRequirements", { requests: AMAP, limits: AMAP }),
  volumeName: S,
  storageClassName: S,
  volumeMode: S,
  dataSource: A,
  dataSourceRef: A,
  volumeAttributesClassName: S,
});

const SCHEMAS: Record<string, T> = {
  Pod: top("Pod", { spec: PodSpec, status: A }),
  Deployment: top("Deployment", {
    spec: obj("DeploymentSpec", {
      replicas: I,
      selector: A,
      template: PodTemplate,
      strategy: A,
      minReadySeconds: I,
      revisionHistoryLimit: I,
      paused: B,
      progressDeadlineSeconds: I,
    }),
    status: A,
  }),
  ReplicaSet: top("ReplicaSet", { spec: obj("ReplicaSetSpec", { replicas: I, minReadySeconds: I, selector: A, template: PodTemplate }), status: A }),
  Service: top("Service", {
    spec: obj("ServiceSpec", {
      ports: arr(ServicePort),
      selector: SMAP,
      clusterIP: S,
      clusterIPs: arr(S),
      type: S,
      externalIPs: arr(S),
      sessionAffinity: S,
      loadBalancerIP: S,
      loadBalancerSourceRanges: arr(S),
      externalName: S,
      externalTrafficPolicy: S,
      healthCheckNodePort: I,
      publishNotReadyAddresses: B,
      sessionAffinityConfig: A,
      ipFamilies: arr(S),
      ipFamilyPolicy: S,
      allocateLoadBalancerNodePorts: B,
      loadBalancerClass: S,
      internalTrafficPolicy: S,
      trafficDistribution: S,
    }),
    status: A,
  }),
  Job: top("Job", { spec: JobSpec, status: A }),
  CronJob: top("CronJob", {
    spec: obj("CronJobSpec", {
      schedule: S,
      timeZone: S,
      startingDeadlineSeconds: I,
      concurrencyPolicy: S,
      suspend: B,
      jobTemplate: obj("JobTemplateSpec", { metadata: ObjectMeta, spec: JobSpec }),
      successfulJobsHistoryLimit: I,
      failedJobsHistoryLimit: I,
    }),
    status: A,
  }),
  DaemonSet: top("DaemonSet", {
    spec: obj("DaemonSetSpec", { selector: A, template: PodTemplate, updateStrategy: A, minReadySeconds: I, revisionHistoryLimit: I }),
    status: A,
  }),
  StatefulSet: top("StatefulSet", {
    spec: obj("StatefulSetSpec", {
      replicas: I,
      selector: A,
      template: PodTemplate,
      volumeClaimTemplates: arr(obj("PersistentVolumeClaim", { apiVersion: S, kind: S, metadata: ObjectMeta, spec: PVCSpec, status: A })),
      serviceName: S,
      podManagementPolicy: S,
      updateStrategy: A,
      revisionHistoryLimit: I,
      minReadySeconds: I,
      persistentVolumeClaimRetentionPolicy: A,
      ordinals: A,
    }),
    status: A,
  }),
  PersistentVolumeClaim: top("PersistentVolumeClaim", { spec: PVCSpec, status: A }),
  NetworkPolicy: top("NetworkPolicy", {
    spec: obj("NetworkPolicySpec", {
      podSelector: LabelSelector,
      ingress: arr(obj("NetworkPolicyIngressRule", { from: arr(NPPeer), ports: arr(NPPort) })),
      egress: arr(obj("NetworkPolicyEgressRule", { to: arr(NPPeer), ports: arr(NPPort) })),
      policyTypes: arr(S),
    }),
    status: A,
  }),
  Ingress: top("Ingress", {
    spec: obj("IngressSpec", {
      ingressClassName: S,
      defaultBackend: IngressBackend,
      tls: arr(obj("IngressTLS", { hosts: arr(S), secretName: S })),
      rules: arr(obj("IngressRule", { host: S, http: obj("HTTPIngressRuleValue", { paths: arr(obj("HTTPIngressPath", { path: S, pathType: S, backend: IngressBackend })) }) })),
    }),
    status: A,
  }),
  ConfigMap: top("ConfigMap", { data: SMAP, binaryData: AMAP, immutable: B }),
  Secret: top("Secret", { data: SMAP, stringData: SMAP, type: S, immutable: B }),
  Namespace: top("Namespace", { spec: A, status: A }),
};

function typeName(t: T): string {
  switch (t.t) {
    case "string":
      return "string";
    case "int":
      return "int32";
    case "bool":
      return "bool";
    case "intOrString":
      return "intstr.IntOrString";
    case "map":
      return t.value === "string" ? "string" : "map[string]interface {}";
    case "array":
      return t.of.t === "object" ? `[]v1.${t.of.go}` : `[]${typeName(t.of)}`;
    case "object":
      return `v1.${t.go}`;
    default:
      return "interface {}";
  }
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  return "object";
}

interface Problem {
  kind: "unknown" | "type";
  path: string;
  goStruct?: string;
  goPath?: string;
  actual?: string;
  expected?: string;
}

function walk(value: unknown, t: T, path: string, goStruct: string, goPath: string, problems: Problem[]): void {
  if (value === null || value === undefined) return;
  const typeErr = (expected: string) => problems.push({ kind: "type", path, goStruct, goPath, actual: jsType(value), expected });
  switch (t.t) {
    case "any":
      return;
    case "string":
      if (typeof value !== "string") typeErr("string");
      return;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) typeErr("int32");
      return;
    case "bool":
      if (typeof value !== "boolean") typeErr("bool");
      return;
    case "intOrString":
      if (typeof value !== "number" && typeof value !== "string") typeErr("intstr.IntOrString");
      return;
    case "map":
      if (typeof value !== "object" || Array.isArray(value)) {
        typeErr(t.value === "string" ? "map[string]string" : "map[string]interface {}");
        return;
      }
      if (t.value === "string") {
        for (const [k, v] of Object.entries(value as object)) {
          if (typeof v !== "string") problems.push({ kind: "type", path: `${path}.${k}`, goStruct, goPath, actual: jsType(v), expected: "string" });
        }
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        typeErr(typeName(t));
        return;
      }
      value.forEach((item, i) => walk(item, t.of, `${path}[${i}]`, t.of.t === "object" ? t.of.go : goStruct, `${goPath}`, problems));
      return;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        typeErr(typeName(t));
        return;
      }
      for (const [k, v] of Object.entries(value as object)) {
        const child = t.fields[k];
        const p = path ? `${path}.${k}` : k;
        if (!child) {
          if (!t.open) problems.push({ kind: "unknown", path: p });
          continue;
        }
        walk(v, child, p, t.go, goPath ? `${goPath}.${k}` : k, problems);
      }
    }
  }
}

/** Throw the error the API server would return for an invalid manifest, if any. */
export function validateFields(obj: Record<string, unknown>, verb: "creating" | "applying" | "replacing", source: string): void {
  const kind = String(obj.kind ?? "");
  const schema = SCHEMAS[kind];
  if (!schema) return;
  const problems: Problem[] = [];
  walk(obj, schema, "", kind, "", problems);
  if (problems.length === 0) return;
  const apiVersion = String(obj.apiVersion ?? "v1");
  const version = apiVersion.includes("/") ? apiVersion.split("/")[1] : apiVersion;
  const what = `${kind} in version "${version}" cannot be handled as a ${kind}`;
  const action = verb === "creating" ? "error when creating" : verb === "applying" ? "error when applying patch" : "error when replacing";
  const typeProblem = problems.find((p) => p.kind === "type");
  if (typeProblem) {
    const field = typeProblem.goPath ? `${typeProblem.goStruct}.${typeProblem.goPath}` : typeProblem.goStruct;
    throw new KubeError(
      `Error from server (BadRequest): ${action} "${source}": ${what}: json: cannot unmarshal ${typeProblem.actual} into Go struct field ${field} of type ${typeProblem.expected}`,
    );
  }
  const unknown = problems.filter((p) => p.kind === "unknown").map((p) => `unknown field "${p.path}"`);
  throw new KubeError(`Error from server (BadRequest): ${action} "${source}": ${what}: strict decoding error: ${unknown.join(", ")}`);
}
