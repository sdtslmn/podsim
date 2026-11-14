// Real files, kept inside one work folder so the simulator never touches
// anything else on the learner's machine.

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileSystem } from "@podsim/core";

export class NodeFS implements FileSystem {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private resolve(p: string): string {
    const full = path.resolve(this.root, p.replace(/^~\//, ""));
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`${p}: outside the podsim work folder (${this.root})`);
    }
    return full;
  }

  readFile(p: string): string {
    return fs.readFileSync(this.resolve(p), "utf8");
  }
  writeFile(p: string, content: string): void {
    const full = this.resolve(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  appendFile(p: string, content: string): void {
    const full = this.resolve(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, content, "utf8");
  }
  exists(p: string): boolean {
    try {
      return fs.existsSync(this.resolve(p));
    } catch {
      return false;
    }
  }
  isDirectory(p: string): boolean {
    try {
      return fs.statSync(this.resolve(p)).isDirectory();
    } catch {
      return false;
    }
  }
  list(p: string): string[] {
    return fs
      .readdirSync(this.resolve(p))
      .filter((n) => !n.startsWith("."))
      .sort();
  }
  remove(p: string): void {
    fs.rmSync(this.resolve(p), { force: true, recursive: true });
  }
  mkdir(p: string): void {
    fs.mkdirSync(this.resolve(p), { recursive: true });
  }
  cwd(): string {
    return this.root;
  }
  /** Absolute path, for opening a file in the learner's editor. */
  absolute(p: string): string {
    return this.resolve(p);
  }
}
