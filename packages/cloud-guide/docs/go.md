# Go SDK

One Go client for every Runtime Cloud product, with a `context.Context` on every call.

The module is `withruntime.com/go`, imported as package `withruntime`. It needs
Go 1.23 or later and uses only the standard library.

```bash no-run
go get withruntime.com/go
```

**The client finds its key by itself.** It uses `RUNTIME_API_KEY` when that is
set, and otherwise the connection this machine saved (any `npx withruntime`
command connects it, with one browser approval).

On a server, put a key from https://withruntime.com/account/keys in
`RUNTIME_API_KEY` from your secret manager. Never put it in source code, a URL
or a command-line argument. With no key anywhere, `withruntime.New` returns an
error whose code is `missing_api_key` and whose hint says how to get one.

## Hello, sandbox

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, &withruntime.CreateOptions{Funding: "trial"})
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	result, err := sbx.Exec(ctx, "python3 -c 'print(6 * 7)'", &withruntime.ExecOptions{Check: true})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(result.Stdout)
}
```

`Create` returns once the sandbox is running. `opts` may be `nil`: with no
options you get the free trial while it lasts, the default region, and 2 vCPU,
4 GiB of memory and a 4 GiB disk for up to 30 minutes. `Funding: "trial"` never
falls back to paid credit. Every field is optional:

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, &withruntime.CreateOptions{
		Name:           "tests-42",
		Labels:         map[string]string{"team": "search", "job": "42"},
		VCPU:           2,
		MemoryMiB:      4096,
		DiskMiB:        8192,
		TimeoutSeconds: 900,
		OnLeaseEnd:     "stop",
		Network: &withruntime.Network{
			Internet: true,
			Allow:    []string{"proxy.golang.org", "*.githubusercontent.com"},
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)
	fmt.Println(sbx.ID(), sbx.Info().Funding, sbx.Info().ExpiresAt)
}
```

A field newer than the SDK goes in `Extra`, which is merged into the request.

## Run commands

`Exec` runs a string under `bash -c`. `ExecArgv` runs a program directly, with no
shell, which is what you want for untrusted arguments.

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	if _, err := sbx.Exec(ctx, "mkdir -p app && echo 'print(1 + 1)' > app/main.py", nil); err != nil {
		log.Fatal(err)
	}
	run, err := sbx.ExecArgv(ctx, []string{"python3", "main.py"}, &withruntime.ExecOptions{
		Cwd:     "/workspace/app",
		Env:     map[string]string{"API_TOKEN": os.Getenv("API_TOKEN")},
		Timeout: 2 * time.Minute,
	})
	if err != nil {
		log.Fatal(err)
	}
	if *run.ExitCode != 0 {
		fmt.Println(run.Stderr)
	}
	fmt.Print(run.Stdout)
}
```

- `Env` is how secrets reach a command. It is never echoed back, and journals
  record a hash, not the value. Never put a secret in the command line itself.
- `Stdin` gives the command input, then closes it.
- The default timeout is 60 seconds; the maximum is 24 hours. A timeout is a
  result (`TimedOut` is true, with the output so far), not an error.
- `Check: true` returns a `*withruntime.CommandError`, with the exit code and
  output, on a non-zero exit or a timeout.
- A result holds at most 64 KiB of `Stdout` and 64 KiB of `Stderr`, and
  `StdoutTruncated` or `StderrTruncated` says when more was dropped. With
  `OnStdout` or `OnStderr` (or a `Timeout` over 60 seconds) the command streams
  instead, and the result keeps everything it printed.

Stream output as it happens with callbacks, or range over the events:

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	_, err = sbx.Exec(ctx, "for i in 1 2 3; do echo line $i; sleep 1; done", &withruntime.ExecOptions{
		OnStdout: func(text string) { fmt.Print(text) },
	})
	if err != nil {
		log.Fatal(err)
	}
	for event, err := range sbx.ExecStream(ctx, "node --version", nil) {
		if err != nil {
			log.Fatal(err)
		}
		switch event.Type {
		case "stdout":
			fmt.Print(event.Data)
		case "exit":
			fmt.Println("exit", *event.ExitCode)
		}
	}
}
```

