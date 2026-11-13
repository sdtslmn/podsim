# Writing labs

A lab is one YAML file in `labs/<level>/`. The file name should start with the lab number, for example `labs/beginner/11-pending-pod.yaml`.

## A complete example

```yaml
id: 11-pending-pod
title: Fix a Pod stuck in Pending
level: beginner          # beginner | intermediate | advanced
minutes: 8               # rough time to finish
tracks: [ckad, cka]      # kcna | ckad | cka | cks (informational)
topic: Troubleshooting
intro: |
  A short explanation of the concept and the scenario. Plain text.
  Use `backticks` for commands and names, they are highlighted.

  Lines that start with two spaces are kept as they are (good for examples).
setup:                   # shell commands run before the learner starts (optional)
  - |
    cat <<EOF | kubectl apply -f -
    apiVersion: v1
    kind: Pod
    metadata:
      name: fast
    spec:
      nodeSelector:
        disktype: ssd
      containers:
      - name: app
        image: nginx:1.27
    EOF
files:                   # files placed in the learner's work folder (optional)
  notes.txt: |
    anything
settle: 20               # seconds of simulated time to let the setup settle (default 20)
tasks:
  - What the learner must do, one task per line.
checks:
  - name: Pod fast is Running
    kind: Pod
    resource: fast
    path: .status.phase
    equals: Running
hints:
  - A gentle nudge first.
  - Then a stronger one.
  - The last hint can be the command.
solution:
  - kubectl label node node01 disktype=ssd
learned: |
  Shown when every check passes. One or two sentences that sum up the idea
  and point to what to try next.
```

## Checks

Every check needs a `name`. That text is shown to the learner with a tick or a cross, so write it as a statement: "Pod web is Running", not "Check pod".

### Object exists or is gone

```yaml
- name: Namespace dev exists
  kind: Namespace
  resource: dev
  expect: exists

- name: The old Pod was removed
  kind: Pod
  resource: legacy
  expect: absent
```

`namespace` defaults to `default`. Cluster-scoped kinds (Node, Namespace, ClusterRole) ignore it.

### A field has a value

`path` uses the same syntax as `kubectl -o jsonpath`, without the braces.

```yaml
- name: The Service forwards to port 80
  kind: Service
  resource: web
  path: .spec.ports[0].targetPort
  equals: 80

- name: The image is nginx 1.27
  kind: Deployment
  resource: web
  path: .spec.template.spec.containers[0].image
  matches: "^nginx:1\\.27$"     # regular expression

- name: The Pod mounts the config
  kind: Pod
  resource: app
  path: .spec.volumes[*].configMap.name
  contains: app-config

- name: At least 3 replicas are ready
  kind: Deployment
  resource: web
  path: .status.readyReplicas
  gte: 3                        # lte works too
```

Annotation and label keys with dots or slashes go in brackets: `.metadata.annotations['deployment.kubernetes.io/revision']`.

### Counting objects

```yaml
- name: There are exactly 5 shop Pods
  kind: Pod
  count:
    selector: app=shop          # label selector, same syntax as kubectl -l
    phase: Running              # optional
    ready: true                 # optional
    equals: 5                   # or gte: 5
```

### Running a command

For things that are easier to test from the outside, run a shell command and match its output. Keep these read-only, or clean up after yourself (`--rm`).

```yaml
- name: A client Pod reaches the Service
  command: kubectl run lab-check --rm -it --image=busybox --restart=Never -- wget -qO- -T 2 http://web
  outputMatches: Welcome to nginx

- name: The app ServiceAccount can list Pods
  command: kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:app
  outputMatches: "^yes"
```

`exitCode: 0` checks the exit code instead of, or as well as, the output.

## Good labs

- **One idea per lab.** If you need two paragraphs to explain the goal, split it.
- **Start unsolved.** The validator fails a lab whose checks already pass before the learner does anything.
- **Check results, not keystrokes.** Do not force one command when several are fine. Check the object, not how it was made.
- **Name what the learner sees.** Checks and hints should use the names that appear in `kubectl get` output.
- **Hints go from vague to exact.** The last hint may give the command; the solution shows the full answer.
- **Original content only.** Map labs to public curriculum topics, never to real exam questions.

## Validate before you open a pull request

```bash
npm run validate-labs
```

This runs every lab's setup, confirms the checks fail at the start, runs the solution, and confirms every check passes. `npm test` runs the same thing as part of the test suite.
