// kubectl explain: field documentation for the resources learners use most.
// Field names and types follow the Kubernetes API; descriptions are short
// summaries written for the simulator.

import { KubeError } from "../types.js";
import type { Flags } from "./flags.js";
import { type Ctx, out, kindOrThrow } from "./common.js";

/** Go type → field → "type|description". A trailing "!" on the type marks a required field. */
type Fields = Record<string, string>;

const P = "string";
const META = "ObjectMeta|Standard object metadata: name, namespace, labels, annotations.";
const top = (spec: string, status = "", extra: Fields = {}): Fields => ({
  apiVersion: `${P}|APIVersion defines the versioned schema of this representation of an object.`,
  kind: `${P}|Kind is a string value representing the REST resource this object represents.`,
  metadata: META,
  ...(spec ? { spec: `${spec}|Desired behavior, set by the user.` } : {}),
  ...(status ? { status: `${status}|Most recently observed status, filled in by the system. Read-only.` } : {}),
  ...extra,
});

const TYPES: Record<string, Fields> = {
  ObjectMeta: {
    annotations: "map[string]string|Unstructured key/value data for tools. Not used for selection.",
    creationTimestamp: "string|When the object was created. Set by the server. Read-only.",
    generateName: "string|Prefix the server uses to generate a unique name when name is empty.",
    labels: "map[string]string|Key/value pairs used to organize and select objects (selectors, Services, Deployments).",
    name: "string|Name, unique within a namespace. Required when creating, cannot be updated.",
    namespace: "string|Namespace of the object. Empty means the default namespace for namespaced kinds.",
    ownerReferences: "[]OwnerReference|Objects this object depends on. Used for garbage collection.",
    uid: "string|Unique ID for the object's whole lifetime. Set by the server.",
  },
  Pod: top("PodSpec", "PodStatus"),
  PodSpec: {
    activeDeadlineSeconds: "integer|Seconds the pod may be active before the system fails it.",
    affinity: "Affinity|Scheduling constraints: node affinity, pod affinity and anti-affinity.",
    automountServiceAccountToken: "boolean|Whether a service account token is mounted automatically.",
    containers: "[]Container!|Containers in the pod. At least one is required. Cannot be updated.",
    dnsPolicy: "string|DNS policy: ClusterFirst (default), ClusterFirstWithHostNet, Default or None.",
    ephemeralContainers: "[]EphemeralContainer|Debug containers added to a running pod with kubectl debug.",
    hostNetwork: "boolean|Use the node's network namespace.",
    hostname: "string|Hostname of the pod. Defaults to the pod name.",
    imagePullSecrets: "[]LocalObjectReference|Secrets used to pull images from private registries.",
    initContainers: "[]Container|Containers that run to completion, in order, before the app containers start. An init container with restartPolicy Always is a sidecar.",
    nodeName: "string|Schedule onto this node directly, bypassing the scheduler.",
    nodeSelector: "map[string]string|Node labels the pod's node must have.",
    priorityClassName: "string|Name of a PriorityClass for the pod.",
    restartPolicy: "string|Restart policy for all containers: Always (default), OnFailure or Never.",
    securityContext: "PodSecurityContext|Pod-level security attributes and common container settings.",
    serviceAccountName: "string|Name of the ServiceAccount the pod runs as. Defaults to default.",
    shareProcessNamespace: "boolean|Share one process namespace between all containers in the pod.",
    subdomain: "string|With hostname, gives the pod a DNS name through a headless Service.",
    terminationGracePeriodSeconds: "integer|Seconds the pod gets to stop after SIGTERM. Defaults to 30.",
    tolerations: "[]Toleration|Taints the pod tolerates.",
    topologySpreadConstraints: "[]TopologySpreadConstraint|How pods are spread across topology domains.",
    volumes: "[]Volume|Volumes that containers in the pod can mount.",
  },
  Container: {
    args: "[]string|Arguments to the entrypoint. Replace the image's CMD.",
    command: "[]string|Entrypoint array. Not run in a shell. Replaces the image's ENTRYPOINT.",
    env: "[]EnvVar|Environment variables to set in the container.",
    envFrom: "[]EnvFromSource|Sources (ConfigMaps, Secrets) whose keys become environment variables.",
    image: "string|Container image name, for example nginx:1.29.",
    imagePullPolicy: "string|Always, Never or IfNotPresent. Defaults to Always for :latest, IfNotPresent otherwise.",
    lifecycle: "Lifecycle|Actions run right after start (postStart) and before stop (preStop).",
    livenessProbe: "Probe|Periodic probe of container liveness. The container is restarted if it fails.",
    name: "string!|Name of the container, unique within the pod (DNS label).",
    ports: "[]ContainerPort|Ports the container exposes. Informational, but names can be referenced.",
    readinessProbe: "Probe|Periodic probe of readiness. A failing container is removed from Service endpoints.",
    resources: "ResourceRequirements|Compute resources (cpu, memory) requested and limited.",
    restartPolicy: "string|For init containers only: Always makes it a sidecar that keeps running.",
    securityContext: "SecurityContext|Security options for this container, overriding the pod's.",
    startupProbe: "Probe|Probe that must succeed before liveness and readiness probes start.",
    stdin: "boolean|Keep stdin open (kubectl run -i).",
    tty: "boolean|Allocate a TTY (kubectl run -t).",
    volumeMounts: "[]VolumeMount|Volumes to mount into the container's filesystem.",
    workingDir: "string|Working directory. Defaults to the image's WORKDIR.",
  },
  Probe: {
    exec: "ExecAction|Run a command in the container. Exit code 0 is success.",
    failureThreshold: "integer|Consecutive failures before the probe is considered failed. Defaults to 3.",
    grpc: "GRPCAction|Call the gRPC health checking protocol on a port.",
    httpGet: "HTTPGetAction|Send an HTTP GET. Status 200-399 is success.",
    initialDelaySeconds: "integer|Seconds after the container starts before probes begin.",
    periodSeconds: "integer|How often to probe, in seconds. Defaults to 10.",
    successThreshold: "integer|Consecutive successes needed after a failure. Must be 1 for liveness and startup.",
    tcpSocket: "TCPSocketAction|Open a TCP connection to a port.",
    terminationGracePeriodSeconds: "integer|Grace period when the probe fails and the container is killed.",
    timeoutSeconds: "integer|Seconds after which the probe times out. Defaults to 1.",
  },
  ExecAction: { command: "[]string|Command to run inside the container. Not run in a shell; use sh -c for shell features." },
  HTTPGetAction: {
    host: "string|Host name to connect to. Defaults to the pod IP.",
    httpHeaders: "[]HTTPHeader|Custom headers to send.",
    path: "string|Path to request.",
    port: "IntOrString!|Port number or name.",
    scheme: "string|HTTP (default) or HTTPS.",
  },
  TCPSocketAction: { host: "string|Host to connect to. Defaults to the pod IP.", port: "IntOrString!|Port number or name." },
  GRPCAction: { port: "integer!|Port of the gRPC service.", service: "string|Service name to place in the health check request." },
  HTTPHeader: { name: "string!|Header name.", value: "string!|Header value." },
  Lifecycle: { postStart: "LifecycleHandler|Called right after the container is created.", preStop: "LifecycleHandler|Called before the container is terminated." },
  LifecycleHandler: { exec: "ExecAction|Command to run.", httpGet: "HTTPGetAction|HTTP request to send.", sleep: "SleepAction|Sleep for a number of seconds.", tcpSocket: "TCPSocketAction|Deprecated." },
  SleepAction: { seconds: "integer!|Seconds to sleep." },
  ResourceRequirements: {
    limits: "map[string]Quantity|Maximum resources allowed. Exceeding the memory limit gets the container OOMKilled.",
    requests: "map[string]Quantity|Minimum resources needed; used for scheduling. Defaults to limits when only limits are set.",
  },
  SecurityContext: {
    allowPrivilegeEscalation: "boolean|Whether a process can gain more privileges than its parent.",
    capabilities: "Capabilities|Linux capabilities to add or drop.",
    privileged: "boolean|Run as privileged: like root on the host.",
    readOnlyRootFilesystem: "boolean|Mount the container's root filesystem read-only.",
    runAsGroup: "integer|GID to run the entrypoint as.",
    runAsNonRoot: "boolean|Refuse to start if the container would run as UID 0.",
    runAsUser: "integer|UID to run the entrypoint as. Defaults to the image's USER.",
    seccompProfile: "SeccompProfile|Seccomp options: RuntimeDefault, Localhost or Unconfined.",
  },
  PodSecurityContext: {
    fsGroup: "integer|Group that owns mounted volumes and is added to every container's groups.",
    runAsGroup: "integer|Default GID for all containers.",
    runAsNonRoot: "boolean|Refuse to start containers that would run as root.",
    runAsUser: "integer|Default UID for all containers.",
    seccompProfile: "SeccompProfile|Default seccomp profile for all containers.",
    supplementalGroups: "[]integer|Extra groups for the first process of every container.",
  },
  Capabilities: { add: "[]string|Capabilities to add, for example NET_ADMIN.", drop: "[]string|Capabilities to drop, for example ALL." },
  SeccompProfile: { localhostProfile: "string|Profile file on the node, for type Localhost.", type: "string!|RuntimeDefault, Localhost or Unconfined." },
  EnvVar: {
    name: "string!|Name of the environment variable.",
    value: "string|Value. $(VAR) references to earlier variables are expanded.",
    valueFrom: "EnvVarSource|Take the value from a ConfigMap, Secret, pod field or resource.",
  },
  EnvVarSource: {
    configMapKeyRef: "ConfigMapKeySelector|A key of a ConfigMap.",
    fieldRef: "ObjectFieldSelector|A pod field: metadata.name, metadata.namespace, status.podIP, spec.nodeName...",
    resourceFieldRef: "ResourceFieldSelector|A container resource: limits.cpu, requests.memory...",
    secretKeyRef: "SecretKeySelector|A key of a Secret.",
  },
  ConfigMapKeySelector: { key: "string!|The key to select.", name: "string|Name of the ConfigMap.", optional: "boolean|Do not fail if the ConfigMap or key is missing." },
  SecretKeySelector: { key: "string!|The key to select.", name: "string|Name of the Secret.", optional: "boolean|Do not fail if the Secret or key is missing." },
  ObjectFieldSelector: { apiVersion: "string|Schema version of fieldPath. Defaults to v1.", fieldPath: "string!|Path of the field, for example metadata.name." },
  ResourceFieldSelector: { containerName: "string|Container name. Required for volumes.", divisor: "Quantity|Output unit, defaults to 1.", resource: "string!|Resource, for example limits.memory." },
  EnvFromSource: { configMapRef: "ConfigMapEnvSource|ConfigMap to read keys from.", prefix: "string|Prefix added to every key.", secretRef: "SecretEnvSource|Secret to read keys from." },
  ConfigMapEnvSource: { name: "string|Name of the ConfigMap.", optional: "boolean|Do not fail if it is missing." },
  SecretEnvSource: { name: "string|Name of the Secret.", optional: "boolean|Do not fail if it is missing." },
  ContainerPort: { containerPort: "integer!|Port number on the pod's IP.", hostPort: "integer|Port on the node. Rarely needed.", name: "string|Name that Services can refer to.", protocol: "string|TCP (default), UDP or SCTP." },
  VolumeMount: {
    mountPath: "string!|Path in the container where the volume is mounted.",
    name: "string!|Name of the volume (from spec.volumes).",
    readOnly: "boolean|Mount read-only.",
    subPath: "string|Mount only this path inside the volume, for example one key of a ConfigMap.",
  },
  Volume: {
    configMap: "ConfigMapVolumeSource|Files from a ConfigMap, one per key.",
    downwardAPI: "DownwardAPIVolumeSource|Files with pod fields and resources.",
    emptyDir: "EmptyDirVolumeSource|Empty directory that lives as long as the pod. Shared between containers.",
    hostPath: "HostPathVolumeSource|A file or directory from the node.",
    name: "string!|Volume name, referenced by volumeMounts.",
    persistentVolumeClaim: "PersistentVolumeClaimVolumeSource|Storage from a PersistentVolumeClaim.",
    projected: "ProjectedVolumeSource|Several sources (secrets, configMaps, downwardAPI, serviceAccountToken) in one directory.",
    secret: "SecretVolumeSource|Files from a Secret, one per key.",
  },
  ConfigMapVolumeSource: { defaultMode: "integer|File mode bits, for example 0644.", items: "[]KeyToPath|Only these keys, at these paths.", name: "string|Name of the ConfigMap.", optional: "boolean|Do not fail if it is missing." },
  SecretVolumeSource: { defaultMode: "integer|File mode bits.", items: "[]KeyToPath|Only these keys, at these paths.", optional: "boolean|Do not fail if it is missing.", secretName: "string|Name of the Secret." },
  KeyToPath: { key: "string!|Key to project.", mode: "integer|File mode bits.", path: "string!|Relative path of the file." },
  EmptyDirVolumeSource: { medium: "string|Empty for node storage, or Memory for tmpfs.", sizeLimit: "Quantity|Maximum size." },
  HostPathVolumeSource: { path: "string!|Path on the node.", type: "string|Directory, DirectoryOrCreate, File, FileOrCreate, Socket..." },
  PersistentVolumeClaimVolumeSource: { claimName: "string!|Name of a PersistentVolumeClaim in the pod's namespace.", readOnly: "boolean|Mount read-only." },
  DownwardAPIVolumeSource: { defaultMode: "integer|File mode bits.", items: "[]DownwardAPIVolumeFile|Files to create." },
  DownwardAPIVolumeFile: { fieldRef: "ObjectFieldSelector|Pod field.", path: "string!|Relative file path.", resourceFieldRef: "ResourceFieldSelector|Container resource." },
  ProjectedVolumeSource: { defaultMode: "integer|File mode bits.", sources: "[]VolumeProjection|Sources to project." },
  VolumeProjection: { configMap: "ConfigMapProjection|A ConfigMap.", downwardAPI: "DownwardAPIProjection|Pod fields.", secret: "SecretProjection|A Secret.", serviceAccountToken: "ServiceAccountTokenProjection|A service account token." },
  Toleration: {
    effect: "string|NoSchedule, PreferNoSchedule or NoExecute. Empty matches all effects.",
    key: "string|Taint key. Empty with operator Exists matches all taints.",
    operator: "string|Exists or Equal (default).",
    tolerationSeconds: "integer|For NoExecute: how long the pod stays after the taint appears.",
    value: "string|Taint value for operator Equal.",
  },
  Affinity: { nodeAffinity: "NodeAffinity|Node affinity rules.", podAffinity: "PodAffinity|Co-locate with other pods.", podAntiAffinity: "PodAntiAffinity|Keep away from other pods." },
  NodeAffinity: {
    preferredDuringSchedulingIgnoredDuringExecution: "[]PreferredSchedulingTerm|Preferred node terms, with weights.",
    requiredDuringSchedulingIgnoredDuringExecution: "NodeSelector|Hard requirement for the node.",
  },
  NodeSelector: { nodeSelectorTerms: "[]NodeSelectorTerm!|Terms ORed together." },
  NodeSelectorTerm: { matchExpressions: "[]NodeSelectorRequirement|Node label requirements.", matchFields: "[]NodeSelectorRequirement|Node field requirements." },
  NodeSelectorRequirement: { key: "string!|Label key.", operator: "string!|In, NotIn, Exists, DoesNotExist, Gt or Lt.", values: "[]string|Values." },
  LabelSelector: { matchExpressions: "[]LabelSelectorRequirement|Set-based requirements, ANDed.", matchLabels: "map[string]string|Exact label matches, ANDed." },
  LabelSelectorRequirement: { key: "string!|Label key.", operator: "string!|In, NotIn, Exists or DoesNotExist.", values: "[]string|Values for In and NotIn." },
  PodTemplateSpec: { metadata: META, spec: "PodSpec|Pod specification." },
  Deployment: top("DeploymentSpec", "DeploymentStatus"),
  DeploymentSpec: {
    minReadySeconds: "integer|Seconds a new pod must be ready before it counts as available.",
    paused: "boolean|Pause rollouts.",
    progressDeadlineSeconds: "integer|Seconds before a stuck rollout is reported as failed. Defaults to 600.",
    replicas: "integer|Number of desired pods. Defaults to 1.",
    revisionHistoryLimit: "integer|Old ReplicaSets kept for rollback. Defaults to 10.",
    selector: "LabelSelector!|Selects the pods this Deployment manages. Must match the template labels. Immutable.",
    strategy: "DeploymentStrategy|How old pods are replaced: RollingUpdate (default) or Recreate.",
    template: "PodTemplateSpec!|Template for the pods.",
  },
  DeploymentStrategy: { rollingUpdate: "RollingUpdateDeployment|Rolling update parameters.", type: "string|Recreate or RollingUpdate (default)." },
  RollingUpdateDeployment: {
    maxSurge: "IntOrString|Pods allowed above the desired count during an update. Number or percentage. Defaults to 25%.",
    maxUnavailable: "IntOrString|Pods that may be unavailable during an update. Number or percentage. Defaults to 25%.",
  },
  ReplicaSet: top("ReplicaSetSpec", "ReplicaSetStatus"),
  ReplicaSetSpec: { minReadySeconds: "integer|Seconds before a ready pod counts as available.", replicas: "integer|Desired pods.", selector: "LabelSelector!|Pod selector.", template: "PodTemplateSpec|Pod template." },
  DaemonSet: top("DaemonSetSpec", "DaemonSetStatus"),
  DaemonSetSpec: { minReadySeconds: "integer|Seconds before a ready pod counts as available.", revisionHistoryLimit: "integer|Old revisions kept.", selector: "LabelSelector!|Pod selector.", template: "PodTemplateSpec!|Pod template.", updateStrategy: "DaemonSetUpdateStrategy|RollingUpdate (default) or OnDelete." },
  DaemonSetUpdateStrategy: { rollingUpdate: "RollingUpdateDaemonSet|Rolling update parameters.", type: "string|RollingUpdate or OnDelete." },
  RollingUpdateDaemonSet: { maxSurge: "IntOrString|Extra pods during an update.", maxUnavailable: "IntOrString|Unavailable pods during an update. Defaults to 1." },
  StatefulSet: top("StatefulSetSpec", "StatefulSetStatus"),
  StatefulSetSpec: {
    podManagementPolicy: "string|OrderedReady (default) or Parallel.",
    replicas: "integer|Desired pods.",
    selector: "LabelSelector!|Pod selector.",
    serviceName: "string|Headless Service that gives each pod a stable DNS name.",
    template: "PodTemplateSpec!|Pod template.",
    updateStrategy: "StatefulSetUpdateStrategy|RollingUpdate (default) or OnDelete.",
    volumeClaimTemplates: "[]PersistentVolumeClaim|One PVC per pod is created from each template.",
  },
  StatefulSetUpdateStrategy: { rollingUpdate: "RollingUpdateStatefulSetStrategy|Rolling update parameters.", type: "string|RollingUpdate or OnDelete." },
  RollingUpdateStatefulSetStrategy: { maxUnavailable: "IntOrString|Unavailable pods during an update.", partition: "integer|Only pods with an ordinal at or above this are updated." },
  Job: top("JobSpec", "JobStatus"),
  JobSpec: {
    activeDeadlineSeconds: "integer|Seconds the Job may run before it is terminated and marked Failed.",
    backoffLimit: "integer|Retries before the Job is marked Failed. Defaults to 6.",
    completionMode: "string|NonIndexed (default) or Indexed.",
    completions: "integer|Successful pods needed. Defaults to 1.",
    parallelism: "integer|Pods running at the same time. Defaults to 1.",
    selector: "LabelSelector|Set by the system.",
    suspend: "boolean|Do not create pods while true.",
    template: "PodTemplateSpec!|Pod template. restartPolicy must be Never or OnFailure.",
    ttlSecondsAfterFinished: "integer|Delete the Job this many seconds after it finishes.",
  },
  CronJob: top("CronJobSpec", "CronJobStatus"),
  CronJobSpec: {
    concurrencyPolicy: "string|Allow (default), Forbid or Replace.",
    failedJobsHistoryLimit: "integer|Failed Jobs kept. Defaults to 1.",
    jobTemplate: "JobTemplateSpec!|Template for the Jobs.",
    schedule: "string!|Cron schedule, for example */5 * * * *.",
    startingDeadlineSeconds: "integer|Seconds after a missed schedule a Job may still start.",
    successfulJobsHistoryLimit: "integer|Successful Jobs kept. Defaults to 3.",
    suspend: "boolean|Do not start new Jobs while true.",
    timeZone: "string|Time zone name for the schedule, for example Etc/UTC.",
  },
  JobTemplateSpec: { metadata: META, spec: "JobSpec|Job specification." },
  Service: top("ServiceSpec", "ServiceStatus"),
  ServiceSpec: {
    clusterIP: "string|Virtual IP. None makes a headless Service. Mostly immutable.",
    externalName: "string|DNS name for type ExternalName.",
    externalTrafficPolicy: "string|Cluster (default) or Local.",
    ports: "[]ServicePort|Ports the Service exposes.",
    selector: "map[string]string|Pods with these labels receive the traffic.",
    sessionAffinity: "string|ClientIP or None (default).",
    type: "string|ClusterIP (default), NodePort, LoadBalancer or ExternalName.",
  },
  ServicePort: {
    name: "string|Port name. Required when there is more than one port.",
    nodePort: "integer|Port on every node for NodePort and LoadBalancer (30000-32767). Allocated when empty.",
    port: "integer!|Port the Service listens on.",
    protocol: "string|TCP (default), UDP or SCTP.",
    targetPort: "IntOrString|Port number or name on the pods. Defaults to port.",
  },
  ConfigMap: top("", "", { binaryData: "map[string]string|Binary values, base64 encoded.", data: "map[string]string|Configuration data.", immutable: "boolean|When true, data cannot be changed." }),
  Secret: top("", "", { data: "map[string]string|Values, base64 encoded.", immutable: "boolean|When true, data cannot be changed.", stringData: "map[string]string|Plain text values, merged into data on write.", type: "string|Opaque (default), kubernetes.io/tls, kubernetes.io/dockerconfigjson..." }),
  ServiceAccount: top("", "", { automountServiceAccountToken: "boolean|Whether pods get a token automatically.", imagePullSecrets: "[]LocalObjectReference|Pull secrets added to pods.", secrets: "[]ObjectReference|Deprecated." }),
  Namespace: top("NamespaceSpec", "NamespaceStatus"),
  NamespaceSpec: { finalizers: "[]string|Finalizers." },
  NetworkPolicy: top("NetworkPolicySpec"),
  NetworkPolicySpec: {
    egress: "[]NetworkPolicyEgressRule|Allowed outgoing traffic. Applies when policyTypes includes Egress.",
    ingress: "[]NetworkPolicyIngressRule|Allowed incoming traffic. An empty list denies all.",
    podSelector: "LabelSelector!|Pods the policy applies to. Empty selects all pods in the namespace.",
    policyTypes: "[]string|Ingress, Egress or both. Defaults to Ingress, plus Egress when egress rules exist.",
  },
  NetworkPolicyIngressRule: { from: "[]NetworkPolicyPeer|Allowed sources. Empty means any.", ports: "[]NetworkPolicyPort|Allowed ports. Empty means all." },
  NetworkPolicyEgressRule: { ports: "[]NetworkPolicyPort|Allowed ports. Empty means all.", to: "[]NetworkPolicyPeer|Allowed destinations. Empty means any." },
  NetworkPolicyPeer: {
    ipBlock: "IPBlock|A CIDR range.",
    namespaceSelector: "LabelSelector|Namespaces. With podSelector in the same entry, both must match.",
    podSelector: "LabelSelector|Pods, in the policy's namespace unless namespaceSelector is set.",
  },
  NetworkPolicyPort: { endPort: "integer|End of a port range.", port: "IntOrString|Port number or name.", protocol: "string|TCP (default), UDP or SCTP." },
  IPBlock: { cidr: "string!|CIDR, for example 10.0.0.0/16.", except: "[]string|CIDRs excluded from the block." },
  Ingress: top("IngressSpec", "IngressStatus"),
  IngressSpec: {
    defaultBackend: "IngressBackend|Backend for requests that match no rule.",
    ingressClassName: "string|IngressClass that implements this Ingress, for example nginx.",
    rules: "[]IngressRule|Host and path rules.",
    tls: "[]IngressTLS|TLS hosts and the Secrets with their certificates.",
  },
  IngressRule: { host: "string|Host name. Empty matches all hosts.", http: "HTTPIngressRuleValue|Paths for this host." },
  HTTPIngressRuleValue: { paths: "[]HTTPIngressPath!|Path to backend mappings." },
  HTTPIngressPath: { backend: "IngressBackend!|Where matching requests go.", path: "string|Path to match, starting with /.", pathType: "string!|Exact, Prefix or ImplementationSpecific." },
  IngressBackend: { resource: "TypedLocalObjectReference|Another resource as backend.", service: "IngressServiceBackend|A Service as backend." },
  IngressServiceBackend: { name: "string!|Service name.", port: "ServiceBackendPort|Service port." },
  ServiceBackendPort: { name: "string|Port name.", number: "integer|Port number." },
  IngressTLS: { hosts: "[]string|Hosts in the certificate.", secretName: "string|Secret with tls.crt and tls.key." },
  PersistentVolumeClaim: top("PersistentVolumeClaimSpec", "PersistentVolumeClaimStatus"),
  PersistentVolumeClaimSpec: {
    accessModes: "[]string|ReadWriteOnce, ReadOnlyMany, ReadWriteMany or ReadWriteOncePod.",
    resources: "VolumeResourceRequirements|Storage requested, for example requests.storage: 1Gi.",
    selector: "LabelSelector|Labels of PersistentVolumes to bind to.",
    storageClassName: "string|StorageClass. Empty string means no class; unset means the default class.",
    volumeMode: "string|Filesystem (default) or Block.",
    volumeName: "string|Bind to this PersistentVolume.",
  },
  VolumeResourceRequirements: { limits: "map[string]Quantity|Maximum storage.", requests: "map[string]Quantity|Minimum storage, for example storage: 1Gi." },
  PersistentVolume: top("PersistentVolumeSpec", "PersistentVolumeStatus"),
  PersistentVolumeSpec: {
    accessModes: "[]string|Access modes the volume supports.",
    capacity: "map[string]Quantity|Size, for example storage: 5Gi.",
    claimRef: "ObjectReference|The claim bound to this volume.",
    hostPath: "HostPathVolumeSource|A directory on a node, for testing.",
    persistentVolumeReclaimPolicy: "string|Retain, Delete or Recycle.",
    storageClassName: "string|StorageClass this volume belongs to.",
  },
  Role: top("", "", { rules: "[]PolicyRule|Permissions granted in the Role's namespace." }),
  ClusterRole: top("", "", { aggregationRule: "AggregationRule|Build the rules from other ClusterRoles.", rules: "[]PolicyRule|Permissions granted." }),
  PolicyRule: {
    apiGroups: "[]string|API groups. \"\" is the core group.",
    nonResourceURLs: "[]string|URLs like /healthz, for ClusterRoles only.",
    resourceNames: "[]string|Restrict to objects with these names.",
    resources: "[]string|Resources, for example pods, deployments, pods/log.",
    verbs: "[]string!|Verbs: get, list, watch, create, update, patch, delete, or *.",
  },
  RoleBinding: top("", "", { roleRef: "RoleRef!|The Role or ClusterRole granted. Immutable.", subjects: "[]Subject|Users, groups and service accounts that get the role." }),
  ClusterRoleBinding: top("", "", { roleRef: "RoleRef!|The ClusterRole granted. Immutable.", subjects: "[]Subject|Who gets the role." }),
  RoleRef: { apiGroup: "string!|rbac.authorization.k8s.io", kind: "string!|Role or ClusterRole.", name: "string!|Name of the role." },
  Subject: { apiGroup: "string|rbac.authorization.k8s.io for users and groups.", kind: "string!|User, Group or ServiceAccount.", name: "string!|Name.", namespace: "string|Namespace of a ServiceAccount." },
  ResourceQuota: top("ResourceQuotaSpec", "ResourceQuotaStatus"),
  ResourceQuotaSpec: { hard: "map[string]Quantity|Limits per resource name, for example pods, requests.cpu, limits.memory.", scopeSelector: "ScopeSelector|Scopes the quota applies to.", scopes: "[]string|Terminating, NotTerminating, BestEffort, NotBestEffort..." },
  LimitRange: top("LimitRangeSpec"),
  LimitRangeSpec: { limits: "[]LimitRangeItem!|Limits by object type." },
  LimitRangeItem: {
    default: "map[string]Quantity|Default limits for containers that set none.",
    defaultRequest: "map[string]Quantity|Default requests for containers that set none.",
    max: "map[string]Quantity|Maximum per container or pod.",
    maxLimitRequestRatio: "map[string]Quantity|Maximum ratio of limit to request.",
    min: "map[string]Quantity|Minimum per container or pod.",
    type: "string!|Container, Pod or PersistentVolumeClaim.",
  },
  HorizontalPodAutoscaler: top("HorizontalPodAutoscalerSpec", "HorizontalPodAutoscalerStatus"),
  HorizontalPodAutoscalerSpec: {
    behavior: "HorizontalPodAutoscalerBehavior|Scale up and down policies and stabilization windows.",
    maxReplicas: "integer!|Upper limit of replicas.",
    metrics: "[]MetricSpec|Metrics used to compute the replica count.",
    minReplicas: "integer|Lower limit of replicas. Defaults to 1.",
    scaleTargetRef: "CrossVersionObjectReference!|The Deployment, StatefulSet or ReplicaSet to scale.",
  },
  MetricSpec: { resource: "ResourceMetricSource|A resource metric such as cpu or memory.", type: "string!|Resource, Pods, Object, External or ContainerResource." },
  ResourceMetricSource: { name: "string!|cpu or memory.", target: "MetricTarget!|Target value." },
  MetricTarget: { averageUtilization: "integer|Target average percentage of the request.", averageValue: "Quantity|Target average value.", type: "string!|Utilization, Value or AverageValue.", value: "Quantity|Target value." },
  CrossVersionObjectReference: { apiVersion: "string|API version of the target.", kind: "string!|Kind of the target.", name: "string!|Name of the target." },
  PodDisruptionBudget: top("PodDisruptionBudgetSpec", "PodDisruptionBudgetStatus"),
  PodDisruptionBudgetSpec: { maxUnavailable: "IntOrString|Pods that may be unavailable after an eviction.", minAvailable: "IntOrString|Pods that must stay available after an eviction.", selector: "LabelSelector|Pods covered by the budget." },
};

