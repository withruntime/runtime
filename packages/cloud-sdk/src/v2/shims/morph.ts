/* withruntime/morph: Morph Cloud's client on Runtime. Change the import from
   "morphcloud" to "withruntime/morph"; RUNTIME_API_KEY replaces MORPH_API_KEY.
   A Morph snapshot is a Runtime snapshot, an instance a sandbox started from one. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, client, run } from "./base.js";

export interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export class Snapshot {
  constructor(readonly id: string) {}
}

export class Instance {
  constructor(private readonly k: Runtime, readonly id: string) {}

  async exec(command: string | string[]): Promise<ExecResponse> {
    const r = await run(this.k, this.id, command);
    return { exit_code: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
  }

  async snapshot(): Promise<Snapshot> {
    return new Snapshot((await this.k.sandboxes.snapshot(this.id)).id);
  }

  async branch(count = 1): Promise<{ snapshot: Snapshot; instances: Instance[] }> {
    const f = await this.k.sandboxes.fork(this.id, { count });
    return { snapshot: new Snapshot(""), instances: f.sandboxes.map((s) => new Instance(this.k, s.id)) };
  }

  async exposeHttpService(name: string, port: number): Promise<{ name: string; port: number; url: string }> {
    const p = await this.k.previews.create(this.id, { port, visibility: "public" });
    return { name, port, url: p.info.url };
  }

  async pause(): Promise<void> {
    await this.k.sandboxes.pause(this.id);
  }

  async resume(): Promise<void> {
    await this.k.sandboxes.resume(this.id);
  }

  async stop(): Promise<void> {
    await this.k.sandboxes.delete(this.id);
  }
}

export class MorphCloudClient {
  readonly snapshots: {
    create(p?: { imageId?: string; vcpus?: number; memory?: number; diskSize?: number }): Promise<Snapshot>;
    get(p: { snapshotId: string }): Promise<Snapshot>;
    delete(p: { snapshotId: string }): Promise<void>;
  };
  readonly instances: {
    start(p: { snapshotId: string }): Promise<Instance>;
    get(p: { instanceId: string }): Promise<Instance>;
    list(): Promise<Instance[]>;
    stop(p: { instanceId: string }): Promise<void>;
  };

  constructor(o: RuntimeOptions = {}) {
    const k = client(o);
    this.snapshots = {
      // A base snapshot: a sandbox of those sizes, kept as a snapshot, then deleted.
      async create(p = {}) {
        const s = await k.sandboxes.create({
          ...(p.imageId ? { image: p.imageId } : {}),
          ...(p.vcpus ? { vcpu: p.vcpus } : {}),
          ...(p.memory ? { memoryGB: p.memory / 1024 } : {}),
          ...(p.diskSize ? { diskGB: p.diskSize / 1024 } : {}),
        });
        try {
          return new Snapshot((await k.sandboxes.snapshot(s.id)).id);
        } finally {
          await k.sandboxes.delete(s.id);
        }
      },
      async get(p) {
        return new Snapshot((await k.snapshots.get(p.snapshotId)).id);
      },
      async delete(p) {
        await k.snapshots.delete(p.snapshotId);
      },
    };
    this.instances = {
      async start(p) {
        return new Instance(k, (await k.sandboxes.create({ snapshot: p.snapshotId })).id);
      },
      async get(p) {
        return new Instance(k, (await k.sandboxes.get(p.instanceId)).id);
      },
      async list() {
        return (await k.sandboxes.list()).items.map((s) => new Instance(k, s.id));
      },
      async stop(p) {
        await k.sandboxes.delete(p.instanceId);
      },
    };
  }
}

export default MorphCloudClient;
