/* withruntime/modal: Modal Sandboxes on Runtime. Change the import from "modal" to
   "withruntime/modal"; RUNTIME_API_KEY replaces MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.
   An app is a label; an image is a Runtime image by name. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, client, run } from "./base.js";

export class App {
  constructor(readonly name: string) {}
}

export class Image {
  constructor(readonly tag: string) {}
}

class Stream {
  constructor(private readonly t: string) {}
  async readText(): Promise<string> {
    return this.t;
  }
}

export class ContainerProcess {
  readonly stdout: Stream;
  readonly stderr: Stream;
  constructor(private readonly code: number, out: string, err: string) {
    this.stdout = new Stream(out);
    this.stderr = new Stream(err);
  }
  async wait(): Promise<number> {
    return this.code;
  }
}

export class Sandbox {
  constructor(private readonly k: Runtime, readonly sandboxId: string) {}

  async exec(command: string[], o: { workdir?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ContainerProcess> {
    const r = await run(this.k, this.sandboxId, command, { cwd: o.workdir, env: o.env, timeoutMs: o.timeoutMs });
    return new ContainerProcess(r.exitCode ?? -1, r.stdout, r.stderr);
  }

  async terminate(): Promise<void> {
    await this.k.sandboxes.delete(this.sandboxId);
  }
}

export class ModalClient {
  readonly apps: { fromName(name: string, o?: { createIfMissing?: boolean }): Promise<App> };
  readonly images: { fromRegistry(tag: string): Image };
  readonly sandboxes: {
    create(app: App, image: Image, o?: { cpu?: number; memoryMiB?: number; timeoutMs?: number; env?: Record<string, string> }): Promise<Sandbox>;
    fromId(id: string): Promise<Sandbox>;
  };

  constructor(o: RuntimeOptions = {}) {
    const k = client(o);
    this.apps = { fromName: async (name) => new App(name) };
    this.images = { fromRegistry: (tag) => new Image(tag) };
    this.sandboxes = {
      async create(app, image, c = {}) {
        const s = await k.sandboxes.create({
          image: image.tag,
          labels: { "modal-app": app.name },
          ...(c.cpu ? { vcpu: Math.max(1, Math.ceil(c.cpu)) } : {}),
          // Modal's memory is MiB; a sandbox has no time limit, so its timeout is taken and does nothing.
          ...(c.memoryMiB ? { memoryGB: c.memoryMiB / 1024 } : {}),
        });
        return new Sandbox(k, s.id);
      },
      async fromId(id) {
        return new Sandbox(k, (await k.sandboxes.get(id)).id);
      },
    };
  }
}

export default ModalClient;
