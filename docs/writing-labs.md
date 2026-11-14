# Writing labs

A lab is one YAML file in `labs/<level>/` (`beginner`, `intermediate`, `advanced`, `scenarios`, or `ckad` for exam skills). The id starts with a level letter and a number, and the file has the same name: `labs/intermediate/i23-pending-pod.yaml`. The letter and number are the code learners type (`lab i23`).

| Folder | Letter | Level value |
|---|---|---|
| `beginner/` | b | `beginner` |
| `intermediate/` | i | `intermediate` |
| `advanced/` | a | `advanced` |
| `scenarios/` | s | `scenario` |
| `ckad/` (exam skills) | c | `advanced` |

Then add the id to [`labs/curriculum.yaml`](../labs/curriculum.yaml): under a module of its level in the learning path, and under the matching domain of a certification track if it fits one. `npm run validate-labs` fails if a lab is missing from the curriculum or the curriculum names a lab that does not exist.

Real-life scenarios are longer labs that combine several topics and usually start from a broken or incomplete setup. Write the intro as the situation someone would face at work, and give each part of the job its own task and its own checks, so learners can use `check` as a progress bar.

## A complete example

```yaml
id: i23-pending-pod
title: Fix a Pod stuck in Pending
level: intermediate      # beginner | intermediate | advanced | scenario
minutes: 8               # rough time to finish
tracks: [ckad, cka]      # kcna | ckad | cka | cks (informational)
topic: Scheduling        # shown when the lab is not in the curriculum
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

## Mock exams

A mock exam is one YAML file in `exams/`. It is a list of tasks, each a small lab without hints: the learner works through them under a timer and everything is scored at the end.

```yaml
id: ckad-mock-2
title: CKAD mock exam 2
track: ckad
minutes: 120
passPercent: 66
intro: |
  Shown before the exam starts.
tasks:
  - host: ckad00031          # unique per task; the learner connects with ssh ckad00031
    weight: 6                # percent of the total score; weights should add up to 100
    domain: Services and Networking
    title: Short title for the task list
    text: |
      The task as the learner reads it. Name every object, namespace and value
      the checks look for.
    setup: []                # same as labs
    files: {}                # same as labs, placed in the home folder of that host
    checks: []               # same as labs; each passed check earns weight / number of checks
    solution: []             # shown with the results, and run by the validator
```

Every task runs on its own simulated cluster, so tasks cannot interfere with each other. `npm run validate-labs` checks exam tasks the same way as labs: unsolved after setup, solved by the solution.
