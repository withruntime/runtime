/** Workers conditional entry. The Durable Object coordinates requests and stores
 * configuration; Runtime owns compute. Existing Container/Wrangler declarations
 * still need removal during infrastructure migration. */
import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectState,
  DurableObjectNamespace,
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types/index.ts";
import { only, CompatibilityError } from "../compat/core.js";
import { Runtime } from "../client.js";
import { workerSandboxIdentity } from "./identity.js";
import {
  Sandbox as RuntimeSandbox,
  sanitizeSandboxId,
  validateSandboxConfiguration,
  type ExecutionSession,
  type Process,
  type SandboxOptions,
  type SessionOptions,
  type ExecOptions,
  type ProcessOptions,
  type ReadFileResult,
  type ReadFileStreamResult,
} from "./index.js";
export * from "./index.js";
export interface RuntimeWorkerEnv {
  RUNTIME_API_KEY: string;
  RUNTIME_API_URL?: string;
}
type Configuration = {
  sandboxName?: { name: string; normalizeId?: boolean };
  nativeSandboxId?: string;
  sleepAfter?: string | number;
  keepAlive?: boolean;
};
type ConfigurationIntent = {
  sandboxId?: string;
  previous: Configuration;
  next: Configuration;
};
const CONFIGURATION_KEY = "runtime.configuration";
const CONFIGURATION_INTENT_KEY = "runtime.configuration.pending";

/** Preserve the original failure even when durable recovery also fails. */
function configurationFailure(error: unknown, uncertain: boolean, cleanup?: unknown) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      if (uncertain)
        Object.defineProperty(error, "configurationUncertain", { value: true, configurable: true });
      if (cleanup !== undefined)
        Object.defineProperty(
          error,
          "cause" in error && error.cause !== undefined ? "cleanupError" : "cause",
          {
            value: cleanup,
            configurable: true,
          },
        );
    } catch {
      // A frozen exception still keeps its original identity and type.
    }
  }
  return error;
}

