import type { Cluster } from "../cluster.js";
import { isoTime, parseMemory } from "../util.js";
import type { KObject } from "../types.js";
import { quotaUsage } from "../admission.js";

const ROOT_CA = "-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIk8sim0k8sim0wDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\nAxMKa3ViZXJuZXRlczAeFw0yNjAxMDEwMDAwMDBaFw0zNjAxMDEwMDAwMDBaMBUx\n...simulated certificate, not a real key...\n-----END CERTIFICATE-----\n";

/** Every namespace gets a default ServiceAccount and the kube-root-ca.crt ConfigMap. */
export function reconcileNamespaces(cluster: Cluster, t: number): void {
  for (const ns of cluster.list("Namespace")) {
    const name = ns.metadata.name;
    if (!cluster.get("ServiceAccount", "default", name)) {
      cluster.put({
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: "default", namespace: name, uid: cluster.random.uid(), creationTimestamp: isoTime(t) },
      });
    }
    if (!cluster.get("ConfigMap", "kube-root-ca.crt", name)) {
      cluster.put({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "kube-root-ca.crt",
          namespace: name,
          uid: cluster.random.uid(),
          creationTimestamp: isoTime(t),
          annotations: { "kubernetes.io/description": "Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters." },
        },
        data: { "ca.crt": ROOT_CA },
      });
    }
  }
}

function storageBytes(q: unknown): number {
  const v = parseMemory(String(q ?? "0"));
  return Number.isNaN(v) ? 0 : v;
}

