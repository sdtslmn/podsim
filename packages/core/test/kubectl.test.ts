import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

describe("kubectl basics", () => {
  it("lists nodes and system pods", async () => {
    const s = sandbox();
    const nodes = await s.run("kubectl get nodes");
    expect(nodes.code).toBe(0);
    expect(nodes.out).toMatch(/^NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION/);
    expect(nodes.out).toMatch(/controlplane\s+Ready\s+control-plane/);
    const pods = await s.run("k get po -A");
    expect(pods.out).toContain("kube-system");
    expect(pods.out).toContain("coredns-");
    const empty = await s.run("kubectl get pods");
    expect(empty.err).toContain("No resources found in default namespace.");
  });

  it("runs a pod and shows it progress to Running", async () => {
    const s = sandbox();
    expect((await s.run("kubectl run web --image=nginx")).out).toBe("pod/web created\n");
    const early = await s.run("kubectl get pods");
    expect(early.out).toMatch(/web\s+0\/1\s+ContainerCreating/);
    s.tick(8000);
    const later = await s.run("kubectl get pod web -o wide");
    expect(later.out).toMatch(/web\s+1\/1\s+Running\s+0/);
    expect(later.out).toMatch(/10\.244\.\d+\.\d+\s+node0[12]/);
    const desc = await s.run("kubectl describe pod web");
    expect(desc.out).toMatch(/^Name:\s+web$/m);
    expect(desc.out).toMatch(/Successfully assigned default\/web to node0[12]/);
    expect(desc.out).toContain("Started container web");
    const logs = await s.run("kubectl logs web");
    expect(logs.out).toContain("Configuration complete; ready for start up");
  });

  it("prints dry-run YAML like the real client", async () => {
    const s = sandbox();
    const r = await s.run("kubectl run web --image=nginx --port=80 --dry-run=client -o yaml");
    expect(r.out).toBe(
      ["apiVersion: v1", "kind: Pod", "metadata:", "  labels:", "    run: web", "  name: web", "spec:", "  containers:", "  - image: nginx", "    name: web", "    ports:", "    - containerPort: 80", "    resources: {}", "  dnsPolicy: ClusterFirst", "  restartPolicy: Always", "status: {}", ""].join("\n"),
    );
    const d = await s.run("kubectl create deploy web --image=nginx:1.27 --replicas=3 --dry-run=client -o yaml");
    expect(d.out).toContain("replicas: 3");
    expect(d.out).toContain("name: nginx");
    expect(s.cluster.get("Deployment", "web")).toBeUndefined();
  });

  it("supports $do style variables, heredocs and apply", async () => {
    const s = sandbox();
    await s.run('export do="--dry-run=client -o yaml"');
    await s.run("kubectl run api --image=httpd $do > pod.yaml");
    expect(s.fs.readFile("pod.yaml")).toContain("image: httpd");
    expect((await s.run("kubectl apply -f pod.yaml")).out).toBe("pod/api created\n");
    expect((await s.run("kubectl apply -f pod.yaml")).out).toBe("pod/api unchanged\n");
    const heredoc = await s.run(
      [
        "cat <<EOF | kubectl apply -f -",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: app-config",
        "data:",
        "  MODE: prod",
        "EOF",
      ].join("\n"),
    );
    expect(heredoc.out).toBe("configmap/app-config created\n");
    expect(s.shell.needsMoreInput("cat <<EOF > x.yaml\nkind: Pod")).toBe(true);
  });

  it("rejects typos and wrong types the way the API server does", async () => {
    const s = sandbox();
    s.fs.writeFile(
      "bad.yaml",
      ["apiVersion: v1", "kind: Pod", "metadata:", "  name: bad", "spec:", "  containers:", "  - name: bad", "    imagee: nginx"].join("\n"),
    );
    const r = await s.run("kubectl apply -f bad.yaml");
    expect(r.code).toBe(1);
    expect(r.err).toContain('strict decoding error: unknown field "spec.containers[0].imagee"');
    s.fs.writeFile("labels.yaml", ["apiVersion: v1", "kind: Pod", "metadata:", "  name: x", "  labels:", "    version: 1.0", "spec:", "  containers:", "  - name: x", "    image: nginx"].join("\n"));
    const t = await s.run("kubectl apply -f labels.yaml");
    expect(t.err).toContain("cannot unmarshal number into Go struct field ObjectMeta.metadata.labels of type string");
  });
});

