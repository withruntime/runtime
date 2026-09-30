/** Four tools bound to one Runtime sandbox, in no framework's format: a name,
 * a description, a JSON Schema and a function. The adapters for the Vercel AI
 * SDK (and Mastra), the Claude Agent SDK and the OpenAI Agents SDK wrap these,
 * and any other framework can too:
 *
 *   import { sandboxTools } from "withruntime/tools";
 *   for (const t of sandboxTools(sbx)) register(t.name, t.description, t.inputSchema, t.execute);
 *
 * The application creates the sandbox and binds the tools to it: the model
 * chooses commands and paths, never the sandbox, the account or the key.
 * Relative paths are under /workspace, and output is capped so one noisy
 * command cannot flood the model's context. */
import { TOOL_EXEC_TIMEOUT_SECONDS } from "../api-defaults.js";
import { NotFoundError } from "../errors.js";
import type { Sandbox } from "../sandbox.js";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, { type: "string" | "integer"; description: string; minimum?: number }>;
  required: string[];
  additionalProperties: false;
};

export type SandboxTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Input): Promise<Output>;
};

export type ExecInput = { command: string; cwd?: string; timeoutSeconds?: number };
export type ExecOutput = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export type ListEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
};

export type SandboxToolOptions = {
  /** Where relative paths resolve. Default /workspace. */
  root?: string;
  /** For a command that names no timeout. Default 300. */
  timeoutSeconds?: number;
  /** Characters kept from each of stdout, stderr and a file read; the rest is cut from the front. Default 20 000. */
  maxOutputChars?: number;
};

export type SandboxTools = [
  SandboxTool<ExecInput, ExecOutput>,
  SandboxTool<{ path: string }, string>,
  SandboxTool<{ path: string; content: string }, string>,
  SandboxTool<{ path?: string; depth?: number }, ListEntry[] | { error: string }>,
];

const WORKSPACE = "/workspace";

/** A POSIX path joined and normalized: `..` cannot climb past `/`. */
export function resolvePath(root: string, path: string | undefined): string {
  const joined = (path ?? ".").startsWith("/") ? path! : `${root}/${path ?? "."}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `[${text.length - limit} earlier characters omitted]\n${text.slice(-limit)}`;
}

/** runtime_exec, runtime_read_file, runtime_write_file and runtime_list_files, bound to `sandbox`. */
export function sandboxTools(sandbox: Sandbox, options: SandboxToolOptions = {}): SandboxTools {
  const root = resolvePath("/", options.root ?? WORKSPACE);
  const timeoutSeconds = options.timeoutSeconds ?? TOOL_EXEC_TIMEOUT_SECONDS;
  const limit = options.maxOutputChars ?? 20_000;
  const inFilesApi = (path: string) => path.startsWith(`${WORKSPACE}/`);
  return [
    {
      name: "runtime_exec",
      description:
        "Run a shell command (bash) in the sandbox and return its exit code, stdout and stderr.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command line, run under `bash -c`, for example `pytest -q`.",
          },
          cwd: {
            type: "string",
            description: "Directory to run in. Relative paths are under /workspace, the default.",
          },
          timeoutSeconds: {
            type: "integer",
            minimum: 1,
            description: "Seconds before the command is stopped and reported as timed out.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute({ command, cwd, timeoutSeconds: seconds }) {
        const result = await sandbox.exec(command, {
          cwd: resolvePath(root, cwd),
          timeoutMs: (seconds ?? timeoutSeconds) * 1000,
        });
        return {
          exitCode: result.exitCode,
          stdout: clip(result.stdout, limit),
          stderr: clip(result.stderr, limit),
          timedOut: result.timedOut,
        };
      },
    },
    {
      name: "runtime_read_file",
      description: "Read a text file from the sandbox.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file's path. Relative paths are under /workspace.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute({ path }) {
        const target = resolvePath(root, path);
        if (inFilesApi(target)) {
          try {
            return clip(await sandbox.files.readText(target), limit);
          } catch (error) {
            if (error instanceof NotFoundError) return `No such file: ${target}`;
            throw error;
          }
        }
        const result = await sandbox.exec(["cat", "--", target]);
        return clip(result.exitCode === 0 ? result.stdout : result.stderr, limit);
      },
    },
    {
      name: "runtime_write_file",
      description: "Create or replace a text file in the sandbox, making parent directories.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file's path. Relative paths are under /workspace.",
          },
          content: { type: "string", description: "The file's full new content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute({ path, content }) {
        const target = resolvePath(root, path);
        if (inFilesApi(target)) await sandbox.files.write(target, content);
        else {
          const result = await sandbox.exec(
            ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", target],
            { stdin: content },
          );
          if (result.exitCode !== 0) return `Could not write ${target}: ${result.stderr.trim()}`;
        }
        return `Wrote ${new TextEncoder().encode(content).length} bytes to ${target}`;
      },
    },
    {
      name: "runtime_list_files",
      description: "List a directory in the sandbox: each entry's path, type and size.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The directory. Relative paths are under /workspace, the default.",
          },
          depth: {
            type: "integer",
            minimum: 1,
            description: "How many levels below it to include; 1 lists only its children.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute({ path, depth }) {
        const levels = String(Math.max(1, Math.min(depth ?? 1, 10)));
        const result = await sandbox.exec([
          "sh",
          "-c",
          'find "$1" -mindepth 1 -maxdepth "$2" -printf "%y\\t%s\\t%p\\n" | sort -k3 | head -n 1000',
          "sh",
          resolvePath(root, path),
          levels,
        ]);
        if (result.exitCode !== 0 && !result.stdout)
          return { error: result.stderr.trim() || `find exited with ${result.exitCode}` };
        const kinds: Record<string, ListEntry["type"]> = {
          f: "file",
          d: "directory",
          l: "symlink",
        };
        return result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [kind = "", size = "0", ...rest] = line.split("\t");
            return { path: rest.join("\t"), type: kinds[kind] ?? "other", size: Number(size) || 0 };
          });
      },
    },
  ];
}
