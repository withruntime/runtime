/** Runtime Cloud sandboxes for the OpenAI Agents SDK (JavaScript).
 *
 * `RuntimeCloudSandboxClient` is a sandbox client for `SandboxAgent`: the
 * agent's shell (with PTY sessions and stdin), file edits, image views and
 * manifest all live in one Runtime Cloud microVM, and the agent definition
 * does not change:
 *
 *   import { run } from "@openai/agents";
 *   import { SandboxAgent } from "@openai/agents/sandbox";
 *   import { RuntimeCloudSandboxClient } from "withruntime/openai-agents";
 *
 *   const agent = new SandboxAgent({ name: "Coder", instructions: "Fix the failing test." });
 *   await run(agent, "Go.", {
 *     sandbox: { client: new RuntimeCloudSandboxClient({ create: { funding: "trial" } }) },
 *   });
 *
 * Needs `@openai/agents` 0.18 or newer beside this package. The key comes from
 * RUNTIME_API_KEY or this machine's `runtime login`. Plain function tools for
 * an ordinary `Agent` are `runtimeFunctionTools(sandbox)`. */
import {
  applyDiff,
  tool,
  UserError,
  type ApplyPatchOperation,
  type Editor,
} from "@openai/agents-core";
import type { Manifest } from "@openai/agents-core/sandbox";
import {
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type Entry,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxDirectoryEntry,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
  type ViewImageArgs,
  type WorkspaceArchiveData,
  type WriteStdinArgs,
} from "@openai/agents-core/sandbox";
import {
  deserializeManifest,
  elapsedSeconds,
  formatExecResponse,
  imageOutputFromBytes,
  materializeEnvironment,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  serializeManifestRecord,
  shellQuote,
  truncateOutput,
} from "@openai/agents-core/sandbox/internal";
import { Runtime } from "../client.js";
import { NotFoundError, RuntimeError } from "../errors.js";
import type { Process, Sandbox } from "../sandbox.js";
import { sandboxTools, type SandboxToolOptions } from "../tools/index.js";
import type { CreateSandbox } from "../types.js";

export const BACKEND_ID = "runtime_cloud";
const PROVIDER = "RuntimeCloudSandboxClient";
const FILES_HOME = "/workspace";
const STAGING = "/workspace/.openai-agents-staging";
const MAX_EXEC_MS = 86_400_000;
const YIELD_MIN_MS = 250;
const YIELD_EMPTY_MIN_MS = 5_000;
const YIELD_MAX_MS = 30_000;
const MAX_PROCESSES = 64;

export type RuntimeCloudSandboxClientOptions = {
  /** How to create the sandbox: every field `runtime.sandboxes.create` takes
   * (funding, image, snapshot, vcpu, memoryMiB, network...). */
  create?: CreateSandbox;
  /** Set for every command, under the manifest's own environment. */
  env?: Record<string, string>;
  /** Ports `resolveExposedPort` may share as Runtime previews. */
  exposedPorts?: number[];
  /** Private previews carry their token in the endpoint's query. Default private. */
  previewVisibility?: "private" | "public";
  /** Pause instead of stopping at the end, so `resume` wakes the same machine. */
  pauseOnExit?: boolean;
  /** Longest a command may run. Default one hour; at most 24 hours. */
  execTimeoutMs?: number;
};

export interface RuntimeCloudSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  create: CreateSandbox;
  environment: Record<string, string>;
  configuredExposedPorts?: number[];
  previewVisibility: "private" | "public";
  pauseOnExit: boolean;
  execTimeoutMs: number;
}

type PtyEntry = {
  process: Process;
  tty: boolean;
  chunks: string[];
  exitCode: number | null | undefined;
  done: boolean;
  wake?: () => void;
  lastUsed: number;
  pump?: Promise<void>;
};

const isRuntimeError = (error: unknown): error is RuntimeError => error instanceof RuntimeError;
const clampYield = (ms: number) => Math.max(YIELD_MIN_MS, Math.min(YIELD_MAX_MS, ms));
const inFilesApi = (path: string) => path.startsWith(`${FILES_HOME}/`);

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function providerError(message: string, error: unknown, details: Record<string, unknown> = {}) {
  return new SandboxProviderError(message, {
    provider: BACKEND_ID,
    ...details,
    cause: error instanceof Error ? error.message : String(error),
    ...(isRuntimeError(error) ? { code: error.code } : {}),
  });
}