describe("deployments and services", () => {
  it("scales, rolls out, rolls back and records history", async () => {
    const s = sandbox();
    await s.run("kubectl create deployment web --image=nginx:1.25 --replicas=2");
    s.tick(8000);
    expect((await s.run("kubectl get deploy web")).out).toMatch(/web\s+2\/2\s+2\s+2/);
    expect((await s.run("kubectl scale deploy web --replicas=4")).out).toBe("deployment.apps/web scaled\n");
    s.tick(8000);
    expect((await s.run("kubectl get deploy web")).out).toMatch(/web\s+4\/4/);
    expect((await s.run("kubectl set image deployment/web nginx=nginx:1.27")).out).toBe("deployment.apps/web image updated\n");
    const status = await s.run("kubectl rollout status deployment/web");
    expect(status.code).toBe(0);
    expect(status.out).toContain('deployment "web" successfully rolled out');
    const hist = await s.run("kubectl rollout history deployment/web");
    expect(hist.out).toMatch(/REVISION\s+CHANGE-CAUSE\n1\s+<none>\n2\s+<none>/);
    expect((await s.run("kubectl rollout undo deployment/web")).out).toBe("deployment.apps/web rolled back\n");
    s.tick(20000);
    const img = await s.run("kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[0].image}'");
    expect(img.out).toBe("nginx:1.25");
  });

  it("exposes a deployment and serves traffic to a client pod", async () => {
    const s = sandbox();
    await s.run("kubectl create deployment web --image=nginx --replicas=2 --port=80");
    await s.run("kubectl expose deployment web --port=80");
    s.tick(8000);
    const svc = await s.run("kubectl get svc web");
    expect(svc.out).toMatch(/web\s+ClusterIP\s+10\.\d+\.\d+\.\d+\s+<none>\s+80\/TCP/);
    const ep = await s.run("kubectl get endpoints web");
    expect(ep.out).toMatch(/10\.244\.\d+\.\d+:80,10\.244\.\d+\.\d+:80/);
    const client = await s.run("kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- http://web");
    expect(client.out).toContain("Welcome to nginx!");
    expect(client.out).toContain('pod "tmp" deleted');
    const dns = await s.run("kubectl run dns --rm -it --image=busybox --restart=Never -- nslookup web");
    expect(dns.out).toContain("web.default.svc.cluster.local");
  });

  it("explains a wrong targetPort with connection refused", async () => {
    const s = sandbox();
    await s.run("kubectl create deployment web --image=nginx --port=80");
    await s.run("kubectl expose deployment web --port=80 --target-port=8080");
    await s.run("kubectl run client --image=busybox -- sleep 3600");
    s.tick(8000);
    const r = await s.run("kubectl exec client -- wget -qO- -T 2 http://web");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Connection refused");
  });
});

