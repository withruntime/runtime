# Python SDK

One Python client for every Runtime Cloud product, sync and async, method for method.

`withruntime` needs Python 3.10 or later and uses only the standard library. It
imports in about 30 ms and keeps its connections open between calls.

```bash no-run
pip install withruntime
```

This guide describes `withruntime` 0.11.0. `pip show withruntime` shows the
version you have; a method named here that yours lacks means an older one, and
`pip install -U withruntime` updates it.

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that is
set, and otherwise the connection this machine saved (any `npx withruntime`
command connects it, with one browser approval).

On a server, put a key from https://withruntime.com/account/keys in
`RUNTIME_API_KEY` from your secret manager. Never put it in source code, a URL
or a command-line argument. With no key anywhere, the first call fails with
`missing_api_key` and says how to get one.

The singular product names match the CLI. Each pair below uses the same
product client, connections and defaults; existing plural calls keep working.

| Preferred product  | Existing alias      |
| ------------------ | ------------------- |
| `runtime.sandbox`  | `runtime.sandboxes` |
| `runtime.snapshot` | `runtime.snapshots` |
| `runtime.image`    | `runtime.images`    |
| `runtime.volume`   | `runtime.volumes`   |
| `runtime.job`      | `runtime.jobs`      |
| `runtime.domain`   | `runtime.domains`   |
| `runtime.port`     | `runtime.ports`     |
| `runtime.address`  | `runtime.addresses` |

## Hello, sandbox

Write a file that totals three invoice amounts, then run it; the total is 750.

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n")
    result = sbx.exec("python3 /workspace/invoice.py")
    print(result.exit_code, result.stdout)  # 0, "750\n"
```

`Sandbox.create()` takes no required arguments and returns once the sandbox is
running. Leaving the `with` block stops it, even after an exception.

With no arguments you get the free trial while it lasts, the default region, and
2 vCPU, 4 GiB of memory and a 4 GiB disk for up to 30 minutes. A paid sandbox
can have up to {{max-vcpu}} vCPUs and {{max-memory}}; a trial one, 2 vCPU and
4 GiB.

Omitting `funding` can use prepaid credit after the trial is exhausted. Set
`funding="trial"` when you want free use only; it never falls back to paid.
Every field is optional and takes snake_case names:

```python
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY, or this machine's connection
sbx = runtime.sandboxes.create(
    name="tests-42",
    labels={"team": "search", "job": "42"},
    vcpu=2,
    memory_mib=4096,
    disk_mib=8192,
    timeout_seconds=900,
    on_lease_end="stop",
    network={"internet": True, "allow": ["pypi.org", "*.pythonhosted.org"]},
)
print(sbx.id, sbx.info["funding"], sbx.info["expiresAt"])
sbx.stop()
```

`timeout_seconds` is how long the sandbox may run before its lease ends; then
it pauses or stops, as `on_lease_end` says. A trial sandbox that is still
working then gets its `timeout_seconds` again, until the trial hours run out
([trial](./trial)); a paid one runs longer with `persistent` or `keep_alive`.

`env` sets variables for every command, background process, terminal, SSH
session and image start command in the sandbox, for its whole life; a
command's own `env` goes over them. Values are never shown again: `sbx.info`
and every later answer carry only `envNames`. `update(env=...)` changes them, a
value setting a variable and `None` removing one, for commands started after
it. At most {{sandbox-env-vars}} variables and {{sandbox-env-size}}; forks keep them
([API](./api#sandboxes)).

```python check
from withruntime import Runtime

runtime = Runtime()
sbx = runtime.sandboxes.create(env={"QUEUE_URL": "https://queue.example.com", "MODE": "worker"})
print(sbx.info["envNames"])  # ['MODE', 'QUEUE_URL']
sbx.update(env={"MODE": "drain", "QUEUE_URL": None})
sbx.delete()
```

The async client is the same with `await`:

```python
import asyncio
from withruntime import AsyncRuntime


async def main():
    async with AsyncRuntime() as runtime:
        async with await runtime.sandboxes.create() as sbx:
            results = await asyncio.gather(*(sbx.exec(f"echo {i}") for i in range(10)))
            print([r.stdout.strip() for r in results])


asyncio.run(main())
```

## Run commands

A string runs under `bash -c`. A list runs the program directly, with no shell,
which is what you want for untrusted arguments.

**A server, a watcher or anything that should keep running goes in
[`spawn`](#background-processes), not `exec`.** Everything an `exec` starts,
`nohup … &` and `setsid` included, ends when its command returns, and a result
holds at most 64 KiB of each stream (see below).

```python
import os
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.exec("mkdir -p app && echo 'print(1 + 1)' > app/main.py")
    run = sbx.exec(
        ["python3", "main.py"],
        cwd="/workspace/app",
        env={"API_TOKEN": os.environ.get("API_TOKEN", "")},
        timeout_ms=120_000,
    )
    if run.exit_code != 0:
        print(run.stderr)
