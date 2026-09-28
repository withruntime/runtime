# Ruby SDK

One Ruby client for every Runtime Cloud product.

The `withruntime` gem needs Ruby 3.2 or later and uses only the standard
library. It is safe to share between threads and keeps its connections open.

```bash no-run
gem install withruntime
```

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that is
set, and otherwise the connection this machine saved (any `npx withruntime`
command connects it, with one browser approval).

On a server, put a key from https://withruntime.com/account/keys in
`RUNTIME_API_KEY` from your secret manager. Never put it in source code, a URL
or a command-line argument. With no key anywhere, `WithRuntime::Client.new`
raises `WithRuntime::AuthenticationError` whose `code` is `missing_api_key`
and whose `hint` says how to get one.

## Hello, sandbox

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create(funding: "trial")
begin
  puts sbx.exec("python3 -c 'print(6 * 7)'", check: true).stdout
ensure
  sbx.stop
end
```

`create` returns once the sandbox is running. With no arguments you get the
free trial while it lasts, the default region, and 2 vCPU, 4 GiB of memory and
a 4 GiB disk for up to 30 minutes. `funding: "trial"` never falls back to paid
credit. Every field is optional, in snake_case:

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create(
  name: "tests-42",
  labels: { team: "search", job: "42" },
  vcpu: 2,
  memory_mib: 4096,
  disk_mib: 8192,
  timeout_seconds: 900,
  on_lease_end: "stop",
  network: { internet: true, allow: ["rubygems.org", "*.githubusercontent.com"] }
)
puts sbx.id, sbx.info.funding, sbx.info.expires_at
sbx.stop
```

An answer reads by snake_case name (`sbx.info.memory_mib`) or by the API's own
key (`sbx.info["memoryMiB"]`), so a field newer than the SDK is always there. A
string key in a request (`"newField" => 1`) is sent as it is.

## Run commands

A string runs under `bash -c`; an array runs the program directly, with no
shell, which is what you want for untrusted arguments.

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
sbx.exec("mkdir -p app && echo 'print(1 + 1)' > app/main.py")
run = sbx.exec(["python3", "main.py"], cwd: "/workspace/app", env: { API_TOKEN: ENV.fetch("API_TOKEN", "") }, timeout: 120)
warn run.stderr unless run.exit_code.zero?
print run.stdout

sbx.exec("for i in 1 2 3; do echo line $i; sleep 1; done", on_stdout: ->(text) { print text })
sbx.exec_stream("node --version") do |event|
  print event["data"] if event["type"] == "stdout"
end
sbx.stop
```

- `env:` is how secrets reach a command. It is never echoed back. Never put a
  secret in the command line itself.
- `stdin:` gives the command input, then closes it.
- The default timeout is 60 seconds; the maximum is a day. A timeout is a
  result (`timed_out` is true, with the output so far), not an exception.
- `check: true` raises `WithRuntime::CommandError`, with the exit code and
  output, on a non-zero exit or a timeout.
- With `on_stdout:`, `on_stderr:` or a timeout over a minute, the command
  streams and the result keeps everything it printed. A long stream resumes by
  itself when the server ends it, so no output is dropped.

## Background processes

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
server = sbx.spawn("python3 -m http.server 8000", cwd: "/workspace")
repl = sbx.spawn(["python3", "-i", "-q"], pipe_stdin: true)
repl.write("print(21 * 2)\n", eof: true)
print repl.wait.stdout
sbx.processes.each { |process| puts "#{process.id} #{process.state} #{process.command}" }
server.kill("SIGTERM")
sbx.stop
```

A process outlives your connection; get it back with `sbx.process(id)`.
`write` tracks input offsets, so a retried write is never typed twice.

## Files

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
sbx.files.write("/workspace/data/input.csv", "a,b\n1,2\n")
print sbx.files.read_text("/workspace/data/input.csv")
sbx.files.list("/workspace", depth: 2).each { |entry| puts "#{entry.type} #{entry.size} #{entry.path}" }
sbx.files.mkdir("/workspace/out")
sbx.files.rename("/workspace/data/input.csv", "/workspace/out/input.csv")
sbx.files.upload("./lib", "/workspace/project/lib")
sbx.files.download("/workspace/out", "./out")
sbx.stop
```

`write` makes parent directories and replaces the file atomically; a file over
1 MiB goes in parallel chunks checked by SHA-256. `stat` returns `nil` for a
path that does not exist. `upload` and `download` move a whole directory as
one gzipped archive. Pass `mode: 0o755` to write an executable, or
`mode: 0` for no permission bits. `chmod(path, mode)` changes an existing
file. A caller-supplied `idempotency_key:` also makes a complete large-file
write safe to repeat; each upload phase keeps its own stable key. On an
older guest, setting a mode also needs the exec grant for its chmod fallback.

## Pause, wake, fork and snapshot

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create(funding: "trial")
sbx.pause # memory and files are kept; compute billing stops
again = runtime.sandboxes.get(sbx.id)
again.wake(timeout_seconds: 1200)
again.extend_lease(600)

copies = again.fork(count: 2, funding: "trial")
copies.each(&:stop)
snapshot = again.snapshot(name: "ready", retention_days: 7)
runtime.sandboxes.create(snapshot: snapshot.id, funding: "trial").stop
runtime.snapshots.delete(snapshot.id)
again.stop
```

