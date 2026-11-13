import type { Cluster } from "../cluster.js";
import { isoTime, parseMemory } from "../util.js";

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

/**
 * The simulated cluster has one storage class, "standard", which binds
 * claims immediately. Claims asking for any other class stay Pending.
 */
export function reconcileVolumeClaims(cluster: Cluster, t: number): void {
  for (const pvc of cluster.list("PersistentVolumeClaim")) {
    if (pvc.status?.phase === "Bound") continue;
    const sc = pvc.spec?.storageClassName ?? "standard";
    if (sc === "standard") {
      pvc.spec = { ...(pvc.spec ?? {}), storageClassName: "standard", volumeName: `pvc-${pvc.metadata.uid}`, volumeMode: pvc.spec?.volumeMode ?? "Filesystem" };
      const req = pvc.spec.resources?.requests?.storage ?? "1Gi";
      pvc.status = { phase: "Bound", accessModes: pvc.spec.accessModes ?? ["ReadWriteOnce"], capacity: { storage: Number.isNaN(parseMemory(req)) ? "1Gi" : req } };
      cluster.recordEvent(pvc, "Normal", "ProvisioningSucceeded", `Successfully provisioned volume pvc-${pvc.metadata.uid}`, { component: "rancher.io/local-path" }, t);
      cluster.put(pvc);
    } else {
      cluster.recordEvent(pvc, "Warning", "ProvisioningFailed", `storageclass.storage.k8s.io "${sc}" not found`, { component: "persistentvolume-controller" }, t, 15000);
    }
  }
}