function defaultClass(cluster: Cluster): KObject | undefined {
  return cluster.list("StorageClass").find((c) => c.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true");
}

function bind(cluster: Cluster, pvc: KObject, pv: KObject, t: number): void {
  pv.spec.claimRef = { apiVersion: "v1", kind: "PersistentVolumeClaim", name: pvc.metadata.name, namespace: pvc.metadata.namespace, uid: pvc.metadata.uid, resourceVersion: pvc.metadata.resourceVersion };
  pv.status = { phase: "Bound", lastPhaseTransitionTime: isoTime(t) };
  pv.metadata.annotations = { ...(pv.metadata.annotations ?? {}), "pv.kubernetes.io/bound-by-controller": "yes" };
  cluster.put(pv);
  pvc.spec = { ...(pvc.spec ?? {}), volumeName: pv.metadata.name, volumeMode: pvc.spec?.volumeMode ?? "Filesystem" };
  pvc.metadata.annotations = { ...(pvc.metadata.annotations ?? {}), "pv.kubernetes.io/bind-completed": "yes", "pv.kubernetes.io/bound-by-controller": "yes" };
  pvc.status = { phase: "Bound", accessModes: pv.spec.accessModes ?? ["ReadWriteOnce"], capacity: { storage: pv.spec.capacity?.storage ?? "1Gi" } };
  cluster.put(pvc);
}

/**
 * PersistentVolume controller: binds claims to matching volumes, provisions
 * volumes for classes with a provisioner (the default "standard" class), and
 * releases or deletes volumes when their claim goes away.
 */
export function reconcileVolumeClaims(cluster: Cluster, t: number): void {
  const pvs = cluster.list("PersistentVolume");
  // Release volumes whose claim is gone.
  for (const pv of pvs) {
    const ref = pv.spec?.claimRef;
    if (!ref || pv.status?.phase !== "Bound") continue;
    const claim = cluster.get("PersistentVolumeClaim", ref.name, ref.namespace);
    if (claim && claim.metadata.uid === ref.uid) continue;
    if ((pv.spec.persistentVolumeReclaimPolicy ?? "Retain") === "Delete") {
      cluster.remove("PersistentVolume", pv.metadata.name);
      cluster.scratch.delete(`pv/${pv.metadata.name}`);
    } else {
      pv.status = { phase: "Released", lastPhaseTransitionTime: isoTime(t) };
      cluster.put(pv);
    }
  }
  for (const pvc of cluster.list("PersistentVolumeClaim")) {
    if (pvc.status?.phase === "Bound") continue;
    pvc.spec = pvc.spec ?? {};
    let sc: string | undefined = pvc.spec.storageClassName;
    if (sc === undefined) {
      const def = defaultClass(cluster);
      if (def) {
        sc = def.metadata.name;
        pvc.spec.storageClassName = sc;
        cluster.put(pvc);
      }
    }
    const want = storageBytes(pvc.spec.resources?.requests?.storage);
    const modes: string[] = pvc.spec.accessModes ?? [];
    const sel = pvc.spec.selector?.matchLabels as Record<string, string> | undefined;
    const candidates = cluster
      .list("PersistentVolume")
      .filter((pv) => (pv.status?.phase ?? "Available") === "Available" && !pv.spec?.claimRef)
      .filter((pv) => (pv.spec?.storageClassName ?? "") === (sc ?? ""))
      .filter((pv) => !pvc.spec.volumeName || pv.metadata.name === pvc.spec.volumeName)
      .filter((pv) => modes.every((m) => (pv.spec?.accessModes ?? []).includes(m)))
      .filter((pv) => storageBytes(pv.spec?.capacity?.storage) >= want)
      .filter((pv) => !sel || Object.entries(sel).every(([k, v]) => pv.metadata.labels?.[k] === v))
      .sort((a, b) => storageBytes(a.spec?.capacity?.storage) - storageBytes(b.spec?.capacity?.storage));
    if (candidates[0]) {
      bind(cluster, pvc, candidates[0], t);
      continue;
    }
    const cls = sc ? cluster.get("StorageClass", sc) : undefined;
    if (cls && cls.provisioner && cls.provisioner !== "kubernetes.io/no-provisioner" && !pvc.spec.volumeName) {
      if (cls.volumeBindingMode === "WaitForFirstConsumer" && !cluster.list("Pod", pvc.metadata.namespace).some((p) => (p.spec?.volumes ?? []).some((v: { persistentVolumeClaim?: { claimName: string } }) => v.persistentVolumeClaim?.claimName === pvc.metadata.name))) {
        cluster.recordEvent(pvc, "Normal", "WaitForFirstConsumer", "waiting for first consumer to be created before binding", { component: "persistentvolume-controller" }, t, 60000);
        continue;
      }
      const name = `pvc-${pvc.metadata.uid}`;
      const pv = cluster.create(
        {
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: { name, annotations: { "pv.kubernetes.io/provisioned-by": String(cls.provisioner) } },
          spec: {
            accessModes: modes.length ? modes : ["ReadWriteOnce"],
            capacity: { storage: pvc.spec.resources?.requests?.storage ?? "1Gi" },
            persistentVolumeReclaimPolicy: (cls.reclaimPolicy as string) ?? "Delete",
            storageClassName: sc,
            volumeMode: pvc.spec.volumeMode ?? "Filesystem",
            hostPath: { path: `/var/local-path-provisioner/${name}_${pvc.metadata.namespace}_${pvc.metadata.name}`, type: "DirectoryOrCreate" },
          },
        },
        { at: t },
      );
      cluster.recordEvent(pvc, "Normal", "Provisioning", `External provisioner is provisioning volume for claim "${pvc.metadata.namespace}/${pvc.metadata.name}"`, { component: `${cls.provisioner}_local-path-provisioner` }, t);
      cluster.recordEvent(pvc, "Normal", "ProvisioningSucceeded", `Successfully provisioned volume ${name}`, { component: `${cls.provisioner}_local-path-provisioner` }, t);
      bind(cluster, pvc, pv, t);
      continue;
    }
    if (sc && !cls && !cluster.list("PersistentVolume").some((pv) => pv.spec?.storageClassName === sc)) {
      cluster.recordEvent(pvc, "Warning", "ProvisioningFailed", `storageclass.storage.k8s.io "${sc}" not found`, { component: "persistentvolume-controller" }, t, 15000);
    } else {
      cluster.recordEvent(pvc, "Normal", "FailedBinding", sc ? "no persistent volumes available for this claim and no storage class is set" : "no persistent volumes available for this claim and no storage class is set", { component: "persistentvolume-controller" }, t, 15000);
    }
  }
}

/** Keep ResourceQuota status (hard and used) current. */
export function reconcileQuotas(cluster: Cluster): void {
  for (const q of cluster.list("ResourceQuota")) {
    const hard = (q.spec?.hard ?? {}) as Record<string, string>;
    const status = { hard: { ...hard }, used: quotaUsage(cluster, q.metadata.namespace!, hard) };
    if (JSON.stringify(status) !== JSON.stringify(q.status)) {
      q.status = status;
      cluster.put(q);
    }
  }
}