A long stream resumes by itself when the server ends it, so no output is
dropped. The sandbox keeps the latest 1 MiB of a command's output; a reader that
falls further behind gets a `truncated` event.

## Background processes

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	server, err := sbx.Spawn(ctx, "python3 -m http.server 8000", &withruntime.SpawnOptions{Cwd: "/workspace"})
	if err != nil {
		log.Fatal(err)
	}
	repl, err := sbx.SpawnArgv(ctx, []string{"python3", "-i", "-q"}, &withruntime.SpawnOptions{PipeStdin: true})
	if err != nil {
		log.Fatal(err)
	}
	if err := repl.Write(ctx, []byte("print(21 * 2)\n"), true); err != nil {
		log.Fatal(err)
	}
	done, err := repl.Wait(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(done.Stdout)

	processes, err := sbx.Processes(ctx)
	if err != nil {
		log.Fatal(err)
	}
	for _, process := range processes {
		fmt.Println(process.ID, process.State, process.Command)
	}
	if err := server.Kill(ctx, "SIGTERM"); err != nil {
		log.Fatal(err)
	}
}
```

`process.Output(ctx, 0)` yields every event from the start until the process
exits. A process outlives your connection; get it back with
`sbx.Process(ctx, id)`. `Write` tracks input offsets, so a retried write is never
typed twice.

## Files

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	if err := sbx.Files.Write(ctx, "/workspace/data/input.csv", []byte("a,b\n1,2\n")); err != nil {
		log.Fatal(err)
	}
	text, err := sbx.Files.ReadText(ctx, "/workspace/data/input.csv")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(text)
	entries, err := sbx.Files.List(ctx, "/workspace", &withruntime.FileListOptions{Depth: 2})
	if err != nil {
		log.Fatal(err)
	}
	for _, entry := range entries {
		fmt.Println(entry.Type, entry.Size, entry.Path)
	}
	if err := sbx.Files.Mkdir(ctx, "/workspace/out", true); err != nil {
		log.Fatal(err)
	}
	if err := sbx.Files.Rename(ctx, "/workspace/data/input.csv", "/workspace/out/input.csv", false); err != nil {
		log.Fatal(err)
	}
	if err := sbx.Files.Upload(ctx, "./testdata", "/workspace/project"); err != nil {
		log.Fatal(err)
	}
	if err := sbx.Files.Download(ctx, "/workspace/out", "./out"); err != nil {
		log.Fatal(err)
	}
}
```

`Write` makes parent directories and replaces the file atomically; a file over
1 MiB goes in parallel chunks checked by SHA-256. `Stat` returns `nil` for a
path that does not exist. `Upload` and `Download` move a whole directory as one
gzipped archive.

