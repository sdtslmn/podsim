// Charts in the simulated chart repositories, plus the `helm create`
// scaffold. Templates use the same Go template syntax as real charts and are
// rendered by template.ts.

export interface ChartFiles {
  /** Path inside the chart directory -> content. */
  [path: string]: string;
}

export interface RepoChart {
  name: string;
  version: string;
  appVersion: string;
  description: string;
  files: ChartFiles;
}

export interface Repo {
  url: string;
  charts: RepoChart[];
}

const chartYaml = (name: string, version: string, appVersion: string, description: string) =>
  `apiVersion: v2\nname: ${name}\ndescription: ${description}\ntype: application\nversion: ${version}\nappVersion: "${appVersion}"\n`;

function bitnamiWeb(name: string, version: string, appVersion: string, description: string, image: string, tag: string, title: string): RepoChart {
  const values = `## @param replicaCount Number of ${title} replicas to deploy
replicaCount: 1

image:
  registry: docker.io
  repository: ${image}
  tag: ${tag}
  pullPolicy: IfNotPresent

## @param containerPorts.http Sets http port inside ${title} container
containerPorts:
  http: 8080

## @param podLabels Extra labels for ${title} pods
podLabels: {}

## @param resources Set container requests and limits
resources: {}

service:
  ## @param service.type Service type
  type: LoadBalancer
  ports:
    http: 80
  ## @param service.nodePorts.http Node port for HTTP
  nodePorts:
    http: ""
`;
  const helpers = `{{- define "${name}.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "${name}.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "${name}.selectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/name: {{ .Chart.Name }}
{{- end -}}
`;
  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "${name}.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "${name}.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "${name}.labels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      containers:
        - name: ${name}
          image: {{ printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag }}
          imagePullPolicy: {{ .Values.image.pullPolicy | quote }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPorts.http }}
          {{- if .Values.resources }}
          resources: {{- toYaml .Values.resources | nindent 12 }}
          {{- end }}
`;
  const svc = `apiVersion: v1
