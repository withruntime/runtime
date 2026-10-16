import type { Sandbox as NativeSandbox } from "../sandbox.js";
import type {
  Execution as NativeExecution,
  ExecutionResult as NativeResult,
  InterpreterContext,
} from "../products/interpreter.js";
import { CompatibilityError, only } from "../compat/core.js";
import { sseStream } from "./streams.js";

type Language = "python" | "javascript" | "typescript";
export interface CreateContextOptions {
  language?: Language;
  cwd?: string;
  envVars?: Record<string, string | undefined>;
  timeout?: number;
}
export interface CodeContext {
  readonly id: string;
  readonly language: string;
  readonly cwd: string;
  readonly createdAt: Date;
  readonly lastUsed: Date;
}
export interface OutputMessage {
  text: string;
  timestamp: number;
}
export interface ExecutionError {
  name: string;
  message: string;
  traceback: string[];
  lineNumber?: number;
}
export interface RunCodeOptions {
  context?: CodeContext;
  language?: Language;
  envVars?: Record<string, string | undefined>;
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (output: OutputMessage) => void | Promise<void>;
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}

const FORMATS = {
  text: "text/plain",
  html: "text/html",
  png: "image/png",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  latex: "text/latex",
  markdown: "text/markdown",
  javascript: "application/javascript",
  json: "application/json",
} as const;
type Fields = { -readonly [K in keyof typeof FORMATS]?: K extends "json" ? unknown : string };

/** One rich result, as Cloudflare's: each format by name, the MIME bundle in
 * `data`. `chart` is never set on Runtime. */
export class Result implements Fields {
  text?: string;
  html?: string;
  png?: string;
  jpeg?: string;
  svg?: string;
  latex?: string;
  markdown?: string;
  javascript?: string;
  json?: unknown;
  chart?: undefined;
  data?: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    for (const [field, mime] of Object.entries(FORMATS))
      if (data[mime] !== undefined) (this as Record<string, unknown>)[field] = data[mime];
    this.data = data;
  }
  formats(): string[] {
    return Object.keys(FORMATS).filter((field) => (this as Record<string, unknown>)[field]);
  }
}

export class Execution {
  results: Result[] = [];
  logs: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  error?: ExecutionError;
  executionCount?: number;
  constructor(
    readonly code: string,
    readonly context: CodeContext,
  ) {}
  toJSON() {
    return {
      code: this.code,
      logs: this.logs,
      error: this.error,
      executionCount: this.executionCount,
      results: this.results.map((r) => ({
        text: r.text,
        html: r.html,
        png: r.png,
        jpeg: r.jpeg,
        svg: r.svg,
        latex: r.latex,
        markdown: r.markdown,
        javascript: r.javascript,
        json: r.json,
        chart: r.chart,
        data: r.data,
      })),
    };
  }
}

const context = (c: InterpreterContext): CodeContext => ({
  id: c.id,
  language: c.language,
  cwd: c.cwd,
  createdAt: new Date(c.startedAt),
  lastUsed: new Date(c.startedAt),
});
const failure = (e: { name: string; value: string; traceback: string }): ExecutionError => ({
  name: e.name,
  message: e.value,
  traceback: e.traceback ? e.traceback.split("\n") : [],
});
/** A run that ended without the code's own error still tells the caller why. */
const ended = (run: NativeExecution): ExecutionError | undefined =>
  run.status === "timeout"
    ? { name: "TimeoutError", message: "Execution timed out", traceback: [] }
    : run.status === "interrupted" || run.status === "lost"
      ? { name: "InterruptedError", message: `Execution ${run.status}`, traceback: [] }
      : undefined;
const TEXT_MIME = /^text\/|json|javascript|svg|latex/;
export const RUN_ENV =
  "envVars on a run; set them when making the context with createCodeContext({ envVars })";
export const hasEnv = (env: Record<string, string | undefined> | undefined) =>
  Object.values(env ?? {}).some((v) => v !== undefined);
function base64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 32768)
    raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(raw);
}

/** Cloudflare's code interpreter on Runtime's: Python, JavaScript and
 * TypeScript contexts whose variables persist between runs. */
