# JavaScript and TypeScript SDK

One client for every Runtime Cloud product. It runs on Node 22.12 or later, and on Bun.

`withruntime` ships the `runtime` CLI. Its one dependency, `undici`, loads only when a proxy applies. If you run behind a proxy, see [troubleshooting](./troubleshooting). In a Cloudflare Worker, it needs `nodejs_compat` and a wrapped `fetch`. See [calling Runtime from a Worker](./cloudflare-sandbox-alternative#calling-runtime-from-a-worker).

```bash no-run
npm install withruntime
```

This guide describes `withruntime` 0.45.0. Run `npm ls withruntime` to see the version you have. If a method named here is missing from yours, you have an older version. Run `npm install withruntime@latest` to update it.

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that variable is set. Otherwise, it uses the connection this machine saved. Any `npx withruntime` command creates that connection, with one browser approval.

On a server, put a key from https://withruntime.com/account/keys in `RUNTIME_API_KEY`. Load it from your secret manager. Never put it in source code, a URL, a browser bundle or a command-line argument. If no key is set anywhere, the first call fails with `missing_api_key`. The error says how to get one.

One plural word names each product. The CLI, the API and MCP use the same names. A name renamed on 6 October 2026 keeps working for 30 days after the rename ships. Each use prints the new name once on stderr. After 30 days, the old name fails with `name_retired`. The hint names the new one.

| Product                      | Old name                               |
| ---------------------------- | -------------------------------------- |
| `runtime.sandboxes`          | `runtime.sandbox`                      |
| `runtime.snapshots`          | `runtime.snapshot`                     |
| `runtime.images`             | `runtime.image`                        |
| `runtime.volumes`            | `runtime.volume`                       |
| `runtime.jobs`               | `runtime.job`                          |
| `runtime.domains`            | `runtime.domain`                       |
| `runtime.ports`              | `runtime.port`                         |
| `runtime.ips`                | `runtime.address`, `runtime.addresses` |
| `runtime.networks`           | `runtime.network`                      |
| `runtime.networks.wireguard` | `runtime.tunnel`                       |

Each product can also be imported alone. Use the same word, from `withruntime/<product>`: `sandboxes`, `snapshots`, `images`, `volumes`, `jobs`, `domains`, `ports`, `ips` and `networks`. Each import has one function. It takes the client's options and returns that product. It finds the key the same way.

```ts no-run
import { volumes } from "withruntime/volumes";

const volume = await volumes().create({ sizeMiB: 10_240, name: "cache" });
```

## Hello, sandbox

Write a file that totals three invoice amounts. Then run it. The total is 750.

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
const result = await sbx.exec("python3 /workspace/invoice.py");
console.log(result.exitCode, result.stdout); // 0, "750\n"
```

`Sandbox.create()` takes no required arguments. It returns once the sandbox is running. `await using` deletes the sandbox when the block ends, even after an error. To stop the sandbox instead and keep its disk, create it with `keep: true`. It needs Node 24, Bun, Deno or TypeScript. In plain JavaScript on Node 22, write `const sbx = ...` and call `await sbx.delete()` in a `finally` block.

With no arguments, you get the free usage while it lasts. You also get the default region, and 2 vCPU, 4 GiB of memory and a 4 GiB disk. The sandbox runs while it works. It pauses itself when idle. It has no time limit. A paid sandbox can have up to {{max-vcpu}} vCPUs and {{max-memory}}. A sandbox without credit can have 2 vCPU and 4 GiB.

The free usage is spent first, then prepaid credit. You cannot choose between them. `funding` is accepted and ignored. Every field is optional:

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
console.log(sbx.id, sbx.info.funding, sbx.info.endsAt);
await sbx.stop();
```

A sandbox needs no time limit. It runs while it works and pauses itself when idle. It keeps running until you stop it, or until credit or the [free usage](./included-usage) runs out. `timeoutSeconds` (60 to 86,400, 24 hours) sets a limit when you want one. The example above sets one. At the end, the sandbox pauses (the default) or stops, as `onLeaseEnd` says. This happens whether it is busy or not. `sbx.info.endsAt` is when it will stop or pause by itself. It is `null` when it never will. `sbx.extend(seconds)` moves the end later. `sbx.update({ timeoutSeconds, onTimeout })` sets a new end from now. It can be sooner or later. `0` removes the limit. `network` narrows what the sandbox can reach from its first start. See [the sandbox environment](./sandbox-environment).

`env` sets variables for the sandbox's whole life. They apply to every command, background process, terminal, SSH session and image start command in the sandbox. A command's own `env` takes precedence over them. Values are never shown again. `sbx.info` and every later response carry only `envNames`. `update({ env })` changes the variables. A value sets a variable, and `null` removes one. Changes apply to commands started after the update. The sandbox allows at most {{sandbox-env-vars}} variables and {{sandbox-env-size}}. Forks keep them ([API](./api#sandboxes)).

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({
  env: { QUEUE_URL: "https://queue.example.com", MODE: "worker" },
});
console.log(sbx.info.envNames); // ["MODE", "QUEUE_URL"]
await sbx.update({ env: { MODE: "drain", QUEUE_URL: null } });
await sbx.delete();
```

## Run commands

A string runs under `bash -c`. An array runs the program directly, with no shell. Use an array for untrusted arguments.

**A server, a watcher or anything that should keep running goes in [`spawn`](#background-processes), not `exec`.** Everything an `exec` starts ends when its command returns. That includes `nohup … &` and `setsid`. A result holds at most 64 KiB of each stream (see below).

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

- `env` is how secrets reach a command. It is never echoed back. Journals record a hash, not the value. Never put a secret in the command line itself.
- `user: "root"` runs the command as root, with no `sudo` in front. Its `env`, `PATH` and working directory stay the same. `HOME` is `/root`. The default, `"sandbox"`, is the user `runtime`. `spawn` and `terminal` take it too. A process says which user it runs as in `info.user`.
- `stdin` gives the command input, then closes it.
- The default timeout is 60 seconds. If the sandbox's time limit has less time left, the timeout is that time instead. When the output streams (`onStdout`, `onStderr` or `execStream`), the default is 24 hours. The maximum is 24 hours. A command with no `timeoutMs` is never refused for the time limit. A timeout is a result, not an exception. The result has `timedOut: true`, with the output so far.
- `check: true` throws `CommandError` on a non-zero exit, with the result on it.
- The sandbox's out-of-memory killer can end a command. When it does, the result has `outOfMemory` set. Its process has the same details: the code, processes killed, the sandbox's size, a message and a hint. With `check: true`, the call throws `CommandError` with the code `out_of_memory` ([when a program runs out of memory](./sandbox-environment#when-a-program-runs-out-of-memory)).
- A result holds at most 64 KiB (65,536 bytes) of `stdout` and 64 KiB of `stderr`. The rest is dropped. `stdoutTruncated` or `stderrTruncated` is `true` when output was dropped. When nothing was dropped, both are `false`. For more output, pass `onStdout` or `onStderr`. A `timeoutMs` over 60 seconds does the same. The command then streams, and the result keeps everything it printed. Or send the output to a file, such as `cmd > /workspace/out.log`. Then read it with `sbx.files.readText`.

Stream output as it happens, with callbacks or by iterating the events:

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

A stream that runs past the server's limit resumes by itself from the right byte. So no output is lost or repeated. While you read a command's stream, the command waits for you. That way it does not lose output, from its first byte. The sandbox keeps the latest 1 MiB. If a reader is away for more than 10 seconds while more than 1 MiB comes out, the reader loses the oldest part. It gets a `truncated` event. The result has both truncation flags set to `true`.

From withruntime 0.7.0, a stream also resumes from the right byte. This happens when its connection drops after the command started. A streamed exec cancelled through `signal` sends its command SIGTERM. It then throws `cancelled`, with `details.processId`. A stream that cannot pick up again throws `connection_error`. That error names the process, which may still be running. `sbx.processes.get(processId)` reads or stops it.

## Background processes

`spawn` starts a server, a watcher or a REPL. It returns immediately. The process outlives your connection. Get it back later with `sbx.processes.get(id)`.

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const server = await sbx.spawn("python3 -m http.server 8000", { cwd: "/workspace" });
console.log(server.id, server.state); // console.log(server) shows id, command, state, exitCode

const repl = await sbx.spawn(["python3", "-i", "-q"], { stdin: "pipe" });
await repl.write("print(sum([125, 250, 375]))\n");
await repl.write("exit()\n", { eof: true });
const done = await repl.wait();
console.log(done.stdout);

for (const p of await sbx.processes.list()) console.log(p.id, p.state, p.command);
await server.kill("SIGTERM");
```

`spawn(command, { request: { signal, timeoutMs, idempotencyKey } })` controls the HTTP request. It is separate from the process's execution timeout. The outer `timeoutMs` controls the guest process. `request.timeoutMs` controls the client's request and its retries.

`process.write()` tracks accepted input offsets. It keeps concurrent writes in order. When the process accepts only part of the input, later chunks match its capacity. When its input pipe is full, the SDK waits briefly and retries. It does not advance the offset while it waits. An empty EOF write closes input after earlier queued writes finish. Pass `signal` and `timeoutMs` in the same options object as `eof`. A caller-supplied `idempotencyKey` is refused before writing. Replaying a logical write after partial progress could duplicate input. Each request retry stays protected by its input offset and the SDK's per-request key. An explicit timeout covers the queue, every chunk and every backpressure wait together. A canceled queued write sends nothing. Process `get`, `list`, `kill` and `resize` also accept request options. They have the same cancellation and timeout controls.

`process.output()` yields every event from the start, or from a `cursor`. It does this until the process exits. The sandbox keeps each process's latest 1 MiB of output. So a reader that reconnects misses nothing. The exception is when more than 1 MiB came out while it was away. Then a `truncated` event says how many bytes are gone. `wait()` sets both truncation flags. A process that prints more than 1 MiB should write to a file.

## An interactive terminal

`terminal()` opens a real terminal over a WebSocket. What you write is typed into it. `onData` receives what the terminal prints, colours and all.

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

`npx withruntime sandboxes shell <id>` does the same from your own terminal.

## Files

Paths are absolute. `/workspace` is the sandbox user's home. Any path the user can reach works. `sudo` reaches the rest.

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

`write` creates parent directories and replaces the file atomically. Large files go in parallel, in 1 MiB chunks. Each chunk is checked by SHA-256. A transfer resumes after a dropped connection. Under `/workspace`, there is no size limit beyond the disk. Elsewhere, a file is written with the sandbox user's own rights. It can be at most 1 MiB. To write a larger file, write it to `/workspace`. Then move it with a command.

Copy whole directories in one call. They travel as one compressed archive.

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

`download(remote, local, { signal, timeoutMs })` applies one explicit deadline. The deadline covers metadata, transfer, gzip, extraction and retries. A file download publishes its temporary file only once it is complete. A directory download stages and verifies the archive before it merges. Cancellation stops later changes. Files already merged into an existing destination are kept.

An uploaded file keeps its permissions, so a script stays runnable. `write(path, data, { mode: 0o755 })` sets them. The default is 0o644 when left out.

`files.archive(path, { gzip, exclude, user })` returns a `Uint8Array` of a folder's tar bytes. The bytes are gzip-compressed by default. `exclude` takes plain relative paths, not globs. `files.unarchive(path, bytes, { gzip, user })` merges those bytes into a folder. It detects gzip when omitted. Both default to the sandbox user. Pass `user: "root"` explicitly for root-owned trees. This requires passwordless `sudo` inside the sandbox. For example:

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.files.write("/workspace/project/report.txt", "total: 750\n");
const archive = await sbx.files.archive("/workspace/project");
await sbx.files.unarchive("/workspace/restored", archive);
console.log(await sbx.files.readText("/workspace/restored/report.txt"));
```

A directory download keeps the links inside the directory. It throws `unsafe_archive` for any entry or link that would reach outside it. So nothing in a sandbox can write elsewhere on your machine. Before it publishes, the download also checks links against files already in the destination. Invalid checksums, malformed path metadata and incomplete tar end markers are refused. Do not treat a partial directory as a successful copy.

From `withruntime` 0.7.0, reads are checked. The API sends each file's length before its bytes. It also sends a small file's SHA-256. If a file arrives short, `read` reads it again. If it is still short, `read` throws `download_incomplete`. It does not return part of the file. For a file too big to hold in memory, use `readStream`. It hands you the bytes as they arrive (Daytona's `downloadFileStream`). It errors if they end short. `download` streams to disk through a partial file. The partial file is renamed into place only once it is whole:

```ts no-run
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const stream = await sbx.files.readStream("/workspace/dataset.tar");
await stream.pipeTo(Writable.toWeb(createWriteStream("dataset.tar")));
```

For single-file uploads on Node or Bun, `files.writeStream` accepts a local file path, a Blob, a byte iterator or a readable byte stream. It checks the complete size and digest before it starts the remote upload. A known local file or Blob needs no extra staging copy. An unknown-length source first writes one private temporary file. The temporary file is limited to the local disk space available at the start. Then the SDK reads that file for upload. This adds one extra write and read of the payload on your machine. Browser callers use `files.write` with byte data instead.

```ts no-run
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.files.writeStream("/workspace/dataset.tar", "./dataset.tar", {
  signal: AbortSignal.timeout(120_000),
  onProgress: ({ bytesSent }) => console.log(bytesSent),
});
```

Upload reads use bounded parallel chunks. The SDK does not buffer the whole file. Chunks from the source and transport buffers also use memory. When an upload is canceled or fails, the SDK closes the input streams it owns. It drains the active upload workers. It tries a remote abort, with a separate cleanup deadline. It removes the private stage. An input iterator that never finishes closing has a bounded cleanup wait.

`upload` and `download` of a directory move one tar archive through the API's folder routes. Those routes pack and unpack the archive with `tar` inside the sandbox. From a language with no SDK, the same routes take a plain PUT or GET ([files in the API guide](./api#files)). A downloaded folder is unpacked as it arrives. Its size is limited only by your disk. It lands in place only once all of it has arrived.

A sandbox holds at most 4 uploads and 4 downloads at once. Extra transfers wait for `transfer_limit` to clear. Each transfer frees its slot when it ends. A download left unread for a minute gives its slot to the next one.

### Watch files

`files.watch` delivers changes under a directory as they happen. It reports create, write, remove, rename (with `oldPath`) and chmod. It is E2B's `watchDir`, with more. It adds include and exclude globs. An excluded directory is not watched at all. It batches changes. Repeated writes to one file fold into one event with a `count`. A new directory is scanned as it appears. So files made in it before its watch took effect are reported too.

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

A sandbox runs at most four watches. Each watch ends after `timeoutMs`. The default is one hour. A flood of changes is capped at 5,000 events a second. Dropped events are reported through `onNotice`, as an `overflow` with how many were dropped. They are never dropped silently. Reading a watch never wakes a paused sandbox. Delivery stops with `onExit("paused")`. After the sandbox wakes, `watch.resume()` carries on from the same place. Nothing is lost.

To have changes pushed to you instead, start the watch for your account's [webhooks](./observability#events). Runtime reads the watch and sends `sandbox.files.changed` events. The events are signed and retried. Nothing of yours runs in the sandbox or reads here. The watch runs until stopped, unless you give `timeoutMs`. It never keeps a sandbox that pauses itself awake.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const watch = await sbx.files.watches.webhook("/workspace/app", { recursive: true, id: "sync" });
await sbx.files.watches.stop(watch.id);
```

## Pause, wake, extend

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({ timeoutSeconds: 600 }); // a ten-minute limit
await sbx.exec("echo state > /workspace/state.txt");
await sbx.pause(); // memory and files are kept; compute billing stops
// ... later, even from another process:
const again = await Sandbox.connect(sbx.id);
await again.wake({ timeoutSeconds: 1200 }); // a new limit, from the wake
await again.extend(600); // moves the limit ten minutes on
await again.stop();
```

A sandbox created without `timeoutSeconds` has no limit. So `wake()` needs no argument. `extend()` returns immediately and changes nothing.

A paused sandbox keeps its memory, its processes and its files. `pause()` returns once the sandbox's processors have stopped. That is when compute billing ends. The host then writes the sandbox's memory to disk. A wake or snapshot requested in the meantime waits for that write. Wake restores the sandbox on the same host. See [pricing](./pricing) for what a paused sandbox costs and how long it is kept.

A server keeps room for the memory of every sandbox it runs that can pause. When that room is short, a pause still succeeds. It can take up to about a minute while the server makes room. The server compresses saved memory images. It moves kept snapshots to other servers. It copies paused sandboxes to storage and shrinks them. If there is still no room, the sandbox is paused all the same. It is billed as paused. The server holds its memory and saves it once there is room. A wake in the meantime resumes the sandbox at once. Only a sandbox whose time is nearly up is not paused then. It is too near its end to save its memory later. For that sandbox, `pause()` fails with `no_capacity` (503, `retryable` true, `Retry-After: 60`). The sandbox keeps running with its memory and files. Pause again with a new call. That is a new request. A `pause()` that returns first, with the sandbox still `pausing`, has not failed. `GET /v1/sandboxes/{id}?waitFor=paused` (`sbx.refresh()` in a loop) shows `paused`. It shows `running` if the pause was not taken. A snapshot that the server has no room for is refused with `host_capacity` (503). Retry it later.

### Wake on request

A paused sandbox wakes by itself when a request needs it. Such requests include an `exec`, a file, process, terminal, desktop or code-interpreter call, or a visit to one of its shared ports. The call waits while the sandbox wakes. This takes about {{server-wake-command}} on Runtime's servers. Then the call runs. A browser that visits a shared port sees a short "Waking up" page. The page reloads itself. The wake is billed like any wake. Billing starts from the moment the sandbox runs again. The sandbox runs while it works again. A sandbox with a time limit gets a fresh limit of its own `timeoutSeconds`. Or it keeps the limit it paused with, if that ends later.

Turn it off with `autoWake: false` at create. Or turn it off later with `sbx.update({ autoWake: false })`. A call to a paused sandbox that cannot wake then fails with `sandbox_paused`, until you call `wake()`.

### Pause when idle

A sandbox pauses itself after **{{idle-pause}}** of idle time. Idle means nothing happens in it. There is no request. No command or terminal is still running. No preview, port, SSH or tunnel connection is open. There is no network traffic. Its processes use under a fortieth of a vCPU. A background job that computes or downloads keeps it running. With automatic wake, the next request wakes it. So a sandbox that is used now and then costs running time only while it is used. Between uses, it costs only parked storage.

`idlePauseSeconds` sets the idle time. It takes {{idle-pause-min}} to {{idle-pause-max}} seconds, or 0 for never. A `persistent` sandbox has no idle pause unless you set one.

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({ idlePauseSeconds: 600 }); // ten idle minutes
await sbx.update({ idlePauseSeconds: 1800 }); // change it later; 0 turns it off
```

The pause lands within about five seconds of the idle time. A sandbox created before 27 September 2026 keeps the idle setting it had. For the old default, `sbx.info.idlePauseUnusedOnly` is `true`. That default paused only a sandbox that nothing had used.

### Keep a sandbox running

A sandbox with no time limit keeps running while it works, with nothing to renew. Two settings go further:

- **`persistent: true`** keeps a paid sandbox running until you stop it. It runs whether idle or not, for as long as the account has credit. Its disk is billed and kept, as for any sandbox. So after a stop, `sbx.restart()` starts it again. Set a ceiling with `maxTotalCostMicros`. `update({ persistent: false })` makes it an ordinary sandbox again. `delete()` removes it for good.
- **`keepAlive`** moves a time limit on, from your process, while the process runs. It applies to a sandbox created with `timeoutSeconds`. It keeps the limit ten minutes ahead. It checks once a minute. It stops when you call `stop()`, or when you call the function it returns. On a sandbox with no time limit, it only watches.

```ts check
import { Sandbox } from "withruntime";

// Runs while credit lasts; restart() brings it back after a stop.
const server = await Sandbox.create({
  persistent: true,
  maxTotalCostMicros: 50_000_000, // at most $50 over its life
});
await server.update({ persistent: false }); // back to an ordinary sandbox

// A one-hour limit, moved on while this process holds it.
const worker = await Sandbox.create({ timeoutSeconds: 3600, keepAlive: true });
const release = worker.keepAlive({ marginSeconds: 1800 }); // or later, with options
release();
await worker.stop();
```

## Sandboxes by name

A name is unique in the account while its sandbox can still run. That means the sandbox is running, paused, or stopped and persistent. A key in a [compartment](./security#compartments) uses its compartment's own names. `Sandbox.getOrCreate(name)` returns that sandbox. It wakes the sandbox if it is paused. It restarts the sandbox if it is stopped and persistent. If no sandbox has the name, it creates one with the options you pass. `sbx.info.reused` is `true` when it found one.

```ts check
import { Sandbox } from "withruntime";

const dev = await Sandbox.getOrCreate("dev", { idlePauseSeconds: 900 });
await dev.exec("git pull || true");
// The next process, or tomorrow, gets the same sandbox and its files.
```

A create with a name that another sandbox holds fails with `name_taken`. `error.details.sandboxId` names that sandbox, when your key can reach it. A sandbox that stops for good gives up its name. It keeps the name in its own record. To rename a sandbox, use `sbx.update({ name })`.

## Find sandboxes again

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const page = await runtime.sandboxes.list({ labels: { team: "search" }, state: ["running"] });
for await (const sbx of page) console.log(sbx.id, sbx.info.name, sbx.state);
```

Every list in every product returns a page. `page.data` holds the items. `page.hasMore` says whether more pages exist. `await page.next()` gets the next page. `await page.toArray()` returns all items. `for await` walks every item on every page. Filter by `name`, `labels` and `state`. A stopped sandbox, whose disk is kept, is listed with the live ones. A sandbox whose disk is gone is listed only when you pass `includeStopped: true`.

`await runtime.sandboxes.stopAll({ labels: { team: "search" } })` stops every live sandbox that has all those labels. It stops eight at a time. It returns `{ stopped, failed }`. One failure does not stop the rest. The call needs at least one label. `await runtime.sandboxes.deleteAll({ labels: { team: "search" } })` deletes for good every sandbox with all those labels. Stopped sandboxes are deleted too. It works the same way, and returns `{ deleted, failed }`.

## Delete a sandbox

`await sbx.delete()`, or `runtime.sandboxes.delete(id)` without reading the sandbox first, removes a sandbox for good. It works in any state. It stops the sandbox. It deletes the sandbox's disk and paused memory. It revokes its previews and ports, frees its name, and removes it from every list. Its snapshots, usage and audit entries stay. Deleting it again returns the same `{ id, status: "deleted", deletedAt }`. Any other call to it then fails with `not_found`. Use `stop()` when you may want a persistent sandbox's disk back.

## Errors and retries

Every failure is a typed error. It has a `code`, a `message`, a `hint` that says what to do, and a `requestId` to quote to support.

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

| Class                     | When                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `AuthenticationError`     | 401: the key is missing, wrong or revoked                                                      |
| `PermissionDeniedError`   | 403: the key or account may not do this                                                        |
| `NotFoundError`           | 404: no such resource in this account                                                          |
| `ConflictError`           | 409: the wrong state, or a count you hold at its limit; change it first                        |
| `InvalidRequestError`     | 400 and 422: `details` names every wrong field                                                 |
| `RateLimitError`          | 429: your own limit that clears over time (rate, concurrent work, a daily cap); `retryAfterMs` |
| `ServiceUnavailableError` | 5xx: capacity or a dependency; `retryable` says whether to send it again                       |
| `AccountBlockedError`     | 402 `account_blocked`: a payment is disputed or in review (from 0.7.0)                         |
| `ConnectionError`         | No answer at all                                                                               |
| `CommandError`            | `check: true` and the command did not exit 0                                                   |

Every write carries an idempotency key. The SDK makes it for you. Timeouts, dropped connections and every response that says `retryable: true` are retried. They are retried with the same key, after its `Retry-After`. So a retried create never makes two sandboxes, and a retried command never runs twice. A wait over 60 seconds is not slept on. The error is returned immediately, with `retryAfterMs`. An attempt whose response has not started after 125 seconds is sent again the same way. The API starts every response within 120 seconds. So the server it was sent to is gone. This happens, for example, when the controller fails over mid-call. A response that ran nothing (`guest_busy`, `busy`, `rate_limited`) is sent again. It is retried until the call's deadline. Without a deadline, it is retried for five minutes, past `maxRetries`. For methods that accept it, pass your own `idempotencyKey`. Then a retry is safe across process restarts. A transport timeout or connection error on a mutation carries `error.idempotencyKey`. That includes the key the SDK generated. Reuse it with identical input only on methods that accept a caller key. `process.write` protects each input chunk with its offset and an SDK request key instead. It refuses a caller key. Interrupted complete response bodies are retried with the same key. Streamed output is never replayed after it reaches your code.

`timeoutMs` covers credential lookup, waiting for a local connection, sending, reading the response and automatic retries. `timeoutMs: 0` turns off that deadline. An `AbortSignal` you pass still cancels the call.

**A create, wake or restart waits for room.** Suppose all {{trial-sandboxes}} slots without credit are taken (`no_credit_running_limit`). Or the account is at its limit (`quota_exceeded`). Or the region is full (`no_capacity`). Then `sandboxes.create` waits. It sends the same request again, for up to two minutes. A burst of CI jobs past the limit queues instead of failing. A sandbox's `wake` and `restart` wait the same way when their own server is full (`no_capacity`). A sandbox stays on its server. So the wake is sent again with the same idempotency key until room frees up. A fork never waits.

- When the wait runs out, the refusal is thrown as it came.
- The wait is added to `timeoutMs`. It is not taken from it.
- Set `waitForCapacityMs` on the client, or on one create, wake or restart. `0` fails immediately, as in `await sbx.wake({ waitForCapacityMs: 0 })`.
- From withruntime 0.7.0, `onCapacityWait(refusal, waitMs)` on one create is called before each wait. It tells a person why nothing has happened yet. The CLI prints the refusal once on standard error.

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

An owner, admin or developer can make a read-only key, for monitoring and CI. They can also set a daily spending limit on a key that spends. Do both at [API keys](https://withruntime.com/account/keys). A key can read both settings. It cannot change either. `runtime.limits` needs withruntime 0.3.1 or later:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { access, daily } = await runtime.limits.get();
console.log(access); // "full", "read" or "selected"
if (daily.remainingMicros !== null && BigInt(daily.remainingMicros) < 1_000_000n)
  console.log("less than $1 left in this 24-hour window");
```

Past the limit, a create, wake, extension or renewal fails. It throws a `RuntimeError` whose `code` is `spending_limit_reached` (HTTP 402). It is not retried. Stop and tell the person you work for. A read-only key that asks to change anything gets `PermissionDeniedError`. See [security](./security).

## Secrets your sandboxes never see

Store an API key once with `runtime.secrets`. Name the hosts it may go to. Every sandbox in the account then has an environment variable. The variable has the secret's name, or the name set by `env`. It holds a placeholder. The host's proxy swaps in the real value on HTTPS requests to those hosts. The value is sealed and never returned:

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
const page = await runtime.secrets.list({ limit: 10, after: "GITHUB_TOKEN" }); // one page, by name
await runtime.secrets.delete("GITHUB_TOKEN");
```

With `header`, the proxy sets that header on every request to the hosts. `format` places the value in the header. With `rules`, on accounts with credit, only the requests a rule allows carry the value. A rule matches by method and path. A path is exact, or it ends in `/*`. Replacing a secret keeps its placeholder, so running sandboxes use the new value. See [security](./security#secrets-sandboxes-never-see) for the limits and for what is never rewritten.

With `env: "GITHUB_TOKEN"`, sandboxes see the placeholder in that variable. They do not see the secret's name. So secrets scoped with `only` to different sandboxes can share one variable. One example is a `GITHUB_TOKEN` for each repository. A store that would give one sandbox two of them is refused.

```ts check
import { Sandbox } from "withruntime";
await using sbx = await Sandbox.create({ secrets: ["ANTHROPIC_API_KEY"] });
console.log(sbx.info.secrets);
```

`secrets` limits a sandbox to the egress secrets you name. Only secrets that would otherwise reach it are counted. `[]` means none. Leaving it out means every one. The list is fixed for the sandbox's life. A `fork()` or a copy of a snapshot may only narrow it.

## Custom images

Build an image once with your dependencies. Then start every sandbox from it. Give exactly one source. It can be a `recipe` of packages. It can be an `image`, such as `python:3.12-slim`. Private registries work too. Or it can be a `dockerfile` with `contextDir`. That folder is the one `docker build` would read. Multi-stage builds, `COPY --from`, `ARG`, heredocs and `.dockerignore` all work. See [custom images](./images) for everything a build can do.

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

`build` streams the log to `onLog`. It waits until the image is ready. If the build fails, it throws the build's own error. `images.create` queues the build and returns immediately. Each build of a `name` becomes its next version. It takes the tag `latest`, or the `tags` you give. `image` on a create takes an id, `name`, `name:tag` or `name@version`. `start` sets what a sandbox from the image runs. It also sets when the create returns (`readyPort` or `readyCommand`). A Dockerfile's `CMD` and `HEALTHCHECK` fill it in.

`images.list()`, `images.versions(name)`, `images.resolve(ref)`, `images.tag(ref, tag)`, `images.untag(ref, tag)`, `images.logs(id)`, `images.followLogs(id, onLog)` and `images.delete(ref)` do the rest. `images.registries.set({ registry, username, password })` stores credentials for private images. A rebuild starts from the steps an earlier build shares. A stored image is charged on its whole file. This holds until copied-image accounting has been qualified and enabled. Where it is enabled, a verified identical copy in your account on the same server adds only its extra storage. The shared base and each verified extra allocation count once. They count while a ready copy still holds them. An extra allocation transfers only to proven descendants of the copy that added it ([pricing](./pricing#snapshots-images-and-volumes)). Building an image is not charged.

A new build leaves running sandboxes alone. `sbx.switchImage("data:v2")` moves a sandbox to the new build. It keeps the sandbox's id, `/workspace` (its home), volumes, environment and previews. Its processes restart. The rest of its old disk is lost. So snapshot it first to keep everything. A switch that fails is undone (`switch_undone`). See [move a sandbox to a new version](./images#move-a-sandbox-to-a-new-version).

## Volumes

A volume is a disk that outlives its sandboxes. Attach it read-write to one sandbox at a time. Or attach it as a read-only `snapshot` copy to any number of sandboxes.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const volume = await runtime.volumes.create({ sizeMiB: 10_240, name: "cache" });
await using sbx = await runtime.sandboxes.create({
  volumes: [{ volumeId: volume.id, path: "/data" }],
});
await sbx.exec("sudo chown runtime /data && echo kept > /data/note.txt");
```

A volume lives on one server. A sandbox that uses it is placed on that server. Runtime backs it up off that server every day, and whenever you ask. A backup restores as a new volume ([storage and backups](./storage)). The volume is charged on its full size from the moment it is created. This holds whether or not it is written ([pricing](./pricing#snapshots-images-and-volumes)). Stopping a sandbox first writes out what it wrote to its volumes. A time limit or credit that runs out does the same. The sandbox's programs are frozen just before its end. The write after that is not charged.

`sbx.mounts.add({ provider, bucket, path, secret })` mounts your own S3, R2 or Google Cloud Storage bucket as a directory. `sbx.mounts.list()` shows mounts. `sbx.mounts.remove(path)` ends a mount. The sandbox never holds the bucket's key ([mount your own bucket](./storage#mount-your-own-bucket)).

## Snapshots and forks

A fork is a copy of a sandbox as it is now. It has the same files, memory and running processes. It becomes a new sandbox of its own. Prepare a machine once. Then try several things from exactly that point.

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

A running sandbox is paused while a snapshot or fork captures it. It is woken before the call returns. A snapshot of a fresh sandbox is ready in {{server-snapshot}} on Runtime's servers. A bigger snapshot takes longer, the more memory it holds. A paused sandbox stays paused. Copies get the source's vCPUs, memory, disk and CPU. That covers reserved CPU, or a raised floor. Copies are billed as a create with those settings would be. They run on its host. A snapshot is kept on that host. It is copied off the host, encrypted, after its final compressed form is ready. It survives loss of the server once `backedUp` is `true`. That means the off-host copy has been checked ([storage and backups](./storage)). A sandbox with volumes cannot be snapshotted.

Snapshots default to `mode: "memory"`. That mode keeps files, memory and running processes. `await base.snapshot({ mode: "disk" })` keeps only the root filesystem. Each sandbox created from it boots fresh, without the saved processes. You set the `vcpu`, `memoryMiB` and `diskMiB` for each one. The disk must be at least the saved size. A copy of a memory snapshot is always the snapshot's size. Both modes pause a running source until capture finishes. Then they wake it. A source that was already paused stays paused. For a disk snapshot, the pause first waits for the sandbox to write out what it holds in memory. This takes a few seconds at most.

Where deferred compression has been qualified and enabled, a memory snapshot can be `ready` with `compressionPending: true`. Such a snapshot can start copies on the same server from the captured raw state. Runtime compresses it in the background. Billing uses its final verified compressed allocation. Temporary raw files are not charged. The off-server copy waits for that final form. So `backedUp` stays false while compression is pending. See [snapshot storage](./storage#snapshots-survive-their-server).

If a snapshot was captured but waking its source fails, the error keeps the original failure. It also includes `details.snapshotId`, `details.sourceSandboxId` and `details.sourceWakeError`. Read that saved snapshot. Wake the source explicitly before taking another capture. A failed recovery does not erase the snapshot id.

Copies run on what the account's new sandboxes run on, as `create` does. `funding` is accepted and ignored. On an account without credit, a copy must fit the limits without credit. So a sandbox with reserved CPU, or a floor above 250, forks only once the account holds credit.

The snapshot a fork takes is deleted when the fork ends. This happens whether or not every copy started. Nothing is billed for it. Pass `keepSnapshot: true` to keep it. You can then start more copies later. The kept snapshot is billed as snapshot storage.

- **A copy fails:** the error's `details.startedSandboxIds` names the copies that did start. They keep running, and billing, until you stop them.
- **Retrying:** a failed fork is over. A retry with the same idempotency key returns the same error. So fork again with a new key.
- **A fork stops partway,** for instance because our server restarted. A source the fork paused stays paused. It is not woken when nobody asked. An account notice (`GET /v1/notices`) names the sandbox and the fork. It says nothing was charged for the fork's snapshot. It also says how to wake the sandbox.

A snapshot is kept as long as you have credit. It has no end date. Without credit, it is kept for 7 days. Or it is kept for `retentionDays`, which can be 1 to 365. Delete it sooner with `runtime.snapshots.delete`.

## Code interpreter

A notebook-style session runs in the sandbox. It supports Python, JavaScript, TypeScript, R, Java, Bash and Go. Variables persist between runs. Go keeps its functions, types and imports. It runs each cell as a program. matplotlib charts and R plots come back as PNG. pandas and R data frames, and arrays of objects, come back as tables. In any language, `display` returns a file (.png, .svg, .html, .csv...) as a result.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.interpreter.run("import math\nx = math.pi");
const cell = await sbx.interpreter.run("round(x * 2, 3)");
console.log(cell.results[0]?.data["text/plain"]); // 6.283

const ts = await sbx.interpreter.run("const n: number = 21; n * 2", { language: "typescript" });
const r = await sbx.interpreter.run("summary(c(1, 2, 3))", { language: "r" });
```

Python, JavaScript, TypeScript and Bash are in the default image. R, Java and Go are installed from Ubuntu's archive. That happens the first time a context uses them. On 23 September 2026, this took about 35 seconds for Java or Go, and 90 seconds for R. It happens once per sandbox. To skip it, bake them into an image with `apt`.

## Network rules

`sbx.network.get()`, `sbx.network.set({ internet, allow, deny, connect })`, `sbx.network.off()` and `sbx.network.on()`. See [the sandbox environment](./sandbox-environment) for what each rule does.

## Share a port

A preview gives one port of a sandbox an HTTPS address. It is private by default. A request needs the token. Send the token in the `x-runtime-preview-token` header. Or use the `urlWithToken` link, which carries the token. That link works as it is in a browser, `fetch`, `curl` or a WebSocket client. It works until the token expires. A browser keeps the token for the site, and drops it from the address bar. This also applies inside an iframe on your own site. WebSockets work.

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

Pass `{ visibility: "public" }` for an address anyone can open. Only paid sandboxes can do this. A sandbox without credit's previews stay private. `previews.rotate(port)` refuses every token issued so far. `previews.delete(port)` stops sharing.

- **When a change applies:** sharing, rotating, deleting, and switching between public and private take effect when the call returns. The next request with an old token is refused. Runtime also closes any WebSocket opened with one.
- **Which sites may embed it:** `embedOrigins: ["https://app.example.com"]` holds the preview to those sites. You can list up to {{embed-origins}} sites. Use `https://*.example.com` for subdomains. Any other site's iframe is refused. The link's token works in an iframe only on the listed sites. If you leave it out, a shared port keeps its list. `[]` allows any site again. That is the default.
- **Token lifetime:** a token lasts a day by default. `ttlSeconds` sets the lifetime, from 60 seconds to 7 days. A token lasts at least that long. It lasts at most one step longer. A step is an hour, or a 24th of a shorter lifetime. So reads within a step return the same token. A browser's cookie from the link lasts exactly as long as its token.
- **Absolute token deadline:** pass `expiresAt` as a timezone-qualified ISO timestamp in `create`. Or pass it in `previews.get(port, undefined, { expiresAt })`. It must be between a minute and a week ahead. It rounds down to a whole second. If you pass both fields, the earlier deadline wins. A session's expiry also limits its preview reads. Use the returned `tokenExpiresAt` as the actual deadline. This requires the server's matching absolute-deadline support. An older server refuses the field. It does not substitute a relative lifetime.
- **When the sandbox is not running:** a paused or waking sandbox's preview returns 503 with `Retry-After` while it wakes. A stopped sandbox's preview returns 404. A deleted or failed sandbox's preview returns 410. Neither of the last two has `Retry-After`. A preview's address is under `runtimehost.com`. That is the domain for everything sandboxes serve. It is kept apart from Runtime's own site.

## A sandbox from a browser

A session lets your own frontend reach one sandbox directly. Calls do not pass through your servers, and the browser holds no key. Your backend creates the session with its key. It then gives the page the token:

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

- **What it can do:** run commands and read their output as it streams. It can start and drive processes, read, write and watch files, and run the code interpreter. It can also read the sandbox's previews with their tokens.
- **What it cannot:** stop, pause, extend, fork, snapshot or change the sandbox. It cannot create anything. It cannot reach another sandbox, keys, billing or secrets. Those calls return `403 forbidden`.
- **How long:** {{session-default}}, unless `ttlSeconds` asks otherwise. Never more than {{session-max}}. `sbx.sessions.revoke(id)` ends one immediately. Revoking the key that made a session ends all of that key's sessions. `sbx.sessions.list()` shows them.
- **Which pages:** `origins` lists up to {{session-origins}} exact origins, such as `https://host`. While you develop, use `http://localhost:5173`. The API allows CORS for those origins alone. It refuses a request from any other page.
- **Who can make one:** a key that can run commands in the sandbox. The session acts as that key's agent, so it can never do more than the key.
- **Money:** a session spends only what the sandbox already spends. A paused sandbox wakes for its commands only if the sandbox wakes on requests (`autoWake`, on by default). It wakes with the time limit it had, if any.
- **Terminals:** a session has no WebSocket terminal. Start a process with `spawn(command, { pty: {}, stdin: "pipe" })`, write to it and follow its output.

The token appears in the response to `create` only. Keep it out of logs and URLs.

## A desktop

A Linux desktop runs in the sandbox. You drive it as a person would. Open a page, click, type, press keys, take screenshots, and watch it live.

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

The live view is a private preview of the desktop. `streamUrl` carries its token, so anyone holding it can watch. Open it in a browser, and keep it to yourself.

The desktop and Chromium are ready on every server. The first start in a sandbox installs nothing on its disk. It takes about a second.

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

A recording uses one encoder thread, at low priority, and at most 4 Mbit/s. So the desktop and your programs come first. A recording file never grows past `maxMiB`. Recording stops before the sandbox's disk fills. A sandbox keeps at most 8 GiB of recordings. Recordings are files on the sandbox's own disk. They count toward its disk. Nothing is stored or charged apart from that.

A recording started before the desktop is running is refused immediately with 409 `desktop_not_running`. Nothing is installed or written.

## A browser over CDP

`sbx.browser.start()` runs Chromium in the sandbox. It returns `cdpUrl`, the address that Playwright, Puppeteer, browser-use and Stagehand connect to. The browser runs in the sandbox, so its traffic follows the sandbox's network rules.

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create({ memoryMiB: 2048 });
const { cdpUrl, version } = await sbx.browser.start();
console.log(version, cdpUrl);
```

Give a browser 2 GiB. Chromium takes what the sandbox has, and heavy apps need that memory. We measured 100 visits to ten heavy pages. The pages ranged from news sites to Google Sheets, YouTube and StackBlitz. None crashed at 2 GiB. At 1.5 GiB, 20 visits crashed for memory. At 1 GiB, 56 crashed. These results were measured on 6 October 2026. 1 GiB suits light pages and scraping. It costs half the memory charge. Under 2 GiB, `start` returns a `hint` that says so. The hint sits beside `memoryMiB`, the sandbox's size. The browser starts either way.

Pass `cdpUrl` to the tool as it is. Use `chromium.connectOverCDP(cdpUrl)` in Playwright. Use `puppeteer.connect({ browserWSEndpoint: cdpUrl })` in Puppeteer.

`cdpUrl` is private. It carries a token that lasts a day. `sbx.browser.get()` returns a fresh one. Anyone holding it can drive the browser, so keep it to yourself. Code inside the sandbox finds the same browser at `http://127.0.0.1:9222`. `start({ headless: false })` shows the browser on the sandbox's [desktop](#a-desktop). It also returns the live view as `streamUrl`. `sbx.browser.stop()` ends the browser. After that, `get()` returns `running: false`. The browser comes from the host as a read-only disk. So a start in a new sandbox takes about 1 to 2 seconds, and installs nothing. A sandbox from a custom image that is not Ubuntu 24.04 x86_64 installs Chromium on its first start. That takes about a minute, once. `start` waits for the install. Called directly, the API returns 409 `browser_installing` until the install is done. Call again after `retryAfterMs`. A browser that cannot start or install returns 409 `browser_failed`. The error carries the sandbox's own words.

The CLI is `runtime sandboxes browser <id> start`, and agents use the MCP tool `runtime_sandboxes_browser`.

### A page in under a second

For many short tasks, such as fetching one page each, keep spare browsers paused. A paused sandbox is charged only for its storage. It wakes in about a tenth of a second, with Chromium as it was:

```ts check
import { Sandbox } from "withruntime";

const spare = await Sandbox.create({ vcpu: 1, memoryMiB: 1024 });
const { cdpUrl } = await spare.browser.start();
await spare.pause(); // ready for the next page

await spare.wake(); // about 0.1 s
// connect to cdpUrl, open a new browser context, fetch the page, close it
await spare.pause();
```

Open each page in its own browser context. In Playwright, that is `browser.newContext()`. So no cookie or storage passes from one page to the next. On 18 October 2026, we measured from a client outside Runtime. A woken spare had one page loaded, its screenshot taken and its HTML read. That took 0.56 to 0.81 seconds after the wake was asked for.

Wikipedia, BBC News and a GitHub repository page each peaked between 194 and 331 MiB. So 1 GiB is enough for fetching pages like these.

## MCP servers in a sandbox

Start well-known MCP servers inside a sandbox with one call. Then give your agent their URLs. `runtime.mcp.catalog()` lists them. The list has 15 servers in all: GitHub, Postgres, a Playwright browser, filesystem, fetch, git, time, memory, sequential thinking, Notion, Context7, Brave Search, Exa, Firecrawl and Supabase. Each entry gives its licence (all MIT or Apache-2.0), pinned version, settings and the hosts it calls.

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

Each server is reached at its own Streamable HTTP URL. That URL goes through a private preview link. Every request also needs the gateway's bearer token. A secret setting names a [Runtime secret](./security#secrets-sandboxes-never-see). The server sees only a placeholder. The egress proxy puts the value into its HTTPS requests to the secret's own hosts. A database password cannot be swapped that way. So the Postgres server's `DATABASE_URI` is passed as given. The servers run as the sandbox's user, behind its own network rules. A host the rules refuse is a warning, never a change. Your own stdio server runs the same way. For example: `{ name: "mine", command: ["python3", "server.py"] }`.

### A URL to configure an agent with once

With `public: true`, the URLs carry no link token. They never expire. So an agent, or a teammate's MCP client, can be set up with them once. The `Authorization` header still guards every request. The header is kept. A start after the sandbox restarted gives the same header. So does a start with `replace`. `stop()` forgets the header. The next start makes a new one. Like any public preview, it needs an account with a kept top-up.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
// No time limit: idle, it pauses with the servers in memory, and the next
// request wakes it, waiting the moment that takes rather than failing.
const sbx = await runtime.sandboxes.getOrCreate("mcp", { idlePauseSeconds: 300 });
const gateway = await sbx.mcp.start([{ id: "fetch" }], { public: true, replace: true });
console.log(gateway.servers[0]?.url, gateway.headers); // the same after every start
```

A stopped sandbox does not wake on a request. Call `sbx.restart()` to start it again. The same start gives the same URL and header. For your own name, point a [domain](./networking) at the gateway's port. The port is 8765 unless you chose another.

## Domains, TCP ports, addresses, the tunnel and your own proxy

Paid accounts only. See [networking](./networking).

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
const ip = await runtime.ips.reserve(); // ip.address
await runtime.networks.wireguard.create();
const office = await runtime.networks.wireguard.addPeer({
  name: "office",
  routes: ["10.0.0.0/16"],
});
console.log(office.config); // a wg-quick file
await runtime.networks.upstreamProxy.set({
  url: "http://proxy.example.com:3128",
  secret: "PROXY_AUTH",
});
```

`runtime.networks.upstreamProxy` sends every sandbox's outbound connections through your own proxy. It is available from `withruntime` 0.12.0. From 0.7.0, it is `runtime.network.upstreamProxy`. `get()` reads the proxy setting. `remove()` removes it. See [your own proxy](./security#your-own-proxy).

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

`runtime.events.list()` reads lifecycle events. `runtime.otel.create()` pushes events and metrics to an OpenTelemetry endpoint. See [metrics and webhooks](./observability).

## Account API calls

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const counts = await runtime.usageRequests("7d");
console.log(counts.calls, counts.errorPercent);
for (const row of counts.operations) console.log(row.operation, row.serverErrors);
```

`usageRequests()` defaults to `"24h"`. `"7d"`, `"30d"` and `"90d"` select longer windows. Counts are exact decimal strings. `errorPercent` is null when no calls were counted. A key needs the `usage` scope. It also needs read-only access or all-products access. See [account API calls](./observability#account-api-calls).

### Export settled usage

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
let cursor: string | undefined;
do {
  const page = await runtime.usageExport({
    since: "2026-09-01T00:00:00Z",
    until: "2026-10-01T00:00:00Z",
    ...(cursor ? { cursor } : {}),
  });
  process.stdout.write(page.csv);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

The range includes settlements at `since`. It excludes settlements at `until`. Pending holds are excluded. Rows cover every visible product, with exact amount strings. Concatenate each server CSV page unchanged. The header appears only on the first page. Each page checks current permissions and reads current settlements. `page.finalThrough` is the time before which no more charges will settle. The range is final once it reaches `until`. A row's `final` is true once its resource is deleted and can be charged nothing more. See [export settled usage](./api#export-settled-usage).

## Identity tokens

Inside a sandbox, `Sandbox.identityToken({ audience })` returns a short-lived OIDC token. The token names the sandbox. Use it to trade for AWS or Google Cloud credentials, without a stored key. It needs no API key. `runtime.sso.get()` reads the account's single sign-on. See [identity tokens](./identity-tokens) and [single sign-on](./single-sign-on).

## Feedback and support

`runtime.feedback.submit(...)` tells the team what broke or is missing. `runtime.support.message(...)` asks for help. See [feedback and support](./feedback-and-support).

## Coming from E2B, Daytona, Vercel Sandbox or Blaxel

After you change the import, their supported sandbox calls keep the same call shapes on Runtime. The versions are `withruntime` 0.4.0 or later for E2B. They are 0.5.0 or later for Daytona and Vercel Sandbox. They are 0.8.0 or later for Blaxel:

```ts no-run
import { Sandbox } from "withruntime/e2b"; // was: from "e2b"
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk"
import { Sandbox as VercelSandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
import { MorphCloudClient } from "withruntime/morph"; // was: from "morphcloud"
import { ModalClient } from "withruntime/modal"; // was: from "modal"
```

Sandboxes get the old provider's defaults. If Runtime cannot honor a call the same way, the call throws `NotSupportedError`. It does this before anything happens. The error names what to use instead. `E2B.md`, `DAYTONA.md`, `VERCEL.md` and `BLAXEL.md` in the package list every mapping and gap. To move to Runtime's own calls, see [migration](./migrate).

To run a Worker written for Cloudflare's Sandbox SDK (0.x), change its import to `withruntime/cloudflare`. Delete the `containers` block from its Wrangler config. Add a `RUNTIME_API_KEY` secret. See [change the import](./cloudflare-sandbox-alternative#change-the-import).

To run code that calls Fly's Machines API, change only its address, to `npx withruntime fly-api`. A Node service can answer the same calls itself. It uses `machinesApi()` from `withruntime/fly`. See [migration](./migrate).

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

`RUNTIME_API_URL` points the client at another API origin. Code inside a Runtime sandbox calls Runtime's API at `http://runtime.internal`. See [Runtime's API from inside a sandbox](./sandbox-environment#runtime-s-api-from-inside-a-sandbox). Connections are kept alive and reused across calls. A client holds at most 48 connections at once (`maxConnections`). That count includes calls and streams, such as a command's output. The client keeps 8 of them for calls. Past that limit, calls and streams wait their turn instead of failing. One address may hold 64 connections to the API until it has used a valid key. After that, it may hold more. See [limits](./api#limits).

Before 0.3.0, the package was `@withruntime/cloud`. That name, and `runtime-cloud` and `withruntime-cloud`, stopped at 0.5.1. They get no new releases. Install `withruntime` for everything since.
