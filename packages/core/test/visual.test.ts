import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";
import { clusterView } from "../src/visual.js";
import { trafficEvents } from "../src/podruntime.js";

describe("visualizer data", () => {
  it("shows nodes with their Pods, Services with endpoints and Ingress routes", async () => {
    const s = sandbox();
    await s.run("kubectl create deployment web --image=nginx:1.29 --replicas=2");
    await s.run("kubectl expose deployment web --port=80");
    await s.run("kubectl create ingress web --class=nginx --rule='web.local/*=web:80'");
    await s.run("kubectl run broken --image=ngnix:1.29");
    await s.run("kubectl cordon node02");
    s.tick(15000);
    s.cluster.advance();
    const v = clusterView(s.cluster);
    const web = v.pods.filter((p) => p.owner?.name === "web");
    expect(web).toHaveLength(2);
    expect(web.every((p) => p.state === "running" && p.owner?.kind === "Deployment")).toBe(true);
    expect(v.pods.find((p) => p.name === "broken")!.state).toBe("failed");
    expect(v.pods.some((p) => p.ns === "kube-system")).toBe(false);
    expect(clusterView(s.cluster, { system: true }).pods.some((p) => p.ns === "kube-system")).toBe(true);
    const svc = v.services.find((x) => x.name === "web")!;
    expect(svc.ready.sort()).toEqual(web.map((p) => p.uid).sort());
    expect(v.ingresses[0].routes).toEqual([{ host: "web.local", path: "/", service: "web", port: "80" }]);
    expect(v.nodes.find((n) => n.name === "node02")!.unschedulable).toBe(true);
    expect(v.nodes.find((n) => n.name === "controlplane")!.taints).toContain("node-role.kubernetes.io/control-plane:NoSchedule");
  });

  it("marks Pods selected by NetworkPolicies and records allowed and blocked traffic", async () => {
    const s = sandbox();
    await s.run("kubectl run db --image=redis:7 -l app=db --port=6379 --expose");
    await s.run("kubectl run backend --image=busybox:1.36 -l app=backend -- sleep 3600");
    await s.run("kubectl run frontend --image=busybox:1.36 -l app=frontend -- sleep 3600");
    s.tick(15000);
    s.fs.writeFile("np.yaml", "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: backend\n    ports:\n    - port: 6379\n");
    await s.run("kubectl apply -f np.yaml");
    const v = clusterView(s.cluster, { namespace: "default" });
    const db = v.pods.find((p) => p.name === "db")!;
    expect(db.ingressPolicy).toBe(true);
    expect(v.pods.find((p) => p.name === "frontend")!.ingressPolicy).toBe(false);
    expect(v.policies[0].rules).toEqual(["Ingress from pods app=backend on 6379/TCP"]);
    const before = trafficEvents(s.cluster).at(-1)?.seq ?? 0;
    await s.run("kubectl exec backend -- nc -z -w 2 db 6379");
    await s.run("kubectl exec frontend -- nc -z -w 2 db 6379");
    const events = trafficEvents(s.cluster, before);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ from: { ns: "default", name: "backend" }, service: { name: "db" }, pod: { name: "db" }, ok: true });
    expect(events[1]).toMatchObject({ from: { name: "frontend" }, pod: { name: "db" }, ok: false, blocked: "ingress-policy" });
  });
});
