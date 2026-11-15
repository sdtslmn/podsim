# Roadmap

The plan, roughly in order. Open an issue if you want to work on something or think the order is wrong.

## v0.1

- Simulated cluster engine with scheduler, kubelet, Deployment, ReplicaSet, Endpoints and garbage collection
- kubectl emulation for the everyday commands, with real output formats and error messages
- Shell with pipes, redirects, heredocs and variables
- Terminal and browser front ends
- 10 beginner labs, lab format, lab validator, CI and GitHub Pages deployment

## v0.2: ready for the CKAD (this release)

- Containers run their commands in a shell interpreter, with image and volume filesystems, users and capabilities
- Jobs, CronJobs, DaemonSets, StatefulSets, HorizontalPodAutoscalers and a simulated metrics-server
- Init containers, native sidecars, liveness, readiness and startup probes, OOMKilled
- ResourceQuota, LimitRange, securityContext, Pod Security Admission, ServiceAccount tokens, RBAC with `--as`
- PersistentVolumes, StorageClasses and dynamic provisioning
- NetworkPolicy enforcement, ingress-nginx, NodePorts from the host, port-forward
- CRDs, Helm, Kustomize, docker and podman image builds, removed API versions
- `kubectl explain`, `debug`, `events`, `top`, `autoscale`, `auth can-i --list`
- A live Visualizer: nodes and Pods, Services, Ingress and NetworkPolicies, with animated traffic
- A training path of 57 labs from zero to production (beginner, intermediate, advanced, real-life scenarios), plus a CKAD track that maps them to the five exam domains, exam-skill drills and two timed mock exams with ssh hosts and automatic scoring

## v0.3: CKA track

- Several clusters and contexts in one kubeconfig
- Node troubleshooting: kubelet and container runtime failures, `systemctl`, `journalctl`, `crictl`
- Control plane: static Pods, etcd backup and restore, kubeadm upgrades
- Gateway API
- `--watch` for `get` and `events`
- A CKA lab track and mock exam

## v0.4: security track

- CKS topics: audit logs, AppArmor and seccomp profiles, image scanning, runtime security
- Secrets encryption at rest, admission webhooks
- Kubernetes at the industrial edge: segmented namespaces, NetworkPolicy zones and conduits, workload hardening

## Later

- More real-life scenarios, more mock exams, and a KCNA and KCSA question bank
- Publish the CLI to npm so `npx podsim` works without cloning
- Translations of the lab text
- Instructor view: a class code and a progress board for a group of learners