```

- `env` is how secrets reach a command. It is never echoed back, and journals
  record a hash, not the value. Never put a secret in the command line itself.
- `stdin` gives the command input, then closes it.
- The default timeout is 60 seconds, or what the sandbox's lease has left when
  that is less, and 24 hours when the output streams (`on_stdout`,
  `on_stderr` or `exec_stream`); the maximum is 24 hours. A command with no
  `timeout_ms` is never refused for the lease. A
  timeout is a result (`timed_out=True`, with the output so far), not an
  exception.
- `check=True` raises `CommandError` on a non-zero exit.
- A result holds at most 64 KiB (65,536 bytes) of `stdout` and 64 KiB of
  `stderr`. The rest is dropped, and `stdout_truncated` or `stderr_truncated` is
  `True`; when nothing was dropped, both are `False`. For more output, pass
  `on_stdout` or `on_stderr` (a `timeout_ms` over 60 seconds does the same): the
  command then streams, and the result keeps everything it printed. Or send the
  output to a file (`cmd > /workspace/out.log`) and read it with
  `sbx.files.read_text`.

Stream output as it happens with callbacks, or iterate the events:

```python
import sys
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.exec("for i in 1 2 3; do echo line $i; sleep 1; done", on_stdout=sys.stdout.write)
    for event in sbx.exec_stream("npm --version"):
        if event["type"] == "stdout":
            print(event["data"], end="")
        elif event["type"] == "exit":
            print("exit", event["exit_code"])
```

`exec_stream` events expose snake_case fields, including `process_id`,
`exit_code`, `timed_out`, `duration_ms`, `stdout_truncated`,
`stderr_truncated`, `dropped_bytes` and `resume_at`, when the event carries
that value. The previous camelCase keys remain available with the same values.

While you read a command's stream, the command waits for you rather than lose
output, from its first byte. The sandbox keeps the latest 1 MiB; a reader away
for more than 10 seconds while more than that came out loses the oldest part,
gets a `truncated` event, and the result has both truncation flags `True`. From withruntime 0.7.0, a stream
whose connection drops after the command started picks up again from the right
byte; one that cannot raises `ConnectionError` with `details["processId"]`, and
the command may still be running. Ctrl-C, or cancelling the task, during a
streamed `exec` sends the command SIGTERM.

## Background processes

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    server = sbx.spawn("python3 -m http.server 8000", cwd="/workspace")
    print(server)  # Process(id=..., command=..., state='running', exit_code=None)

    repl = sbx.spawn(["python3", "-i", "-q"], stdin="pipe")
    repl.write("print(sum([125, 250, 375]))\n")
    repl.write("exit()\n", eof=True)
    print(repl.wait().stdout)

    for process in sbx.processes():
        print(process["id"], process["state"], process["command"])
    server.kill("SIGTERM")
```

`process.write()` tracks accepted input offsets and keeps concurrent writes in
order. When the process accepts only part of the input, later chunks match its
capacity; when its input pipe is full, the SDK waits briefly before retrying
without advancing the offset. An empty EOF write closes input after earlier queued writes finish.

`process.output(cursor=0)` yields every event from the start until the process
exits. A process outlives your connection; get it back with `sbx.process(id)`.
The sandbox keeps each process's latest 1 MiB of output: a reader that was away
while more than that came out gets a `truncated` event saying how many bytes are
gone, and `wait()` sets both truncation flags. A process that prints more than
1 MiB should write to a file.

## An interactive terminal

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    term = sbx.terminal(cols=120, rows=40)
    term.write("echo hello from the terminal\n")
    term.write("exit\n")
    while (chunk := term.recv()) is not None:
        print(chunk.decode(errors="replace"), end="")
```

## Files

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.files.write("/workspace/data/input.csv", "a,b\n1,2\n")
    text = sbx.files.read_text("/workspace/data/input.csv")
    data = sbx.files.read("/workspace/data/input.csv")  # bytes
    print(sbx.files.exists("/workspace/data/input.csv"), sbx.files.stat("/workspace/data/input.csv"))
    for entry in sbx.files.list("/workspace", depth=2):
        print(entry["type"], entry["size"], entry["path"])
    print(sbx.files.glob("**/*.csv"))
    sbx.files.mkdir("/workspace/out")
    sbx.files.rename("/workspace/data/input.csv", "/workspace/out/input.csv")
    sbx.files.remove("/workspace/data", recursive=True)
```

