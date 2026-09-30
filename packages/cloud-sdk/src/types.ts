/** A sandbox as the API answers it. Times are ISO 8601 strings, money is
 * integer microdollars (1,000,000 = $1). */
export type SandboxInfo = {
  id: string;
  kind: "sandbox";
  name: string | null;
  labels: Record<string, string>;
  status: "pending" | "active" | "paused" | "stopping" | "stopped";
  state: "starting" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped";
  region: string;
  funding: "trial" | "paid";
  vcpu: number;
  memoryMiB: number;
  diskMiB: number;
  cpu: "shared" | "reserved";
  cpuFloorMillis: number;
  pausable: boolean;
  timeoutSeconds: number;
  /** Pauses after this many idle seconds; 0 is never. */
  idlePauseSeconds?: number;
  /** True only for a sandbox created before 27 September 2026 with the old
   * default idle pause, which paused it only while nothing had used it. */
  idlePauseUnusedOnly?: boolean;
  /** A request (exec, files, terminal, a visit to a shared port) wakes it when paused. */
  autoWake?: boolean;
  /** Its lease renews itself while credit lasts, and its disk is kept after a stop. */
  persistent?: boolean;
  /** The last exec, file, terminal, desktop or preview request, to within a minute. */
  lastActiveAt?: string | null;
  onLeaseEnd: "pause" | "stop";
  createdAt: string;
  readyAt: string | null;
  expiresAt: string;
  endedAt: string | null;
  stopReason: string | null;
  pausedAt: string | null;
  pausedExpiresAt: string | null;
  chargedMicros: number;
  heldMicros: number;
  simulated?: boolean;
  replayed?: boolean;
  /** The names of its own environment variables (`env`), on a create, an
   * update and a read of one sandbox. Values are never shown. */
  envNames?: string[];
  /** On a create from an image with a start command: whether it started,
   * became ready (readyMs), timed out, or exited first. The create's answer
   * alone carries it, and the Sandbox that create returned keeps it through
   * later reads; `sandboxes.get` and `list` have none, because the API keeps
   * no record of it. */
  start?: {
    state: "started" | "ready" | "timeout" | "exited" | "not_running";
    processId?: string;
    exitCode?: number | null;
    readyMs?: number;
  };
  /** Present and true when getOrCreate answered a sandbox that already held the name. */
  reused?: boolean;
  [key: string]: unknown;
};

export type CreateSandbox = {
  name?: string;
  labels?: Record<string, string>;
  /** Environment variables for every command, process, terminal, SSH session
   * and the image's start command in this sandbox, under each command's own
   * `env`. At most 32 variables and 32 KiB. Values are never shown again;
   * answers list only `envNames`. Copies made by fork() keep them. */
  env?: Record<string, string>;
  /** Omit to use the free trial while it lasts, then prepaid credit. */
  funding?: "trial" | "paid";
  region?: string;
  vcpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
  cpu?: "shared" | "reserved";
  cpuFloorMillis?: number;
  /** How long it may run before its lease ends. Default 1800. */
  timeoutSeconds?: number;
  pausable?: boolean;
  /** What happens when timeoutSeconds runs out: "pause" (default) or "stop". */
  onLeaseEnd?: "pause" | "stop";
  /** Pause after this many seconds in which nothing happens in it: no
   * request, no command or terminal running, no open connection, no network
   * traffic and no CPU use. Default 60 for a pausable sandbox; 0 never;
   * otherwise 10 to 86400. A request wakes it again. */
  idlePauseSeconds?: number;
  /** A request to a paused sandbox wakes it. Default true. */
  autoWake?: boolean;
  /** Keep it running while credit lasts (its lease renews itself) and keep its
   * disk after a stop, for restart(). Paid only. */
  persistent?: boolean;
  /** The most it may cost over its whole life, in microdollars. */
  maxTotalCostMicros?: number;
  /** With name: return the sandbox that already has the name, woken if paused. */
  getOrCreate?: boolean;
  maxCostMicros?: number;
  /** Network rules from the first start; the same shape as sandbox.network.set.
   * Omit for the public web on ports 80 and 443. */
  network?: { internet: boolean; allow?: string[]; deny?: string[]; connect?: string[] };
  /** A ready image (runtime.images.build): its id, name (its latest tag),
   * name:tag or name@version. When the image has a start command, create
   * answers once its ready check passes and says how in `start`. */
  image?: string;
  /** A ready snapshot's id: the sandbox starts as a copy of it, with its shape. Not with image. */
  snapshot?: string;
  /** Up to four volumes: read-write ("rw", one sandbox at a time) or a
   * read-only "snapshot" copy. */
  volumes?: { volumeId: string; path: string; mode?: "rw" | "snapshot" }[];
  /** Paid only: join your Tailscale network once running. `authKeySecret`
   * names a job secret holding the auth key. */
  tailscale?: { authKeySecret: string; hostname?: string; tags?: string[] };
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  durationMs?: number | null;
  processId?: string;
  replayed?: boolean;
};