## Pause, wake, extend, fork and snapshot

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, &withruntime.CreateOptions{Funding: "trial"})
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	if err := sbx.Pause(ctx, nil); err != nil { // memory and files are kept; compute billing stops
		log.Fatal(err)
	}
	again, err := client.Sandboxes.Get(ctx, sbx.ID())
	if err != nil {
		log.Fatal(err)
	}
	if err := again.Wake(ctx, 20*time.Minute, nil); err != nil {
		log.Fatal(err)
	}
	if err := again.Extend(ctx, 10*time.Minute, nil); err != nil {
		log.Fatal(err)
	}

	copies, err := again.Fork(ctx, &withruntime.ForkOptions{Count: 2, Funding: "trial"})
	if err != nil {
		log.Fatal(err)
	}
	for _, copied := range copies {
		fmt.Println("fork", copied.ID(), copied.State())
		_ = copied.Stop(ctx, nil)
	}
	snapshot, err := again.Snapshot(ctx, &withruntime.SnapshotOptions{Name: "ready", RetentionDays: 7})
	if err != nil {
		log.Fatal(err)
	}
	fromSnapshot, err := client.Sandboxes.Create(ctx, &withruntime.CreateOptions{Snapshot: snapshot.ID, Funding: "trial"})
	if err != nil {
		log.Fatal(err)
	}
	_ = fromSnapshot.Stop(ctx, nil)
	if err := client.Snapshots.Delete(ctx, snapshot.ID); err != nil {
		log.Fatal(err)
	}
}
```

A fork copies a sandbox as it is now, with its files, memory and running
processes, on the same server; see [JavaScript](./javascript) for what forks and
snapshots keep and how they are billed. If a copy fails, the error's
`Details["startedSandboxIds"]` names the copies that did start.

## Share a port

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	if _, err := sbx.Spawn(ctx, "python3 -m http.server 3000", nil); err != nil {
		log.Fatal(err)
	}
	preview, err := sbx.Previews.Create(ctx, 3000, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(preview.URL, *preview.Token) // send the token as x-runtime-preview-token
}
```

A preview is private by default; `Visibility: "public"` shares it with anyone
who has the address. Addresses are under `runtimehost.com`.

## Sandboxes by name, and keeping one running

`Sandboxes.GetOrCreate(ctx, name, opts)` answers the sandbox with that name,
woken if paused and restarted if stopped and persistent, or creates one with
`opts`; `Info().Reused` says which. `KeepAlive` extends the lease from your
process, so ten minutes remain, until `Stop` or `StopKeepAlive`.
`Persistent: true` on a paid sandbox renews the lease on the server instead.

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	dev, err := client.Sandboxes.GetOrCreate(ctx, "dev", &withruntime.CreateOptions{IdlePauseSeconds: 900})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(dev.ID(), dev.Info().Reused)

	dev.KeepAlive(ctx, nil)
	defer dev.StopKeepAlive()
	off := false
	if err := dev.Update(ctx, withruntime.SandboxSettings{AutoWake: &off}, nil); err != nil {
		log.Fatal(err)
	}
}
```

## An interactive terminal

`sbx.Terminal` opens a shell over a WebSocket. It is an `io.ReadWriteCloser`:
write what you type, read what it prints.

```go
package main

import (
	"context"
	"io"
	"log"
	"os"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	term, err := sbx.Terminal(ctx, &withruntime.TerminalOptions{Cols: 120, Rows: 40})
	if err != nil {
		log.Fatal(err)
	}
	defer term.Close()
	if _, err := term.Write([]byte("uname -a; exit\n")); err != nil {
		log.Fatal(err)
	}
	if _, err := io.Copy(os.Stdout, term); err != nil {
		log.Fatal(err)
	}
}
```

## Images, volumes and snapshots

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	image, err := client.Images.Build(ctx, withruntime.CreateImageOptions{
		Name:   "data",
		Recipe: &withruntime.ImageRecipe{Pip: []string{"pandas"}, Apt: []string{"jq"}},
	}, func(line withruntime.ImageLogLine) { fmt.Println(line.Text) })
	if err != nil {
		log.Fatal(err)
	}
	volume, err := client.Volumes.Create(ctx, withruntime.CreateVolumeOptions{SizeMiB: 10240, Name: "cache"})
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, &withruntime.CreateOptions{
		Image:   image.ID,
		Volumes: []withruntime.VolumeMount{{VolumeID: volume.ID, Path: "/data"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)
	result, err := sbx.Exec(ctx, "python3 -c 'import pandas; print(pandas.__version__)'", nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(result.Stdout)
}
```

