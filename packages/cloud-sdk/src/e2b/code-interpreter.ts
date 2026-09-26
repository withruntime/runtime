/** `@e2b/code-interpreter`, on Runtime. Change the import:
 *
 *   import { Sandbox } from "withruntime/e2b/code-interpreter";
 *
 * runCode runs in Runtime's interpreter (sandbox.runtime.interpreter):
 * stateful Python and JavaScript contexts, as in E2B. Other languages throw
 * NotSupportedError. */
import type { Runtime } from "../client.js";
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
    /** Unix epoch in nanoseconds (from the client's clock). */
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
  /** Accepted and ignored: Runtime's SDK allows the run its timeout plus a minute. */
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

function language(requested: RunCodeLanguage | undefined): "python" | "javascript" {
  if (requested === undefined || requested === "python") return "python";
  if (requested === "javascript" || requested === "js") return "javascript";
  throw new NotSupportedError(
    `Running ${requested} code in the interpreter`,
    requested === "bash"
      ? "Use sandbox.commands.run(code)."
      : "Runtime's interpreter runs Python and JavaScript; install the language and run it with sandbox.commands.run(...).",
  );
}

/** The code interpreter sandbox: everything the base Sandbox has, plus runCode
 * and code contexts. */
export class Sandbox extends BaseSandbox {
  protected static override readonly defaultTemplate: string = "code-interpreter-v1";
  /** Contexts made to carry the sandbox's envs, one per language. */
  readonly #envContexts = new Map<string, Promise<string>>();

  get #interpreter(): RuntimeInterpreter {
    return this.runtime.interpreter;
  }

  /** The context a run goes to: the one asked for; else, when the sandbox has
   * envs, a context made once with them; else Runtime's default one. */
  async #contextFor(lang: "python" | "javascript", context: Context | undefined) {
    if (context) return context.id;
    if (!Object.keys(this.envs).length) return undefined;
    let id = this.#envContexts.get(lang);
    if (!id) {
      id = guard("sandbox", async () => {
        const made = await this.#interpreter.contexts.create({
          id: `e2b-${lang}`,
          language: lang,
          env: this.envs,
        });
        return made.id;
      }).catch(async (error: unknown) => {
        // Made already, by another object connected to this sandbox.
        const existing = (await this.#interpreter.contexts.list()).find(
          (one) => one.id === `e2b-${lang}`,
        );
        if (existing) return existing.id;
        throw error;
      });
      this.#envContexts.set(lang, id);
    }
    return id;
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
    const context = await this.#contextFor(lang, opts.context);
    const now = () => Date.now() * 1_000_000;
    const streaming = opts.onStdout || opts.onStderr || opts.onResult || opts.onError;
    const execution = await guard("sandbox", () =>
      this.#interpreter.run(code, {
        ...(context ? { context } : { language: lang }),
        timeoutMs: opts.timeoutMs ?? 60_000,
        ...(streaming
          ? {
              onStdout: (text: string) =>
                void opts.onStdout?.(new OutputMessage(text, now(), false)),
              onStderr: (text: string) =>
                void opts.onStderr?.(new OutputMessage(text, now(), true)),
              onError: (error: { name: string; value: string; traceback: string }) =>
                void opts.onError?.(new ExecutionError(error.name, error.value, error.traceback)),
            }
          : {}),
      }),
    );
    if (execution.status === "timeout")
      throw new TimeoutError(
        `Execution timed out after ${opts.timeoutMs ?? 60_000} ms: pass a larger 'timeoutMs'.`,
      );
    if (execution.status === "lost")
      throw new SandboxError("The interpreter lost this run (its context stopped); run it again.");
    const results = await Promise.all(
      execution.results.map(async (result) => new Result(await this.#inline(result), result.main)),
    );
    if (opts.onResult) for (const result of results) await opts.onResult(result);
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
        ...(Object.keys(this.envs).length ? { env: this.envs } : {}),
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