export type ExecOptions = {
  cwd?: string;
  /** Merged over the sandbox's environment. Put secrets here, never in the command. */
  env?: Record<string, string>;
  /** Given to standard input, then closed. */
  stdin?: string | Uint8Array;
  /** Default 60 000, or 24 hours when the output streams (onStdout, onStderr or
   * execStream); up to 24 hours. A timeout is a result (timedOut), not an error. */
  timeoutMs?: number;
  onStdout?: (text: string) => unknown;
  onStderr?: (text: string) => unknown;
  /** Throw CommandError when the exit code is not 0. */
  check?: boolean;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export type ProcessInfo = {
  id: string;
  kind: "process";
  state: "running" | "exited" | "killed" | "timed_out" | "unknown";
  exitCode: number | null;
  command: string;
  cwd: string;
  pty: boolean;
  stdinOpen: boolean;
  stdinOffset: number;
  outputEncoding?: "utf8" | "base64";
  startedAt: string;
  endedAt: string | null;
  timeoutMs: number | null;
  outputBytes: number;
  firstOffset: number;
};

export type OutputEvent =
  | { type: "start"; processId: string; replayed?: boolean }
  | { type: "stdout" | "stderr"; data: string; offset: number; base64?: string }
  | { type: "exit"; exitCode: number | null; state: string; timedOut: boolean; durationMs?: number }
  | { type: "truncated"; droppedBytes: number; resumeAt: number }
  | { type: "continue"; processId: string; cursor: number }
  | { type: "error"; error: { code: string; message: string; requestId?: string } };

export type BinaryOutputEvent =
  | Exclude<OutputEvent, { type: "stdout" | "stderr" }>
  | { type: "stdout" | "stderr"; data: Uint8Array; offset: number };

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: string;
  modifiedAt: string;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
  symlinkTarget?: string;
};

/** GET /v1/usage. Money is integer microdollars in strings (1,000,000 = $1),
 * exact past 2^53: available = credited - spent - expired - held. */
export type Usage = {
  orgId: string;
  unit: "microdollars";
  credited: string;
  spent: string;
  held: string;
  /** Credit that expired, or grant credit taken back. */
  expired: string;
  /** What can still be spent. */
  available: string;
  /** The part of spent that refunds and disputes took. */
  takenBack: string;
  trial: { totalMs: number; usedMs: number; reservedMs: number; availableMs: number } | null;
  /** Outbound traffic this calendar month, UTC: the first `allowanceBytes` an
   * account sends are free, and the rest is charged at the rate in the pricing
   * guide (https://withruntime.com/docs/pricing#network-products). */
  outbound?: {
    month: string;
    sentBytes: number;
    freeBytes: number;
    billableBytes: number;
    allowanceBytes: number;
    chargedMicros: string;
    /** What the balance or a spending limit could not cover; never charged. */
    writtenOffMicros: string;
  } | null;
  resources: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type FeedbackKind =
  | "bug"
  | "missing_feature"
  | "competitor_gap"
  | "migration_blocker"
  | "docs"
  | "pricing"
  | "praise"
  | "other";

/** What `sandbox.update()` changes; fields left out stay as they are. */
export type SandboxSettings = {
  name?: string;
  labels?: Record<string, string>;
  /** Changes its environment: a value sets a variable, null removes it, and
   * the rest stay. Commands started afterwards get the change. */
  env?: Record<string, string | null>;
  /** A request to a paused sandbox wakes it. */
  autoWake?: boolean;
  /** Pause after this many seconds with no activity, counted from now; 0
   * never, otherwise 10 to 86400. */
  idlePauseSeconds?: number;
  /** Keep it running while credit lasts and keep its disk after a stop. Paid only. */
  persistent?: boolean;
  /** Lifetime cap in microdollars; null removes it. */
  maxTotalCostMicros?: number | null;
};

/** A deleted sandbox, as `delete()` answers it the first time and every time
 * after. It reads nowhere else afterwards. */
export type DeletedSandbox = {
  id: string;
  kind: "sandbox";
  name: string | null;
  labels: Record<string, string>;
  status: "deleted";
  /** "stopping" until its machine has stopped, usually well under a second. */
  state: string;
  deletedAt: string;
  endedAt: string | null;
  replayed?: boolean;
};

/** How `sandbox.keepAlive()` extends the lease. */
export type KeepAliveOptions = {
  /** How often it checks, in seconds. Default 60. */
  everySeconds?: number;
  /** How much lease it keeps ahead of now, in seconds (60 to 3600). Default 600. */
  marginSeconds?: number;
  /** Called with an error an extension met; the loop carries on. */
  onError?: (error: unknown) => void;
};
