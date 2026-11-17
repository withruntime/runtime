/* withruntime/vercel: Vercel Sandbox on Runtime. Change the import from
   "@vercel/sandbox" to "withruntime/vercel"; RUNTIME_API_KEY replaces the OIDC token. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, bytes, client, run } from "./base.js";

export class CommandFinished {
  constructor(readonly exitCode: number, private readonly out: string, private readonly err: string) {}
  async stdout(): Promise<string> {
    return this.out;
  }
  async stderr(): Promise<string> {
    return this.err;
  }
  async output(): Promise<string> {
    return this.out + this.err;
  }
}

/** Where Vercel's runCommand writes output as it is written: a Node Writable, or anything with write(). */
export interface Sink {
  write(chunk: string): unknown;
}

export interface RunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  /** Each piece of standard output as it is written. */
  stdout?: Sink;
  /** Each piece of standard error as it is written. */
  stderr?: Sink;
}

export class Sandbox {
  private constructor(private readonly k: Runtime, readonly sandboxId: string) {}

  static async create(params: RuntimeOptions & { timeout?: number; resources?: { vcpus?: number }; source?: unknown } = {}): Promise<Sandbox> {
    const k = client(params);
    const s = await k.sandboxes.create({
      ...(params.resources?.vcpus ? { vcpu: params.resources.vcpus } : {}),
      ...(params.timeout ? { timeoutSeconds: Math.ceil(params.timeout / 1000) } : {}),
    });
    return new Sandbox(k, s.id);
  }

  static async get(params: RuntimeOptions & { sandboxId: string }): Promise<Sandbox> {
    const k = client(params);
    return new Sandbox(k, (await k.sandboxes.get(params.sandboxId)).id);
  }

  async runCommand(cmdOrParams: string | RunCommandParams, args: string[] = []): Promise<CommandFinished> {
    const p = typeof cmdOrParams === "string" ? { cmd: cmdOrParams, args } : cmdOrParams;
    const argv = [...(p.sudo ? ["sudo"] : []), p.cmd, ...(p.args ?? [])];
    if (!p.stdout && !p.stderr) {
      const r = await run(this.k, this.sandboxId, argv, { cwd: p.cwd, env: p.env });
      return new CommandFinished(r.exitCode ?? -1, r.stdout, r.stderr);
    }
    // Output asked for as it is written: the core's stream, each chunk passed on as it arrives.
    const sbx = await this.k.sandboxes.get(this.sandboxId);
    const stream = sbx.execStream(argv, { ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.env ? { env: p.env } : {}) });
    let out = "";
    let err = "";
    for await (const c of stream) {
      if (c.stream === "stderr") {
        err += c.text;
        p.stderr?.write(c.text);
      } else {
        out += c.text;
        p.stdout?.write(c.text);
      }
    }
    return new CommandFinished((await stream.wait()).exitCode ?? -1, out, err);
  }

  async writeFiles(files: { path: string; content: Uint8Array | string }[]): Promise<void> {
    for (const f of files) await this.k.sandboxes.write(this.sandboxId, bytes(f.content), { path: f.path });
  }

  async readFile(params: { path: string }): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const b = await this.k.sandboxes.read(this.sandboxId, { path: params.path });
      return new ReadableStream({ start: (c) => (c.enqueue(b), c.close()) });
    } catch {
      return null;
    }
  }

  async mkDir(path: string): Promise<void> {
    await run(this.k, this.sandboxId, ["mkdir", "-p", path]);
  }

  /** The address a port is served at: a preview of it. */
  async domain(port: number): Promise<string> {
    return (await this.k.previews.create(this.sandboxId, { port, visibility: "public" })).info.url;
  }

  async stop(): Promise<void> {
    await this.k.sandboxes.delete(this.sandboxId);
  }
}

export default Sandbox;
