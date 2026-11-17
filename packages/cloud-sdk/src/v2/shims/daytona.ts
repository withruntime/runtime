/* withruntime/daytona: Daytona's client on Runtime. Change the import from
   "@daytonaio/sdk" to "withruntime/daytona"; RUNTIME_API_KEY replaces DAYTONA_API_KEY. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, bytes, client, list, run, text } from "./base.js";

export interface ExecuteResponse {
  exitCode: number;
  result: string;
  artifacts: { stdout: string };
}

export interface CreateSandboxParams {
  image?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  resources?: { cpu?: number; memory?: number; disk?: number };
  autoStopInterval?: number;
}

export class Sandbox {
  readonly process: { executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<ExecuteResponse> };
  readonly fs: {
    uploadFile(file: Uint8Array | string, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Uint8Array>;
    listFiles(path: string): Promise<{ name: string; isDir: boolean; size: number; modTime: string }[]>;
    deleteFile(path: string): Promise<void>;
    createFolder(path: string, mode?: string): Promise<void>;
  };

  constructor(private readonly k: Runtime, readonly id: string, envVars: Record<string, string> = {}) {
    this.process = {
      async executeCommand(command, cwd, env, timeout) {
        const r = await run(k, id, command, { cwd, env: { ...envVars, ...env }, timeoutMs: timeout ? timeout * 1000 : undefined });
        const result = r.stdout + r.stderr;
        return { exitCode: r.exitCode ?? -1, result, artifacts: { stdout: result } };
      },
    };
    this.fs = {
      async uploadFile(file, remotePath) {
        await k.sandboxes.write(id, bytes(file), { path: remotePath });
      },
      downloadFile: (remotePath) => k.sandboxes.read(id, { path: remotePath }),
      async listFiles(path) {
        return (await list(k, id, path)).map((e) => ({ name: e.name, isDir: e.type === "dir", size: e.size, modTime: e.modifiedTime.toISOString() }));
      },
      async deleteFile(path) {
        await k.sandboxes.remove(id, { path, recursive: true });
      },
      async createFolder(path, mode) {
        await run(k, id, ["mkdir", "-p", ...(mode ? ["-m", mode] : []), path]);
      },
    };
  }

  async getPreviewLink(port: number): Promise<{ url: string; token: string }> {
    const p = await this.k.previews.create(this.id, { port });
    return { url: p.info.url, token: p.info.token ?? "" };
  }

  async start(): Promise<void> {
    await this.k.sandboxes.resume(this.id);
  }

  async stop(): Promise<void> {
    await this.k.sandboxes.pause(this.id);
  }

  async delete(): Promise<void> {
    await this.k.sandboxes.delete(this.id);
  }
}

export class Daytona {
  readonly #k: Runtime;
  constructor(config: RuntimeOptions & { apiUrl?: string } = {}) {
    this.#k = client(config);
  }

  async create(params: CreateSandboxParams = {}): Promise<Sandbox> {
    const s = await this.#k.sandboxes.create({
      ...(params.image ? { image: params.image } : {}),
      ...(params.labels ? { labels: params.labels } : {}),
      ...(params.resources?.cpu ? { vcpu: params.resources.cpu } : {}),
      ...(params.resources?.memory ? { memoryMiB: params.resources.memory * 1024 } : {}),
      ...(params.resources?.disk ? { diskMiB: params.resources.disk * 1024 } : {}),
    });
    return new Sandbox(this.#k, s.id, params.envVars);
  }

  async get(id: string): Promise<Sandbox> {
    return new Sandbox(this.#k, (await this.#k.sandboxes.get(id)).id);
  }

  async list(): Promise<Sandbox[]> {
    return (await this.#k.sandboxes.list()).items.map((s) => new Sandbox(this.#k, s.id));
  }

  async delete(sandbox: Sandbox): Promise<void> {
    await sandbox.delete();
  }
}

export default Daytona;