`Images.Build` waits until the image is ready and returns an `*Error` whose
code is `image_failed` when the build fails; `Images.Create` queues it and
returns. A Dockerfile build takes `Dockerfile` and `ContextDir`, the folder
`docker build` would read, with its `.dockerignore`; only the parts of the
folder the server does not have yet are uploaded. `Images.Resolve`, `Tag`,
`Untag`, `Versions`, `FollowLogs` and `Images.Registries.Set` for private
images do the rest; see [custom images](./images). A volume lives on one
server. Daily backups are enabled by default; `BackedUp` becomes true after
a backup has been copied off the host and checked. A sandbox with volumes
cannot be snapshotted.

## Code interpreter, network rules and secrets

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Create(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Stop(context.Background(), nil)

	if _, err := sbx.Interpreter.Run(ctx, "import math\nx = math.pi", nil); err != nil {
		log.Fatal(err)
	}
	cell, err := sbx.Interpreter.Run(ctx, "round(x * 2, 3)", nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(cell.Results[0].Data["text/plain"])

	policy, err := sbx.Network.Set(ctx, withruntime.Network{Internet: true, Allow: []string{"pypi.org", "*.pythonhosted.org"}})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(policy.Enforced, policy.Allow)

	secret, err := client.Secrets.Set(ctx, "OPENAI_API_KEY", withruntime.SetSecretOptions{
		Value: "sk-...",
		Hosts: []string{"api.openai.com"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(secret.Placeholder) // what sandboxes see in $OPENAI_API_KEY
}
```

`sbx.Desktop` drives a Linux desktop in the sandbox (`Start`, `Open`, `Click`,
`Type`, `Press`, `Screenshot`), as in [JavaScript](./javascript).

## Metrics, events and webhooks

```go
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	hook, err := client.Webhooks.Create(ctx, withruntime.CreateWebhookOptions{URL: "https://example.com/hooks/runtime"})
	if err != nil {
		log.Fatal(err)
	}
	secret := hook.Secret // shown once; keep it
	http.HandleFunc("/hooks/runtime", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		event, err := withruntime.VerifyWebhook(body, r.Header.Get("Runtime-Signature"), []string{secret}, 0)
		if err != nil {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		fmt.Println(event.Type)
		w.WriteHeader(http.StatusNoContent)
	})
	for event, err := range client.Events.All(ctx, &withruntime.EventListOptions{Type: "sandbox.stopped"}) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(event.CreatedAt, event.Type)
	}
}
```

`sbx.Metrics(ctx, "15m")` returns the sandbox's measured CPU and memory, and
`client.Otel.Create` pushes events and metrics to an OpenTelemetry endpoint.
See [metrics and webhooks](./observability).

## An endpoint newer than the SDK

`client.Request` calls any API path with the client's key, retries,
idempotency keys and errors:

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	var page map[string]any
	if err := client.Request(context.Background(), "GET", "/v1/volumes", nil, &page); err != nil {
		log.Fatal(err)
	}
	fmt.Println(page["data"])
}
```

## Find sandboxes again

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	filter := &withruntime.ListOptions{Labels: map[string]string{"team": "search"}, State: []string{"running"}}
	for sbx, err := range client.Sandboxes.All(ctx, filter) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(sbx.ID(), sbx.State())
	}
}
```

`Sandboxes.List` returns one page (`Data`, `HasMore`, `Next`); `All` walks every
page.

## Errors and retries

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	_, err = client.Sandboxes.Get(ctx, "00000000-0000-4000-8000-000000000000")
	var failure *withruntime.Error
	switch {
	case errors.Is(err, withruntime.ErrNotFound):
		fmt.Println("no such sandbox")
	case errors.As(err, &failure):
		fmt.Println(failure.Code, failure.Hint, failure.RequestID)
	}
}
```

Every error is a `*withruntime.Error` with `Code`, `Message`, `Hint`,
`RequestID`, `Status` and `Details`. `errors.Is` matches it against
`ErrAuthentication`, `ErrPermissionDenied`, `ErrNotFound`, `ErrConflict`,
`ErrInvalidRequest`, `ErrRateLimited`, `ErrServiceUnavailable` and
`ErrConnection`, the same classes as the JavaScript and Python SDKs.