describe("troubleshooting signals", () => {
  it("shows ImagePullBackOff with the real event text", async () => {
    const s = sandbox();
    await s.run("kubectl run broken --image=ngnix");
    s.tick(15000);
    expect((await s.run("kubectl get pod broken")).out).toMatch(/broken\s+0\/1\s+(ImagePullBackOff|ErrImagePull)/);
    const d = await s.run("kubectl describe pod broken");
    expect(d.out).toContain("pull access denied");
    await s.run("kubectl set image pod/broken broken=nginx");
    s.tick(8000);
    expect((await s.run("kubectl get pod broken")).out).toMatch(/broken\s+1\/1\s+Running/);
  });

  it("explains Pending pods and fixes them with a node label", async () => {
    const s = sandbox();
    s.fs.writeFile(
      "ssd.yaml",
      ["apiVersion: v1", "kind: Pod", "metadata:", "  name: fast", "spec:", "  nodeSelector:", "    disktype: ssd", "  containers:", "  - name: app", "    image: nginx"].join("\n"),
    );
    await s.run("kubectl apply -f ssd.yaml");
    s.tick(5000);
    const d = await s.run("kubectl describe pod fast");
    expect(d.out).toContain("FailedScheduling");
    expect(d.out).toContain("didn't match Pod's node affinity/selector");
    expect((await s.run("kubectl label node node02 disktype=ssd")).out).toBe("node/node02 labeled\n");
    s.tick(5000);
    expect((await s.run("kubectl get pod fast -o wide")).out).toMatch(/Running.*node02/);
  });

  it("reports CreateContainerConfigError for a missing ConfigMap", async () => {
    const s = sandbox();
    s.fs.writeFile(
      "env.yaml",
      ["apiVersion: v1", "kind: Pod", "metadata:", "  name: app", "spec:", "  containers:", "  - name: app", "    image: nginx", "    envFrom:", "    - configMapRef:", "        name: app-config"].join("\n"),
    );
    await s.run("kubectl apply -f env.yaml");
    s.tick(8000);
    expect((await s.run("kubectl get pod app")).out).toMatch(/CreateContainerConfigError/);
    await s.run("kubectl create configmap app-config --from-literal=MODE=prod");
    s.tick(3000);
    expect((await s.run("kubectl get pod app")).out).toMatch(/app\s+1\/1\s+Running/);
    expect((await s.run("kubectl exec app -- printenv MODE")).out).toBe("prod\n");
  });
});

describe("cluster operations", () => {
  it("drains a node and reschedules pods", async () => {
    const s = sandbox();
    await s.run("kubectl create deployment web --image=nginx --replicas=4");
    s.tick(8000);
    const fail = await s.run("kubectl drain node01");
    expect(fail.code).toBe(1);
    expect(fail.err).toContain("cannot delete DaemonSet-managed Pods");
    const ok = await s.run("kubectl drain node01 --ignore-daemonsets");
    expect(ok.out).toContain("node/node01 drained");
    s.tick(8000);
    const pods = await s.run("kubectl get pods -o wide");
    expect(pods.out).not.toMatch(/web-\S+\s+.*node01/);
    expect((await s.run("kubectl get nodes")).out).toMatch(/node01\s+Ready,SchedulingDisabled/);
    expect((await s.run("kubectl uncordon node01")).out).toBe("node/node01 uncordoned\n");
  });

  it("evaluates RBAC with auth can-i", async () => {
    const s = sandbox();
    await s.run("kubectl create namespace dev");
    await s.run("kubectl create serviceaccount app -n dev");
    await s.run("kubectl create role pod-reader --verb=get,list --resource=pods -n dev");
    await s.run("kubectl create rolebinding app-read --role=pod-reader --serviceaccount=dev:app -n dev");
    expect((await s.run("kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:app")).out).toBe("yes\n");
    expect((await s.run("kubectl auth can-i delete pods -n dev --as=system:serviceaccount:dev:app")).out).toBe("no\n");
    expect((await s.run("kubectl auth can-i list pods -n default --as=system:serviceaccount:dev:app")).out).toBe("no\n");
  });

  it("switches namespace with config set-context", async () => {
    const s = sandbox();
    await s.run("kubectl create ns dev");
    await s.run("kubectl config set-context --current --namespace=dev");
    await s.run("kubectl run x --image=nginx");
    expect(s.cluster.get("Pod", "x", "dev")).toBeTruthy();
  });

  it("pipes output through grep, awk and wc", async () => {
    const s = sandbox();
    await s.run("kubectl create deploy web --image=nginx --replicas=3");
    s.tick(8000);
    expect((await s.run("kubectl get pods --no-headers | wc -l")).out.trim()).toBe("3");
    const names = await s.run("kubectl get pods | grep web | awk '{print $1}'");
    expect(names.out.trim().split("\n")).toHaveLength(3);
    const secret = await s.run("kubectl create secret generic db --from-literal=password=s3cret && kubectl get secret db -o jsonpath='{.data.password}' | base64 -d");
    expect(secret.out).toContain("s3cret");
  });
});