const KIND_DESC: Record<string, string> = {
  Pod: "Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.",
  Deployment: "Deployment enables declarative updates for Pods and ReplicaSets.",
  ReplicaSet: "ReplicaSet ensures that a specified number of pod replicas are running at any given time.",
  DaemonSet: "DaemonSet represents the configuration of a daemon set: one pod on every matching node.",
  StatefulSet: "StatefulSet represents a set of pods with consistent identities: stable names, DNS and storage.",
  Job: "Job represents the configuration of a single job: pods that run to completion.",
  CronJob: "CronJob represents the configuration of a single cron job: Jobs created on a schedule.",
  Service: "Service is a named abstraction of software service (for example, mysql) consisting of local port that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.",
  ConfigMap: "ConfigMap holds configuration data for pods to consume.",
  Secret: "Secret holds secret data of a certain type. The total bytes of the values in the Data field must be less than MaxSecretSize bytes.",
  ServiceAccount: "ServiceAccount binds together a name, understood by users and possibly by peripheral systems, for an identity, a principal that can be authenticated and authorized, and a set of secrets.",
  Namespace: "Namespace provides a scope for Names. Use of multiple namespaces is optional.",
  NetworkPolicy: "NetworkPolicy describes what network traffic is allowed for a set of Pods.",
  Ingress: "Ingress is a collection of rules that allow inbound connections to reach the endpoints defined by a backend.",
  PersistentVolumeClaim: "PersistentVolumeClaim is a user's request for and claim to a persistent volume.",
  PersistentVolume: "PersistentVolume (PV) is a storage resource provisioned by an administrator. It is analogous to a node.",
  Role: "Role is a namespaced, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding.",
  ClusterRole: "ClusterRole is a cluster level, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding or ClusterRoleBinding.",
  RoleBinding: "RoleBinding references a role, but does not contain it. It adds who information via Subjects and namespace information by which namespace it exists in.",
  ClusterRoleBinding: "ClusterRoleBinding references a ClusterRole, but not contain it. It can reference a ClusterRole in the global namespace, and adds who information via Subject.",
  ResourceQuota: "ResourceQuota sets aggregate quota restrictions enforced per namespace.",
  LimitRange: "LimitRange sets resource usage limits for each kind of resource in a Namespace.",
  HorizontalPodAutoscaler: "HorizontalPodAutoscaler is the configuration for a horizontal pod autoscaler, which automatically manages the replica count of any resource implementing the scale subresource based on the metrics specified.",
  PodDisruptionBudget: "PodDisruptionBudget is an object to define the max disruption that can be caused to a collection of pods.",
};

