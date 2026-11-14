import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

const run = async (s: ReturnType<typeof sandbox>, c: string) => (await s.run(c)).out;
const errOf = async (s: ReturnType<typeof sandbox>, c: string) => (await s.run(c)).err;

describe("quotas and limit ranges", () => {
  it("a quota demands requests and limits, a LimitRange fills them in", async () => {
    const s = sandbox();
    await run(s, "kubectl create ns dev");
    await run(s, "kubectl create quota q1 -n dev --hard=pods=2,requests.cpu=1,limits.cpu=2,requests.memory=1Gi,limits.memory=2Gi");
    expect(await errOf(s, "kubectl run p1 -n dev --image=nginx")).toBe(
      'Error from server (Forbidden): pods "p1" is forbidden: failed quota: q1: must specify limits.cpu for: p1; limits.memory for: p1; requests.cpu for: p1; requests.memory for: p1\n',
    );
    s.fs.writeFile("lr.yaml", "apiVersion: v1\nkind: LimitRange\nmetadata:\n  name: defaults\n  namespace: dev\nspec:\n  limits:\n  - type: Container\n    default: {cpu: 500m, memory: 256Mi}\n    defaultRequest: {cpu: 250m, memory: 128Mi}\n    max: {cpu: '1'}\n");
    await run(s, "kubectl apply -f lr.yaml");
    expect(await run(s, "kubectl run p1 -n dev --image=nginx")).toBe("pod/p1 created\n");
    expect(await run(s, "kubectl get pod p1 -n dev -o jsonpath='{.spec.containers[0].resources.requests.cpu}'")).toBe("250m");
    expect(await run(s, "kubectl describe quota q1 -n dev")).toMatch(/requests\.cpu\s+250m\s+1/);
    await run(s, "kubectl create deploy web -n dev --image=nginx --replicas=3");
    s.tick(5000);
    expect(await run(s, "kubectl get deploy web -n dev")).toMatch(/web\s+\d\/3/);
    expect(await run(s, "kubectl describe rs -n dev")).toMatch(/FailedCreate.*exceeded quota: q1, requested: pods=1, used: pods=2, limited: pods=2/);
    const big = await s.run(`kubectl run big -n dev --image=nginx --overrides='{"spec":{"containers":[{"name":"big","image":"nginx","resources":{"limits":{"cpu":"2"}}}]}}'`);
    expect(big.err).toMatch(/maximum cpu usage per Container is 1, but limit is 2/);
  });
});

