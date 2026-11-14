import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

const run = async (s: ReturnType<typeof sandbox>, c: string) => (await s.run(c)).out;

describe("Jobs and CronJobs", () => {
  it("a job completes and keeps its logs", async () => {
    const s = sandbox();
    expect(await run(s, "kubectl create job hello --image=busybox -- sh -c 'echo hello from job'")).toBe("job.batch/hello created\n");
    s.tick(8000);
    expect(await run(s, "kubectl get job hello")).toMatch(/hello\s+Complete\s+1\/1/);
    expect(await run(s, "kubectl logs job/hello")).toBe("hello from job\n");
    expect(await run(s, "kubectl get pods")).toMatch(/hello-\S+\s+0\/1\s+Completed/);
  });

  it("a failing job backs off and gives up after backoffLimit", async () => {
    const s = sandbox();
    s.fs.writeFile("j.yaml", "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: fail\nspec:\n  backoffLimit: 2\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: c\n        image: busybox\n        command: ['sh','-c','exit 3']\n");
    await run(s, "kubectl apply -f j.yaml");
    for (let i = 0; i < 12; i++) s.tick(10000), s.cluster.advance();
    expect(await run(s, "kubectl get job fail")).toMatch(/fail\s+Failed\s+0\/1/);
    expect((await run(s, "kubectl get pods --no-headers")).trim().split("\n")).toHaveLength(3);
    expect(await run(s, "kubectl describe job fail")).toMatch(/BackoffLimitExceeded\s+\S+\s+job-controller\s+Job has reached the specified backoff limit/);
  });

  it("restartPolicy Always is rejected for jobs", async () => {
    const s = sandbox();
    s.fs.writeFile("j.yaml", "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: bad\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        image: busybox\n");
    const r = await s.run("kubectl apply -f j.yaml");
    expect(r.err).toMatch(/spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"/);
  });

  it("parallel jobs run several pods at once", async () => {
    const s = sandbox();
    s.fs.writeFile("j.yaml", "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: par\nspec:\n  completions: 6\n  parallelism: 3\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: c\n        image: busybox\n        command: ['sleep','5']\n");
    await run(s, "kubectl apply -f j.yaml");
    s.tick(3000);
    expect((await run(s, "kubectl get pods --no-headers")).trim().split("\n")).toHaveLength(3);
    s.tick(30000);
    expect(await run(s, "kubectl get job par")).toMatch(/Complete\s+6\/6/);
  });

  it("a cronjob creates jobs on schedule and one can be started by hand", async () => {
    const s = sandbox();
    await run(s, "kubectl create cronjob tick --image=busybox --schedule='*/1 * * * *' -- date");
    s.tick(125000);
    expect(await run(s, "kubectl get cj tick")).toMatch(/tick\s+\*\/1 \* \* \* \*\s+<none>\s+False\s+0\s+\d+s/);
    expect((await run(s, "kubectl get jobs --no-headers")).trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(await run(s, "kubectl create job manual --from=cronjob/tick")).toBe("job.batch/manual created\n");
    const bad = await s.run("kubectl create cronjob x --image=busybox --schedule='* * *'");
    expect(bad.err).toMatch(/spec.schedule: Invalid value: "\* \* \*": expected exactly 5 fields, found 3/);
  });
});

describe("DaemonSets and StatefulSets", () => {
  it("a daemonset runs one pod per worker and rolls out updates", async () => {
    const s = sandbox();
    s.fs.writeFile("ds.yaml", "apiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: agent\nspec:\n  selector:\n    matchLabels: {app: agent}\n  template:\n    metadata:\n      labels: {app: agent}\n    spec:\n      containers:\n      - name: agent\n        image: busybox\n        command: ['sleep','infinity']\n");
    await run(s, "kubectl apply -f ds.yaml");
    s.tick(6000);
    expect(await run(s, "kubectl get ds agent")).toMatch(/agent\s+2\s+2\s+2\s+2\s+2\s+<none>/);
    await run(s, "kubectl set image ds/agent agent=busybox:1.36");
    expect(await run(s, "kubectl rollout status ds/agent")).toMatch(/daemon set "agent" successfully rolled out/);
    expect(await run(s, "kubectl rollout history ds/agent")).toMatch(/1\s+<none>\n2\s+<none>/);
  });

  it("a daemonset with a control plane toleration runs on all three nodes", async () => {
    const s = sandbox();
    s.fs.writeFile("ds.yaml", "apiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: agent\nspec:\n  selector:\n    matchLabels: {app: agent}\n  template:\n    metadata:\n      labels: {app: agent}\n    spec:\n      tolerations:\n      - key: node-role.kubernetes.io/control-plane\n        effect: NoSchedule\n      containers:\n      - name: agent\n        image: busybox\n        command: ['sleep','infinity']\n");
    await run(s, "kubectl apply -f ds.yaml");
    s.tick(6000);
    expect(await run(s, "kubectl get ds agent")).toMatch(/agent\s+3\s+3\s+3/);
  });

  it("a statefulset creates pods in order with stable names, claims and DNS", async () => {
    const s = sandbox();
    s.fs.writeFile("sts.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: nginx\nspec:\n  clusterIP: None\n  selector: {app: web}\n  ports:\n  - port: 80\n---\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: web\nspec:\n  serviceName: nginx\n  replicas: 3\n  selector:\n    matchLabels: {app: web}\n  template:\n    metadata:\n      labels: {app: web}\n    spec:\n      containers:\n      - name: nginx\n        image: nginx\n        volumeMounts:\n        - name: www\n          mountPath: /usr/share/nginx/html\n  volumeClaimTemplates:\n  - metadata:\n      name: www\n    spec:\n      accessModes: [ReadWriteOnce]\n      resources:\n        requests:\n          storage: 1Gi\n");
    await run(s, "kubectl apply -f sts.yaml");
    s.tick(3000);
    expect((await run(s, "kubectl get pods --no-headers")).trim().split("\n")).toHaveLength(1);
    expect(await run(s, "kubectl rollout status sts/web")).toMatch(/statefulset rolling update complete 3 pods/);
    expect(await run(s, "kubectl get pvc -o name")).toBe("persistentvolumeclaim/www-web-0\npersistentvolumeclaim/www-web-1\npersistentvolumeclaim/www-web-2\n");
    await run(s, "kubectl exec web-1 -- sh -c 'echo web-1 > /usr/share/nginx/html/index.html'");
    expect(await run(s, "kubectl run t --rm -it --image=busybox --restart=Never -- wget -qO- http://web-1.nginx")).toBe('web-1\npod "t" deleted\n');
    await run(s, "kubectl delete pod web-1");
    s.tick(8000);
    expect(await run(s, "kubectl exec web-1 -- cat /usr/share/nginx/html/index.html")).toBe("web-1\n");
    await run(s, "kubectl scale sts web --replicas=1");
    s.tick(10000);
    expect(await run(s, "kubectl get pods -o name")).toBe("pod/web-0\n");
  });
});

describe("containers run simulated processes", () => {
  it("a liveness probe restarts a container whose health file disappears", async () => {
    const s = sandbox();
    s.fs.writeFile("p.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: live\nspec:\n  containers:\n  - name: c\n    image: busybox\n    args: [/bin/sh, -c, 'touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600']\n    livenessProbe:\n      exec:\n        command: [cat, /tmp/healthy]\n      initialDelaySeconds: 5\n      periodSeconds: 5\n");
    await run(s, "kubectl apply -f p.yaml");
    s.tick(20000);
    expect(await run(s, "kubectl get pod live")).toMatch(/1\/1\s+Running\s+0/);
    s.tick(40000);
    expect(await run(s, "kubectl get pod live")).toMatch(/Running\s+1 \(\d+s ago\)/);
    const d = await run(s, "kubectl describe pod live");
    expect(d).toMatch(/Liveness probe failed: cat: can't open '\/tmp\/healthy': No such file or directory/);
    expect(d).toMatch(/Container c failed liveness probe, will be restarted/);
    expect(d).toMatch(/Liveness:\s+exec \[cat \/tmp\/healthy\] delay=5s timeout=1s period=5s #success=1 #failure=3/);
  });

  it("a readiness probe keeps a pod out of service endpoints until it passes", async () => {
    const s = sandbox();
    s.fs.writeFile("p.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\n  labels: {app: web}\nspec:\n  containers:\n  - name: nginx\n    image: nginx\n    readinessProbe:\n      httpGet:\n        path: /healthz\n        port: 80\n      periodSeconds: 5\n");
    await run(s, "kubectl apply -f p.yaml");
    await run(s, "kubectl expose pod web --port=80");
    s.tick(15000);
    expect(await run(s, "kubectl get pod web")).toMatch(/0\/1\s+Running/);
    expect(await run(s, "kubectl get ep web")).toMatch(/web\s+<none>/);
    expect(await run(s, "kubectl get events")).toMatch(/Readiness probe failed: HTTP probe failed with statuscode: 404/);
    await run(s, "kubectl exec web -- sh -c 'echo ok > /usr/share/nginx/html/healthz'");
    s.tick(10000);
    expect(await run(s, "kubectl get pod web")).toMatch(/1\/1\s+Running/);
    expect(await run(s, "kubectl get ep web")).toMatch(/10\.244\.\d+\.\d+:80/);
  });

  it("init containers wait for a service, then the app starts", async () => {
    const s = sandbox();
    s.fs.writeFile("p.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: myapp\nspec:\n  initContainers:\n  - name: wait\n    image: busybox:1.28\n    command: ['sh','-c','until nslookup mydb; do echo waiting for mydb; sleep 2; done']\n  containers:\n  - name: app\n    image: busybox:1.28\n    command: ['sh','-c','echo The app is running! && sleep 3600']\n");
    await run(s, "kubectl apply -f p.yaml");
    s.tick(10000);
    expect(await run(s, "kubectl get pod myapp")).toMatch(/0\/1\s+Init:0\/1/);
    expect(await run(s, "kubectl logs myapp -c wait")).toMatch(/waiting for mydb/);
    await run(s, "kubectl create deploy mydb --image=redis");
    await run(s, "kubectl expose deploy mydb --port=6379");
    s.tick(10000);
    expect(await run(s, "kubectl get pod myapp")).toMatch(/1\/1\s+Running/);
    expect(await run(s, "kubectl logs myapp")).toBe("The app is running!\n");
  });

  it("a native sidecar reads what the app writes to a shared emptyDir", async () => {
    const s = sandbox();
    s.fs.writeFile("p.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: app\nspec:\n  volumes:\n  - name: logs\n    emptyDir: {}\n  initContainers:\n  - name: shipper\n    image: busybox\n    restartPolicy: Always\n    command: ['sh','-c','tail -F /var/log/app.log']\n    volumeMounts:\n    - {name: logs, mountPath: /var/log}\n  containers:\n  - name: app\n    image: busybox\n    command: ['sh','-c','i=0; while true; do echo \"line $i\" >> /var/log/app.log; i=$((i+1)); sleep 2; done']\n    volumeMounts:\n    - {name: logs, mountPath: /var/log}\n");
    await run(s, "kubectl apply -f p.yaml");
    s.tick(12000);
    expect(await run(s, "kubectl get pod app")).toMatch(/2\/2\s+Running/);
    expect(await run(s, "kubectl logs app -c shipper")).toMatch(/^line 0\nline 1\n/);
  });

  it("an interactive shell keeps state between lines and --rm deletes the pod", async () => {
    const s = sandbox();
    expect(await run(s, "kubectl run tmp --rm -it --image=busybox --restart=Never -- sh")).toBe("If you don't see a command prompt, try pressing enter.\n");
    expect(s.shell.sessionPrompt()).toBe("/ # ");
    await run(s, "cd /tmp; echo hi > a.txt");
    expect(s.shell.sessionPrompt()).toBe("/tmp # ");
    expect(await run(s, "cat a.txt")).toBe("hi\n");
    expect(await run(s, "exit")).toBe('pod "tmp" deleted\n');
    expect(s.shell.sessionPrompt()).toBeUndefined();
  });
});
