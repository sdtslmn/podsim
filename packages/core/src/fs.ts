// File system abstraction so the same shell works in Node (real files in a
// work folder) and in the browser (in-memory files).

export interface FileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  appendFile(path: string, content: string): void;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  list(path: string): string[];
  remove(path: string): void;
  mkdir(path: string): void;
  /** Display name of the working folder, e.g. for `pwd`. */
  cwd(): string;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, "/").split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

/** In-memory file system for the browser and for tests. */
export class MemoryFS implements FileSystem {
  private files = new Map<string, string>();
  constructor(initial: Record<string, string> = {}, private root = "/root") {
    for (const [k, v] of Object.entries(initial)) this.files.set(normalize(k), v);
  }
  readFile(path: string): string {
    const v = this.files.get(normalize(path));
    if (v === undefined) throw new Error(`${path}: No such file or directory`);
    return v;
  }
  writeFile(path: string, content: string): void {
    this.files.set(normalize(path), content);
  }
  appendFile(path: string, content: string): void {
    const p = normalize(path);
    this.files.set(p, (this.files.get(p) ?? "") + content);
  }
  exists(path: string): boolean {
    const p = normalize(path);
    return this.files.has(p) || this.isDirectory(path);
  }
  isDirectory(path: string): boolean {
    const p = normalize(path);
    if (p === "") return true;
    for (const k of this.files.keys()) if (k.startsWith(p + "/")) return true;
    return false;
  }
  list(path: string): string[] {
    const p = normalize(path);
    const prefix = p ? p + "/" : "";
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split("/")[0]);
    }
    return [...out].sort();
  }
  remove(path: string): void {
    this.files.delete(normalize(path));
  }
  mkdir(path: string): void {
    // Folders are implicit in the in-memory file system; keep a marker so `ls` shows it.
    const p = normalize(path);
    if (p && !this.isDirectory(p)) this.files.set(p + "/.keep", "");
  }
  cwd(): string {
    return this.root;
  }
}