Every write carries an idempotency key, made for you and kept across the
client's own retries. Transport failures, 429, 502, 503 and 504 are retried
with the same key, so a retry never makes two sandboxes or runs a command
twice. `Retryable()` says whether trying the same call again may work.

**A create waits for room.** When every trial slot is taken (`trial_busy`), the
account is at its limit (`quota_exceeded`) or the region is full
(`no_capacity`), `Sandboxes.Create` waits and sends the same request again, for
up to two minutes. A burst of CI jobs past the limit queues instead of failing.
Set `withruntime.WithWaitForCapacity` on the client, or `WaitForCapacity` on one
create; zero fails at once.

## Read-only keys and daily limits

An owner, admin or developer can make a read-only key and set a daily spending
limit on a key at
[API keys](https://withruntime.com/account/keys). `client.Limits.Get(ctx)`
reads both; past the limit, a create, wake or extension returns an error whose
code is `spending_limit_reached`, and it is not retried. See
[security](./security).

## Configuration

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"withruntime.com/go"
)

func main() {
	client, err := withruntime.New(
		withruntime.WithAPIKey(os.Getenv("MY_RUNTIME_KEY")),
		withruntime.WithTimeout(2*time.Minute),
		withruntime.WithMaxRetries(4),
		withruntime.WithWaitForCapacity(10*time.Minute),
	)
	if err != nil {
		log.Fatal(err)
	}
	me, err := client.Me(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(me.OrgID)
}
```

- `RUNTIME_API_URL` points the client at another API origin, as
  `WithBaseURL` does.
- The client is safe for concurrent use. Make one and share it: it keeps its
  connections open and holds at most 32 calls in flight
  (`WithMaxConnections`).
- It honours `HTTPS_PROXY` and `NO_PROXY`. `WithHTTPClient` supplies your own
  `*http.Client`.
- Money is integer microdollars: 1,000,000 is one US dollar. `client.Usage(ctx)`
  returns the account's balance as exact decimal strings.

## Domains, public ports and private networking

`client.Domains`, `Ports`, `Addresses` and `Tunnel` are account products.
Domains and public ports name the sandbox they serve. `Tunnel` manages a
WireGuard network; `sbx.OpenTunnel` and `sbx.PortForward` open authenticated TCP
connections from your process into one sandbox.

When using `OpenTunnel` directly, read responses while writing requests. Each
stream keeps at most 1 MiB of unread response data. If its reader falls behind
that bound, reads return `tunnel_receive_overflow` after the buffered data;
other streams keep working. `PortForward` drains both directions for you.

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Get(ctx, "11111111-2222-4333-8444-555555555555")
	if err != nil {
		log.Fatal(err)
	}
	domain, err := client.Domains.Add(ctx, withruntime.AddDomainOptions{
		Hostname: "app.example.com", SandboxID: sbx.ID(), Port: 3000,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(domain.Records) // Publish these at your DNS provider, then call Domains.Verify.
	address, err := client.Addresses.Reserve(ctx, 4)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(address.Address, address.Funded, address.FundedUntil)
	forward, err := sbx.PortForward(ctx, 5432, "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	defer forward.Close()
	fmt.Println(forward.Addr()) // Connect your local database client here.
}
```

`Ports.Open` returns `Connect`, the public address and port. `Tunnel.Create`
creates the account's WireGuard network; `AddPeer` and `RotatePeer` return a
configuration holding a generated private key once. Save `Config` even when
`ConfigReady` is false: it is a draft whose gateway public key must be filled
from `Tunnel.Get` before use. A generated-key request is never automatically
retried. To keep the private key entirely on your machine, supply `PublicKey`.

Dedicated addresses and WireGuard networks expose `Funded`, `FundedUntil`,
`RateMicros` and `RateUnit`. Exhausted credit disables traffic while retaining
the reservation until you release it. `SSO.Get` reads sign-on and directory
status and the website address where an owner manages it.

## Backup and restore volumes

`Volumes.Backup` requests a checked copy off the host. `Backups` lists copies;
`GetBackup` and `DeleteBackup` read or remove one. `SetBackupPolicy` changes
daily backups or retention. Restore makes a new volume from a ready backup.

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	backup, err := client.Volumes.Backup(ctx, "11111111-2222-4333-8444-555555555555", nil)
	if err != nil {
		log.Fatal(err)
	}
	if backup.State != "ready" {
		fmt.Println("Backup is still running; poll Volumes.GetBackup:", backup.ID)
		return
	}
	volume, err := client.Volumes.Restore(ctx, backup.ID, &withruntime.CreateVolumeOptions{Name: "restored"})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(volume.ID, volume.State, volume.RestoredFrom)
}
```

## Permissions and file watching

Pass `FileWriteOptions` to write permissions with the content; a pointer keeps
mode `000` distinct from the default. Current guest images require only
`write_file`. Older images require `exec` for the SDK's chmod fallback.
`Files.Chmod` sets an existing file's permissions through the same exec grant.
A supplied write key identifies the whole upload: each mutation phase has its
own stable key, and a repeated completed upload returns without sending its
chunks again.

```go
package main

