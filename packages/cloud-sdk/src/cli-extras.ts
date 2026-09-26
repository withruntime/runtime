import { writeFile } from "node:fs/promises";
import { me } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { McpGateway, McpServerRequest } from "./products/mcp.js";
import type { FileEventType } from "./products/watch.js";
import type { Sandbox } from "./sandbox.js";
import type { Snapshot } from "./snapshots.js";

/* Sandbox commands kept out of cli.ts, which many hands edit: desktop
   recordings, file watching, MCP servers, and reading piped standard input.
   cli.ts hands over its argument helpers as `kit`. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
export async function recordCommand(
  sbx: Sandbox,
  argv: string[],
  out: Out,
  kit: CliKit,
): Promise<number> {
  const { parse, integer, need, table, usage } = kit;
  const [action, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const r = sbx.desktop.recordings;
  switch (action) {
    case "start": {
      const args = parse(rest, [], ["fps", "max-seconds", "max-mib"]);
      const rec = await r.start({
        ...(integer(args, "fps") ? { fps: integer(args, "fps")! } : {}),
        ...(integer(args, "max-seconds") ? { maxSeconds: integer(args, "max-seconds")! } : {}),
        ...(integer(args, "max-mib") ? { maxMiB: integer(args, "max-mib")! } : {}),
      });
      print(
        `Recording ${rec.id}. Stop it: ${me} sandbox desktop ${sbx.id} record stop ${rec.id}`,
        rec,
      );
      return 0;
    }
    case "stop": {
      const rec = await r.stop(need(rest[0], "the recording id"));
      print(
        `Stopped ${rec.id}: ${(rec.bytes / 1_048_576).toFixed(1)} MiB (${rec.reason ?? "stopped"}). Fetch it: ${me} sandbox desktop ${sbx.id} record fetch ${rec.id}`,
        rec,
      );
      return 0;
    }
    case "ls": {
      const list = await r.list();
      print(
        list.length
          ? table([
              ["ID", "STATE", "MIB", "REASON"],
              ...list.map((rec) => [
                rec.id,
                rec.state,
                (rec.bytes / 1_048_576).toFixed(1),
                rec.reason ?? "-",
              ]),
            ])
          : "No recordings.",
        list,
      );
      return 0;
    }
    case "fetch": {
      const id = need(rest[0], "the recording id");
      const file = rest[1] ?? `${id}.mp4`;
      await writeFile(file, await r.download(id));
      print(`Saved ${file}`, { file });
      return 0;
    }
    case "rm":
      print("Deleted.", await r.delete(need(rest[0], "the recording id")));
      return 0;
  }
  throw usage(`${me} sandbox desktop <id> record start|stop|ls|fetch|rm`);
}

export async function watchCommand(
  sbx: Sandbox,
  argv: string[],
  out: Out,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, need } = kit;
  const args = parse(argv, ["recursive"], ["events", "include", "exclude"]);
  const path = need(args.positional[0], "a directory, e.g. /workspace");
  const events = flag(args, "events")?.split(",") as FileEventType[] | undefined;
  const watch = await sbx.files.watch(
    path,
    (event) => {
      if (out.json) out.write(JSON.stringify(event));
      else
        out.write(
          `${event.type.padEnd(6)} ${event.oldPath ? `${event.oldPath} -> ` : ""}${event.path}${event.isDir ? "/" : ""}${event.count && event.count > 1 ? ` (x${event.count})` : ""}`,
        );
    },
    {
      recursive: has(args, "recursive"),
      ...(events ? { events } : {}),
      ...(args.flags.get("include") ? { include: args.flags.get("include")! } : {}),
      ...(args.flags.get("exclude") ? { exclude: args.flags.get("exclude")! } : {}),
      onNotice: (notice) =>
        out.error(
          notice.k === "overflow"
            ? `runtime: ${notice.dropped ?? "some"} events were dropped (${notice.reason}); rescan to catch up.`
            : notice.k === "limit"
              ? `runtime: only ${notice.watches} directories are watched; exclude some.`
              : `runtime: ${notice.bytes} bytes of events were lost while this reader was behind.`,
        ),
      onExit: (reason) => {
        if (reason !== "stopped") out.error(`runtime: the watch ended (${reason}).`);
      },
    },
  );
  const stop = () => void watch.stop();
  process.once("SIGINT", stop);
  try {
    await watch.done;
  } finally {
    process.off("SIGINT", stop);
  }
  return 0;
}

export async function mcpCommand(
  sbx: Sandbox,
  argv: string[],
  out: Out,
  kit: CliKit,
): Promise<number> {
  const { parse, has, integer, pairs, usage } = kit;
  const [action = "status", ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const show = (gw: McpGateway) => {
    if (!gw.running) return "No MCP servers run in this sandbox.";
    const auth = gw.headers?.Authorization ?? "";
    const lines = gw.servers.map(
      (server) =>
        `${server.name.padEnd(20)} ${server.status.padEnd(10)} ${server.url ?? "(no link)"}${server.message ? `\n  ${server.message}` : ""}`,
    );
    return [
      ...lines,
      "",
      `Send the header: Authorization: ${auth.replace(/^Bearer /, "Bearer ")}`,
      ...(gw.servers[0]?.url
        ? [
            "Claude Code:",
            ...gw.servers.map(
              (server) =>
                `  claude mcp add --transport http ${server.name} '${server.url}' --header 'Authorization: ${auth}'`,
            ),
          ]
        : []),
      ...gw.warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n");
  };
  switch (action) {
    case "start": {
      const args = parse(rest, ["replace"], ["secret", "env", "option", "port"]);
      if (!args.positional.length)
        throw usage("Name the servers: runtime sandbox mcp <id> start github fetch");
      const scoped = (name: string) => {
        const found: Record<string, Record<string, string>> = {};
        for (const [key, value] of Object.entries(pairs(args, name))) {
          const dot = key.indexOf(".");
          if (dot < 1) throw usage(`--${name} takes SERVER.NAME=VALUE.`);
          (found[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = value;
        }
        return found;
      };
      const secrets = scoped("secret");
      const env = scoped("env");
      const options = scoped("option");
      const servers: McpServerRequest[] = args.positional.map((id) => ({
        id,
        ...(secrets[id] ? { secrets: secrets[id] } : {}),
        ...(env[id] ? { env: env[id] } : {}),
        ...(options[id] ? { options: options[id] } : {}),
      }));
      const gw = await sbx.mcp.start(servers, {
        ...(integer(args, "port") ? { port: integer(args, "port")! } : {}),
        ...(has(args, "replace") ? { replace: true } : {}),
      });
      print(
        `${show(gw)}\nServers are installing; \`${me} sandbox mcp ${sbx.id}\` shows when they are ready.`,
        gw,
      );
      return 0;
    }
    case "status": {
      const gw = await sbx.mcp.get();
      print(show(gw), gw);
      return 0;
    }
    case "stop":
      print("Stopped.", await sbx.mcp.stop());
      return 0;
  }
  throw usage(`${me} sandbox mcp <id> start|status|stop, or ${me} sandbox mcp catalog`);
}

/** Standard input when it is piped or redirected from a file, read whole, up
 * to the API's 1 MiB; undefined for a terminal. A pipe that says nothing for
 * `quietMs` is taken as no input, so a script that leaves standard input open
 * and silent never hangs a command. */
