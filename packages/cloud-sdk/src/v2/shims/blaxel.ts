/* withruntime/blaxel: Blaxel's SandboxInstance on Runtime. Change the import from
   "@blaxel/core" to "withruntime/blaxel"; RUNTIME_API_KEY replaces BL_API_KEY. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, bytes, client, list, run, text } from "./base.js";

export interface ProcessResult {
  name: string;
  exitCode: number;
  status: "completed" | "failed";
  stdout: string;
  stderr: string;
  logs: string;
}

export class SandboxInstance {
  readonly process: { exec(p: { command: string; name?: string; workingDir?: string; env?: Record<string, string>; waitForCompletion?: boolean; timeout?: number }): Promise<ProcessResult> };
  readonly fs: {
    write(path: string, content: string | Uint8Array): Promise<void>;
    read(path: string): Promise<string>;
    ls(path: string): Promise<{ files: { name: string; path: string; size: number }[]; subdirectories: { name: string; path: string }[] }>;
    rm(path: string, recursive?: boolean): Promise<void>;
    mkdir(path: string): Promise<void>;
  };

  private constructor(private readonly k: Runtime, readonly id: string, readonly metadata: { name: string }) {
    this.process = {
      async exec(p) {
        const r = await run(k, id, p.command, { cwd: p.workingDir, env: p.env, timeoutMs: p.timeout ? p.timeout * 1000 : undefined });
        const exitCode = r.exitCode ?? -1;
        return { name: p.name ?? "", exitCode, status: exitCode === 0 ? "completed" : "failed", stdout: r.stdout, stderr: r.stderr, logs: r.stdout + r.stderr };
      },
    };
    this.fs = {
      async write(path, content) {
        await k.sandboxes.write(id, bytes(content), { path });
      },
      async read(path) {
        return text(await k.sandboxes.read(id, { path }));
      },
      async ls(path) {
        const all = await list(k, id, path);
        return {
          files: all.filter((e) => e.type === "file").map((e) => ({ name: e.name, path: e.path, size: e.size })),
          subdirectories: all.filter((e) => e.type === "dir").map((e) => ({ name: e.name, path: e.path })),
        };
      },
      async rm(path, recursive = false) {
        await k.sandboxes.remove(id, { path, recursive });
      },
      async mkdir(path) {
        await run(k, id, ["mkdir", "-p", path]);
      },
    };
  }

  /** Blaxel names a sandbox; the name finds it again. */
  static async create(p: RuntimeOptions & { name?: string; image?: string; memory?: number; labels?: Record<string, string> } = {}): Promise<SandboxInstance> {
    const k = client(p);
    const s = await k.sandboxes.create({
      ...(p.name ? { name: p.name } : {}),
      ...(p.image ? { image: p.image } : {}),
      ...(p.memory ? { memoryGB: p.memory / 1024 } : {}),
      ...(p.labels ? { labels: p.labels } : {}),
    });
    return new SandboxInstance(k, s.id, { name: s.info.name ?? s.id });
  }

  static async createIfNotExists(p: RuntimeOptions & { name: string; image?: string; memory?: number }): Promise<SandboxInstance> {
    const k = client(p);
    const s = await k.sandboxes.create({ name: p.name, getOrCreate: true, ...(p.image ? { image: p.image } : {}), ...(p.memory ? { memoryGB: p.memory / 1024 } : {}) });
    return new SandboxInstance(k, s.id, { name: s.info.name ?? s.id });
  }

  static async get(nameOrId: string, o: RuntimeOptions = {}): Promise<SandboxInstance> {
    const k = client(o);
    const s = await k.sandboxes.create({ name: nameOrId, getOrCreate: true }).catch(() => k.sandboxes.get(nameOrId));
    return new SandboxInstance(k, s.id, { name: s.info.name ?? s.id });
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.k.previews.create(this.id, { port, visibility: "public" })).info.url;
  }

  async delete(): Promise<void> {
    await this.k.sandboxes.delete(this.id);
  }
}

export default SandboxInstance;