A fork copies a sandbox as it is now, with its files, memory and running
processes, on the same server; see [JavaScript](./javascript) for what forks
and snapshots keep and how they are billed. If a copy fails, the error's
`details["startedSandboxIds"]` names the copies that did start. Because
`extend` is Ruby's own, the lease is extended with `extend_lease(seconds)`.
`sbx.keep_alive` extends it from your process until `stop`, and
`runtime.sandboxes.get_or_create(name, **fields)` answers the sandbox with
that name, woken or restarted, or creates it.

## Share a port

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
sbx.spawn("python3 -m http.server 3000")
preview = sbx.previews.create(3000)
puts preview.url, preview.token # send the token as x-runtime-preview-token
sbx.stop
```

A preview is private by default; `visibility: "public"` shares it with anyone
who has the address. Addresses are under `runtimehost.com`.

## Images, volumes, network rules and secrets

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
image = runtime.images.build(name: "data", recipe: { pip: ["pandas"], apt: ["jq"] }) { |line| puts line.text }
volume = runtime.volumes.create(size_mib: 10_240, name: "cache")
sbx = runtime.sandboxes.create(image: image.id, volumes: [{ volume_id: volume.id, path: "/data" }])
print sbx.exec("python3 -c 'import pandas; print(pandas.__version__)'").stdout
cell = sbx.interpreter.run("import math\nround(math.pi * 2, 3)")
puts cell.results.first.data["text/plain"]
sbx.network.set(internet: true, allow: ["pypi.org", "*.pythonhosted.org"])
sbx.stop

secret = runtime.secrets.set("OPENAI_API_KEY", value: "sk-...", hosts: ["api.openai.com"])
puts secret.placeholder # what sandboxes see in $OPENAI_API_KEY
```

`images.build` waits until the image is ready and raises with code
`image_failed` when the build fails; `images.create` queues it and returns. A
Dockerfile build takes `dockerfile:` and `context_dir:`, the folder
`docker build` would read, with its `.dockerignore`; only the parts the server
does not have yet are uploaded. See [custom images](./images). A volume lives
on one server; volume backups can restore its data onto another host.
`sbx.desktop` drives a Linux desktop in the sandbox.

## Domains, TCP ports and private networking

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
runtime.domains.add(hostname: "app.example.org", sandbox_id: sbx.id, port: 8080)
p runtime.domains.get("app.example.org") # DNS records to install, then verify
runtime.domains.verify("app.example.org")
port = runtime.ports.open(sandbox_id: sbx.id, port: 5432)
p port
runtime.ports.close(port.id)
runtime.domains.remove("app.example.org")
sbx.stop
```

`runtime.addresses.reserve(family: 4)` reserves a dedicated address;
`list` and `release(id)` manage it. Returned funding fields and integer money
are preserved. `runtime.tunnel` manages the account's WireGuard network with
`create`, `get`, `delete`, `add_peer`, `rotate_peer` and `remove_peer`.
Save a generated peer's `config` securely even when `config_ready` is false:
its private key is returned once. Calls generating a private key are not
retried automatically. `runtime.sso.get` reads the organization's SSO state.

## Backups, mounts, MCP and recordings

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
volume = runtime.volumes.create(size_mib: 1024)
backup = runtime.volumes.backup(volume.id, name: "before-import", retention_days: 7)
runtime.volumes.set_backup_policy(volume.id, daily: true, retention_days: 7)
restored = runtime.volumes.restore(backup.id, name: "restored")
p runtime.volumes.backups(volume_id: volume.id).data
runtime.volumes.delete_backup(backup.id)
runtime.volumes.delete(restored.id)
runtime.volumes.delete(volume.id)
```

`sbx.mounts.add(provider: "s3", bucket: "data", path: "/data", secret: "S3_KEY")`
mounts an object store; `list` and `remove(path)` manage mounts. The named
secret stays on Runtime. `runtime.mcp.catalog` lists supported servers;
`sbx.mcp.start(servers: [{ id: "fetch" }])`, `ready`, `get` and `stop` manage
servers in a sandbox. Server `secrets`, `env` and `options` keep their
original dictionary keys.

`sbx.desktop.recordings.start(fps: 10)` returns a recording. Use `get(id)`,
`list`, `stop(id)`, `download(id)` for MP4 bytes, and `delete(id)` to manage it.

