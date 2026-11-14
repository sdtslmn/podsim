import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

type S = ReturnType<typeof sandbox>;
const run = async (s: S, c: string) => (await s.run(c)).out;
const err = async (s: S, c: string) => (await s.run(c)).err;

describe("kubectl top and metrics-server", () => {
  it("reports pod and node usage once metrics are scraped", async () => {
    const s = sandbox();
    await run(s, "kubectl create deploy web --image=nginx --replicas=2");
    await run(s, "kubectl run burner --image=polinux/stress -- stress --cpu 1");
    s.tick(5000);
    expect(await err(s, "kubectl top pod burner")).toMatch(/Metrics not available for pod default\/burner/);
    s.tick(30000);
    const top = await run(s, "kubectl top pod --sort-by=cpu");
    expect(top.split("\n")[0]).toMatch(/NAME\s+CPU\(cores\)\s+MEMORY\(bytes\)/);
    expect(top.split("\n")[1]).toMatch(/^burner\s+1000m/);
    expect(await run(s, "kubectl top pod --sort-by=cpu --no-headers | head -1 | awk '{print $1}'")).toBe("burner\n");
    expect(await run(s, "kubectl top node")).toMatch(/node01\s+\d+m\s+\d+%\s+\d+Mi\s+\d+%/);
    expect(await run(s, "kubectl top pod -n kube-system")).toMatch(/metrics-server/);
  });

  it("fails without metrics-server", async () => {
    const s = sandbox();
    await run(s, "kubectl scale deploy metrics-server -n kube-system --replicas=0");
    s.tick(30000);
    expect(await err(s, "kubectl top pod")).toBe("error: Metrics API not available\n");
  });
});

describe("HorizontalPodAutoscaler", () => {
  it("scales a busy Deployment up to maxReplicas", async () => {
    const s = sandbox();
    s.fs.writeFile("d.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: busy\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: busy\n  template:\n    metadata:\n      labels:\n        app: busy\n    spec:\n      containers:\n      - name: stress\n        image: polinux/stress\n        command: [\"stress\", \"--cpu\", \"1\"]\n        resources:\n          requests:\n            cpu: 200m\n          limits:\n            cpu: 500m\n");
    await run(s, "kubectl apply -f d.yaml");
    expect(await run(s, "kubectl autoscale deployment busy --min=1 --max=4 --cpu-percent=50")).toBe("horizontalpodautoscaler.autoscaling/busy autoscaled\n");
    expect(await run(s, "kubectl get hpa busy")).toMatch(/cpu: <unknown>\/50%/);
    for (let i = 0; i < 8; i++) s.tick(15000), await run(s, "kubectl get hpa");
    expect(await run(s, "kubectl get hpa busy")).toMatch(/busy\s+Deployment\/busy\s+cpu: \d+%\/50%\s+1\s+4\s+4/);
    expect(await run(s, "kubectl get deploy busy -o jsonpath='{.spec.replicas}'")).toBe("4");
    expect(await run(s, "kubectl describe hpa busy")).toMatch(/SuccessfulRescale\s+.*New size: 4; reason: cpu resource utilization \(percentage of request\) above target/);
  });

  it("reports missing CPU requests", async () => {
    const s = sandbox();
    await run(s, "kubectl create deploy web --image=nginx");
    await run(s, "kubectl autoscale deploy web --max=3 --cpu-percent=80");
    s.tick(45000);
    await run(s, "kubectl get hpa");
    expect(await run(s, "kubectl get hpa web")).toMatch(/cpu: <unknown>\/80%/);
    expect(await run(s, "kubectl events --for hpa/web")).toMatch(/FailedGetResourceMetric\s+HorizontalPodAutoscaler\/web\s+failed to get cpu utilization: missing request for cpu in container nginx/);
  });
});

