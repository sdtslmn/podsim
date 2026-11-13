import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

describe("README claims", () => {
  it("custom-columns, sort-by, field-selector", async () => {
    const s = sandbox();
    await s.run("kubectl create deploy web --image=nginx --replicas=2");
    await s.run("kubectl run solo --image=busybox --restart=Never -- sh -c 'echo hi'");
    s.tick(10000);
    const cc = await s.run("kubectl get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image --sort-by=.metadata.name");
    expect(cc.out.split("\n")[0]).toMatch(/^NAME\s+IMAGE$/);
    expect(cc.out).toMatch(/solo\s+busybox/);
    const fsel = await s.run("kubectl get pods --field-selector status.phase=Succeeded -o name");
    expect(fsel.out.trim()).toBe("pod/solo");
    expect((await s.run("kubectl get pod solo")).out).toMatch(/solo\s+0\/1\s+Completed/);
    expect((await s.run("kubectl logs solo")).out).toBe("hi\n");
  });

  it("wait, patch, replace --force, cut, xargs, pvc", async () => {
    const s = sandbox();
    await s.run("kubectl create deploy web --image=nginx");
    const w = await s.run("kubectl wait --for=condition=Available deployment/web --timeout=30s");
    expect(w.out).toBe("deployment.apps/web condition met\n");
    expect((await s.run(`kubectl patch deployment web -p '{"spec":{"replicas":3}}'`)).out).toBe("deployment.apps/web patched\n");
    s.tick(8000);
    expect((await s.run("kubectl get deploy web --no-headers | cut -d ' ' -f 1")).out.trim()).toBe("web");
    await s.run("kubectl run p --image=nginx --dry-run=client -o yaml > p.yaml");
    await s.run("kubectl apply -f p.yaml");
    const r = await s.run("kubectl replace --force -f p.yaml");
    expect(r.out).toBe('pod "p" deleted\npod/p replaced\n');
    const x = await s.run("kubectl get pods -l app=web -o name | xargs kubectl delete");
    expect(x.out.match(/deleted/g)?.length).toBe(3);
    s.fs.writeFile("pvc.yaml", "apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\nspec:\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests:\n      storage: 1Gi\n");
    await s.run("kubectl apply -f pvc.yaml");
    expect((await s.run("kubectl get pvc data")).out).toMatch(/data\s+Bound\s+pvc-\S+\s+1Gi\s+RWO\s+standard/);
  });

  it("taints and tolerations keep pods off a node", async () => {
    const s = sandbox();
    expect((await s.run("kubectl taint nodes node01 dedicated=gpu:NoSchedule")).out).toBe("node/node01 tainted\n");
    await s.run("kubectl create deploy web --image=nginx --replicas=4");
    s.tick(8000);
    expect((await s.run("kubectl get pods -o wide")).out).not.toContain("node01");
    expect((await s.run("kubectl taint nodes node01 dedicated=gpu:NoSchedule-")).out).toBe("node/node01 untainted\n");
  });
});
