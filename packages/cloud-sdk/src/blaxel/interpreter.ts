import type { ExecutionResult } from "../products/interpreter.js";
import { ENV_FILE, parseEnvFile } from "./context.js";
import { guard, isNotFound, NotSupportedError, ResponseError } from "./errors.js";
import { SandboxInstance } from "./sandbox.js";
import type {
  Port,
  Sandbox as SandboxModel,
  SandboxCreateConfiguration,
  SandboxLifecycle,
} from "./types.js";

/* Blaxel's CodeInterpreter over Runtime's interpreter
   (sandbox.withruntime.interpreter): stateful contexts, as a Jupyter server
   keeps them, with the same result classes. No Jupyter server runs; the
   sandbox itself is a Runtime sandbox with every SandboxInstance method. */

type Language = "python" | "javascript" | "typescript" | "r" | "java" | "bash" | "go";
const LANGUAGES = new Set<string>([
  "python",
  "javascript",
  "typescript",
  "r",
  "java",
  "bash",
  "go",
]);
const TEXT_MIME = /^text\/|json|javascript|svg|latex/;
/** A MIME bundle's keys, as Blaxel's Jupyter server names them. */
const FIELDS: Record<string, string> = {
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

function languageOf(requested: string | null | undefined): Language {
  const language = requested ?? "python";
  if (language === "js") return "javascript";
  if (language === "ts") return "typescript";
  if (!LANGUAGES.has(language))
    throw new NotSupportedError(
      `Running ${language} code in the interpreter`,
      "Runtime's interpreter runs Python, JavaScript, TypeScript, R, Java, Bash and Go; run anything else with sandbox.process.exec.",
    );
  return language as Language;
}

class OutputMessage {
  constructor(
    public text: string,
    public timestamp: number | null,
    public isStderr: boolean,
  ) {}
}
class Result {
  [key: string]: unknown;
  constructor(kwargs: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(kwargs)) this[key] = value;
  }
}
class ExecutionError {
  constructor(
    public name: string,
    public value: unknown,
    public traceback: unknown,
  ) {}
}
class Logs {
  stdout: string[] = [];
  stderr: string[] = [];
}
class Execution {
  results: Result[] = [];
  logs = new Logs();
  error: ExecutionError | null = null;
  executionCount: number | null = null;
}
class Context {
  constructor(public id: string) {}
  static fromJson(data: Record<string, unknown>): Context {
    const id = data.id ?? data.context_id;
    return new Context(typeof id === "string" || typeof id === "number" ? String(id) : "");
  }
}

