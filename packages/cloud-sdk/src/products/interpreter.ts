import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

export type InterpreterLanguage =
  "python" | "javascript" | "typescript" | "r" | "java" | "bash" | "go";
export type ResultRef = { path: string; bytes: number; sha256: string };
/** One rich result: a MIME bundle (text/plain, text/html, image/png as base64,
 * application/json, application/vnd.runtime.table+json for a DataFrame). */
export type ExecutionResult = {
  main: boolean;
  data: Record<string, unknown>;
  refs: Record<string, ResultRef>;
};
export type Execution = {
  id: string;
  contextId: string;
  language: InterpreterLanguage;
  executionCount: number | null;
  status: "ok" | "error" | "interrupted" | "timeout" | "lost";
  stdout: string;
  stderr: string;
  results: ExecutionResult[];
  error: { name: string; value: string; traceback: string } | null;
  overflow: { stream: "stdout" | "stderr"; path: string | null; bytes: number; dropped: number }[];
  durationMs: number;
  contextStarted: boolean;
  lostBytes: number;
};
export type InterpreterContext = {
  id: string;
  language: InterpreterLanguage;
  processId: string;
  cwd: string;
  state: string;
  startedAt: number;
};
export type RunOptions = RequestOptions & {
  language?: InterpreterLanguage;
  /** A context id; each language's own name ("python", "typescript", "r"...) is
   * its default context, started on first use. */
  context?: string;
  timeoutMs?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onResult?: (result: ExecutionResult) => void;
  onError?: (error: { name: string; value: string; traceback: string }) => void;
};
type Event =
  | { k: "start"; n: number }
  | { k: "stdout" | "stderr"; text: string }
  | ({ k: "result" } & ExecutionResult)
  | { k: "error"; name: string; value: string; traceback: string }
  | { k: "end" }
  | { k: "execution"; execution: Execution }
  | { k: "failure"; code: string; message: string; hint: string | null };

/** A stateful interpreter in the sandbox, in Python, JavaScript, TypeScript,
 * R, Java, Bash or Go:
 * `await sbx.interpreter.run("import pandas as pd; pd.DataFrame({'a': [1]})")`.
 * Variables persist between runs of the same context, like a notebook. */
export function sandboxInterpreter(t: Transport, sandbox: Sandbox) {
  const base = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/interpreter`;
  return {
    /** Run a cell. With any of the on* callbacks, output streams as it happens. */
    async run(code: string, options: RunOptions = {}): Promise<Execution> {
      const { language, context, timeoutMs, onStdout, onStderr, onResult, onError, ...request } =
        options;
      const body = {
        code,
        ...(language ? { language } : {}),
        ...(context ? { context } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      if (!onStdout && !onStderr && !onResult && !onError)
        return t.json<Execution>({ method: "POST", path: `${base()}:run`, body, ...request });
      for await (const event of t.events<Event>({
        method: "POST",
        path: `${base()}:run`,
        body: { ...body, stream: true },
        ...request,
      })) {
        if (event.k === "stdout") onStdout?.(event.text);
        else if (event.k === "stderr") onStderr?.(event.text);
        else if (event.k === "result")
          onResult?.({ main: event.main, data: event.data, refs: event.refs });
        else if (event.k === "error") onError?.(event);
        else if (event.k === "execution") return event.execution;
        else if (event.k === "failure") throw new Error(`${event.code}: ${event.message}`);
      }
      throw new Error("The interpreter stream ended without a result");
    },
    contexts: {
      list: async (options?: RequestOptions) =>
        (
          await t.json<{ data: InterpreterContext[] }>({
            method: "GET",
            path: `${base()}/contexts`,
            ...options,
          })
        ).data,
      create: (
        input: {
          id?: string;
          language?: InterpreterLanguage;
          cwd?: string;
          env?: Record<string, string>;
        } = {},
        options?: RequestOptions,
      ) =>
        t.json<InterpreterContext>({
          method: "POST",
          path: `${base()}/contexts`,
          body: input,
          ...options,
        }),
      restart: (id: string, options?: RequestOptions) =>
        t.json<InterpreterContext>({
          method: "POST",
          path: `${base()}/contexts/${encodeURIComponent(id)}:restart`,
          body: {},
          ...options,
        }),
      interrupt: (id: string, options?: RequestOptions) =>
        t.json<{ interrupted: boolean }>({
          method: "POST",
          path: `${base()}/contexts/${encodeURIComponent(id)}:interrupt`,
          body: {},
          ...options,
        }),
      remove: (id: string, options?: RequestOptions) =>
        t.json<{ deleted: boolean }>({
          method: "DELETE",
          path: `${base()}/contexts/${encodeURIComponent(id)}`,
          ...options,
        }),
    },
    /** The bytes of a result too large to travel inline (a `refs` entry). */
    result(ref: ResultRef | { path: string }, options?: RequestOptions): Promise<Uint8Array> {
      const match =
        /^\/workspace\/\.runtime\/interpreter\/([a-z0-9][a-z0-9-]*)\/out\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(
          ref.path,
        );
      if (!match) throw new Error("Not an interpreter result path");
      return t.bytes({
        method: "GET",
        path: `${base()}/contexts/${match[1]}/results/${match[2]}`,
        ...options,
      });
    },
  };
}
