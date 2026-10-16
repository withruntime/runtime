import {
  Runloop,
  type DevboxAsyncExecutionDetailView,
  type DevboxCreateParams,
  type DevboxExecuteParams,
  type RequestOptions,
} from "./index.js";
import { only } from "../compat/core.js";

export class RunloopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunloopError";
  }
}

/** The high-level command handles share the low-level adapter's validation,
 * cancellation and process input path; they never send a provider request. */
export class RunloopSDK {
  readonly api: Runloop;
  readonly devbox;
  constructor(options: ConstructorParameters<typeof Runloop>[0] = {}) {
    this.api = new Runloop(options);
    this.devbox = {
      fromId: (id: string) => new Devbox(this.api, id),
      create: async (params: DevboxCreateParams = {}, request?: RequestOptions) => {
        const info = await this.api.devboxes.createAndAwaitRunning(params, request);
        return new Devbox(this.api, info.id);
      },
    };
  }
  get secret(): never {
    return this.api.secrets;
  }
  get storageObject(): never {
    return this.api.objects;
  }
  get axon(): never {
    return this.api.axons;
  }
  get gatewayConfig(): never {
    return this.api.gatewayConfigs;
  }
  get mcpConfig(): never {
    return this.api.mcpConfigs;
  }
  get networkPolicy(): never {
    return this.api.networkPolicies;
  }
}

export class Devbox {
  readonly cmd;
  constructor(
    private readonly client: Runloop,
    readonly id: string,
  ) {
    const start = async (
      command: string,
      params: Omit<DevboxExecuteParams, "command"> = {},
      options?: RequestOptions,
    ) => {
      only("Runloop command; use devboxes.executions streams for output callbacks", params, [
        "shell_name",
        "attach_stdin",
      ]);
      const initial = await client.devboxes.executeAsync(id, { command, ...params }, options);
      return new Execution(client, id, initial.execution_id, initial);
    };
    this.cmd = {
      execAsync: start,
      exec: async (
        command: string,
        params: Omit<DevboxExecuteParams, "command"> = {},
        options?: RequestOptions,
      ) => {
        if (params.attach_stdin) throw new TypeError("attach_stdin requires cmd.execAsync");
        return (await start(command, params, options)).result(options);
      },
    };
  }
  getInfo(options?: RequestOptions) {
    return this.client.devboxes.retrieve(this.id, options);
  }
  shutdown(options?: RequestOptions) {
    return this.client.devboxes.shutdown(this.id, {}, options);
  }
  suspend(options?: RequestOptions) {
    return this.client.devboxes.suspend(this.id, options);
  }
  resume(options?: RequestOptions) {
    return this.client.devboxes.resume(this.id, options);
  }
}

export class Execution {
  constructor(
    private readonly client: Runloop,
    readonly devboxId: string,
    readonly executionId: string,
    _initialResult: DevboxAsyncExecutionDetailView,
    private readonly streamingPromise?: Promise<void>,
  ) {}

  async sendStdIn(input: string, options?: RequestOptions): Promise<void> {
    await this.input({ text: input }, options);
  }
  async closeStdIn(options?: RequestOptions): Promise<void> {
    await this.input({ signal: "EOF" }, options);
  }
  private async input(
    body: Parameters<Runloop["devboxes"]["executions"]["sendStdIn"]>[2],
    options?: RequestOptions,
  ) {
    const response = await this.client.devboxes.executions.sendStdIn(
      this.devboxId,
      this.executionId,
      body,
      options,
    );
    if (!response.success)
      throw new RunloopError(`Failed to send stdin to execution ${this.executionId}`);
  }
  getState(options?: RequestOptions) {
    return this.client.devboxes.executions.retrieve(this.devboxId, this.executionId, {}, options);
  }
  async kill(options?: RequestOptions): Promise<void> {
    await this.client.devboxes.executions.kill(this.devboxId, this.executionId, {}, options);
  }
  async result(options: RequestOptions = {}): Promise<ExecutionResult> {
    only("Runloop execution result; use Runtime process waits for other wait options", options, [
      "signal",
      "timeout",
      "idempotencyKey",
    ]);
    const [command] = await Promise.allSettled([
      this.client.devboxes.executions.awaitCompleted(this.devboxId, this.executionId, options),
      this.streamingPromise,
    ]);
    if (command.status === "rejected") throw command.reason;
    return new ExecutionResult(this.client, this.devboxId, this.executionId, command.value);
  }
}

export class ExecutionResult {
  constructor(
    private readonly client: Runloop,
    private readonly devboxId: string,
    readonly executionId: string,
    readonly result: DevboxAsyncExecutionDetailView,
  ) {}
  get exitCode() {
    return this.result.exit_status ?? null;
  }
  get success() {
    return this.exitCode === 0;
  }
  get failed() {
    return this.exitCode !== null && this.exitCode !== 0;
  }
  stdout(numLines?: number) {
    return this.output("stdout", numLines);
  }
  stderr(numLines?: number) {
    return this.output("stderr", numLines);
  }
  private async output(channel: "stdout" | "stderr", numLines?: number): Promise<string> {
    let output = this.result[channel] ?? "";
    if (
      this.result[`${channel}_truncated`] &&
      (numLines === undefined || output.split("\n").filter(Boolean).length < numLines)
    ) {
      output = "";
      const executions = this.client.devboxes.executions;
      const stream =
        channel === "stdout"
          ? executions.streamStdoutUpdates(this.devboxId, this.executionId)
          : executions.streamStderrUpdates(this.devboxId, this.executionId);
      for await (const chunk of stream) output += chunk.output;
    }
    if (numLines === undefined) return output;
    if (numLines <= 0) return "";
    return output.replace(/\n+$/, "").split("\n").slice(-numLines).join("\n");
  }
}