`write` makes parent directories and replaces the file atomically; large files go
in parallel chunks checked by SHA-256. Under `/workspace` there is no size limit
beyond the disk. Elsewhere a file is written with the sandbox user's own rights
and can be at most 1 MiB; write a larger one to `/workspace` and move it with a
command. Whole directories travel as one archive:

```python
import pathlib
import tempfile
from withruntime import Sandbox

project = pathlib.Path(tempfile.mkdtemp())
(project / "main.py").write_text("print('hi')\n")

with Sandbox.create() as sbx:
    sbx.files.upload(str(project), "/workspace/project")
    sbx.exec("cd project && python3 main.py > result.txt")
    sbx.files.download("/workspace/project", str(project.parent / "project-out"))
```

An uploaded file keeps its permissions; `write(path, data, mode=0o755)` sets
them (0o644 when left out).

`files.archive(path, gzip=True, exclude=None, user="sandbox")` returns the
folder's tar bytes, gzip-compressed by default. `exclude` holds plain relative
paths, not globs. `files.unarchive(path, data, gzip=None, user="sandbox")`
merges archive bytes into the destination and detects gzip when omitted. Pass
`user="root"` explicitly for root-owned trees; this requires passwordless
`sudo` inside the sandbox.

```python check
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.files.write("/workspace/project/report.txt", "total: 750\n")
    archive = sbx.files.archive("/workspace/project")
    sbx.files.unarchive("/workspace/restored", archive)
    print(sbx.files.read_text("/workspace/restored/report.txt"))
```

A directory download keeps the links inside the directory and raises
`unsafe_archive` for any entry or link that would reach outside it, so
nothing in a sandbox can write elsewhere on your machine.
The download also checks links against files already in the destination before
publishing. Invalid checksums, malformed path metadata and incomplete tar
end markers are refused. Compressed archives are unpacked in bounded pieces;
this adds no limit on the total downloaded directory size.

From `withruntime` 0.7.0, reads are checked. The API sends
every file's length before its bytes, and a small file's SHA-256; `read` reads
a file that arrives short again, then raises
`download_incomplete` rather than return part of it. `read` has no size limit.
For a file too big to hold in memory, `read_stream` yields the bytes as they
arrive and raises if they end short, and `download` streams to disk through a
partial file that is renamed into place only once it is whole:

```python no-run
with open("dataset.tar", "wb") as out:
    for piece in sbx.files.read_stream("/workspace/dataset.tar"):
        out.write(piece)
```

