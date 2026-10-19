import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";
// Every type @cloudflare/sandbox 0.12.10 exports, by name: a Worker's
// TypeScript that names one must still compile after the import changes.
import type {
  BackupOptions,
  BaseApiResponse,
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  CodeContext,
  CommandExecuteResponse,
  CommandsResponse,
  ContainerStub,
  ContainerUnavailableContext,
  ContainerUnavailableReason,
  CreateContextOptions,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DirectoryBackup,
  ErrorResponse,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecuteRequest,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionSession,
  FileChunk,
  FileMetadata,
  FileOperationRequest,
  FileStreamEvent,
  FileWatchSSEEvent,
  GitCheckoutRequest,
  GitCheckoutResult,
  ISandbox,
  InterpreterClient,
  ListFilesOptions,
  LocalMountBucketOptions,
  LogEvent,
  MkdirRequest,
  MountBucketOptions,
  NamedTunnelInfo,
  OperationInterruptedContext,
  OperationInterruptedReason,
  PingResponse,
  Process,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessOptions,
  ProcessStartResult,
  ProcessStatus,
  PtyOptions,
  QuickTunnelInfo,
  RPCTransportContext,
  RPCTransportErrorKind,
  ReadFileRequest,
  RemoteMountBucketOptions,
  RequestConfig,
  ResponseHandler,
  RestoreBackupResult,
  RunCodeOptions,
  SandboxClientOptions,
  SandboxEnv,
  SandboxOptions,
  SandboxTransport,
  SessionOptions,
  SessionRequest,
  StartProcessRequest,
  StreamOptions,
  TunnelInfo,
  TunnelOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions,
  WriteFileRequest,
} from "../../src/cloudflare/worker.js";
import { Sandbox as Facade } from "../../src/cloudflare/index.js";
import type { Runtime } from "../../src/client.js";

export type Named = [
  BackupOptions,
  BaseApiResponse,
  BaseExecOptions,
  BucketCredentials,
  BucketProvider,
  CheckChangesOptions,
  CheckChangesResult,
  CodeContext,
  CommandExecuteResponse,
  CommandsResponse,
  ContainerStub,
  ContainerUnavailableContext,
  ContainerUnavailableReason,
  CreateContextOptions,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DirectoryBackup,
  ErrorResponse,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecuteRequest,
  ExecutionCallbacks,
  ExecutionResult,
  ExecutionSession,
  FileChunk,
  FileMetadata,
  FileOperationRequest,
  FileStreamEvent,
  FileWatchSSEEvent,
  GitCheckoutRequest,
  GitCheckoutResult,
  ISandbox,
  InterpreterClient,
  ListFilesOptions,
  LocalMountBucketOptions,
  LogEvent,
  MkdirRequest,
  MountBucketOptions,
  NamedTunnelInfo,
  OperationInterruptedContext,
  OperationInterruptedReason,
  PingResponse,
  Process,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessOptions,
  ProcessStartResult,
  ProcessStatus,
  PtyOptions,
  QuickTunnelInfo,
  RPCTransportContext,
  RPCTransportErrorKind,
  ReadFileRequest,
  RemoteMountBucketOptions,
  RequestConfig,
  ResponseHandler<unknown>,
  RestoreBackupResult,
  RunCodeOptions,
  SandboxClientOptions,
  SandboxEnv,
  SandboxOptions,
  SandboxTransport,
  SessionOptions,
  SessionRequest,
  StartProcessRequest,
  StreamOptions,
  TunnelInfo,
  TunnelOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions,
  WriteFileRequest,
];

// The real Worker entry, with only its platform base classes replaced.
void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));
const worker = await import("../../src/cloudflare/worker.js");
const { Sandbox: Worker, getSandbox } = worker;