function parse(spec: string): { type: string; required: boolean; desc: string } {
  const i = spec.indexOf("|");
  const raw = i >= 0 ? spec.slice(0, i) : spec;
  return { type: raw.replace(/!$/, ""), required: raw.endsWith("!"), desc: i >= 0 ? spec.slice(i + 1) : "" };
}

const elem = (t: string) => t.replace(/^\[\]/, "").replace(/^map\[string\]/, "");
const shownType = (t: string) => (t === "integer" || t === "string" || t === "boolean" || t.startsWith("map[") ? t : t === "IntOrString" ? "IntOrString" : t === "Quantity" ? "Quantity" : t.startsWith("[]") ? `[]${elem(t)}` : t);

function wrap(text: string, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 76) {
      lines.push(indent + cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) lines.push(indent + cur.trim());
  return lines.join("\n");
}

function fieldLines(fields: Fields, recursive: boolean, depth: number, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const name of Object.keys(fields).sort()) {
    const f = parse(fields[name]);
    const pad = "  ".repeat(depth + 1);
    out.push(`${pad}${name}\t<${shownType(f.type)}>${f.required ? " -required-" : ""}`);
    if (recursive) {
      const sub = TYPES[elem(f.type)];
      if (sub && !seen.has(elem(f.type)) && depth < 8) out.push(...fieldLines(sub, true, depth + 1, new Set([...seen, elem(f.type)])));
    } else {
      if (f.desc) out.push(wrap(f.desc, pad + "  "));
      out.push("");
    }
  }
  return out;
}

