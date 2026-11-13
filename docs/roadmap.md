# Roadmap

The plan, roughly in order. Open an issue if you want to work on something or think the order is wrong.

## v0.1 (this release)

- Simulated cluster engine with scheduler, kubelet, Deployment, ReplicaSet, Endpoints and garbage collection
- kubectl emulation for the everyday commands, with real output formats and error messages
- Shell with pipes, redirects, heredocs and variables
- Terminal and browser front ends
- 10 beginner labs, lab format, lab validator, CI and GitHub Pages deployment

## v0.2: more labs and core workloads

- Labs: Pending Pods (nodeSelector, taints), labels and selectors, Secrets, resource requests and limits, multi-container Pods, ConfigMaps as files, `kubectl explain`-free manifest writing
- Jobs and CronJobs
- Liveness and readiness probes, with Pods that fail them
- `--watch` for `get pods` and `get events`
- `kubectl explain` for the common resources

## v0.3: CKA and CKAD tracks

- DaemonSets and StatefulSets
- NetworkPolicy enforcement in the simulated network (wget and curl respect policies)
- Ingress with a simulated ingress controller
- Intermediate labs grouped by exam domain
- Exam mode: a timer, several tasks across namespaces, a score at the end

## v0.4: security track

- RBAC labs (Roles, ClusterRoles, ServiceAccounts, `auth can-i`)
- Pod Security Admission levels and securityContext
- Secrets handling and image hygiene
- Kubernetes at the industrial edge: segmented namespaces, NetworkPolicy zones and conduits, workload hardening

## Later

- Publish the CLI to npm so `npx k8s-sim` works without cloning
- Translations of the lab text
- Instructor view: a class code and a progress board for a group of learners
