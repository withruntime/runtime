# withruntime

The official client for [Runtime Cloud](https://withruntime.com): Linux machines for AI agents and apps, each a
microVM with its own kernel, disk and network, created in milliseconds and billed for the CPU it uses and the memory
it holds. The client is generated from the API's OpenAPI description, so every product and every operation of
`https://api.withruntime.com/v2` is here, typed.

## Install

```bash
go get withruntime.com/go/v2
```

Go 1.23 or later. The module has no dependencies outside the standard library.

## Authentication

The client reads your API key from `RUNTIME_API_KEY`. Create a key at https://withruntime.com/account/keys and keep it
in a secret manager, never in source code or a URL. A key pair's `rtsk_` secret also works: the client signs each
request with it and never sends it.

## Quickstart

```go
package main

import (
	"context"
	"fmt"
	"log"

	runtime "withruntime.com/go/v2/generated"
)

func main() {
	ctx := context.Background()
	rt := runtime.New(runtime.Options{}) // reads RUNTIME_API_KEY

	sbx, err := rt.Sandboxes.Create(ctx, runtime.SandboxCreate{}, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer sbx.Delete(ctx, nil)

	if _, err := sbx.Files.Write(ctx, "/workspace/invoice.py", []byte("print(sum([125, 250, 375]))\n"), nil, nil); err != nil {
		log.Fatal(err)
	}
	p, err := sbx.Exec(ctx, "python3 /workspace/invoice.py", nil, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(*p.ExitCode, *p.Stdout) // 0 750
}
```

The client is the package `withruntime.com/go/v2/generated`.

## Configuration

```go
rt := runtime.New(runtime.Options{
	APIKey:     os.Getenv("RUNTIME_API_KEY"), // the default
	Project:    "prj_...",                    // default: RUNTIME_PROJECT
	BaseURL:    "https://api.withruntime.com", // default: RUNTIME_API_URL
	MaxRetries: 3,                            // 0 means 3, -1 none
})
```

## Products

| Class | Create one | What it is |
| --- | --- | --- |
| `Sandbox` | `rt.Sandboxes.Create(ctx, …, nil)` | A Linux machine with its own kernel, made in milliseconds, paused with its memory kept when idle and resumed where it was. |
| `FunctionMachine` | `rt.Functions.Create(ctx, …, nil)` | A machine that answers HTTP with a handler in /app/index.ts (`export default { fetch(request) }`, as Cloudflare Workers and Vercel take one) on port 8080, reached at its preview. |
| `App` | `rt.Apps.Create(ctx, …, nil)` | A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. |
| `Site` | `rt.Sites.Create(ctx, …, nil)` | A machine that serves the static files in /site on port 8080 (as Netlify and Vercel serve a build's output), reached at its preview. |
| `CiMachine` | `rt.Ci.Create(ctx, …, nil)` | A machine that runs a repository's checks to their end (its `run`) with git, Docker, Node, Bun, Python and a compiler, and is stopped then. |
| `Browser` | `rt.Browsers.Create(ctx, …, nil)` | A machine running headless Chromium, driven over the Chrome DevTools Protocol at its preview on port 9222: one WebSocket address for Playwright's `connectOverCDP` and Puppeteer's `connect`, as Browserbase gives one. |
| `Desktop` | `rt.Desktops.Create(ctx, …, nil)` | A machine running a Linux desktop with Chromium, for agents that use a computer: screenshot returns what its screen shows and act moves and clicks its mouse and types on its keyboard. |
| `Notebook` | `rt.Notebooks.Create(ctx, …, nil)` | A machine running JupyterLab on port 8888 over /workspace, with NumPy, pandas and matplotlib, reached at its private preview. |
| `Workspace` | `rt.Workspaces.Create(ctx, …, nil)` | A development environment: a machine running VS Code in the browser (code-server) on port 8080 over /workspace, reached at its private preview, as Codespaces and Gitpod give one. |
| `Container` | `rt.Containers.Create(ctx, …, nil)` | A machine that runs one OCI image from any registry under Docker on its own network (`start` `runtime-container <image>`), the port it listens on reached at its preview, as Cloud Run and Fly Machines run one. |
| `Build` | `rt.Builds.Create(ctx, …, nil)` | The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. |
| `Job` | `rt.Jobs.Create(ctx, …, nil)` | A command run in a fresh machine, once or on a cron schedule in a timezone. |
| `Image` | `rt.Images.Create(ctx, …, nil)` | What a machine boots: a root filesystem, its environment and its start. |
| `Volume` | `rt.Volumes.Create(ctx, …, nil)` | A disk that outlives the machines it is attached to. |
| `Domain` | `rt.Domains.Create(ctx, …, nil)` | Your own hostname serving a machine's port, with HTTPS. |

Every machine (each class above with `files`) has `Refresh`, `Delete`, `Pause`, `Resume`, `Exec`, `Metrics`, `Fork`, `Snapshot`, `Update`, `Screenshot`, `Act`, `RunCode`, `Files.Read`, `Files.Write`, `Files.Remove`, `Files.Stat`, `Files.List`, `Files.DownloadFolder`, `Files.UploadFolder`, `Files.BeginFolderUpload`, `Files.WriteFolderUpload`, `Files.CommitFolderUpload`, `Files.AbortFolderUpload`, `Files.Mkdir`, `Files.Rename`, `Files.Link`, `Files.RevokeLinks`, `Processes.Output`, `Processes.Write`, `Processes.Signal`, `Processes.Resize`, `Processes.List`, `Network.Get`, `Network.Set`.

- `Sandbox` also has `ExecStream`, `Previews.Create`.
- `Job` also has `Run`.
- `Image` also has `Logs`.
- `Domain` also has `Verify`.

The API's other resources (keys, projects, roles, secrets, snapshots, webhooks, usage and more) are clients on the
runtime object. The [API reference](https://withruntime.com/docs/reference) lists every operation.

## Errors

Every error the API returns is a `*runtime.Error` with `Code`, `Message`, `Status`, `RequestID`, `Hint`, `Param`
and `Retryable`. Match an error family with `errors.Is`:

```go
_, err := rt.Sandboxes.Get(ctx, "sbx_missing", runtime.SandboxGetQuery{}, nil)
if errors.Is(err, runtime.ErrNotFound) {
	var e *runtime.Error
	errors.As(err, &e)
	fmt.Println(e.Code, e.RequestID)
}
```

## Retries and idempotency

The client retries a rate-limited (429) or unavailable (503) answer, and a lost connection on a call that is safe to send again, up to `MaxRetries` times (default 3). Every write sends an `Idempotency-Key` header, generated when `RequestOptions.IdempotencyKey` is empty, so a retry never runs a write twice. The `context.Context` you pass cancels a call.

## Lists

`List` returns one page; `ListAll` iterates every item across pages:

```go
for s, err := range rt.Sandboxes.ListAll(ctx, runtime.SandboxListQuery{State: runtime.Ptr("running")}, nil) {
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(s.ID)
}
```

## Versioning

The package follows [Semantic Versioning](https://semver.org): a minor or patch release never breaks code written
for an earlier release of the same major version. Each request sends the API version the client was generated for in
the `Runtime-Version` header. Every release is listed in [CHANGELOG.md](CHANGELOG.md).

## Resources

- Guides: https://withruntime.com/docs
- API reference: https://withruntime.com/docs/reference
- Pricing: https://withruntime.com/pricing
- Status: https://status.withruntime.com
- Support: support@withruntime.com

## License

Apache-2.0