describe("kubectl events", () => {
  it("lists events with filters", async () => {
    const s = sandbox();
    await run(s, "kubectl run bad --image=ngnix:1.27");
    s.tick(20000);
    const all = await run(s, "kubectl events");
    expect(all.split("\n")[0]).toMatch(/^LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE/);
    expect(await run(s, "kubectl events --types=Warning")).toMatch(/Warning\s+Failed\s+Pod\/bad/);
    expect(await run(s, "kubectl events --for pod/bad")).not.toMatch(/Node\//);
    expect(await err(s, "kubectl events -n kube-public")).toBe("No events found in kube-public namespace.\n");
  });
});

describe("kubectl debug", () => {
  it("adds an ephemeral container and opens a shell in it", async () => {
    const s = sandbox();
    await run(s, "kubectl run web --image=nginx:1.29");
    s.tick(10000);
    const r = await s.run("kubectl debug -it web --image=busybox:1.36 --target=web --container=dbg");
    expect(r.out).toContain("If you don't see a command prompt, try pressing enter.");
    expect(r.err).toContain('Targeting container "web"');
    expect(await run(s, "wget -qO- localhost")).toMatch(/Welcome to nginx/);
    expect(await run(s, "exit")).toContain("Session ended, the ephemeral container will not be restarted");
    expect(await run(s, "kubectl get pod web -o jsonpath='{.spec.ephemeralContainers[0].name}'")).toBe("dbg");
    expect(await run(s, "kubectl get pod web -o jsonpath='{.status.ephemeralContainerStatuses[0].state.running}'")).not.toBe("");
  });

  it("debugs a crashing pod through a copy", async () => {
    const s = sandbox();
    await run(s, "kubectl run crash --image=busybox:1.36 -- sh -c 'exit 1'");
    s.tick(10000);
    await run(s, "kubectl debug crash -it --copy-to=crash-debug --container=crash -- sh");
    expect(await run(s, "echo inside")).toBe("inside\n");
    await run(s, "exit");
    expect(await run(s, "kubectl get pod crash-debug")).toMatch(/crash-debug\s+1\/1\s+Running/);
    expect(await run(s, "kubectl get pod crash-debug -o jsonpath='{.spec.shareProcessNamespace}'")).toBe("true");
  });

  it("debugs a node with the host filesystem at /host", async () => {
    const s = sandbox();
    expect(await run(s, "kubectl debug node/node01 -it --image=busybox:1.36")).toMatch(/^Creating debugging pod node-debugger-node01-[a-z0-9]{5} with container debugger on node node01\./);
    expect(await run(s, "cat /host/etc/hostname")).toBe("node01\n");
    expect(await run(s, "ls /host/var/lib/kubelet")).toContain("config.yaml");
  });
});

describe("kubectl auth can-i --list and explain", () => {
  it("lists what a ServiceAccount may do", async () => {
    const s = sandbox();
    await run(s, "kubectl create sa dev");
    await run(s, "kubectl create role pod-reader --verb=get,list --resource=pods");
    await run(s, "kubectl create rolebinding dev-read --role=pod-reader --serviceaccount=default:dev");
    const out = await run(s, "kubectl auth can-i --list --as=system:serviceaccount:default:dev");
    expect(out.split("\n")[0]).toMatch(/^Resources\s+Non-Resource URLs\s+Resource Names\s+Verbs/);
    expect(out).toMatch(/\npods\s+\[\]\s+\[\]\s+\[get list\]/);
    expect(out).toMatch(/\[\/healthz\]\s+\[\]\s+\[get\]/);
    expect(await run(s, "kubectl auth can-i --list")).toMatch(/\*\.\*\s+\[\]\s+\[\]\s+\[\*\]/);
  });

  it("explains fields", async () => {
    const s = sandbox();
    const probe = await run(s, "kubectl explain pod.spec.containers.livenessProbe");
    expect(probe).toMatch(/^KIND:\s+Pod\nVERSION:\s+v1\n\nFIELD: livenessProbe <Probe>/);
    expect(probe).toMatch(/httpGet\t<HTTPGetAction>/);
    expect(await run(s, "kubectl explain deploy.spec.strategy --recursive")).toMatch(/rollingUpdate\t<RollingUpdateDeployment>\n    maxSurge\t<IntOrString>/);
    expect(await run(s, "kubectl explain pod.spec.containers")).toMatch(/name\t<string> -required-/);
    expect(await err(s, "kubectl explain pod.spec.nope")).toBe('error: field "nope" does not exist\n');
  });
});

describe("host shell tools", () => {
  it("has sed, find and printf on the work folder", async () => {
    const s = sandbox();
    s.fs.writeFile("f.yaml", "apiVersion: batch/v1beta1\nkind: CronJob\n");
    await run(s, "sed -i 's|batch/v1beta1|batch/v1|' f.yaml");
    expect(s.fs.readFile("f.yaml")).toBe("apiVersion: batch/v1\nkind: CronJob\n");
    expect(await run(s, "sed -n '/kind/p' f.yaml")).toBe("kind: CronJob\n");
    expect(await run(s, "find . -name '*.yaml'")).toBe("./f.yaml\n");
    expect(await run(s, "printf '%s-%s\\n' a b")).toBe("a-b\n");
  });

  it("expands heredocs like bash", async () => {
    const s = sandbox();
    await run(s, "export NAME=web");
    await run(s, 'cat <<EOF > x.txt\nname: $NAME\nliteral: \\$HOME and \\\\ backslash\nEOF');
    expect(s.fs.readFile("x.txt")).toBe("name: web\nliteral: $HOME and \\ backslash\n");
  });

  it("kubectl run -l sets labels and --expose creates a Service", async () => {
    const s = sandbox();
    expect(await run(s, "kubectl run db --image=redis:7 -l app=db --port=6379 --expose")).toBe("service/db created\npod/db created\n");
    expect(await run(s, "kubectl get svc db -o jsonpath='{.spec.selector.app}'")).toBe("db");
    expect(await run(s, "kubectl get pod db -o jsonpath='{.metadata.labels}'")).toBe('{"app":"db"}');
  });
});