## Watch files

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.create
watch = sbx.files.watch("/workspace", recursive: true)
begin
  watch.events.each { |event| puts "#{event.k}: #{event.path}" }
ensure
  watch.stop
  sbx.stop
end
```

The reader follows continuation messages and keeps `watch.cursor`. Overflow
and lost-event notices reach your block. `watch.close` cancels only the active
reader; another thread can call it while HTTP headers, a body or a retry delay
is pending. `watch.stop` also removes the watch in the guest and prevents new
readers. A paused sandbox ends the current stream.

## Terminal and local port forwarding

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
sbx = runtime.sandboxes.get("your-sandbox-id")
terminal = sbx.terminal(cols: 100, rows: 30)
begin
  terminal.write("printf 'hello\n'\n")
  print terminal.read
  terminal.resize(cols: 120, rows: 40)
ensure
  terminal.close
end
forward = sbx.port_forward(8080)
begin
  puts "Local server: http://#{forward.host}:#{forward.port}"
ensure
  forward.close
end
```

A terminal exposes `read`, `write`, `resize`, `process_id`, `exit_code` and
`close`. `sbx.open_tunnel` shares one authenticated connection across
`connect(port)` and `ssh(public_key)` streams. Each stream supports `read`,
`write`, `close_write` and `close`; half-closing input still permits a response.
`port_forward` binds to `127.0.0.1` and a free port by default; pass `host:`
and `local_port:` to choose them. Closing it releases its listener and active
connections.

Read responses while writing large requests. An individual unread stream has
at most 1 MiB buffered; overflow closes that stream with
`tunnel_receive_overflow` and leaves other streams usable. Closing a terminal
or tunnel wakes blocked readers and writers. WebSockets use the same API key
and origin, support an HTTP CONNECT proxy, and verify TLS certificates.

## Metrics, events and webhooks

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
hook = runtime.webhooks.create(url: "https://example.com/hooks/runtime")
secret = hook.secret # shown once; keep it

# In your endpoint, with the raw body and the Runtime-Signature header:
begin
  event = WithRuntime::Webhooks.verify("{}", "t=0,v1=0", secret)
  puts event.type
rescue WithRuntime::WebhookVerificationError => e
  puts "refused: #{e.message}"
end
runtime.events.list(type: "sandbox.stopped").each { |event| puts "#{event.created_at} #{event.type}" }
```

`sbx.metrics(range: "15m")` returns the sandbox's measured CPU and memory, and
`runtime.otel.create(endpoint: ...)` pushes events and metrics to an
OpenTelemetry endpoint. See [metrics and webhooks](./observability).

## Errors and retries

```ruby
require "withruntime"

runtime = WithRuntime::Client.new
begin
  runtime.sandboxes.get("00000000-0000-4000-8000-000000000000")
rescue WithRuntime::NotFoundError
  puts "no such sandbox"
rescue WithRuntime::Error => e
  puts e.code, e.hint, e.request_id
end
```

Every error is a `WithRuntime::Error` with `code`, `message`, `hint`,
`request_id`, `status` and `details`. Its subclasses are
`AuthenticationError`, `PermissionDeniedError`, `NotFoundError`,
`ConflictError`, `InvalidRequestError`, `RateLimitError`,
`ServiceUnavailableError`, `ConnectionError` and `CommandError`, the same
classes as the JavaScript, Python, Go and Java SDKs.

Every write carries an idempotency key, made for you and kept across the
client's own retries. Transport failures, 429, 502, 503 and 504 are retried
with the same key, so a retry never makes two sandboxes or runs a command
twice. `retryable?` says whether trying the same call again may work.

**A create waits for room.** When every trial slot is taken (`trial_busy`), the
account is at its limit (`quota_exceeded`) or the region is full
(`no_capacity`), `sandboxes.create` waits and sends the same request again, for
up to two minutes. Pass `wait_for_capacity:` (seconds) to the client or to one
create; zero fails at once.

An owner, admin or developer can make a read-only key and set a daily spending
limit on a key at [API keys](https://withruntime.com/account/keys).
`runtime.limits.get` reads both; past the limit, a create, wake or extension
raises with code `spending_limit_reached`, and it is not retried.

## Configuration

```ruby
require "withruntime"

runtime = WithRuntime::Client.new(
  api_key: ENV.fetch("MY_RUNTIME_KEY"),
  timeout: 120,
  max_retries: 4,
  wait_for_capacity: 600
)
puts runtime.me.org_id
p runtime.request("GET", "/v1/volumes") # any endpoint, same rules
```

- `RUNTIME_API_URL` points the client at another API origin, as `base_url:`
  does.
- The client is safe to share between threads. It keeps its connections open
  and holds at most 32 calls in flight (`max_connections:`).
- It honours `HTTPS_PROXY` and `NO_PROXY`.
- Money is integer microdollars: 1,000,000 is one US dollar.
  `runtime.usage.available` is the account's balance as an exact decimal
  string.
