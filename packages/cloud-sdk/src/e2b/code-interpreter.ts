/** `@e2b/code-interpreter`, on Runtime. Change the import:
 *
 *   import { Sandbox } from "withruntime/e2b/code-interpreter";
 *
 * runCode runs in Runtime's interpreter (sandbox.runtime.interpreter):
 * stateful contexts in every E2B interpreter language. */
import type { Runtime } from "../client.js";
import type { InterpreterLanguage } from "../products/interpreter.js";
import type { ConnectionOpts } from "./client.js";
import { guard, NotSupportedError, SandboxError, TimeoutError } from "./errors.js";
import { bind } from "./index.js";
import { Sandbox as BaseSandbox } from "./sandbox.js";

export * from "./index.js";

type RuntimeInterpreter = BaseSandbox["runtime"]["interpreter"];
type RuntimeExecution = Awaited<ReturnType<RuntimeInterpreter["run"]>>;
type RuntimeResult = RuntimeExecution["results"][number];

export type RunCodeLanguage =
  "python" | "javascript" | "typescript" | "r" | "java" | "bash" | (string & {});

/** A line of output, as E2B's callbacks receive it. */
export class OutputMessage {
  constructor(
    readonly line: string,
    /** Unix epoch in microseconds (from the client's clock), as in E2B. */
    readonly timestamp: number,
    readonly error: boolean,
  ) {}
  toString(): string {
    return this.line;
  }
}

export class ExecutionError {
  constructor(
    public name: string,
    public value: string,
    public traceback: string,
  ) {}
}

export type MIMEType = string;
export type RawData = { [key: MIMEType]: unknown };

const FORMATS: Record<string, keyof ResultFields> = {
  "text/plain": "text",
  "text/html": "html",
  "text/markdown": "markdown",
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "application/pdf": "pdf",
  "text/latex": "latex",
  "application/json": "json",
  "application/javascript": "javascript",
};
type ResultFields = {
  text?: string;
  html?: string;
  markdown?: string;
  svg?: string;
  png?: string;
  jpeg?: string;
  pdf?: string;
  latex?: string;
  json?: string;
  javascript?: string;
};

/** One rich result, as E2B's: text, html, png (base64) and the rest. `chart`
 * and E2B's `data` (its own DataFrame format) are never set on Runtime; a
 * DataFrame arrives in `extra` under application/vnd.runtime.table+json. */
export class Result implements ResultFields {
  readonly isMainResult: boolean;
  readonly text?: string;
  readonly html?: string;
  readonly markdown?: string;
  readonly svg?: string;
  readonly png?: string;
  readonly jpeg?: string;
  readonly pdf?: string;
  readonly latex?: string;
  readonly json?: string;
  readonly javascript?: string;
  readonly data?: Record<string, unknown>;
  readonly chart?: undefined;
  readonly extra?: Record<string, unknown>;
  readonly raw: RawData;
  constructor(rawData: RawData, isMainResult: boolean) {
    this.raw = rawData;
    this.isMainResult = isMainResult;
    const extra: Record<string, unknown> = {};
    const fields: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(rawData)) {
      const field = FORMATS[mime];
      if (field) fields[field] = value;
      else extra[mime] = value;
    }
    Object.assign(this, fields);
    if (Object.keys(extra).length) this.extra = extra;
  }
  formats(): string[] {
    return [
      ...Object.values(FORMATS).filter((field) => this[field] !== undefined),
      ...Object.keys(this.extra ?? {}),
    ];
  }
  toJSON() {
    return {
      text: this.text,
      html: this.html,
      markdown: this.markdown,
      svg: this.svg,
      png: this.png,
      jpeg: this.jpeg,
      pdf: this.pdf,
      latex: this.latex,
      json: this.json,
      javascript: this.javascript,
      ...(this.extra ? { extra: this.extra } : {}),
    };
  }
}

export type Logs = { stdout: string[]; stderr: string[] };

export class Execution {
  constructor(
    public results: Result[] = [],
    public logs: Logs = { stdout: [], stderr: [] },
    public error?: ExecutionError,
    public executionCount?: number,
  ) {}
  /** The main result's text. */
  get text(): string | undefined {
    return this.results.find((result) => result.isMainResult)?.text;
  }
  toJSON() {
    return { results: this.results, logs: this.logs, error: this.error };
  }
}

export type Context = { id: string; language: string; cwd: string };

export interface RunCodeOpts {
  onStdout?: (output: OutputMessage) => unknown;
  onStderr?: (output: OutputMessage) => unknown;
  onResult?: (data: Result) => unknown;
  onError?: (error: ExecutionError) => unknown;
  /** Refused when set: Runtime's contexts take their environment when made. */
  envs?: Record<string, string>;
  /** Default 60 000, as in E2B. */
  timeoutMs?: number;
  /** Deadline for receiving response headers; 0 disables it. */
  requestTimeoutMs?: number;
}
export interface CreateCodeContextOpts {
  cwd?: string;
  language?: RunCodeLanguage;
  requestTimeoutMs?: number;
}

const TEXT_MIME = /^text\/|json|javascript|svg|latex/;

/** Output as E2B's logs: one entry per line, each keeping its newline. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function language(requested: RunCodeLanguage | undefined): InterpreterLanguage {
  const selected = requested === "js" ? "javascript" : (requested ?? "python");
  if (["python", "javascript", "typescript", "r", "java", "bash", "go"].includes(selected))
    return selected as InterpreterLanguage;
  throw new NotSupportedError(
    `Running ${requested} code in the interpreter`,
    "Use Python, JavaScript, TypeScript, R, Java, Bash or Go.",
  );
}

/** The code interpreter sandbox: everything the base Sandbox has, plus runCode
 * and code contexts. */