/** Output as the Jupyter server reports it: one entry per line. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A sandbox that runs code, as Blaxel's CodeInterpreter. */
export class CodeInterpreter extends SandboxInstance {
  static readonly DEFAULT_IMAGE = "blaxel/jupyter-server";
  static readonly DEFAULT_PORTS: Port[] = [{ name: "jupyter", target: 8888, protocol: "HTTP" }];
  static readonly DEFAULT_LIFECYCLE: SandboxLifecycle = {
    expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }],
  };
  static readonly OutputMessage = OutputMessage;
  static readonly Result = Result;
  static readonly ExecutionError = ExecutionError;
  static readonly Logs = Logs;
  static readonly Execution = Execution;
  static readonly Context = Context;

  /** Contexts made to carry the sandbox's envs, one per language. */
  #envContexts = new Map<Language, Promise<string | undefined>>();
  #envs: Promise<Record<string, string>> | undefined;

  /** Blaxel's defaults for a code interpreter: its image, port 8888, and
   * deletion after 30 idle minutes (a paused sandbox kept one day). */
  static override async create<T extends typeof SandboxInstance>(
    this: T,
    sandbox?: SandboxCreateConfiguration | SandboxModel | Record<string, unknown> | null,
    options: { safe?: boolean; createIfNotExist?: boolean } = {},
  ): Promise<InstanceType<T>> {
    const defaults: SandboxCreateConfiguration = {
      image: CodeInterpreter.DEFAULT_IMAGE,
      ports: CodeInterpreter.DEFAULT_PORTS,
      lifecycle: CodeInterpreter.DEFAULT_LIFECYCLE,
    };
    let merged: SandboxCreateConfiguration | SandboxModel = defaults;
    if (sandbox && typeof sandbox === "object") {
      if ("metadata" in sandbox || "spec" in sandbox) {
        const model = sandbox as SandboxModel;
        merged = {
          ...model,
          spec: {
            ...model.spec,
            runtime: { image: defaults.image!, ports: defaults.ports!, ...model.spec?.runtime },
            lifecycle: model.spec?.lifecycle ?? defaults.lifecycle!,
          },
        } as SandboxModel;
      } else merged = { ...defaults, ...(sandbox as SandboxCreateConfiguration) };
    }
    return super.create.call(this, merged, options) as Promise<InstanceType<T>>;
  }

  get _jupyterUrl(): string {
    throw new NotSupportedError(
      "The Jupyter server's address (_jupyterUrl)",
      "No Jupyter server runs: use runCode, or sandbox.withruntime.interpreter.",
    );
  }

  get #interpreter() {
    return this.withruntime.interpreter;
  }

  /** The sandbox's envs: those this object set, else the env file's. */
  #sandboxEnvs(): Promise<Record<string, string>> {
    const known = this.spec.runtime?.envs;
    if (known)
      return Promise.resolve(Object.fromEntries(known.map((e) => [e.name!, e.value ?? ""])));
    this.#envs ??= this.fs.read(ENV_FILE).then(parseEnvFile, (error: unknown) => {
      if (isNotFound(error)) return {};
      throw error;
    });
    return this.#envs;
  }

  /** The context a run goes to: the one asked for; else, when the sandbox has
   * envs, a context made once with them; else Runtime's default one. */
  async #contextFor(language: Language): Promise<string | undefined> {
    let id = this.#envContexts.get(language);
    if (!id) {
      id = (async () => {
        const envs = await this.#sandboxEnvs();
        if (!Object.keys(envs).length) return undefined;
        const wanted = `blaxel-${language}`;
        try {
          return (
            await guard(() =>
              this.#interpreter.contexts.create({ id: wanted, language, env: envs }),
            )
          ).id;
        } catch (error) {
          // Made already, by another object for this sandbox.
          if (!(error instanceof ResponseError && error.status === 409)) throw error;
          return wanted;
        }
      })();
      this.#envContexts.set(language, id);
      id.catch(() => this.#envContexts.delete(language));
    }
    return id;
  }

  async #inline(result: ExecutionResult): Promise<Result> {
    const data: Record<string, unknown> = { ...result.data };
    for (const [mime, ref] of Object.entries(result.refs ?? {})) {
      if (data[mime] !== undefined) continue;
      const bytes = await guard(() => this.#interpreter.result(ref));
      data[mime] = TEXT_MIME.test(mime)
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("base64");
    }
    const fields: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(data)) {
      const field = FIELDS[mime];
      if (field) fields[field] = value;
      else if (mime === "application/vnd.runtime.table+json") fields.data = value;
      else extra[mime] = value;
    }
    return new Result({
      ...fields,
      ...(Object.keys(extra).length ? { extra } : {}),
      is_main_result: result.main,
    });
  }

  /** Runs code in a stateful context. Errors in the code come back in
   * `execution.error`; a run past `timeout` seconds (default 60, 0 for none)
   * throws "Request timeout", as in Blaxel. */
  async runCode(
    code: string,
    options: {
      language?: string | null;
      context?: Context | null;
      onStdout?: (msg: OutputMessage) => void;
      onStderr?: (msg: OutputMessage) => void;
      onResult?: (result: Result) => void;
      onError?: (error: ExecutionError) => void;
      envs?: Record<string, string> | null;
      timeout?: number | null;
      requestTimeout?: number | null;
    } = {},
  ): Promise<Execution> {
    if (options.language && options.context)
      throw new Error("You can provide context or language, but not both at the same time.");
    if (options.envs && Object.keys(options.envs).length)
      throw new NotSupportedError(
        "Environment variables for one run (runCode envs)",
        "Set them in the sandbox's envs at create (every context gets them), or in the code (os.environ).",
      );
    const language = languageOf(options.language);
    const context = options.context?.id ?? (await this.#contextFor(language));
    const timeout = options.timeout === 0 ? null : (options.timeout ?? 60);
    const now = () => Date.now() / 1000;
    const streaming = options.onStdout || options.onStderr || options.onError;
    const execution = await guard(() =>
      this.#interpreter.run(code, {
        ...(context ? { context } : { language }),
        ...(timeout === null
          ? { timeoutMs: 86_400_000 }
          : { timeoutMs: Math.ceil(timeout * 1000) }),
        ...(streaming
          ? {
              onStdout: (text: string) => options.onStdout?.(new OutputMessage(text, now(), false)),
              onStderr: (text: string) => options.onStderr?.(new OutputMessage(text, now(), true)),
              onError: (error: { name: string; value: string; traceback: string }) =>
                options.onError?.(new ExecutionError(error.name, error.value, error.traceback)),
            }
          : {}),
      }),
    );
    if (execution.status === "timeout") throw new Error("Request timeout");
    if (execution.status === "lost")
      throw new Error("The interpreter lost this run (its context stopped); run it again.");
    const out = new Execution();
    out.results = await Promise.all(execution.results.map((result) => this.#inline(result)));
    if (options.onResult) for (const result of out.results) options.onResult(result);
    out.logs.stdout = lines(execution.stdout);
    out.logs.stderr = lines(execution.stderr);
    if (execution.error) {
      out.error = new ExecutionError(
        execution.error.name,
        execution.error.value,
        execution.error.traceback,
      );
      if (!streaming) options.onError?.(out.error);
    }
    out.executionCount = execution.executionCount;
    return out;
  }

  /** A new context: its own variables, directory and the sandbox's envs. */
  async createCodeContext(
    options: { cwd?: string | null; language?: string | null; requestTimeout?: number | null } = {},
  ): Promise<Context> {
    const language = languageOf(options.language);
    const envs = await this.#sandboxEnvs();
    const cwd = options.cwd ? options.cwd.replace(/^\/blaxel(?=\/|$)/, "/workspace") : undefined;
    const made = await guard(() =>
      this.#interpreter.contexts.create({
        language,
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(envs).length ? { env: envs } : {}),
      }),
    );
    return new Context(made.id);
  }
}
