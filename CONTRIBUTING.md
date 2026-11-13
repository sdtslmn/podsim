# Contributing

Thanks for helping. The two most useful contributions are new labs and fixes where k8s-sim behaves differently from a real cluster.

## Setup

```bash
npm install
npm run build
npm test
```

## Adding a lab

1. Copy an existing lab in `labs/beginner/` and change it. The format is described in [docs/writing-labs.md](docs/writing-labs.md).
2. Run `npm run validate-labs` until it passes.
3. Try the lab yourself in the shell (`npm start -- lab <number>`) as if you had never seen it.
4. Open a pull request.

## Fixing a fidelity problem

1. Add a test in `packages/core/test/` that shows the expected real output.
2. Fix the engine or the kubectl layer.
3. In the pull request, say which Kubernetes version the real output came from.

## Code layout

- `packages/core/src/cluster.ts`: the in-memory API server (create, replace, validation, defaults)
- `packages/core/src/controllers/`: scheduler, kubelet, Deployment, ReplicaSet, Endpoints, garbage collector
- `packages/core/src/kubectl/`: argument parsing, commands, printers, describe, jsonpath
- `packages/core/src/shell.ts`: the small shell around kubectl
- `packages/core/src/labs/`: lab format and lab runner
- `packages/cli/`: terminal front end
- `packages/web/`: browser front end

The core package must not use Node APIs, so it keeps working in the browser.

## Style

- TypeScript, strict mode. Keep functions small and name things after the Kubernetes concept they model.
- Output strings should match real kubectl exactly, including spacing.
- Messages that are not real kubectl output start with `(k8s-sim)` so learners can tell the difference.