`upload` and `download` of a directory move one tar archive through the API's
folder routes, which pack and unpack it with `tar` inside the sandbox; any
language can call them with a plain PUT or GET ([files in the API guide](./api#files)).
A downloaded folder is unpacked as it arrives, so its size is bounded only by
your disk, and it lands in place only once it has all arrived.

A sandbox holds at most 4 uploads and 4 downloads at once; more wait for
`transfer_limit` to clear. Each frees its slot when it ends, and a download
left unread for a minute gives its slot to the next one.

### Watch files

`files.watch` streams changes under a directory: create, write, remove, rename
(with the old path) and chmod. Repeated writes to one file inside a batch come
as one event with a count. It is E2B's `watch_dir`, with filters, and a watch
survives a pause: `events()` stops with `exit_reason == "paused"`, and calling
it again after the sandbox wakes carries on from the same place.

```python check
from withruntime import Sandbox

with Sandbox.create() as sbx:
    watch = sbx.files.watch("/workspace", recursive=True, exclude=["node_modules", ".git/**"])
    sbx.exec("echo hi > /workspace/note.txt")
    for event in watch.get_new_events(wait_ms=2000):  # or: for event in watch.events()
        print(event["type"], event["path"])
    watch.stop()
```

A sandbox runs at most four watches; each ends after `timeout_ms` (one hour by
default). A flood of changes is capped at 5,000 events a second and reported
as an `overflow` notice in `watch.notices`, never dropped silently.

`webhook=True` has Runtime read the watch and send its changes to your
account's [webhooks](./observability#events) as `sandbox.files.changed`
events, so nothing has to read it here; `timeout_ms=0` keeps it running until
stopped. It never keeps a sandbox that pauses itself awake.

```python check
from withruntime import Sandbox

with Sandbox.create() as sbx:
    watch = sbx.files.watches.start("/workspace/app", recursive=True, webhook=True, timeout_ms=0, id="sync")
    sbx.files.watches.stop("sync")
```

## Pause, wake, extend

```python check
from withruntime import Sandbox

sbx = Sandbox.create(timeout_seconds=600)
sbx.exec("echo state > /workspace/state.txt")
sbx.pause()  # memory and files are kept; compute billing stops
again = Sandbox.connect(sbx.id)
again.wake(timeout_seconds=1200)
again.extend(600)
again.stop()
```

`pause()` returns once the sandbox's processors have stopped, which is where
compute billing ends; the host then writes its memory to disk, and a wake or
snapshot asked for meanwhile waits for that write.

A paused sandbox also wakes by itself when a request needs it: an `exec`, a
file, process, terminal, desktop or code-interpreter call, or a visit to one of
its shared ports. The call waits while it wakes, about {{server-wake-command}} on Runtime's servers.
The wake is billed like any wake, from the moment it runs again, with a fresh
lease of its own `timeout_seconds`, or the lease it paused with when that ends
later. Turn it off with `auto_wake=False` at create
or `sbx.update(auto_wake=False)`; a call to a paused sandbox then fails with
`sandbox_paused` until you call `wake()`.

A sandbox pauses itself after **{{idle-pause}}** in which nothing happens in it: no
request, no command or terminal still running, no open preview, port, SSH or
tunnel connection, no network traffic, and its processes using under a fortieth
of a vCPU. The next request wakes it. `idle_pause_seconds` sets the idle time:
{{idle-pause-min}} to {{idle-pause-max}} seconds, or 0 for never. A `persistent` sandbox has none unless you
set it.

```python check
from withruntime import Sandbox

sbx = Sandbox.create(idle_pause_seconds=600)
sbx.update(idle_pause_seconds=1800)  # 0 turns it off
sbx.stop()
```

### Keep a sandbox running

`persistent=True` keeps a paid sandbox running for as long as the account has
credit: its lease renews itself on the server, and after a stop its disk is
kept, billed as reserved disk, so `sbx.restart()` starts it again.
`update(persistent=False)` makes it an ordinary sandbox again: running, its
disk stops being billed at once; stopped, its disk is deleted, which is how you
delete it. `keep_alive()` extends the lease from your process instead, so ten minutes
remain, once a minute, until `stop()` or the function it returns.

```python check
from withruntime import Sandbox

server = Sandbox.create(funding="paid", persistent=True, max_total_cost_micros=50_000_000)
server.update(persistent=False)  # back to an ordinary lease

worker = Sandbox.create()
release = worker.keep_alive(margin_seconds=1800)
release()
worker.stop()
```

## Sandboxes by name

A name is unique in the account while its sandbox can still run: running,
paused, or stopped and persistent. `Sandbox.get_or_create(name)` answers that
sandbox, woken if paused and restarted if stopped and persistent, or creates
one with the fields you pass; `sbx.info.get("reused")` is `True` when it found
one. A create with a name another sandbox holds fails with `name_taken`.

```python check
from withruntime import Sandbox

dev = Sandbox.get_or_create("dev", idle_pause_seconds=900)
dev.exec("git pull || true")
```

## Find sandboxes again

```python
from withruntime import Runtime

runtime = Runtime()
for sbx in runtime.sandboxes.list(labels={"team": "search"}, state=["running"]):
    print(sbx.id, sbx.info["name"], sbx.state)
```

Every list returns a page: `page.data`, `page.has_more`, `page.next_page()`,
`page.to_list()`, and a `for` loop walks every item on every page.

`runtime.sandboxes.stop_all(labels={"team": "search"})` stops every live
sandbox with all those labels, eight at a time, and returns
`{"stopped": [...], "failed": [...]}`: one failure does not stop the rest. It
needs at least one label.

## Delete a sandbox

`sbx.delete()`, or `runtime.sandboxes.delete(sandbox_id)` without reading it
first, removes a sandbox for good in any state: it stops it, deletes its disk
and paused memory, revokes its previews and ports, frees its name and takes it
out of every list. Its snapshots, usage and audit entries stay. Deleting it
again answers the same `{"id", "status": "deleted", "deletedAt"}`; any other
call to it then raises `NotFoundError`. `stop()` is the one to use when you may
want a persistent sandbox's disk back.

## Errors and retries

```python
from withruntime import NotFoundError, RuntimeAPIError, Sandbox

try:
    Sandbox.connect("00000000-0000-4000-8000-000000000000")
except NotFoundError:
    print("no such sandbox")
except RuntimeAPIError as error:
    print(error.code, error.hint, error.request_id)
```

The classes match the JavaScript SDK: `AuthenticationError`,
`PermissionDeniedError`, `NotFoundError`, `ConflictError`,
`InvalidRequestError`, `RateLimitError`, `ServiceUnavailableError`,
`AccountBlockedError` (from 0.7.0), `ConnectionError` and `CommandError`, all
subclasses of `withruntime.RuntimeAPIError`. `RuntimeAPIError` and
`RuntimeConnectionError` name the SDK errors without hiding Python's built-in
`RuntimeError` and `ConnectionError`. The old exports remain aliases of the
same classes, so existing catches keep working. Every write carries an idempotency
key, made for you; transport failures, 429 and 503 are retried with the same
key, so a retry never makes two sandboxes or runs a command twice.
Interrupted complete response bodies are retried with the same key too;
streamed output is never replayed after it reaches your code. A failed body
read or retry delay carries the original `error.idempotency_key`.

Pass your own `idempotency_key` to make a retry safe across process restarts.
For 24 hours, a create or a command sent again with the same key and the same
input answers with the first one's result instead of doing it twice; the same
key with different input is refused with `idempotency_key_reused`.

```python
from withruntime import Runtime

with Runtime() as runtime:
    with runtime.sandboxes.create(idempotency_key="job-42-sandbox") as sbx:
        sbx.exec(["python3", "-c", "print(42)"], idempotency_key="job-42-step-1")
```

**A create waits for room.** When every trial slot is taken (`trial_busy`), the
account is at its limit (`quota_exceeded`) or the region is full
(`no_capacity`), `sandboxes.create` waits and sends the same request again, for
up to two minutes. A burst of CI jobs past the limit queues instead of failing.

- When the wait runs out, the refusal is raised as it came.
- Set `wait_for_capacity` (seconds) on the client or on one create. `0` fails at
  once.
- From withruntime 0.7.0, `on_capacity_wait(refusal, seconds)` on one create is
  called before each wait,
  to tell a person why nothing has happened yet.

```python
from withruntime import Runtime

# A CI job that may queue for ten minutes behind the others.
with Runtime(wait_for_capacity=600) as runtime:
    with runtime.sandboxes.create() as sbx:
        # One create that should fail at once instead.
        with runtime.sandboxes.create(wait_for_capacity=0) as now:
            print(sbx.id, now.id)
        # One that says why it is waiting (withruntime 0.7.0).
        with runtime.sandboxes.create(
                on_capacity_wait=lambda refusal, seconds: print(refusal.message, "Waiting.")) as told:
            print(told.id)
```

## Read-only keys and daily limits

An owner, admin or developer can make a read-only key and set a daily spending
limit on a key at
[API keys](https://withruntime.com/account/keys). A key reads both and can
change neither. `runtime.limits` needs withruntime 0.3.1 or later:

```python check
from withruntime import Runtime

with Runtime() as runtime:
    limits = runtime.limits.get()
    print(limits["access"])  # "full", "read" or "selected"
    left = limits["daily"]["remainingMicros"]
    if left is not None and int(left) < 1_000_000:
        print("less than $1 left in this 24-hour window")
```

Past the limit, a create, wake, extension or renewal fails with a
`RuntimeError` whose `code` is `spending_limit_reached` (HTTP 402), and it is
not retried. A read-only key asking to change anything gets
`PermissionDeniedError`. See [security](./security).

Cap a single create with `max_cost_micros`, in millionths of a dollar. The
create is refused before anything starts if its first lease, priced as if every
vCPU were busy for all of it, would cost more:

```python check
from withruntime import ConflictError, Runtime

with Runtime() as runtime:
    try:
        # At most 5 cents for this sandbox's first lease.
        sbx = runtime.sandboxes.create(funding="paid", vcpu=2, timeout_seconds=600,
                                       max_cost_micros=50_000)
        sbx.stop()
    except ConflictError as error:
        print(error.code)  # "budget_exceeded": ask for less, or raise the cap
```

## Secrets your sandboxes never see

Store an API key once with `runtime.secrets`, naming the hosts it may go to.
Every sandbox of the account then has an environment variable of that name
holding a placeholder, and the host's proxy swaps in the real value on HTTPS
requests to those hosts. The value is sealed and never returned:

```python check
import os

from withruntime import Runtime

with Runtime() as runtime:
    runtime.secrets.set("OPENAI_API_KEY", value=os.environ["OPENAI_API_KEY"],
                        hosts=["api.openai.com"])
    runtime.secrets.set("GITHUB_TOKEN", value=os.environ["GITHUB_TOKEN"],
                        hosts=["api.github.com"], header="Authorization",
                        format="token {value}",
                        rules=[{"methods": ["GET", "HEAD"], "paths": ["/repos/acme/*"]}])
    for secret in runtime.secrets.list():  # names, hosts and placeholders, never values
        print(secret["name"], secret["hosts"])
    runtime.secrets.delete("GITHUB_TOKEN")
```

With `header`, the proxy sets that header on every request to the hosts, with
`format` placing the value. With `rules`, on paid accounts, only the requests a
rule allows by method and path carry it: a path is exact or ends in `/*`.
Replacing a secret keeps its placeholder, so
running sandboxes use the new value. See
[security](./security#secrets-sandboxes-never-see) for the limits and what is
never rewritten.

## Images, volumes and snapshots

```python check
from withruntime import Runtime

runtime = Runtime()
image = runtime.images.build(name="data", recipe={"pip": ["pandas"], "apt": ["jq"]},
                             on_log=lambda line: print(line["text"]))
volume = runtime.volumes.create(size_mib=10_240, name="cache")
with runtime.sandboxes.create(image=image["id"],
                              volumes=[{"volume_id": volume["id"], "path": "/data"}]) as sbx:
    print(sbx.exec("python3 -c 'import pandas; print(pandas.__version__)'").stdout)

# A sandbox with volumes cannot be snapshotted, so these use one without.
with runtime.sandboxes.create(image=image["id"]) as base:
    forks = base.fork(count=2, funding="trial")  # copies as it is now, running
    for fork in forks:
        fork.stop()
    snapshot = base.snapshot(name="with-pandas", retention_days=7)
    with runtime.sandboxes.create(snapshot=snapshot["id"]):
        pass
    runtime.snapshots.delete(snapshot["id"])
```

`images.build` waits until the image is ready; `images.create` queues it and
returns. A Dockerfile build takes `dockerfile` and `context_dir`, the folder
`docker build` would read, with its `.dockerignore`; multi-stage builds,
`COPY --from`, `ARG` and heredocs work. Each build of a `name` is its next
version and takes the tag `latest`, or the `tags` you give, and `image=` on a
create takes an id, `name`, `name:tag` or `name@version`. `start` sets what a
sandbox from the image runs and when its create answers
(`{"command": ..., "ready_port": 8000}`). `images.versions(name)`,
`images.resolve(ref)`, `images.tag(ref, tag)`, `images.untag(ref, tag)`,
`images.follow_logs(id, on_log)` and `images.registries.set(registry,
username=..., password=...)` for private images do the rest; see
[custom images](./images). `sbx.switch_image("data:v2", keep="workspace")` moves
a running sandbox to a new build, keeping its id, `/workspace` (its home),
volumes, environment and previews; its processes restart and the rest of its
old disk is lost ([move a sandbox to a new version](./images#move-a-sandbox-to-a-new-version)).
When enabled, `sbx.resize(memory_mib=4096, vcpu=2, restart=True)` restarts it at
a new size on the same server, keeping its whole disk; its programs stop. A volume lives on one server and is backed up off it
daily; `volumes.backup(id)` and `volumes.restore(backup_id)` make and restore a
backup ([storage and backups](./storage)). `sbx.mounts.add(provider="s3", bucket=..., path=..., secret=...)`,
`list()` and `remove(path)` mount your own bucket without the sandbox holding
its key ([mount your own bucket](./storage#mount-your-own-bucket)). Images, volumes and kept snapshots are charged as storage
([pricing](./pricing#snapshots-images-and-volumes)).

Forks and snapshots:

- `fork` takes `funding` as a create does; without it, the copies keep the
  source's funding.
- Copies keep the source's size and CPU (reserved CPU, or a raised floor) and
  are billed as a create with those would be. A trial copy must fit the trial.
- The snapshot a fork takes is deleted when the fork ends, whether every copy
  started or not, and is not billed, unless `keep_snapshot=True`.
- If a copy fails, the error's `details["startedSandboxIds"]` names the copies
  that did start; they keep running until stopped. A retry with the same
  idempotency key answers the same error.
- A sandbox created with `pausable=False` cannot be forked.
- If a fork stops partway and left its source paused, the source stays paused,
  and an account notice says so and how to wake it.
- Copies run on the source's server by default. Cross-server placement requires
  [qualified transfers](./storage#wake-or-fork-on-another-server-when-enabled)
  to be enabled. A kept snapshot is stored on its source server and
  copied off it, encrypted, after its final compressed form is ready. It survives loss of the server once
  `backedUp` is `True`, meaning that copy has been checked
  ([storage and backups](./storage)).
- Snapshots default to `mode="memory"`, keeping files, memory and running
  processes. `base.snapshot(mode="disk")` keeps only the root filesystem;
  each copy boots fresh without the saved processes. Both modes pause a
  running source until capture finishes, then wake it; an already paused
  source stays paused.

Where deferred compression has been qualified and enabled, a memory
snapshot can be `"ready"` with `compressionPending` set to `True`
and start copies on the same server before background compression finishes.
Temporary raw files are not charged; snapshot billing uses the final verified
compressed allocation. The off-server copy waits for that final form, so
`backedUp` is false while compression is pending. See
[snapshot storage](./storage#snapshots-survive-their-server).

If a snapshot was captured but waking its source fails, the error keeps the
original failure and `details["snapshotId"]`, `details["sourceSandboxId"]` and
`details["sourceWakeError"]`. Read that saved snapshot and wake the source
explicitly before taking another capture; a failed recovery does not erase the
snapshot id.

See [JavaScript](./javascript#custom-images) for what each does; the Python
methods are the same in snake_case.

## Code interpreter and network rules

The interpreter runs Python, JavaScript, TypeScript, R, Java, Bash and Go.
Each language keeps its state between cells, except Go, which keeps its
functions, types and imports and runs each cell as a program. R plots and
matplotlib charts come back as PNG images; pandas and R data frames as tables.
R, Java and Go are installed in the sandbox the first time you use them
(30 to 90 seconds, once), or bake them into an image with `apt`.
A package `pip install` adds, from a cell or from `sbx.exec`, imports in a
context that is already running, even in the cell that installed it.

```python check
from withruntime import Runtime

runtime = Runtime()
with runtime.sandboxes.create() as sbx:
    sbx.interpreter.run("import math\nx = math.pi")
    cell = sbx.interpreter.run("round(x * 2, 3)")
    print(cell["results"][0]["data"]["text/plain"])
    frame = sbx.interpreter.run("df <- data.frame(a = 1:3); df", language="r")
    print(frame["results"][0]["data"]["application/vnd.runtime.table+json"])

    sbx.network.set(internet=True, allow=["pypi.org", "*.pythonhosted.org"])
    print(sbx.network.get())
```

Feedback and support are on the client too: `runtime.feedback.submit(...)` and
`runtime.support.message(...)`; see [feedback and support](./feedback-and-support).

## Previews and the desktop

```python check
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.spawn("python3 -m http.server 3000")
    preview = sbx.previews.create(3000)  # private: the link carries its token
    print(preview["urlWithToken"])

    sbx.desktop.start(width=1280, height=800)  # the first start installs it
    sbx.desktop.open("https://example.com")
    sbx.desktop.click(640, 400)
    with open("screen.png", "wb") as file:
        file.write(sbx.desktop.screenshot())

    recording = sbx.desktop.recordings.start(fps=10, max_mib=256)
    sbx.desktop.type("hello")
    sbx.desktop.recordings.stop(recording["id"])
    with open("demo.mp4", "wb") as file:
        file.write(sbx.desktop.recordings.download(recording["id"]))
```

A preview is private by default: open `urlWithToken`, or send `token` as the
`x-runtime-preview-token` header. `visibility="public"` gives an address anyone
can open, on a paid sandbox only; a trial sandbox's previews stay private.

`embed_origins=["https://app.example.com"]` on `create` names the sites that
may show the preview in an iframe (up to {{embed-origins}}); any other site's
iframe is refused. `sbx.previews.rotate(3000)` refuses every token issued for
the port so far and returns a new one; `sbx.previews.delete(3000)` stops sharing it. A preview's
address is under `runtimehost.com`, the domain for everything sandboxes serve,
kept apart from Runtime's own site.
See [JavaScript](./javascript#share-a-port) for what each does.

Native `previews.create` and `previews.get` accept `expires_at` as a
timezone-qualified ISO timestamp, a minute to a week ahead. It rounds down
to a whole second; with `ttl_seconds`, the earlier deadline wins. A session's
expiry also limits its preview reads. Use the returned `tokenExpiresAt` as
the actual deadline. The matching server feature is required: an older server
refuses the absolute field rather than falling back to a relative lifetime.

## A sandbox from a browser

A session lets your own frontend reach one sandbox directly, without a key in
the browser. Make it on your server and hand the page the token and the
sandbox id; the page uses them with the JavaScript SDK
(`Sandbox.fromSession({ token, sandboxId })`) or the HTTP API:

```python no-run
session = sbx.sessions.create(origins=["https://app.example.com"], ttl_seconds=900)
token, sandbox_id = session["token"], session["sandboxId"]
```

A session runs commands, uses files and reaches previews of that one sandbox,
and nothing else. It lasts {{session-default}} unless asked and
{{session-max}} at most; `sbx.sessions.revoke(session_id)` ends it at once, and
revoking the key that made it ends all of them. Python code can use one too:
`Sandbox.from_session(token, sandbox_id)`. [A sandbox from a
browser](./javascript#a-sandbox-from-a-browser) has the rest.

## MCP servers in a sandbox

Start well-known MCP servers (GitHub, Postgres, a Playwright browser,
filesystem, fetch, git and more; `runtime.mcp.catalog()` lists them with their
licences) inside a sandbox, and give your agent their URLs:

```python check
from withruntime import Runtime

runtime = Runtime()
with runtime.sandboxes.create() as sbx:
    sbx.mcp.start([
        {"id": "github", "secrets": {"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}},
        {"id": "fetch"},
    ])
    gateway = sbx.mcp.ready()  # every server installed
    for server in gateway["servers"]:
        print(server["name"], server["url"])
    print(gateway["headers"])  # send these with every request
```

A secret setting names a [Runtime secret](./security#secrets-sandboxes-never-see): the server
sees a placeholder, and the egress proxy puts the value into its HTTPS
requests to the secret's own hosts. The servers keep to the sandbox's network
rules; a host the rules refuse is a warning, never a change.

## Domains, TCP ports, addresses, the tunnel and your own proxy

Paid accounts only; see [networking](./networking).

```python check
domain = runtime.domains.add("app.example.com", sandbox_id=sbx.id, port=3000)
print(domain["records"])  # the TXT and CNAME to set; then runtime.domains.verify(...)
db = runtime.ports.open(sandbox_id=sbx.id, port=5432)
print(db["connect"])  # "203.0.113.10:23456"
ip = runtime.addresses.reserve()
runtime.tunnel.create()
office = runtime.tunnel.add_peer("office", routes=["10.0.0.0/16"])
print(office["config"])  # a wg-quick file
runtime.network.upstream_proxy.set("http://proxy.example.com:3128", secret="PROXY_AUTH")
```

`runtime.network.upstream_proxy`, from `withruntime` 0.7.0,
sends every sandbox's outbound connections through your own proxy; `get()` and
`remove()` read and undo it. See
[your own proxy](./security#your-own-proxy).

## Metrics and webhooks

```python check
from withruntime import Runtime, Sandbox, verify_webhook

sbx = Sandbox.create()
latest = sbx.metrics(range="15m")["latest"]  # CPU and memory, measured

runtime = Runtime()
hook = runtime.webhooks.create(url="https://example.com/hooks/runtime")
# In the endpoint: verify_webhook(raw_body, headers["runtime-signature"], hook["secret"])
print(latest, verify_webhook.__name__)
```

`runtime.events.list()` reads lifecycle events and `runtime.otel.create()`
pushes events and metrics to an OpenTelemetry endpoint. See
[metrics and webhooks](./observability).

## Account API calls

```python check
from withruntime import Runtime

with Runtime() as runtime:
    counts = runtime.usage_requests("7d")
    print(counts["calls"], counts["errorPercent"])
    for row in counts["operations"]:
        print(row["operation"], row["serverErrors"])
```

`usage_requests()` defaults to `"24h"`; `"7d"`, `"30d"` and `"90d"` select
longer windows. Counts are exact decimal strings, and `errorPercent` is `None`
when no calls were counted. `AsyncRuntime` has the same method, awaited. A key
needs the `usage` scope, read-only access or all-products access. See
[account API calls](./observability#account-api-calls).

## Identity tokens

Inside a sandbox, `Sandbox.identity_token("sts.amazonaws.com")` returns a
short-lived OIDC token naming the sandbox, to trade for AWS or Google Cloud
credentials without a stored key. It needs no API key. See
[identity tokens](./identity-tokens).

## Single sign-on

An owner sets up single sign-on (SAML or OIDC) and directory sync (SCIM) on
the [Single sign-on](https://withruntime.com/account/single-sign-on) page;
both are free. A key made by an owner or admin reads it with
`runtime.sso.get()`: each identity provider, its domain and whether it is
verified, whether single sign-on is required, and the directory sync's users
and group roles. See [single sign-on](./single-sign-on).

## Coming from E2B, Daytona, Vercel Sandbox or Blaxel

Their supported Python sandbox calls keep the same call shapes on Runtime
after changing the import,
in `withruntime` 0.4.0 and later for E2B and 0.5.0 and later for Daytona and
Vercel Sandbox, and 0.8.1 and later for Blaxel:

```python no-run
from withruntime.e2b import Sandbox  # was: from e2b import Sandbox
from withruntime.daytona import Daytona  # was: from daytona import Daytona
from withruntime.vercel import sandbox  # was: from vercel import sandbox
from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance
```

The adapters translate supported calls to Runtime's native sandbox, with the
provider defaults described in each mapping. Unsupported options are refused
before allocation, and the mapping names the supported alternatives. To move to Runtime's own calls, see [migration](./migrate).

## Configuration

```python
from withruntime import Runtime

with Runtime(max_retries=4, timeout=120) as runtime:
    print(runtime.me()["orgId"])
```

`RUNTIME_API_URL` points the client at another API origin. Code inside a
Runtime sandbox calls Runtime's API at `http://runtime.internal`
([Runtime's API from inside a sandbox](./sandbox-environment#runtime-s-api-from-inside-a-sandbox)).

Before 0.3.0 the package was `withruntime-cloud`, imported as `runtime_cloud`.
That name stopped at 0.5.1 and gets no new releases: install `withruntime` and
`import withruntime` for everything since.
