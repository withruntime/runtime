import {
  CommandHandle,
  commandRequest,
  connectionRequest,
  killProcess,
  refuseUser,
  resolveProcess,
  type CommandRequestOpts,
  type SandboxContext,
  type Username,
} from "./commands.js";
import { guard, InvalidArgumentError, NotSupportedError } from "./errors.js";

export interface PtyCreateOpts extends CommandRequestOpts {
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void | Promise<void>;
  timeoutMs?: number;
  user?: Username;
  envs?: Record<string, string>;
  cwd?: string;
}
export type PtyConnectOpts = CommandRequestOpts & Pick<PtyCreateOpts, "onData" | "timeoutMs">;

function dimensions(size: { cols: number; rows: number }) {
  for (const value of [size.cols, size.rows])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new InvalidArgumentError("PTY rows and columns must be positive whole numbers.");
  return { cols: size.cols, rows: size.rows };
}

/** E2B's PTY methods over native terminal processes with lossless output. */
export class Pty {
  constructor(private readonly ctx: SandboxContext) {}

  async create(opts: PtyCreateOpts): Promise<CommandHandle> {
    refuseUser(opts.user);
    const pty = dimensions(opts);
    const opening = connectionRequest(opts, this.ctx.requestTimeoutMs);
    if (typeof opts.onData !== "function")
      throw new InvalidArgumentError("onData must be a function.");
    const env = { TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...opts.envs };
    const process = await guard("sandbox", async () => {
      await this.ctx.ensureHome(opts.cwd, opening.request);
      opening.request.signal?.throwIfAborted();
      return this.ctx.runtime.spawn(["/bin/bash", "-i", "-l"], {
        pty,
        stdin: "pipe",
        outputEncoding: "base64",
        env,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        request: opening.request,
      });
    }).catch(opening.failure);
    return new CommandHandle(process, {
      stdin: false,
      pty: true,
      onData: opts.onData,
      timeoutMs: opening.timeoutMs,
      deadline: opening.deadline,
      signal: opts.signal,
      requestTimeoutMs: this.ctx.requestTimeoutMs,
    });
  }

  async connect(pid: number, opts?: PtyConnectOpts): Promise<CommandHandle> {
    const opening = connectionRequest(opts ?? {}, this.ctx.requestTimeoutMs);
    const process = await resolveProcess(this.ctx, pid, opening.request).catch(opening.failure);
    if (!process.info.pty || process.info.outputEncoding !== "base64")
      throw new NotSupportedError(
        "Connecting to a legacy text-output PTY",
        "Create the PTY through sandbox.pty.create first.",
      );
    return new CommandHandle(process, {
      stdin: false,
      pty: true,
      onData: opts?.onData,
      timeoutMs: opening.timeoutMs,
      deadline: opening.deadline,
      cursor: process.info.outputBytes,
      signal: opts?.signal,
      requestTimeoutMs: this.ctx.requestTimeoutMs,
    });
  }

  async sendInput(pid: number, data: Uint8Array, opts: CommandRequestOpts = {}): Promise<void> {
    const request = commandRequest(opts, this.ctx.requestTimeoutMs);
    const process = await resolveProcess(this.ctx, pid, request);
    if (!process.info.pty)
      throw new InvalidArgumentError(`The process with pid ${pid} is not a PTY.`);
    request.signal?.throwIfAborted();
    await guard("sandbox", () => process.write(data, request));
  }

  async resize(
    pid: number,
    size: { cols: number; rows: number },
    opts: CommandRequestOpts = {},
  ): Promise<void> {
    const pty = dimensions(size);
    const request = commandRequest(opts, this.ctx.requestTimeoutMs);
    const process = await resolveProcess(this.ctx, pid, request);
    if (!process.info.pty)
      throw new InvalidArgumentError(`The process with pid ${pid} is not a PTY.`);
    request.signal?.throwIfAborted();
    await guard("sandbox", () => process.resize(pty.cols, pty.rows, request));
  }

  kill(pid: number, opts: CommandRequestOpts = {}): Promise<boolean> {
    return killProcess(this.ctx, pid, commandRequest(opts, this.ctx.requestTimeoutMs));
  }
}
