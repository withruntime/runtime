/** A sandbox as the API answers it. Times are ISO 8601 strings, money is
 * integer microdollars (1,000,000 = $1). */
export type SandboxInfo = {
  id: string;
  kind: "sandbox";
  name: string | null;
  labels: Record<string, string>;
  /** @deprecated Read `state`. An older, coarser name for it, still sent for
   * older clients. */
  status: "pending" | "active" | "paused" | "stopping" | "stopped";
  state: "starting" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped";
  region: string;
  funding: "trial" | "paid";
  vcpu: number;
  memoryMiB: number;
  diskMiB: number;
  cpu: "shared" | "reserved";
  cpuFloorMillis: number;
  /** @deprecated Always true for a sandbox created since 5 October 2026:
   * every sandbox can pause. */
  pausable: boolean;
  /** Its time limit in seconds; 0 is none: it runs while it works. */
  timeoutSeconds: number;
  /** Pauses after this many idle seconds; 0 is never. */
  idlePauseSeconds?: number;
  /** True only for a sandbox created before 27 September 2026 with the old
   * default idle pause, which paused it only while nothing had used it. */
  idlePauseUnusedOnly?: boolean;
  /** A request (exec, files, terminal, a visit to a shared port) wakes it when paused. */
  autoWake?: boolean;
  /** Who its commands, processes and terminals run as when one names no
   * user: "sandbox" (uid 1000) or "root". Absent from APIs before 25 October 2026. */
  user?: "sandbox" | "root";
  /** With no time limit, how far ahead each renewal funds it, in seconds;
   * it runs for at least half of this even if Runtime cannot renew it.
   * Absent from APIs before 25 October 2026. */
  leaseSeconds?: number;
  /** Runs until stopped while credit lasts, never paused for idleness or a
   * time limit, and its disk is kept after a stop. */
  persistent?: boolean;
  /** The last exec, file, terminal, desktop or preview request, to within a minute. */
  lastActiveAt?: string | null;
  /** What happens when its time limit, credit or a spending limit ends it. */
  onLeaseEnd: "pause" | "stop" | "delete";
  /** onLeaseEnd's newer name (0381): the same value. */
  onTimeout?: "pause" | "stop" | "delete";
  createdAt: string;
  readyAt: string | null;
  /** Paid up to: a time ahead of now that moves on by itself while it runs.
   * Not when it ends; that is `endsAt`. */
  expiresAt: string;
  /** When it stops or pauses by itself: its time limit, or where its funding
   * ends once credit or a spending limit stops its renewal. Null when it
   * never will, and when it is not running. Absent from older servers. */
  endsAt?: string | null;
  endedAt: string | null;
  /** Why it stopped or paused, such as `requested`, `idle` or `time_limit`
   * (its `timeoutSeconds` ran out). A server before 4 October 2026 sent
   * `lease_expired` for `time_limit`. */
  stopReason: string | null;
  pausedAt: string | null;
  pausedExpiresAt: string | null;
  chargedMicros: number;
  /** @deprecated Read `chargedMicros` and `runtime.usage()`. Still sent for
   * older clients. */
  heldMicros: number;
  simulated?: boolean;
  replayed?: boolean;
  /** The names of its own environment variables (`env`), on a create, an
   * update and a read of one sandbox. Values are never shown. */
  envNames?: string[];
  /** The egress secrets this sandbox may use, by name: only those of your
   * egress secrets that would otherwise reach it. Null is every secret that
   * reaches it. Fixed for the sandbox's life; a fork or a copy of a snapshot
   * may only narrow its source's list. On a create, an update, a fork and a
   * read of one sandbox; absent from list pages and older servers. */
  secrets?: string[] | null;
  /** On an update with labels by a key that may read secrets, when one of
   * the account's egress secrets is scoped: true once every server running its sandboxes holds the change,
   * so the next request uses the new scope; false while one has not
   * confirmed (it takes it within 15 seconds). */
  secretsEnforced?: boolean;
  /** On a create from an image with a start command: whether it started
   * (and was still running half a second later), became ready (readyMs),
   * timed out, or exited first (exitCode, and stderr's last lines). The create's answer
   * alone carries it, and the Sandbox that create returned keeps it through
   * later reads; `sandboxes.get` and `list` have none, because the API keeps
   * no record of it. */
  start?: {
    state: "started" | "ready" | "timeout" | "exited" | "not_running";
    processId?: string;
    exitCode?: number | null;
    readyMs?: number;
    /** With exited: the last lines the start command wrote to stderr. */
    stderr?: string;
  };
  /** Present and true when getOrCreate answered a sandbox that already held the name. */
  reused?: boolean;
  /** An opaque tag for the server it is on, like `pl_3f9a0c1b2d4e5f60`. Your
   * sandboxes and snapshots with the same tag are on the same server. It is
   * never the server's name, and other accounts see unrelated tags. Null
   * before it is placed. Absent from older servers. */
  placement?: string | null;
  [key: string]: unknown;
};