export class CodeInterpreter {
  readonly #native: () => Promise<NativeSandbox>;
  constructor(sandbox: { native(): Promise<NativeSandbox> } | (() => Promise<NativeSandbox>)) {
    this.#native = typeof sandbox === "function" ? sandbox : () => sandbox.native();
  }
  async createCodeContext(options: CreateContextOptions = {}): Promise<CodeContext> {
    only("Cloudflare createCodeContext", options, ["language", "cwd", "envVars", "timeout"]);
    const language = this.#language(options.language);
    const s = await this.#native();
    return context(
      await s.interpreter.contexts.create(
        {
          language,
          cwd: options.cwd ?? "/workspace",
          env: Object.fromEntries(
            Object.entries(options.envVars ?? {}).filter(
              (e): e is [string, string] => e[1] !== undefined,
            ),
          ),
        },
        options.timeout !== undefined ? { timeoutMs: options.timeout } : {},
      ),
    );
  }
  async runCode(code: string, options: RunCodeOptions = {}): Promise<Execution> {
    if (hasEnv(options.envVars)) throw new CompatibilityError("Cloudflare", RUN_ENV);
    const { s, target } = await this.#prepare(options);
    const execution = new Execution(code, target);
    const run = await s.interpreter.run(code, {
      context: target.id,
      ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onStdout: (text) => {
        execution.logs.stdout.push(text);
        return options.onStdout?.({ text, timestamp: Date.now() });
      },
      onStderr: (text) => {
        execution.logs.stderr.push(text);
        return options.onStderr?.({ text, timestamp: Date.now() });
      },
      onResult: async (raw) => {
        const result = new Result(await this.#inline(s, raw));
        execution.results.push(result);
        return options.onResult?.(result);
      },
      onError: (raw) => {
        execution.error = failure(raw);
        return options.onError?.(execution.error);
      },
    });
    execution.executionCount = run.executionCount ?? undefined;
    if (!execution.error && ended(run)) {
      execution.error = ended(run);
      await options.onError?.(execution.error!);
    }
    return execution;
  }
  /** The run as Cloudflare's container streams it: `data:` lines of stdout,
   * stderr, result, error and execution_complete events. */
  async runCodeStream(code: string, options: RunCodeOptions = {}): Promise<ReadableStream> {
    if (hasEnv(options.envVars)) throw new CompatibilityError("Cloudflare", RUN_ENV);
    const { s, target } = await this.#prepare(options);
    return sseStream<Record<string, unknown>>(async (send, cancelled) => {
      const signal = options.signal ? AbortSignal.any([options.signal, cancelled]) : cancelled;
      const run = await s.interpreter.run(code, {
        context: target.id,
        signal,
        ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        onStdout: (text) => send({ type: "stdout", text, timestamp: Date.now() }),
        onStderr: (text) => send({ type: "stderr", text, timestamp: Date.now() }),
        onResult: async (raw) => {
          const { data: _data, ...fields } = new Result(await this.#inline(s, raw));
          send({ type: "result", ...fields, data: raw.data, timestamp: Date.now() });
        },
        onError: (e) =>
          send({ type: "error", ename: e.name, evalue: e.value, traceback: failure(e).traceback }),
      });
      const stop = ended(run);
      if (run.error === null && stop)
        send({ type: "error", ename: stop.name, evalue: stop.message, traceback: [] });
      send({ type: "execution_complete", execution_count: run.executionCount });
    });
  }
  async listCodeContexts(): Promise<CodeContext[]> {
    return (await (await this.#native()).interpreter.contexts.list()).map(context);
  }
  async deleteCodeContext(contextId: string): Promise<void> {
    await (await this.#native()).interpreter.contexts.remove(contextId);
  }
  #language(language: string | undefined): Language {
    if (language === undefined) return "python";
    if (!["python", "javascript", "typescript"].includes(language))
      throw new Error(
        `Unsupported language: ${language}. Supported languages: python, javascript, typescript`,
      );
    return language as Language;
  }
  async #prepare(options: RunCodeOptions) {
    only("Cloudflare runCode", options, [
      "context",
      "language",
      "envVars",
      "timeout",
      "signal",
      "onStdout",
      "onStderr",
      "onResult",
      "onError",
    ]);
    const s = await this.#native();
    // Each language's own name is Runtime's default context for it, started on first use.
    const language = this.#language(options.context?.language ?? options.language);
    const target = options.context ?? {
      id: language,
      language,
      cwd: "/workspace",
      createdAt: new Date(),
      lastUsed: new Date(),
    };
    return { s, target };
  }
  /** Large results travel by reference; Cloudflare's arrive inline. */
  async #inline(s: NativeSandbox, raw: NativeResult): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = { ...raw.data };
    for (const [mime, ref] of Object.entries(raw.refs ?? {})) {
      if (data[mime] !== undefined) continue;
      const bytes = await s.interpreter.result(ref);
      data[mime] = TEXT_MIME.test(mime) ? new TextDecoder().decode(bytes) : base64(bytes);
    }
    return data;
  }
}
