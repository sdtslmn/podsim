# PodSim

A Kubernetes training simulator. Practice `kubectl` on a simulated cluster, in your terminal or in the browser, with guided labs that check your work automatically, a CKAD lab track for every exam domain, and a timed mock exam in the style of the real one.

Nothing here runs real containers. The simulator models how Kubernetes objects behave: the scheduler places Pods on nodes, the kubelet pulls images and starts containers, Deployments roll out new ReplicaSets, Services collect endpoints. You see the same states, events and error messages a real cluster gives you, without installing anything or paying for a cluster.

**Try it in the browser:** https://sdtslmn.github.io/podsim/

![The browser version running the Services lab](docs/images/web-lab.png)

## Why a simulator

Real practice clusters (Killercoda, KodeKloud, kind, minikube) are great once you know the basics. For a first contact they are often too much: you wait for VMs, things break in ways that have nothing to do with what you are learning, and you need an account or a powerful laptop.

PodSim starts instantly, works offline, resets in a second and behaves the same every time. Use it to build muscle memory and understand what happens behind each command, then move to a real cluster.

## Quick start

You need [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
git clone https://github.com/sdtslmn/podsim.git
cd podsim
npm install
npm run sim            # builds and opens the practice shell
```

Inside the shell:

```
controlplane:~$ labs           # list the labs
controlplane:~$ lab 1          # start the first lab
controlplane:~$ kubectl run web --image=nginx
controlplane:~$ check          # check your work
controlplane:~$ hint           # stuck? get a hint
```

Other ways to start it:

```bash
npm start                      # open the shell (after npm run build)
npm start -- lab 3             # jump straight to lab 3
npm start -- lab ckad-12       # a CKAD lab
npm start -- exam              # the timed CKAD mock exam
npm start -- -c "kubectl get nodes -o wide"   # run one command and exit
```

### Browser version

```bash
npm run dev:web                # then open the URL Vite prints
```

The browser version runs entirely client side, so it can be hosted on GitHub Pages. The workflow in `.github/workflows/pages.yml` publishes it on every push to `main` once Pages is enabled for the repository (Settings, Pages, Source: GitHub Actions).

## Teaching with the sandbox

The sandbox is a fresh simulated cluster with no lab attached. Type a command and the class sees what a real cluster would do: Pods move from ContainerCreating to Running, a typo in an image name ends in ImagePullBackOff, a rolling update keeps the old Pods serving until the new ones are ready. Nothing is created anywhere outside the simulator, and `reset` brings back a clean cluster in a second, so you can repeat a demo as often as you like.

In the browser, open the page, click Sandbox and put it on the projector. Learners can follow along on their own laptops with no setup.

## Labs

**Beginner** (first contact with Kubernetes):

| # | Lab | Topic |
|---|-----|-------|
| 01 | Run your first Pod | Pods |
| 02 | Write a Pod manifest | Pods |
| 03 | Work in a namespace | Namespaces |
| 04 | Create a Deployment | Deployments |
| 05 | Scale a Deployment | Deployments |
| 06 | Roll out a new version | Deployments |
| 07 | Roll back a broken release | Troubleshooting |
| 08 | Expose a Deployment with a Service | Services |
| 09 | Fix a Pod that cannot pull its image | Troubleshooting |
| 10 | Configure a Pod with a ConfigMap | Configuration |

**CKAD track**, grouped by the five domains of the CKAD curriculum:

| Domain (weight) | Labs |
|---|---|
| Application Design and Build (20%) | ckad-01 build, push and run an image · 02 CronJob · 03 parallel Job · 04 init container · 05 native sidecar · 06 PersistentVolumeClaim |
| Application Deployment (20%) | ckad-07 rolling update strategy · 08 canary · 09 blue/green · 10 Helm install and upgrade · 11 Kustomize overlay |
| Application Observability and Maintenance (15%) | ckad-12 readiness and liveness probes · 13 probe restart loop · 14 removed API versions · 15 debug a crash with logs · 16 `kubectl top` |
| Application Environment, Configuration and Security (25%) | ckad-17 ConfigMaps and Secrets · 18 securityContext · 19 ServiceAccount and RBAC · 20 ResourceQuota · 21 custom resources |
| Services and Networking (20%) | ckad-22 NetworkPolicy · 23 fix a Service and add a NodePort · 24 Ingress |

Each lab is a YAML file in [`labs/`](labs). Writing a new one takes a few minutes, see [docs/writing-labs.md](docs/writing-labs.md).

## Mock exam

`ckad-mock-1` has 16 weighted tasks across all five domains, a 120 minute timer and a 66% pass mark, like the real exam. You start on a base node and connect to each task's host with `ssh`, where a separate simulated cluster waits for you. At the end every task is scored automatically, with partial credit per check, and you get the breakdown and a reference solution for each task.

In the browser click **Mock exam**; in the terminal run `npm start -- exam`. The questions are original practice material mapped to the public curriculum, not exam questions.

## CKAD coverage

How the [CKAD curriculum](https://github.com/cncf/curriculum) competencies map to the simulator:

| Competency | In PodSim |
|---|---|
| Define, build and modify container images | `docker` and `podman` build from a Dockerfile, `images`, `tag`, `save`, `load`, `push`; Pods pull pushed images with their CMD, ENTRYPOINT, ENV and WORKDIR |
| Choose and use the right workload resource | Deployments, ReplicaSets, DaemonSets, StatefulSets, Jobs (completions, parallelism, backoff, Indexed, TTL), CronJobs (schedules, concurrency, history) |
| Multi-container Pod design patterns | init containers, native sidecars, shared volumes, shared network and `localhost` |
| Persistent and ephemeral volumes | emptyDir, hostPath, ConfigMap, Secret, projected and downwardAPI volumes; PVCs bound by the `standard` StorageClass; StatefulSet volumeClaimTemplates |
| Deployment strategies (blue/green, canary) | Services route by label to every ready Pod, so selector switches and replica splits behave like on a real cluster |
| Rolling updates | maxSurge, maxUnavailable, Recreate, revisions, `rollout history/undo/pause/resume/restart` |
| Helm | `helm repo`, `search`, `show`, `pull`, `create`, `lint`, `template`, `install`, `upgrade`, `rollback`, `history`, `get`, `uninstall`, with Bitnami nginx, apache and redis charts |
| Kustomize | `kubectl kustomize`, `apply -k`, `delete -k`: bases, overlays, generators with hash suffixes, prefixes, labels, images, replicas, patches |
| API deprecations | removed versions fail with the real "no matches for kind" error; `kubectl api-resources`, `kubectl explain` |
| Probes and health checks | liveness, readiness and startup probes (httpGet, tcpSocket, exec, grpc) with real events and restarts |
| Built-in CLI monitoring | `kubectl top pod/node` from a simulated metrics-server, `kubectl events`, `describe`, HorizontalPodAutoscalers |
| Container logs | `logs`, `-c`, `--previous`, `-f`, `--tail`, `--since`, `-l`, logs of Jobs and Deployments |
| Debugging | `describe`, events, `exec -it`, `kubectl debug` (ephemeral containers, `--copy-to`, `node/NAME`), port-forward |
| Resources that extend Kubernetes | CustomResourceDefinitions with schema validation, printer columns and short names |
| Authentication, authorization, admission | RBAC (Roles, ClusterRoles, bindings, `--as`, `auth can-i`, `auth can-i --list`), ServiceAccount tokens, Pod Security Admission, quota and LimitRange admission |
| Requests, limits, quotas | scheduling by requests, OOMKilled on memory limits, ResourceQuota, LimitRange defaults |
| ConfigMaps and Secrets | environment variables, `envFrom`, files, `subPath`, immutable objects, generic, TLS and docker-registry Secrets |
| ServiceAccounts | per-namespace accounts, `automountServiceAccountToken`, calling the API server from a Pod with the token |
| Application security | securityContext (users, groups, fsGroup, capabilities, read-only root, privilege escalation) enforced inside the container |
| NetworkPolicies | ingress and egress rules, pod, namespace and IP block peers, ports, DNS; enforced for `wget`, `curl` and `nc` |
| Services | ClusterIP, NodePort, headless, ExternalName, named target ports, endpoints, DNS names |
| Ingress | ingress-nginx controller on NodePort 30080/30443, host and path rules, path types, default backends, IngressClass |

The simulated cluster reports Kubernetes v1.35, the version the CKAD exam environment used in 2026. The exam moves to newer releases a few weeks after each one, so check the official exam FAQ before you book.

## What is simulated

**Cluster**: one control plane node and two workers, kube-system Pods (etcd, API server, scheduler, controller manager, CoreDNS, kube-proxy, metrics-server), the ingress-nginx controller, a default `standard` StorageClass, default ServiceAccounts and ClusterRoles.

**Controllers**: scheduler (taints and tolerations, nodeSelector, node affinity, requests, cordoned nodes), kubelet (image pulls, init containers, sidecars, probes, restarts with back-off, OOMKilled, ephemeral containers), Deployment, ReplicaSet, DaemonSet, StatefulSet, Job, CronJob, HorizontalPodAutoscaler, Endpoints, PersistentVolume binding and provisioning, ResourceQuota, Ingress status, garbage collection.

**Containers run a shell**: every container runs its command in a small shell interpreter on the simulated clock, with a filesystem built from its image and volumes. `kubectl exec` and `kubectl run --rm -it` give you a prompt inside the container with `ls`, `cat`, `env`, `ps`, `wget`, `curl`, `nc`, `nslookup` and friends. HTTP and TCP traffic goes through Services, DNS and NetworkPolicies to processes that really listen.

**kubectl**: `get` (all output formats, `-l`, `--field-selector`, `--sort-by`, `-A`), `describe`, `explain`, `run`, `create` (all common generators), `apply`/`create`/`delete` with `-f` and `-k`, `kustomize`, `replace --force`, `patch` (strategic, merge, JSON, `--patch-file`), `label`, `annotate`, `scale`, `autoscale`, `expose`, `set`, `rollout`, `logs`, `exec`, `debug`, `port-forward`, `top`, `events`, `cordon`, `drain`, `taint`, `auth can-i`, `wait`, `config`, `api-resources`.

**On the host**: `helm`, `docker`, `podman`, `curl` and `wget` against NodePorts, and a shell with pipes, redirects, heredocs, variables, aliases, `grep`, `sed`, `awk`, `cut`, `sort`, `find`, `base64` and more.

**API server behaviour**: strict field validation, type checks, immutable fields, admission (quota, LimitRange, Pod Security), RBAC, removed API versions, and the real error messages.

Not simulated yet: `--watch`, an editor inside the terminal for `kubectl edit` (use the Files panel or your own editor), Gateway API, several clusters in one kubeconfig. See the [roadmap](docs/roadmap.md).

## How it works

```
packages/core   simulated cluster engine, kubectl emulation, shell, lab runner (no Node APIs, runs in the browser too)
packages/cli    terminal front end (readline, real files in ./podsim-work)
packages/web    browser front end (xterm.js, in-memory files)
labs/           lab definitions in YAML
exams/          mock exam definitions in YAML
```

The engine keeps every object in an in-memory store shaped like the real API, so `kubectl get -o yaml` looks real. Controllers run on a virtual clock that advances with wall time between commands, in one-second steps, so state changes happen in the right order. Labs and tests can jump the clock forward to skip waiting.

## Development

```bash
npm install
npm run build          # compile core and cli
npm test               # unit tests, kubectl behaviour tests, every lab solved by its solution
npm run validate-labs  # the same lab check through the CLI
npm run dev:web        # browser version with hot reload
```

When the simulator prints something that differs from a real cluster, please open an issue with both outputs. Fidelity is the main goal.

## Contributing

Contributions are welcome, especially new labs and fixes where the output differs from real Kubernetes. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Kubernetes is a registered trademark of The Linux Foundation. This project is not affiliated with or endorsed by The Linux Foundation or the Cloud Native Computing Foundation. The labs are original exercises mapped to public curriculum topics; they do not contain exam questions.