import (
	"context"
	"fmt"
	"log"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Get(ctx, "11111111-2222-4333-8444-555555555555")
	if err != nil {
		log.Fatal(err)
	}
	mode := uint32(0o755)
	if err := sbx.Files.Write(ctx, "/workspace/run.sh", []byte("#!/bin/sh\necho ready\n"), &withruntime.FileWriteOptions{Mode: &mode}); err != nil {
		log.Fatal(err)
	}
	watch, err := sbx.Files.Watch(ctx, "/workspace", &withruntime.WatchOptions{Recursive: true, Exclude: []string{"node_modules"}})
	if err != nil {
		log.Fatal(err)
	}
	defer watch.Stop(context.Background())
	for batch, err := range watch.Events(ctx) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(batch.Kind, batch.Events, batch.Reason, watch.Cursor())
	}
}
```

`Events` reconnects on a continuation and preserves its cursor. A pause ends
iteration without stopping the guest watch; after waking the sandbox, call
`Events` again. `overflow` and `lost` notices mean you should rescan. Breaking
iteration closes its HTTP response. `Stop` also stops the guest watch.
`Files.Watches.List` and `Read` support finding watches and polling instead.

## Bucket mounts, MCP servers and recordings

`sbx.Mounts.Add` mounts a customer bucket using the name of a Runtime secret,
with `List` and `Remove` for lifecycle management. The sandbox never receives
the bucket key. `client.MCP.Catalog` lists available servers; `sbx.MCP.Start`,
`Ready`, `Get` and `Stop` manage servers running in that sandbox.
`sbx.Desktop.Recordings` has `Start`, `Get`, `List`, `Stop`, `Download` and
`Delete`; downloaded bytes are MP4.

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"withruntime.com/go"
)

func main() {
	ctx := context.Background()
	client, err := withruntime.New()
	if err != nil {
		log.Fatal(err)
	}
	sbx, err := client.Sandboxes.Get(ctx, "11111111-2222-4333-8444-555555555555")
	if err != nil {
		log.Fatal(err)
	}
	catalog, err := client.MCP.Catalog(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(catalog)
	_, err = sbx.MCP.Start(ctx, withruntime.MCPStartOptions{Servers: []withruntime.MCPServerRequest{{ID: "github", Secrets: map[string]string{"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}}}})
	if err != nil {
		log.Fatal(err)
	}
	gateway, err := sbx.MCP.Ready(ctx, 5*time.Minute)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(gateway.Servers, gateway.Warnings) // Connect with gateway.Headers; keep its token private.
}
```
