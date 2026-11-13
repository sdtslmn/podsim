import { describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster.js";

function fakeClock(start = Date.parse("2026-11-14T10:00:00Z")) {
  let now = start;
  return {
    clock: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("cluster bootstrap", () => {
  it("starts with three ready nodes and running system pods", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 1 });
    expect(c.list("Node").map((n) => n.metadata.name)).toEqual(["controlplane", "node01", "node02"]);
    const sys = c.list("Pod", "kube-system");
    expect(sys.length).toBeGreaterThanOrEqual(9);
    for (const p of sys) expect(p.status.phase).toBe("Running");
    expect(c.get("ServiceAccount", "default", "default")).toBeTruthy();
  });
});

describe("pod lifecycle", () => {
  it("runs a valid image and fails a typo", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 2 });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "web" }, spec: { containers: [{ name: "web", image: "nginx" }] } });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "typo" }, spec: { containers: [{ name: "typo", image: "ngnix" }] } });
    c.advance();
    expect(c.get("Pod", "web")!.status.containerStatuses[0].state.waiting.reason).toBe("ContainerCreating");
    fc.tick(10000);
    c.advance();
    const web = c.get("Pod", "web")!;
    expect(web.status.phase).toBe("Running");
    expect(web.spec.nodeName).toMatch(/node0[12]/);
    expect(web.status.podIP).toMatch(/^10\.244\./);
    const typo = c.get("Pod", "typo")!;
    expect(typo.status.phase).toBe("Pending");
    expect(typo.status.containerStatuses[0].state.waiting.reason).toBe("ImagePullBackOff");
  });

  it("crash loops a container that exits", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 3 });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "db" }, spec: { containers: [{ name: "db", image: "postgres:17" }] } });
    fc.tick(60000);
    c.advance();
    const db = c.get("Pod", "db")!;
    expect(db.status.containerStatuses[0].restartCount).toBeGreaterThanOrEqual(2);
    expect(db.status.containerStatuses[0].state.waiting?.reason ?? "Running").toMatch(/CrashLoopBackOff|Running/);
  });

  it("keeps a pod Pending when no node matches its nodeSelector", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 4 });
    c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "ssd" }, spec: { nodeSelector: { disktype: "ssd" }, containers: [{ name: "a", image: "nginx" }] } });
    fc.tick(5000);
    c.advance();
    const pod = c.get("Pod", "ssd")!;
    expect(pod.spec.nodeName).toBeUndefined();
    const cond = pod.status.conditions.find((x: { type: string }) => x.type === "PodScheduled");
    expect(cond.message).toContain("didn't match Pod's node affinity/selector");
    expect(cond.message).toContain("untolerated taint {node-role.kubernetes.io/control-plane: }");
    const node = c.get("Node", "node01")!;
    node.metadata.labels!.disktype = "ssd";
    c.replace(node);
    fc.tick(5000);
    c.advance();
    expect(c.get("Pod", "ssd")!.spec.nodeName).toBe("node01");
  });
});

describe("deployments", () => {
  it("creates a replicaset and pods, then rolls out a new image", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 5 });
    const tpl = { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "nginx", image: "nginx:1.25" }] } };
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: 3, selector: { matchLabels: { app: "web" } }, template: tpl } });
    fc.tick(10000);
    c.advance();
    let d = c.get("Deployment", "web")!;
    expect(d.status.readyReplicas).toBe(3);
    expect(c.list("ReplicaSet", "default")).toHaveLength(1);

    d = structuredClone(d);
    d.spec.template.spec.containers[0].image = "nginx:1.27";
    c.replace(d);
    fc.tick(30000);
    c.advance();
    d = c.get("Deployment", "web")!;
    expect(d.status.updatedReplicas).toBe(3);
    expect(d.status.readyReplicas).toBe(3);
    expect(d.metadata.annotations!["deployment.kubernetes.io/revision"]).toBe("2");
    const rss = c.list("ReplicaSet", "default");
    expect(rss).toHaveLength(2);
    expect(rss.map((r) => r.spec.replicas).sort()).toEqual([0, 3]);
  });

  it("stalls a rollout with a bad image and keeps old pods serving", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 6 });
    const tpl = { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: "nginx:1.25" }] } };
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api" }, spec: { replicas: 3, selector: { matchLabels: { app: "api" } }, template: tpl } });
    fc.tick(10000);
    c.advance();
    const d = structuredClone(c.get("Deployment", "api")!);
    d.spec.template.spec.containers[0].image = "nginx:1.99.x";
    c.replace(d);
    fc.tick(60000);
    c.advance();
    const after = c.get("Deployment", "api")!;
    expect(after.status.readyReplicas).toBe(3);
    expect(after.status.updatedReplicas).toBe(1);
  });

  it("removes replicasets and pods when the deployment is deleted", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 7 });
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x" }, spec: { replicas: 2, selector: { matchLabels: { app: "x" } }, template: { metadata: { labels: { app: "x" } }, spec: { containers: [{ name: "x", image: "nginx" }] } } } });
    fc.tick(5000);
    c.advance();
    expect(c.list("Pod", "default")).toHaveLength(2);
    c.remove("Deployment", "x");
    c.advance();
    expect(c.list("ReplicaSet", "default")).toHaveLength(0);
    expect(c.list("Pod", "default")).toHaveLength(0);
  });
});

describe("services", () => {
  it("fills endpoints with ready pods", () => {
    const fc = fakeClock();
    const c = new Cluster({ clock: fc.clock, seed: 8 });
    c.create({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: 2, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "nginx", ports: [{ containerPort: 80, name: "http" }] }] } } } });
    c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "web" }, spec: { selector: { app: "web" }, ports: [{ port: 8080, targetPort: "http" }] } });
    fc.tick(10000);
    c.advance();
    const ep = c.get("Endpoints", "web")!;
    expect((ep.subsets as { addresses: unknown[] }[])[0].addresses).toHaveLength(2);
    expect((ep.subsets as { ports: { port: number }[] }[])[0].ports[0].port).toBe(80);
  });
});
