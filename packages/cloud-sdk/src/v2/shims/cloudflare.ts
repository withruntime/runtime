/* withruntime/cloudflare: Cloudflare's Sandbox SDK on Runtime, in a Worker. Change
   the import from "@cloudflare/sandbox" to "withruntime/cloudflare", delete the
   wrangler `containers` block and add a RUNTIME_API_KEY secret. getSandbox's id
   names the sandbox: the same id is the same sandbox. */

import type { Runtime } from "../../generated/index.js";
import { type RuntimeOptions, bytes, client, run, text } from "./base.js";

export interface ExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class RuntimeSandbox {
  #id: Promise<string> | undefined;
  constructor(private readonly k: Runtime, private readonly name: string) {}

  private id(): Promise<string> {
    this.#id ??= this.k.sandboxes.create({ name: this.name, getOrCreate: true }).then((s) => s.id);
    return this.#id;
  }

  async exec(command: string, o: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): Promise<ExecResult> {
    const r = await run(this.k, await this.id(), command, { cwd: o.cwd, env: o.env, timeoutMs: o.timeout });
    const exitCode = r.exitCode ?? -1;
    return { success: exitCode === 0, exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  async writeFile(path: string, content: string, o: { encoding?: "base64" | "utf-8" } = {}): Promise<{ success: boolean; path: string }> {
    const data = o.encoding === "base64" ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : bytes(content);
    await this.k.sandboxes.write(await this.id(), data, { path });
    return { success: true, path };
  }

  async readFile(path: string): Promise<{ success: boolean; path: string; content: string }> {
    return { success: true, path, content: text(await this.k.sandboxes.read(await this.id(), { path })) };
  }

  async mkdir(path: string): Promise<{ success: boolean }> {
    return { success: (await run(this.k, await this.id(), ["mkdir", "-p", path])).exitCode === 0 };
  }

  async deleteFile(path: string): Promise<{ success: boolean }> {
    await this.k.sandboxes.remove(await this.id(), { path });
    return { success: true };
  }

  async exposePort(port: number): Promise<{ url: string; port: number }> {
    const p = await this.k.previews.create(await this.id(), { port, visibility: "public" });
    return { url: p.info.url, port };
  }

  async destroy(): Promise<void> {
    await this.k.sandboxes.delete(await this.id());
  }
}

/** The binding argument is the Worker's old Sandbox namespace and is not used: the
 * key is `options.apiKey`, else the RUNTIME_API_KEY secret. */
export function getSandbox(binding: unknown, id: string, options: RuntimeOptions & { env?: { RUNTIME_API_KEY?: string } } = {}): RuntimeSandbox {
  const fromBinding = (binding as { RUNTIME_API_KEY?: string } | undefined)?.RUNTIME_API_KEY;
  const apiKey = options.apiKey ?? options.env?.RUNTIME_API_KEY ?? fromBinding;
  return new RuntimeSandbox(client({ ...options, ...(apiKey ? { apiKey } : {}) }), id);
}

/** Kept so `export { Sandbox } from "@cloudflare/sandbox"` in a Worker still resolves. */
export class Sandbox {}
