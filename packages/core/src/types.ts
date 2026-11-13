// Kubernetes objects are kept close to their real JSON shape so that
// `kubectl get -o yaml` output looks like the real thing. Fields we do not
// model are simply carried through.

import type { Labels } from "./util.js";

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Labels;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  generateName?: string;
  [key: string]: unknown;
}

export interface KObject {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status?: any;
  [key: string]: unknown;
}

export interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  ports?: { containerPort: number; name?: string; protocol?: string }[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  imagePullPolicy?: string;
  [key: string]: unknown;
}

/** Result of running one command in the simulator. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class KubeError extends Error {
  constructor(message: string, public exitCode = 1) {
    super(message);
  }
}
