// Loading manifests from files, folders and stdin.

import { parseAllDocuments } from "yaml";
import type { FileSystem } from "../fs.js";
import type { KObject } from "../types.js";
import { KubeError } from "../types.js";

export interface LoadedObject {
  obj: KObject;
  source: string;
}

export function parseManifests(text: string, source: string): LoadedObject[] {
  const out: LoadedObject[] = [];
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      const e = doc.errors[0];
      const line = e.linePos?.[0]?.line;
      const msg = e.message.split("\n")[0];
      throw new KubeError(`error: error parsing ${source}: error converting YAML to JSON: yaml: ${line ? `line ${line}: ` : ""}${msg}`);
    }
    const value = doc.toJS({ maxAliasCount: 50 });
    if (value === null || value === undefined) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new KubeError(`error: error validating "${source}": error validating data: invalid object to validate`);
    }
    if (value.kind === "List" && Array.isArray(value.items)) {
      for (const item of value.items) out.push({ obj: item as KObject, source });
      continue;
    }
    const missing: string[] = [];
    if (!value.apiVersion) missing.push("apiVersion not set");
    if (!value.kind) missing.push("kind not set");
    if (missing.length) {
      throw new KubeError(`error: error validating "${source}": error validating data: [${missing.join(", ")}]; if you choose to ignore these errors, turn validation off with --validate=false`);
    }
    out.push({ obj: value as KObject, source });
  }
  return out;
}

/** Load every manifest named by -f (files, folders, "-" for stdin). */
export function loadFiles(fs: FileSystem, names: string[], stdin: string | undefined, recursive: boolean): LoadedObject[] {
  const out: LoadedObject[] = [];
  for (const name of names) {
    if (name === "-") {
      if (stdin === undefined) throw new KubeError("error: no objects passed to apply");
      out.push(...parseManifests(stdin, "STDIN"));
      continue;
    }
    if (/^https?:\/\//.test(name)) {
      throw new KubeError(`error: unable to read URL "${name}": (k8s-sim) the simulator has no internet access. Save the manifest to a local file and use -f with that file.`);
    }
    if (!fs.exists(name)) throw new KubeError(`error: the path "${name}" does not exist`);
    if (fs.isDirectory(name)) {
      const walk = (dir: string, depth: number) => {
        for (const entry of fs.list(dir)) {
          const p = `${dir.replace(/\/$/, "")}/${entry}`;
          if (fs.isDirectory(p)) {
            if (recursive && depth < 10) walk(p, depth + 1);
          } else if (/\.(ya?ml|json)$/i.test(entry)) {
            out.push(...parseManifests(fs.readFile(p), p));
          }
        }
      };
      walk(name, 0);
      continue;
    }
    out.push(...parseManifests(fs.readFile(name), name));
  }
  if (out.length === 0) throw new KubeError("error: no objects passed to apply");
  return out;
}