describe("pod security and service accounts", () => {
  it("restricted namespaces reject pods that do not harden themselves", async () => {
    const s = sandbox();
    await run(s, "kubectl create ns secure");
    await run(s, "kubectl label ns secure pod-security.kubernetes.io/enforce=restricted");
    const e = await errOf(s, "kubectl run bad -n secure --image=nginx");
    expect(e).toMatch(/violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false/);
    expect(e).toMatch(/runAsNonRoot != true/);
    s.fs.writeFile("ok.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: ok\n  namespace: secure\nspec:\n  securityContext:\n    runAsNonRoot: true\n    runAsUser: 1000\n    seccompProfile: {type: RuntimeDefault}\n  containers:\n  - name: c\n    image: busybox\n    command: ['sleep','3600']\n    securityContext:\n      allowPrivilegeEscalation: false\n      capabilities: {drop: [ALL]}\n");
    expect(await run(s, "kubectl apply -f ok.yaml")).toBe("pod/ok created\n");
    s.tick(5000);
    expect(await run(s, "kubectl exec -n secure ok -- id")).toBe("uid=1000 gid=1000 groups=1000\n");
  });

  it("runAsNonRoot with a root image fails to start, readOnlyRootFilesystem blocks writes", async () => {
    const s = sandbox();
    await run(s, `kubectl run nr --image=nginx --overrides='{"spec":{"securityContext":{"runAsNonRoot":true}}}'`);
    s.tick(5000);
    expect(await run(s, "kubectl get pod nr")).toMatch(/CreateContainerConfigError/);
    expect(await run(s, "kubectl describe pod nr")).toMatch(/container has runAsNonRoot and image will run as root/);
    s.fs.writeFile("ro.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: ro\nspec:\n  volumes:\n  - name: scratch\n    emptyDir: {}\n  containers:\n  - name: c\n    image: busybox\n    command: ['sleep','3600']\n    securityContext:\n      readOnlyRootFilesystem: true\n    volumeMounts:\n    - {name: scratch, mountPath: /scratch}\n");
    await run(s, "kubectl apply -f ro.yaml");
    s.tick(5000);
    expect((await s.run("kubectl exec ro -- touch /tmp/x")).err).toMatch(/touch: \/tmp\/x: Read-only file system/);
    expect((await s.run("kubectl exec ro -- touch /scratch/x")).code).toBe(0);
  });

  it("a missing service account is rejected", async () => {
    const s = sandbox();
    expect(await errOf(s, `kubectl run p --image=nginx --overrides='{"spec":{"serviceAccountName":"ghost"}}'`)).toBe(
      'Error from server (Forbidden): pods "p" is forbidden: error looking up service account default/ghost: serviceaccount "ghost" not found\n',
    );
  });

  it("--as is checked against RBAC, and pods can call the API with their token", async () => {
    const s = sandbox();
    await run(s, "kubectl create sa reader");
    await run(s, "kubectl create role pod-reader --verb=get,list --resource=pods");
    await run(s, "kubectl create rolebinding rb --role=pod-reader --serviceaccount=default:reader");
    expect((await s.run("kubectl get pods --as=system:serviceaccount:default:reader")).code).toBe(0);
    expect(await errOf(s, "kubectl get deploy --as=system:serviceaccount:default:reader")).toBe(
      'Error from server (Forbidden): deployments.apps is forbidden: User "system:serviceaccount:default:reader" cannot list resource "deployments" in API group "apps" in the namespace "default"\n',
    );
    s.fs.writeFile("api.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api\nspec:\n  serviceAccountName: reader\n  containers:\n  - name: c\n    image: nicolaka/netshoot\n    command: ['sleep','infinity']\n");
    await run(s, "kubectl apply -f api.yaml");
    s.tick(5000);
    const tokenCurl = (path: string, flags = "-sk") => `kubectl exec api -- sh -c 'curl ${flags} -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" https://kubernetes.default.svc${path}'`;
    expect(await run(s, tokenCurl("/api/v1/namespaces/default/pods"))).toMatch(/"kind": "PodList"[\s\S]*"name": "api"/);
    expect(await run(s, tokenCurl("/api/v1/namespaces/default/secrets"))).toMatch(/"code": 403/);
    expect((await s.run(tokenCurl("/api/v1/namespaces/default/pods", "-s"))).code).toBe(60);
    expect(await run(s, "kubectl create token reader")).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+\n$/);
  });
});

describe("persistent volumes", () => {
  it("a claim binds to a matching volume, and data outlives the pod", async () => {
    const s = sandbox();
    s.fs.writeFile("pv.yaml", "apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: task-pv\nspec:\n  storageClassName: manual\n  capacity: {storage: 10Gi}\n  accessModes: [ReadWriteOnce]\n  hostPath: {path: /mnt/data}\n---\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: task-pvc\nspec:\n  storageClassName: manual\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests: {storage: 3Gi}\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: writer\nspec:\n  volumes:\n  - name: data\n    persistentVolumeClaim: {claimName: task-pvc}\n  containers:\n  - name: c\n    image: busybox\n    command: ['sh','-c','echo saved > /data/file; sleep 3600']\n    volumeMounts:\n    - {name: data, mountPath: /data}\n");
    await run(s, "kubectl apply -f pv.yaml");
    s.tick(5000);
    expect(await run(s, "kubectl get pvc task-pvc")).toMatch(/task-pvc\s+Bound\s+task-pv\s+10Gi\s+RWO\s+manual/);
    await run(s, "kubectl delete pod writer");
    await run(s, `kubectl run reader --image=busybox --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"task-pvc"}}],"containers":[{"name":"reader","image":"busybox","command":["sleep","3600"],"volumeMounts":[{"name":"d","mountPath":"/d"}]}]}}'`);
    s.tick(5000);
    expect(await run(s, "kubectl exec reader -- cat /d/file")).toBe("saved\n");
    await run(s, "kubectl delete pod reader");
    await run(s, "kubectl delete pvc task-pvc");
    s.tick(2000);
    expect(await run(s, "kubectl get pv task-pv")).toMatch(/Retain\s+Released\s+default\/task-pvc/);
  });

  it("a claim without a class gets a volume from the default StorageClass", async () => {
    const s = sandbox();
    s.fs.writeFile("pvc.yaml", "apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\nspec:\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests: {storage: 1Gi}\n");
    await run(s, "kubectl apply -f pvc.yaml");
    s.tick(1000);
    expect(await run(s, "kubectl get pv")).toMatch(/pvc-\S+\s+1Gi\s+RWO\s+Delete\s+Bound\s+default\/data\s+standard/);
    await run(s, "kubectl delete pvc data");
    s.tick(1000);
    expect((await s.run("kubectl get pv")).err).toBe("No resources found\n");
  });
});
