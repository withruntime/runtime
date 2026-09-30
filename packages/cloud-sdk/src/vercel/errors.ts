import { RuntimeError } from "../errors.js";

/* Vercel Sandbox's error classes by the same names, so a
   `catch (e) { if (e instanceof APIError) ... }` written for Vercel keeps
   working. One made from a Runtime answer also carries Runtime's `code`,
   `hint` and `requestId`, and the original error as `cause`. */

interface Options<ErrorData> {
  message?: string;
  json?: ErrorData;
  text?: string;
  sandboxName?: string;
  sessionId?: string;
}

/** An error answer from the API. `response.status` is the HTTP status, and
 * `json` is `{ error: { code, message } }` as Vercel's is. */
export class APIError<ErrorData = unknown> extends Error {
  response: Response;
  json?: ErrorData;
  text?: string;
  sandboxName?: string;
  sessionId?: string;
  code?: string;
  hint?: string;
  requestId?: string;
  constructor(response: Response, options: Options<ErrorData> = {}) {
    super(options.message ?? `Status code ${response.status} is not ok`);
    this.name = new.target.name;
    this.response = response;
    if (options.json !== undefined) this.json = options.json;
    if (options.text !== undefined) this.text = options.text;
    if (options.sandboxName !== undefined) this.sandboxName = options.sandboxName;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
  }
}

/** A command's output stream failed, as Vercel's StreamError. */
export class StreamError extends Error {
  code: string;
  sessionId: string;
  constructor(code: string, message: string, sessionId: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.sessionId = sessionId;
  }
}

/** A Vercel token was given where a Runtime key is needed. */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A call that Vercel Sandbox supports and Runtime does not, or not in the
 * same way. Thrown before anything is done, never after doing something
 * different. `feature` names what was asked for; `alternative` says what to
 * use on Runtime instead. */
export class NotSupportedError extends Error {
  readonly code = "not_supported";
  readonly feature: string;
  readonly alternative: string;
  constructor(feature: string, alternative: string, message?: string) {
    super(message ?? `${feature} is not supported on Runtime. ${alternative}`);
    this.name = new.target.name;
    this.feature = feature;
    this.alternative = alternative;
  }
}

/** A Runtime SDK error as Vercel's APIError, or NotSupportedError for a
 * product Runtime has switched off. Anything else passes through unchanged. */
export function translate(error: unknown, sandboxName?: string): unknown {
  if (!(error instanceof RuntimeError)) return error;
  const message = [
    error.message,
    error.hint ? `Hint: ${error.hint}` : "",
    error.requestId ? `Request: ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (error.status === 503 && error.code.endsWith("_unavailable"))
    return new NotSupportedError(
      error.code.replace(/_unavailable$/, ""),
      error.hint ?? "",
      message,
    );
  if (error.status < 200 || error.status > 599) return error;
  const json = { error: { code: error.code, message: error.message } };
  const out = new APIError(
    new Response(JSON.stringify(json), {
      status: error.status,
      headers: { "content-type": "application/json" },
    }),
    { message, json, text: JSON.stringify(json), ...(sandboxName ? { sandboxName } : {}) },
  );
  out.code = error.code;
  if (error.hint) out.hint = error.hint;
  if (error.requestId) out.requestId = error.requestId;
  out.cause = error;
  return out;
}

/** Runs `work`, turning any Runtime error into Vercel's. */
export async function guard<T>(work: () => Promise<T>, sandboxName?: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error, sandboxName);
  }
}

/** A node:fs-style error, as Vercel's `sandbox.fs` throws. */
export function fsError(
  code: "ENOENT" | "EEXIST" | "EISDIR" | "ENOTDIR" | "EACCES" | "ENOTEMPTY" | "EINVAL",
  syscall: string,
  path: string,
) {
  const text = {
    ENOENT: "no such file or directory",
    EEXIST: "file already exists",
    EISDIR: "illegal operation on a directory",
    ENOTDIR: "not a directory",
    EACCES: "permission denied",
    ENOTEMPTY: "directory not empty",
    EINVAL: "invalid argument",
  }[code];
  const errno = {
    ENOENT: -2,
    EEXIST: -17,
    EISDIR: -21,
    ENOTDIR: -20,
    EACCES: -13,
    ENOTEMPTY: -39,
    EINVAL: -22,
  }[code];
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), {
    code,
    errno,
    syscall,
    path,
  });
}
