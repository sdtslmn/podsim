# k8s-sim

A Kubernetes training simulator for new learners. Practice `kubectl` on a simulated cluster, in your terminal or in the browser, with guided labs that check your work automatically.

Nothing here runs real containers. The simulator models how Kubernetes objects behave: the scheduler places Pods on nodes, the kubelet pulls images and starts containers, Deployments roll out new ReplicaSets, Services collect endpoints. You see the same states, events and error messages a real cluster gives you, without installing anything or paying for a cluster.

**Try it in the browser:** https://sdtslmn.github.io/k8s-sim/

![The browser version running the Services lab](docs/images/web-lab.png)

## Why a simulator

Real practice clusters (Killercoda, KodeKloud, kind, minikube) are great once you know the basics. For a first contact they are often too much: you wait for VMs, things break in ways that have nothing to do with what you are learning, and you need an account or a powerful laptop.

k8s-sim starts instantly, works offline, resets in a second and behaves the same every time. Use it to build muscle memory and understand what happens behind each command, then move to a real cluster.

## Quick start

You need [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
git clone https://github.com/sdtslmn/k8s-sim.git
cd k8s-sim
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
npm start -- -c "kubectl get nodes -o wide"   # run one command and exit
```

### Browser version

```bash
npm run dev:web                # then open the URL Vite prints
```

The browser version runs entirely client side, so it can be hosted on GitHub Pages. The workflow in `.github/workflows/pages.yml` publishes it on every push to `main` once Pages is enabled for the repository (Settings, Pages, Source: GitHub Actions).

## Labs

| # | Lab | Topic | Level |
|---|-----|-------|-------|
| 01 | Run your first Pod | Pods | beginner |
| 02 | Write a Pod manifest | Pods | beginner |
| 03 | Work in a namespace | Namespaces | beginner |
| 04 | Create a Deployment | Deployments | beginner |
| 05 | Scale a Deployment | Deployments | beginner |
| 06 | Roll out a new version | Deployments | beginner |
| 07 | Roll back a broken release | Troubleshooting | beginner |
| 08 | Expose a Deployment with a Service | Services | beginner |
| 09 | Fix a Pod that cannot pull its image | Troubleshooting | beginner |
| 10 | Configure a Pod with a ConfigMap | Configuration | beginner |

Each lab is a YAML file in [`labs/`](labs). Writing a new one takes a few minutes, see [docs/writing-labs.md](docs/writing-labs.md).

## What is simulated

**Cluster**: one control plane node and two workers, kube-system Pods (etcd, API server, scheduler, controller manager, CoreDNS, kube-proxy), default ServiceAccounts and the default ClusterRoles.

**Controllers**: scheduler (taints and tolerations, nodeSelector, node affinity, CPU and memory requests, cordoned nodes), kubelet (image pulls, ErrImagePull and ImagePullBackOff, CrashLoopBackOff with back-off timing, CreateContainerConfigError, missing volumes), Deployment (RollingUpdate with maxSurge and maxUnavailable, Recreate, revisions, rollback, progress deadline), ReplicaSet, Endpoints, garbage collection, PersistentVolumeClaims with a `standard` storage class.

**kubectl**: `get` (wide, yaml, json, name, jsonpath, custom-columns, `--show-labels`, `-l`, `--field-selector`, `--sort-by`, `-A`), `describe`, `run`, `create` (deployment, namespace, configmap, secret, service, serviceaccount, role, rolebinding, clusterrole, clusterrolebinding), `apply`, `delete`, `replace --force`, `patch`, `label`, `annotate`, `scale`, `expose`, `set image|env|resources|serviceaccount`, `rollout status|history|undo|restart|pause|resume`, `logs`, `exec`, `cordon`, `uncordon`, `drain`, `taint`, `auth can-i`, `wait`, `config set-context --current --namespace`, `api-resources`, `version`, `cluster-info`.

**Inside containers**: `kubectl exec` and `kubectl run --rm -it ... -- CMD` support `env`, `printenv`, `cat` (including mounted ConfigMaps and Secrets), `ls`, `nslookup`, `wget` and `curl`. HTTP requests go through Services to the right Pods, so a wrong selector or targetPort fails the way it would on a real cluster.

**API server behaviour**: strict field validation (a typo like `imagee` is rejected), type checks (`version: 1.0` in labels is rejected), immutable fields (Pod spec, Deployment selector), name validation, the real error messages.

**Shell**: pipes into `grep`, `awk`, `cut`, `wc`, `head`, `tail`, `sort`, `base64 -d`, `xargs`; `>` and `>>` redirects; heredocs (`cat <<EOF > pod.yaml`); `export do="--dry-run=client -o yaml"` style variables; `alias`.

Not simulated yet: Jobs, CronJobs, DaemonSets, StatefulSets, NetworkPolicy enforcement, probes, HPA, `kubectl edit`, `--watch`, `explain`. See the [roadmap](docs/roadmap.md).

## How it works

```
packages/core   simulated cluster engine, kubectl emulation, shell, lab runner (no Node APIs, runs in the browser too)
packages/cli    terminal front end (readline, real files in ./k8s-sim-work)
packages/web    browser front end (xterm.js, in-memory files)
labs/           lab definitions in YAML
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
