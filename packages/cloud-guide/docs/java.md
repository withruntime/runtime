# Java SDK

One Java client for every Runtime Cloud product.

`com.withruntime:withruntime` needs Java 17 or later and nothing beyond the
JDK: no HTTP library, no JSON library. It is a named module,
`com.withruntime`.

```xml
<dependency>
  <groupId>com.withruntime</groupId>
  <artifactId>withruntime</artifactId>
  <version>0.1.0</version>
</dependency>
```

With Gradle: `implementation("com.withruntime:withruntime:0.1.0")`.

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that is
set, and otherwise the connection this machine saved (any `npx withruntime`
command connects it, with one browser approval).

On a server, put a key from https://withruntime.com/account/keys in
`RUNTIME_API_KEY` from your secret manager. Never put it in source code, a URL
or a command-line argument. With no key anywhere, `RuntimeClient.create()`
throws `RuntimeCloudException.Authentication` whose code is `missing_api_key`
and whose hint says how to get one.

## Hello, sandbox

```java
import com.withruntime.*;

public class Hello {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create(new CreateSandbox().funding("trial"))) {
      sbx.files().write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
      CommandResult result = sbx.exec("python3 /workspace/invoice.py", new ExecOptions().check(true));
      System.out.print(result.stdout());
    }
  }
}
```

`create` returns once the sandbox is running, and closing it stops it. With no
options you get the free trial while it lasts, the default region, and 2 vCPU,
4 GiB of memory and a 4 GiB disk for up to 30 minutes. `funding("trial")`
never falls back to paid credit. Every field is optional:

```java
import com.withruntime.*;

public class Sized {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    Sandbox sbx =
        runtime
            .sandboxes()
            .create(
                new CreateSandbox()
                    .name("tests-42")
                    .label("team", "search")
                    .vcpu(2)
                    .memoryMiB(4096)
                    .diskMiB(8192)
                    .timeoutSeconds(900)
                    .onLeaseEnd("stop")
                    .network(new NetworkRules().internet(true).allow("repo.maven.apache.org")));
    System.out.println(sbx.id() + " " + sbx.info().funding() + " " + sbx.info().expiresAt());
    sbx.stop();
  }
}
```

A field newer than the SDK goes in with `.set("field", value)`.

## Run commands

`exec` runs a string under `bash -c`. `execArgv` runs a program directly, with
no shell, which is what you want for untrusted arguments.

```java
import com.withruntime.*;
import java.time.Duration;
import java.util.List;

public class Commands {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create()) {
      sbx.exec("mkdir -p app && echo 'print(1 + 1)' > app/main.py");
      CommandResult run =
          sbx.execArgv(
              List.of("python3", "main.py"),
              new ExecOptions()
                  .cwd("/workspace/app")
                  .env("API_TOKEN", System.getenv("API_TOKEN"))
                  .timeout(Duration.ofMinutes(2)));
      if (run.exitCode() != 0) System.err.print(run.stderr());
      System.out.print(run.stdout());

      sbx.exec("for i in 1 2 3; do echo line $i; sleep 1; done", new ExecOptions().onStdout(System.out::print));
      try (EventStream<OutputEvent> events = sbx.execStream("node --version", new ExecOptions())) {
        for (OutputEvent event : events)
          if (event.type().equals("stdout")) System.out.print(event.data());
      }
    }
  }
}
```

- `env` is how secrets reach a command. It is never echoed back. Never put a
  secret in the command line itself.
- `stdin` gives the command input, then closes it.
- The default timeout is 60 seconds; the maximum is 24 hours. A timeout is a
  result (`timedOut()` is true, with the output so far), not an exception.
- `check(true)` throws `RuntimeCloudException.Command`, with the exit code and
  output, on a non-zero exit or a timeout.
- A result holds at most 64 KiB of each stream unless it streams; with
  `onStdout`, `onStderr` or a timeout over a minute, the command streams and
  the result keeps everything it printed. A long stream resumes by itself when
  the server ends it, so no output is dropped.

## Background processes

```java
import com.withruntime.*;

public class Processes {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create()) {
      SandboxProcess server = sbx.spawn("python3 -m http.server 8000", new SpawnOptions().cwd("/workspace"));
      SandboxProcess repl = sbx.spawn("python3 -i -q", new SpawnOptions().pipeStdin());
      repl.write("print(21 * 2)\n", true);
      System.out.print(repl.waitFor().stdout());
      for (ProcessInfo process : sbx.processes()) System.out.println(process.id() + " " + process.state());
      server.kill("SIGTERM");
    }
  }
}
```

A process outlives your connection; get it back with `sbx.process(id)`.
`write` tracks input offsets, so a retried write is never typed twice.

## Files

