import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

const run = async (s: ReturnType<typeof sandbox>, c: string) => (await s.run(c)).out;

async function webAndApi(s: ReturnType<typeof sandbox>) {
  await run(s, "kubectl create deploy web --image=nginx");
  await run(s, "kubectl expose deploy web --port=80");
  await run(s, "kubectl create deploy api --image=hashicorp/http-echo -- /http-echo -text=api -listen=:8080");
  await run(s, "kubectl expose deploy api --port=8080");
  s.tick(10000);
}

describe("Ingress", () => {
  it("routes by host and path through the ingress-nginx NodePort", async () => {
    const s = sandbox();
    await webAndApi(s);
    expect(await run(s, "kubectl create ingress shop --class=nginx --rule='shop.local/=web:80' --rule='shop.local/api*=api:8080'")).toBe("ingress.networking.k8s.io/shop created\n");
    s.tick(10000);
    expect(await run(s, "kubectl get ingress shop")).toMatch(/shop\s+nginx\s+shop\.local\s+192\.168\.56\.\d+\s+80/);
    expect(await run(s, "curl -s -H 'Host: shop.local' http://node01:30080/")).toMatch(/Welcome to nginx/);
    expect(await run(s, "curl -s -H 'Host: shop.local' http://localhost:30080/api/v1")).toBe("api\n");
    expect(await run(s, "curl -s -o /dev/null -w '%{http_code}' -H 'Host: nope.local' http://localhost:30080/")).toBe("404");
    expect(await run(s, "kubectl describe ingress shop")).toMatch(/\/api\s+api:8080 \(10\.244\.\d+\.\d+:8080\)/);
  });

  it("requires pathType", async () => {
    const s = sandbox();
    s.fs.writeFile("i.yaml", "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: x\nspec:\n  rules:\n  - http:\n      paths:\n      - path: /\n        backend:\n          service:\n            name: web\n            port:\n              number: 80\n");
    expect((await s.run("kubectl apply -f i.yaml")).err).toMatch(/spec.rules\[0\].http.paths\[0\].pathType: Required value: pathType must be specified/);
  });
});

describe("NetworkPolicy", () => {
  it("only lets labelled clients in, and an egress deny breaks DNS", async () => {
    const s = sandbox();
    await webAndApi(s);
    s.fs.writeFile("np.yaml", "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: web-allow-frontend\nspec:\n  podSelector:\n    matchLabels: {app: web}\n  policyTypes: [Ingress]\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels: {role: frontend}\n    ports:\n    - port: 80\n");
    await run(s, "kubectl apply -f np.yaml");
    await run(s, "kubectl run client --image=busybox --restart=Never -- sleep 3600");
    await run(s, "kubectl run frontend --image=busybox --restart=Never --labels=role=frontend -- sleep 3600");
    s.tick(5000);
    expect((await s.run("kubectl exec client -- wget -qO- -T 2 http://web")).err).toMatch(/wget: download timed out/);
    expect(await run(s, "kubectl exec frontend -- wget -qO- -T 2 http://web")).toMatch(/Welcome to nginx/);
    expect(await run(s, "kubectl exec client -- wget -qO- -T 2 http://api:8080")).toBe("api\n");
    s.fs.writeFile("deny.yaml", "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny-egress\nspec:\n  podSelector:\n    matchLabels: {run: client}\n  policyTypes: [Egress]\n");
    await run(s, "kubectl apply -f deny.yaml");
    expect(await run(s, "kubectl exec client -- nslookup api")).toMatch(/connection timed out; no servers could be reached/);
    expect((await s.run("kubectl exec client -- wget -qO- -T 2 http://api:8080")).err).toMatch(/bad address 'api'/);
    s.fs.writeFile("dns.yaml", "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-dns-and-api\nspec:\n  podSelector:\n    matchLabels: {run: client}\n  policyTypes: [Egress]\n  egress:\n  - ports:\n    - {port: 53, protocol: UDP}\n    - {port: 53, protocol: TCP}\n  - to:\n    - podSelector:\n        matchLabels: {app: api}\n    ports:\n    - port: 8080\n");
    await run(s, "kubectl apply -f dns.yaml");
    expect(await run(s, "kubectl exec client -- wget -qO- -T 2 http://api:8080")).toBe("api\n");
  });

  it("namespaceSelector peers allow traffic from other namespaces", async () => {
    const s = sandbox();
    await webAndApi(s);
    await run(s, "kubectl create ns team-a");
    await run(s, "kubectl label ns team-a team=a");
    await run(s, "kubectl create ns team-b");
    s.fs.writeFile("np.yaml", "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: from-team-a\nspec:\n  podSelector: {}\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels: {team: a}\n");
    await run(s, "kubectl apply -f np.yaml");
    await run(s, "kubectl run c -n team-a --image=busybox --restart=Never -- sleep 3600");
    await run(s, "kubectl run c -n team-b --image=busybox --restart=Never -- sleep 3600");
    s.tick(5000);
    expect(await run(s, "kubectl exec -n team-a c -- wget -qO- -T 2 http://web.default")).toMatch(/Welcome to nginx/);
    expect((await s.run("kubectl exec -n team-b c -- wget -qO- -T 2 http://web.default")).code).toBe(1);
  });
});

describe("host networking", () => {
  it("curl from the host reaches NodePorts, ClusterIPs and port-forwards but not service names", async () => {
    const s = sandbox();
    await webAndApi(s);
    await run(s, "kubectl expose deploy api --name=api-np --type=NodePort --port=8080");
    const np = (await run(s, "kubectl get svc api-np -o jsonpath='{.spec.ports[0].nodePort}'")).trim();
    expect(await run(s, `curl -s http://node02:${np}`)).toBe("api\n");
    expect(await run(s, "curl -s http://$(kubectl get svc api -o jsonpath='{.spec.clusterIP}'):8080")).toBe("api\n");
    expect((await s.run("curl -s http://api:8080")).code).toBe(6);
    await run(s, "kubectl port-forward deploy/web 8080:80");
    expect(await run(s, "curl -s localhost:8080")).toMatch(/Welcome to nginx/);
  });
});