/** Every value @cloudflare/sandbox 0.12.10's dist/index.d.ts exports. */
const UPSTREAM_VALUES = [
  "BackupClient",
  "BackupCreateError",
  "BackupExpiredError",
  "BackupNotFoundError",
  "BackupRestoreError",
  "BucketMountError",
  "BucketUnmountError",
  "CodeInterpreter",
  "CommandClient",
  "ContainerProxy",
  "ContainerUnavailableError",
  "FileClient",
  "GitClient",
  "InvalidBackupConfigError",
  "InvalidMountConfigError",
  "MissingCredentialsError",
  "OperationInterruptedError",
  "PortClient",
  "ProcessClient",
  "ProcessExitedBeforeReadyError",
  "ProcessReadyTimeoutError",
  "RPCTransportError",
  "S3FSMountError",
  "Sandbox",
  "SandboxClient",
  "SessionTerminatedError",
  "UtilityClient",
  "asyncIterableToSSEStream",
  "collectFile",
  "getSandbox",
  "isDurableObjectCodeUpdateReset",
  "isExecResult",
  "isPlatformTransientError",
  "isProcess",
  "isProcessStatus",
  "parseSSEStream",
  "proxyTerminal",
  "proxyToSandbox",
  "responseToAsyncIterable",
  "streamFile",
];

test("the Worker entry exports every value @cloudflare/sandbox 0.12.10 exports", () => {
  // A missing one fails the Worker's bundle: "No matching export".
  expect(UPSTREAM_VALUES.filter((name) => !(name in worker))).toEqual([]);
});

test("the Worker's Durable Object answers every Sandbox call the Node module answers or refuses", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("../../compat-inventory.json", import.meta.url), "utf8"),
  ) as { cloudflare: { items: Record<string, string> } };
  // Properties, not calls; and the members getSandbox adds on the Worker side.
  const notCalls = new Set(["defaultPort", "envVars", "sleepAfter", "client", "tunnels"]);
  const calls = Object.entries(inventory.cloudflare.items)
    .filter(([key, status]) => /^Sandbox\.[a-zA-Z]+$/.test(key) && status !== "missing")
    .map(([key]) => key.slice("Sandbox.".length))
    .filter((name) => !notCalls.has(name));
  const prototype = Worker.prototype as unknown as Record<string, unknown>;
  // A name the class lacks reaches Cloudflare's RPC as "does not implement the method".
  const missing = calls.filter(
    (name) =>
      typeof prototype[name] !== "function" &&
      !["onStart", "onStop", "onError", "onActivityExpired", "wsConnect"].includes(name),
  );
  expect(missing).toEqual([]);
});