/** One Runtime Cloud sandbox as an Agents SDK sandbox session. */
export class RuntimeCloudSandboxSession implements SandboxSession<RuntimeCloudSandboxSessionState> {
  readonly state: RuntimeCloudSandboxSessionState;
  #runtime: Runtime;
  #sandbox: Sandbox | undefined;
  #paused = false;
  #processes = new Map<number, PtyEntry>();

  constructor(args: {
    state: RuntimeCloudSandboxSessionState;
    runtime: Runtime;
    sandbox?: Sandbox;
  }) {
    this.state = args.state;
    this.#runtime = args.runtime;
    this.#sandbox = args.sandbox;
  }

  /** The Runtime sandbox, created (or woken) on first use. */
  async sandbox(): Promise<Sandbox> {
    if (this.#sandbox && this.#paused) {
      await this.#sandbox.wake();
      this.#paused = false;
    }
    if (!this.#sandbox) {
      this.#sandbox = await this.#runtime.sandboxes.create(this.state.create);
      this.state.sandboxId = this.#sandbox.id;
    }
    return this.#sandbox;
  }

  /** Runs `operation`, waking the sandbox once if it paused itself when idle. */
  async #call<T>(operation: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await this.sandbox();
    try {
      return await operation(sandbox);
    } catch (error) {
      if (!isRuntimeError(error) || error.code !== "sandbox_paused") throw error;
      await sandbox.wake();
      return await operation(sandbox);
    }
  }

  // Paths.

  /** An absolute path inside the workspace root or a granted path; anything else is refused. */
  resolvePath(path: string): string {
    const root = this.state.manifest.root;
    const resolved = normalize(path.startsWith("/") ? path : `${root}/${path}`);
    const allowed = [root, ...this.state.manifest.extraPathGrants.map((grant) => grant.path)];
    if (
      !allowed.some(
        (base) => resolved === base || resolved.startsWith(`${base === "/" ? "" : base}/`),
      )
    )
      throw new UserError(`Path is outside the sandbox workspace: ${path}`);
    return resolved;
  }

  #workdir(workdir?: string): string {
    return workdir ? this.resolvePath(workdir) : this.state.manifest.root;
  }

  // Commands.

  supportsPty(): boolean {
    return true;
  }

  #argv(args: ExecCommandArgs): string[] {
    const shellPath = args.shell ?? "/bin/sh";
    const flag = args.shell ? ((args.login ?? true) ? "-lc" : "-c") : "-c";
    const command = [shellPath, flag, args.cmd];
    if (!args.runAs) return command;
    const env = Object.entries(this.state.environment).map(([key, value]) => `${key}=${value}`);
    return ["sudo", "-n", "-u", args.runAs, "--", "env", ...env, ...command];
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    const start = Date.now();
    const result = await this.#call((sbx) =>
      sbx.exec(this.#argv(args), {
        cwd: this.#workdir(args.workdir),
        env: this.state.environment,
        timeoutMs: Math.min(MAX_EXEC_MS, args.yieldTimeMs ?? this.state.execTimeoutMs),
      }),
    );
    return {
      output: result.stdout + result.stderr,
      stdout: result.stdout,
      stderr: result.stderr,
      wallTimeSeconds: elapsedSeconds(start),
      exitCode: result.timedOut ? null : result.exitCode,
    };
  }

  /** Starts the command and returns its output so far: finished, with its exit
   * code, or still running, with a session id for `writeStdin`. */
  async execCommand(args: ExecCommandArgs): Promise<string> {
    const start = Date.now();
    let process: Process;
    try {
      process = await this.#call((sbx) =>
        sbx.spawn(this.#argv(args), {
          cwd: this.#workdir(args.workdir),
          env: this.state.environment,
          timeoutMs: Math.min(MAX_EXEC_MS, this.state.execTimeoutMs),
          ...(args.tty ? { pty: { cols: 80, rows: 24 } } : {}),
        }),
      );
    } catch (error) {
      throw providerError(`${PROVIDER} could not start the command.`, error, {
        sandboxId: this.state.sandboxId,
      });
    }
    const entry: PtyEntry = {
      process,
      tty: Boolean(args.tty),
      chunks: [],
      exitCode: undefined,
      done: false,
      lastUsed: Date.now(),
    };
    entry.pump = this.#pump(entry);
    const sessionId = await this.#register(entry);
    return this.#collect(
      sessionId,
      entry,
      clampYield(args.yieldTimeMs ?? 10_000),
      start,
      args.maxOutputTokens,
    );
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    const start = Date.now();
    const entry = this.#processes.get(args.sessionId);
    if (!entry) throw new UserError(`No running process with session ID ${args.sessionId}.`);
    const chars = args.chars ?? "";
    if (chars) {
      if (!entry.tty)
        throw new UserError("This process has no stdin; start it with tty: true to type into it.");
      await entry.process.write(chars);
    }
    entry.lastUsed = Date.now();
    const yieldMs = clampYield(args.yieldTimeMs ?? 250);
    return this.#collect(
      args.sessionId,
      entry,
      chars ? yieldMs : Math.max(yieldMs, YIELD_EMPTY_MIN_MS),
      start,
      args.maxOutputTokens,
    );
  }

  async #register(entry: PtyEntry): Promise<number> {
    if (this.#processes.size >= MAX_PROCESSES) {
      const oldest = [...this.#processes.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      )[0];
      if (oldest) {
        this.#processes.delete(oldest[0]);
        await this.#terminate(oldest[1]);
      }
    }
    let id: number;
    do id = 1_000 + Math.floor(Math.random() * 99_000);
    while (this.#processes.has(id));
    this.#processes.set(id, entry);
    return id;
  }

  /** Moves the process's output into `entry` until it exits; a dropped stream resumes a few times. */
  async #pump(entry: PtyEntry): Promise<void> {
    let cursor = 0;
    let failures = 0;
    try {
      for (;;) {
        try {
          for await (const event of entry.process.output({ cursor })) {
            failures = 0;
            if (event.type === "stdout" || event.type === "stderr") {
              cursor = event.offset + Buffer.byteLength(event.data);
              entry.chunks.push(event.data);
              entry.wake?.();
            } else if (event.type === "exit") entry.exitCode = event.exitCode ?? -1;
          }
          if (entry.exitCode === undefined) {
            const info = await entry.process.refresh();
            if (info.state !== "running") entry.exitCode = info.exitCode ?? -1;
          }
          if (entry.exitCode !== undefined) return;
        } catch (error) {
          failures += 1;
          if (failures > 4 || (isRuntimeError(error) && !error.retryable)) {
            entry.chunks.push(`\n[Runtime: the output stream failed: ${String(error)}]\n`);
            entry.exitCode = -1;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 200 * failures));
        }
      }
    } finally {
      entry.done = true;
      entry.wake?.();
    }
  }

  async #collect(
    sessionId: number,
    entry: PtyEntry,
    yieldMs: number,
    start: number,
    maxOutputTokens?: number,
  ): Promise<string> {
    const deadline = Date.now() + yieldMs;
    while (!entry.done && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deadline - Date.now());
        entry.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      entry.wake = undefined;
    }
    const output = truncateOutput(entry.chunks.splice(0).join(""), maxOutputTokens);
    const finished = entry.done && entry.exitCode !== undefined;
    if (finished) this.#processes.delete(sessionId);
    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      ...(finished ? { exitCode: entry.exitCode } : { sessionId }),
      ...(output.originalTokenCount === undefined
        ? {}
        : { originalTokenCount: output.originalTokenCount }),
    });
  }

  async #terminate(entry: PtyEntry): Promise<void> {
    if (!entry.done) await entry.process.kill("SIGKILL").catch(() => undefined);
  }

  // Files.

  async #readBytes(path: string): Promise<Uint8Array> {
    if (inFilesApi(path)) return this.#call((sbx) => sbx.files.read(path));
    // The Files API serves /workspace; another path is copied there first.
    const staging = `${STAGING}/${crypto.randomUUID()}`;
    try {
      const copied = await this.#call((sbx) =>
        sbx.exec([
          "sh",
          "-c",
          'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"',
          "sh",
          path,
          staging,
        ]),
      );
      if (copied.exitCode !== 0) {
        if (copied.stderr.includes("No such file"))
          throw new NotFoundError({
            message: copied.stderr.trim(),
            code: "file_not_found",
            status: 404,
          });
        throw new SandboxProviderError(`${PROVIDER} could not read ${path}.`, {
          stderr: copied.stderr,
        });
      }
      return await this.#call((sbx) => sbx.files.read(staging));
    } finally {
      await this.#call((sbx) => sbx.files.remove(staging)).catch(() => undefined);
    }
  }

  async #writeBytes(path: string, data: string | Uint8Array): Promise<void> {
    if (inFilesApi(path)) {
      await this.#call((sbx) => sbx.files.write(path, data));
      return;
    }
    const staging = `${STAGING}/${crypto.randomUUID()}`;
    try {
      await this.#call((sbx) => sbx.files.write(staging, data));
      const copied = await this.#call((sbx) =>
        sbx.exec([
          "sh",
          "-c",
          'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"',
          "sh",
          staging,
          path,
        ]),
      );
      if (copied.exitCode !== 0)
        throw new SandboxProviderError(`${PROVIDER} could not write ${path}.`, {
          stderr: copied.stderr,
        });
    } finally {
      await this.#call((sbx) => sbx.files.remove(staging)).catch(() => undefined);
    }
  }

  #filesystemRunAs(runAs?: string) {
    if (runAs)
      throw new SandboxUnsupportedFeatureError(
        `${PROVIDER} reads and writes files as the sandbox user; run commands with runAs instead.`,
        { provider: BACKEND_ID, feature: "filesystem.runAs" },
      );
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    this.#filesystemRunAs(args.runAs);
    const bytes = await this.#readBytes(this.resolvePath(args.path));
    return typeof args.maxBytes === "number" && bytes.byteLength > args.maxBytes
      ? bytes.subarray(0, args.maxBytes)
      : bytes;
  }

  async viewImage(args: ViewImageArgs) {
    this.#filesystemRunAs(args.runAs);
    return imageOutputFromBytes(args.path, await this.#readBytes(this.resolvePath(args.path)));
  }

  async listDir(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    const path = this.resolvePath(args.path);
    const result = await this.#call((sbx) =>
      sbx.exec(["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\t%f\\n"]),
    );
    if (result.exitCode !== 0)
      throw new SandboxProviderError(`${PROVIDER} could not list ${path}.`, {
        stderr: result.stderr,
      });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind = "", ...rest] = line.split("\t");
        const name = rest.join("\t");
        return {
          name,
          path: `${path === "/" ? "" : path}/${name}`,
          type: kind === "f" ? "file" : kind === "d" ? "dir" : "other",
        } satisfies SandboxDirectoryEntry;
      })
      .filter((entry) => entry.path !== STAGING)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #test(flag: "-e" | "-d", path: string, runAs?: string): Promise<boolean> {
    const argv = ["test", flag, this.resolvePath(path)];
    const result = await this.#call((sbx) =>
      sbx.exec(runAs ? ["sudo", "-n", "-u", runAs, "--", ...argv] : argv),
    );
    return result.exitCode === 0;
  }

  pathExists(path: string, runAs?: string): Promise<boolean> {
    return this.#test("-e", path, runAs);
  }

  directoryExists(path: string, runAs?: string): Promise<boolean> {
    return this.#test("-d", path, runAs);
  }

  createEditor(runAs?: string): Editor {
    this.#filesystemRunAs(runAs);
    const read = async (path: string) =>
      new TextDecoder().decode(await this.#readBytes(this.resolvePath(path)));
    const exists = (path: string) => this.pathExists(path);
    return {
      createFile: async (operation: Extract<ApplyPatchOperation, { type: "create_file" }>) => {
        if (await exists(operation.path))
          throw new UserError(`Cannot create file because it already exists: ${operation.path}`);
        await this.#writeBytes(
          this.resolvePath(operation.path),
          applyDiff("", operation.diff, "create"),
        );
        return {};
      },
      updateFile: async (operation: Extract<ApplyPatchOperation, { type: "update_file" }>) => {
        const source = this.resolvePath(operation.path);
        const target = operation.moveTo ? this.resolvePath(operation.moveTo) : source;
        await this.#writeBytes(target, applyDiff(await read(operation.path), operation.diff));
        if (target !== source) await this.#call((sbx) => sbx.exec(["rm", "-f", "--", source]));
        return {};
      },
      deleteFile: async (operation: Extract<ApplyPatchOperation, { type: "delete_file" }>) => {
        const path = this.resolvePath(operation.path);
        const result = await this.#call((sbx) => sbx.exec(["rm", "-f", "--", path]));
        if (result.exitCode !== 0)
          throw new UserError(`Cannot delete ${operation.path}: ${result.stderr}`);
        return {};
      },
    };
  }

  // The manifest.

  async prepareWorkspaceRoot(): Promise<void> {
    const root = this.state.manifest.root;
    // The root may sit where the sandbox user cannot write (/app); make it as root and hand it over.
    const result = await this.#call((sbx) =>
      sbx.exec(
        [
          "sh",
          "-c",
          'mkdir -p -- "$1" 2>/dev/null || { sudo -n mkdir -p -- "$1" && sudo -n chown "$(id -u):$(id -g)" -- "$1"; }',
          "sh",
          root,
        ],
        { cwd: "/" },
      ),
    );
    if (result.exitCode !== 0)
      throw new SandboxProviderError(`${PROVIDER} could not prepare the workspace root ${root}.`, {
        stderr: result.stderr,
      });
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    this.#filesystemRunAs(runAs);
    for (const group of manifest.groups) await this.#root(["groupadd", "-f", group.name]);
    const users = new Set([
      ...manifest.users.map((user) => user.name),
      ...manifest.groups.flatMap((group) => (group.users ?? []).map((user) => user.name)),
    ]);
    for (const name of users)
      await this.#root([
        "sh",
        "-c",
        'id -u "$1" >/dev/null 2>&1 || useradd -U -M -s /usr/sbin/nologin "$1"',
        "sh",
        name,
      ]);
    for (const group of manifest.groups)
      for (const user of group.users ?? [])
        await this.#root(["usermod", "-aG", group.name, user.name]);
    for (const [path, entry] of Object.entries(manifest.entries))
      await this.#materialize(this.resolvePath(path), entry);
    this.state.environment = await materializeEnvironment(manifest, this.state.environment);
    this.state.manifest = mergeManifestDelta(this.state.manifest, manifest);
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.#filesystemRunAs(args.runAs);
    await this.#materialize(this.resolvePath(args.path), args.entry);
    const relative = this.resolvePath(args.path)
      .slice(this.state.manifest.root.length)
      .replace(/^\//, "");
    this.state.manifest = mergeManifestEntryDelta(
      this.state.manifest,
      relative || args.path,
      args.entry,
    );
  }

  async #root(argv: string[]): Promise<void> {
    const result = await this.#call((sbx) => sbx.exec(["sudo", "-n", ...argv], { cwd: "/" }));
    if (result.exitCode !== 0)
      throw new SandboxProviderError(`${PROVIDER} could not run ${argv[0]}.`, {
        stderr: result.stderr,
      });
  }

  async #materialize(path: string, entry: Entry): Promise<void> {
    if ("permissions" in entry && entry.permissions !== undefined)
      throw new SandboxUnsupportedFeatureError(
        `${PROVIDER} does not set manifest permissions yet.`,
        {
          provider: BACKEND_ID,
          feature: "entry.permissions",
          path,
        },
      );
    switch (entry.type) {
      case "file":
        await this.#writeBytes(path, entry.content);
        return;
      case "dir": {
        const made = await this.#call((sbx) => sbx.exec(["mkdir", "-p", "--", path]));
        if (made.exitCode !== 0)
          throw new SandboxProviderError(`${PROVIDER} could not make ${path}.`, {
            stderr: made.stderr,
          });
        for (const [name, child] of Object.entries(entry.children ?? {}))
          await this.#materialize(normalize(`${path}/${name}`), child);
        return;
      }
      case "local_file": {
        const { readFile } = await import("node:fs/promises");
        await this.#writeBytes(path, await readFile(entry.src));
        return;
      }
      case "local_dir": {
        // One gzipped tar, staged inside /workspace where uploads of any size are accepted.
        const { packDirectory } = await import("../tar.js");
        const staging = `${STAGING}/${crypto.randomUUID()}.tar.gz`;
        const archive = await packDirectory(entry.src);
        try {
          await this.#call((sbx) => sbx.files.write(staging, archive));
          const unpacked = await this.#call((sbx) =>
            sbx.exec([
              "sh",
              "-c",
              'mkdir -p -- "$1" && tar -xzf "$2" -C "$1"',
              "sh",
              path,
              staging,
            ]),
          );
          if (unpacked.exitCode !== 0)
            throw new SandboxProviderError(`${PROVIDER} could not place ${entry.src}.`, {
              stderr: unpacked.stderr,
            });
        } finally {
          await this.#call((sbx) => sbx.files.remove(staging)).catch(() => undefined);
        }
        return;
      }
      case "git_repo": {
        const url = /^[a-z]+:\/\//.test(entry.repo)
          ? entry.repo
          : `https://${entry.host ?? "github.com"}/${entry.repo.replace(/\.git$/, "")}.git`;
        const script = [
          "set -e",
          "tmp=$(mktemp -d)",
          `git clone --depth 1 ${entry.ref ? `--branch ${shellQuote(entry.ref)} ` : ""}${shellQuote(url)} "$tmp/repo"`,
          'mkdir -p -- "$(dirname -- "$1")" && rm -rf -- "$1"',
          'mv -- "$tmp/repo/$2" "$1"',
          'rm -rf -- "$tmp"',
        ].join("\n");
        const subpath = (entry.subpath ?? "").replace(/^\/+/, "");
        const cloned = await this.#call((sbx) =>
          sbx.exec(["sh", "-c", script, "sh", path, subpath], { timeoutMs: 600_000 }),
        );
        if (cloned.exitCode !== 0)
          throw new SandboxProviderError(`${PROVIDER} could not clone ${entry.repo}.`, {
            stderr: cloned.stderr,
          });
        return;
      }
      default:
        throw new SandboxUnsupportedFeatureError(
          `${PROVIDER} does not attach ${entry.type} entries; mount storage from a command instead.`,
          { provider: BACKEND_ID, feature: entry.type, path },
        );
    }
  }

  // Ports.

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const configured = this.state.configuredExposedPorts;
    if (configured && !configured.includes(port))
      throw new UserError(`Port ${port} is not in exposedPorts (${configured.join(", ")}).`);
    let preview: { url: string; token: string | null };
    try {
      preview = await this.#call((sbx) =>
        sbx.previews.create(port, { visibility: this.state.previewVisibility }),
      );
    } catch (error) {
      throw providerError(`${PROVIDER} could not share port ${port}.`, error, { port });
    }
    const url = new URL(preview.url);
    const tls = url.protocol === "https:";
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : tls ? 443 : 80,
      tls,
      query: preview.token ? `runtime_preview_token=${preview.token}` : "",
    };
  }

  // Workspace archives.

  async persistWorkspace(): Promise<Uint8Array> {
    const root = this.state.manifest.root;
    const staging = `${STAGING}/${crypto.randomUUID()}.tar`;
    const skip = root === FILES_HOME ? ["--exclude=./.openai-agents-staging"] : [];
    try {
      const packed = await this.#call((sbx) =>
        sbx.exec(
          [
            "sh",
            "-c",
            `mkdir -p -- ${STAGING} && tar ${skip.join(" ")} -C "$1" -cf - . > "$2"`,
            "sh",
            root,
            staging,
          ],
          {
            cwd: "/",
            timeoutMs: this.state.execTimeoutMs,
          },
        ),
      );
      if (packed.exitCode !== 0)
        throw new SandboxProviderError(`${PROVIDER} could not archive the workspace.`, {
          stderr: packed.stderr,
        });
      return await this.#call((sbx) => sbx.files.read(staging));
    } finally {
      await this.#call((sbx) => sbx.files.remove(staging)).catch(() => undefined);
    }
  }

  async hydrateWorkspace(data: WorkspaceArchiveData): Promise<void> {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    const staging = `${STAGING}/${crypto.randomUUID()}.tar`;
    try {
      await this.#call((sbx) => sbx.files.write(staging, bytes));
      const unpacked = await this.#call((sbx) =>
        sbx.exec(
          [
            "sh",
            "-c",
            'mkdir -p -- "$1" && tar -C "$1" -xf "$2"',
            "sh",
            this.state.manifest.root,
            staging,
          ],
          {
            cwd: "/",
            timeoutMs: this.state.execTimeoutMs,
          },
        ),
      );
      if (unpacked.exitCode !== 0)
        throw new SandboxProviderError(`${PROVIDER} could not restore the workspace.`, {
          stderr: unpacked.stderr,
        });
    } finally {
      await this.#call((sbx) => sbx.files.remove(staging)).catch(() => undefined);
    }
  }

  // Lifecycle.

  async running(): Promise<boolean> {
    if (!this.#sandbox || this.#paused) return false;
    try {
      await this.#sandbox.refresh();
      return this.#sandbox.state === "running";
    } catch {
      return false;
    }
  }

  /** Ends every process the agent started. */
  async shutdown(): Promise<void> {
    const entries = [...this.#processes.values()];
    this.#processes.clear();
    await Promise.all(entries.map((entry) => this.#terminate(entry)));
  }

  /** Stops the sandbox, or pauses it with `pauseOnExit`. */
  async delete(): Promise<void> {
    await this.shutdown();
    const sandbox = this.#sandbox;
    if (!sandbox || this.#paused) return;
    if (this.state.pauseOnExit) {
      try {
        await sandbox.pause();
        this.#paused = true;
        return;
      } catch {
        // Stop it rather than leave it running.
      }
    }
    try {
      await sandbox.stop();
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    this.#sandbox = undefined;
  }

  async close(): Promise<void> {
    await this.delete();
  }
}

/** Creates, resumes and deletes Runtime Cloud sandbox sessions. */
export class RuntimeCloudSandboxClient implements SandboxClient<
  RuntimeCloudSandboxClientOptions,
  RuntimeCloudSandboxSessionState
> {
  readonly backendId = BACKEND_ID;
  readonly runtime: Runtime;
  readonly #options: RuntimeCloudSandboxClientOptions;

  constructor(options: RuntimeCloudSandboxClientOptions & { runtime?: Runtime } = {}) {
    const { runtime, ...rest } = options;
    this.runtime = runtime ?? new Runtime();
    this.#options = rest;
  }

  async create(
    args?: SandboxClientCreateArgs<RuntimeCloudSandboxClientOptions> | Manifest,
    manifestOptions?: RuntimeCloudSandboxClientOptions,
  ): Promise<RuntimeCloudSandboxSession> {
    const normalized = normalizeSandboxClientCreateArgs(args, manifestOptions);
    if (normalized.snapshot && normalized.snapshot.type !== "noop")
      throw new SandboxUnsupportedFeatureError(
        `${PROVIDER} keeps no SDK snapshots; use pauseOnExit to resume the same machine, or create from a Runtime snapshot.`,
        { provider: BACKEND_ID, feature: "snapshot" },
      );
    const options = { ...this.#options, ...normalized.options };
    const manifest = normalized.manifest;
    const state: RuntimeCloudSandboxSessionState = {
      manifest,
      sandboxId: "",
      create: { ...options.create },
      environment: await materializeEnvironment(manifest, options.env),
      ...(options.exposedPorts ? { configuredExposedPorts: options.exposedPorts } : {}),
      previewVisibility: options.previewVisibility ?? "private",
      pauseOnExit: options.pauseOnExit ?? false,
      execTimeoutMs: Math.min(MAX_EXEC_MS, options.execTimeoutMs ?? 3_600_000),
    };
    const session = new RuntimeCloudSandboxSession({ state, runtime: this.runtime });
    await session.sandbox();
    try {
      await session.prepareWorkspaceRoot();
      await session.applyManifest(manifest);
    } catch (error) {
      state.pauseOnExit = false;
      await session.delete().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /** Reattaches to the same sandbox while it runs (waking it when paused);
   * otherwise starts a new one and applies the manifest again. */
  async resume(state: RuntimeCloudSandboxSessionState): Promise<RuntimeCloudSandboxSession> {
    if (state.sandboxId) {
      try {
        const sandbox = await this.runtime.sandboxes.get(state.sandboxId);
        if (sandbox.state === "paused" || sandbox.state === "pausing") await sandbox.wake();
        else if (sandbox.state === "starting" || sandbox.state === "resuming")
          await sandbox.waitFor("running");
        if (sandbox.state === "running")
          return new RuntimeCloudSandboxSession({ state, runtime: this.runtime, sandbox });
      } catch (error) {
        if (!(error instanceof NotFoundError) && !(isRuntimeError(error) && error.status === 409))
          throw error;
      }
    }
    const session = await this.create(state.manifest, {
      create: state.create,
      env: state.environment,
      ...(state.configuredExposedPorts ? { exposedPorts: state.configuredExposedPorts } : {}),
      previewVisibility: state.previewVisibility,
      pauseOnExit: state.pauseOnExit,
      execTimeoutMs: state.execTimeoutMs,
    });
    Object.assign(state, session.state);
    return new RuntimeCloudSandboxSession({
      state,
      runtime: this.runtime,
      sandbox: await session.sandbox(),
    });
  }

  async delete(state: RuntimeCloudSandboxSessionState): Promise<void> {
    if (!state.sandboxId) return;
    try {
      const sandbox = await this.runtime.sandboxes.get(state.sandboxId);
      if (state.pauseOnExit) await sandbox.pause();
      else await sandbox.stop();
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  canPersistOwnedSessionState(state: RuntimeCloudSandboxSessionState): boolean {
    return state.pauseOnExit;
  }

  /** The state without secrets: the environment is materialized again on the way back. */
  async serializeSessionState(
    state: RuntimeCloudSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return {
      sandboxId: state.sandboxId,
      create: state.create,
      configuredExposedPorts: state.configuredExposedPorts,
      previewVisibility: state.previewVisibility,
      pauseOnExit: state.pauseOnExit,
      execTimeoutMs: state.execTimeoutMs,
      manifest: serializeManifestRecord(state.manifest),
    };
  }

  async deserializeSessionState(
    record: Record<string, unknown>,
  ): Promise<RuntimeCloudSandboxSessionState> {
    const manifest = deserializeManifest(record.manifest as Record<string, unknown> | undefined);
    return {
      manifest,
      sandboxId: typeof record.sandboxId === "string" ? record.sandboxId : "",
      create: (record.create as CreateSandbox | undefined) ?? {},
      environment: await materializeEnvironment(manifest, this.#options.env),
      ...(Array.isArray(record.configuredExposedPorts)
        ? { configuredExposedPorts: record.configuredExposedPorts as number[] }
        : {}),
      previewVisibility: record.previewVisibility === "public" ? "public" : "private",
      pauseOnExit: record.pauseOnExit === true,
      execTimeoutMs: typeof record.execTimeoutMs === "number" ? record.execTimeoutMs : 3_600_000,
    };
  }
}

/** The four sandbox tools as function tools for an ordinary `Agent`
 * (no SandboxAgent): runtime_exec, runtime_read_file, runtime_write_file and
 * runtime_list_files, bound to `sandbox`. */
export function runtimeFunctionTools(sandbox: Sandbox, options: SandboxToolOptions = {}) {
  return sandboxTools(sandbox, options).map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      // Non-strict: the optional fields stay optional.
      parameters: {
        type: "object" as const,
        properties: spec.inputSchema.properties,
        required: spec.inputSchema.required,
        additionalProperties: true as const,
      },
      strict: false as const,
      execute: async (input: unknown) => {
        const output = await (spec.execute as (value: unknown) => Promise<unknown>)(input);
        return typeof output === "string" ? output : JSON.stringify(output);
      },
    }),
  );
}
