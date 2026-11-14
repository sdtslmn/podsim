import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.js";

type S = ReturnType<typeof sandbox>;
const run = async (s: S, c: string) => (await s.run(c)).out;
const err = async (s: S, c: string) => (await s.run(c)).err;

const CRD = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com
spec:
  group: stable.example.com
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              cronSpec:
                type: string
              image:
                type: string
              replicas:
                type: integer
    additionalPrinterColumns:
    - name: Spec
      type: string
      jsonPath: .spec.cronSpec
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
  scope: Namespaced
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
    - ct
`;

describe("CustomResourceDefinitions", () => {
  it("registers a new kind with printer columns and schema validation", async () => {
    const s = sandbox();
    s.fs.writeFile("crd.yaml", CRD);
    s.fs.writeFile("ct.yaml", "apiVersion: stable.example.com/v1\nkind: CronTab\nmetadata:\n  name: my-cron\nspec:\n  cronSpec: '* * * * */5'\n  image: my-image\n  replicas: 2\n");
    s.fs.writeFile("bad.yaml", "apiVersion: stable.example.com/v1\nkind: CronTab\nmetadata:\n  name: bad\nspec:\n  cronSpec: 5\n  replicas: 'two'\n");
    expect(await err(s, "kubectl apply -f ct.yaml")).toMatch(/no matches for kind "CronTab" in version "stable.example.com\/v1"\nensure CRDs are installed first/);
    expect(await run(s, "kubectl apply -f crd.yaml")).toBe("customresourcedefinition.apiextensions.k8s.io/crontabs.stable.example.com created\n");
    expect(await run(s, "kubectl apply -f ct.yaml")).toBe("crontab.stable.example.com/my-cron created\n");
    expect(await run(s, "kubectl get ct")).toMatch(/NAME\s+SPEC\s+REPLICAS\s+AGE\nmy-cron\s+\* \* \* \* \*\/5\s+2\s+0s/);
    expect(await run(s, "kubectl get crontabs.stable.example.com my-cron -o jsonpath='{.spec.image}'")).toBe("my-image");
    expect(await err(s, "kubectl apply -f bad.yaml")).toMatch(/spec.replicas in body must be of type integer: "string"/);
    expect(await run(s, "kubectl api-resources")).toMatch(/crontabs\s+ct\s+stable.example.com\/v1\s+true\s+CronTab/);
    await run(s, "kubectl delete crd crontabs.stable.example.com");
    expect(await err(s, "kubectl get ct")).toMatch(/the server doesn't have a resource type "ct"/);
  });

  it("keeps custom kinds inside their own cluster", async () => {
    const a = sandbox();
    const b = sandbox();
    a.fs.writeFile("crd.yaml", CRD);
    await run(a, "kubectl apply -f crd.yaml");
    expect(await err(a, "kubectl get ct")).toMatch(/No resources found/);
    expect(await err(b, "kubectl get ct")).toMatch(/doesn't have a resource type/);
  });
});

describe("API deprecations", () => {
  it("rejects removed API versions with the real message", async () => {
    const s = sandbox();
    s.fs.writeFile("old.yaml", "apiVersion: extensions/v1beta1\nkind: Deployment\nmetadata:\n  name: old\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        image: nginx\n");
    expect(await err(s, "kubectl apply -f old.yaml")).toMatch(/no matches for kind "Deployment" in version "extensions\/v1beta1"/);
    expect(await run(s, "kubectl api-resources --api-group=apps")).toMatch(/deployments\s+deploy\s+apps\/v1/);
  });
});

describe("Helm", () => {
  it("installs, upgrades, rolls back and uninstalls a repository chart", async () => {
    const s = sandbox();
    expect(await run(s, "helm repo add bitnami https://charts.bitnami.com/bitnami")).toBe('"bitnami" has been added to your repositories\n');
    expect(await run(s, "helm search repo nginx")).toMatch(/bitnami\/nginx\s+22\.1\.1\s+1\.29\.3/);
    expect(await run(s, "helm install my-nginx bitnami/nginx --set replicaCount=2 --set service.type=ClusterIP")).toMatch(/STATUS: deployed\nREVISION: 1/);
    s.tick(10000);
    expect(await run(s, "kubectl get deploy my-nginx")).toMatch(/my-nginx\s+2\/2/);
    expect(await run(s, "kubectl get svc my-nginx")).toMatch(/ClusterIP/);
    await run(s, "helm upgrade my-nginx bitnami/nginx --reuse-values --set replicaCount=3");
    expect(await run(s, "helm get values my-nginx")).toBe("USER-SUPPLIED VALUES:\nreplicaCount: 3\nservice:\n  type: ClusterIP\n");
    expect(await run(s, "helm history my-nginx")).toMatch(/1\s+.*superseded.*\n2\s+.*deployed/);
    expect(await run(s, "helm rollback my-nginx 1")).toBe("Rollback was a success! Happy Helming!\n");
    s.tick(5000);
    expect(await run(s, "kubectl get deploy my-nginx")).toMatch(/2\/2/);
    expect(await run(s, "helm ls")).toMatch(/my-nginx\s+default\s+3\s+.*deployed\s+nginx-22\.1\.1/);
    expect(await run(s, "kubectl get secrets")).toMatch(/sh\.helm\.release\.v1\.my-nginx\.v3\s+helm\.sh\/release\.v1/);
    expect(await run(s, "helm uninstall my-nginx")).toBe('release "my-nginx" uninstalled\n');
    expect(await err(s, "kubectl get deploy")).toMatch(/No resources found/);
  });

  it("installs into a new namespace and lists across namespaces", async () => {
    const s = sandbox();
    await run(s, "helm repo add bitnami https://charts.bitnami.com/bitnami");
    expect(await err(s, "helm install cache bitnami/redis -n data")).toMatch(/namespaces "data" not found/);
    await run(s, "helm install cache bitnami/redis -n data --create-namespace");
    s.tick(15000);
    expect(await run(s, "kubectl get sts -n data")).toMatch(/cache-redis-master\s+1\/1/);
    expect(await run(s, "helm ls -A")).toMatch(/cache\s+data\s+1/);
    expect(await run(s, "helm ls")).not.toMatch(/cache/);
  });

  it("scaffolds, templates and installs a local chart", async () => {
    const s = sandbox();
    expect(await run(s, "helm create mychart")).toBe("Creating mychart\n");
    expect(await run(s, "helm lint ./mychart")).toMatch(/1 chart\(s\) linted, 0 chart\(s\) failed/);
    expect(await run(s, "helm template t ./mychart --set replicaCount=4")).toMatch(/kind: Deployment\nmetadata:\n  name: t-mychart[\s\S]*replicas: 4/);
    await run(s, "helm install demo ./mychart --set service.type=NodePort");
    s.tick(10000);
    expect(await run(s, "kubectl get svc demo-mychart")).toMatch(/NodePort\s+10\.\d+\.\d+\.\d+\s+<none>\s+80:3\d{4}\/TCP/);
    expect(await run(s, "kubectl get deploy demo-mychart")).toMatch(/1\/1/);
  });
});

describe("Kustomize", () => {
  function layout(s: S) {
    s.fs.writeFile("base/deployment.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: nginx\n        image: nginx:1.27\n        envFrom:\n        - configMapRef:\n            name: web-config\n");
    s.fs.writeFile("base/service.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n  - port: 80\n");
    s.fs.writeFile("base/kustomization.yaml", "resources:\n- deployment.yaml\n- service.yaml\nconfigMapGenerator:\n- name: web-config\n  literals:\n  - MODE=base\n");
    s.fs.writeFile("overlays/prod/kustomization.yaml", "resources:\n- ../../base\nnamespace: prod\nnamePrefix: prod-\ncommonLabels:\n  env: prod\nimages:\n- name: nginx\n  newTag: '1.29'\nreplicas:\n- name: web\n  count: 3\nconfigMapGenerator:\n- name: web-config\n  behavior: merge\n  literals:\n  - MODE=prod\npatches:\n- target:\n    kind: Deployment\n    name: web\n  patch: |-\n    - op: add\n      path: /spec/template/spec/containers/0/resources\n      value:\n        limits:\n          memory: 256Mi\n");
  }

  it("renders an overlay with generators, prefixes, labels, images, replicas and patches", async () => {
    const s = sandbox();
    layout(s);
    const out = await run(s, "kubectl kustomize overlays/prod");
    const cm = out.match(/name: (prod-web-config-[a-z0-9]{10})\n/)![1];
    expect(out.indexOf("kind: ConfigMap")).toBeLessThan(out.indexOf("kind: Service"));
    expect(out.indexOf("kind: Service")).toBeLessThan(out.indexOf("kind: Deployment"));
    expect(out).toContain("MODE: prod");
    expect(out).toContain(`configMapRef:\n            name: ${cm}`);
    expect(out).toMatch(/selector:\n    matchLabels:\n      app: web\n      env: prod/);
    expect(out).toContain("image: nginx:1.29");
    expect(out).toContain("replicas: 3");
    expect(out).toContain("memory: 256Mi");
    expect(out).toContain("namespace: prod");
  });

  it("applies, gets and deletes with -k", async () => {
    const s = sandbox();
    layout(s);
    await run(s, "kubectl create ns prod");
    const applied = await run(s, "kubectl apply -k overlays/prod");
    expect(applied).toMatch(/^configmap\/prod-web-config-[a-z0-9]{10} created\nservice\/prod-web created\ndeployment.apps\/prod-web created\n$/);
    s.tick(10000);
    expect(await run(s, "kubectl get deploy -n prod")).toMatch(/prod-web\s+3\/3/);
    expect(await run(s, "kubectl get -k overlays/prod")).toMatch(/deployment.apps\/prod-web\s+3\/3/);
    expect(await run(s, "kubectl delete -k overlays/prod")).toMatch(/deployment.apps "prod-web" deleted/);
  });

  it("reports a missing kustomization", async () => {
    const s = sandbox();
    s.fs.mkdir("empty");
    expect(await err(s, "kubectl apply -k empty")).toMatch(/unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory/);
  });
});

describe("Image builds", () => {
  it("builds, pushes and runs a custom image in a pod", async () => {
    const s = sandbox();
    s.fs.writeFile("job/Dockerfile", 'FROM busybox:1.36\nWORKDIR /app\nCOPY run.sh .\nENV GREETING=hi\nCMD ["sh", "/app/run.sh"]\n');
    s.fs.writeFile("job/run.sh", 'echo "$GREETING from $(pwd)"\n');
    expect((await s.run("docker build -t greeter:v1 job")).err).toMatch(/naming to docker.io\/library\/greeter:v1/);
    expect(await run(s, "docker images")).toMatch(/greeter\s+v1\s+[0-9a-f]{12}/);
    expect(await run(s, "docker run --rm greeter:v1")).toBe("hi from /app\n");
    expect(await err(s, "docker push greeter:v1")).toMatch(/denied/);
    await run(s, "docker tag greeter:v1 localhost:5000/greeter:v1");
    expect(await run(s, "docker push localhost:5000/greeter:v1")).toMatch(/v1: digest: sha256:[0-9a-f]{64}/);
    await run(s, "kubectl run greeter --image=localhost:5000/greeter:v1 --restart=Never");
    await run(s, "kubectl run missing --image=localhost:5000/missing:v1 --restart=Never");
    s.tick(10000);
    expect(await run(s, "kubectl get pod greeter")).toMatch(/Completed/);
    expect(await run(s, "kubectl logs greeter")).toBe("hi from /app\n");
    expect(await run(s, "kubectl get pod missing")).toMatch(/ImagePullBackOff|ErrImagePull/);
  });

  it("builds with podman and saves an archive", async () => {
    const s = sandbox();
    s.fs.writeFile("app/index.html", "hello from my app\n");
    s.fs.writeFile("app/Dockerfile", "FROM nginx:1.27\nCOPY index.html /usr/share/nginx/html/index.html\n");
    expect(await run(s, "podman build -t localhost:5000/web:1.0 app")).toMatch(/STEP 2\/2: COPY[\s\S]*Successfully tagged localhost:5000\/web:1.0/);
    await run(s, "podman save -o web.tar localhost:5000/web:1.0");
    expect(s.fs.exists("web.tar")).toBe(true);
    await run(s, "podman push localhost:5000/web:1.0");
    await run(s, "kubectl run web --image=localhost:5000/web:1.0 --port=80");
    s.tick(10000);
    expect(await run(s, "kubectl exec web -- cat /usr/share/nginx/html/index.html")).toBe("hello from my app\n");
    expect(await err(s, "podman build -t x nowhere")).toMatch(/context must be a directory/);
  });
});