export async function pipedStdin(
  options: { limit?: number; quietMs?: number } = {},
): Promise<Uint8Array | undefined> {
  const { fstatSync } = await import("node:fs");
  const stdin = process.stdin;
  if (stdin.isTTY) return undefined;
  let kind: ReturnType<typeof fstatSync>;
  try {
    kind = fstatSync(0);
  } catch {
    return undefined;
  }
  if (!kind.isFIFO() && !kind.isFile() && !kind.isSocket()) return undefined;
  const limit = options.limit ?? 1_048_576;
  return new Promise<Uint8Array | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: Uint8Array | undefined, error?: Error) => {
      clearTimeout(quiet);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      clearTimeout(quiet);
      size += chunk.length;
      if (size > limit)
        return done(
          undefined,
          Object.assign(
            new Error(
              `Standard input is over ${limit / 1_048_576} MiB. Copy the file in with \`${me} sandbox cp\` and read it there.`,
            ),
            { code: "usage" },
          ),
        );
      chunks.push(chunk);
    };
    const onEnd = () => done(size ? new Uint8Array(Buffer.concat(chunks)) : undefined);
    const quiet = setTimeout(() => {
      if (!size) done(undefined);
    }, options.quietMs ?? 100);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

/** What to say when a command's streamed output lost bytes, or nothing. */
export function lostOutput(
  result: { stdoutTruncated?: boolean; stderrTruncated?: boolean },
  id: string,
) {
  if (!result.stdoutTruncated && !result.stderrTruncated) return undefined;
  return `runtime: some of the command's output was lost: it wrote faster than it was read, and the sandbox keeps the latest 1 MiB. Write it to a file and copy it out: ${me} sandbox cp ${id}:/workspace/out.txt .`;
}

/** Feeds `runtime sandbox shell` from standard input. When piped input ends,
 * the shell is told so the way a terminal says it, Ctrl-D, after a newline
 * if the last line had none: `echo ls | runtime sandbox shell <id>` runs `ls`
 * and exits, as ssh does, where it used to wait forever (25 September 2026).
 * A keyboard never ends, so a terminal's input is left alone. Returns the
 * function that unhooks it. */
export function pipeShellInput(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  terminal: { write(data: Uint8Array | string): void },
): () => void {
  let last = 10;
  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    if (bytes.length) last = bytes[bytes.length - 1]!;
    terminal.write(new Uint8Array(bytes));
  };
  const onEnd = () => {
    if (stdin.isTTY) return;
    terminal.write(last === 10 ? "\x04" : "\n\x04");
  };
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  return () => {
    stdin.off("data", onData);
    stdin.off("end", onEnd);
  };
}

/** `runtime snapshot get`, as `runtime sandbox get` reads: one fact a line.
 * It printed raw JSON until 25 September 2026; `--json` still does. */
export function describeSnapshot(s: Snapshot, table: (rows: string[][]) => string): string {
  const mib = (bytes: number | null) =>
    bytes === null ? "-" : `${Math.ceil(bytes / 1_048_576).toLocaleString("en-US")} MiB`;
  const labels = (s.labels ?? {}) as Record<string, string>;
  return table([
    ["id", s.id],
    ["name", s.name ?? "-"],
    ["state", s.state],
    ["from", s.sourceSandboxId],
    ["shape", `${s.shape.vcpu} vCPU, ${s.shape.memoryMiB} MiB memory, ${s.shape.diskMiB} MiB disk`],
    ["stored", mib(s.storedBytes)],
    ["billed for", mib(s.meteredBytes)],
    [
      "backed up",
      s.backedUp
        ? `yes${s.durability.durableAt ? `, ${s.durability.durableAt}` : ""}`
        : s.durability.state,
    ],
    ["created", s.createdAt],
    ["kept until", `${s.expiresAt} (${s.retentionDays} days)`],
    [
      "labels",
      Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "-",
    ],
    ...(s.error ? [["error", s.error]] : []),
  ]);
}
