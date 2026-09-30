/** Real local processes and private files; native allocation/transport is simulated. */
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Process, Sandbox } from "../../src/sandbox.js";

export async function localSandbox() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-codesandbox-"));
  const processes = new Map<string, Process>();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let service: ReturnType<typeof Bun.spawn> | undefined;
  const invocations: { command: string | string[]; options: Record<string, unknown> }[] = [];
  const path = (value: string) =>
    value.startsWith("/workspace/.runtime-compat/codesandbox/")
      ? join(directory, "compat", value.slice("/workspace/.runtime-compat/codesandbox/".length))
      : value.startsWith("/workspace/") || value.startsWith("/project/")
        ? join(directory, value.slice(1))
        : value;
  await mkdir(path("/project/sandbox"), { recursive: true });
  let writeFailure: Error | undefined;
  let activeSubscriptions = 0;
  const files = {
    async readText(value: string) {
      if (value.endsWith("/environment.json")) return "{}";
      return readFile(path(value), "utf8");
    },
    async exists(value: string) {
      try {
        await stat(path(value));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async write(value: string, data: string, options?: { mode?: number }) {
      if (writeFailure) throw writeFailure;
      await mkdir(dirname(path(value)), { recursive: true });
      if (value.startsWith("/workspace/.runtime-compat/codesandbox/") && data.includes('"cwd"')) {
        const config = JSON.parse(data) as { cwd?: string };
        if (config.cwd) config.cwd = path(config.cwd);
        data = JSON.stringify(config);
      }
      await writeFile(path(value), data, { mode: options?.mode });
    },
  };
  const native = {
    id: "local-codesandbox",
    state: "running",
    info: { state: "running" },
    async refresh() {
      return native;
    },
    files,
    async exec(
      command: string[],
      options: { signal?: AbortSignal; check?: boolean; stdin?: string } = {},
    ) {
      options.signal?.throwIfAborted();
      if (command[0] === "sudo") {
        if (!command[4]?.includes("User=1000") || !command[4]?.includes("KillMode=control-group"))
          throw new Error("Unexpected privileged fixture command");
        if (!service || service.exitCode !== null) {
          service = Bun.spawn(
            ["python3", path(`${command.at(-1)!}/service.py`), path(command.at(-1)!)],
            { stdout: "ignore", stderr: "inherit" },
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      const child = Bun.spawn(command.map(path), {
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        signal: options.signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (options.check && exitCode !== 0) throw new Error(stderr);
      return { stdout, stderr, exitCode };
    },
    processes: {
      list: async () => [...processes.values()].map((process) => process.info),
      get: async (id: string) => processes.get(id)!,
    },
    async spawn(
      command: string | string[],
      options: { env?: Record<string, string>; cwd?: string } = {},
    ) {
      invocations.push({ command, options: structuredClone(options) });
      const child = Bun.spawn(
        typeof command === "string" ? ["bash", "-c", command] : command.map(path),
        {
          cwd: options.cwd ? path(options.cwd) : directory,
          env: { ...process.env, ...options.env },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      children.push(child);
      const info = { id: crypto.randomUUID(), state: "running", command };
      const result = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      void child.exited.then(() => {
        info.state = "exited";
      });
      const handle = {
        id: info.id,
        info,
        async *output({ signal }: { signal?: AbortSignal } = {}) {
          activeSubscriptions++;
          let abort!: () => void;
          const cancelled = new Promise<never>((_, reject) => {
            abort = () =>
              reject(signal?.reason instanceof Error ? signal.reason : new Error("Cancelled"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
          try {
            const [stdout, stderr, exitCode] = await Promise.race([result, cancelled]);
            if (stdout) yield { type: "stdout", data: stdout, offset: 0 };
            if (stderr) yield { type: "stderr", data: stderr, offset: stdout.length };
            yield { type: "exit", exitCode, state: "exited", timedOut: false };
          } finally {
            signal?.removeEventListener("abort", abort);
            activeSubscriptions--;
          }
        },
        async wait(options: { signal?: AbortSignal } = {}) {
          let stdout = "",
            stderr = "",
            exitCode: number | null = null;
          for await (const event of handle.output(options)) {
            if (event.type === "stdout") stdout += event.data;
            if (event.type === "stderr") stderr += event.data;
            if (event.type === "exit") exitCode = event.exitCode;
          }
          return { stdout, stderr, exitCode, timedOut: false };
        },
        async kill() {
          child.kill();
          await child.exited;
        },
      } as unknown as Process;
      processes.set(info.id, handle);
      return handle;
    },
  } as unknown as Sandbox;
  return {
    native,
    directory,
    invocations,
    children,
    path,
    async restartService(options: { fileSizeLimit?: number } = {}) {
      if (service && service.exitCode === null) {
        service.kill();
        await service.exited;
      }
      const root = path("/workspace/.runtime-compat/codesandbox/service");
      const args =
        options.fileSizeLimit === undefined
          ? ["python3", join(root, "service.py"), root]
          : [
              "python3",
              "-c",
              "import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[1]),int(sys.argv[1]))); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.executable,[sys.executable,*sys.argv[2:]])",
              String(options.fileSizeLimit),
              join(root, "service.py"),
              root,
            ];
      service = Bun.spawn(args, {
        stdout: "ignore",
        stderr: "inherit",
      });
    },
    subscriptions: () => activeSubscriptions,
    failWrites: (error: Error) => {
      writeFailure = error;
    },
    async close() {
      if (service && service.exitCode === null) {
        service.kill();
        await service.exited;
      }
      for (const child of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