export class Sandbox extends BaseSandbox {
  protected static override readonly defaultTemplate: string = "code-interpreter-v1";
  get #interpreter(): RuntimeInterpreter {
    return this.runtime.interpreter;
  }

  async #inline(result: RuntimeResult): Promise<RawData> {
    const data: RawData = { ...result.data };
    for (const [mime, ref] of Object.entries(result.refs ?? {})) {
      if (data[mime] !== undefined) continue;
      const bytes = await guard("sandbox", () => this.#interpreter.result(ref));
      data[mime] = TEXT_MIME.test(mime)
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("base64");
    }
    return data;
  }

  /** Runs code in a stateful context. Errors in the code come back in
   * `execution.error`, as in E2B; a run past `timeoutMs` throws TimeoutError. */
  async runCode(
    code: string,
    opts: RunCodeOpts & { language?: RunCodeLanguage; context?: Context } = {},
  ): Promise<Execution> {
    if (opts.language !== undefined && opts.context !== undefined)
      throw new SandboxError("Pass language or context, not both.");
    if (opts.envs && Object.keys(opts.envs).length)
      throw new NotSupportedError(
        "Environment variables for one run (runCode envs)",
        "Make a context with them: sandbox.runtime.interpreter.contexts.create({ env }), then runCode(code, { context: { id } }).",
      );
    const lang = language(opts.context?.language ?? opts.language);
    const context = opts.context?.id;
    const now = () => Date.now() * 1_000;
    const streamedResults: Result[] = [];
    const controller = new AbortController();
    const requestTimeout = opts.requestTimeoutMs ?? this.requestTimeoutMs;
    const timeout = opts.timeoutMs ?? 60_000;
    let stage = "Request";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (milliseconds: number) => {
      clearTimeout(timer);
      if (milliseconds) timer = setTimeout(() => controller.abort(), milliseconds);
    };
    arm(requestTimeout);
    let execution: RuntimeExecution;
    try {
      execution = await guard("sandbox", () =>
        this.#interpreter.run(code, {
          ...(context ? { context } : { language: lang }),
          // E2B times out its reader; it does not send a kernel deadline.
          timeoutMs: 0,
          requestTimeoutMs: 0,
          interruptOnDisconnect: false,
          signal: controller.signal,
          onResponse: () => {
            stage = "Execution";
            arm(timeout);
          },
          // Stream even without callbacks: the header/body deadlines are separate.
          onStdout: (text: string) => opts.onStdout?.(new OutputMessage(text, now(), false)),
          onStderr: (text: string) => opts.onStderr?.(new OutputMessage(text, now(), true)),
          onError: (error: { name: string; value: string; traceback: string }) =>
            opts.onError?.(new ExecutionError(error.name, error.value, error.traceback)),
          onResult: async (result: RuntimeResult) => {
            const mapped = new Result(await this.#inline(result), result.main);
            streamedResults.push(mapped);
            await opts.onResult?.(mapped);
          },
        }),
      );
    } catch (error) {
      if (controller.signal.aborted)
        throw new TimeoutError(
          `${stage} timed out — the '${stage === "Request" ? "requestTimeoutMs" : "timeoutMs"}' option can be used to increase this timeout`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (execution.status === "timeout")
      throw new TimeoutError(
        `Execution timed out after ${opts.timeoutMs ?? 60_000} ms: pass a larger 'timeoutMs'.`,
      );
    if (execution.status === "lost")
      throw new SandboxError("The interpreter lost this run (its context stopped); run it again.");
    const results =
      streamedResults.length === execution.results.length
        ? streamedResults
        : await Promise.all(
            execution.results.map(
              async (result) => new Result(await this.#inline(result), result.main),
            ),
          );
    return new Execution(
      results,
      { stdout: lines(execution.stdout), stderr: lines(execution.stderr) },
      execution.error
        ? new ExecutionError(execution.error.name, execution.error.value, execution.error.traceback)
        : undefined,
      execution.executionCount ?? undefined,
    );
  }

  async createCodeContext(opts: CreateCodeContextOpts = {}): Promise<Context> {
    const lang = language(opts.language);
    const made = await guard("sandbox", () =>
      this.#interpreter.contexts.create({
        language: lang,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      }),
    );
    return { id: made.id, language: made.language, cwd: made.cwd };
  }

  async removeCodeContext(context: Context | string): Promise<void> {
    const id = typeof context === "string" ? context : context.id;
    await guard("sandbox", () => this.#interpreter.contexts.remove(id));
  }

  async listCodeContexts(): Promise<Context[]> {
    const contexts = await guard("sandbox", () => this.#interpreter.contexts.list());
    return contexts.map((one) => ({ id: one.id, language: one.language, cwd: one.cwd }));
  }

  async restartCodeContext(context: Context | string): Promise<void> {
    const id = typeof context === "string" ? context : context.id;
    await guard("sandbox", () => this.#interpreter.contexts.restart(id));
  }
}
export default Sandbox;

/** E2B's client with bound options, for the code interpreter. */
export class E2B {
  readonly Sandbox: typeof Sandbox;
  constructor(opts: Omit<ConnectionOpts, "signal"> & { client?: Runtime } = {}) {
    this.Sandbox = bind(Sandbox, opts);
  }
}