export type CreateSandbox = {
  name?: string;
  /** What the end of an `await using` block does to it. By default the
   * block deletes it; `keep: true` stops it instead, which keeps its disk
   * (billed while it is kept). Not sent to the API. */
  keep?: boolean;
  labels?: Record<string, string>;
  /** Environment variables for every command, process, terminal, SSH session
   * and the image's start command in this sandbox, under each command's own
   * `env`. At most 32 variables and 32 KiB. Values are never shown again;
   * answers list only `envNames`. Copies made by fork() keep them. */
  env?: Record<string, string>;
  /** The egress secrets this sandbox may use, by name: only those of your
   * egress secrets that would otherwise reach it. [] is none; leave it out
   * for every secret that reaches it. Fixed for the sandbox's life; a fork or
   * a copy of a snapshot may only narrow its source's list. At most 64. */
  secrets?: string[];
  /** Omit to use the free usage while it lasts, then prepaid credit. */
  funding?: "trial" | "paid";
  region?: string;
  vcpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
  cpu?: "shared" | "reserved";
  cpuFloorMillis?: number;
  /** A time limit, 60 to 86400 seconds (24 hours). Leave it out (or 0) for
   * none: the sandbox runs while it works and pauses when idle, until you
   * stop it or credit runs out. */
  timeoutSeconds?: number;
  /** @deprecated Ignored since 5 October 2026: every sandbox can pause. */
  pausable?: boolean;
  /** What happens when its time limit, credit or a spending limit ends it:
   * "pause" (default), "stop", or "delete" (when the time limit runs out,
   * delete it and its files; credit or a spending limit only stops it). */
  onLeaseEnd?: "pause" | "stop" | "delete";
  /** Pause after this many seconds in which nothing happens in it: no
   * request, no command or terminal running, no open connection, no network
   * traffic and no CPU use. Default 300 unless persistent; 0 never;
   * otherwise 60 to 86400 (a shorter time is raised to 60). A request wakes
   * it again. */
  idlePauseSeconds?: number;
  /** A request to a paused sandbox wakes it. Default true. */
  autoWake?: boolean;
  /** "root": its commands, processes and terminals run as root, through the
   * sandbox's passwordless sudo, unless one says `user: "sandbox"`. Default
   * "sandbox"; a sandbox made from a snapshot runs as its source did. Files
   * written through `files` stay the sandbox user's. */
  user?: "sandbox" | "root";
  /** With no time limit, how far ahead each renewal funds it: 300 to 43200
   * seconds (12 hours). It is renewed when half is left, so it keeps running
   * for at least half of this through an outage of Runtime's control plane.
   * Each renewal holds that much time's credit; what it does not use is
   * released. Default: its first lease, usually 1800. */
  leaseSeconds?: number;
  /** Keep it running until you stop it, while credit lasts, with no idle
   * pause unless idlePauseSeconds asks for one. Its disk is billed as any
   * sandbox's, and kept after a stop, for restart(), as any sandbox's is.
   * Paid only. */
  persistent?: boolean;
  /** The most it may cost over its whole life, in microdollars. */
  maxTotalCostMicros?: number;
  /** With name: return the sandbox that already has the name, woken if paused. */
  getOrCreate?: boolean;
  /** @deprecated Use `maxTotalCostMicros`. Still accepted for older clients. */
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
  /** One to 16 ids of your own sandboxes or snapshots. The new sandbox starts
   * on a server none of them is on, and stays apart if its start is moved.
   * With no other server that has room, the create answers 503 `no_capacity`
   * and nothing is made or charged. A copy of a snapshot starts only where that
   * snapshot is kept, so a `snapshot` with `spreadFrom` naming its server also
   * answers `no_capacity`. */
  spreadFrom?: string[];
  /** Up to four volumes: read-write ("rw", one sandbox at a time) or a
   * read-only "snapshot" copy. */
  volumes?: { volumeId: string; path: string; mode?: "rw" | "snapshot" }[];
  /** Paid only: join your Tailscale network once running. `authKeySecret`
   * names a job secret holding the auth key. */
  tailscale?: { authKeySecret: string; hostname?: string; tags?: string[] };
};

/** Present on a command the sandbox's out-of-memory killer ended (the
 * program, or anything it started): a bare exit -9, or 137 from a shell,
 * does not say why. */