/** Queue waits share the caller's existing signal and never reset its deadline. */
async function waitForConfiguration(pending: Promise<unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's abort reason as is, as the upstream SDK does
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** The official Worker SDK returns plain records with callable RPC properties,
 * so ids/status are values rather than remote-property promises. */
function sessionTarget(session: ExecutionSession) {
  function readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>;
  function readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64" },
  ): Promise<ReadFileResult>;
  function readFile(path: string, options?: { encoding?: "utf8" | "utf-8" | "base64" | "none" }) {
    return options?.encoding === "none"
      ? session.readFile(path, { encoding: "none" })
      : session.readFile(path, options as { encoding?: "utf8" | "utf-8" | "base64" });
  }
  return {
    id: session.id,
    exec: (command: string, options?: ExecOptions) => session.exec(command, options),
    execStream: (command: string, options?: ExecOptions) => session.execStream(command, options),
    startProcess: async (command: string, options?: ProcessOptions) =>
      processTarget(await session.startProcess(command, options)),
    writeFile: (...args: Parameters<ExecutionSession["writeFile"]>) => session.writeFile(...args),
    readFile,
    mkdir: (...args: Parameters<ExecutionSession["mkdir"]>) => session.mkdir(...args),
    deleteFile: (path: string) => session.deleteFile(path),
    renameFile: (path: string, to: string) => session.renameFile(path, to),
    moveFile: (path: string, to: string) => session.renameFile(path, to),
    exists: (path: string) => session.exists(path),
    listFiles: (...args: Parameters<ExecutionSession["listFiles"]>) => session.listFiles(...args),
    setEnvVars: (...args: Parameters<ExecutionSession["setEnvVars"]>) =>
      session.setEnvVars(...args),
  };
}
function processTarget(process: Process) {
  return {
    id: process.id,
    command: process.command,
    status: process.status,
    startTime: process.startTime,
    endTime: process.endTime,
    exitCode: process.exitCode,
    sessionId: process.sessionId,
    kill: (signal?: string) => process.kill(signal),
    getStatus: () => process.getStatus(),
    getLogs: () => process.getLogs(),
    waitForExit: (timeout?: number) => process.waitForExit(timeout),
    waitForLog: (pattern: string | RegExp, timeout?: number) =>
      process.waitForLog(pattern, timeout),
  };
}
export class Sandbox<Env extends RuntimeWorkerEnv = RuntimeWorkerEnv> extends DurableObject<Env> {
  private configuration: Configuration = {};
  private configurationIntent?: ConfigurationIntent;
  private facade?: RuntimeSandbox;
  private configurationTail: Promise<unknown> = Promise.resolve();
  private configurationOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.configurationTail.catch(() => undefined).then(operation);
    this.configurationTail = result;
    return result;
  }
  private previewTail: Promise<unknown> = Promise.resolve();
  private previewOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.previewTail.catch(() => undefined).then(operation);
    this.previewTail = result;
    return result;
  }
  private readonly initialized: Promise<void>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      this.configuration = (await ctx.storage.get<Configuration>(CONFIGURATION_KEY)) ?? {};
      this.configurationIntent =
        await ctx.storage.get<ConfigurationIntent>(CONFIGURATION_INTENT_KEY);
    });
  }
  private async sandbox(signal?: AbortSignal) {
    await waitForConfiguration(this.initialized, signal);
    // A staged intent is transient while an update is still running. Wait for
    // the queued update before deciding whether uncertainty was retained.
    let configurationTail: Promise<unknown>;
    do {
      configurationTail = this.configurationTail;
      await waitForConfiguration(
        configurationTail.catch(() => undefined),
        signal,
      );
    } while (configurationTail !== this.configurationTail);
    signal?.throwIfAborted();
    if (this.configurationIntent)
      throw configurationFailure(
        new Error(
          "Runtime's configuration is uncertain. Call configure() to reconcile it before use.",
        ),
        true,
      );
    if (!this.configuration.sandboxName)
      throw new Error("Call getSandbox(namespace, id) before using the Durable Object");
    if (!this.env.RUNTIME_API_KEY?.startsWith("rtcloud_"))
      throw new Error("Set the RUNTIME_API_KEY Worker secret to a Runtime API key");
    this.facade ??= new RuntimeSandbox(
      new Runtime({ apiKey: this.env.RUNTIME_API_KEY, baseUrl: this.env.RUNTIME_API_URL }),
      workerSandboxIdentity(this.ctx.id.toString(), this.configuration),
      { ...this.configuration },
    );
    return this.facade;
  }
  async configure(configuration: Configuration) {
    only("Cloudflare Worker configure", configuration, ["sandboxName", "sleepAfter", "keepAlive"]);
    validateSandboxConfiguration(configuration);
    if (configuration.sandboxName !== undefined) {
      only("Cloudflare Worker sandboxName", configuration.sandboxName, ["name", "normalizeId"]);
      sanitizeSandboxId(configuration.sandboxName.name);
      if (
        configuration.sandboxName.normalizeId !== undefined &&
        typeof configuration.sandboxName.normalizeId !== "boolean"
      )
        throw new TypeError("normalizeId must be a boolean");
    }
    const requested = {
      ...(configuration.sandboxName === undefined
        ? {}
        : { sandboxName: { ...configuration.sandboxName } }),
      ...(configuration.sleepAfter === undefined ? {} : { sleepAfter: configuration.sleepAfter }),
      ...(configuration.keepAlive === undefined ? {} : { keepAlive: configuration.keepAlive }),
    };
    return this.configurationOperation(async () => {
      await this.initialized;
      if (
        this.configuration.sandboxName &&
        requested.sandboxName &&
        this.configuration.sandboxName.name !== requested.sandboxName.name
      )
        throw new Error("A Durable Object cannot change sandbox identity");
      if (this.configurationIntent) {
        const facade =
          this.facade ??
          new RuntimeSandbox(
            new Runtime({ apiKey: this.env.RUNTIME_API_KEY, baseUrl: this.env.RUNTIME_API_URL }),
            workerSandboxIdentity(this.ctx.id.toString(), this.configuration),
            { ...this.configuration },
          );
        try {
          // Recovery uses the saved UUID even after a Durable Object restart.
          const actual = await facade.reconcileConfiguration(this.configurationIntent.sandboxId);
          const reconciled = { ...this.configuration, ...actual };
          await this.ctx.storage.put(CONFIGURATION_KEY, reconciled);
          await this.ctx.storage.delete(CONFIGURATION_INTENT_KEY);
          this.configuration = reconciled;
          this.facade = facade;
          this.configurationIntent = undefined;
        } catch (error) {
          throw configurationFailure(error, true);
        }
      }
      const previous = this.configuration;
      const stored = await this.ctx.storage.get<Configuration>(CONFIGURATION_KEY);
      const nativeSandboxId = workerSandboxIdentity(this.ctx.id.toString(), previous);
      const next = { ...previous, ...requested, nativeSandboxId };
      if (!this.facade) {
        await this.ctx.storage.put(CONFIGURATION_KEY, next);
        this.configuration = next;
        return;
      }
      this.configurationIntent = { sandboxId: this.facade.existingNativeId(), previous, next };
      try {
        await this.ctx.storage.put(CONFIGURATION_INTENT_KEY, this.configurationIntent);
      } catch (error) {
        let cleanup: unknown;
        try {
          // Native mutation has not started. A failed write may still have
          // persisted the intent, so clear this operation's staging record.
          await this.ctx.storage.delete(CONFIGURATION_INTENT_KEY);
          this.configurationIntent = undefined;
        } catch (failure) {
          cleanup = failure;
        }
        throw configurationFailure(error, this.configurationIntent !== undefined, cleanup);
      }
      let nativeAttempted = false;
      try {
        await this.ctx.storage.put(CONFIGURATION_KEY, next);
        nativeAttempted = true;
        await this.facade.configure({
          ...(requested.sleepAfter === undefined ? {} : { sleepAfter: requested.sleepAfter }),
          ...(requested.keepAlive === undefined ? {} : { keepAlive: requested.keepAlive }),
        });
      } catch (error) {
        let cleanup: unknown;
        try {
          if (stored === undefined) await this.ctx.storage.delete(CONFIGURATION_KEY);
          else await this.ctx.storage.put(CONFIGURATION_KEY, stored);
          if (!nativeAttempted) {
            await this.ctx.storage.delete(CONFIGURATION_INTENT_KEY);
            this.configurationIntent = undefined;
          }
        } catch (failure) {
          cleanup = failure;
        }
        // A rejected native request may have applied remotely. Keep its intent
        // until an authoritative read succeeds; rollback is only local state.
        throw configurationFailure(error, this.configurationIntent !== undefined, cleanup);
      }
      this.configuration = next;
      try {
        await this.ctx.storage.delete(CONFIGURATION_INTENT_KEY);
        this.configurationIntent = undefined;
      } catch (error) {
        throw configurationFailure(error, true);
      }
    });
  }
  setSandboxName(name: string, normalizeId = false) {
    return this.configure({
      sandboxName: { name: normalizeId ? name.toLowerCase() : name, normalizeId },
    });
  }
  setSleepAfter(sleepAfter: string | number) {
    return this.configure({ sleepAfter });
  }
  setKeepAlive(keepAlive: boolean) {
    return this.configure({ keepAlive });
  }
  async exec(command: string, options?: ExecOptions) {
    return (await this.sandbox(options?.signal)).exec(command, options);
  }
  async execStream(command: string, options?: ExecOptions) {
    return (await this.sandbox(options?.signal)).execStream(command, options);
  }
  async startProcess(command: string, options?: ProcessOptions) {
    return processTarget(await (await this.sandbox()).startProcess(command, options));
  }
  async listProcesses() {
    return (await (await this.sandbox()).listProcesses()).map((p) => processTarget(p));
  }
  async getProcess(id: string) {
    const p = await (await this.sandbox()).getProcess(id);
    return p ? processTarget(p) : null;
  }
  async getProcessLogs(id: string) {
    return (await this.sandbox()).getProcessLogs(id);
  }
  async killProcess(id: string, signal?: string) {
    return (await this.sandbox()).killProcess(id, signal);
  }
  async killAllProcesses() {
    return (await this.sandbox()).killAllProcesses();
  }
  async createSession(options?: SessionOptions) {
    return sessionTarget(await (await this.sandbox()).createSession(options));
  }
  async getSession(id: string) {
    return sessionTarget(await (await this.sandbox()).getSession(id));
  }
  async deleteSession(id: string) {
    return (await this.sandbox()).deleteSession(id);
  }
  async writeFile(...args: Parameters<RuntimeSandbox["writeFile"]>) {
    return (await this.sandbox()).writeFile(...args);
  }
  readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64" },
  ): Promise<ReadFileResult>;
  async readFile(path: string, options?: { encoding?: "utf8" | "utf-8" | "base64" | "none" }) {
    const s = await this.sandbox();
    return options?.encoding === "none"
      ? s.readFile(path, { encoding: "none" })
      : s.readFile(path, options as { encoding?: "utf8" | "utf-8" | "base64" });
  }
  async mkdir(...args: Parameters<RuntimeSandbox["mkdir"]>) {
    return (await this.sandbox()).mkdir(...args);
  }
  async deleteFile(path: string) {
    return (await this.sandbox()).deleteFile(path);
  }
  async renameFile(path: string, to: string) {
    return (await this.sandbox()).renameFile(path, to);
  }
  async moveFile(path: string, to: string) {
    return (await this.sandbox()).moveFile(path, to);
  }
  async listFiles(...args: Parameters<RuntimeSandbox["listFiles"]>) {
    return (await this.sandbox()).listFiles(...args);
  }
  async exists(path: string) {
    return (await this.sandbox()).exists(path);
  }
  async setEnvVars(...args: Parameters<RuntimeSandbox["setEnvVars"]>) {
    return (await this.sandbox()).setEnvVars(...args);
  }
  exposePort(port: number, options: { name?: string; hostname: string; token?: string }) {
    return this.previewOperation(() => this.expose(port, options));
  }
  private async expose(port: number, options: { name?: string; hostname: string; token?: string }) {
    only("Cloudflare Worker exposePort", options, ["name", "hostname", "token"]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000)
      throw new TypeError("Preview port must be 1024-65535, excluding 3000");
    if (
      !/^[a-z0-9.-]+$/i.test(options.hostname) ||
      options.hostname.startsWith(".") ||
      options.hostname.endsWith(".")
    )
      throw new TypeError("Preview hostname must be a DNS hostname");
    if (options.hostname.endsWith(".workers.dev"))
      throw new Error(
        "Port exposure requires a custom domain; .workers.dev does not support wildcard preview subdomains",
      );
    const existing = await this.ctx.storage.get<{ token: string }>(`runtime.preview.${port}`);
    const token = options.token ?? existing?.token ?? crypto.randomUUID().replaceAll("-", "");
    const ports = await this.ctx.storage.list<{ token: string; port: number }>({
      prefix: "runtime.preview.",
    });
    if ([...ports.values()].some((p) => p.port !== port && p.token === token))
      throw new Error(`Token '${token}' is already in use by another port`);
    if (!/^[a-z0-9_]{1,63}$/.test(token))
      throw new TypeError(
        "Preview token must contain 1-63 lowercase letters, digits or underscores",
      );
    const sandbox = await this.sandbox();
    const name = this.configuration.sandboxName!.name;
    if (name !== name.toLowerCase())
      throw new CompatibilityError(
        "Cloudflare",
        "uppercase sandbox IDs in preview hostnames; use normalizeId:true",
      );
    const native = await (await sandbox.native()).previews.create(port, { visibility: "private" });
    const url = `https://${port}-${name}-${token}.${options.hostname}`;
    await this.ctx.storage.put(`runtime.preview.${port}`, {
      token,
      url,
      target: native.url,
      authToken: native.token,
      authExpiresAt: native.tokenExpiresAt,
      port,
      name: options.name,
    });
    return { url, port, name: options.name };
  }
  unexposePort(port: number) {
    return this.previewOperation(async () => {
      await (await this.sandbox()).unexposePort(port);
      await this.ctx.storage.delete(`runtime.preview.${port}`);
    });
  }
  async isPortExposed(port: number) {
    return !!(await this.ctx.storage.get(`runtime.preview.${port}`));
  }
  async validatePortToken(port: number, token: string) {
    const record = await this.ctx.storage.get<{ token: string }>(`runtime.preview.${port}`);
    return record?.token === token;
  }
  async getExposedPorts(hostname: string) {
    return [
      ...(
        await this.ctx.storage.list<{ url: string; port: number; token: string }>({
          prefix: "runtime.preview.",
        })
      ).values(),
    ].map((p) => ({
      url: `https://${p.port}-${this.configuration.sandboxName!.name}-${p.token}.${hostname}`,
      port: p.port,
      status: "active" as const,
    }));
  }
  async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    return this.forwardPreview(request as unknown as Request) as unknown as Promise<WorkerResponse>;
  }
  private async forwardPreview(request: Request): Promise<Response> {
    await this.initialized;
    const route = previewRoute(new URL(request.url));
    if (!route || route.id !== this.configuration.sandboxName?.name)
      return new Response("Not found", { status: 404 });
    const record = await this.ctx.storage.get<{
      token: string;
      target: string;
      authToken: string | null;
      authExpiresAt: string | null;
    }>(`runtime.preview.${route.port}`);
    if (!record || record.token !== route.token) return new Response("Not found", { status: 404 });
    if (!record.authExpiresAt || Date.parse(record.authExpiresAt) <= Date.now() + 60000) {
      const preview = await (await (await this.sandbox()).native()).previews.get(route.port);
      record.target = preview.url;
      record.authToken = preview.token;
      record.authExpiresAt = preview.tokenExpiresAt;
      await this.ctx.storage.put(`runtime.preview.${route.port}`, record);
    }
    if (!record.authToken) throw new Error("Private preview did not return an authorization token");
    const incoming = new URL(request.url),
      target = new URL(record.target);
    target.pathname = incoming.pathname;
    const authorization = [...target.searchParams];
    target.search = incoming.search;
    for (const [key, value] of authorization) target.searchParams.set(key, value);
    const headers = new Headers(request.headers);
    headers.set("x-runtime-preview-token", record.authToken);
    headers.delete("host");
    return fetch(new Request(new Request(target, request), { headers, redirect: "manual" }));
  }
  async destroy() {
    await (await this.sandbox()).destroy();
    this.facade = undefined;
    const ports = await this.ctx.storage.list({ prefix: "runtime.preview." });
    await this.ctx.storage.delete([...ports.keys()]);
  }
}
export function getSandbox<T extends Sandbox>(
  namespace: DurableObjectNamespace<T>,
  id: string,
  options: SandboxOptions = {},
): T {
  only("Cloudflare Worker getSandbox", options, ["normalizeId", "sleepAfter", "keepAlive"]);
  sanitizeSandboxId(id);
  const name = options.normalizeId ? id.toLowerCase() : id;
  const stub = namespace.get(namespace.idFromName(name));
  const configured = stub.configure({
    sandboxName: { name, normalizeId: options.normalizeId },
    ...(options.sleepAfter !== undefined ? { sleepAfter: options.sleepAfter } : {}),
    ...(options.keepAlive !== undefined ? { keepAlive: options.keepAlive } : {}),
  });
  // Await configuration for every operation so no request can race name setup.
  return new Proxy(stub, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function" || key === "then") return value;
      return (...args: unknown[]) =>
        Promise.resolve(configured).then(() => Reflect.apply(value, target, args) as unknown);
    },
  }) as unknown as T;
}

function previewRoute(url: URL) {
  const label = url.hostname.split(".")[0] ?? "";
  const match = /^(\d{4,5})-([a-z0-9_-]+)-([a-z0-9_]{1,63})$/.exec(label);
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1024 || port > 65535 || port === 3000) return null;
  return { port, id: match[2]!, token: match[3]! };
}
export async function proxyToSandbox(
  request: Request,
  env: { Sandbox: DurableObjectNamespace<Sandbox> },
): Promise<Response | null> {
  const route = previewRoute(new URL(request.url));
  if (!route) return null;
  return getSandbox(env.Sandbox, route.id, { normalizeId: true }).fetch(
    request as unknown as WorkerRequest,
  ) as unknown as Promise<Response>;
}