export function cmdExplain(ctx: Ctx, f: Flags): number {
  const what = f.args[0];
  if (!what) throw new KubeError('error: You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
  const [resPart, ...path] = what.split(".");
  const info = kindOrThrow(resPart);
  const root = TYPES[info.kind];
  const version = f.str("api-version") ?? info.apiVersion;
  const group = version.includes("/") ? version.split("/")[0] : "";
  const header = [`GROUP:      ${group}`, `KIND:       ${info.kind}`, `VERSION:    ${version.includes("/") ? version.split("/")[1] : version}`, ""].filter((l) => group || !l.startsWith("GROUP"));
  if (!root) {
    out(ctx, [...header, "DESCRIPTION:", wrap(`(podsim) Field documentation for ${info.kind} is not included in the simulator. See https://kubernetes.io/docs/reference/kubernetes-api/`, "    "), ""].join("\n"));
    return 0;
  }
  let fields: Fields = root;
  let typeName = info.kind;
  let field: { name: string; type: string; desc: string } | undefined;
  for (const p of path) {
    const spec = fields[p];
    if (!spec) throw new KubeError(`error: field "${p}" does not exist`);
    const pf = parse(spec);
    field = { name: p, type: pf.type, desc: pf.desc };
    typeName = elem(pf.type);
    fields = TYPES[typeName] ?? {};
  }
  const lines = [...header];
  if (field) lines.push(`FIELD: ${field.name} <${shownType(field.type)}>`, "", "");
  lines.push("DESCRIPTION:");
  lines.push(wrap(field ? field.desc || `${field.name} is a ${shownType(field.type)}.` : KIND_DESC[info.kind] ?? `${info.kind} object.`, "    "));
  lines.push("    ");
  if (Object.keys(fields).length) {
    lines.push("FIELDS:");
    lines.push(...fieldLines(fields, f.bool("recursive"), 0, new Set([typeName])));
  }
  out(ctx, lines.join("\n").replace(/\n+$/, "\n").trimEnd());
  return 0;
}
