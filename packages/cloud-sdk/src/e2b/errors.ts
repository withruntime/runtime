import { RuntimeError } from "../errors.js";

/* E2B's error classes, by the same names and with the same parents, so a
   `catch (e) { if (e instanceof CommandExitError) ... }` written for E2B keeps
   working. Each one made from a Runtime answer also carries Runtime's own
   `code`, `hint` and `requestId`, and the original error as `cause`. */

type Detail = { code?: string; hint?: string; requestId?: string; cause?: unknown };

function attach(error: Error, detail: Detail) {
  const target = error as Error & Detail;
  if (detail.code !== undefined) target.code = detail.code;
  if (detail.hint !== undefined) target.hint = detail.hint;
  if (detail.requestId !== undefined) target.requestId = detail.requestId;
  if (detail.cause !== undefined) target.cause = detail.cause;
}

/** Base class for E2B's sandbox errors. */
export class SandboxError extends Error {
  statusCode?: number;
  code?: string;
  hint?: string;
  requestId?: string;
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class TimeoutError extends SandboxError {}
export class InvalidArgumentError extends SandboxError {}
export class NotEnoughSpaceError extends SandboxError {}
export class NotFoundError extends SandboxError {}
export class FileNotFoundError extends NotFoundError {}
export class SandboxNotFoundError extends NotFoundError {}
export class TemplateError extends SandboxError {}
export class RateLimitError extends SandboxError {}
/** E2B's AuthenticationError extends Error, not SandboxError. */
export class AuthenticationError extends Error {
  code?: string;
  hint?: string;
  requestId?: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** E2B's ServiceBusyError extends Error, not SandboxError. */
export class ServiceBusyError extends Error {
  readonly statusCode = 503;
  code?: string;
  hint?: string;
  requestId?: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A call that E2B supports and Runtime does not, or not in the same way.
 * Thrown before anything is done, never after doing something different.
 * `feature` names what was asked for; `alternative` says what to use on
 * Runtime instead. */
export class NotSupportedError extends SandboxError {
  readonly feature: string;
  readonly alternative: string;
  constructor(feature: string, alternative: string, message?: string) {
    super(message ?? `${feature} is not supported on Runtime. ${alternative}`);
    this.feature = feature;
    this.alternative = alternative;
    this.code = "not_supported";
  }
}

/** Runtime's addition, for `getHost` and `getPublicHost`: a free-trial
 * sandbox shares a port only privately, so a request needs the port's token,
 * and a host name alone cannot carry one. The message says what works. A
 * NotSupportedError, so code that catches those catches this too. */
export class PublicPreviewNotAllowedError extends NotSupportedError {
  constructor(sandboxId: string, port: number | undefined, message?: string) {
    const where = port === undefined ? "<port>" : String(port);
    const alternative =
      `For an address that works on the trial, use (await sandbox.runtime.previews.create(${where})).urlWithToken: ` +
      "it carries the token, in a browser, fetch or curl. For other paths on it, send the token as the " +
      "x-runtime-preview-token header or the runtime_preview_token query parameter. A public host needs a paid " +
      "sandbox, which is the account owner's decision.";
    super(
      "A public address on a free-trial sandbox",
      alternative,
      message ??
        `Sandbox ${sandboxId} runs on the free trial, where a shared port is private: every request needs the ` +
          `port's token, and a host name alone cannot carry one. ${alternative}`,
    );
    this.code = "public_preview_not_allowed";
  }
}

/** What `commands.run` resolves with, as in E2B. */
export interface CommandResult {
  exitCode: number;
  error?: string;
  stdout: string;
  stderr: string;
  /** Runtime's addition, present only when true: some of the command's
   * output was dropped before it was read, so `stdout` and `stderr` are
   * missing part of it. A warning says so too. */
  truncated?: true;
}

/** Thrown by `commands.run` and `CommandHandle.wait` when the command exits
 * with a code other than 0. It carries the result, as in E2B. */
export class CommandExitError extends SandboxError implements CommandResult {
  readonly #result: CommandResult;
  constructor(result: CommandResult) {
    super(result.error);
    this.#result = result;
  }
  get exitCode(): number {
    return this.#result.exitCode;
  }
  get error(): string | undefined {
    return this.#result.error;
  }
  get stdout(): string {
    return this.#result.stdout;
  }
  get stderr(): string {
    return this.#result.stderr;
  }
  get truncated(): true | undefined {
    return this.#result.truncated;
  }
}

/** Which object a call was about, to name a 404 the way E2B would. */
export type Subject = "sandbox" | "file" | "other";

/** Turns a Runtime SDK error into the E2B error a caller written for E2B
 * expects. Anything that is not a Runtime error passes through unchanged. */
export function translate(error: unknown, subject: Subject = "other"): unknown {
  if (!(error instanceof RuntimeError)) return error;
  const message = [
    error.message,
    error.hint ? `Hint: ${error.hint}` : "",
    error.requestId ? `Request: ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let out: Error;
  if (error.status === 503 && error.code.endsWith("_unavailable"))
    // A product switched off on purpose (forks, previews): Runtime's own words
    // say what is off and what to use meanwhile.
    out = new NotSupportedError(error.code.replace(/_unavailable$/, ""), error.hint ?? "", message);
  else if (error.code === "public_preview_not_allowed")
    // A 403 that is about the sandbox's funding, not the key.
    out = new PublicPreviewNotAllowedError("", undefined, message);
  else if (error.status === 401 || error.status === 403) out = new AuthenticationError(message);
  else if (error.code === "file_not_found" || (error.status === 404 && subject === "file"))
    out = new FileNotFoundError(message);
  else if (error.status === 404 && subject === "sandbox") out = new SandboxNotFoundError(message);
  else if (error.status === 404) out = new NotFoundError(message);
  else if (error.status === 429) out = new RateLimitError(message);
  else if (/space|disk_full|no_room/.test(error.code)) out = new NotEnoughSpaceError(message);
  else if (error.status === 400 || error.status === 413 || error.status === 422)
    out = new InvalidArgumentError(message);
  else if (error.status === 503) out = new ServiceBusyError(message);
  else if (error.code === "command_timeout") out = new TimeoutError(message);
  else out = new SandboxError(message);
  if (out instanceof SandboxError && error.status) out.statusCode = error.status;
  attach(out, {
    code: error.code,
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    cause: error,
  });
  return out;
}

/** Runs `work`, turning any Runtime error into its E2B counterpart. */
export async function guard<T>(subject: Subject, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error, subject);
  }
}
