import { Cluster } from "../src/cluster.js";
import { MemoryFS } from "../src/fs.js";
import { Shell } from "../src/shell.js";
import type { IO } from "../src/kubectl/index.js";

/** A shell on a cluster with a fake clock. sleep() advances the clock instantly. */
export function sandbox(seed = 42) {
  let now = Date.parse("2026-11-14T10:00:00Z");
  const clock = () => now;
  const cluster = new Cluster({ clock, seed });
  const fs = new MemoryFS();
  const shell = new Shell(cluster, fs);
  const tick = (ms: number) => {
    now += ms;
  };
  async function run(line: string): Promise<{ out: string; err: string; code: number }> {
    let out = "";
    let err = "";
    const io: IO = {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      sleep: async (ms) => tick(ms),
    };
    const code = await shell.exec(line, io);
    return { out, err, code };
  }
  return { cluster, fs, shell, run, tick };
}
