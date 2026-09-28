# JavaScript and TypeScript SDK

One client for every Runtime Cloud product, for Node 22.12 or later and Bun.

`withruntime` ships the `runtime` CLI. Its one dependency, `undici`, loads only
when a proxy applies. Behind a proxy, see [troubleshooting](./troubleshooting).
In a Cloudflare Worker it needs `nodejs_compat` and a wrapped `fetch`; see
[calling Runtime from a Worker](./cloudflare-sandbox-alternative#calling-runtime-from-a-worker).

```bash no-run
npm install withruntime
```

This guide describes `withruntime` 0.8.4. `npm ls withruntime` shows the version
you have; a method named here that yours lacks means an older one, and
`npm install withruntime@latest` updates it.

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that is
set, and otherwise the connection this machine saved (any `npx withruntime`
command connects it, with one browser approval).

On a server, put a key from https://withruntime.com/account/keys in
`RUNTIME_API_KEY` from your secret manager. Never put it in source code, a URL,
a browser bundle or a command-line argument. With no key anywhere, the first
call fails with `missing_api_key` and says how to get one.

## Hello, sandbox

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const result = await sbx.exec("python3 -c 'print(6 * 7)'");
console.log(result.exitCode, result.stdout);
```

`Sandbox.create()` takes no required arguments and returns once the sandbox is
running. `await using` stops it when the block ends, even after an error. It
needs Node 24, Bun, Deno or TypeScript; in plain JavaScript on Node 22, write
`const sbx = ...` and call `await sbx.stop()` in a `finally` block.

With no arguments you get the free trial while it lasts, the default region, and
2 vCPU, 4 GiB of memory and a 4 GiB disk for up to 30 minutes. A paid sandbox
can have up to {{max-vcpu}} vCPUs and {{max-memory}}; a trial one, 2 vCPU and 4 GiB. Every field
is optional:

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY, or this machine's connection
const sbx = await runtime.sandboxes.create({
  name: "tests-42",
  labels: { team: "search", job: "42" },
  vcpu: 2,
  memoryMiB: 4096,
  diskMiB: 8192,
  timeoutSeconds: 900,
  onLeaseEnd: "stop",
  network: { internet: true, allow: ["pypi.org", "*.pythonhosted.org"] },
});
console.log(sbx.id, sbx.info.funding, sbx.info.expiresAt);
await sbx.stop();
```

`timeoutSeconds` is how long the sandbox may run before its lease ends. At the
end it pauses (the default) or stops, as `onLeaseEnd` says. `network` narrows
what it can reach from its first start; see [the sandbox environment](./sandbox-environment).

## Run commands

A string runs under `bash -c`. An array runs the program directly, with no shell,
which is what you want for untrusted arguments.

**A server, a watcher or anything that should keep running goes in
[`spawn`](#background-processes), not `exec`.** Everything an `exec` starts,
`nohup … &` and `setsid` included, ends when its command returns, and a result
holds at most 64 KiB of each stream (see below).

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.exec("mkdir -p app && echo 'print(1 + 1)' > app/main.py");
const run = await sbx.exec(["python3", "main.py"], {
  cwd: "/workspace/app",
  env: { API_TOKEN: process.env.API_TOKEN ?? "" },
  timeoutMs: 120_000,
});
if (run.exitCode !== 0) console.error(run.stderr);
```

- `env` is how secrets reach a command. It is never echoed back, and journals
  record a hash, not the value. Never put a secret in the command line itself.
- `stdin` gives the command input, then closes it.
- The default timeout is 60 seconds, and 24 hours when the output streams
  (`onStdout`, `onStderr` or `execStream`); the maximum is 24 hours. A timeout
  is a result (`timedOut: true`, with the output so far), not an exception.
- `check: true` throws `CommandError` on a non-zero exit, with the result on it.
- A result holds at most 64 KiB (65,536 bytes) of `stdout` and 64 KiB of
  `stderr`. The rest is dropped, and `stdoutTruncated` or `stderrTruncated` is
  `true`; when nothing was dropped, both are `false`. For more output, pass
  `onStdout` or `onStderr` (a `timeoutMs` over 60 seconds does the same): the
  command then streams, and the result keeps everything it printed. Or send the
  output to a file (`cmd > /workspace/out.log`) and read it with
  `sbx.files.readText`.

Stream output as it happens with callbacks, or iterate the events:

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.exec("for i in 1 2 3; do echo line $i; sleep 1; done", {
  onStdout: (text) => process.stdout.write(text),
  onStderr: (text) => process.stderr.write(text),
});
for await (const event of sbx.execStream("npm --version")) {
  if (event.type === "stdout") process.stdout.write(event.data);
  if (event.type === "exit") console.log("exit", event.exitCode);
}
```

A stream that runs past the server's limit resumes by itself from the right byte,
so no output is lost or repeated. While you read a command's stream, the command
waits for you rather than lose output, from its first byte. The sandbox keeps
the latest 1 MiB; a reader away for more than 10 seconds while more than that
came out loses the oldest part, gets a `truncated` event, and the result has
both truncation flags `true`.

From withruntime 0.7.0, a stream whose connection drops after the command
started also resumes from the right byte. A streamed exec cancelled through
`signal` sends its command SIGTERM and throws `cancelled`, with
`details.processId`; one that cannot pick its stream up again throws
`connection_error` naming the process, which may still be running:
`sbx.processes.get(processId)` reads or stops it.

## Background processes

`spawn` starts a server, a watcher or a REPL and returns at once. The process
outlives your connection; get it back later with `sbx.processes.get(id)`.

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const server = await sbx.spawn("python3 -m http.server 8000", { cwd: "/workspace" });
console.log(server.id, server.info.state);

const repl = await sbx.spawn(["python3", "-i", "-q"], { stdin: "pipe" });
await repl.write("print(21 * 2)\n");
await repl.write("exit()\n", { eof: true });
const done = await repl.wait();
console.log(done.stdout);

for (const p of await sbx.processes.list()) console.log(p.id, p.state, p.command);
await server.kill("SIGTERM");
```

`process.output()` yields every event from the start, or from a `cursor`, until
the process exits. The sandbox keeps each process's latest 1 MiB of output, so a
reader that reconnects misses nothing unless more than that came out while it
was away. Then a `truncated` event says how many bytes are gone, and `wait()`
sets both truncation flags. A process that prints more than 1 MiB should write
to a file.

## An interactive terminal

`terminal()` opens a real terminal over a WebSocket: what you write is typed, and
`onData` receives what the terminal prints, colours and all.

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const term = await sbx.terminal({
  cols: 120,
  rows: 40,
  onData: (bytes) => process.stdout.write(bytes),
});
term.write("echo hello from the terminal\n");
term.resize(100, 30);
term.write("exit\n");
console.log("exit code", await term.exited);
```

`npx withruntime sandbox shell <id>` does the same from your own terminal.

## Files

Paths are absolute. `/workspace` is the sandbox user's home; any path the user
can reach works, and `sudo` reaches the rest.

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.files.write("/workspace/data/input.csv", "a,b\n1,2\n");
const text = await sbx.files.readText("/workspace/data/input.csv");
const bytes = await sbx.files.read("/workspace/data/input.csv");
console.log(text.length === bytes.length);

console.log(await sbx.files.exists("/workspace/data/input.csv"));
console.log(await sbx.files.stat("/workspace/data/input.csv"));
for (const entry of await sbx.files.list("/workspace", { depth: 2 }))
  console.log(entry.type, entry.size, entry.path);
console.log(await sbx.files.glob("**/*.csv"));

await sbx.files.mkdir("/workspace/out");
await sbx.files.rename("/workspace/data/input.csv", "/workspace/out/input.csv");
await sbx.files.remove("/workspace/data", { recursive: true });
```

`write` makes parent directories and replaces the file atomically. Large files go
in parallel 1 MiB chunks, each checked by SHA-256, and resume after a dropped
connection. Under `/workspace` there is no size limit beyond the disk. Elsewhere
a file is written with the sandbox user's own rights and can be at most 1 MiB;
write a larger one to `/workspace` and move it with a command.

Copy whole directories in one call. They travel as one compressed archive:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "withruntime";

const project = await mkdtemp(join(tmpdir(), "project-"));
await writeFile(join(project, "main.py"), "print('hi')\n");

await using sbx = await Sandbox.create();
await sbx.files.upload(project, "/workspace/project");
await sbx.exec("cd project && python3 main.py > result.txt");
await sbx.files.download("/workspace/project", join(project, "..", "project-out"));
```

An uploaded file keeps its permissions, so a script stays runnable;
`write(path, data, { mode: 0o755 })` sets them (0o644 when left out).

A directory download keeps the links inside the directory and throws
`unsafe_archive` for any entry or link that would reach outside it, so
nothing in a sandbox can write elsewhere on your machine.

From `withruntime` 0.7.0, reads are checked. The API sends
every file's length before its bytes, and a small file's SHA-256; `read` reads
a file that arrives short again, then throws
`download_incomplete` rather than return part of it. For a file too big to hold
in memory, `readStream` hands you the bytes as they arrive (Daytona's
`downloadFileStream`) and errors if they end short, and `download` streams to
disk through a partial file that is renamed into place only once it is whole:

```ts no-run
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const stream = await sbx.files.readStream("/workspace/dataset.tar");
await stream.pipeTo(Writable.toWeb(createWriteStream("dataset.tar")));
```

A sandbox holds at most 4 uploads and 4 downloads at once; more wait for
`transfer_limit` to clear. Each frees its slot when it ends, and a download
left unread for a minute gives its slot to the next one.

### Watch files

`files.watch` delivers changes under a directory as they happen: create,
write, remove, rename (with `oldPath`) and chmod. It is E2B's `watchDir`, and
more: include and exclude globs (an excluded directory is not watched at all),
batches with repeated writes to one file folded into one event and a `count`,
and a new directory scanned as it appears, so files made in it before its watch
took effect are reported too.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const watch = await sbx.files.watch("/workspace", (event) => console.log(event.type, event.path), {
  recursive: true,
  exclude: ["node_modules", ".git/**"],
  onNotice: (notice) => console.warn("rescan:", notice),
  onExit: (reason) => console.log("watch ended:", reason),
});
await sbx.exec("echo hi > /workspace/note.txt");
await watch.stop();
```

A sandbox runs at most four watches, and each ends after `timeoutMs` (one hour
by default). A flood of changes is capped at 5,000 events a second and reported
through `onNotice` (an `overflow` with how many were dropped), never silently.
Reading a watch never wakes a paused sandbox: delivery stops with
`onExit("paused")`, and `watch.resume()` after it wakes carries on from the
same place, with nothing lost.

## Pause, wake, extend

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({ timeoutSeconds: 600 });
await sbx.exec("echo state > /workspace/state.txt");
await sbx.pause(); // memory and files are kept; compute billing stops
// ... later, even from another process:
const again = await Sandbox.connect(sbx.id);
await again.wake({ timeoutSeconds: 1200 });
await again.extend(600); // more time before the lease ends
await again.stop();
```

A paused sandbox keeps its memory, its processes and its files. `pause()`
returns once the sandbox's processors have stopped, which is where compute
billing ends; the host then writes its memory to disk, and a wake or snapshot
asked for meanwhile waits for that write. Wake restores it on the same host. See [pricing](./pricing) for what a paused sandbox costs and
how long it is kept.

### Wake on request

A paused sandbox wakes by itself when a request needs it: an `exec`, a file,
process, terminal, desktop or code-interpreter call, or a visit to one of its
shared ports. The call waits while it wakes, about {{wake}}, and
then runs. A browser that visits a shared port sees a short "Waking up" page
that reloads itself. The wake is billed like any wake, from the moment the
sandbox runs again, and it gets a fresh lease of its own `timeoutSeconds`, or
keeps the lease it paused with when that ends later.

Turn it off with `autoWake: false` at create, or later with
`sbx.update({ autoWake: false })`. A call to a paused sandbox that cannot wake
then fails with `sandbox_paused` until you call `wake()`.

### Pause when idle

A sandbox pauses itself after **{{idle-pause}}** in which nothing happens in it: no
request, no command or terminal still running, no open preview, port, SSH or
tunnel connection, no network traffic, and its processes using under a fortieth
of a vCPU. A background job that computes or downloads keeps it running. With
automatic wake, the next request wakes it, so a sandbox that is used now and
then costs running time only while it is used and parked storage in between.

`idlePauseSeconds` sets the idle time: {{idle-pause-min}} to {{idle-pause-max}} seconds, or 0 for never. A
`persistent` sandbox has none unless you set it.

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({ idlePauseSeconds: 600 }); // ten idle minutes
await sbx.update({ idlePauseSeconds: 1800 }); // change it later; 0 turns it off
```

The pause lands within about five seconds of the idle time. A sandbox that
cannot pause (`pausable: false`) never pauses for being idle. One created before
27 September 2026 keeps the idle setting it had; `sbx.info.idlePauseUnusedOnly`
is `true` for the old default, which paused only a sandbox nothing had used.

### Keep a sandbox running

Two ways, for two jobs:

- **`persistent: true`** keeps a paid sandbox running for as long as the
  account has credit: its lease renews itself on the server, and after a stop
  its disk is kept, billed as reserved disk, so `sbx.restart()` starts it
  again. Set a ceiling with `maxTotalCostMicros`.
- **`keepAlive`** extends the lease from your process while it runs, which
  suits a job or a notebook that owns the sandbox. It extends the lease so ten
  minutes remain, once a minute, and stops when you call `stop()` or the
  function it returns.

```ts check
import { Sandbox } from "withruntime";

// Runs while credit lasts; restart() brings it back after a stop.
const server = await Sandbox.create({
  funding: "paid",
  persistent: true,
  maxTotalCostMicros: 50_000_000, // at most $50 over its life
});
await server.update({ persistent: false }); // back to an ordinary lease

// Kept running while this process holds it.
const worker = await Sandbox.create({ keepAlive: true });
const release = worker.keepAlive({ marginSeconds: 1800 }); // or later, with options
release();
await worker.stop();
```

## Sandboxes by name

A name is unique in the account while its sandbox can still run: running,
paused, or stopped and persistent. `Sandbox.getOrCreate(name)` answers that
sandbox, woken if it is paused and restarted if it is stopped and persistent,
or creates one with the options you pass. `sbx.info.reused` is `true` when it
found one.

```ts check
import { Sandbox } from "withruntime";

const dev = await Sandbox.getOrCreate("dev", { idlePauseSeconds: 900 });
await dev.exec("git pull || true");
// The next process, or tomorrow, gets the same sandbox and its files.
```

A create with a name another sandbox holds fails with `name_taken`, and
`error.details.sandboxId` names that sandbox when your key can reach it. A
sandbox that stops for good gives its name up and keeps it in its own record.
Rename one with `sbx.update({ name })`.

## Find sandboxes again

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const page = await runtime.sandboxes.list({ labels: { team: "search" }, state: ["running"] });
for await (const sbx of page) console.log(sbx.id, sbx.info.name, sbx.state);
```

Every list in every product returns a page: `page.data`, `page.hasMore`,
`await page.next()` for the next page, `await page.toArray()`, and `for await`
walks every item on every page. Filter by `name`, `labels`
and `state`; stopped sandboxes are left out unless you pass `includeStopped: true`.

## Errors and retries

Every failure is a typed error with a `code`, a `message`, a `hint` that says what
to do, and a `requestId` to quote to support.

```ts
import { NotFoundError, RuntimeError, Sandbox } from "withruntime";

try {
  await Sandbox.connect("00000000-0000-4000-8000-000000000000");
} catch (error) {
  if (error instanceof NotFoundError) console.log("no such sandbox");
  else if (error instanceof RuntimeError) console.log(error.code, error.hint, error.requestId);
  else throw error;
}
```

| Class                     | When                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `AuthenticationError`     | 401: the key is missing, wrong or revoked                              |
| `PermissionDeniedError`   | 403: the key or account may not do this                                |
| `NotFoundError`           | 404: no such resource in this account                                  |
| `ConflictError`           | 409: the resource is in the wrong state, or the trial busy             |
| `InvalidRequestError`     | 400 and 422: `details` names every wrong field                         |
| `RateLimitError`          | 429: slow down; `retryAfterMs` says how long                           |
| `ServiceUnavailableError` | 503: capacity or a dependency; safe to retry                           |
| `AccountBlockedError`     | 402 `account_blocked`: a payment is disputed or in review (from 0.7.0) |
| `ConnectionError`         | No answer at all                                                       |
| `CommandError`            | `check: true` and the command did not exit 0                           |

Every write carries an idempotency key, made for you. Timeouts, dropped
connections, 429 and 503 are retried with the same key and a growing delay, so a
retried create never makes two sandboxes and a retried command never runs twice.
Pass your own `idempotencyKey` to make a retry safe across process restarts.

**A create waits for room.** When every trial slot is taken (`trial_busy`), the
account is at its limit (`quota_exceeded`) or the region is full
(`no_capacity`), `sandboxes.create` waits and sends the same request again, for
up to two minutes. A burst of CI jobs past the limit queues instead of failing.

- When the wait runs out, the refusal is thrown as it came.
- The wait is added to `timeoutMs`, not taken from it.
- Set `waitForCapacityMs` on the client or on one create. `0` fails at once.
- From withruntime 0.7.0, `onCapacityWait(refusal, waitMs)` on one create is
  called before each wait,
  to tell a person why nothing has happened yet. The CLI prints the refusal
  once on standard error.

```ts
import { Runtime } from "withruntime";

// A CI job that may queue for ten minutes behind the others.
const runtime = new Runtime({ waitForCapacityMs: 600_000 });
await using sbx = await runtime.sandboxes.create();
// One create that should fail at once instead.
await using now = await runtime.sandboxes.create({}, { waitForCapacityMs: 0 });
// One that says why it is waiting (withruntime 0.7.0).
await using told = await runtime.sandboxes.create(
  {},
  { onCapacityWait: (refusal) => console.error(`${refusal.message} Waiting.`) },
);
```

## Read-only keys and daily limits

An owner, admin or developer can make a read-only key, for monitoring and CI,
and can set a daily spending limit on a key that spends, at
[API keys](https://withruntime.com/account/keys). A key reads both and can
change neither. `runtime.limits` needs withruntime 0.3.1 or later:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { access, daily } = await runtime.limits.get();
console.log(access); // "full", "read" or "selected"
if (daily.remainingMicros !== null && BigInt(daily.remainingMicros) < 1_000_000n)
  console.log("less than $1 left in this 24-hour window");
```

Past the limit, a create, wake, extension or renewal fails with a
`RuntimeError` whose `code` is `spending_limit_reached` (HTTP 402). It is not
retried: stop and tell the person you work for. A read-only key asking to change
anything gets `PermissionDeniedError`. See [security](./security).

## Secrets your sandboxes never see

Store an API key once with `runtime.secrets`, naming the hosts it may go to.
Every sandbox of the account then has an environment variable of that name
holding a placeholder, and the host's proxy swaps in the real value on HTTPS
requests to those hosts. The value is sealed and never returned:

```ts check
import { Runtime } from "withruntime";
const runtime = new Runtime();
await runtime.secrets.set("GITHUB_TOKEN", {
  value: process.env.GITHUB_TOKEN ?? "",
  hosts: ["api.github.com"],
  header: "Authorization",
  format: "token {value}",
  rules: [{ methods: ["GET", "HEAD"], paths: ["/repos/acme/*"] }],
});
for (const secret of await runtime.secrets.list()) console.log(secret.name, secret.hosts);
await runtime.secrets.delete("GITHUB_TOKEN");
```

With `header`, the proxy sets that header on every request to the hosts, with
`format` placing the value. With `rules`, on paid accounts, only the requests a
rule allows by method and path carry it: a path is exact or ends in `/*`.
Replacing a secret keeps its placeholder, so running sandboxes use the new
value. See [security](./security#secrets-sandboxes-never-see) for the limits
and what is never rewritten.

## Custom images

Build an image once with your dependencies, then start every sandbox from it.
Give exactly one source: a `recipe` of packages, an `image` such as
`python:3.12-slim` (private registries too), or a `dockerfile` with
`contextDir`, the folder `docker build` would read. Multi-stage builds,
`COPY --from`, `ARG`, heredocs and `.dockerignore` all work. See
[custom images](./images) for everything a build can do.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const image = await runtime.images.build(
  { name: "data", recipe: { pip: ["pandas"], apt: ["jq"] } },
  { onLog: (line) => console.log(line.text) },
);
await using sbx = await runtime.sandboxes.create({ image: "data" });
console.log(
  image.version,
  (await sbx.exec("python3 -c 'import pandas; print(pandas.__version__)'")).stdout,
);
```

`build` streams the log to `onLog`, waits until the image is ready and throws
with the build's own error if it fails; `images.create` queues it and returns at
once. Each build of a `name` is its next version and takes the tag `latest`, or
the `tags` you give; `image` on a create takes an id, `name`, `name:tag` or
`name@version`. `start` sets what a sandbox from the image runs and when its
create answers (`readyPort` or `readyCommand`); a Dockerfile's `CMD` and
`HEALTHCHECK` fill it in.

`images.list()`, `images.versions(name)`, `images.resolve(ref)`,
`images.tag(ref, tag)`, `images.untag(ref, tag)`, `images.logs(id)`,
`images.followLogs(id, onLog)` and `images.delete(ref)` do the rest, and
`images.registries.set({ registry, username, password })` stores credentials
for private images. A rebuild starts from the steps an earlier build shares. A
stored image is charged on its whole file
([pricing](./pricing#snapshots-images-and-volumes)); building one is not.

## Volumes

A volume is a disk that outlives sandboxes. Attach it read-write to one sandbox
at a time, or as a read-only `snapshot` copy to any number.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const volume = await runtime.volumes.create({ sizeMiB: 10_240, name: "cache" });
await using sbx = await runtime.sandboxes.create({
  volumes: [{ volumeId: volume.id, path: "/data" }],
});
await sbx.exec("sudo chown runtime /data && echo kept > /data/note.txt");
```

A volume lives on one server, and a sandbox that uses it is placed on that
server. It is backed up off that server every day and whenever you
ask, and a backup restores as a new volume ([storage and backups](./storage)). It is charged on its full size from the
moment it is created, written or not ([pricing](./pricing#snapshots-images-and-volumes)).
Stopping a sandbox has it write out what it wrote to its volumes first. A
sandbox whose lease runs out stops at once, so run `sync` after writes it must
keep.

`sbx.mounts.add({ provider, bucket, path, secret })` mounts your own S3, R2 or
Google Cloud Storage bucket as a directory, and `sbx.mounts.list()` and
`sbx.mounts.remove(path)` show and end mounts. The sandbox never holds the
bucket's key ([mount your own bucket](./storage#mount-your-own-bucket)).

## Snapshots and forks

A fork is a copy of a sandbox as it is now: its files, its memory and its
running processes, as a new sandbox of its own. Prepare a machine once, then try
several things from exactly that point.

```ts check
import { Runtime, Sandbox } from "withruntime";

const runtime = new Runtime();
await using base = await Sandbox.create();
await base.exec("pip install --quiet requests");
const [a, b] = await base.fork({ count: 2 }); // both running, answered together
await Promise.all([a!.stop(), b!.stop()]);

// Or keep the machine to start copies from later:
const snapshot = await base.snapshot({ name: "with-requests", retentionDays: 7 });
await using later = await runtime.sandboxes.create({ snapshot: snapshot.id });
await runtime.snapshots.delete(snapshot.id);
```

A running sandbox is paused while a snapshot or fork captures it, then woken before the call
returns (a snapshot of a fresh sandbox is ready in {{snapshot-take}}, longer the more memory it holds); a paused one stays paused. Copies get the source's
vCPUs, memory, disk and CPU (reserved CPU, or a raised floor), are billed as a
create with those would be, and run on its host. A snapshot is kept on that
host and copied off it, encrypted, as soon as it is taken, so it survives the
loss of the server ([storage and backups](./storage)); a sandbox with volumes
cannot be snapshotted.

`fork` takes `funding` as `create` does: `"trial"` or `"paid"`. Without it, the
copies keep the source's funding. A trial copy must fit the trial, so a sandbox
with reserved CPU, or a floor above 250, forks only onto `"paid"`.

The snapshot a fork takes is deleted when the fork ends, whether every copy
started or not, and nothing is billed for it. Pass `keepSnapshot: true` to keep
it and start more copies later; it is then billed as snapshot storage.

- **A copy fails:** the error's `details.startedSandboxIds` names the copies that
  did start. They keep running, and billing, until you stop them.
- **Retrying:** a failed fork is over. A retry with the same idempotency key
  answers the same error, so fork again with a new one.
- **`pausable: false`:** a fork pauses its source for a moment, so a sandbox
  created this way cannot be forked.
- **A fork stops partway,** for instance because our server restarted: a source
  it paused stays paused rather than being woken with nobody asking. An account
  notice (`GET /v1/notices`) names the sandbox and the fork, says nothing was
  charged for the fork's snapshot, and says how to wake it.

A snapshot is kept for `retentionDays`, 1 to 365, and 7 when omitted; delete it
sooner with `runtime.snapshots.delete`.

## Code interpreter

A notebook-style session in the sandbox, in Python, JavaScript, TypeScript, R,
Java, Bash or Go. Variables persist between runs (Go keeps its functions, types
and imports, and runs each cell as a program); matplotlib charts and R plots
come back as PNG, pandas and R data frames and arrays of objects as tables.
In any language, `display` returns a file (.png, .svg, .html, .csv...) as a
result.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.interpreter.run("import math\nx = math.pi");
const cell = await sbx.interpreter.run("round(x * 2, 3)");
console.log(cell.results[0]?.data["text/plain"]); // 6.283

const ts = await sbx.interpreter.run("const n: number = 21; n * 2", { language: "typescript" });
const r = await sbx.interpreter.run("summary(c(1, 2, 3))", { language: "r" });
```

Python, JavaScript, TypeScript and Bash are in the default image. R, Java and
Go are installed from Ubuntu's archive the first time a context uses them (on
23 September 2026 that took about 35 seconds for Java or Go and 90 for R, once
per sandbox); bake them into an image with `apt` to skip it.

## Network rules

`sbx.network.get()`, `sbx.network.set({ internet, allow, deny, connect })`,
`sbx.network.off()` and `sbx.network.on()`; see
[the sandbox environment](./sandbox-environment) for what each rule does.

## Share a port

A preview gives one port of a sandbox an HTTPS address. It is private by default:
a request needs the token, sent as the `x-runtime-preview-token` header, or
the `urlWithToken` link, which carries it. That link works as it is in a
browser, `fetch`, `curl` or a WebSocket client until the token expires; a
browser keeps the token for the site and drops it from the address bar.
WebSockets work.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.spawn("python3 -m http.server 3000");
const preview = await sbx.previews.create(3000);
const page = await fetch(preview.url, {
  headers: { "x-runtime-preview-token": preview.token! },
});
console.log(page.status);
```

Pass `{ visibility: "public" }` for an address anyone can open (paid sandboxes;
a trial sandbox's previews stay private), `previews.rotate(port)`
to refuse every token issued so far, and `previews.delete(port)` to stop sharing.

- **Token lifetime:** a day by default; `ttlSeconds` sets 60 seconds to 7 days.
  A token lasts at least that long and at most one step longer (an hour, or a
  24th of a shorter lifetime), so reads within a step return the same token. A
  browser's cookie from the link lasts exactly as long as its token.
- **When the sandbox is not running:** a paused or waking sandbox's preview
  answers 503 with `Retry-After` while it wakes; a stopped one answers 404, and
  a deleted or failed one 410, neither with `Retry-After`.
  A preview's address is under `runtimehost.com`, the domain for everything
  sandboxes serve, kept apart from Runtime's own site.

## A sandbox from a browser

A session lets your own frontend reach one sandbox directly, without passing
every call through your servers and without a key in the browser. Your backend
makes it with its key and hands the page the token:

```ts no-run
// On your server, with RUNTIME_API_KEY.
import { Sandbox } from "withruntime";

export async function sessionFor(sandboxId: string) {
  const sbx = await Sandbox.connect(sandboxId);
  const session = await sbx.sessions.create({
    origins: ["https://app.example.com"],
    ttlSeconds: 900,
  });
  return { token: session.token, sandboxId: session.sandboxId };
}
```

```ts no-run
// In the page, with what your server returned.
import { Sandbox } from "withruntime";

const { token, sandboxId } = (await (await fetch("/api/sandbox-session")).json()) as {
  token: string;
  sandboxId: string;
};
const sbx = Sandbox.fromSession({ token, sandboxId });
const { stdout } = await sbx.exec("ls /workspace");
await sbx.files.write("/workspace/notes.txt", "from the browser");
console.log(stdout);
```

- **What it can do:** run commands and read their output as it streams, start
  and drive processes, read, write and watch files, run the code interpreter,
  and read the sandbox's previews with their tokens.
- **What it cannot:** stop, pause, extend, fork, snapshot or change the
  sandbox, create anything, or reach another sandbox, keys, billing or
  secrets. Those answer `403 forbidden`.
- **How long:** {{session-default}} unless `ttlSeconds` asks otherwise, and
  {{session-max}} at most. `sbx.sessions.revoke(id)` ends one at once, and
  revoking the key that made it ends all of its sessions. `sbx.sessions.list()`
  shows them.
- **Which pages:** `origins` lists up to {{session-origins}} exact origins,
  `https://host` or `http://localhost:5173` while developing. The API answers
  CORS for those alone and refuses a request from any other page.
- **Who can make one:** a key that can run commands in the sandbox. The
  session acts as that key's agent, so it can never do more than the key.
- **Money:** a session spends only what the sandbox already does. A paused
  sandbox wakes for its commands only if the sandbox wakes on requests
  (`autoWake`, on by default), with the lease it had.
- **Terminals:** a session has no WebSocket terminal. Start a process with
  `spawn(command, { pty: {}, stdin: "pipe" })`, write to it and follow its
  output.

The token is in the answer to `create` only; keep it out of logs and URLs.

## A desktop

A Linux desktop in the sandbox, driven like a person would: open a page, click,
type, press keys, take screenshots, and watch it live.

```ts check
import { writeFile } from "node:fs/promises";
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const { streamUrl } = await sbx.desktop.start({ width: 1280, height: 800 });
console.log("watch it:", streamUrl);
await sbx.desktop.open("https://example.com");
await sbx.desktop.click(640, 400);
await sbx.desktop.type("hello");
await writeFile("screen.png", await sbx.desktop.screenshot());
```

The live view is a private preview of the desktop: `streamUrl` carries its
token, so anyone holding it can watch. Open it in a browser and keep it to
yourself.

The first start in a sandbox installs the desktop (about 90 seconds and 1 GB
of its disk, once); Firefox follows in the background, and an `open` before it
is ready waits for it.

Record the screen to MP4:

```ts check
import { writeFile } from "node:fs/promises";
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.desktop.start();
const rec = await sbx.desktop.recordings.start({ fps: 10, maxMiB: 256 });
await sbx.desktop.open("https://example.com");
await sbx.desktop.recordings.stop(rec.id);
await writeFile("demo.mp4", await sbx.desktop.recordings.download(rec.id));
```

A recording uses one encoder thread at low priority and at most 4 Mbit/s, so
the desktop and your programs come first. Its file never grows past `maxMiB`,
recording stops before the sandbox's disk fills, and a sandbox keeps at most
8 GiB of recordings. They are files on the sandbox's own disk, counted with it;
nothing is stored or charged apart from it.

## MCP servers in a sandbox

Start well-known MCP servers inside a sandbox with one call, and give your
agent their URLs. `runtime.mcp.catalog()` lists them: GitHub, Postgres, a
Playwright browser, filesystem, fetch, git, time, memory, sequential thinking,
Notion, Context7, Brave Search, Exa, Firecrawl and Supabase, 15 in all, each
with its licence (all MIT or
Apache-2.0), pinned version, settings and the hosts it calls.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await using sbx = await runtime.sandboxes.create();
await sbx.mcp.start([
  { id: "github", secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_TOKEN" } },
  { id: "fetch" },
]);
const gateway = await sbx.mcp.ready(); // every server installed
for (const server of gateway.servers) console.log(server.name, server.url);
console.log(gateway.headers); // { Authorization: "Bearer ..." } on every request
```

Each server is reached at its own Streamable HTTP URL, through a private
preview link, and every request also needs the gateway's bearer token. A
secret setting names a [Runtime secret](./security#secrets-sandboxes-never-see):
the server sees only a placeholder, and the egress proxy puts the value into
its HTTPS requests to the secret's own hosts. A database password cannot be
swapped that way, so the Postgres server's `DATABASE_URI` is passed as given.
The servers run as the sandbox's user behind its own network rules: a host
the rules refuse is a warning, never a change. Your own stdio server runs the
same way: `{ name: "mine", command: ["python3", "server.py"] }`.

## Domains, TCP ports, addresses, the tunnel and your own proxy

Paid accounts only; see [networking](./networking).

```ts check
import { Runtime } from "withruntime";
const runtime = new Runtime();
const sbx = await runtime.sandboxes.create();
const domain = await runtime.domains.add({
  hostname: "app.example.com",
  sandboxId: sbx.id,
  port: 3000,
});
console.log(domain.records); // the TXT and CNAME to set; then runtime.domains.verify("app.example.com")
const db = await runtime.ports.open({ sandboxId: sbx.id, port: 5432 });
console.log(db.connect); // "203.0.113.10:23456"
const ip = await runtime.addresses.reserve(); // ip.address
await runtime.tunnel.create();
const office = await runtime.tunnel.addPeer({
  name: "office",
  routes: ["10.0.0.0/16"],
});
console.log(office.config); // a wg-quick file
await runtime.network.upstreamProxy.set({
  url: "http://proxy.example.com:3128",
  secret: "PROXY_AUTH",
});
```

`runtime.network.upstreamProxy`, from `withruntime` 0.7.0,
sends every sandbox's outbound connections through your own proxy; `get()` and
`remove()` read and undo it. See
[your own proxy](./security#your-own-proxy).

## Metrics and webhooks

```ts check
import { Runtime, Sandbox, verifyWebhook } from "withruntime";

const sbx = await Sandbox.create();
const { latest } = await sbx.metrics({ range: "15m" }); // CPU and memory, measured

const runtime = new Runtime();
const hook = await runtime.webhooks.create({ url: "https://example.com/hooks/runtime" });
// In the endpoint: await verifyWebhook(rawBody, request.headers.get("runtime-signature"), hook.secret!)
console.log(latest?.cpuPercent, typeof verifyWebhook);
```

`runtime.events.list()` reads lifecycle events and `runtime.otel.create()`
pushes events and metrics to an OpenTelemetry endpoint. See
[metrics and webhooks](./observability).

## Identity tokens

Inside a sandbox, `Sandbox.identityToken({ audience })` returns a short-lived
OIDC token naming the sandbox, to trade for AWS or Google Cloud credentials
without a stored key. It needs no API key. `runtime.sso.get()` reads the
account's single sign-on. See [identity tokens](./identity-tokens) and
[single sign-on](./single-sign-on).

## Feedback and support

`runtime.feedback.submit(...)` tells the team what broke or is missing, and
`runtime.support.message(...)` asks for help; see
[feedback and support](./feedback-and-support).

## Coming from E2B, Daytona, Vercel Sandbox or Blaxel

Code written for their SDKs runs on Runtime after changing one import, in
`withruntime` 0.4.0 and later for E2B and 0.5.0 and later for Daytona and
Vercel Sandbox, and 0.8.0 and later for Blaxel:

```ts no-run
import { Sandbox } from "withruntime/e2b"; // was: from "e2b"
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk"
import { Sandbox as VercelSandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
```

Sandboxes get the old provider's defaults, and a call Runtime cannot honour
the same way throws `NotSupportedError` before anything happens, naming what
to use instead. `E2B.md`, `DAYTONA.md`, `VERCEL.md` and `BLAXEL.md` in the
package list every mapping and gap. To move to Runtime's own calls, see
[migration](./migrate).

## Configuration

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime({
  apiKey: process.env.RUNTIME_API_KEY, // the default
  maxRetries: 4,
  timeoutMs: 120_000,
});
console.log((await runtime.me()).orgId);
```

`RUNTIME_API_URL` points the client at another API origin. Connections are kept
alive and reused across calls.

Before 0.3.0 the package was `@withruntime/cloud`. That name, and
`runtime-cloud` and `withruntime-cloud`, stopped at 0.5.1 and get no new
releases: install `withruntime` for everything since.
