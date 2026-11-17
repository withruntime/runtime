/* withruntime/e2b: E2B's Sandbox on Runtime. Change the import from "e2b" (or
   "@e2b/code-interpreter") to "withruntime/e2b"; RUNTIME_API_KEY replaces E2B_API_KEY.
   Every call is the generated core's: the handle's exec, its files, and execStream
   for output as it is written. */

import type { OutputChunk, Process, Runtime, SandboxInfo, Sandbox as Handle } from "../../generated/index.js";
import { type RuntimeOptions, base64, bytes, client, list, shell, text } from "./base.js";

export interface SandboxOpts extends RuntimeOptions {
  /** Milliseconds it lives; E2B's default is 300000. */
  timeoutMs?: number;
  metadata?: Record<string, string>;
  envs?: Record<string, string>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface CommandOpts {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  /** Called with each piece of standard output as it is written. */
  onStdout?: (data: string) => void;
  /** Called with each piece of standard error as it is written. */
  onStderr?: (data: string) => void;
  /** Returns at once with a handle to the running command. */
  background?: boolean;
  stdin?: boolean;
}

/** E2B throws this for a command that exits non-zero. */
export class CommandExitError extends Error implements CommandResult {
  constructor(readonly stdout: string, readonly stderr: string, readonly exitCode: number) {
    super(`Command exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
    this.name = "CommandExitError";
  }
}

export interface EntryInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedTime: Date;
}

/** A command running in the background: E2B's CommandHandle. */
export class CommandHandle {
  #done: Promise<CommandResult>;
  constructor(
    readonly pid: string,
    done: Promise<CommandResult>,
    private readonly kill_: () => Promise<boolean>,
    private readonly input: (data: string) => Promise<void>,
  ) {
    this.#done = done;
  }
  /** Waits for it to end; throws CommandExitError for a non-zero exit, as E2B does. */
  wait(): Promise<CommandResult> {
    return this.#done;
  }
  kill(): Promise<boolean> {
    return this.kill_();
  }
  sendStdin(data: string): Promise<void> {
    return this.input(data);
  }
}

/** One run of runCode: E2B's Execution, its output as text and lines. */
export interface Execution {
  text: string | undefined;
  results: { text: string }[];
  logs: { stdout: string[]; stderr: string[] };
  error: { name: string; value: string; traceback: string } | undefined;
}

export interface SandboxInfoE2B {
  sandboxId: string;
  templateId: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: Date;
  state: "running" | "paused";
}

const e2bInfo = (s: SandboxInfo): SandboxInfoE2B => ({
  sandboxId: s.id,
  templateId: s.image ?? "default",
  ...(s.name ? { name: s.name } : {}),
  metadata: s.labels,
  startedAt: new Date(s.createdAt ?? 0),
  state: s.state === "paused" ? "paused" : "running",
});

/** Sandbox.list's pages: E2B's SandboxPaginator. */
export class SandboxPaginator {
  #next: string | undefined;
  #started = false;
  constructor(private readonly o: SandboxOpts & { limit?: number }) {}
  get hasNext(): boolean {
    return !this.#started || this.#next !== undefined;
  }
  async nextItems(): Promise<SandboxInfoE2B[]> {
    const page = await client(this.o).sandboxes.list({
      ...(this.o.limit ? { limit: this.o.limit } : {}),
      ...(this.#next ? { cursor: this.#next } : {}),
    } as { limit?: number });
    this.#started = true;
    this.#next = page.next;
    return page.items.map(e2bInfo);
  }
}

const LANGUAGES: Record<string, (file: string) => string[]> = {
  python: (f) => ["python3", f],
  js: (f) => ["node", f],
  javascript: (f) => ["node", f],
  ts: (f) => ["bun", f],
  typescript: (f) => ["bun", f],
  bash: (f) => ["bash", f],
  sh: (f) => ["sh", f],
};
const EXT: Record<string, string> = { python: "py", js: "mjs", javascript: "mjs", ts: "ts", typescript: "ts", bash: "sh", sh: "sh" };

export class Sandbox {
  readonly commands: {
    run(cmd: string, opts: CommandOpts & { background: true }): Promise<CommandHandle>;
    run(cmd: string, opts?: CommandOpts): Promise<CommandResult>;
    kill(pid: string): Promise<boolean>;
  };
  readonly files: {
    write(path: string, data: string | ArrayBuffer | Uint8Array): Promise<{ path: string; name: string }>;
    read(path: string, opts?: { format?: "text" | "bytes" }): Promise<string>;
    list(path: string): Promise<EntryInfo[]>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    makeDir(path: string): Promise<boolean>;
  };

  private constructor(private readonly rt: Runtime, private readonly sbx: Handle, envs: Record<string, string> = {}) {
    const self = sbx;
    const start = (cmd: string, o: CommandOpts): { handle: Promise<CommandHandle>; done: Promise<CommandResult> } => {
      const stream = self.execStream(shell(cmd), {
        ...(o.cwd ? { cwd: o.cwd } : {}),
        env: { ...envs, ...o.envs },
        ...(o.timeoutMs ? { timeoutSeconds: o.timeoutMs / 1000 } : {}),
        ...(o.stdin ? { stdinOpen: true } : {}),
      });
      const done = (async () => {
        let stdout = "";
        let stderr = "";
        for await (const c of stream as AsyncIterable<OutputChunk>) {
          if (c.stream === "stderr") {
            stderr += c.text;
            o.onStderr?.(c.text);
          } else {
            stdout += c.text;
            o.onStdout?.(c.text);
          }
        }
        const p: Process = await stream.wait();
        const exitCode = p.exitCode ?? -1;
        if (exitCode !== 0) throw new CommandExitError(stdout, stderr, exitCode);
        return { stdout, stderr, exitCode };
      })();
      const handle = stream.started().then(
        (p) =>
          new CommandHandle(
            p.id,
            done,
            async () => ((await self.processes.signal(p.id, { signal: "SIGKILL" })), true),
            async (data) => void (await self.processes.write(p.id, { data: base64(data) })),
          ),
      );
      return { handle, done };
    };
    this.commands = {
      run: ((cmd: string, o: CommandOpts = {}) => {
        const { handle, done } = start(cmd, o);
        if (o.background) {
          done.catch(() => undefined);
          return handle;
        }
        return done;
      }) as Sandbox["commands"]["run"],
      async kill(pid) {
        await self.processes.signal(pid, { signal: "SIGKILL" });
        return true;
      },
    };
    this.files = {
      async write(path, data) {
        await self.files.write(path, bytes(data));
        return { path, name: path.split("/").pop() ?? path };
      },
      async read(path) {
        return text(await self.files.read(path));
      },
      list: (path) => list(rt, self.id, path),
      async remove(path) {
        await self.files.remove(path, { recursive: true });
      },
      async exists(path) {
        return (await self.exec(["test", "-e", path])).exitCode === 0;
      },
      async makeDir(path) {
        return (await self.exec(["mkdir", "-p", path])).exitCode === 0;
      },
    };
  }

  get sandboxId(): string {
    return this.sbx.id;
  }

  static async create(templateOrOpts?: string | SandboxOpts, maybe?: SandboxOpts): Promise<Sandbox> {
    const o = (typeof templateOrOpts === "string" ? maybe : templateOrOpts) ?? {};
    const image = typeof templateOrOpts === "string" ? templateOrOpts : undefined;
    const rt = client(o);
    const sbx = await rt.sandboxes.create({
      ...(image ? { image } : {}),
      ...(o.metadata ? { labels: o.metadata } : {}),
    });
    return new Sandbox(rt, sbx, o.envs);
  }

  static async connect(sandboxId: string, o: RuntimeOptions = {}): Promise<Sandbox> {
    const rt = client(o);
    const sbx = await rt.sandboxes.get(sandboxId);
    if (sbx.info.state === "paused") await sbx.resume();
    return new Sandbox(rt, sbx);
  }

  static async kill(sandboxId: string, o: RuntimeOptions = {}): Promise<boolean> {
    await client(o).sandboxes.delete(sandboxId);
    return true;
  }

  /** The org's sandboxes, a page at a time: E2B's paginator. */
  static list(o: SandboxOpts & { limit?: number } = {}): SandboxPaginator {
    return new SandboxPaginator(o);
  }

  /** Taken and does nothing: a Runtime sandbox has no time limit; it pauses when idle and lives until deleted. */
  static async setTimeout(_sandboxId: string, _timeoutMs: number, _o: RuntimeOptions = {}): Promise<void> {}

  /** Taken and does nothing: a Runtime sandbox has no time limit; it pauses when idle and lives until deleted. */
  async setTimeout(_timeoutMs: number): Promise<void> {}

  async getInfo(): Promise<SandboxInfoE2B> {
    return e2bInfo((await this.sbx.refresh()).info);
  }

  /** Runs code (Python by default; js, ts, bash) and returns its output. Each
   * run is a fresh interpreter: variables do not carry between runs. */
  async runCode(code: string, o: { language?: string; envs?: Record<string, string>; timeoutMs?: number; onStdout?: (d: { line: string }) => void; onStderr?: (d: { line: string }) => void } = {}): Promise<Execution> {
    const language = (o.language ?? "python").toLowerCase();
    const argv = LANGUAGES[language];
    if (!argv) throw new TypeError(`runCode: no language ${language}`);
    const file = `/tmp/.run-${crypto.randomUUID()}.${EXT[language]}`;
    await this.sbx.files.write(file, code);
    const stream = this.sbx.execStream(argv(file), { ...(o.envs ? { env: o.envs } : {}), ...(o.timeoutMs ? { timeoutSeconds: o.timeoutMs / 1000 } : {}) });
    let stdout = "";
    let stderr = "";
    for await (const c of stream as AsyncIterable<OutputChunk>) {
      if (c.stream === "stderr") {
        stderr += c.text;
        o.onStderr?.({ line: c.text });
      } else {
        stdout += c.text;
        o.onStdout?.({ line: c.text });
      }
    }
    const p = await stream.wait();
    await this.sbx.files.remove(file).catch(() => undefined);
    const lines = (s: string) => s.split(/(?<=\n)/).filter(Boolean);
    const failed = (p.exitCode ?? -1) !== 0;
    const last = stderr.trim().split("\n").pop() ?? "";
    return {
      text: stdout || undefined,
      results: stdout ? [{ text: stdout }] : [],
      logs: { stdout: lines(stdout), stderr: lines(stderr) },
      error: failed ? { name: last.split(":")[0] || "Error", value: last.split(":").slice(1).join(":").trim() || last, traceback: stderr } : undefined,
    };
  }

  /** The host a port is served at: a preview of it. */
  async getHost(port: number): Promise<string> {
    const p = await this.rt.previews.create(this.sbx.id, { port, visibility: "public" });
    return new URL(p.info.url).host;
  }

  async isRunning(): Promise<boolean> {
    return (await this.sbx.refresh()).info.state === "running";
  }

  async pause(): Promise<boolean> {
    await this.sbx.pause();
    return true;
  }

  async kill(): Promise<void> {
    await this.sbx.delete();
  }
}

export default Sandbox;