```java
import com.withruntime.*;
import java.nio.file.Path;

public class FilesExample {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create()) {
      sbx.files().write("/workspace/data/input.csv", "a,b\n1,2\n");
      System.out.print(sbx.files().readText("/workspace/data/input.csv"));
      for (FileEntry entry : sbx.files().list("/workspace", 2, null))
        System.out.println(entry.type() + " " + entry.size() + " " + entry.path());
      sbx.files().mkdir("/workspace/out", true);
      sbx.files().rename("/workspace/data/input.csv", "/workspace/out/input.csv", false);
      sbx.files().upload(Path.of("src"), "/workspace/project/src");
      sbx.files().download("/workspace/out", Path.of("out"));
    }
  }
}
```

`write` makes parent directories and replaces the file atomically; a file over
1 MiB goes in parallel chunks checked by SHA-256. `stat` returns `null` for a
path that does not exist. `upload` and `download` move a whole directory as
one gzipped tar archive through the API's folder routes, which pack and unpack
it with `tar` inside the sandbox ([files in the API guide](./api#files)); a
large one uploads in parts. A downloaded folder is unpacked as it arrives and
lands in place only once it has all arrived: one cut short is
`download_incomplete` and writes nothing.

## Pause, wake, fork and snapshot

```java
import com.withruntime.*;
import java.time.Duration;
import java.util.List;

public class Lifecycle {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create(new CreateSandbox().funding("trial"))) {
      sbx.pause(); // memory and files are kept; compute billing stops
      Sandbox again = runtime.sandboxes().get(sbx.id());
      again.wake(Duration.ofMinutes(20));
      again.extend(Duration.ofMinutes(10));

      List<Sandbox> copies = again.fork(new ForkOptions().count(2).funding("trial"));
      for (Sandbox copy : copies) copy.stop();

      Snapshot snapshot = again.snapshot(new SnapshotOptions().name("ready").retentionDays(7));
      try (Sandbox fromSnapshot = runtime.sandboxes().create(new CreateSandbox().snapshot(snapshot.id()).funding("trial"))) {
        System.out.println(fromSnapshot.id());
      }
      runtime.snapshots().delete(snapshot.id());
    }
  }
}
```

A fork copies a sandbox as it is now, with its files, memory and running
processes, on the same server; see [JavaScript](./javascript) for what forks
and snapshots keep and how they are billed. If a copy fails, the exception's
`details().get("startedSandboxIds")` names the copies that did start.
`sbx.keepAlive(every, margin, onError)` extends the lease from your process
until `stop()`, and `runtime.sandboxes().getOrCreate(name, options)` answers
the sandbox with that name, woken or restarted, or creates it.

## Share a port

```java
import com.withruntime.*;

public class Share {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try (Sandbox sbx = runtime.sandboxes().create()) {
      sbx.spawn("python3 -m http.server 3000", new SpawnOptions());
      Preview preview = sbx.previews().create(3000);
      System.out.println(preview.url() + " " + preview.token()); // send the token as x-runtime-preview-token
    }
  }
}
```

A preview is private by default; `create(port, "public", null)` shares it with
anyone who has the address. Addresses are under `runtimehost.com`.

## Images, volumes, network rules and secrets

```java
import com.withruntime.*;
import java.util.List;
import java.util.Map;

public class Storage {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    Image image =
        runtime
            .images()
            .build(
                new CreateImage().name("data").recipe(Map.of("pip", List.of("pandas"), "apt", List.of("jq"))),
                line -> System.out.println(line.getString("text")));
    Volume volume = runtime.volumes().create(10240, "cache", null);
    try (Sandbox sbx = runtime.sandboxes().create(new CreateSandbox().image(image.id()).volume(volume.id(), "/data", null))) {
      System.out.print(sbx.exec("python3 -c 'import pandas; print(pandas.__version__)'").stdout());
      JsonObject cell = sbx.interpreter().run("import math\nround(math.pi * 2, 3)");
      System.out.println(cell.getObjects("results").get(0).getObject("data").getString("text/plain"));
      sbx.network().set(new NetworkRules().internet(true).allow("pypi.org", "*.pythonhosted.org"));
    }
    JsonObject secret = runtime.secrets().set("OPENAI_API_KEY", "sk-...", List.of("api.openai.com"));
    System.out.println(secret.getString("placeholder")); // what sandboxes see in $OPENAI_API_KEY
  }
}
```

`images().build` waits until the image is ready and throws with code
`image_failed` when the build fails; `images().create` queues it and returns. A
Dockerfile build takes `dockerfile(text)` and `contextDir(path)`, the folder
`docker build` would read, with its `.dockerignore`; only the parts the server
does not have yet are uploaded. See [custom images](./images). A volume lives
on one server; its backups can restore a new volume onto another host. `sbx.desktop()` drives a Linux
desktop in the sandbox.

## Metrics, events and webhooks

```java
import com.withruntime.*;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class Hooks {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    JsonObject hook = runtime.webhooks().create("https://example.com/hooks/runtime", null, null);
    String secret = hook.getString("secret"); // shown once; keep it

    // In your endpoint, with the raw body and the Runtime-Signature header:
    byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
    String header = "t=0,v1=0";
    try {
      JsonObject event = Products.Webhooks.verify(body, header, List.of(secret));
      System.out.println(event.getString("type"));
    } catch (SecurityException forged) {
      System.out.println("refused: " + forged.getMessage());
    }
    for (JsonObject event : runtime.events().list(null, "sandbox.stopped"))
      System.out.println(event.getString("createdAt") + " " + event.getString("type"));
  }
}
```

`sbx.metrics("15m")` returns the sandbox's measured CPU and memory, and
`runtime.otel().create(...)` pushes events and metrics to an OpenTelemetry
endpoint. See [metrics and webhooks](./observability).

## Errors and retries

```java
import com.withruntime.*;

public class Errors {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    try {
      runtime.sandboxes().get("00000000-0000-4000-8000-000000000000");
    } catch (RuntimeCloudException.NotFound missing) {
      System.out.println("no such sandbox");
    } catch (RuntimeCloudException failure) {
      System.out.println(failure.code() + " " + failure.hint() + " " + failure.requestId());
    }
  }
}
```

Every exception is a `RuntimeCloudException` (unchecked) with `code()`,
`getMessage()`, `hint()`, `requestId()`, `status()` and `details()`. Its
subclasses are `Authentication`, `PermissionDenied`, `NotFound`, `Conflict`,
`InvalidRequest`, `RateLimited`, `ServiceUnavailable`, `Connection` and
`Command`, the same classes as the JavaScript, Python and Go SDKs.

Every write carries an idempotency key, made for you and kept across the
client's own retries. Transport failures, 429, 502, 503 and 504 are retried
with the same key, so a retry never makes two sandboxes or runs a command
twice. `retryable()` says whether trying the same call again may work.

**A create waits for room.** When every trial slot is taken (`trial_busy`), the
account is at its limit (`quota_exceeded`) or the region is full
(`no_capacity`), `sandboxes().create` waits and sends the same request again,
for up to two minutes. Set `waitForCapacity` on the client builder, or on one
`CreateSandbox`; zero fails at once.

An owner, admin or developer can make a read-only key and set a daily spending
limit on a key at [API keys](https://withruntime.com/account/keys).
`runtime.limits().get()` reads both; past the limit, a create, wake or
extension throws with code `spending_limit_reached`, and it is not retried.

## Configuration

```java
import com.withruntime.*;
import java.time.Duration;

public class Configured {
  public static void main(String[] args) {
    RuntimeClient runtime =
        RuntimeClient.builder()
            .apiKey(System.getenv("MY_RUNTIME_KEY"))
            .timeout(Duration.ofMinutes(2))
            .maxRetries(4)
            .waitForCapacity(Duration.ofMinutes(10))
            .build();
    System.out.println(runtime.me().orgId());
    System.out.println(runtime.request("GET", "/v1/volumes", null, null)); // any endpoint, same rules
  }
}
```

- `RUNTIME_API_URL` points the client at another API origin, as `baseUrl`
  does.
- Code inside a Runtime sandbox calls Runtime's API at `http://runtime.internal`
  ([Runtime's API from inside a sandbox](./sandbox-environment#runtime-s-api-from-inside-a-sandbox)).
- The client is safe for concurrent use. Make one and share it: it keeps its
  connections open and holds at most 32 calls in flight (`maxConnections`).
- It honours `HTTPS_PROXY` and `NO_PROXY`. `httpClient` supplies your own
  `java.net.http.HttpClient`.
- Money is integer microdollars: 1,000,000 is one US dollar.
  `runtime.usage()` returns the account's balance exactly, as `BigInteger`.

## Network products and backups

`runtime.domains()`, `ports()`, `addresses()` and `tunnel()` manage account
networking. Domains and ports name the sandbox they serve. `tunnel()` is the
account's WireGuard network; it is separate from a sandbox's TCP forwarding.
Answers keep the API's complete fields through `JsonObject`: use `getLong`
for integer money and `getInstant` for funding deadlines. An address or tunnel
reservation stays until released when credit runs out; traffic stops during
the unfunded time.

```java
import com.withruntime.*;
import java.util.List;

public class NetworkProductsExample {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    JsonObject domain = runtime.domains().add("app.example.org", args[0], 8080);
    System.out.println(domain.getObjects("records")); // Publish these DNS records, then verify.
    JsonObject address = runtime.addresses().reserve(4);
    System.out.println(address.getString("address"));
    System.out.println(address.getLong("rateMicros"));
    runtime.tunnel().create("10.66.0.0/24");
    JsonObject peer = runtime.tunnel().addPeer("laptop", null, List.of());
    // Save peer.getString("config") privately, even when configReady is false.
    // Its private key is shown once; generated-key calls are not automatically retried.
    System.out.println(peer.getBoolean("configReady"));
    System.out.println(runtime.sso().get()); // Owner console manages SSO settings.
  }
}
```

`volumes().backup`, `backups`, `getBackup`, `deleteBackup`, `setBackupPolicy`
and `restore` manage backups. A restore creates a new volume; it does not
replace the original. A backup's `backedUp` field is true once its copy has
been checked off the source host. Writes after that backup are not in it.

```java
import com.withruntime.*;

public class VolumeBackupExample {
  public static void main(String[] args) {
    RuntimeClient runtime = RuntimeClient.create();
    runtime.volumes().setBackupPolicy(args[0], true, 7);
    JsonObject backup = runtime.volumes().backup(args[0], "before-update");
    if ("ready".equals(backup.getString("state"))) {
      Volume restored = runtime.volumes().restore(backup.getString("id"), "restored");
      System.out.println(restored.id());
    }
  }
}
```

## File permissions and watching

`Files.WriteOptions.mode(0755)` sets permissions atomically on current guest
images; `0` means no permissions, rather than the default. Older images use
the `exec` permission for a chmod fallback. A supplied write idempotency key
covers the whole upload, including completed retries. `files().chmod` changes
an existing file's permissions.

A watch's `events()` follows its cursor across server handovers. Loss notices
(`overflow` or `lost`) mean the caller should rescan. Closing the event stream
stops reading; `watch.stop()` also stops the guest watch. A later `events()`
resumes after a pause or an earlier reader close. Only one reader uses a watch
at a time. `files().watches()` also lists watches, polls and stops them by ID.

```java
import com.withruntime.*;
import java.util.Map;

public class FileWatchExample {
  public static void main(String[] args) {
    Sandbox sandbox = RuntimeClient.create().sandboxes().get(args[0]);
    sandbox.files().write("/workspace/run.sh", "#!/bin/sh\necho ready\n",
        new Files.WriteOptions().mode(0755).idempotencyKey("install-run-script-v1"));
    FileWatch watch = sandbox.files().watch("/workspace", Map.of("recursive", true));
    try (EventStream<JsonObject> events = watch.events()) {
      for (JsonObject event : events) {
        System.out.println(event);
        if ("paused".equals(event.getString("k"))) break;
      }
    } finally {
      watch.stop();
    }
  }
}
```

## Terminals and TCP forwarding

A terminal carries binary input/output over an authenticated WebSocket.
Read output while writing input. Close it to release a blocked reader or
writer; interrupting its reader also closes it. Its opening deadline follows
the client's timeout. Closing an attached terminal does not stop its existing
process; a new terminal's shell ends with the connection.

`openTunnel()` multiplexes loopback TCP streams. A stream's `closeWrite()`
sends input EOF and keeps reading the response. Each stream holds at most
1 MiB of unread response data; exceeding that bound fails only that stream
with `tunnel_receive_overflow`, after delivering its buffered bytes.
`portForward()` copies both directions for each local connection and closes
its listener and active connections together.

```java
import com.withruntime.*;
import java.net.InetSocketAddress;
import java.util.Map;

public class TerminalForwardExample {
  public static void main(String[] args) throws Exception {
    Sandbox sandbox = RuntimeClient.create().sandboxes().get(args[0]);
    try (Terminal terminal = sandbox.terminal(Map.of("command", "printf ready"))) {
      terminal.input().transferTo(System.out);
      System.out.println(terminal.exitCode());
    }
    try (PortForward forward = sandbox.portForward(5432, new InetSocketAddress("127.0.0.1", 0))) {
      System.out.println(forward.address()); // Connect your local database client here.
      System.in.read();
    }
  }
}
```

## Bucket mounts, MCP servers and recordings

`sbx.mounts().add(options)` takes provider, bucket, path and the name of a
Runtime secret, keeping the bucket key outside the sandbox. `list()` and
`remove(path)` manage its lifecycle. `runtime.mcp().catalog()` lists server
choices; `sbx.mcp().start(options)`, `get()`, `ready(timeout)` and `stop()`
manage sandbox servers. `ready` waits for installation to end; inspect each
server's status for failures. Interrupted waits stop promptly.

`sbx.desktop().recordings()` has `start`, `get`, `list`, `stop`, `download`
and `delete`. Downloads return MP4 bytes. Recordings live on the sandbox's
own disk and count toward that disk's space.