kind: Service
metadata:
  name: {{ include "${name}.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - name: http
      port: {{ .Values.service.ports.http }}
      targetPort: http
      {{- if and (or (eq .Values.service.type "NodePort") (eq .Values.service.type "LoadBalancer")) .Values.service.nodePorts.http }}
      nodePort: {{ .Values.service.nodePorts.http }}
      {{- end }}
  selector:
    {{- include "${name}.selectorLabels" . | nindent 4 }}
`;
  const notes = `CHART NAME: {{ .Chart.Name }}
CHART VERSION: {{ .Chart.Version }}
APP VERSION: {{ .Chart.AppVersion }}

** Please be patient while the chart is being deployed **
${title} can be accessed through the following DNS name from within your cluster:

    {{ include "${name}.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local (port {{ .Values.service.ports.http }})

To access ${title} from outside the cluster, follow the steps below:

{{- if eq .Values.service.type "LoadBalancer" }}

1. Get the ${title} URL by running these commands:

  NOTE: It may take a few minutes for the LoadBalancer IP to be available.
        Watch the status with: 'kubectl get svc --namespace {{ .Release.Namespace }} -w {{ include "${name}.fullname" . }}'
{{- else if eq .Values.service.type "NodePort" }}

1. Get the ${title} URL by running these commands:

    export NODE_PORT=$(kubectl get --namespace {{ .Release.Namespace }} -o jsonpath="{.spec.ports[0].nodePort}" services {{ include "${name}.fullname" . }})
    export NODE_IP=$(kubectl get nodes --namespace {{ .Release.Namespace }} -o jsonpath="{.items[0].status.addresses[0].address}")
    echo "http://\${NODE_IP}:\${NODE_PORT}"
{{- else }}

1. Get the ${title} URL by running:

    kubectl port-forward --namespace {{ .Release.Namespace }} svc/{{ include "${name}.fullname" . }} 8080:{{ .Values.service.ports.http }}
    echo "http://127.0.0.1:8080"
{{- end }}
`;
  return {
    name,
    version,
    appVersion,
    description,
    files: {
      "Chart.yaml": chartYaml(name, version, appVersion, description),
      "values.yaml": values,
      "templates/_helpers.tpl": helpers,
      "templates/deployment.yaml": deployment,
      "templates/svc.yaml": svc,
      "templates/NOTES.txt": notes,
    },
  };
}

function bitnamiRedis(): RepoChart {
  const name = "redis";
  const values = `architecture: standalone

auth:
  ## @param auth.enabled Enable password authentication
  enabled: true
  ## @param auth.password Redis password (a random one is generated when empty)
  password: ""

image:
  registry: docker.io
  repository: bitnami/redis
  tag: 8.2.2-debian-12-r0

master:
  count: 1
  resources: {}
  persistence:
    enabled: true
    size: 8Gi
`;
  const helpers = `{{- define "redis.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
`;
  const secret = `{{- if .Values.auth.enabled }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "redis.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    app.kubernetes.io/name: redis
type: Opaque
data:
  redis-password: {{ .Values.auth.password | default (randAlphaNum 10) | b64enc | quote }}
{{- end }}
`;
  const sts = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "redis.fullname" . }}-master
  namespace: {{ .Release.Namespace | quote }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    app.kubernetes.io/name: redis
    app.kubernetes.io/component: master
spec:
  replicas: {{ .Values.master.count }}
  serviceName: {{ include "redis.fullname" . }}-headless
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
      app.kubernetes.io/name: redis
      app.kubernetes.io/component: master
  template:
    metadata:
      labels:
        app.kubernetes.io/instance: {{ .Release.Name }}
        app.kubernetes.io/managed-by: {{ .Release.Service }}
        app.kubernetes.io/name: redis
        app.kubernetes.io/component: master
    spec:
      containers:
        - name: redis
          image: {{ printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag }}
          env:
            {{- if .Values.auth.enabled }}
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "redis.fullname" . }}
                  key: redis-password
            {{- else }}
            - name: ALLOW_EMPTY_PASSWORD
              value: "yes"
            {{- end }}
          ports:
            - name: redis
              containerPort: 6379
          {{- if .Values.master.resources }}
          resources: {{- toYaml .Values.master.resources | nindent 12 }}
          {{- end }}
          {{- if .Values.master.persistence.enabled }}
          volumeMounts:
            - name: redis-data
              mountPath: /data
          {{- end }}
  {{- if .Values.master.persistence.enabled }}
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.master.persistence.size | quote }}
  {{- end }}
`;
  const svc = `apiVersion: v1
kind: Service
metadata:
  name: {{ include "redis.fullname" . }}-master
  namespace: {{ .Release.Namespace | quote }}
  labels:
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    app.kubernetes.io/name: redis
spec:
  type: ClusterIP
  ports:
    - name: tcp-redis
      port: 6379
      targetPort: redis
  selector:
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/name: redis
    app.kubernetes.io/component: master
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "redis.fullname" . }}-headless
  namespace: {{ .Release.Namespace | quote }}
spec:
  type: ClusterIP
  clusterIP: None
  ports:
    - name: tcp-redis
      port: 6379
      targetPort: redis
  selector:
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/name: redis
`;
  const notes = `CHART NAME: {{ .Chart.Name }}
CHART VERSION: {{ .Chart.Version }}
APP VERSION: {{ .Chart.AppVersion }}

** Please be patient while the chart is being deployed **

Redis can be accessed via port 6379 on the following DNS name from within your cluster:

    {{ include "redis.fullname" . }}-master.{{ .Release.Namespace }}.svc.cluster.local
{{- if .Values.auth.enabled }}

To get your password run:

    export REDIS_PASSWORD=$(kubectl get secret --namespace {{ .Release.Namespace }} {{ include "redis.fullname" . }} -o jsonpath="{.data.redis-password}" | base64 -d)
{{- end }}
`;
  return {
    name,
    version: "23.1.3",
    appVersion: "8.2.2",
    description: "Redis(R) is an open source, advanced key-value store.",
    files: {
      "Chart.yaml": chartYaml(name, "23.1.3", "8.2.2", "Redis(R) is an open source, advanced key-value store."),
      "values.yaml": values,
      "templates/_helpers.tpl": helpers,
      "templates/secret.yaml": secret,
      "templates/master-statefulset.yaml": sts,
      "templates/services.yaml": svc,
      "templates/NOTES.txt": notes,
    },
  };
}

export const REPOS: Record<string, Repo> = {
  "https://charts.bitnami.com/bitnami": {
    url: "https://charts.bitnami.com/bitnami",
    charts: [
      bitnamiWeb("nginx", "22.1.1", "1.29.3", "NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache.", "bitnami/nginx", "1.29.3-debian-12-r0", "NGINX"),
      bitnamiWeb("apache", "11.4.29", "2.4.65", "Apache HTTP Server is an open-source HTTP server.", "bitnami/apache", "2.4.65-debian-12-r0", "Apache"),
      bitnamiRedis(),
    ],
  },
};
REPOS["oci://registry-1.docker.io/bitnamicharts"] = REPOS["https://charts.bitnami.com/bitnami"];

/** The chart `helm create NAME` writes (same structure as the real scaffold). */
export function scaffold(name: string): ChartFiles {
  return {
    "Chart.yaml": `apiVersion: v2
name: ${name}
description: A Helm chart for Kubernetes

# A chart can be either an 'application' or a 'library' chart.
type: application

# This is the chart version. This version number should be incremented each time you make changes
# to the chart and its templates, including the app version.
version: 0.1.0

# This is the version number of the application being deployed.
appVersion: "1.16.0"
`,
    "values.yaml": `# Default values for ${name}.
# This is a YAML-formatted file.

replicaCount: 1

image:
  repository: nginx
  pullPolicy: IfNotPresent
  # Overrides the image tag whose default is the chart appVersion.
  tag: ""

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  automount: true
  annotations: {}
  name: ""

podAnnotations: {}
podLabels: {}

podSecurityContext: {}
securityContext: {}

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: false
  className: ""
  annotations: {}
  hosts:
    - host: chart-example.local
      paths:
        - path: /
          pathType: ImplementationSpecific
  tls: []

resources: {}

livenessProbe:
  httpGet:
    path: /
    port: http
readinessProbe:
  httpGet:
    path: /
    port: http

autoscaling:
  enabled: false
  minReplicas: 1
  maxReplicas: 100
  targetCPUUtilizationPercentage: 80

volumes: []
volumeMounts: []

nodeSelector: {}
tolerations: []
affinity: {}
`,
    ".helmignore": "# Patterns to ignore when building packages.\n.DS_Store\n.git/\n*.swp\n*.tmp\n",
    "templates/_helpers.tpl": `{{/*
Expand the name of the chart.
*/}}
{{- define "${name}.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "${name}.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "${name}.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "${name}.labels" -}}
helm.sh/chart: {{ include "${name}.chart" . }}
{{ include "${name}.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "${name}.selectorLabels" -}}
app.kubernetes.io/name: {{ include "${name}.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "${name}.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "${name}.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
`,
    "templates/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "${name}.fullname" . }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "${name}.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "${name}.labels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "${name}.serviceAccountName" . }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          {{- with .Values.livenessProbe }}
          livenessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.readinessProbe }}
          readinessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
`,
    "templates/service.yaml": `apiVersion: v1
kind: Service
metadata:
  name: {{ include "${name}.fullname" . }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "${name}.selectorLabels" . | nindent 4 }}
`,
    "templates/serviceaccount.yaml": `{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "${name}.serviceAccountName" . }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
automountServiceAccountToken: {{ .Values.serviceAccount.automount }}
{{- end }}
`,
    "templates/ingress.yaml": `{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "${name}.fullname" . }}
  labels:
    {{- include "${name}.labels" . | nindent 4 }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType }}
            backend:
              service:
                name: {{ include "${name}.fullname" $ }}
                port:
                  number: {{ $.Values.service.port }}
          {{- end }}
    {{- end }}
{{- end }}
`,
    "templates/NOTES.txt": `1. Get the application URL by running these commands:
{{- if contains "NodePort" .Values.service.type }}
  export NODE_PORT=$(kubectl get --namespace {{ .Release.Namespace }} -o jsonpath="{.spec.ports[0].nodePort}" services {{ include "${name}.fullname" . }})
  export NODE_IP=$(kubectl get nodes --namespace {{ .Release.Namespace }} -o jsonpath="{.items[0].status.addresses[0].address}")
  echo http://$NODE_IP:$NODE_PORT
{{- else if contains "ClusterIP" .Values.service.type }}
  kubectl --namespace {{ .Release.Namespace }} port-forward svc/{{ include "${name}.fullname" . }} 8080:{{ .Values.service.port }}
  echo "Visit http://127.0.0.1:8080 to use your application"
{{- end }}
`,
  };
}