const NAME = { sandboxName: { name: "valid" }, nativeSandboxId: `cf-do-${"a".repeat(64)}` };
/** A Worker Durable Object on in-memory storage, its facade on a fake native sandbox. */
function durable(Class: typeof Worker = Worker, native: Record<string, unknown> = {}) {
  const records = new Map<string, unknown>([["runtime.configuration", NAME]]);
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(),
    storage: {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => void records.set(key, value),
      delete: async (key: string | string[]) => {
        for (const k of [key].flat()) records.delete(k);
        return true;
      },
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...records].filter(([key]) => key.startsWith(prefix))),
    },
  } as unknown as DurableObjectState;
  const object = new Class(ctx, { RUNTIME_API_KEY: "rtcloud_fixture" });
  const facade = new Facade({} as Runtime, "valid");
  facade.native = async () => native as never;
  (object as unknown as { facade: Facade }).facade = facade;
  return object;
}
const previews = {
  previews: {
    create: async () => ({
      url: "https://p.runtimehost.test/",
      token: "t",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  },
};

test("preview URLs and tokens are Cloudflare's: http on a local hostname, 16-character tokens", async () => {
  const sb = durable(Worker, previews);
  const local = await sb.exposePort(8000, { hostname: "localhost:8787" });
  expect(local.url).toMatch(/^http:\/\/8000-valid-[a-z0-9_]{16}\.localhost:8787\/$/);
  const named = await sb.exposePort(8080, { hostname: "example.com", token: "api_v1" });
  expect(named.url).toBe("https://8080-valid-api_v1.example.com/");
  await expect(sb.exposePort(8081, { hostname: "example.com", token: "api-v1" })).rejects.toThrow(
    "Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.",
  );
  await expect(
    sb.exposePort(8081, { hostname: "example.com", token: "a".repeat(17) }),
  ).rejects.toThrow("Custom token too long. Maximum 16 characters allowed.");
  await expect(sb.exposePort(8082, { hostname: "example.com", token: "api_v1" })).rejects.toThrow(
    "Token 'api_v1' is already in use by port 8080. Please use a different token.",
  );
  await expect(sb.exposePort(80, { hostname: "example.com" })).rejects.toThrow(
    "Invalid port number: 80. Must be 1024-65535, excluding 3000 (sandbox control plane).",
  );
  expect((await sb.getExposedPorts("localhost:8787")).map((p) => p.url)).toContain(local.url);
});

test("a process over the Durable Object waits for a port, and a session carries Cloudflare's calls", async () => {
  const process = {
    id: "p1",
    info: { state: "running", command: "node server.js", startedAt: new Date().toISOString() },
    refresh: async () => process.info,
  };
  const probes: string[][] = [];
  const native = {
    id: "n",
    processes: { get: async () => process },
    exec: async (argv: string[]) => {
      probes.push(argv);
      return { exitCode: probes.length < 2 ? 1 : 0 };
    },
    files: { write: async () => undefined },
  };
  const sb = durable(Worker, native);
  const target = (await sb.getProcess("p1"))!;
  await target.waitForPort(3000, { interval: 1 });
  expect(probes).toHaveLength(2);
  expect(probes[0]!.join(" ")).toContain("http://127.0.0.1:3000/");
  await target.waitForPort(5432, { mode: "tcp", interval: 1 });
  expect(probes.at(-1)!.join(" ")).toContain("/dev/tcp/127.0.0.1/5432");
  process.info = { ...process.info, state: "exited", exitCode: 127 } as typeof process.info;
  await expect(target.waitForPort(6379, { mode: "tcp" })).rejects.toThrow(
    "Process exited with code 127 before becoming ready. Waiting for: port 6379 (TCP)",
  );
  const session = await sb.createSession({ id: "s" });
  for (const call of [
    "gitCheckout",
    "streamProcessLogs",
    "readFileStream",
    "watch",
    "checkChanges",
    "createCodeContext",
    "runCode",
    "runCodeStream",
    "listCodeContexts",
    "deleteCodeContext",
    "listProcesses",
    "killAllProcesses",
    "mountBucket",
    "unmountBucket",
    "moveFile",
  ])
    expect([call, typeof (session as Record<string, unknown>)[call]]).toEqual([call, "function"]);
});

test("Cloudflare-only members refuse by name, with Runtime's alternative", async () => {
  const sb = durable();
  await expect(sb.createBackup()).rejects.toThrow("snapshot the sandbox with Runtime's snapshots");
  await expect(sb.containerFetch()).rejects.toThrow("fetch the URL exposePort returns");
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ configure: async () => undefined }),
  };
  const handle = getSandbox(namespace as never, "valid") as unknown as {
    tunnels: { get(port: number): Promise<unknown> };
    wsConnect(request: Request, port: number): Promise<Response>;
  };
  await expect(handle.tunnels.get(5173)).rejects.toThrow("use exposePort");
  await expect(handle.wsConnect(new Request("http://x"), 8080)).rejects.toThrow(
    "connect to the URL exposePort returns",
  );
  expect(() => getSandbox(namespace as never, "valid", { labels: { a: "b" } } as never)).toThrow(
    "call sandbox.setLabels(labels)",
  );
});

test("a subclass's outbound interception refuses on first use instead of doing nothing", async () => {
  class Intercepting extends Worker {
    allowedHosts = ["github.com"];
    enableInternet = false;
  }
  const sb = durable(Intercepting as unknown as typeof Worker);
  (sb as unknown as { facade?: unknown }).facade = undefined;
  await expect(sb.exec("echo")).rejects.toThrow("set the sandbox's network rules");
  class Hooked extends Worker {}
  (Hooked as unknown as { outboundByHost: object }).outboundByHost = {};
  const hooked = durable(Hooked as unknown as typeof Worker);
  (hooked as unknown as { facade?: unknown }).facade = undefined;
  await expect(hooked.exec("echo")).rejects.toThrow("Sandbox.outboundByHost");
});