export type OutOfMemory = {
  code: "out_of_memory";
  processesKilled: number;
  /** The sandbox's memory size; null if it could not be read. */
  memoryMiB: number | null;
  message: string;
  /** What to do: a larger memoryMiB, or a program that uses less. */
  hint: string;
};

/** What a command run with `traceFiles` opened and wrote, until it exited. */
export type TracedFiles = {
  /** Every file and directory it, or anything it started, opened: sorted
   * absolute paths, links resolved; a directory (a listing) ends in "/". */
  read: string[];
  /** Every file it wrote. */
  written: string[];
  /** Some paths are missing: the lists are not the whole story. */
  truncated: boolean;
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
  outOfMemory?: OutOfMemory;
  /** With `traceFiles` only. */
  files?: TracedFiles;
};

export type ExecOptions = {
  cwd?: string;
  /** Who runs it: "sandbox" (uid 1000, HOME=/workspace) or "root", through
   * the sandbox's passwordless sudo with the same environment and PATH and
   * HOME=/root: no need to prefix it with sudo. Default: the sandbox's own
   * `user`, the sandbox user unless it was made with "root". */
  user?: "sandbox" | "root";
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
  /** Answer `files`: what the command read and wrote, for keying a cache by
   * what a test really read. */
  traceFiles?: boolean;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export type ProcessInfo = {
  id: string;
  kind: "process";
  state: "running" | "exited" | "killed" | "timed_out" | "unknown";
  exitCode: number | null;
  command: string;
  /** Who it runs as; absent from APIs before 17 October 2026. */
  user?: "sandbox" | "root";
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
  outOfMemory?: OutOfMemory;
};

export type OutputEvent =
  | { type: "start"; processId: string; replayed?: boolean }
  | { type: "stdout" | "stderr"; data: string; offset: number; base64?: string }
  | {
      type: "exit";
      exitCode: number | null;
      state: string;
      timedOut: boolean;
      durationMs?: number;
      outOfMemory?: OutOfMemory;
      /** An exec with `traceFiles`. */
      files?: TracedFiles;
    }
  | { type: "truncated"; droppedBytes: number; resumeAt: number }
  | { type: "continue"; processId: string; cursor: number }
  | {
      type: "error";
      error: { code: string; message: string; status?: number; requestId?: string };
    };

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

/** A signed link to one file of a sandbox (POST .../files:link): `url` opens
 * with no API key, GET to download (Range works) or PUT to upload, until
 * `expiresAt`. */
export type FileLink = {
  url: string;
  method: "GET" | "PUT";
  path: string;
  sandboxId: string;
  expiresAt: string;
  filename?: string;
  maxBytes?: number;
  archive?: boolean;
};

/** GET /v1/usage. Money is integer microdollars in strings (1,000,000 = $1),
 * exact past 2^53: available = credited - spent - expired - held. */
export type Usage = {
  orgId: string;
  unit: "microdollars";
  credited: string;
  spent: string;
  /** What running sandboxes and the hour ahead of stored items are about to
   * use, already taken out of `available`. */
  held: string;
  /** Credit that expired, or grant credit taken back. */
  expired: string;
  /** What can still be spent. */
  available: string;
  /** The part of spent that refunds and disputes took. */
  takenBack: string;
  /** Machine time the account can still run without credit, in
   * milliseconds, or null when it has none. `totalMs` and `usedMs` count free
   * hours given before 5 October 2026 (0 for an account given none);
   * `availableMs` is the larger of those hours left and this month's included
   * usage, as time at 2 vCPU and 4 GiB. The field keeps its older name. */
  trial: {
    totalMs: number;
    usedMs: number;
    /** @deprecated Read `availableMs`. Still sent for older clients. */
    reservedMs: number;
    availableMs: number;
    /** `monthly`: the free usage every month only. `hours`: free hours
     * given before 5 October 2026, kept, beside the free usage. Absent
     * from an API older than 5 October 2026. */
    offer?: "monthly" | "hours";
    /** When the free usage renews: the 1st of next month, 00:00 UTC. */
    renewsAt?: string;
  } | null;
  /** What the account uses free this calendar month (UTC), one row per
   * product, drawn before credit and never charged
   * (https://withruntime.com/docs/included-usage). */
  allowances?: Array<{
    /** machine-memory, machine-cpu, saved-copies or disks. */
    pool: string;
    /** GiB-hour, vCPU-hour or GB-month. */
    unit: string;
    quantity: number;
    used: number;
    /** Held for what is running now; given back unless used. */
    reserved: number;
    left: number;
    /** The month's first day, YYYY-MM-DD. */
    month: string;
    renewsAt: string;
    /** When the free machine time ends for an account that has never paid
     * (30 days after it opened); null once it has paid, when it renews
     * every month. Absent from an API older than 14 October 2026. */
    freeUntil?: string | null;
  }>;
  /** What Runtime for Startups includes (https://withruntime.com/startups).
   * Startup hours are given once, used after this month's free usage
   * and before credit, never renewed, and gone after 12 months. Storage is
   * GB kept free each month for those 12 months. Empty unless the account
   * was accepted to the program or given it; absent from an older API. */
  startupIncluded?: Array<{
    /** machine-cpu, machine-memory, saved-copies (snapshots, images and
     * backups) or disks (volumes). */
    pool: string;
    /** vCPU-hour or GiB-hour for startup hours given `once`, GB for `month` storage. */
    unit: string;
    /** `once`: given once and used up by what runs. `month`: `quantity` GB
     * added to each month's included storage until `expiresAt`, never used
     * up; storage past it bills at the published rate. Absent from an API
     * before startup storage (7 October 2026): `once`. */
    period?: "once" | "month";
    quantity: number;
    /** Null for monthly storage. */
    used: number | null;
    /** Held for what is running now; given back unless used. Null for
     * monthly storage. */
    reserved: number | null;
    /** Null for monthly storage. */
    left: number | null;
    /** Storage GB kept now; null for startup hours given `once`. */
    keptGB?: number | null;
    /** `startup`. */
    source: string;
    grantedAt: string;
    /** 12 months after `grantedAt`: what is left then is gone. */
    expiresAt?: string;
  }>;
  /** What Runtime for Startups includes at once for its 12 months:
   * image builds, and sandboxes (past it, a create answers quota_exceeded).
   * Null without one or after them, when the account's own limits apply;
   * absent from an API older than 7 October 2026. */
  startupLimits?: { buildsAtOnce: number; sandboxesAtOnce: number } | null;
  /** @deprecated Renamed `startupIncluded`; works for 30 days after the rename, with a warning. */
  readonly pot?: Usage["startupIncluded"];
  /** @deprecated Renamed `startupLimits`; works for 30 days after the rename, with a warning. */
  readonly potLimits?: Usage["startupLimits"];
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
  /** The account's pilot while it serves its sandboxes, a free run agreed
   * with Runtime: `hours` sandbox-hours of running time, `usedMs` and
   * `leftMs` of it used and left, and `running`, its sandboxes running now:
   * `leftMs / running` is how long the hours last at this rate. Null on every
   * other account. */
  pilot?: {
    id: string;
    sandboxes: number;
    vcpu: number;
    memoryMiB: number;
    diskMiB: number;
    startsAt: string;
    endsAt: string;
    graceEndsAt: string;
    endedAt: string | null;
    hours: number;
    usedMs: number;
    leftMs: number;
    running?: number;
  } | null;
  /** Everything this key acts for, a row a kind, past the hundred newest
   * `resources` lists: how many, and what was charged and is held, in
   * integer microdollars as strings. Absent from an API before 6 October 2026. */
  kinds?: Array<{ kind: string; resources: number; chargedMicros: string; heldMicros: string }>;
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
  /** Who later commands, processes and terminals run as when one names no
   * user; running ones keep theirs. */
  user?: "sandbox" | "root";
  /** Pause after this many seconds with no activity, counted from now; 0
   * never, otherwise 60 to 86400 (a shorter time is raised to 60). */
  idlePauseSeconds?: number;
  /** With no time limit, how far ahead each renewal funds it: 300 to 43200
   * seconds; null the default again. A running one is renewed by it within
   * seconds. */
  leaseSeconds?: number | null;
  /** Keep it running until you stop it, while credit lasts, and keep its disk
   * after a stop. Paid only. */
  persistent?: boolean;
  /** Lifetime cap in microdollars; null removes it. */
  maxTotalCostMicros?: number | null;
  /** A new time limit counted from now, 60 to 86400 seconds, sooner or later
   * than the one it had; 0 takes the limit away. A paused sandbox counts it
   * from its next wake. Not for a persistent sandbox. */
  timeoutSeconds?: number;
  /** What the end of its time limit does: pause, stop (keep the disk) or
   * delete. */
  onTimeout?: "pause" | "stop" | "delete";
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

/** How `sandbox.keepAlive()` moves on the time limit of a sandbox that has one. */
export type KeepAliveOptions = {
  /** How often it checks, in seconds. Default 60. */
  everySeconds?: number;
  /** How much of its time limit it keeps ahead of now, in seconds (60 to 3600). Default 600. */
  marginSeconds?: number;
  /** Called with an error an extension met; the loop carries on. */
  onError?: (error: unknown) => void;
};
