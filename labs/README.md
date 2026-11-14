# Labs

The labs form one training path, from zero to production:

- `beginner/` (B01 to B16): first contact with clusters, Pods, Deployments, Services and configuration
- `intermediate/` (I01 to I22): workloads, multi-container Pods, storage, health and resources, security, networking, scheduling, Helm and Kustomize
- `advanced/` (A01 to A12): release strategies, building and extending, debugging and autoscaling, hardening
- `scenarios/` (S01 to S07): real-life situations that combine many topics
- `ckad/` (C01, C02): exam workflow and speed drills for the CKAD track

[`curriculum.yaml`](curriculum.yaml) puts the labs in order (levels and modules) and maps them to certification tracks such as the CKAD domains. Mock exams live in [`../exams/`](../exams).

See [../docs/writing-labs.md](../docs/writing-labs.md) for both formats, and run `npm run validate-labs` after any change.
